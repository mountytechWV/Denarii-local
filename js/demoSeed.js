// ── DEMO SEED: The Denarii ──
// Seeds a "Pelosi" demo broker account into each real user's journal data.
// Entirely deterministic — same data is produced on every restore.
// The old separate Pelosi user-account model is deprecated; these functions
// operate on the current user's journalData, not a separate auth record.

const DEMO_BROKER_ID = 'ba_demo_pelosi';
const DEMO_BROKER_DATA_VERSION = 6;

// Legacy constants kept so old code paths don't crash if referenced
const DEMO_USERNAME = 'Pelosi';
const DEMO_PASSWORD = 'demo123';

// ── Deterministic PRNG (mulberry32) ──
function _makePRNG(seed) {
    return function () {
        seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
        var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = t + Math.imul(t ^ (t >>> 7), 61 | t) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

// ═══════════════════════════════════════════════════════════════════════
// PUBLIC API — called from unlockApp() migration block
// ═══════════════════════════════════════════════════════════════════════

// Inject demo broker + data into current user's journalData if not present.
// Returns true if journalData was mutated.
function seedDemoBroker(data) {
    if (!data) return false;
    if (!data.brokerAccounts) data.brokerAccounts = [];
    if (!data.trades) data.trades = [];

    // Already seeded?
    var existing = data.brokerAccounts.find(function(a) { return a.id === DEMO_BROKER_ID; });
    if (existing) return false;

    var demo = _buildDemoBrokerData();
    data.brokerAccounts.push(demo.brokerAccount);

    // Merge trades
    for (var i = 0; i < demo.trades.length; i++) data.trades.push(demo.trades[i]);

    // Merge tags (dedup by name+category)
    if (!data.tags) data.tags = [];
    var tagKey = function(t) { return (t.name||'').toLowerCase() + '|' + (t.category||'').toLowerCase(); };
    var existingTags = {};
    data.tags.forEach(function(t) { existingTags[tagKey(t)] = true; });
    demo.tags.forEach(function(t) { if (!existingTags[tagKey(t)]) data.tags.push(t); });

    // Merge tag categories
    if (!data.tagCategories) data.tagCategories = [];
    demo.tagCategories.forEach(function(c) {
        if (data.tagCategories.indexOf(c) === -1) data.tagCategories.push(c);
    });

    // Merge reviews
    if (!data.reviews) data.reviews = {};
    var rkeys = Object.keys(demo.reviews);
    for (var r = 0; r < rkeys.length; r++) {
        if (!data.reviews[rkeys[r]]) data.reviews[rkeys[r]] = demo.reviews[rkeys[r]];
    }

    // Merge daily planners
    if (!data.dailyPlanners) data.dailyPlanners = {};
    var dpkeys = Object.keys(demo.dailyPlanners);
    for (var dp = 0; dp < dpkeys.length; dp++) {
        if (!data.dailyPlanners[dpkeys[dp]]) data.dailyPlanners[dpkeys[dp]] = demo.dailyPlanners[dpkeys[dp]];
    }

    // Merge weekly planners
    if (!data.weeklyPlanners) data.weeklyPlanners = {};
    var wpkeys = Object.keys(demo.weeklyPlanners);
    for (var wp = 0; wp < wpkeys.length; wp++) {
        if (!data.weeklyPlanners[wpkeys[wp]]) data.weeklyPlanners[wpkeys[wp]] = demo.weeklyPlanners[wpkeys[wp]];
    }

    data._demoBrokerVersion = DEMO_BROKER_DATA_VERSION;
    return true;
}

// Version check — refresh demo broker data if bundled version is newer.
function syncDemoBrokerData(data) {
    if (!data || !data.brokerAccounts) return false;
    var broker = data.brokerAccounts.find(function(a) { return a.id === DEMO_BROKER_ID; });
    if (!broker) return false;
    if (data._demoBrokerVersion >= DEMO_BROKER_DATA_VERSION) return false;

    // Remove old demo broker data
    _removeDemoBrokerData(data);
    // Re-seed with fresh data
    return seedDemoBroker(data);
}

// ── Bundle-based import (Phase C) ────────────────────────────────────
// Imports Pelosi demo data from the static read-only DEMO_BUNDLE into
// the user's journalData. Used by restoreDemoBroker() and new-account
// default import. Never modifies DEMO_BUNDLE itself.

function _importFromDemoBundle(data) {
    if (typeof DEMO_BUNDLE === 'undefined' || !DEMO_BUNDLE) return false;
    if (!data) return false;
    var b = DEMO_BUNDLE;

    if (!data.brokerAccounts) data.brokerAccounts = [];
    if (!data.trades) data.trades = [];

    // Broker account (deep copy)
    data.brokerAccounts.push(JSON.parse(JSON.stringify(b.broker)));

    // Trades (deep copy)
    var bTrades = b.trades;
    for (var i = 0; i < bTrades.length; i++) data.trades.push(JSON.parse(JSON.stringify(bTrades[i])));

    // Tags (dedup by name+category)
    if (!data.tags) data.tags = [];
    var tagKey = function(t) { return (t.name||'').toLowerCase() + '|' + (t.category||'').toLowerCase(); };
    var existingTags = {};
    data.tags.forEach(function(t) { existingTags[tagKey(t)] = true; });
    b.tags.forEach(function(t) { if (!existingTags[tagKey(t)]) data.tags.push(JSON.parse(JSON.stringify(t))); });

    // Tag categories
    if (!data.tagCategories) data.tagCategories = [];
    (b.tagCategories || []).forEach(function(c) {
        if (data.tagCategories.indexOf(c) === -1) data.tagCategories.push(c);
    });

    // Reviews (dedup by key)
    if (!data.reviews) data.reviews = {};
    var rkeys = Object.keys(b.reviews);
    for (var r = 0; r < rkeys.length; r++) {
        if (!data.reviews[rkeys[r]]) data.reviews[rkeys[r]] = JSON.parse(JSON.stringify(b.reviews[rkeys[r]]));
    }

    // Daily planners
    if (!data.dailyPlanners) data.dailyPlanners = {};
    var dpkeys = Object.keys(b.dailyPlanners);
    for (var dp = 0; dp < dpkeys.length; dp++) {
        if (!data.dailyPlanners[dpkeys[dp]]) data.dailyPlanners[dpkeys[dp]] = JSON.parse(JSON.stringify(b.dailyPlanners[dpkeys[dp]]));
    }

    // Weekly planners
    if (!data.weeklyPlanners) data.weeklyPlanners = {};
    var wpkeys = Object.keys(b.weeklyPlanners);
    for (var wp = 0; wp < wpkeys.length; wp++) {
        if (!data.weeklyPlanners[wpkeys[wp]]) data.weeklyPlanners[wpkeys[wp]] = JSON.parse(JSON.stringify(b.weeklyPlanners[wpkeys[wp]]));
    }

    // Set import tracking flags
    data._demoBrokerVersion = b.version;
    data._demoImportVersion = b.version;
    data._demoImportedAt = new Date().toISOString();
    delete data._demoImportDismissed;

    return true;
}

// Restore Demo — callable from Settings UI. Resets data and makes visible.
async function restoreDemoBroker() {
    if (!journalData) { alert('Journal not loaded. Please try again.'); return; }

    // Cloud-primary: save the demo trades to the cloud before changing local data.
    if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
        var demo = {};
        if (!_importFromDemoBundle(demo)) {
            alert('Failed to restore demo: demo data is not loaded.\nYour data was not changed. Please reload and try again.');
            return;
        }
        var res;
        try { res = await _saveTradesToSupabase(demo.trades); } catch (e) { res = { success: false, error: e.message || String(e) }; }
        if (!res || !res.success) {
            // Saves of more than 500 rows commit in chunks, so earlier chunks may be in the cloud.
            alert('Failed to restore demo: ' + ((res && res.error) || 'unknown error')
                + (demo.trades.length > 500
                    ? '\nSome demo trades may already be reset in the cloud. Local data was not changed. Please try again.'
                    : '\nYour data was not changed. Please try again.'));
            return;
        }
    }

    _removeDemoBrokerData(journalData);

    if (!_importFromDemoBundle(journalData)) {
        // Fallback to legacy builder if bundle is not loaded
        seedDemoBroker(journalData);
    }

    await _persistAndRefreshUI();
    alert('Pelosi demo broker restored with fresh sample data.');
}

// Delete Demo — callable from Settings UI. Removes demo data from journal.
async function deleteDemoBroker() {
    if (!journalData) { alert('Journal not loaded. Please try again.'); return; }

    if (!confirm('Remove the Pelosi demo broker and all its sample trades?\n\nYou can bring it back anytime with Restore Demo.')) return;

    _removeDemoBrokerData(journalData);
    journalData._demoImportDismissed = true;
    delete journalData._demoImportVersion;

    await _persistAndRefreshUI();

    // Fire-and-forget: clean up demo rows from Supabase row tables
    _cleanupDemoRowsFromSupabase();
}

// ── Phase D: Supabase demo-row cleanup after local delete ───────────
// Deletes Pelosi/demo rows from cloud row tables for the current user.
// Fire-and-forget — failures are logged but never block the UI or
// affect the local delete.
function _cleanupDemoRowsFromSupabase() {
    try {
        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) return;
        var client = SupabaseAuth.getClient();
        if (!client) return;

        SupabaseAuth.supabaseGetSession().then(function (res) {
            if (!res.data || !res.data.user) return;
            var userId = res.data.user.id;
            // Never delete with a session that belongs to another account.
            if (typeof _sessionMatchesAccount !== 'function' || !_sessionMatchesAccount(userId)) {
                console.warn('[Denarii] Demo cleanup skipped — cloud session is not this account.');
                return;
            }

            // 1. trades — all trades linked to the demo broker
            client.from('trades')
                .delete()
                .eq('user_id', userId)
                .eq('broker_account_id', DEMO_BROKER_ID)
                .then(function (r) {
                    if (r.error) console.warn('[Denarii] Demo cleanup (trades):', r.error.message);
                    else console.log('[Denarii] Demo trades deleted from Supabase.');
                });

            // 2. broker_accounts — the demo broker itself
            client.from('broker_accounts')
                .delete()
                .eq('user_id', userId)
                .eq('id', DEMO_BROKER_ID)
                .then(function (r) {
                    if (r.error) console.warn('[Denarii] Demo cleanup (broker_accounts):', r.error.message);
                    else console.log('[Denarii] Demo broker deleted from Supabase.');
                });

            // 3. tags — demo-seeded tags with deterministic id prefix
            client.from('tags')
                .delete()
                .eq('user_id', userId)
                .like('id', 'tag_demo_%')
                .then(function (r) {
                    if (r.error) console.warn('[Denarii] Demo cleanup (tags):', r.error.message);
                    else console.log('[Denarii] Demo tags deleted from Supabase.');
                });

            // 4. strategies — demo-seeded strategies with known id range
            var demoStratIds = [];
            for (var i = 1000001; i <= 1000013; i++) demoStratIds.push(String(i));
            client.from('strategies')
                .delete()
                .eq('user_id', userId)
                .in('id', demoStratIds)
                .then(function (r) {
                    if (r.error) console.warn('[Denarii] Demo cleanup (strategies):', r.error.message);
                    else console.log('[Denarii] Demo strategies deleted from Supabase.');
                });

            // reviews and note_templates: skipped in Phase D.
            // Reviews use _isDemo inside JSONB data column — no safe
            // server-side filter without a dedicated column. Will be
            // addressed in a future phase.
        });
    } catch (e) {
        console.warn('[Denarii] Demo Supabase cleanup error:', e.message || e);
    }
}

async function _persistAndRefreshUI() {
    if (typeof saveToIndexedDB === 'function') await saveToIndexedDB();
    if (typeof window.renderBrokerAccountsList === 'function') window.renderBrokerAccountsList();
    if (typeof window.populateBrokerAccountDropdowns === 'function') window.populateBrokerAccountDropdowns();
    if (typeof window._invalidateCloudDash === 'function') window._invalidateCloudDash();
    if (typeof updateDashboard === 'function') updateDashboard();
}

// Remove demo broker + all its trades/reviews from journalData
function _removeDemoBrokerData(data) {
    if (!data) return;
    if (data.brokerAccounts) {
        data.brokerAccounts = data.brokerAccounts.filter(function(a) { return a.id !== DEMO_BROKER_ID; });
    }
    if (data.trades) {
        data.trades = data.trades.filter(function(t) { return t.brokerAccountId !== DEMO_BROKER_ID; });
    }
    // Remove demo-keyed reviews, daily planners, and weekly planners
    // All demo entries are marked with _isDemo flag during seeding
    ['reviews', 'dailyPlanners', 'weeklyPlanners'].forEach(function(store) {
        if (data[store]) {
            var keys = Object.keys(data[store]);
            for (var i = 0; i < keys.length; i++) {
                if (data[store][keys[i]] && data[store][keys[i]]._isDemo) {
                    delete data[store][keys[i]];
                }
            }
        }
    });
    delete data._demoBrokerVersion;
}

// ═══════════════════════════════════════════════════════════════════════
// Legacy stubs — prevent crashes from old code paths
// ═══════════════════════════════════════════════════════════════════════
async function seedDemoAccount() { /* deprecated — now a no-op */ }
async function syncDemoData() { /* deprecated — now a no-op */ }
async function restoreDemoAccount() { return restoreDemoBroker(); }
function backfillDemoJournal() { return false; }

// ═══════════════════════════════════════════════════════════════════════
// DATA BUILDER — generates the full demo broker dataset
// ═══════════════════════════════════════════════════════════════════════

function _buildDemoBrokerData() {
    var rng = _makePRNG(0xDE110724);
    var pick = function(arr) { return arr[Math.floor(rng() * arr.length)]; };
    var rFloat = function(lo, hi) { return lo + rng() * (hi - lo); };
    var rInt = function(lo, hi) { return Math.floor(rFloat(lo, hi + 1)); };
    var round2 = function(n) { return Math.round(n * 100) / 100; };
    var _h = function(id) { return ((id * 2654435761) >>> 0); };
    var _hf = function(id, lo, hi) { return lo + (_h(id) % 10000) / 10000 * (hi - lo); };

    // ── Broker account ──
    var brokerAccount = {
        id: DEMO_BROKER_ID,
        broker: 'Pelosi',
        accountNumber: '',
        displayName: 'Pelosi',
        tradingStyle: 'day_trading',
        color: '#f59e0b',
        isDefault: false,
        visible: true,
        isDemo: true,
        createdAt: '2024-03-01T09:00:00.000Z'
    };

    // ── Reference data ──
    var STOCKS = ['AAPL','NVDA','TSLA','AMZN','META','GOOGL','AMD','COIN','PLTR','NFLX',
                  'SPY','QQQ','MSFT','SQ','SHOP','ROKU','DIS','BAC','JPM','XOM'];
    var OPTIONS = ['SPY','QQQ','AAPL','NVDA','TSLA','AMD','META'];

    var SETUPS = [
        'Breakout','VWAP Reclaim','Opening Range Break','Pullback to EMA',
        'Gap Fill','Reversal','Support Bounce','Trend Continuation',
        'Failed Breakout','Double Bottom','Bull Flag','Earnings Play','Gap N Go'
    ];
    // Weighted setup distribution — some setups are more common
    var SETUP_WEIGHTS = [14,12,11,10,8,7,7,7,6,5,5,4,4];
    var SETUP_POOL = [];
    for (var sw = 0; sw < SETUPS.length; sw++) {
        for (var swi = 0; swi < SETUP_WEIGHTS[sw]; swi++) SETUP_POOL.push(SETUPS[sw]);
    }

    var GOOD_EMO = ['Confident','Patient','Focused'];
    var BAD_EMO = ['FOMO','Anxious','Revenge Trading','Frustrated','Distracted'];

    var TAGS_POOL = ['gap-up','high-volume','earnings','catalyst','momentum','news',
                     'trend-day','pre-market-mover','sector-rotation','continuation',
                     'oversold-bounce','squeeze'];

    // ── Content pools (expanded for variety) ──
    var ENTRY_W = [
        'Clean breakout above key resistance with volume confirmation. Waited for the retest before entering.',
        'VWAP reclaim on first attempt, market was trending. Entered on the first 1m candle close above.',
        'Opening range breakout with strong relative strength. Clear setup — waited for the 5m close.',
        'Pullback to 9 EMA holding on the daily. Added on the bounce with appropriate size.',
        'Gap up with strong pre-market volume. Bought the first VWAP test after the open.',
        'Bull flag tight consolidation. Entered on the range break with volume.',
        'Earnings beat drove a gap that held all day. Entered early and let it work.',
        'Double bottom on the 15m with a clear neckline break. Clean entry.',
        'Market was in a clear trend day up. Entered pullbacks into strength all session.',
        'Strong sector day. NVDA leading semis — bought the first dip.',
        'Pre-market levels were hit within the first 15 minutes. Entered right at the level.',
        'Relative volume was 3x average. Clean setup, clean entry.',
        'SPY reclaimed the 21 EMA on the 5m and this name led the push. Entered on the follow-through.',
        'Tight range broke up after 30 minutes of consolidation. Volume confirmed the move.',
        'Clear higher-low structure on the 1m. Entered with a tight stop underneath.',
        'Daily level held perfectly as support. Bounced hard on the test — textbook.',
        'Strong pre-market gapper with news catalyst. Bought the first consolidation break.',
        'Previous day close acted as support. Entered on the hold with defined risk.',
        'Inside bar breakout on the 15m lined up with overall trend. Clean trigger.',
        'Oversold bounce after 3 red days. RSI divergence confirmed the reversal entry.'
    ];
    var ENTRY_L = [
        'Chased the move after missing the initial breakout. Entered too extended.',
        'FOMO into a hot ticker already up 8%. Did not wait for a clean setup.',
        'Entered to make back earlier losses. Broke the revenge trade rule.',
        'Premature entry before the candle closed above resistance.',
        'Averaged down into a losing position after my stop was hit.',
        'Took a trade out of boredom. No clear setup justified the risk.',
        'Wide stop, small size — but setup was low quality. Should have passed.',
        'Entered against the trend. Market was clearly red and I went long anyway.',
        'Poor read on the level 2. Lots of sellers I did not account for.',
        'News spike entry. Bought the top of the spike without waiting for a base.',
        'Entered during the lunch chop. No volume, no follow-through.',
        'Setup looked good on the 1m but the 5m was clearly distributing.',
        'Took a trade on a ticker I had no plan for. Pure impulse.',
        'Ignored the macro: SPY was selling off and I went long a weak name.',
        'Sized too large for the quality of this setup. B-grade at best.',
        'Entered before the pullback was complete. Got shaken out and it went without me.',
        'No pre-market prep today. Entered blind and paid for it.',
        'Afternoon trade after already hitting my daily target. Gave back profits.',
        'Traded through a news event without knowing it was coming. Got caught.',
        'The setup was there but my timing was off by 10 minutes. Late entry = bad fill.'
    ];
    var EXIT_W = [
        'Hit first target at prior resistance. Partial exit then trailed the rest.',
        'Stock started showing distribution on the 5m. Exited before reversal.',
        'Reached daily profit goal — took the win and closed the laptop.',
        'Clean move to measured target. Exited as planned with no second-guessing.',
        'Catalyst pushed it past my target. Sold into strength on the extension.',
        'Took 2R and moved on. Did not get greedy.',
        'Parabolic move into close. Sold into the last buying surge.',
        'Momentum slowed at prior swing high. Took the move and left.',
        'Two consecutive red 1m candles after new high. Respected the sign.',
        'Used a trailing stop that triggered at a logical support break.',
        'Sold half at first target, rest at measured move. Perfect execution.',
        'Volume dried up after the push. Recognized distribution and exited.',
        'Trailed the stop to break-even after 1R. Let it run to 2.5R.',
        'Market started rolling over — got out before the broader selloff.',
        'The tape showed big sellers stepping in. Honored the signal and exited cleanly.'
    ];
    var EXIT_L = [
        'Hit stop loss exactly as planned. Small loss, accepted it and moved on.',
        'Cut it early when the setup broke down below the entry trigger.',
        'Held too long hoping for a bounce. Should have cut at the first warning.',
        'Let the loss run past my stop. Emotional decision cost more than it should.',
        'Sold in a panic near the low. Stopped out and watched it recover.',
        'Wide stop got hit on a shakeout. Reviewed and size was too big.',
        'Market reversed hard. Stopped out of three positions at once.',
        'Earnings miss caused a gap down through my stop overnight.',
        'Broke down below VWAP with heavy selling. Got out quickly.',
        'Failed breakout — got out once it closed back below the level.',
        'Stop hit. Accepted it. The process requires taking planned losses.',
        'Should have exited earlier when the 5m showed the first lower high.',
        'Let a -0.5R loss become -1.5R. Moved my stop. Never again.',
        'The trade thesis broke but I held anyway. Discipline failure.',
        'Caught in a bear trap. Stop was too tight for this name\'s range.'
    ];
    var LESSONS_W = [
        'Patience paid off. Waiting for the right entry makes all the difference.',
        'Following the plan works. No second-guessing the process.',
        'Risk was clearly defined before entry. That is the only way to trade.',
        'Good discipline today. Let the trade develop without interference.',
        'Staying consistent with the process creates consistent results.',
        'This is what A+ setups look like. Keep this as a reference.',
        'Sizing was appropriate for the quality of the setup.',
        'Reviewing this trade confirms the system is working.',
        'Pre-market prep paid off. I knew the levels and executed the plan.',
        'Emotion check: stayed calm throughout. That is the goal every day.',
        'The best trades require the least management. Good entries make everything easier.',
        'Trusting the setup and the stop is the whole game. Did that today.',
        'Smaller size, cleaner execution. Quality over quantity.',
        'When the market gives you a trend day, ride it. Today was that day.',
        'The process is boring when it works. That is a good sign.'
    ];
    var LESSONS_L = [
        'Do not chase. If you miss the entry, let it go and find the next setup.',
        'Revenge trading always makes the day worse. Stop after two losses.',
        'Respect the stop. A planned loss is not a failure.',
        'Risked too much on a B-grade setup. Reserve full size for A+ setups only.',
        'This trade was emotion-driven, not rule-based. Review the checklist.',
        'Averaging down is not a strategy. Honor the original risk.',
        'Low-quality setup accepted out of boredom. Avoid dead hours.',
        'The trend was clearly down. Do not fight the tape.',
        'Pre-market prep missed this risk. Add news check to morning routine.',
        'Size was too large given how extended the move already was.',
        'Every loss teaches something. This one: trust the first signal.',
        'Two losses in a row means step away for 30 minutes. Did not do that today.',
        'The stop is there for a reason. Moving it is not an option.',
        'Trading without a plan is gambling. Today was gambling.',
        'Afternoon trades after a green morning are my biggest leak. Fix this.'
    ];

    var QUICK_W = [
        'Clean execution. Followed the plan.','Good entry, hit target. Disciplined exit.',
        'Solid setup. Let the trade work.','Patience paid off. Good read on the level.',
        'A+ entry and exit. This is the process.','Trailed the stop and let it run.',
        'Pre-market prep identified this level perfectly.','Waited for confirmation. Got rewarded.',
        'Clean risk/reward. Textbook execution.','Entered on the retest. Exited at resistance.',
        'Best trade of the day. Clean from start to finish.','Let the winner run. No interference.',
        'Sized right, timed right. Process working.','Simple setup, simple execution.',
        'Caught the move early and managed it well.','Volume confirmed. No hesitation on entry.',
        'Stuck to the plan even when it felt slow.','Partial at target, trail the rest. Textbook.',
        'Read the tape correctly. Clean decision.','This is what consistency looks like.'
    ];
    var QUICK_L = [
        'Chased the entry. Got punished.','Setup was marginal. Should have passed.',
        'Stopped out. Respected the plan.','Broke the rules. Paid for it.',
        'Entered without a clear trigger.','Sized too big for this setup quality.',
        'Fought the trend. Lost.','Emotional entry after earlier loss.',
        'Wide stop got hit. Acceptable loss.','No edge here. Just noise.',
        'Revenge trade. Should have walked away.','FOMO entry. Not in the playbook.',
        'Afternoon slop trade. Should have been done.','Ignored the red flags on the tape.',
        'Late entry, poor fill, bad outcome.','This setup works 60% of the time. This was the 40%.',
        'Loss is part of the process. Move on.','Over-managed the trade. Let it breathe.',
        'Setup was fine, execution was poor.','Market environment was wrong for this play.'
    ];

    // Win tag combos
    var WIN_TAGS = [
        ['A+ Entry','Honored Stop'],['Scaled In Well','Confident'],
        ['A+ Entry','Focused','Honored Stop'],['Breakout','A+ Entry','Disciplined'],
        ['Pullback','Scaled In Well','Confident'],['ORB','A+ Entry','Focused','Honored Stop'],
        ['Gap and Go','Confident','Scaled In Well'],['Reversal','A+ Entry','Disciplined','Honored Stop'],
        ['Breakout','Focused','Honored Stop'],['Pullback','Confident','A+ Entry'],
        ['A+ Entry','Disciplined'],['Focused','Honored Stop','Confident'],
        ['Gap and Go','A+ Entry'],['Scaled In Well','Focused']
    ];
    var LOSS_TAGS = [
        ['Late Entry','Early Exit'],['FOMO Entry','Panic Exit'],
        ['Chased Price','Ignored Stop'],['Revenge Trade','Impulsive','Late Exit'],
        ['Early Entry','Cut Winner Too Early'],['FOMO Entry','Overtrading','Revengeful'],
        ['Chased Price','Panic Exit','Impulsive'],['Late Entry','Ignored Stop','Revengeful'],
        ['Early Entry','Early Exit','Impulsive'],['Revenge Trade','Late Exit','Overtrading'],
        ['FOMO Entry','Late Entry'],['Chased Price','Early Exit'],
        ['Impulsive','Overtrading'],['Ignored Stop','Late Exit']
    ];

    // ── Trading day calendar: March 1 2024 – March 31 2026 ──
    var BASE = new Date('2024-03-01T00:00:00.000Z');
    var tradingDays = [];
    var totalCalDays = 762; // Mar 1 2024 to Mar 31 2026
    for (var i = 0; i < totalCalDays; i++) {
        var d = new Date(BASE); d.setUTCDate(d.getUTCDate() + i);
        var dow = d.getUTCDay();
        if (dow !== 0 && dow !== 6) tradingDays.push(i);
    }

    var idSeq = 1709280000000; // Mar 1 2024 00:00 UTC in ms

    function makeEntryTime(dayOff, hourET) {
        var dd = new Date(BASE);
        dd.setUTCDate(dd.getUTCDate() + dayOff);
        // Approximate ET→UTC: +5 Nov-Mar, +4 Mar-Nov
        var month = dd.getUTCMonth();
        var utcOff = (month >= 2 && month <= 10) ? 4 : 5;
        dd.setUTCHours(hourET + utcOff, rInt(0, 59), rInt(0, 59), 0);
        return dd;
    }

    function makeTrade(dayOff, isWin, style, assetType) {
        idSeq += rInt(60000, 3600000);
        var id = idSeq;

        var isDay = style === 'day_trading';
        var isOpt = assetType === 'option';

        var symbol = isOpt ? pick(OPTIONS) : pick(STOCKS);
        var setup = pick(SETUP_POOL);
        var emotion = isWin
            ? pick(['Confident','Patient','Focused','Confident','Focused'])
            : pick(['FOMO','Anxious','Revenge Trading','Frustrated','Distracted']);

        var entryHour = rInt(9, 14);
        var entryTime = makeEntryTime(dayOff, entryHour);

        var holdMins = isOpt
            ? rInt(15, 360)
            : isDay ? rInt(4, 240) : rInt(480, 4320);
        var exitTime = new Date(entryTime.getTime() + holdMins * 60000);

        var entryPrice, exitPrice, quantity, pnl, optionType, strike, expiry, optionAction;

        if (isOpt) {
            optionType = rng() > 0.5 ? 'CALL' : 'PUT';
            optionAction = 'buy';
            entryPrice = round2(rFloat(1.20, 14.50));
            var move = isWin ? rFloat(0.20, 0.85) : rFloat(-0.15, -0.65);
            exitPrice = round2(Math.max(0.05, entryPrice * (1 + move)));
            quantity = rInt(1, 8);
            pnl = round2((exitPrice - entryPrice) * quantity * 100);

            var underlying = symbol === 'SPY' ? rFloat(440, 530)
                           : symbol === 'QQQ' ? rFloat(360, 480)
                           : rFloat(60, 380);
            var otm = rFloat(0.01, 0.04);
            var raw = optionType === 'call'
                ? underlying * (1 + otm)
                : underlying * (1 - otm);
            strike = round2(Math.round(raw / 0.5) * 0.5);

            var expD = new Date(entryTime);
            expD.setUTCDate(expD.getUTCDate() + rInt(0, 6));
            expiry = expD.toISOString().split('T')[0];
        } else {
            optionType = null; optionAction = null; strike = 0; expiry = null;
            var isLong = rng() > 0.22;
            var base = rFloat(15, 450);
            entryPrice = round2(base);
            var movePct = isWin
                ? rFloat(0.006, 0.055) * (isLong ? 1 : -1)
                : rFloat(0.004, 0.028) * (isLong ? -1 : 1);
            exitPrice = round2(entryPrice * (1 + movePct));
            quantity = isDay ? rInt(15, 250) : rInt(5, 60);
            pnl = round2((exitPrice - entryPrice) * quantity * (isLong ? 1 : -1));
        }

        // ── Tags ──
        var h = _h(id);
        var tagPool = isWin ? WIN_TAGS : LOSS_TAGS;
        var tags = (rng() < 0.85) ? tagPool[h % tagPool.length].slice() : [];

        // ── Grade ──
        var isGoodEmo = GOOD_EMO.indexOf(emotion) !== -1;
        var isBadEmo = BAD_EMO.indexOf(emotion) !== -1;
        var tradeGrade = '';
        if (rng() < 0.80) {
            if (isWin && isGoodEmo && pnl > 200) tradeGrade = 'A+';
            else if (isWin && isGoodEmo) tradeGrade = 'A';
            else if (isWin) tradeGrade = 'B';
            else if (!isWin && !isBadEmo && pnl > -100) tradeGrade = 'C';
            else if (!isWin && isBadEmo) tradeGrade = 'D';
            else tradeGrade = 'C';
        }

        // ── Targets/stops ──
        var profitTargets = [];
        var stopLosses = [];
        if (rng() < 0.90) {
            var tgtPct = _hf(id + 1, 0.015, 0.045);
            if (isOpt) {
                profitTargets = [{ price: round2(entryPrice * (1 + tgtPct * 3)), qty: quantity }];
            } else if (!isOpt && !(rng() > 0.22)) { // short
                profitTargets = [{ price: round2(entryPrice * (1 - tgtPct)), qty: quantity }];
            } else {
                profitTargets = [{ price: round2(entryPrice * (1 + tgtPct)), qty: quantity }];
            }
        }
        if (rng() < 0.90) {
            var riskPct = _hf(id + 2, 0.008, 0.025);
            if (isOpt) {
                stopLosses = [{ price: round2(entryPrice * (1 - riskPct * 2)), qty: quantity }];
            } else if (!isOpt && !(rng() > 0.22)) {
                stopLosses = [{ price: round2(entryPrice * (1 + riskPct)), qty: quantity }];
            } else {
                stopLosses = [{ price: round2(entryPrice * (1 - riskPct)), qty: quantity }];
            }
        }

        // ── Commission ──
        var commissionFees = isOpt
            ? round2(quantity * 0.65)
            : round2(quantity * 0.005 > 1 ? quantity * 0.005 : 0);

        // ── Notes (with variation: 75% have notes, 25% empty) ──
        var notes = '';
        var entryReason = '';
        var exitReason = '';
        var lessons = '';
        var quickNotes = '';
        if (rng() < 0.75) {
            entryReason = isWin ? ENTRY_W[h % ENTRY_W.length] : ENTRY_L[h % ENTRY_L.length];
            exitReason = isWin ? EXIT_W[h % EXIT_W.length] : EXIT_L[h % EXIT_L.length];
            lessons = isWin ? LESSONS_W[h % LESSONS_W.length] : LESSONS_L[h % LESSONS_L.length];
            notes = '<p><strong>Entry:</strong> ' + entryReason + '</p>'
                  + '<p><strong>Exit:</strong> ' + exitReason + '</p>'
                  + '<p><strong>Lesson:</strong> ' + lessons + '</p>';
        }
        if (rng() < 0.65) {
            quickNotes = isWin ? QUICK_W[h % QUICK_W.length] : QUICK_L[h % QUICK_L.length];
        }

        // ── Drawdown / runup ──
        var movePerShare = Math.abs(exitPrice - entryPrice);
        var drawdown, runup;
        if (isWin) {
            runup = round2(movePerShare * _hf(id + 3, 1.0, 1.4));
            drawdown = round2(movePerShare * _hf(id + 4, 0.1, 0.5) * -1);
        } else {
            drawdown = round2(movePerShare * _hf(id + 3, 1.0, 1.3) * -1);
            runup = round2(movePerShare * _hf(id + 4, 0.05, 0.4));
        }

        // ── R-multiple fields ──
        var tradeRisk = null, initialTarget = null, plannedRMultiple = null, realizedRMultiple = null;
        if (stopLosses.length) {
            tradeRisk = round2(Math.abs(entryPrice - stopLosses[0].price) * quantity);
            initialTarget = profitTargets.length
                ? round2(Math.abs(profitTargets[0].price - entryPrice) * quantity) : 0;
            plannedRMultiple = tradeRisk > 0 && initialTarget > 0
                ? round2(initialTarget / tradeRisk) : 0;
            realizedRMultiple = tradeRisk > 0
                ? round2(Math.abs(pnl) / tradeRisk * (isWin ? 1 : -1)) : 0;
        }

        return {
            id: id,
            symbol: symbol,
            type: isOpt ? 'long' : (rng() > 0.22 ? 'long' : 'short'),
            quantity: quantity,
            entryPrice: entryPrice,
            exitPrice: exitPrice,
            entryTime: entryTime.toISOString(),
            exitTime: exitTime.toISOString(),
            holdSeconds: holdMins * 60,
            pnl: pnl,
            brokerAccountId: DEMO_BROKER_ID,
            assetType: assetType,
            optionType: optionType,
            optionAction: optionAction,
            strike: strike,
            expiry: expiry,
            setupType: setup,
            strategyScore: null,
            emotion: emotion,
            tags: tags,
            tradeGrade: tradeGrade,
            entryReason: entryReason,
            exitReason: exitReason,
            lessons: lessons,
            notes: notes,
            quickNotes: quickNotes,
            profitTargets: profitTargets,
            stopLosses: stopLosses,
            commissionFees: commissionFees,
            tradeRisk: tradeRisk,
            initialTarget: initialTarget,
            plannedRMultiple: plannedRMultiple,
            realizedRMultiple: realizedRMultiple,
            drawdown: drawdown,
            runup: runup,
            source: rng() > 0.65 ? 'imported' : 'manual'
        };
    }

    // ── Generate trades ──
    var trades = [];

    // ~1080 stock trades (70%) — 57% win rate
    for (var si = 0; si < 1080; si++) {
        var sDay = tradingDays[si % tradingDays.length];
        var sWin = rng() < 0.57;
        var sStyle = rng() < 0.68 ? 'day_trading' : 'swing_trading';
        trades.push(makeTrade(sDay, sWin, sStyle, 'stock'));
    }

    // ~490 option trades (30%) — 53% win rate
    for (var oi = 0; oi < 490; oi++) {
        var oDay = tradingDays[oi % tradingDays.length];
        var oWin = rng() < 0.53;
        trades.push(makeTrade(oDay, oWin, 'day_trading', 'option'));
    }

    trades.sort(function(a, b) { return new Date(a.entryTime) - new Date(b.entryTime); });

    // ── Backfill strategy scores ──
    var strategies = (typeof getDemoStrategySeedList === 'function')
        ? getDemoStrategySeedList()
        : [];
    if (strategies.length) _backfillDemoRuleAdherence(trades, strategies);

    // ── Build reviews ──
    var reviews = _buildDemoReviews(trades);

    // ── Demo tags ──
    var tagCategories = ['Setups','Mistakes','Entry Execution','Exit Execution','Missed Trades','Emotional State'];
    var tags = [
        { id:'tag_demo_001', name:'FOMO Entry',          category:'Mistakes',        description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_002', name:'Revenge Trade',        category:'Mistakes',        description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_003', name:'Overtrading',          category:'Mistakes',        description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_004', name:'Ignored Stop',         category:'Mistakes',        description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_005', name:'Bought by Accident',   category:'Mistakes',        description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_006', name:'Gap and Go',           category:'Setups',          description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_007', name:'ORB',                  category:'Setups',          description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_008', name:'Pullback',             category:'Setups',          description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_009', name:'Breakout',             category:'Setups',          description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_010', name:'Reversal',             category:'Setups',          description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_011', name:'A+ Entry',             category:'Entry Execution', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_012', name:'Early Entry',          category:'Entry Execution', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_013', name:'Late Entry',           category:'Entry Execution', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_014', name:'Chased Price',         category:'Entry Execution', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_015', name:'Scaled In Well',       category:'Entry Execution', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_016', name:'Early Exit',           category:'Exit Execution',  description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_017', name:'Late Exit',            category:'Exit Execution',  description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_018', name:'Honored Stop',         category:'Exit Execution',  description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_019', name:'Panic Exit',           category:'Exit Execution',  description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_020', name:'Cut Winner Too Early', category:'Exit Execution',  description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_021', name:'Hesitation',           category:'Missed Trades',   description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_022', name:'No Confidence',        category:'Missed Trades',   description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_023', name:'Distracted',           category:'Missed Trades',   description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_024', name:'Too Slow',             category:'Missed Trades',   description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_025', name:'No Alert Set',         category:'Missed Trades',   description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_026', name:'Confident',            category:'Emotional State', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_027', name:'Focused',              category:'Emotional State', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_028', name:'Impulsive',            category:'Emotional State', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_029', name:'Disciplined',          category:'Emotional State', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true },
        { id:'tag_demo_030', name:'Revengeful',           category:'Emotional State', description:'', createdAt:'2024-03-01T09:30:00.000Z', isDemoSeed:true }
    ];

    // ── Build planners ──
    var planners = _buildDemoPlanners(tradingDays, BASE, rng, pick);

    return {
        brokerAccount: brokerAccount,
        trades: trades,
        tags: tags,
        tagCategories: tagCategories,
        reviews: reviews,
        dailyPlanners: planners.daily,
        weeklyPlanners: planners.weekly
    };
}

// ═══════════════════════════════════════════════════════════════════════
// PLANNER BUILDER — generates daily and weekly planners
// ═══════════════════════════════════════════════════════════════════════

function _buildDemoPlanners(tradingDays, BASE, rng, pick) {
    var pad = function(n) { return n < 10 ? '0' + n : '' + n; };
    function dateKey(dayOff) {
        var d = new Date(BASE); d.setUTCDate(d.getUTCDate() + dayOff);
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }
    function isoWeekKey(dayOff) {
        var d = new Date(BASE); d.setUTCDate(d.getUTCDate() + dayOff);
        var date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        var ys = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        var wn = Math.ceil(((date - ys) / 86400000 + 1) / 7);
        return date.getUTCFullYear() + '-W' + pad(wn);
    }

    var STOCKS = ['AAPL','NVDA','TSLA','AMZN','META','GOOGL','AMD','COIN','PLTR','NFLX',
                  'SPY','QQQ','MSFT','SQ','SHOP','ROKU'];

    // ── Daily planner content pools ──
    var DP_BIAS = ['bullish','bearish','neutral','bullish','bullish','neutral','bearish','neutral','bullish','neutral'];
    var DP_EVENTS = [
        'No major catalysts today.','FOMC rate decision at 2 PM ET.','CPI data at 8:30 AM ET.',
        'AAPL earnings after close.','NVDA earnings after close.','Quad witching day.',
        'Jobs report at 8:30 AM ET.','Fed speaker at 1 PM ET.','No economic data today.',
        'PCE inflation data at 8:30 AM.','Retail sales report this morning.','PPI data at 8:30 AM.',
        'Weekly jobless claims at 8:30 AM.','ISM manufacturing at 10 AM.','No catalysts — clean tape day.',
        'TSLA delivery numbers expected.','OPEX today — expect pinning action.','GDP revision at 8:30 AM.',
        'Jackson Hole speech today.','Bank earnings this morning.','Big tech earnings week starts.',
        'End of quarter rebalancing likely.','VIX elevated — caution on size.','Low volume pre-holiday session.',
        'Consumer confidence at 10 AM.'
    ];
    var DP_CONTENT = [
        '<p>Futures green pre-market. Looking for long setups above VWAP on strong relative-strength names. Will wait for the first 15 minutes to settle before entering. Max 3 trades today.</p>',
        '<p>Market gapping down on weak futures. Watching for gap-fill setups or short opportunities on weak names below VWAP. Keeping size small until direction is clear.</p>',
        '<p>No strong directional bias. Range day expected. Only taking A+ setups with tight risk defined. If nothing sets up by 11 AM, stepping away.</p>',
        '<p>Strong trend day expected. SPY above all key MAs. Looking to buy pullbacks to VWAP on momentum names. Let winners run, trail stops aggressively.</p>',
        '<p>CPI day — expecting volatility. Will wait until 10:30 for the dust to settle before taking any positions. Small size only on first trade.</p>',
        '<p>Earnings season is in full swing. Focusing on post-earnings continuations rather than gap plays. Looking for names that gapped and held above VWAP.</p>',
        '<p>Choppy market this week. Reducing trade count to 2 max. Only taking trades at clearly defined support/resistance levels with volume confirmation.</p>',
        '<p>Pre-market scan shows several gappers. Focusing on the top 2-3 by relative volume. Will build a position on the first pullback after the opening range is set.</p>',
        '<p>Friday before a long weekend — expect low volume. Tight stops, small size, quick exits. No overnight holds.</p>',
        '<p>Sector rotation day expected. Tech leading, financials lagging. Playing the leaders today: NVDA, AMD, META. Watching for the 9 EMA hold on the 5m.</p>',
        '<p>Yesterday was a strong trend day up. Today expecting either continuation or mean reversion. Will let the first 30 minutes tell the story before committing.</p>',
        '<p>VIX is elevated. Keeping position sizes 50% of normal. Looking for defined-risk setups only. No averaging down today.</p>',
        '<p>Simple day: follow the morning checklist, take the first clean A-grade setup, manage it according to the plan, and review after close.</p>',
        '<p>Fed day. Not trading until after 2:30 PM ET. Then watching for the post-announcement trend to develop. Usually get a clear direction by 3 PM.</p>',
        '<p>Quad witching — expect unusual volume and pinning action near round strikes. Playing small, looking for late-day breakouts if they come.</p>',
        '<p>Market has been choppy all week. Today is about patience. If nothing clean sets up, zero trades is a win. Protect the weekly P&L.</p>',
        '<p>Strong overnight futures on positive earnings from AMZN. Looking for gap-and-go setups on big tech. Key level on SPY: 480 support.</p>',
        '<p>Watching the 10-year yield closely today. If it breaks above 4.5%, expect rotation out of growth. Adjusting watchlist accordingly.</p>',
        '<p>Pre-market prep complete. Key levels identified. Alerts set. Now the job is to wait for the setups to come to me instead of forcing trades.</p>',
        '<p>Last trading day of the month. Window dressing possible. Watching for end-of-day buying pressure on large-cap winners. Quick scalps only.</p>',
        '<p>NVDA leading pre-market on AI chip news. Will look for the pullback entry rather than chasing the gap. Key level: yesterday\'s high.</p>',
        '<p>Bearish setup today: market below the 21 EMA on the daily. Focused on short setups and put spreads. Not fighting the trend.</p>',
        '<p>Consolidation pattern forming on SPY. Waiting for the breakout direction. Have both long and short watchlists ready.</p>',
        '<p>After yesterday\'s blow-up, today is about discipline recovery. Max 2 trades, small size, tight stops. Process over P&L.</p>',
        '<p>Clean green day yesterday. Goal today: do not give it back. Selective entries only. If I hit +$500, I am done for the day.</p>'
    ];
    var DP_BF_CONT = [
        'Following the pre-market checklist','Honoring stops on every trade','Waiting for confirmation before entry',
        'Taking partial profits at first target','Keeping size appropriate to setup quality','Reviewing the tape after close',
        'Sticking to my top 5 watchlist names','Using alerts instead of staring at screens','Journaling every trade same day',
        'Starting the day with a clear bias','Managing risk before thinking about reward','Trading the morning session only',
        'Letting winners run with a trailing stop','Reviewing yesterday\'s lessons before the open','Staying patient during the first 15 minutes'
    ];
    var DP_BF_STOP = [
        'Trading after 2 PM without a clear edge','Revenge trading after losses','Chasing extended moves',
        'Oversizing on marginal setups','Adding to losing positions','Trading random tickers from social media',
        'Taking trades during lunch hour','Moving stop losses to avoid being stopped out','Trading before checking the calendar for events',
        'Entering before the candle closes above/below the level','Fighting the overall market direction','Taking B-grade setups with full size',
        'Checking P&L mid-trade','Trading on tilt after a big win','Entering without a defined stop level'
    ];
    var DP_BF_FOCUS = [
        'Track emotional state before each entry','Set hard daily stop-loss at -$300','Review watchlist before the open',
        'Screenshot every trade for end-of-day review','Size down after 2 consecutive losses','Note the market condition before first trade',
        'Identify support/resistance on daily chart first','Set alerts at key levels instead of watching','Take a 10-minute break after each trade',
        'Write the setup thesis before entering','Check the VIX before first trade','Identify the day type in the first 30 minutes',
        'Plan the exit before the entry','Use a timer for 30-minute trade review','Log my energy level at the start of each session'
    ];

    // ── Weekly planner content pools ──
    var WP_CONDITION = ['trending-up','trending-down','range-bound','volatile','uncertain',
                        'trending-up','range-bound','trending-up','volatile','range-bound'];
    var WP_EXPECTED = [
        'Expecting continuation of the uptrend if SPY holds above the 21 EMA.',
        'Bearish lean unless we reclaim the 50-day MA. Watching for lower highs.',
        'Range-bound between 475-490 on SPY. Playing the edges until a breakout.',
        'High volatility expected due to FOMC and earnings. Keeping size small.',
        'Uncertain direction — conflicting signals. Waiting for clarity before committing.',
        'Strong trend likely to continue. Buying pullbacks to moving averages.',
        'Market may chop until CPI data on Wednesday. Then expect a directional move.',
        'Seasonal strength expected into month-end. Bullish bias on dips.',
        'Volatility compression suggests a big move is coming. Direction unclear.',
        'Post-earnings digestion week. Expect sector rotation and stock-picking opportunities.'
    ];
    var WP_EVENTS = [
        'FOMC Wednesday 2 PM, Jobs Friday 8:30 AM','CPI Tuesday, Retail Sales Thursday',
        'AAPL & MSFT earnings Wednesday after close','NVDA earnings Thursday after close',
        'No major events — clean trading week','Jackson Hole symposium Thu-Sat',
        'PCE Friday, GDP Thursday','Bank earnings Mon-Wed, PPI Thursday',
        'Quad witching Friday','Monthly OPEX Friday, Fed speakers Tue/Thu',
        'Consumer confidence Tuesday, Jobless claims Thursday','ISM Manufacturing Monday, Jobs Friday',
        'TSLA earnings Wednesday, META Thursday','End of quarter — window dressing likely',
        'Light week — only jobless claims Thursday'
    ];
    var WP_GUIDES = [
        'SPY key levels: 480 support, 495 resistance. QQQ: 410/425.',
        'Max 3 trades per day. Hard stop at -$500 daily loss.',
        'Focus on breakouts and VWAP reclaims only. No reversal plays.',
        'Trade only the first 2 hours and last 30 minutes. Skip the chop.',
        'Size: full on A-grade, half on B-grade, skip C-grade.',
        'If SPY is below VWAP, only take short setups or sit out.',
        'Earnings week: no positions held overnight unless thesis is very strong.',
        'Key sector watch: semis (SMH) and big tech (XLK) leading the tape.',
        'Volatility is elevated — reduce position size by 30% this week.',
        'Monthly close Friday — expect unusual flows. Be nimble.',
        'Focus on high-volume names only. RVol > 2x for any new entry.',
        'No new trades after 1 PM unless a clear trend day develops.'
    ];
    var WP_CONTENT = [
        '<p>This week the focus is on discipline. Last week I overtraded on 2 of 5 days and gave back morning gains. This week: max 3 trades per day, no afternoon trading unless a clear trend develops.</p><p>The market is in a strong uptrend on the daily. I want to buy pullbacks to VWAP or the 9 EMA and let winners run with trailing stops. Short setups only if SPY loses the 21 EMA.</p>',
        '<p>Earnings season is the dominant theme. I have AAPL and NVDA on the watchlist for post-earnings plays. For non-earnings names, I am sticking to the breakout playbook that worked last week.</p><p>Risk management goal: no single trade loss greater than -$150. If I hit -$300 for the day, I am done.</p>',
        '<p>Market has been range-bound for two weeks. This week I am playing the edges: long near support, short near resistance, with tight stops in both directions. If we break out of the range, I will switch to trend-following mode.</p>',
        '<p>Coming off a strong week. The goal this week is to not give back last week\'s gains. I will be more selective with entries and only trade A-grade setups. Quality over quantity.</p><p>Key focus: trailing stops and partial profits. I left too much on the table last week by exiting too early on two winners.</p>',
        '<p>FOMC week. I do not trade on Wednesday until after the announcement. Monday and Tuesday are for setup identification only. Thursday and Friday are when the real moves happen as the market digests the decision.</p>',
        '<p>Volatility is elevated and the VIX is above 20. This week I am cutting my normal position size by 30-40%. The edge is the same but the risk per trade needs to be smaller in this environment.</p><p>Focus: defined-risk options trades (spreads, not naked) and quick scalps on momentum names.</p>',
        '<p>Last week was frustrating — two good setups that I missed because of hesitation, and two bad entries from FOMO. This week I am re-committing to the process: wait for the setup, take the entry, manage the trade.</p>',
        '<p>End of the month. I expect window dressing from institutions and some unusual flows on Friday. Most of my trading this week will be Mon-Wed. Thursday and Friday are for review and planning.</p>',
        '<p>Simple plan this week: follow the morning checklist, take only A-grade setups, honor every stop, journal every trade. The process produces the results. Trust it.</p>',
        '<p>CPI week. Tuesday morning will set the tone. If CPI comes in hot, expect a selloff — I have short setups ready. If cool, the rally continues and I am buying pullbacks on tech.</p><p>No positions held through the CPI print. Cash is a position.</p>',
        '<p>Post-earnings season wind-down. Volume may decrease. Adjusting expectations: smaller moves, tighter ranges, quicker exits. This is a stock-picker\'s market — sector rotation is the theme.</p>',
        '<p>Strong week expected based on the monthly chart setup. SPY is breaking out of a multi-week consolidation. I want to be positioned in the leaders: NVDA, META, AAPL. Pullbacks to the 9 EMA are buy zones.</p>',
        '<p>Choppy week ahead. Conflicting signals: daily trend is up but the weekly is showing distribution. I will trade lighter and focus on names with their own catalysts rather than riding the index.</p>',
        '<p>Recovery week after last week\'s drawdown. The priority is not making money — it is trading well. Small size, clean setups, disciplined exits. Rebuild confidence through process.</p>',
        '<p>Light economic calendar. This is a good week to focus on technique: entry timing, position management, exit discipline. No shortcuts, no forcing trades. Let the market come to me.</p>'
    ];
    var WP_BF_CONT = [
        'Pre-market checklist every morning','Honoring stops without exception','Reviewing the weekly plan on Monday',
        'Sticking to A-grade setups only','Taking partial profits at first target','Journaling every trade the same day',
        'Morning meditation before the open','Tracking my best time windows','Reducing size after 2 consecutive losses',
        'Following the process regardless of P&L'
    ];
    var WP_BF_STOP = [
        'Overtrading on slow days','Trading after 2 PM without edge','Revenge trading after losses',
        'Chasing extended moves','Adding to losers','Trading off social media tips',
        'Ignoring the overall market direction','Taking trades without a defined stop','Checking P&L obsessively',
        'Trading through major news events unprepared'
    ];
    var WP_BF_FOCUS = [
        'Weekly performance review every Friday','Tracking emotional patterns across the week','Setting weekly max loss at -$1000',
        'Identifying the strongest sector each Monday','Maintaining a watchlist of 5-10 names only','Reviewing monthly goals mid-week',
        'Journaling not just trades but also missed setups','Tracking win rate by setup type','End-of-week equity curve screenshot',
        'Planning next week\'s key levels on Friday afternoon'
    ];

    var daily = {};
    var weekly = {};
    var ts = Date.now();

    // ── Generate daily planners (~50% of trading days) ──
    for (var di = 0; di < tradingDays.length; di++) {
        // Deterministic skip: ~50% coverage
        if (((di * 13 + 7) % 100) >= 50) continue;
        var dk = dateKey(tradingDays[di]);
        var dIdx = di;
        // Build a watchlist of 3-5 tickers
        var wlCount = 3 + (dIdx % 3);
        var wl = [];
        for (var wi = 0; wi < wlCount; wi++) {
            var t = STOCKS[(dIdx + wi * 3) % STOCKS.length];
            if (wl.indexOf(t) === -1) wl.push(t);
        }

        daily['dp|' + dk] = {
            bias: DP_BIAS[dIdx % DP_BIAS.length],
            keyEvents: DP_EVENTS[dIdx % DP_EVENTS.length],
            watchlist: wl.join(', '),
            content: DP_CONTENT[dIdx % DP_CONTENT.length],
            behavioral: {
                cont: [{ text: DP_BF_CONT[dIdx % DP_BF_CONT.length], done: rng() < 0.6 }],
                stop: [{ text: DP_BF_STOP[dIdx % DP_BF_STOP.length], done: rng() < 0.3 }],
                focus: [{ text: DP_BF_FOCUS[dIdx % DP_BF_FOCUS.length], done: rng() < 0.4 }]
            },
            updatedAt: new Date(dk + 'T13:30:00.000Z').toISOString(),
            _isDemo: true
        };
    }

    // ── Generate weekly planners (~60% of trading weeks) ──
    var weeksSeen = {};
    for (var wdi = 0; wdi < tradingDays.length; wdi++) {
        var wk = isoWeekKey(tradingDays[wdi]);
        if (!weeksSeen[wk]) weeksSeen[wk] = true;
    }
    var weekKeys = Object.keys(weeksSeen).sort();
    for (var wki = 0; wki < weekKeys.length; wki++) {
        // Deterministic skip: ~60% coverage
        if (((wki * 17 + 5) % 100) >= 60) continue;
        var wKey = weekKeys[wki];
        var wIdx = wki;

        weekly['wp|' + wKey] = {
            condition: WP_CONDITION[wIdx % WP_CONDITION.length],
            expectedNext: WP_EXPECTED[wIdx % WP_EXPECTED.length],
            keyEvents: WP_EVENTS[wIdx % WP_EVENTS.length],
            keyGuides: WP_GUIDES[wIdx % WP_GUIDES.length],
            content: WP_CONTENT[wIdx % WP_CONTENT.length],
            behavioral: {
                cont: [{ text: WP_BF_CONT[wIdx % WP_BF_CONT.length], done: rng() < 0.5 }],
                stop: [{ text: WP_BF_STOP[wIdx % WP_BF_STOP.length], done: rng() < 0.25 }],
                focus: [{ text: WP_BF_FOCUS[wIdx % WP_BF_FOCUS.length], done: rng() < 0.35 }]
            },
            updatedAt: new Date(wKey.split('-W')[0] + '-01-01T08:00:00.000Z').toISOString(),
            _isDemo: true
        };
    }

    return { daily: daily, weekly: weekly };
}

// ═══════════════════════════════════════════════════════════════════════
// RULE-ADHERENCE BACKFILL
// ═══════════════════════════════════════════════════════════════════════

function _backfillDemoRuleAdherence(trades, strategies) {
    function _h(id) { return ((id * 2654435761) >>> 0); }
    function _round2(n) { return Math.round(n * 100) / 100; }

    var stratMap = {};
    strategies.forEach(function(s) {
        if (s.groups && s.groups.length) stratMap[s.name] = s;
    });

    function _grade(pct, allMand) {
        if (allMand) {
            if (pct >= 100) return 'A+';
            if (pct >= 90)  return 'A';
            if (pct >= 80)  return 'B';
            if (pct >= 70)  return 'C';
            if (pct >= 60)  return 'D';
            return 'F';
        } else {
            if (pct >= 80) return 'B';
            if (pct >= 70) return 'C';
            if (pct >= 60) return 'D';
            return 'F';
        }
    }

    function _eff(rule) {
        return (rule.isMandatory && rule.stars > 0) ? rule.stars + 1 : rule.stars;
    }

    trades.forEach(function(t) {
        if (t.strategyScore) return;

        var strat = stratMap[t.setupType];
        if (!strat) return;

        // ~70% get strategy scores
        var h = _h(t.id);
        if ((h % 100) >= 70) return;

        var outcome = t.pnl > 0 ? 'winner' : t.pnl < 0 ? 'loser' : 'breakeven';

        var allRules = [];
        strat.groups.forEach(function(g) {
            (g.rules || []).forEach(function(r) {
                if (r.showWhen === 'always' || r.showWhen === outcome) {
                    allRules.push(r);
                }
            });
        });
        var scoredRules = allRules.filter(function(r) { return r.stars > 0; });
        if (!scoredRules.length) return;

        var baseProb;
        if (t.pnl > 200)      baseProb = 0.92;
        else if (t.pnl > 0)   baseProb = 0.80;
        else if (t.pnl === 0)  baseProb = 0.60;
        else if (t.pnl > -100) baseProb = 0.50;
        else                   baseProb = 0.35;

        var tradeShift = ((h % 100) / 100 - 0.5) * 0.24;
        var tradeProb = Math.min(0.98, Math.max(0.15, baseProb + tradeShift));

        var followed = [];
        var actualScore = 0;
        var allMandatoryFollowed = true;

        scoredRules.forEach(function(rule, idx) {
            var ruleHash = _h(t.id + rule.id + idx * 7);
            var ruleRoll = (ruleHash % 10000) / 10000;

            var threshold = tradeProb;
            if (rule.isMandatory && t.pnl > 0)  threshold = Math.min(0.97, tradeProb + 0.12);
            if (rule.isMandatory && t.pnl < -50) threshold = Math.max(0.18, tradeProb - 0.10);

            if (ruleRoll < threshold) {
                followed.push(rule.id);
                actualScore += _eff(rule);
            } else if (rule.isMandatory) {
                allMandatoryFollowed = false;
            }
        });

        var maxScore = scoredRules.reduce(function(sum, r) { return sum + _eff(r); }, 0);
        var pct = maxScore > 0 ? _round2(actualScore / maxScore * 100) : 0;

        t.strategyScore = {
            strategyId: strat.id,
            strategyName: strat.name,
            followedRules: followed,
            actualScore: actualScore,
            maxScore: maxScore,
            percentage: pct,
            grade: _grade(pct, allMandatoryFollowed),
            allMandatoryFollowed: allMandatoryFollowed
        };
    });
}

// ═══════════════════════════════════════════════════════════════════════
// REVIEW BUILDER — generates daily/weekly/monthly/yearly reviews
// ═══════════════════════════════════════════════════════════════════════

function _buildDemoReviews(trades) {
    var reviews = {};
    if (!trades.length) return reviews;

    var byDay = {};
    trades.forEach(function(t) {
        var d = (t.exitTime || t.entryTime || '').slice(0, 10);
        if (!d) return;
        if (!byDay[d]) byDay[d] = [];
        byDay[d].push(t);
    });

    var days = Object.keys(byDay).sort();
    var ts = Date.now();

    var DAILY_GOOD = [
        'Followed the morning prep and stuck to A-grade setups only.',
        'Discipline was strong today — waited for clear triggers before entering.',
        'Good sizing on the winners. Let the best trade run longer than usual.',
        'Read the tape well and avoided low-quality chop.',
        'Pre-market plan identified the right levels. Execution was clean.',
        'Stayed patient through the opening volatility and found good entries after.',
        'Best day of the week so far. Process is producing results.',
        'Focused on one or two high-conviction names instead of spreading thin.',
        'Honored the stop on the one loser and it stayed small.',
        'Caught the trend continuation early and managed it well.'
    ];
    var DAILY_BAD = [
        'Took a few trades without clear setups — discipline slipped after lunch.',
        'Revenge traded after the first loss. Added unnecessary damage.',
        'Oversized on a B-grade setup and paid for it.',
        'Got shaken out of a good position too early. Need to trust the levels more.',
        'Chased a move I missed and got punished. That is not my process.',
        'Held a loser too long hoping it would come back. It did not.',
        'Too many trades today. Quantity over quality.',
        'Afternoon was sloppy. Should have stopped after the morning session.',
        'Ignored my stop level and let a small loss turn into a bigger one.',
        'FOMO entry on a ticker I had no plan for.'
    ];
    var DAILY_LESSON = [
        'Quality over quantity. Fewer, better trades.',
        'The stop is the plan. Honor it every time.',
        'Do not trade the afternoon if the morning was already profitable.',
        'Wait for the retest. The first move is rarely the best entry.',
        'Size down after two consecutive losses.',
        'If I cannot explain the setup in one sentence, I should not take it.',
        'The best trades feel boring. That is the process working.',
        'Review the tape after close — patterns repeat.',
        'Prep is everything. The trade is won or lost before the open.',
        'Emotion check: if I feel anything strong, pause before entering.'
    ];

    var WEEKLY_SUMMARY = [
        'Discipline was the defining theme this week. When I followed the plan, results were good.',
        'The week started strong but discipline slipped toward Thursday and Friday.',
        'Consistency improved. Fewer impulsive entries this week compared to last.',
        'This was a grind week — small wins, small losses, nothing dramatic. Process held.',
        'Caught two strong trend days and let the winners run. Best week in a while.',
        'Overtraded on two of the five days. Those days dragged total performance.',
        'Week was mostly about damage control after Monday\'s blow-up.',
        'Steady week. No fireworks but no disasters. That is progress.',
        'Setup selection improved but exit timing still needs work.',
        'Big lesson this week: the afternoon is where I give back morning profits.'
    ];
    var WEEKLY_FOCUS = [
        { cont:'Following the pre-market checklist', stop:'Trading after 2 PM without a clear edge', start:'Journaling every trade within 30 minutes' },
        { cont:'Honoring stops on every trade', stop:'Revenge trading after losses', start:'Tracking emotional state before each entry' },
        { cont:'Focusing on A-grade setups', stop:'Oversizing on marginal setups', start:'Reviewing the week every Friday afternoon' },
        { cont:'Waiting for confirmation candles', stop:'Chasing extended moves', start:'Setting alerts instead of staring at screens' },
        { cont:'Taking partial profits at first target', stop:'Adding to losing positions', start:'Morning meditation before the open' },
        { cont:'Sticking to my top 5 tickers', stop:'Trading random tickers from Twitter', start:'End-of-day P&L screenshot for accountability' },
        { cont:'Reducing size after two consecutive losses', stop:'Trading during lunch hour', start:'Tracking my best/worst time windows weekly' },
    ];

    var MONTHLY_SUMMARY = [
        'The month had a clear narrative: early wins, mid-month regression into bad habits, and a recovery in the final week.',
        'Strongest month in a while. Discipline held for most of the 4 weeks and the equity curve shows it.',
        'A frustrating month. Gave back too much on blow-up days. The stops are the fix.',
        'Gradually improving. Win rate is ticking up and average losers are getting smaller. Process is working.',
        'Mixed month. Good weeks followed by bad ones. Consistency is the gap to close.',
        'Breakout setups carried the month. Reversals continue to underperform — worth dropping.',
    ];
    var MONTHLY_LESSON = [
        'The gap between disciplined days and tilt days is where the edge lives. Close that gap.',
        'Monthly results depend more on avoiding blow-ups than on finding home runs.',
        'Setup selection matters more than entry timing. Bad setups with perfect entries still lose.',
        'Risk management is not optional. Every dollar saved on a stop is a dollar earned.',
        'The two-trader split is real: disciplined trades make money, tilt trades lose it.',
        'Reviewing the month like this makes patterns visible that I miss day-to-day.',
    ];

    var YEARLY_2024 = 'First year of serious journaling. The data tells a clear story: when discipline holds, the account grows. When it breaks — usually through revenge trading and afternoon overtrading — the account gives back. The biggest lesson is that the system works when I follow it, and every deviation has a measurable cost. Going forward, the priority is reducing behavioral cost by implementing a hard daily stop.';
    var YEARLY_2025 = 'Year two showed real growth. Win rate improved from 55% to 58%, and more importantly, average loser size shrank by 20%. The process is working. Setup-wise, breakouts and VWAP reclaims are the clear edge. Reversals need tighter criteria or smaller size. The biggest change: I stopped trading after 2 PM on most days, and the equity curve reflects it.';

    // ── Daily reviews (~70% of trading days) ──
    days.forEach(function(day, idx) {
        if ((idx * 7 + 3) % 10 >= 7) return; // skip ~30%
        var dayTrades = byDay[day];
        var pnl = dayTrades.reduce(function(s, t) { return s + t.pnl; }, 0);
        var isGreen = pnl > 0;
        var good = DAILY_GOOD[idx % DAILY_GOOD.length];
        var bad  = DAILY_BAD[idx % DAILY_BAD.length];
        var lesson = DAILY_LESSON[idx % DAILY_LESSON.length];
        var content = isGreen
            ? '<p>' + good + '</p><p>' + lesson + '</p>'
            : '<p>' + bad + '</p><p>' + lesson + '</p>';

        reviews['daily|' + day] = {
            content: content,
            hiddenPatterns: [],
            status: 'complete',
            nextFocus: {
                cont: [{ text: isGreen ? 'Following the plan' : 'Honoring stops', done: isGreen }],
                stop: [{ text: isGreen ? 'Nothing specific today' : 'Impulsive entries', done: false }],
                start: [{ text: lesson.split('.')[0], done: false }]
            },
            widgets: null,
            createdAt: ts,
            updatedAt: ts,
            _isDemo: true
        };
    });

    // ── Weekly reviews (~85%) ──
    function _isoWeek(dateStr) {
        var d = new Date(dateStr + 'T12:00:00Z');
        var date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        var wn = Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
        var pad2 = function(n) { return n < 10 ? '0' + n : '' + n; };
        return date.getUTCFullYear() + '-W' + pad2(wn);
    }
    var weeksSeen = {};
    days.forEach(function(day) {
        var wk = _isoWeek(day);
        if (!weeksSeen[wk]) weeksSeen[wk] = [];
        weeksSeen[wk].push(day);
    });
    var weekKeys = Object.keys(weeksSeen).sort();
    weekKeys.forEach(function(wk, idx) {
        if ((idx * 3 + 1) % 20 >= 17) return; // skip ~15%
        var summary = WEEKLY_SUMMARY[idx % WEEKLY_SUMMARY.length];
        var focus = WEEKLY_FOCUS[idx % WEEKLY_FOCUS.length];
        reviews['weekly|' + wk] = {
            content: '<p>' + summary + '</p>',
            hiddenPatterns: [],
            status: 'complete',
            nextFocus: {
                cont: [{ text: focus.cont, done: idx < weekKeys.length - 1 }],
                stop: [{ text: focus.stop, done: false }],
                start: [{ text: focus.start, done: idx < weekKeys.length - 2 }]
            },
            widgets: null,
            createdAt: ts,
            updatedAt: ts,
            _isDemo: true
        };
    });

    // ── Monthly reviews (~90%) ──
    var monthsSeen = {};
    days.forEach(function(day) { var m = day.slice(0, 7); monthsSeen[m] = true; });
    var monthKeys = Object.keys(monthsSeen).sort();
    monthKeys.forEach(function(mk, idx) {
        if ((idx * 7) % 30 >= 27) return; // skip ~10%
        var summary = MONTHLY_SUMMARY[idx % MONTHLY_SUMMARY.length];
        var lesson = MONTHLY_LESSON[idx % MONTHLY_LESSON.length];
        reviews['monthly|' + mk] = {
            content: '<p>' + summary + '</p><p>' + lesson + '</p>',
            hiddenPatterns: [],
            status: 'complete',
            nextFocus: {
                cont: [{ text: 'Consistent position sizing', done: idx < monthKeys.length - 1 }],
                stop: [{ text: 'Afternoon overtrading', done: false }],
                start: [{ text: 'Monthly edge review', done: idx < monthKeys.length - 2 }]
            },
            widgets: null,
            createdAt: ts,
            updatedAt: ts,
            _isDemo: true
        };
    });

    // ── Yearly reviews ──
    reviews['yearly|2024'] = {
        content: '<p>' + YEARLY_2024 + '</p>',
        hiddenPatterns: [], status: 'complete',
        nextFocus: {
            cont: [{ text: 'Following the daily trading plan', done: true }],
            stop: [{ text: 'Revenge trading after losses', done: false }],
            start: [{ text: 'Hard daily stop-loss rule', done: true }]
        },
        widgets: null, createdAt: ts, updatedAt: ts, _isDemo: true
    };
    reviews['yearly|2025'] = {
        content: '<p>' + YEARLY_2025 + '</p>',
        hiddenPatterns: [], status: 'complete',
        nextFocus: {
            cont: [{ text: 'Core edge development', done: false }],
            stop: [{ text: 'Inconsistent sizing', done: false }],
            start: [{ text: 'Annual performance review', done: false }]
        },
        widgets: null, createdAt: ts, updatedAt: ts, _isDemo: true
    };

    return reviews;
}
