// ═══════════════════════════════════════════════════════════════════════════
// REVIEWS PAGE MODULE — Daily · Weekly · Monthly · Yearly
// Depends on globals from Denarii.js: journalData, saveToIndexedDB
// ═══════════════════════════════════════════════════════════════════════════
(function () {
    'use strict';

    // ── Module state ──────────────────────────────────────────────────────────
    var _st = {
        daily:   { periodKey: '' },
        weekly:  { periodKey: '' },
        monthly: { periodKey: '' },
        yearly:  { periodKey: '' }
    };
    var _saveTimer = null;
    var _savedRange = null; // selection saved before color picker opens

    // Snapshot layout/edit state (per review type)
    var _rvSnap = {
        daily:   { editMode: false, layout: null, drag: { srcId: null } },
        weekly:  { editMode: false, layout: null, drag: { srcId: null } },
        monthly: { editMode: false, layout: null, drag: { srcId: null } },
        yearly:  { editMode: false, layout: null, drag: { srcId: null } }
    };

    // ── Widget catalog ────────────────────────────────────────────────────────
    var WC = {
        'kpi-strip':     { name: 'KPI Strip',          types: ['daily','weekly','monthly','yearly'], render: wKpi },
        'pnl-bars':      { name: 'P&L by Day',         types: ['weekly','monthly'],                 render: wPnlBars },
        'strategy-snap': { name: 'Strategy Snapshot',  types: ['daily','weekly','monthly','yearly'], render: wStrategySnap },
        'equity-curve':  { name: 'Equity Curve',       types: ['monthly','yearly'],                 render: wEquityCurve },
        'monthly-trend': { name: 'Monthly P&L Trend',  types: ['yearly'],                           render: wMonthlyTrend },
        'win-loss':      { name: 'Win / Loss Split',   types: ['daily','weekly','monthly','yearly'], render: wWinLoss },
        'trade-list':    { name: 'Recent Trades',      types: ['daily','weekly'],                   render: wTradeList }
    };

    var DEFAULT_WIDGETS = {
        daily:   ['kpi-strip', 'strategy-snap'],
        weekly:  ['kpi-strip', 'pnl-bars', 'strategy-snap'],
        monthly: ['kpi-strip', 'equity-curve', 'strategy-snap'],
        yearly:  ['kpi-strip', 'monthly-trend', 'equity-curve']
    };

    // ── Prompt templates ──────────────────────────────────────────────────────
    var PROMPTS = {
        daily:   ['What was my biggest lesson today?','What went well?','What hurt my performance?','What is my plan for tomorrow?'],
        weekly:  ['What patterns repeated this week?','What was my best and worst behavior?','What will I focus on next week?'],
        monthly: ['How strong is my edge this month?','What behavior needs the most improvement?','What habits am I building or breaking?'],
        yearly:  ['How have I grown as a trader this year?','What was my most important lesson?','What is my long-term identity as a trader?','What are my 3 goals for next year?']
    };

    // ── Pattern definitions per type ──────────────────────────────────────────
    var PATTERN_LABELS = {
        daily:   ['Most Costly Mistake','Strongest Setup','Best Time Window','Discipline Check'],
        weekly:  ['Best Strategy','Worst Strategy','Strongest Day','Weakest Day'],
        monthly: ['Best Strategy','Worst Strategy','Most Improved Behavior','Biggest Risk'],
        yearly:  ['Most Recurring Mistake','Strongest Edge','Long-Term Pattern','Biggest Growth']
    };

    // ── Default Next-Focus items per type ─────────────────────────────────────
    var DEFAULT_FOCUS = {
        daily:   { cont: ['Follow entry rules'], stop: ['Revenge trading'], start: ['Review watchlist before open'] },
        weekly:  { cont: ['Best strategy execution'], stop: ['Overtrading on slow days'], start: ['Weekly pre-market prep'] },
        monthly: { cont: ['Winning strategy focus'], stop: ['Low-conviction trades'], start: ['Monthly goal tracking'] },
        yearly:  { cont: ['Core edge development'], stop: ['Inconsistent sizing'], start: ['Annual performance review'] }
    };

    // ── Date helpers ──────────────────────────────────────────────────────────
    function todayISO() {
        var d = new Date();
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function isoWeekNum(d) {
        var date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    }

    function weekKey(d) {
        var w = isoWeekNum(d);
        var thu = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        thu.setUTCDate(thu.getUTCDate() + 4 - (thu.getUTCDay() || 7));
        return thu.getUTCFullYear() + '-W' + pad(w);
    }

    // Weeks run Sun–Sat (local), matching the Weekly Planner: each is stored
    // under the ISO key of its Monday, so the week containing a day is the ISO
    // week of the day after it. Keys are unchanged; only the range they cover.
    function sunWeekKey(d) {
        return weekKey(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1));
    }

    function defaultKey(type) {
        var now = new Date();
        if (type === 'daily')   return todayISO();
        if (type === 'weekly')  return sunWeekKey(now);
        if (type === 'monthly') return now.getFullYear() + '-' + pad(now.getMonth() + 1);
        if (type === 'yearly')  return String(now.getFullYear());
        return '';
    }

    function periodRange(type, key) {
        if (type === 'daily') {
            var d = new Date(key + 'T00:00:00');
            return [d, d];
        }
        if (type === 'weekly') {
            var parts = key.split('-W');
            var yr = parseInt(parts[0]), wk = parseInt(parts[1]);
            var jan4 = new Date(yr, 0, 4);
            var dow = (jan4.getDay() + 6) % 7;
            var mon = new Date(jan4);
            mon.setDate(jan4.getDate() - dow + (wk - 1) * 7);
            var sun = new Date(mon); sun.setDate(mon.getDate() - 1);
            var sat = new Date(mon); sat.setDate(mon.getDate() + 5);
            return [sun, sat];
        }
        if (type === 'monthly') {
            var p = key.split('-');
            return [new Date(+p[0], +p[1]-1, 1), new Date(+p[0], +p[1], 0)];
        }
        if (type === 'yearly') {
            var yr2 = parseInt(key);
            return [new Date(yr2, 0, 1), new Date(yr2, 11, 31)];
        }
        return [new Date(), new Date()];
    }

    function periodLabel(type, key) {
        if (type === 'daily') {
            return new Date(key + 'T00:00:00').toLocaleDateString('en-US',
                { weekday:'long', year:'numeric', month:'long', day:'numeric' });
        }
        if (type === 'weekly') {
            var r = periodRange('weekly', key);
            var p = key.split('-W');
            return 'Week ' + parseInt(p[1]) + ' · ' +
                r[0].toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ' – ' +
                r[1].toLocaleDateString('en-US',{month:'short',day:'numeric'}) + ', ' + p[0];
        }
        if (type === 'monthly') {
            var p2 = key.split('-');
            return new Date(+p2[0], +p2[1]-1, 1)
                .toLocaleDateString('en-US', { year:'numeric', month:'long' });
        }
        return key; // yearly
    }

    // Convert internal key to native input value
    function keyToInputVal(type, key) {
        if (type === 'daily')   return key;          // YYYY-MM-DD
        if (type === 'weekly')  return key;          // YYYY-WNN (browser <input type="week"> format)
        if (type === 'monthly') return key;          // YYYY-MM
        if (type === 'yearly')  return key;          // YYYY
        return key;
    }

    function stepKey(type, key, dir) {
        if (type === 'daily') {
            var d = new Date(key + 'T00:00:00');
            d.setDate(d.getDate() + dir);
            return d.getFullYear() + '-' + pad(d.getMonth()+1) + '-' + pad(d.getDate());
        }
        if (type === 'weekly') {
            var p = key.split('-W');
            var jan4 = new Date(parseInt(p[0]), 0, 4);
            var dow = (jan4.getDay() + 6) % 7;
            var mon = new Date(jan4);
            mon.setDate(jan4.getDate() - dow + (parseInt(p[1]) - 1 + dir) * 7);
            return weekKey(mon);
        }
        if (type === 'monthly') {
            var p2 = key.split('-');
            var yr = parseInt(p2[0]), mo = parseInt(p2[1]) + dir;
            if (mo < 1) { yr--; mo = 12; }
            if (mo > 12) { yr++; mo = 1; }
            return yr + '-' + pad(mo);
        }
        return String(parseInt(key) + dir); // yearly
    }

    // ── Trade filtering ───────────────────────────────────────────────────────
    function tradesFor(type, key) {
        var jd = journalData;
        if (!jd) return [];
        var tradesSource = (Array.isArray(jd.trades) && jd.trades.length ? jd.trades : null) ||
                           (Array.isArray(jd.allTrades) && jd.allTrades.length ? jd.allTrades : null) ||
                           [];
        var r = periodRange(type, key);
        var s = new Date(r[0].getFullYear(), r[0].getMonth(), r[0].getDate());
        var e = new Date(r[1].getFullYear(), r[1].getMonth(), r[1].getDate(), 23, 59, 59);
        return tradesSource.filter(function(t) {
            var tradeDate = t.exitTime || t.entryTime || t.exit_time || t.entry_time || t.created || t.date || t.timestamp;
            if (!tradeDate) return false;
            var ds;
            if (typeof tradeDate === 'number' ||
                (typeof tradeDate === 'string' && /^\d{10,13}$/.test(tradeDate))) {
                var localDate = new Date(Number(tradeDate));
                ds = localDate.getFullYear() + '-' + pad(localDate.getMonth() + 1) + '-' + pad(localDate.getDate());
            } else {
                ds = tradeDate.slice(0, 10);
            }
            var d = new Date(ds + 'T00:00:00');
            return d >= s && d <= e;
        });
    }

    // ── Metrics ───────────────────────────────────────────────────────────────
    function calcMetrics(trades) {
        var closed = trades.filter(function(t) {
            var pnl = t.pnl != null ? t.pnl : (t.net_pnl != null ? t.net_pnl : t.realized_pnl);
            return pnl != null && pnl !== '' && !isNaN(parseFloat(pnl));
        });
        var pnls   = closed.map(function(t) {
            var pnl = t.pnl != null ? t.pnl : (t.net_pnl != null ? t.net_pnl : t.realized_pnl);
            return parseFloat(pnl);
        });
        var wins   = pnls.filter(function(p) { return p > 0; });
        var losses = pnls.filter(function(p) { return p < 0; });
        var gW = wins.reduce(function(a,b){ return a+b; }, 0);
        var gL = Math.abs(losses.reduce(function(a,b){ return a+b; }, 0));
        var expectancy = closed.length
            ? (wins.length/closed.length)*(gW/(wins.length||1)) - (losses.length/closed.length)*(gL/(losses.length||1))
            : 0;
        return {
            count:        closed.length,
            totalPnl:     pnls.reduce(function(a,b){ return a+b; }, 0),
            winRate:      closed.length ? wins.length/closed.length : 0,
            winCount:     wins.length,
            lossCount:    losses.length,
            avgWin:       wins.length   ? gW/wins.length   : 0,
            avgLoss:      losses.length ? gL/losses.length : 0,
            profitFactor: gL > 0 ? gW/gL : (gW > 0 ? Infinity : 0),
            largestWin:   wins.length   ? Math.max.apply(null, wins)   : 0,
            largestLoss:  losses.length ? Math.max.apply(null, losses.map(Math.abs)) : 0,
            grossWin: gW, grossLoss: gL,
            expectancy: expectancy,
            trades: closed
        };
    }

    // ── Pattern engine ────────────────────────────────────────────────────────
    function computePatterns(trades, type) {
        if (!trades.length) return [];
        var m = calcMetrics(trades);
        var patterns = [];

        // P&L result
        if (m.count > 0) {
            var pos = m.totalPnl >= 0;
            patterns.push({
                id:'pnl', type: pos?'positive':'negative',
                icon: pos?'↑':'↓',
                title: pos?'Profitable Period':'Net Loss Period',
                detail: 'Net P&L ' + fmtD(m.totalPnl) + ' across ' + m.count + ' trade' + (m.count!==1?'s':''),
                tooltip: 'Total realized P&L for all closed trades in this period.',
                rank: 90
            });
        }

        // Win rate (min 3 trades)
        if (m.count >= 3) {
            var wrPct = Math.round(m.winRate*100);
            var wrGood = m.winRate >= 0.5;
            patterns.push({
                id:'winrate', type: wrGood?'positive':'neutral',
                icon: wrGood?'✓':'△',
                title: wrPct + '% Win Rate',
                detail: m.winCount + 'W / ' + m.lossCount + 'L — ' + (wrGood?'edge showing':'review entries'),
                tooltip: 'Percentage of trades that closed with positive P&L.',
                rank: 75
            });
        }

        // Best / worst setup
        var sm = {};
        trades.forEach(function(t) {
            var s = t.setupType || t.strategy || t.setup || 'No Strategy';
            if (!sm[s]) sm[s] = { pnl:0, count:0 };
            sm[s].pnl += parseFloat(t.pnl || 0);
            sm[s].count++;
        });
        var setups = Object.keys(sm).map(function(k) { return { name:k, pnl:sm[k].pnl, count:sm[k].count }; });
        setups.sort(function(a,b) { return b.pnl - a.pnl; });
        if (setups.length && setups[0].pnl > 0) {
            patterns.push({
                id:'best-setup', type:'positive', icon:'★',
                title: 'Best Strategy: ' + setups[0].name,
                detail: fmtD(setups[0].pnl) + ' · ' + setups[0].count + ' trade' + (setups[0].count!==1?'s':''),
                tooltip: 'Strategy with highest net P&L this period.',
                rank: 80
            });
        }
        if (setups.length > 1 && setups[setups.length-1].pnl < 0) {
            var w = setups[setups.length-1];
            patterns.push({
                id:'worst-setup', type:'negative', icon:'⚠',
                title: 'Worst Strategy: ' + w.name,
                detail: fmtD(w.pnl) + ' · ' + w.count + ' trade' + (w.count!==1?'s':''),
                tooltip: 'Strategy with largest negative P&L this period.',
                rank: 60
            });
        }

        // Largest win / loss
        if (m.largestWin > 0) {
            patterns.push({
                id:'big-win', type:'positive', icon:'↑',
                title: 'Best Trade: +' + fmt$(m.largestWin),
                detail: 'Single largest winning trade of the period.',
                tooltip: 'The highest single-trade P&L this period.',
                rank: 52
            });
        }
        if (m.largestLoss > 0) {
            patterns.push({
                id:'big-loss', type:'negative', icon:'↓',
                title: 'Worst Trade: -' + fmt$(m.largestLoss),
                detail: 'Review entry, stop placement, and position sizing.',
                tooltip: 'The largest single-trade loss this period.',
                rank: 56
            });
        }

        // Profit factor (min 5 trades)
        if (m.count >= 5) {
            var pf = m.profitFactor;
            if (pf > 2) {
                patterns.push({
                    id:'pf-good', type:'positive', icon:'⚡',
                    title: 'Profit Factor ' + (isFinite(pf)?pf.toFixed(2):'∞'),
                    detail: 'Winners significantly outpace losers.',
                    tooltip: 'Gross wins ÷ gross losses. Above 2 is strong.',
                    rank: 72
                });
            } else if (pf < 1 && isFinite(pf)) {
                patterns.push({
                    id:'pf-low', type:'warning', icon:'⚠',
                    title: 'Low Profit Factor ' + pf.toFixed(2),
                    detail: 'Tighten stops or cut position size.',
                    tooltip: 'Gross wins ÷ gross losses. Below 1 means net loss.',
                    rank: 70
                });
            }
        }

        // Win streak
        var sortedT = trades.slice().sort(function(a,b) {
            return (a.exitDate||a.entryDate||'').localeCompare(b.exitDate||b.entryDate||'');
        });
        var best=0, cur=0, losStr=0, maxLos=0;
        sortedT.forEach(function(t) {
            if (parseFloat(t.pnl||0) > 0) { cur++; if(cur>best) best=cur; losStr=0; }
            else { losStr++; if(losStr>maxLos) maxLos=losStr; cur=0; }
        });
        if (best >= 3) patterns.push({
            id:'streak', type:'positive', icon:'🔥',
            title: best + '-Trade Win Streak',
            detail: 'Longest consecutive winning run.',
            tooltip: 'Max consecutive winning trades this period.',
            rank: 65
        });
        if (maxLos >= 4) patterns.push({
            id:'loss-streak', type:'negative', icon:'❌',
            title: maxLos + '-Trade Loss Streak',
            detail: 'Review entries, size, and emotional state.',
            tooltip: 'Consecutive losses may indicate a process issue.',
            rank: 68
        });

        // Overtrading (weekly+)
        if (type !== 'daily') {
            var dc = {};
            trades.forEach(function(t) {
                var d = (t.exitDate||t.entryDate||'').slice(0,10);
                if (d) dc[d] = (dc[d]||0)+1;
            });
            var hot = Object.keys(dc).filter(function(d){ return dc[d]>=8; });
            if (hot.length) patterns.push({
                id:'overtrade', type:'warning', icon:'!',
                title: 'Overtrading: ' + hot.length + ' day' + (hot.length>1?'s':''),
                detail: hot.length + ' session' + (hot.length>1?'s':' ') + 'with 8+ trades.',
                tooltip: 'High trade frequency on single days can signal revenge trading.',
                rank: 73
            });
        }

        // Expectancy (min 10 trades)
        if (m.count >= 10) {
            var exp = m.expectancy;
            if (exp > 0) patterns.push({
                id:'exp-good', type:'positive', icon:'E',
                title: 'Positive Expectancy: ' + fmtD(exp),
                detail: 'Average expected gain per trade.',
                tooltip: 'Expectancy = (Win% × Avg Win) - (Loss% × Avg Loss).',
                rank: 63
            });
        }

        patterns.sort(function(a,b){ return b.rank - a.rank; });
        return patterns.slice(0, 6);
    }

    // ── Formatters ────────────────────────────────────────────────────────────
    function fmt$(n) {
        if (n==null || isNaN(n)) return '—';
        var a = Math.abs(n);
        return a>=1000 ? '$'+Math.round(a).toLocaleString() : '$'+a.toFixed(2);
    }
    function fmtD(n) {
        if (n==null || isNaN(n)) return '—';
        return (n>=0?'+':'-') + fmt$(Math.abs(n));
    }
    function fmtPct(n) { return n==null||isNaN(n) ? '—' : Math.round(n*100)+'%'; }
    function fmtPF(n)  { return !isFinite(n) ? (n>0?'∞':'—') : n===0 ? '—' : n.toFixed(2); }
    function escH(s) {
        if (!s) return '';
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;').replace(/'/g,'&#39;');
    }

    // ── Storage ───────────────────────────────────────────────────────────────
    function skey(type, key) { return type+'|'+key; }

    function getRev(type, key) {
        var jd = journalData;
        if (!jd) return null;
        if (!jd.reviews) jd.reviews = {};
        return jd.reviews[skey(type, key)] || null;
    }

    function saveRev(type, key, data) {
        var jd = journalData;
        if (!jd) return;
        if (!jd.reviews) jd.reviews = {};
        jd.reviews[skey(type, key)] = data;
        if (typeof saveToIndexedDB==='function') saveToIndexedDB();
    }

    function blankRev(type) {
        var df = DEFAULT_FOCUS[type];
        return {
            content:        '',
            hiddenPatterns: [],
            status:         'draft', // 'draft' | 'complete'
            nextFocus: {
                cont:  (df.cont||[]).map(function(t){ return {text:t,done:false}; }),
                stop:  (df.stop||[]).map(function(t){ return {text:t,done:false}; }),
                start: (df.start||[]).map(function(t){ return {text:t,done:false}; })
            },
            widgets:    null, // null = use defaults
            createdAt:  Date.now(),
            updatedAt:  Date.now()
        };
    }

    function curRev(type, key) { return getRev(type, key) || blankRev(type); }

    function getWidgets(type, key) {
        var r = getRev(type, key);
        return (r && r.widgets) ? r.widgets : DEFAULT_WIDGETS[type].slice();
    }

    // ── Snapshot of editor & next-focus before save ───────────────────────────
    function captureState(type) {
        var ed = document.getElementById('rv-editor-' + type);
        var content = ed ? ed.innerHTML : null;
        var nf = { cont:[], stop:[], start:[] };
        ['cont','stop','start'].forEach(function(cat) {
            document.querySelectorAll('.rv-nf-item[data-cat="'+cat+'"][data-type="'+type+'"]').forEach(function(el, i) {
                var cb = el.querySelector('input[type="checkbox"]');
                var lbl = el.querySelector('.rv-nf-label');
                nf[cat].push({ text: lbl ? lbl.textContent : '', done: cb ? cb.checked : false });
            });
        });
        return { content: content, nextFocus: nf };
    }

    // ── Batch 2: re-sync guard ────────────────────────────────────────────────
    // The open reflection registers its record with auth.js. A re-sync that
    // replaces it reloads a clean editor; a save while it is stale keeps this
    // version as a conflict copy and loads the newer one instead of writing.
    function _rvGuardId(type) { return 'review:' + type; }

    function _rvNfPlain(nf) {
        var out = {};
        ['cont','stop','start'].forEach(function(cat) {
            out[cat] = ((nf && nf[cat]) || []).map(function(t) { return { text: t.text, done: !!t.done }; });
        });
        return out;
    }

    function _rvFormRecord(type, key) {
        var r = JSON.parse(JSON.stringify(curRev(type, key)));
        var s = captureState(type);
        if (s.content !== null) r.content = s.content;
        r.nextFocus = s.nextFocus;
        return r;
    }

    function _rvReload(type, key) {
        _rvClearDraft(type, key);
        if (_st[type].periodKey === key) renderReviewPage(type);
    }

    // True when the save was stale and became a conflict copy + reload.
    function _rvStaleSave(type, key) {
        if (typeof _editorGuardStale !== 'function' || _editorGuardStale(_rvGuardId(type), skey(type, key)) !== true) return false;
        clearTimeout(_saveTimer);
        _editorGuardConflict(_rvGuardId(type), _rvFormRecord(type, key));
        _rvReload(type, key);
        return true;
    }

    function _rvGuardOpen(type, key) {
        if (typeof _editorGuardOpen !== 'function') return;
        _editorGuardOpen(_rvGuardId(type), 'reviews', skey(type, key), {
            isDirty: function() {
                var r = curRev(type, key), s = captureState(type);
                if (s.content !== null && s.content !== (r.content || '')) return true;
                return JSON.stringify(_rvNfPlain(s.nextFocus)) !== JSON.stringify(_rvNfPlain(r.nextFocus || blankRev(type).nextFocus));
            },
            reload:  function() { _rvReload(type, key); },
            resolve: function() { _rvStaleSave(type, key); }
        });
    }

    // ── Save ──────────────────────────────────────────────────────────────────
    // False when the save was stale (kept as a conflict copy) or failed.
    function doSave(type, key, opts) {
        if (_rvStaleSave(type, key)) return false;
        var r = curRev(type, key);
        var state = captureState(type);
        if (state.content !== null) r.content = state.content;
        r.nextFocus = state.nextFocus;
        if (opts && opts.status) {
            r.status = opts.status;
            // A completed save or a reopen both end the current journaling session.
            // Clear the session date header so the next session starts fresh.
            r.sessionHeaderDate = '';
        }
        r.updatedAt = Date.now();
        if (!r.createdAt) r.createdAt = Date.now();
        showStatus(type, 'Saving\u2026', 'saving');
        try {
            saveRev(type, key, r);
        } catch (e) {
            showStatus(type, 'Save failed', 'failed');
            return false;
        }
        // Keep draft alive after background autosave so a page reload can
        // restore the editor. Only clear on explicit review-ending actions
        // (Mark Complete / Reopen) which re-render the page.
        if (opts && opts.status) _rvClearDraft(type, key);
        showStatus(type, opts && opts.status === 'complete' ? 'Marked Complete' : 'Saved');
        if (opts && opts.status) renderReviewPage(type); // re-render to update header badge
        return true;
    }

    // ── Draft protection (localStorage backup) ────────────────────────────────
    // doSave persists to the local database but is debounced 1400ms after typing. If the
    // tab is closed/reloaded before the timer fires, work is lost. A synchronous
    // localStorage write on every keystroke guarantees recovery of in-progress
    // reflection content scoped to this specific review (type + periodKey).
    function _rvDraftKey(type, key) { return 'rv-draft-' + skey(type, key); }
    function _rvSaveDraft(type, key, html) {
        Autosave.save(_rvDraftKey(type, key), { content: html });
    }
    function _rvLoadDraft(type, key) {
        return Autosave.load(_rvDraftKey(type, key));
    }
    function _rvClearDraft(type, key) {
        Autosave.clear(_rvDraftKey(type, key));
    }

    // ── Session-aware date header ─────────────────────────────────────────────
    // Returns date formatted as "April 5, 2026" (no ordinal, no brackets).
    function _rvFormatSessionDate(d) {
        var months = ['January','February','March','April','May','June',
                      'July','August','September','October','November','December'];
        return months[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear();
    }

    function showStatus(type, msg, state) {
        var el = document.getElementById('rv-status-' + type);
        if (!el) return;
        state = state || 'saved';
        el.textContent = msg;
        el.className = 'rv-save-status rv-' + state;
        clearTimeout(el._t);
        el._t = null;
        // Auto-fade only for transient states (saved, informational)
        if (state === 'saved') {
            el._t = setTimeout(function() {
                el.textContent = '';
                el.className = 'rv-save-status';
            }, 2200);
        }
    }

    // ── Rich text toolbar builder ─────────────────────────────────────────────
    function buildToolbar(type) {
        var editorId = 'rv-editor-' + type;
        return EditorToolbar.build(editorId, { templates: true, templateType: type });
    }

    // ── Widget renderers ──────────────────────────────────────────────────────
    function wKpi(trades, type) {
        var m = calcMetrics(trades);
        if (!m.count) return '<div class="rv-w-empty">No data</div>';
        return '<div class="rv-w-kpi">' +
            _mc('Net P&L',       fmtD(m.totalPnl),       m.totalPnl>=0?'pos':'neg') +
            _mc('Win Rate',      fmtPct(m.winRate),       m.winRate>=0.5?'pos':'neu') +
            _mc('Trades',        m.count,                 'neu') +
            _mc('Profit Factor', fmtPF(m.profitFactor),  m.profitFactor>=1?'pos':'neg') +
            _mc('Expectancy',    fmtD(m.expectancy),      m.expectancy>=0?'pos':'neg') +
        '</div>';
    }

    function wPnlBars(trades) {
        if (!trades.length) return '<div class="rv-w-empty">No data</div>';
        // Group by day
        var days = {};
        trades.forEach(function(t) {
            var d = (t.exitTime||t.entryTime||t.exitDate||t.entryDate||'').slice(0,10);
            if (!d) return;
            var p = t.pnl != null ? t.pnl : (t.net_pnl != null ? t.net_pnl : (t.realized_pnl != null ? t.realized_pnl : 0));
            days[d] = (days[d]||0) + parseFloat(p);
        });
        var entries = Object.keys(days).sort().map(function(d) { return { d:d, pnl:days[d] }; });
        if (!entries.length) return '<div class="rv-w-empty">No data</div>';
        var max = Math.max.apply(null, entries.map(function(e){ return Math.abs(e.pnl); })) || 1;
        var bars = entries.map(function(e) {
            var pct = Math.round(Math.abs(e.pnl)/max*80);
            var pos = e.pnl >= 0;
            var label = e.d.slice(5); // MM-DD
            return '<div class="rv-bar-col">' +
                '<div class="rv-bar-wrap">' +
                    '<div class="rv-bar rv-bar-'+(pos?'pos':'neg')+'" style="height:'+pct+'px" title="'+label+': '+fmtD(e.pnl)+'"></div>' +
                '</div>' +
                '<div class="rv-bar-lbl">'+label+'</div>' +
            '</div>';
        }).join('');
        return '<div class="rv-w-bars">'+bars+'</div>';
    }

    function wStrategySnap(trades) {
        if (!trades.length) return '<div class="rv-w-empty">No data</div>';
        var sm = {};
        trades.forEach(function(t) {
            var s = t.setupType||t.strategy||t.setup||'No Strategy';
            if (!sm[s]) sm[s] = { pnl:0, wins:0, count:0 };
            var rawPnl = t.pnl != null ? t.pnl : (t.net_pnl != null ? t.net_pnl : (t.realized_pnl != null ? t.realized_pnl : 0));
            var p = parseFloat(rawPnl);
            sm[s].pnl += p;
            sm[s].count++;
            if (p > 0) sm[s].wins++;
        });
        var rows = Object.keys(sm).map(function(k) {
            return { name:k, pnl:sm[k].pnl, wr:sm[k].wins/(sm[k].count||1), count:sm[k].count };
        }).sort(function(a,b){ return b.pnl-a.pnl; });
        return '<table class="rv-w-table"><thead><tr>' +
            '<th>Strategy</th><th>Trades</th><th>Win%</th><th>Net P&L</th>' +
            '</tr></thead><tbody>' +
            rows.map(function(r) {
                return '<tr>' +
                    '<td>'+escH(r.name)+'</td>' +
                    '<td>'+r.count+'</td>' +
                    '<td>'+fmtPct(r.wr)+'</td>' +
                    '<td class="'+(r.pnl>=0?'rv-pos':'rv-neg')+'">'+fmtD(r.pnl)+'</td>' +
                '</tr>';
            }).join('') +
            '</tbody></table>';
    }

    function wEquityCurve(trades) {
        if (!trades.length) return '<div class="rv-w-empty">No data</div>';
        var sorted = trades.slice().sort(function(a,b) {
            return (a.exitTime||a.entryTime||a.exitDate||a.entryDate||'').localeCompare(b.exitTime||b.entryTime||b.exitDate||b.entryDate||'');
        });
        var cum = 0, pts = [0];
        sorted.forEach(function(t) {
            var p = t.pnl != null ? t.pnl : (t.net_pnl != null ? t.net_pnl : (t.realized_pnl != null ? t.realized_pnl : 0));
            cum += parseFloat(p);
            pts.push(cum);
        });
        var mn = Math.min.apply(null, pts), mx = Math.max.apply(null, pts);
        var range = mx - mn || 1;
        var W = 280, H = 80, pad2 = 4;
        var points = pts.map(function(v, i) {
            var x = pad2 + (i/(pts.length-1||1)) * (W - pad2*2);
            var y = H - pad2 - ((v - mn)/range) * (H - pad2*2);
            return x.toFixed(1)+','+y.toFixed(1);
        }).join(' ');
        var zeroY = H - pad2 - ((0 - mn)/range) * (H - pad2*2);
        var color = cum >= 0 ? 'var(--success)' : 'var(--danger)';
        return '<svg class="rv-w-svg" viewBox="0 0 '+W+' '+H+'" preserveAspectRatio="none">' +
            '<line x1="'+pad2+'" y1="'+zeroY.toFixed(1)+'" x2="'+(W-pad2)+'" y2="'+zeroY.toFixed(1)+'" ' +
                'stroke="var(--border)" stroke-width="1" stroke-dasharray="3,3"/>' +
            '<polyline points="'+points+'" fill="none" stroke="'+color+'" stroke-width="1.8" stroke-linejoin="round"/>' +
        '</svg>' +
        '<div class="rv-w-equity-footer">Final: <span class="'+(cum>=0?'rv-pos':'rv-neg')+'">'+fmtD(cum)+'</span></div>';
    }

    function wMonthlyTrend(trades) {
        // Group by month
        var mo = {};
        trades.forEach(function(t) {
            var k = (t.exitTime||t.entryTime||t.exitDate||t.entryDate||'').slice(0,7);
            if (!k) return;
            var p = t.pnl != null ? t.pnl : (t.net_pnl != null ? t.net_pnl : (t.realized_pnl != null ? t.realized_pnl : 0));
            mo[k] = (mo[k]||0) + parseFloat(p);
        });
        var keys = Object.keys(mo).sort();
        if (!keys.length) return '<div class="rv-w-empty">No data</div>';
        var max = Math.max.apply(null, keys.map(function(k){ return Math.abs(mo[k]); })) || 1;
        var bars = keys.map(function(k) {
            var pct = Math.round(Math.abs(mo[k])/max*80);
            var pos = mo[k]>=0;
            return '<div class="rv-bar-col">' +
                '<div class="rv-bar-wrap"><div class="rv-bar rv-bar-'+(pos?'pos':'neg')+'" style="height:'+pct+'px" title="'+k+': '+fmtD(mo[k])+'"></div></div>' +
                '<div class="rv-bar-lbl">'+(k.slice(5))+'</div>' +
            '</div>';
        }).join('');
        return '<div class="rv-w-bars">'+bars+'</div>';
    }

    function wWinLoss(trades) {
        var m = calcMetrics(trades);
        if (!m.count) return '<div class="rv-w-empty">No data</div>';
        var wPct = m.count ? Math.round(m.winCount/m.count*100) : 0;
        return '<div class="rv-w-winloss">' +
            '<div class="rv-wl-bar">' +
                '<div class="rv-wl-win" style="width:'+wPct+'%"></div>' +
                '<div class="rv-wl-loss" style="width:'+(100-wPct)+'%"></div>' +
            '</div>' +
            '<div class="rv-wl-labels">' +
                '<span class="rv-pos">'+m.winCount+' Win' + (m.winCount!==1?'s':'') + ' (+'+fmt$(m.grossWin)+')</span>' +
                '<span class="rv-neg">'+m.lossCount+' Loss'+(m.lossCount!==1?'es':'') + ' (-'+fmt$(m.grossLoss)+')</span>' +
            '</div>' +
        '</div>';
    }

    function wTradeList(trades) {
        if (!trades.length) return '<div class="rv-w-empty">No trades</div>';
        var recent = trades.slice().sort(function(a,b) {
            return (b.exitTime||b.entryTime||b.exitDate||b.entryDate||'').localeCompare(a.exitTime||a.entryTime||a.exitDate||a.entryDate||'');
        }).slice(0, 8);
        return '<table class="rv-w-table"><thead><tr>' +
            '<th>Symbol</th><th>Strategy</th><th>P&L</th>' +
            '</tr></thead><tbody>' +
            recent.map(function(t) {
                var rawPnl = t.pnl != null ? t.pnl : (t.net_pnl != null ? t.net_pnl : (t.realized_pnl != null ? t.realized_pnl : 0));
                var pnl = parseFloat(rawPnl);
                return '<tr>' +
                    '<td>'+escH(t.symbol||'—')+'</td>' +
                    '<td>'+escH(t.setupType||t.strategy||t.setup||'—')+'</td>' +
                    '<td class="'+(pnl>=0?'rv-pos':'rv-neg')+'">'+fmtD(pnl)+'</td>' +
                '</tr>';
            }).join('') +
            '</tbody></table>';
    }

    // ── Helper: metric card ───────────────────────────────────────────────────
    function _mc(label, val, sentiment) {
        return '<div class="rv-metric rv-metric-'+sentiment+'">'+
            '<div class="rv-metric-val">'+val+'</div>'+
            '<div class="rv-metric-lbl">'+label+'</div>'+
        '</div>';
    }

    // ── Snapshot helpers ──────────────────────────────────────────────────────
    function _tradePnl(t) {
        var p = t.pnl != null ? t.pnl : (t.net_pnl != null ? t.net_pnl : (t.realized_pnl != null ? t.realized_pnl : 0));
        return parseFloat(p) || 0;
    }

    function _tradeDay(t) {
        var d = t.exitTime || t.entryTime || t.exit_time || t.entry_time || t.exitDate || t.entryDate || t.created || t.date || '';
        if (!d) return '';
        if (typeof d === 'number' || (typeof d === 'string' && /^\d{10,13}$/.test(d))) {
            var ld = new Date(Number(d));
            return ld.getFullYear() + '-' + pad(ld.getMonth() + 1) + '-' + pad(ld.getDate());
        }
        return String(d).slice(0, 10);
    }

    // ── Snapshot card library ─────────────────────────────────────────────────
    var RV_SNAP_LIB = {
        daily: [
            { id:'net-pnl',      label:'Net P&L',               render: function(x) { return _mc('Net P&L',            fmtD(x.m.totalPnl),       x.m.totalPnl>=0?'pos':'neg'); } },
            { id:'win-rate',     label:'Win Rate',               render: function(x) { return _mc('Win Rate',           fmtPct(x.m.winRate),       x.m.winRate>=0.5?'pos':'neu'); } },
            { id:'trades',       label:'Trades',                 render: function(x) { return _mc('Trades',             x.m.count,                 'neu'); } },
            { id:'pf',           label:'Profit Factor',          render: function(x) { return _mc('Profit Factor',      fmtPF(x.m.profitFactor),   x.m.profitFactor>=1?'pos':'neg'); } },
            { id:'expectancy',   label:'Expectancy',             render: function(x) { return _mc('Expectancy',         fmtD(x.m.expectancy),      x.m.expectancy>=0?'pos':'neg'); } },
            { id:'avg-win',      label:'Avg Win',                render: function(x) { return _mc('Avg Win',            '+'+fmt$(x.m.avgWin),      'pos'); } },
            { id:'avg-loss',     label:'Avg Loss',               render: function(x) { return _mc('Avg Loss',           '-'+fmt$(x.m.avgLoss),     'neg'); } },
            { id:'best-trade',   label:'Best Trade',             render: function(x) { return _mc('Best Trade',         '+'+fmt$(x.m.largestWin),  'pos'); } },
            { id:'worst-trade',  label:'Worst Trade',            render: function(x) { return _mc('Worst Trade',        '-'+fmt$(x.m.largestLoss), 'neg'); } },
            { id:'max-dd',       label:'Max Intraday Drawdown',  render: function(x) { return _mc('Max Intraday Drawdown',  x.maxDD>0?'-'+fmt$(x.maxDD):'—', x.maxDD>0?'neg':'neu'); } },
            { id:'plan-adh',     label:'Plan Adherence',         render: function(x) { return _mc('Plan Adherence',    x.planAdh!=null?x.planAdh+'%':'—', x.planAdh!=null?(x.planAdh>=80?'pos':x.planAdh>=60?'neu':'neg'):'neu'); } },
            { id:'outside-plan', label:'Outside-Plan Trades',    render: function(x) { return _mc('Outside-Plan Trades', String(x.outsidePlan), x.outsidePlan>0?'neg':'pos'); } },
            { id:'rule-viol',    label:'Rule Violations',        render: function(x) { return _mc('Rule Violations',   String(x.ruleViolations), x.ruleViolations>0?'neg':'pos'); } },
            { id:'emo-disc',     label:'Emotional Discipline',   render: function(x) { return _mc('Emotional Discipline', x.emoDiscipline!=null?x.emoDiscipline+'%':'—', x.emoDiscipline!=null?(x.emoDiscipline>=70?'pos':x.emoDiscipline>=40?'neu':'neg'):'neu'); } },
            { id:'costly-miss',  label:'Most Costly Mistake',    render: function(x) { return _mc('Most Costly Mistake', x.costlyMistake?escH(x.costlyMistake):'—', x.costlyMistake?'neg':'neu'); } }
        ],
        weekly: [
            { id:'net-pnl',      label:'Weekly Net P&L',         render: function(x) { return _mc('Weekly Net P&L',    fmtD(x.m.totalPnl),        x.m.totalPnl>=0?'pos':'neg'); } },
            { id:'green-red',    label:'Green / Red Days',        render: function(x) { return _mc('Green / Red Days', x.greenDays+'G · '+x.redDays+'R', x.greenDays>x.redDays?'pos':'neg'); } },
            { id:'trades',       label:'Total Trades',            render: function(x) { return _mc('Total Trades',      x.m.count,                 'neu'); } },
            { id:'pf',           label:'Profit Factor',           render: function(x) { return _mc('Profit Factor',     fmtPF(x.m.profitFactor),   x.m.profitFactor>=1?'pos':'neg'); } },
            { id:'expectancy',   label:'Expectancy',              render: function(x) { return _mc('Expectancy',        fmtD(x.m.expectancy),      x.m.expectancy>=0?'pos':'neg'); } },
            { id:'best-day',     label:'Best Day',                render: function(x) { return _mc('Best Day',          fmtD(x.bestDayPnl),        x.bestDayPnl>=0?'pos':'neg'); } },
            { id:'worst-day',    label:'Worst Day',               render: function(x) { return _mc('Worst Day',         fmtD(x.worstDayPnl),       x.worstDayPnl>=0?'pos':'neg'); } },
            { id:'avg-daily',    label:'Avg Daily P&L',           render: function(x) { return _mc('Avg Daily P&L',    fmtD(x.avgDailyPnl),       x.avgDailyPnl>=0?'pos':'neg'); } },
            { id:'best-setup',   label:'Best Strategy',              render: function(x) { return _mc('Best Strategy',        x.bestSetup?escH(x.bestSetup.name):'—',  x.bestSetup&&x.bestSetup.pnl>0?'pos':'neu'); } },
            { id:'worst-setup',  label:'Worst Strategy',             render: function(x) { return _mc('Worst Strategy',       x.worstSetup?escH(x.worstSetup.name):'—',x.worstSetup&&x.worstSetup.pnl<0?'neg':'neu'); } },
            { id:'avg-plan',     label:'Avg Plan Adherence',      render: function(x) { return _mc('Avg Plan Adherence', x.planAdh!=null?x.planAdh+'%':'—', x.planAdh!=null?(x.planAdh>=80?'pos':x.planAdh>=60?'neu':'neg'):'neu'); } },
            { id:'rule-viol',    label:'Total Rule Violations',   render: function(x) { return _mc('Total Rule Violations', String(x.ruleViolations), x.ruleViolations>0?'neg':'pos'); } },
            { id:'outside-plan', label:'Outside-Plan Trades',     render: function(x) { return _mc('Outside-Plan Trades', String(x.outsidePlan), x.outsidePlan>0?'neg':'pos'); } },
            { id:'overtrade',    label:'Overtrading Days',        render: function(x) { return _mc('Overtrading Days',  String(x.overtradingDays), x.overtradingDays>0?'neg':'pos'); } },
            { id:'costly-habit', label:'Most Costly Habit',       render: function(x) { return _mc('Most Costly Habit', x.costlyMistake?escH(x.costlyMistake):'—', x.costlyMistake?'neg':'neu'); } },
            { id:'daily-plans',  label:'Daily Plans Completed',   render: function(x) { return _mc('Daily Plans Completed', x.dailyPlansCompleted!=null?x.dailyPlansCompleted+' / '+x.dailyPlansDays:'—', x.dailyPlansCompleted!=null?(x.dailyPlansCompleted>=x.dailyPlansDays?'pos':x.dailyPlansCompleted>0?'neu':'neg'):'neu'); } },
            { id:'journal-rate', label:'Reflection Completion Rate', render: function(x) { return _mc('Reflection Completion Rate', x.journalRate!=null?x.journalRate+'%':'—', x.journalRate!=null?(x.journalRate>=80?'pos':x.journalRate>=50?'neu':'neg'):'neu'); } },
            { id:'goal-follow',  label:'Goal Follow-Through',     render: function(x) { return _mc('Goal Follow-Through', x.goalFollowPct!=null?x.goalFollowPct+'%':'—', x.goalFollowPct!=null?(x.goalFollowPct>=70?'pos':x.goalFollowPct>=40?'neu':'neg'):'neu'); } },
            { id:'vs-last-wk',   label:'vs Last Week',            render: function(x) { return _mc('vs Last Week', x.vsLastPnlDelta!=null?fmtD(x.vsLastPnlDelta):'—', x.vsLastPnlDelta!=null?(x.vsLastPnlDelta>=0?'pos':'neg'):'neu'); } }
        ],
        monthly: [
            { id:'net-pnl',      label:'Monthly Net P&L',        render: function(x) { return _mc('Monthly Net P&L',  fmtD(x.m.totalPnl),        x.m.totalPnl>=0?'pos':'neg'); } },
            { id:'total-r',      label:'Total R',                 render: function(x) { return _mc('Total R',          x.totalR!=null?x.totalR.toFixed(2)+'R':'—', x.totalR!=null?(x.totalR>=0?'pos':'neg'):'neu'); } },
            { id:'pf',           label:'Profit Factor',           render: function(x) { return _mc('Profit Factor',    fmtPF(x.m.profitFactor),   x.m.profitFactor>=1?'pos':'neg'); } },
            { id:'expectancy',   label:'Expectancy',              render: function(x) { return _mc('Expectancy',       fmtD(x.m.expectancy),      x.m.expectancy>=0?'pos':'neg'); } },
            { id:'green-days',   label:'Green Days %',            render: function(x) { return _mc('Green Days %',     x.tradingDays?Math.round(x.greenDays/x.tradingDays*100)+'%':'—', x.greenDays>=x.redDays?'pos':'neg'); } },
            { id:'consistency',  label:'Consistency Score',       render: function(x) { return _mc('Consistency Score', x.consistencyScore!=null?x.consistencyScore:'—', x.consistencyScore!=null?(x.consistencyScore>=70?'pos':x.consistencyScore>=40?'neu':'neg'):'neu'); } },
            { id:'green-wks',    label:'Green / Red Weeks',       render: function(x) { return _mc('Green / Red Weeks',x.greenWeeks+'G · '+x.redWeeks+'R', x.greenWeeks>=x.redWeeks?'pos':'neg'); } },
            { id:'avg-daily',    label:'Avg Daily P&L',           render: function(x) { return _mc('Avg Daily P&L',   fmtD(x.avgDailyPnl),       x.avgDailyPnl>=0?'pos':'neg'); } },
            { id:'max-dd',       label:'Largest Drawdown',        render: function(x) { return _mc('Largest Drawdown', x.maxDD>0?'-'+fmt$(x.maxDD):'—', x.maxDD>0?'neg':'neu'); } },
            { id:'recovery',     label:'Recovery Rate',           render: function(x) { return _mc('Recovery Rate',    x.recoveryRate!=null?x.recoveryRate+'%':'—', x.recoveryRate!=null?(x.recoveryRate>=60?'pos':x.recoveryRate>=40?'neu':'neg'):'neu'); } },
            { id:'freq-viol',    label:'Most Frequent Violation', render: function(x) { return _mc('Most Frequent Violation', x.freqViolation?escH(x.freqViolation):'—', x.freqViolation?'neg':'neu'); } },
            { id:'costly-behav', label:'Most Costly Behavior',    render: function(x) { return _mc('Most Costly Behavior', x.costlyMistake?escH(x.costlyMistake):'—', x.costlyMistake?'neg':'neu'); } },
            { id:'best-setup',   label:'Best Strategy',              render: function(x) { return _mc('Best Strategy',       x.bestSetup?escH(x.bestSetup.name):'—',  x.bestSetup&&x.bestSetup.pnl>0?'pos':'neu'); } },
            { id:'worst-setup',  label:'Worst Strategy',             render: function(x) { return _mc('Worst Strategy',      x.worstSetup?escH(x.worstSetup.name):'—',x.worstSetup&&x.worstSetup.pnl<0?'neg':'neu'); } },
            { id:'best-time',    label:'Best Time of Day',        render: function(x) { return _mc('Best Time of Day', x.bestTimeLabel||'—', x.bestTimePnl!=null&&x.bestTimePnl>0?'pos':'neu'); } }
        ],
        yearly: [
            { id:'net-pnl',      label:'Yearly Net P&L',         render: function(x) { return _mc('Yearly Net P&L',   fmtD(x.m.totalPnl),        x.m.totalPnl>=0?'pos':'neg'); } },
            { id:'total-r',      label:'Total R',                 render: function(x) { return _mc('Total R',          x.totalR!=null?x.totalR.toFixed(2)+'R':'—', x.totalR!=null?(x.totalR>=0?'pos':'neg'):'neu'); } },
            { id:'pf',           label:'Profit Factor',           render: function(x) { return _mc('Profit Factor',    fmtPF(x.m.profitFactor),   x.m.profitFactor>=1?'pos':'neg'); } },
            { id:'expectancy',   label:'Expectancy',              render: function(x) { return _mc('Expectancy',       fmtD(x.m.expectancy),      x.m.expectancy>=0?'pos':'neg'); } },
            { id:'profit-mos',   label:'Profitable Months',       render: function(x) { return _mc('Profitable Months',x.moKeys.length?Math.round(x.profitableMonths/x.moKeys.length*100)+'%':'—', x.profitableMonths>=(x.moKeys.length/2)?'pos':'neg'); } },
            { id:'consistency',  label:'Consistency Score',       render: function(x) { return _mc('Consistency Score', x.consistencyScore!=null?x.consistencyScore:'—', x.consistencyScore!=null?(x.consistencyScore>=70?'pos':x.consistencyScore>=40?'neu':'neg'):'neu'); } },
            { id:'max-dd',       label:'Largest Drawdown',        render: function(x) { return _mc('Largest Drawdown', x.maxDD>0?'-'+fmt$(x.maxDD):'—', x.maxDD>0?'neg':'neu'); } },
            { id:'dd-period',    label:'Longest Drawdown Period', render: function(x) { return _mc('Longest Drawdown Period', x.maxDDStreak>0?x.maxDDStreak+' day'+(x.maxDDStreak!==1?'s':''):'—', x.maxDDStreak>10?'neg':x.maxDDStreak>0?'neu':'pos'); } },
            { id:'avg-monthly',  label:'Avg Monthly Return',      render: function(x) { return _mc('Avg Monthly Return',fmtD(x.avgMonthlyReturn),  x.avgMonthlyReturn>=0?'pos':'neg'); } },
            { id:'recovery',     label:'Recovery Time',           render: function(x) { return _mc('Recovery Time',    x.recoveryRate!=null?x.recoveryRate+'%':'—', x.recoveryRate!=null?(x.recoveryRate>=60?'pos':x.recoveryRate>=40?'neu':'neg'):'neu'); } },
            { id:'best-setup',   label:'Best Strategy',              render: function(x) { return _mc('Best Strategy',       x.bestSetup?escH(x.bestSetup.name):'—',  x.bestSetup&&x.bestSetup.pnl>0?'pos':'neu'); } },
            { id:'worst-setup',  label:'Worst Strategy',             render: function(x) { return _mc('Worst Strategy',      x.worstSetup?escH(x.worstSetup.name):'—',x.worstSetup&&x.worstSetup.pnl<0?'neg':'neu'); } },
            { id:'best-time',    label:'Best Time of Day',        render: function(x) { return _mc('Best Time of Day', x.bestTimeLabel||'—', x.bestTimePnl!=null&&x.bestTimePnl>0?'pos':'neu'); } },
            { id:'costly-habit', label:'Most Costly Habit',       render: function(x) { return _mc('Most Costly Habit', x.costlyMistake?escH(x.costlyMistake):'—', x.costlyMistake?'neg':'neu'); } }
        ]
    };

    var RV_SNAP_DEFAULT = {
        daily:   ['net-pnl','trades','pf','expectancy','plan-adh','emo-disc'],
        weekly:  ['net-pnl','green-red','trades','pf','avg-plan','journal-rate'],
        monthly: ['net-pnl','pf','green-days','max-dd','total-r','consistency'],
        yearly:  ['net-pnl','pf','profit-mos','max-dd','total-r','consistency']
    };

    function rvSnapSaveLayout(type) {
        var jd = journalData;
        if (!jd.reviewLayouts) jd.reviewLayouts = {};
        jd.reviewLayouts[type] = _rvSnap[type].layout.slice();
        if (typeof saveToIndexedDB === 'function') saveToIndexedDB();
    }

    // ── Snapshot drag-and-drop ────────────────────────────────────────────────
    function setupRvSnapDrag(type) {
        var grid = document.getElementById('rv-snap-grid-' + type);
        if (!grid) return;
        var snap = _rvSnap[type];
        var drag = snap.drag;

        grid.addEventListener('dragstart', function(e) {
            var card = e.target.closest('[data-card-id]');
            if (!card) return;
            drag.srcId = card.dataset.cardId;
            setTimeout(function() { if (card) card.classList.add('rv-snap-dragging'); }, 0);
        });

        grid.addEventListener('dragend', function() {
            grid.querySelectorAll('.rv-snap-dragging,.rv-snap-drag-over').forEach(function(el) {
                el.classList.remove('rv-snap-dragging', 'rv-snap-drag-over');
            });
        });

        grid.addEventListener('dragover', function(e) {
            e.preventDefault();
            var card = e.target.closest('[data-card-id]');
            grid.querySelectorAll('.rv-snap-drag-over').forEach(function(el) {
                el.classList.remove('rv-snap-drag-over');
            });
            if (card && card.dataset.cardId !== drag.srcId) {
                card.classList.add('rv-snap-drag-over');
                drag.overId = card.dataset.cardId;
            }
        });

        grid.addEventListener('drop', function(e) {
            e.preventDefault();
            var card = e.target.closest('[data-card-id]');
            if (!card) return;
            var targetId = card.dataset.cardId;
            if (!targetId || targetId === drag.srcId) return;
            var layout = snap.layout;
            var srcIdx = layout.indexOf(drag.srcId);
            var tgtIdx = layout.indexOf(targetId);
            if (srcIdx < 0 || tgtIdx < 0) return;
            var moved = layout.splice(srcIdx, 1)[0];
            var newTgt = layout.indexOf(targetId);
            layout.splice(newTgt, 0, moved);
            drag.srcId = null;
            drag.overId = null;
            rvSnapSaveLayout(type);
            renderReviewPage(type);
        });
    }

    function buildSnapshot(type, m, trades, periodKey) {

        // Day-level grouping
        var days = {};
        trades.forEach(function(t) {
            var d = _tradeDay(t);
            if (!d) return;
            if (!days[d]) days[d] = { pnl: 0, count: 0 };
            days[d].pnl += _tradePnl(t);
            days[d].count++;
        });
        var dayKeys    = Object.keys(days).sort();
        var dayPnls    = dayKeys.map(function(k) { return days[k].pnl; });
        var greenDays  = dayPnls.filter(function(p) { return p > 0; }).length;
        var redDays    = dayPnls.filter(function(p) { return p < 0; }).length;
        var tradingDays = dayKeys.length;
        var bestDayPnl  = dayPnls.length ? Math.max.apply(null, dayPnls) : 0;
        var worstDayPnl = dayPnls.length ? Math.min.apply(null, dayPnls) : 0;
        var avgDailyPnl = tradingDays ? m.totalPnl / tradingDays : 0;
        var overtradingDays = dayKeys.filter(function(k) { return days[k].count >= 8; }).length;

        // Setup grouping
        var setupMap = {};
        trades.forEach(function(t) {
            var s = t.setupType || t.strategy || t.setup || 'No Strategy';
            if (!setupMap[s]) setupMap[s] = { pnl: 0, count: 0 };
            setupMap[s].pnl += _tradePnl(t);
            setupMap[s].count++;
        });
        var setups = Object.keys(setupMap).map(function(k) {
            return { name: k, pnl: setupMap[k].pnl, count: setupMap[k].count };
        }).sort(function(a, b) { return b.pnl - a.pnl; });
        var bestSetup  = setups.length ? setups[0] : null;
        var worstSetup = setups.length > 1 ? setups[setups.length - 1] : null;

        // Month grouping (yearly)
        var mos = {};
        trades.forEach(function(t) {
            var mk = _tradeDay(t).slice(0, 7);
            if (!mk) return;
            if (!mos[mk]) mos[mk] = { pnl: 0 };
            mos[mk].pnl += _tradePnl(t);
        });
        var moKeys = Object.keys(mos).sort();
        var moPnls = moKeys.map(function(k) { return mos[k].pnl; });
        var profitableMonths = moPnls.filter(function(p) { return p > 0; }).length;
        var avgMonthlyReturn = moKeys.length ? m.totalPnl / moKeys.length : 0;

        // Week grouping (monthly)
        var wks = {};
        trades.forEach(function(t) {
            var d = _tradeDay(t);
            if (!d) return;
            var wk = sunWeekKey(new Date(d + 'T00:00:00'));
            if (!wks[wk]) wks[wk] = { pnl: 0 };
            wks[wk].pnl += _tradePnl(t);
        });
        var wkPnls   = Object.keys(wks).map(function(k) { return wks[k].pnl; });
        var greenWeeks = wkPnls.filter(function(p) { return p > 0; }).length;
        var redWeeks   = wkPnls.filter(function(p) { return p < 0; }).length;

        // Largest drawdown + longest drawdown period (in trading days)
        var sortedT = trades.slice().sort(function(a, b) {
            return _tradeDay(a).localeCompare(_tradeDay(b));
        });
        var cum = 0, peak = 0, maxDD = 0;
        var ddStreak = 0, maxDDStreak = 0, lastDDDay = '';
        sortedT.forEach(function(t) {
            cum += _tradePnl(t);
            if (cum >= peak) {
                peak = cum;
                ddStreak = 0;
                lastDDDay = '';
            } else {
                var day = _tradeDay(t);
                if (day !== lastDDDay) { ddStreak++; lastDDDay = day; }
                if (ddStreak > maxDDStreak) maxDDStreak = ddStreak;
            }
            var dd = peak - cum;
            if (dd > maxDD) maxDD = dd;
        });

        // Plan adherence: average strategyScore.percentage across eligible trades
        var _planScores = [];
        var outsidePlan = 0;
        var ruleViolations = 0;
        trades.forEach(function(t) {
            if (!t.setupType) { outsidePlan++; return; }
            if (t.strategyScore) {
                _planScores.push(t.strategyScore.percentage || 0);
                if (!t.strategyScore.allMandatoryFollowed) ruleViolations++;
            }
        });
        var planAdh = _planScores.length ? Math.round(_planScores.reduce(function(a,b){return a+b;},0) / _planScores.length) : null;

        // Emotional discipline: % of trades with positive emotion
        var GOOD_EMO = ['Confident','Patient','Focused'];
        var BAD_EMO  = ['FOMO','Anxious','Revenge Trading','Frustrated','Distracted'];
        var emoGood = 0, emoTotal = 0;
        trades.forEach(function(t) {
            if (!t.emotion) return;
            if (GOOD_EMO.indexOf(t.emotion) !== -1) { emoGood++; emoTotal++; }
            else if (BAD_EMO.indexOf(t.emotion) !== -1) { emoTotal++; }
        });
        var emoDiscipline = emoTotal > 0 ? Math.round(emoGood / emoTotal * 100) : null;

        // Most costly mistake: tag in "Mistakes" category with worst total P&L
        var mistakeTags = {};
        var jdTags = (typeof journalData !== 'undefined' && journalData.tags) ? journalData.tags : [];
        var mistakeNames = {};
        jdTags.forEach(function(tg) { if (tg.category === 'Mistakes') mistakeNames[tg.name] = true; });
        trades.forEach(function(t) {
            if (!t.tags || !t.tags.length) return;
            t.tags.forEach(function(tagName) {
                if (mistakeNames[tagName]) {
                    if (!mistakeTags[tagName]) mistakeTags[tagName] = 0;
                    mistakeTags[tagName] += _tradePnl(t);
                }
            });
        });
        var costlyMistake = null;
        Object.keys(mistakeTags).forEach(function(name) {
            if (!costlyMistake || mistakeTags[name] < mistakeTags[costlyMistake]) costlyMistake = name;
        });
        var costlyMistakePnl = costlyMistake ? mistakeTags[costlyMistake] : 0;

        // Journal completion rate: % of trades with meaningful journal content
        var journaledCount = 0;
        trades.forEach(function(t) {
            if (t.entryReason || t.exitReason || t.lessons || t.tradeGrade || (t.tags && t.tags.length)) journaledCount++;
        });
        var journalRate = trades.length > 0 ? Math.round(journaledCount / trades.length * 100) : null;

        // Daily plans completed: count daily reviews marked complete within this period
        var dailyPlansCompleted = null, dailyPlansDays = 0;
        if (periodKey && (type === 'weekly' || type === 'monthly')) {
            var range = periodRange(type, periodKey);
            var dCur = new Date(range[0]);
            var dEnd = new Date(range[1]);
            var completed = 0, totalDays = 0;
            while (dCur <= dEnd) {
                var dow = dCur.getDay();
                if (dow !== 0 && dow !== 6) {
                    totalDays++;
                    var dk = dCur.getFullYear() + '-' + pad(dCur.getMonth()+1) + '-' + pad(dCur.getDate());
                    var dr = getRev('daily', dk);
                    if (dr && dr.status === 'complete') completed++;
                }
                dCur.setDate(dCur.getDate() + 1);
            }
            dailyPlansCompleted = completed;
            dailyPlansDays = totalDays;
        }

        // Goal follow-through: % of previous period's nextFocus items marked done
        var goalFollowPct = null;
        if (periodKey) {
            var prevKey = stepKey(type, periodKey, -1);
            var prevRev = getRev(type, prevKey);
            if (prevRev && prevRev.nextFocus) {
                var nfTotal = 0, nfDone = 0;
                ['cont','stop','start'].forEach(function(cat) {
                    (prevRev.nextFocus[cat] || []).forEach(function(item) {
                        if (item.text) { nfTotal++; if (item.done) nfDone++; }
                    });
                });
                if (nfTotal > 0) goalFollowPct = Math.round(nfDone / nfTotal * 100);
            }
        }

        // Improvement vs last week: P&L delta
        var vsLastPnlDelta = null;
        if (periodKey && type === 'weekly') {
            var prevWkKey = stepKey('weekly', periodKey, -1);
            var prevTrades = tradesFor('weekly', prevWkKey);
            if (prevTrades.length > 0) {
                var prevPnl = prevTrades.reduce(function(s,t) { return s + _tradePnl(t); }, 0);
                vsLastPnlDelta = m.totalPnl - prevPnl;
            }
        }

        // Total R: sum of realizedRMultiple for trades with tradeRisk
        var totalR = null;
        var rCount = 0;
        trades.forEach(function(t) {
            if (t.tradeRisk > 0 && t.realizedRMultiple != null) {
                totalR = (totalR || 0) + t.realizedRMultiple;
                rCount++;
            }
        });
        if (rCount > 0) totalR = Math.round(totalR * 100) / 100;

        // Consistency Score: 100 - normalized CV of daily P&L (clamped 0-100)
        var consistencyScore = null;
        if (dayPnls.length >= 3) {
            var _mean = dayPnls.reduce(function(a,b){return a+b;},0) / dayPnls.length;
            var _variance = dayPnls.reduce(function(a,p){return a + (p-_mean)*(p-_mean);},0) / dayPnls.length;
            var _stddev = Math.sqrt(_variance);
            var _absMean = Math.abs(_mean);
            // Use max(absMean, stddev*0.1) as denominator to avoid near-zero blowup
            var _denom = Math.max(_absMean, _stddev * 0.1, 1);
            consistencyScore = Math.max(0, Math.min(100, Math.round(100 - (_stddev / _denom) * 50)));
        }

        // Recovery Rate: % of trades (chronological) at or above previous cumulative high
        var recoveryRate = null;
        if (sortedT.length >= 3) {
            var _rCum = 0, _rPeak = 0, _atHigh = 0;
            sortedT.forEach(function(t) {
                _rCum += _tradePnl(t);
                if (_rCum >= _rPeak) { _rPeak = _rCum; _atHigh++; }
            });
            recoveryRate = Math.round(_atHigh / sortedT.length * 100);
        }

        // Best Time of Day: hour bucket with highest total P&L
        var bestTimeLabel = null;
        var bestTimePnl = null;
        if (trades.length > 0) {
            var hourPnl = {};
            trades.forEach(function(t) {
                var h = new Date(t.entryTime).getHours();
                if (!hourPnl[h]) hourPnl[h] = 0;
                hourPnl[h] += _tradePnl(t);
            });
            var bestHour = null;
            Object.keys(hourPnl).forEach(function(h) {
                if (bestHour === null || hourPnl[h] > hourPnl[bestHour]) bestHour = h;
            });
            if (bestHour !== null) {
                var bh = parseInt(bestHour);
                var startLabel = bh === 0 ? '12 AM' : bh < 12 ? bh + ' AM' : bh === 12 ? '12 PM' : (bh-12) + ' PM';
                var eh = (bh + 1) % 24;
                var endLabel = eh === 0 ? '12 AM' : eh < 12 ? eh + ' AM' : eh === 12 ? '12 PM' : (eh-12) + ' PM';
                bestTimeLabel = startLabel + '–' + endLabel;
                bestTimePnl = hourPnl[bestHour];
            }
        }

        // Most Frequent Violation: mandatory rule most often not followed
        var freqViolation = null;
        var jdStrats = (typeof journalData !== 'undefined' && journalData.strategies) ? journalData.strategies : [];
        var _stratRuleMap = {};
        jdStrats.forEach(function(s) {
            if (!s.groups) return;
            s.groups.forEach(function(g) {
                (g.rules || []).forEach(function(r) {
                    if (r.isMandatory) _stratRuleMap[r.id] = { text: r.text, stratName: s.name };
                });
            });
        });
        if (Object.keys(_stratRuleMap).length > 0) {
            var violCounts = {};
            trades.forEach(function(t) {
                if (!t.strategyScore || t.strategyScore.allMandatoryFollowed) return;
                var strat = jdStrats.find(function(s) { return s.name === t.setupType; });
                if (!strat || !strat.groups) return;
                strat.groups.forEach(function(g) {
                    (g.rules || []).forEach(function(r) {
                        if (!r.isMandatory) return;
                        var outcome = t.pnl > 0 ? 'winner' : t.pnl < 0 ? 'loser' : 'breakeven';
                        if (r.showWhen && r.showWhen !== 'always' && r.showWhen !== outcome) return;
                        if (t.strategyScore.followedRules.indexOf(r.id) === -1) {
                            violCounts[r.id] = (violCounts[r.id] || 0) + 1;
                        }
                    });
                });
            });
            var topViolId = null;
            Object.keys(violCounts).forEach(function(rid) {
                if (!topViolId || violCounts[rid] > violCounts[topViolId]) topViolId = rid;
            });
            if (topViolId && _stratRuleMap[topViolId]) {
                var ruleText = _stratRuleMap[topViolId].text;
                freqViolation = ruleText.length > 40 ? ruleText.slice(0, 37) + '...' : ruleText;
            }
        }

        var ctx = {
            m: m, trades: trades,
            greenDays: greenDays, redDays: redDays, tradingDays: tradingDays,
            bestDayPnl: bestDayPnl, worstDayPnl: worstDayPnl,
            avgDailyPnl: avgDailyPnl, overtradingDays: overtradingDays,
            bestSetup: bestSetup, worstSetup: worstSetup,
            moKeys: moKeys, profitableMonths: profitableMonths,
            avgMonthlyReturn: avgMonthlyReturn,
            greenWeeks: greenWeeks, redWeeks: redWeeks, maxDD: maxDD, maxDDStreak: maxDDStreak,
            planAdh: planAdh, outsidePlan: outsidePlan, ruleViolations: ruleViolations,
            emoDiscipline: emoDiscipline,
            costlyMistake: costlyMistake, costlyMistakePnl: costlyMistakePnl,
            journalRate: journalRate,
            dailyPlansCompleted: dailyPlansCompleted, dailyPlansDays: dailyPlansDays,
            goalFollowPct: goalFollowPct,
            vsLastPnlDelta: vsLastPnlDelta,
            totalR: totalR, consistencyScore: consistencyScore,
            recoveryRate: recoveryRate,
            bestTimeLabel: bestTimeLabel, bestTimePnl: bestTimePnl,
            freqViolation: freqViolation
        };

        // Load layout from storage once, then keep in module state
        var snap = _rvSnap[type];
        if (!snap.layout) {
            var jdLayouts = journalData && journalData.reviewLayouts;
            snap.layout = (jdLayouts && jdLayouts[type])
                ? jdLayouts[type].slice()
                : RV_SNAP_DEFAULT[type].slice();
        }
        var layout = snap.layout;
        var lib    = RV_SNAP_LIB[type] || [];
        var libMap = {};
        lib.forEach(function(c) { libMap[c.id] = c; });

        // Render cards (with drag/remove wrappers in edit mode)
        var cards = layout.map(function(id) {
            var c = libMap[id];
            if (!c) return '';
            var inner = c.render(ctx);
            if (snap.editMode) {
                return '<div class="rv-snap-card-wrap" data-card-id="' + id + '" draggable="true">' +
                    '<span class="rv-snap-drag-handle" title="Drag to reorder">⠿</span>' +
                    inner +
                    '<button class="rv-snap-remove-btn" ' +
                        'onclick="window._rvSnapRemove(\'' + type + '\',\'' + id + '\')" ' +
                        'title="Remove">✕</button>' +
                '</div>';
            }
            return inner;
        }).join('');

        // Picker: show only cards not currently in layout
        var inLayout = {};
        layout.forEach(function(id) { inLayout[id] = true; });
        var available = lib.filter(function(c) { return !inLayout[c.id]; });
        var pickerHtml = available.length
            ? available.map(function(c) {
                return '<div class="rv-snap-picker-item">' +
                    '<span class="rv-snap-picker-label">' + escH(c.label) + '</span>' +
                    '<button class="btn btn-secondary btn-small" ' +
                        'onclick="window._rvSnapAdd(\'' + type + '\',\'' + c.id + '\')">+ Add</button>' +
                '</div>';
              }).join('')
            : '<div class="rv-snap-picker-empty">All cards are shown.</div>';

        var editBtnText  = snap.editMode ? '✓ Done' : 'Edit Layout';
        var gridClass    = 'review-metrics rv-snapshot-grid' + (snap.editMode ? ' rv-snap-edit-mode' : '');

        return '<div class="review-section">' +
            '<div class="review-section-hdr">' +
                '<h3 class="review-section-title">Snapshot</h3>' +
                '<div style="display:flex;gap:6px;align-items:center;">' +
                (snap.editMode
                    ? '<button class="btn btn-secondary btn-small" onclick="window._rvSnapOpenPicker(\'' + type + '\')">+ Add Card</button>' +
                      '<button class="btn btn-secondary btn-small" onclick="window._rvSnapReset(\'' + type + '\')">Reset</button>'
                    : '') +
                '<button class="btn btn-secondary btn-small" onclick="window._rvSnapEdit(\'' + type + '\')">' + editBtnText + '</button>' +
                '</div>' +
            '</div>' +
            '<div class="' + gridClass + '" id="rv-snap-grid-' + type + '">' + cards + '</div>' +
            '<div class="rv-snap-picker-panel" id="rv-snap-picker-' + type + '" style="display:none;">' +
                '<div class="rv-snap-picker-hdr">' +
                    '<span>Add Card</span>' +
                    '<button class="rv-snap-picker-close" onclick="window._rvSnapClosePicker(\'' + type + '\')">✕</button>' +
                '</div>' +
                '<div class="rv-snap-picker-body">' + pickerHtml + '</div>' +
            '</div>' +
        '</div>';
    }

    // ── Next-Focus list builder ───────────────────────────────────────────────
    function buildNfList(type, key, cat, items) {
        var labels = { cont:'Continue ✓', stop:'Stop ✗', start:'Focus →' };
        var colors = { cont:'rv-nf-continue', stop:'rv-nf-stop', start:'rv-nf-start' };
        var html = '<div class="rv-nf-col '+colors[cat]+'">' +
            '<div class="rv-nf-col-hdr">' +
                '<span class="rv-nf-col-label">'+labels[cat]+'</span>' +
                '<button class="rv-nf-add" onclick="window._rvNfAdd(\''+type+'\',\''+escH(key)+'\',\''+cat+'\')" title="Add item">+</button>' +
            '</div>' +
            '<div class="rv-nf-items" id="rv-nf-'+type+'-'+cat+'">';
        (items||[]).forEach(function(item, i) {
            html += '<div class="rv-nf-item" data-cat="'+cat+'" data-type="'+type+'" data-i="'+i+'">' +
                '<input type="checkbox"'+(item.done?' checked':'')+' ' +
                    'onchange="window._rvNfToggle(\''+type+'\',\''+escH(key)+'\',\''+cat+'\','+i+',this.checked)">' +
                '<span class="rv-nf-label'+(item.done?' rv-done':'')+'">'+escH(item.text)+'</span>' +
                '<button class="review-action-del" onclick="window._rvNfRemove(\''+type+'\',\''+escH(key)+'\',\''+cat+'\','+i+')" title="Remove">✕</button>' +
            '</div>';
        });
        html += '</div></div>';
        return html;
    }

    // ── AI Analysis state ──────────────────────────────────────────────────────
    // In-memory cache keyed by type+'|'+periodKey. Persisted in review.aiAnalysis.
    var _rvAiCache = {};

    function _rvAiCacheKey(type, key) { return type + '|' + key; }

    function _rvGetAi(type, key) {
        var ck = _rvAiCacheKey(type, key);
        if (_rvAiCache[ck]) return _rvAiCache[ck];
        var rev = getRev(type, key);
        if (rev && rev.aiAnalysis) {
            _rvAiCache[ck] = rev.aiAnalysis;
            return rev.aiAnalysis;
        }
        return null;
    }

    function _rvSaveAi(type, key, data) {
        var ck = _rvAiCacheKey(type, key);
        _rvAiCache[ck] = data;
        // Capture current editor/NF state before saving so we don't overwrite
        // unsaved reflection edits with stale content from the review object.
        var rev = curRev(type, key);
        var state = captureState(type);
        if (state.content !== null) rev.content = state.content;
        rev.nextFocus = state.nextFocus;
        rev.aiAnalysis = data;
        rev.updatedAt = Date.now();
        saveRev(type, key, rev);
    }

    // ── Run AI into on-page panel ───────────────────────────────────────────
    function _rvRunAI(type) {
        var key = _st[type].periodKey;
        var bodyEl = document.getElementById('rv-ai-body-' + type);
        var footerEl = document.getElementById('rv-ai-footer-' + type);
        if (!bodyEl) return;

        if (typeof window._rvAiRender === 'function') {
            window._rvAiRender(type, key, bodyEl, footerEl);
        }
    }

    function _rvAppendAI(type) {
        var key = _st[type].periodKey;
        var ai = _rvGetAi(type, key);
        if (!ai || !ai.text) return;
        if (ai.appendedAt) {
            if (!confirm('This AI analysis was already appended. Append again?')) return;
        }
        var ed = document.getElementById('rv-editor-' + type);
        if (!ed) return;
        var sep = '--------------------------------';
        var dateStr = new Date().toLocaleDateString('en-US', { month:'long', day:'numeric', year:'numeric' });
        var appendHtml = '<p><br></p><p>' + sep + '</p>' +
            '<p><strong>AI Analysis \u2014 ' + escH(dateStr) + '</strong></p>' +
            '<p>' + escH(ai.text) + '</p>';
        ed.focus();
        // Place cursor at end
        var sel = window.getSelection();
        sel.selectAllChildren(ed);
        sel.collapseToEnd();
        document.execCommand('insertHTML', false, appendHtml);
        // Mark as appended
        ai.appendedAt = Date.now();
        _rvSaveAi(type, key, ai);
        // Update append button state
        _rvUpdateAppendBtn(type);
        // Trigger save
        _rvSaveDraft(type, key, ed.innerHTML);
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function() { doSave(type, key, {}); }, 400);
    }

    // ── Clean Up with AI ──────────────────────────────────────────────────────
    var _rvCleanupBusy = {};

    function _rvCleanupMsg(type, text, isError) {
        var el = document.getElementById('rv-cleanup-msg-' + type);
        if (!el) return;
        el.textContent = text;
        el.style.color = isError ? 'var(--danger)' : 'var(--text-secondary)';
    }

    function _rvCleanupAccount() {
        return typeof _noteCleanupAccount === 'function' ? _noteCleanupAccount() : null;
    }

    // Appends below the reflection; the original text is never replaced.
    function _rvCleanUpAI(type) {
        if (_rvCleanupBusy[type] || typeof _noteCleanup !== 'function') return;
        var key = _st[type].periodKey;
        // Save pending typing first, as the planners do. A stale save reloads the page.
        if (_saveTimer) {
            clearTimeout(_saveTimer);
            _saveTimer = null;
            if (doSave(type, key, {}) === false) return;
        }
        var ed = document.getElementById('rv-editor-' + type);
        if (!ed) return;
        var acct = _rvCleanupAccount();
        var sel = document.getElementById('rv-cleanup-format-' + type);
        var btn = document.getElementById('rv-cleanup-btn-' + type);
        _rvCleanupBusy[type] = true;
        if (btn) btn.disabled = true;
        _rvCleanupMsg(type, 'Cleaning up…');
        return _noteCleanup(type, ed, sel && sel.value === 'paragraphs' ? 'paragraphs' : 'bullets').then(function(res) {
            _rvCleanupBusy[type] = false;
            var b = document.getElementById('rv-cleanup-btn-' + type);
            if (b) b.disabled = false;
            if (!res.ok) { _rvCleanupMsg(type, res.message, true); return; }
            // The period, account or page changed during the call (a re-render
            // replaces the editor): never write into another reflection.
            if (_st[type].periodKey !== key || _rvCleanupAccount() !== acct ||
                document.getElementById('rv-editor-' + type) !== ed) {
                _rvCleanupMsg(type, 'Cleanup discarded because the reflection changed. Try again.', true);
                return;
            }
            ed.insertAdjacentHTML('beforeend', res.block);
            _rvSaveDraft(type, key, ed.innerHTML);
            clearTimeout(_saveTimer);
            _saveTimer = null;
            if (doSave(type, key, {}) === false) {
                _rvCleanupMsg(type, 'Updated on another device; your version was kept as a conflict copy.', true);
                return;
            }
            _rvCleanupMsg(type, 'Cleaned-up version added below your reflection.' + (res.note ? ' ' + res.note : ''));
        });
    }

    function _rvUpdateAppendBtn(type) {
        var key = _st[type].periodKey;
        var ai = _rvGetAi(type, key);
        var btn = document.getElementById('rv-ai-append-' + type);
        if (!btn) return;
        if (ai && ai.text) {
            btn.style.display = '';
            if (ai.appendedAt) {
                btn.innerHTML = '✓ Appended';
                btn.title = 'Already appended. Click to append again.';
            } else {
                btn.innerHTML = 'Append to Reflection';
                btn.title = 'Copy AI analysis text into your Reflection editor';
            }
        } else {
            btn.style.display = 'none';
        }
    }

    function _rvRenderAiPanel(type) {
        var key = _st[type].periodKey;
        var ai = _rvGetAi(type, key);
        var bodyEl = document.getElementById('rv-ai-body-' + type);
        var footerEl = document.getElementById('rv-ai-footer-' + type);
        if (bodyEl && ai && ai.text) {
            bodyEl.textContent = ai.text;
        }
        if (footerEl && ai && ai.model) {
            footerEl.innerHTML = escH(ai.model) + ' \xb7 ' +
                ((ai.durationMs || 0) / 1000).toFixed(1) + 's' +
                (ai.generatedAt ? ' \xb7 ' + new Date(ai.generatedAt).toLocaleDateString() : '');
            footerEl.style.display = '';
        } else if (footerEl) {
            footerEl.style.display = 'none';
        }
        _rvUpdateAppendBtn(type);
    }

    // ── Main render ───────────────────────────────────────────────────────────
    function renderReviewPage(type) {
        var container = document.getElementById(type + '-review');
        if (!container) return;

        var st = _st[type];
        if (!st.periodKey) st.periodKey = defaultKey(type);
        var key      = st.periodKey;
        var trades   = tradesFor(type, key);
        var m        = calcMetrics(trades);
        var patterns = computePatterns(trades, type);
        var review   = curRev(type, key);
        var label    = periodLabel(type, key);
        var hasTrades = trades.length > 0;
        var nf       = review.nextFocus || blankRev(type).nextFocus;
        var isComplete = review.status === 'complete';

        // Date-picker input
        var pickerType = type==='daily'?'date': type==='weekly'?'week': type==='monthly'?'month':'number';
        var pickerVal  = keyToInputVal(type, key);
        var pickerAttrs = type==='yearly'
            ? 'type="number" min="2000" max="2099" value="'+pickerVal+'"'
            : 'type="'+pickerType+'" value="'+pickerVal+'"';

        // Title mapping
        var titles = { daily:'Daily Reflection', weekly:'Weekly Reflection', monthly:'Monthly Reflection', yearly:'Yearly Reflection' };
        var subtitles = {
            daily:   'Reflect on today\u2019s trades, surface patterns, and lock in your next action items.',
            weekly:  'Review the week\u2019s performance, identify key themes, and plan your focus for next week.',
            monthly: 'Step back and assess your month \u2014 what\u2019s working, what\u2019s not, and where to push next.',
            yearly:  'Your annual retrospective \u2014 measure growth, set goals, and chart the path forward.'
        };

        var html = '<div class="rv-workspace' + (isComplete ? ' rv-complete' : '') + '">';

        // ── Card Header ─────────────────────────────────────────────────────
        html += '<div class="rv-workspace-header">' +
            '<div class="rv-workspace-header-left">' +
                '<h3 class="rv-workspace-title">' + escH(titles[type] || 'Reflection') + '</h3>' +
                '<p class="rv-workspace-subtitle">' + (subtitles[type] || '') + '</p>' +
            '</div>' +
            '<div class="rv-workspace-header-right">' +
                '<span class="rv-save-status" id="rv-status-'+type+'"></span>' +
                (isComplete ? '<span class="rv-badge-complete">\u2713 Complete</span>' : '') +
                '<button class="btn btn-secondary btn-small" onclick="window._rvSave(\''+type+'\',\''+escH(key)+'\')">Save Draft</button>' +
                (isComplete
                    ? '<button class="btn btn-secondary btn-small" onclick="window._rvReopen(\''+type+'\',\''+escH(key)+'\')">Reopen</button>'
                    : '<button class="btn btn-primary btn-small" onclick="window._rvComplete(\''+type+'\',\''+escH(key)+'\')">Mark Complete</button>'
                ) +
            '</div>' +
        '</div>';

        // ── Period Navigation Bar ───────────────────────────────────────────
        html += '<div class="rv-period-bar">' +
            '<div class="review-period-nav">' +
                '<button class="btn btn-secondary btn-small review-nav-btn" onclick="window._rvStep(\''+type+'\',-1)">\u2039</button>' +
                '<div class="rv-period-wrap">' +
                    '<div class="review-period-label">'+escH(label)+'</div>' +
                    '<input class="rv-datepicker" '+pickerAttrs+' '+
                        'onchange="window._rvPickDate(\''+type+'\',this.value)" '+
                        'title="Jump to date">' +
                '</div>' +
                '<button class="btn btn-secondary btn-small review-nav-btn" onclick="window._rvStep(\''+type+'\',1)">\u203A</button>' +
            '</div>' +
            '<div class="rv-period-bar-right">' +
                '<button class="btn btn-secondary btn-small" onclick="window._rvToday(\''+type+'\')">Today</button>' +
                _rvPlanBtn(type, key) +
            '</div>' +
        '</div>';

        // ── Two-column body ─────────────────────────────────────────────────
        html += '<div class="rv-body">';

        // ── LEFT RAIL ──────────────────────────────────────────────────────
        html += '<div class="rv-rail">';

        // Snapshot
        html += buildSnapshot(type, m, trades, key);

        // Pattern Highlights
        var visP = patterns.filter(function(p) {
            return !review.hiddenPatterns || review.hiddenPatterns.indexOf(p.id) === -1;
        });
        var hiddenCount = patterns.length - visP.length;

        html += '<div class="rv-rail-section">' +
            '<div class="rv-rail-section-hdr">' +
                '<span class="rv-rail-section-title">Pattern Highlights' +
                    (m.count>0 && m.count<5 ? ' <span class="rv-data-note">(limited data)</span>' : '') +
                '</span>' +
                (hiddenCount > 0
                    ? '<button class="btn btn-secondary btn-small" style="font-size:10px;padding:2px 6px;" onclick="window._rvShowAllPatterns(\''+type+'\',\''+escH(key)+'\')">Show '+hiddenCount+' hidden</button>'
                    : '') +
            '</div>' +
            '<div class="rv-rail-section-body">';

        if (hasTrades && visP.length) {
            html += '<div class="review-patterns">';
            visP.forEach(function(p) {
                html += '<div class="review-pattern review-pattern-'+p.type+'" title="'+escH(p.tooltip||'')+'">' +
                    '<div class="review-pattern-icon">'+p.icon+'</div>' +
                    '<div class="review-pattern-body">' +
                        '<div class="review-pattern-title">'+escH(p.title)+'</div>' +
                        '<div class="review-pattern-detail">'+escH(p.detail)+'</div>' +
                    '</div>' +
                    '<button class="review-pattern-dismiss" title="Dismiss" ' +
                        'onclick="window._rvDismissPattern(\''+type+'\',\''+escH(key)+'\',\''+p.id+'\')">✕</button>' +
                '</div>';
            });
            html += '</div>';
        } else {
            html += '<div class="review-empty">' +
                '<div class="review-empty-text" style="font-size:12px;">' +
                (hasTrades ? 'No patterns detected yet.' :
                    (m.count < 1 ? 'No closed trades for this period.' : 'Need 3+ trades for patterns.')) +
                '</div></div>';
        }
        html += '</div></div>'; // rail-section-body + rail-section

        // AI Analysis Panel
        var ai = _rvGetAi(type, key);
        html += '<div class="rv-ai-panel">' +
            '<div class="rv-ai-panel-hdr">' +
                '<span class="rv-ai-panel-title">AI Analysis</span>' +
                '<div class="rv-ai-panel-actions">' +
                    '<button class="btn btn-secondary btn-small" id="rv-ai-append-'+type+'" style="font-size:10px;padding:2px 8px;display:none;" ' +
                        'onclick="window._rvAppendAI(\''+type+'\')">' +
                        (ai && ai.appendedAt ? '\u2713 Appended' : 'Append to Reflection') +
                    '</button>' +
                    '<button class="btn btn-primary btn-small" style="font-size:10px;padding:3px 10px;" ' +
                        'onclick="window._rvRunAI(\''+type+'\')">Run AI</button>' +
                '</div>' +
            '</div>' +
            '<div class="rv-ai-panel-body" id="rv-ai-body-'+type+'">' +
                (ai && ai.text ? escH(ai.text) : '') +
            '</div>' +
            '<div class="rv-ai-panel-footer" id="rv-ai-footer-'+type+'" style="' + (ai && ai.model ? '' : 'display:none;') + '">' +
                (ai && ai.model ? escH(ai.model) + ' \xb7 ' + ((ai.durationMs||0)/1000).toFixed(1) + 's' + (ai.generatedAt ? ' \xb7 ' + new Date(ai.generatedAt).toLocaleDateString() : '') : '') +
            '</div>' +
        '</div>';

        html += '</div>'; // rv-rail

        // ── RIGHT MAIN COLUMN ──────────────────────────────────────────────
        html += '<div class="rv-main">';

        // Reflection Editor
        var cleanupFmt = typeof _noteCleanupSavedFormat === 'function' ? _noteCleanupSavedFormat() : 'bullets';
        html += '<div class="review-section" style="flex:1;display:flex;flex-direction:column;">' +
            '<div class="review-section-hdr" style="flex-wrap:wrap;">' +
                '<h3 class="review-section-title">Reflection</h3>' +
                '<div class="cleanup-controls">' +
                '<span id="rv-cleanup-msg-'+type+'" style="font-size:12px;color:var(--text-secondary);"></span>' +
                '<select class="btn btn-secondary btn-small" id="rv-cleanup-format-'+type+'" data-note-cleanup-format title="Clean-up format" aria-label="Clean-up format" style="padding:8px 10px;" onchange="noteCleanupFormatChange(this.value)">' +
                    '<option value="bullets"' + (cleanupFmt === 'bullets' ? ' selected' : '') + '>Bullets</option>' +
                    '<option value="paragraphs"' + (cleanupFmt === 'paragraphs' ? ' selected' : '') + '>Paragraphs</option>' +
                '</select>' +
                '<button type="button" class="btn btn-secondary btn-small" id="rv-cleanup-btn-'+type+'" onclick="window._rvCleanUpAI(\''+type+'\')">Clean Up with AI</button>' +
                '</div>' +
            '</div>' +
            buildToolbar(type) +
            '<div class="rv-editor" id="rv-editor-'+type+'" contenteditable="true" spellcheck="true" style="flex:1;min-height:400px;">' +
                (review.content || '') +
            '</div>' +
        '</div>';

        // Next-Focus / Action Plan
        html += '<div class="review-section">' +
            '<div class="review-section-hdr"><h3 class="review-section-title">Next-Focus / Action Plan</h3></div>' +
            '<div class="rv-nf-grid">' +
                buildNfList(type, key, 'cont', nf.cont) +
                buildNfList(type, key, 'stop', nf.stop) +
                buildNfList(type, key, 'start', nf.start) +
            '</div>' +
        '</div>';

        html += '</div>'; // rv-main
        html += '</div>'; // rv-body
        html += '</div>'; // rv-workspace

        container.innerHTML = html;
        renderRvTemplateDropdown(type);

        // Setup snapshot drag-and-drop (active only when editMode is on)
        if (_rvSnap[type].editMode) setupRvSnapDrag(type);

        // Restore persisted AI panel state
        _rvRenderAiPanel(type);

        // Bind editor auto-save
        var editor = document.getElementById('rv-editor-' + type);
        if (editor) {
            // Restore any unsaved draft captured from a prior session
            // (reload, crash, power loss). Only restore if the draft is newer
            // than the last local database save for this exact review.
            var draft = _rvLoadDraft(type, key);
            if (draft && draft.content != null &&
                draft.ts > (review.updatedAt || 0) &&
                draft.content !== (review.content || '')) {
                editor.innerHTML = draft.content;
                showStatus(type, 'Restored unsaved draft');
            }
            editor.addEventListener('input', function() {
                // Synchronous localStorage write protects against reload/crash
                // in the debounce window before the local database is updated.
                _rvSaveDraft(type, key, editor.innerHTML);
                showStatus(type, 'Unsaved changes', 'unsaved');
                clearTimeout(_saveTimer);
                _saveTimer = setTimeout(function() { doSave(type, key, {}); }, 1400);
            });
            if (typeof EditorToolbar !== 'undefined') {
                EditorToolbar.bindPasteResize('rv-editor-' + type);
                EditorToolbar.bindImagePopout('rv-editor-' + type);
            }
        }
        _rvGuardOpen(type, key);

    }

    // ── Toolbar action helpers ────────────────────────────────────────────────
    function _rvSaveSel() {
        var sel = window.getSelection();
        _savedRange = (sel && sel.rangeCount > 0) ? sel.getRangeAt(0).cloneRange() : null;
    }

    function _restoreSel() {
        if (!_savedRange) return;
        var sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(_savedRange);
    }

    function _rvApplyFore(color, type) {
        _restoreSel();
        document.execCommand('foreColor', false, color);
        var lbl = document.getElementById('rv-forebg-' + type);
        if (lbl) lbl.style.color = color;
    }

    function _rvApplyHilite(color) {
        _restoreSel();
        document.execCommand('hiliteColor', false, color) ||
        document.execCommand('backColor', false, color);
    }

    async function _rvInsertLink() {
        _restoreSel();
        var url = await window.showPromptModal({ message: 'Enter URL:', defaultValue: 'https://' });
        if (url && url.trim()) document.execCommand('createLink', false, url.trim());
    }

    function _rvInsertPrompts(type) {
        var ed = document.getElementById('rv-editor-' + type);
        if (!ed) return;
        var html = (PROMPTS[type]||[]).map(function(p) {
            return '<h3>'+escH(p)+'</h3><p><br></p>';
        }).join('');
        ed.focus();
        document.execCommand('insertHTML', false, html);
    }

    // ── Template dropdown ─────────────────────────────────────────────────────
    // Populates the template select for a given review type using its context as
    // the timeframe filter.  type ('daily'|'weekly'|'monthly'|'yearly') maps
    // directly to the timeframe value stored on each template.
    // Legacy templates with an empty timeframes array appear in all contexts.
    function renderRvTemplateDropdown(type) {
        var sel = document.getElementById('rv-template-select-' + type);
        if (!sel) return;
        var all = journalData.noteTemplates || [];
        var matches = [];
        for (var i = 0; i < all.length; i++) {
            var t = all[i];
            if (!t.isFavorite) continue;
            var tfs = Array.isArray(t.timeframes) ? t.timeframes : [];
            if (tfs.length === 0 || tfs.indexOf(type) !== -1) matches.push(t);
        }
        matches.sort(function(a, b) {
            return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' });
        });
        sel.innerHTML = '<option value="">Template\u2026</option>' +
            matches.map(function(t) {
                return '<option value="' + t.id + '">' + escH(t.name) + '</option>';
            }).join('');
    }

    function _rvApplyTemplate(type, id) {
        if (!id) return;
        var tmpl = null;
        var all = journalData.noteTemplates || [];
        for (var i = 0; i < all.length; i++) {
            if (String(all[i].id) === String(id)) { tmpl = all[i]; break; }   // id may be a string or number
        }
        if (!tmpl) return;
        var ed = document.getElementById('rv-editor-' + type);
        if (!ed) return;

        // Convert template content to HTML (mirror Trade journal behavior)
        var tmplHtml;
        if (!/<[a-z][\s\S]*>/i.test(tmpl.content)) {
            tmplHtml = (tmpl.content || '').split('\n\n').map(function(p) {
                return p.trim() ? '<p>' + p.replace(/\n/g, '<br>') + '</p>' : '<p><br></p>';
            }).join('');
        } else {
            tmplHtml = tmpl.content;
        }

        var current = ed.innerHTML.trim();
        var isEmpty = (!current || current === '<br>' || current === '<p><br></p>');

        if (isEmpty) {
            // Empty reflection → insert cleanly, no separator / no date header.
            ed.innerHTML = tmplHtml;
        } else {
            // Append to existing content, prepending a separator + session date.
            // Only one date header per journaling session: reuse r.sessionHeaderDate
            // if already set, otherwise capture today's date for this session.
            var key = _st[type].periodKey;
            var r = curRev(type, key);
            if (!r.sessionHeaderDate) {
                r.sessionHeaderDate = _rvFormatSessionDate(new Date());
                saveRev(type, key, r);
            }
            var sep = '------------------------------------------------------------------------------------------------';
            var appendedHtml =
                '<p><br></p>' +
                '<p>' + sep + '</p>' +
                '<p>' + escH(r.sessionHeaderDate) + '</p>' +
                tmplHtml;
            ed.innerHTML = ed.innerHTML + appendedHtml;
        }
        ed.focus();
        // Persist immediately — both to the local database (via debounced doSave) and to
        // the localStorage draft backup so the template insertion is recoverable.
        _rvSaveDraft(type, _st[type].periodKey, ed.innerHTML);
        clearTimeout(_saveTimer);
        _saveTimer = setTimeout(function() { doSave(type, _st[type].periodKey, {}); }, 400);
    }

    // ── Date picker ───────────────────────────────────────────────────────────
    function _rvPickDate(type, val) {
        if (!val) return;
        doSave(type, _st[type].periodKey, {});
        // Convert native input value to our internal key
        if (type === 'yearly') {
            _st[type].periodKey = String(parseInt(val));
        } else if (type === 'weekly') {
            // Browser gives YYYY-WNN (may be YYYY-W1 or YYYY-W01)
            var parts = val.split('-W');
            if (parts.length === 2) {
                _st[type].periodKey = parts[0] + '-W' + pad(parseInt(parts[1]));
            }
        } else {
            _st[type].periodKey = val;
        }
        renderReviewPage(type);
    }

    // ── Period navigation ─────────────────────────────────────────────────────
    function _rvStep(type, dir) {
        doSave(type, _st[type].periodKey, {});
        _st[type].periodKey = stepKey(type, _st[type].periodKey, dir);
        renderReviewPage(type);
    }

    function _rvToday(type) {
        doSave(type, _st[type].periodKey, {});
        _st[type].periodKey = defaultKey(type);
        renderReviewPage(type);
    }

    // ── Pattern actions ───────────────────────────────────────────────────────
    function _rvDismissPattern(type, key, pid) {
        var r = curRev(type, key);
        var s = captureState(type);
        if (s.content !== null) r.content = s.content;
        r.nextFocus = s.nextFocus;
        if (!r.hiddenPatterns) r.hiddenPatterns = [];
        if (r.hiddenPatterns.indexOf(pid) === -1) r.hiddenPatterns.push(pid);
        r.updatedAt = Date.now();
        saveRev(type, key, r);
        renderReviewPage(type);
    }

    function _rvShowAllPatterns(type, key) {
        var r = curRev(type, key);
        var s = captureState(type);
        if (s.content !== null) r.content = s.content;
        r.nextFocus = s.nextFocus;
        r.hiddenPatterns = [];
        r.updatedAt = Date.now();
        saveRev(type, key, r);
        renderReviewPage(type);
    }

    // ── Snapshot layout actions ───────────────────────────────────────────────
    function _rvSnapEdit(type) {
        _rvSnap[type].editMode = !_rvSnap[type].editMode;
        renderReviewPage(type);
    }

    function _rvSnapRemove(type, id) {
        var layout = _rvSnap[type].layout;
        if (!layout) return;
        var idx = layout.indexOf(id);
        if (idx !== -1) layout.splice(idx, 1);
        rvSnapSaveLayout(type);
        renderReviewPage(type);
    }

    function _rvSnapAdd(type, id) {
        var snap = _rvSnap[type];
        if (!snap.layout) snap.layout = RV_SNAP_DEFAULT[type].slice();
        if (snap.layout.indexOf(id) === -1) snap.layout.push(id);
        rvSnapSaveLayout(type);
        _rvSnapClosePicker(type);
        renderReviewPage(type);
    }

    function _rvSnapReset(type) {
        _rvSnap[type].layout = RV_SNAP_DEFAULT[type].slice();
        rvSnapSaveLayout(type);
        renderReviewPage(type);
    }

    function _rvSnapOpenPicker(type) {
        var panel = document.getElementById('rv-snap-picker-' + type);
        if (panel) panel.style.display = 'block';
    }

    function _rvSnapClosePicker(type) {
        var panel = document.getElementById('rv-snap-picker-' + type);
        if (panel) panel.style.display = 'none';
    }

    // ── Widget actions ────────────────────────────────────────────────────────
    function _rvToggleWidgetPicker(type) {
        var picker = document.getElementById('rv-wpicker-' + type);
        if (picker) picker.style.display = picker.style.display === 'none' ? 'block' : 'none';
    }

    function _rvToggleWidget(type, key, wid) {
        var r = curRev(type, key);
        var s = captureState(type);
        if (s.content !== null) r.content = s.content;
        r.nextFocus = s.nextFocus;
        var ws = r.widgets || DEFAULT_WIDGETS[type].slice();
        var idx = ws.indexOf(wid);
        if (idx === -1) ws.push(wid); else ws.splice(idx, 1);
        r.widgets = ws;
        r.updatedAt = Date.now();
        saveRev(type, key, r);
        renderReviewPage(type);
    }

    function _rvRemoveWidget(type, key, wid) {
        var r = curRev(type, key);
        var s = captureState(type);
        if (s.content !== null) r.content = s.content;
        r.nextFocus = s.nextFocus;
        var ws = r.widgets || DEFAULT_WIDGETS[type].slice();
        var idx = ws.indexOf(wid);
        if (idx !== -1) ws.splice(idx, 1);
        r.widgets = ws;
        r.updatedAt = Date.now();
        saveRev(type, key, r);
        renderReviewPage(type);
    }

    // ── Next-Focus actions ────────────────────────────────────────────────────
    async function _rvNfAdd(type, key, cat) {
        if (_rvStaleSave(type, key)) return;
        var text = await window.showPromptModal({ message: 'New item:' });
        if (!text || !text.trim()) return;
        var r = curRev(type, key);
        var s = captureState(type);
        if (s.content !== null) r.content = s.content;
        r.nextFocus = s.nextFocus;
        if (!r.nextFocus[cat]) r.nextFocus[cat] = [];
        r.nextFocus[cat].push({ text: text.trim(), done: false });
        r.updatedAt = Date.now();
        saveRev(type, key, r);
        renderReviewPage(type);
    }

    function _rvNfToggle(type, key, cat, idx, done) {
        if (_rvStaleSave(type, key)) return;
        var r = curRev(type, key);
        var s = captureState(type);
        if (s.content !== null) r.content = s.content;
        r.nextFocus = s.nextFocus;
        if (r.nextFocus[cat] && r.nextFocus[cat][idx]) r.nextFocus[cat][idx].done = done;
        r.updatedAt = Date.now();
        saveRev(type, key, r);
        var label = document.querySelector('.rv-nf-item[data-cat="'+cat+'"][data-type="'+type+'"][data-i="'+idx+'"] .rv-nf-label');
        if (label) label.className = 'rv-nf-label' + (done?' rv-done':'');
    }

    function _rvNfRemove(type, key, cat, idx) {
        if (_rvStaleSave(type, key)) return;
        var r = curRev(type, key);
        var s = captureState(type);
        if (s.content !== null) r.content = s.content;
        r.nextFocus = s.nextFocus;
        if (r.nextFocus[cat]) r.nextFocus[cat].splice(idx, 1);
        r.updatedAt = Date.now();
        saveRev(type, key, r);
        renderReviewPage(type);
    }

    // ── Save / Complete / Reopen ──────────────────────────────────────────────
    function _rvSave(type, key)     { doSave(type, key, {}); }
    function _rvComplete(type, key) { doSave(type, key, { status: 'complete' }); }
    function _rvReopen(type, key)   { doSave(type, key, { status: 'draft' }); }

    // ── Planner context modal ────────────────────────────────────────────────
    function _rvGetPlannerData(type, key) {
        if (!journalData) return null;
        if (type === 'daily') {
            return (journalData.dailyPlanners || {})['dp|' + key] || null;
        }
        if (type === 'weekly') {
            return (journalData.weeklyPlanners || {})['wp|' + key] || null;
        }
        return null;
    }

    function _rvPlanBtn(type, key) {
        if (type !== 'daily' && type !== 'weekly') return '';
        var plan = _rvGetPlannerData(type, key);
        if (!plan) return '';
        var label = type === 'daily' ? 'View Daily Plan' : 'View Weekly Plan';
        return '<button class="btn btn-secondary btn-small" ' +
            'onclick="window._rvViewPlan(\'' + type + '\')" ' +
            'style="margin-left:4px;">' + label + '</button>';
    }

    function _rvBfReadonly(bf) {
        if (!bf) return '';
        var cats = [
            { key: 'cont',  label: 'Continue', cls: 'rv-nf-continue' },
            { key: 'stop',  label: 'Stop',     cls: 'rv-nf-stop' },
            { key: 'focus', label: 'Focus',     cls: 'rv-nf-start' }
        ];
        var hasAny = false;
        cats.forEach(function(c) { if (bf[c.key] && bf[c.key].length) hasAny = true; });
        if (!hasAny) return '';
        var html = '<div class="plan-ctx-section"><div class="plan-ctx-label">Behavioral Focus</div>' +
            '<div class="plan-ctx-bf-grid">';
        cats.forEach(function(c) {
            var items = bf[c.key] || [];
            if (!items.length) return;
            html += '<div class="plan-ctx-bf-col ' + c.cls + '">' +
                '<div class="plan-ctx-bf-col-hdr">' + c.label + '</div>';
            items.forEach(function(item) {
                html += '<div class="plan-ctx-bf-item">' +
                    '<span class="plan-ctx-bf-check">' + (item.done ? '\u2713' : '\u2013') + '</span>' +
                    '<span class="' + (item.done ? 'rv-done' : '') + '">' + escH(item.text) + '</span>' +
                '</div>';
            });
            html += '</div>';
        });
        html += '</div></div>';
        return html;
    }

    function _rvBuildPlanModal(type) {
        var st = _st[type];
        if (!st) return;
        var key = st.periodKey;
        var plan = _rvGetPlannerData(type, key);
        if (!plan) return;
        var body = document.getElementById('plan-ctx-modal-body');
        if (!body) return;

        var label = periodLabel(type, key);
        var title = type === 'daily' ? 'Daily Plan' : 'Weekly Plan';
        var navSection = type === 'daily' ? 'daily-planner' : 'weekly-planner';

        var html = '<div class="plan-ctx-header">' +
            '<h2 class="plan-ctx-title">' + escH(title) + ' \u2014 ' + escH(label) + '</h2>' +
            '<button type="button" class="btn btn-secondary btn-small" onclick="closeModal(\'plan-ctx-modal\')">Close</button>' +
        '</div>';

        // Structured fields
        if (type === 'daily') {
            if (plan.bias)      html += '<div class="plan-ctx-field"><span class="plan-ctx-label">Market Bias</span><span class="plan-ctx-value">' + escH(plan.bias) + '</span></div>';
            if (plan.keyEvents) html += '<div class="plan-ctx-field"><span class="plan-ctx-label">Key Events</span><span class="plan-ctx-value">' + escH(plan.keyEvents) + '</span></div>';
            if (plan.watchlist) html += '<div class="plan-ctx-field"><span class="plan-ctx-label">Watchlist</span><span class="plan-ctx-value">' + escH(plan.watchlist) + '</span></div>';
        } else {
            if (plan.condition)    html += '<div class="plan-ctx-field"><span class="plan-ctx-label">Market Condition</span><span class="plan-ctx-value">' + escH(plan.condition) + '</span></div>';
            if (plan.expectedNext) html += '<div class="plan-ctx-field"><span class="plan-ctx-label">Expected Next Week</span><span class="plan-ctx-value">' + escH(plan.expectedNext) + '</span></div>';
            if (plan.keyEvents)    html += '<div class="plan-ctx-field"><span class="plan-ctx-label">Key Events</span><span class="plan-ctx-value">' + escH(plan.keyEvents) + '</span></div>';
            if (plan.keyGuides)    html += '<div class="plan-ctx-field"><span class="plan-ctx-label">Key Guides</span><span class="plan-ctx-value">' + escH(plan.keyGuides) + '</span></div>';
        }

        // Plan text
        if (plan.content) {
            html += '<div class="plan-ctx-section">' +
                '<div class="plan-ctx-label">Plan</div>' +
                '<div class="plan-ctx-plan-text">' + plan.content + '</div>' +
            '</div>';
        }

        // Behavioral focus
        html += _rvBfReadonly(plan.behavioral);

        // Saved planner AI analysis (read-only, no new AI call)
        if (plan.aiAnalysis && plan.aiAnalysis.text) {
            html += '<div class="plan-ctx-section">' +
                '<div class="plan-ctx-label">AI Analysis</div>' +
                '<div class="plan-ctx-ai-text">' + escH(plan.aiAnalysis.text) + '</div>';
            if (plan.aiAnalysis.model) {
                html += '<div class="plan-ctx-ai-meta">' +
                    escH(plan.aiAnalysis.model) +
                    (plan.aiAnalysis.durationMs ? ' \xb7 ' + (plan.aiAnalysis.durationMs / 1000).toFixed(1) + 's' : '') +
                '</div>';
            }
            html += '</div>';
        }

        // Open in Planner link
        html += '<div class="plan-ctx-footer">' +
            '<a href="#" class="plan-ctx-open-link" onclick="window._rvOpenPlanner(\'' + type + '\',\'' + escH(key) + '\');return false;">Open in Planner \u2192</a>' +
        '</div>';

        body.innerHTML = html;
        openModal('plan-ctx-modal');
    }

    function _rvViewPlan(type) {
        // Clear stale content before building to prevent flash of old data
        var body = document.getElementById('plan-ctx-modal-body');
        if (body) body.innerHTML = '';
        _rvBuildPlanModal(type);
    }

    function _rvOpenPlanner(type, key) {
        closeModal('plan-ctx-modal');
        if (type === 'daily') {
            activateSection('daily-planner');
            // Sync planner to the matching date after navigation renders it
            setTimeout(function() {
                if (typeof dpPickDate === 'function') dpPickDate(key);
            }, 0);
        } else if (type === 'weekly') {
            activateSection('weekly-planner');
            setTimeout(function() {
                if (typeof wpPickWeek === 'function') wpPickWeek(key);
            }, 0);
        }
    }

    // ── Init ──────────────────────────────────────────────────────────────────
    function initDailyReview()   { renderReviewPage('daily');   }
    function initWeeklyReview()  { renderReviewPage('weekly');  }
    function initMonthlyReview() { renderReviewPage('monthly'); }
    function initYearlyReview()  { renderReviewPage('yearly');  }

    // ── Window exposures ──────────────────────────────────────────────────────
    window.initDailyReview    = initDailyReview;
    window.initWeeklyReview   = initWeeklyReview;
    window.initMonthlyReview  = initMonthlyReview;
    window.initYearlyReview   = initYearlyReview;

    window._rvStep            = _rvStep;
    window._rvToday           = _rvToday;
    window._rvPickDate        = _rvPickDate;
    window._rvInsertPrompts   = _rvInsertPrompts;
    window._rvSaveSel         = _rvSaveSel;
    window._rvApplyFore       = _rvApplyFore;
    window._rvApplyHilite     = _rvApplyHilite;
    window._rvInsertLink      = _rvInsertLink;
    window._rvDismissPattern  = _rvDismissPattern;
    window._rvShowAllPatterns = _rvShowAllPatterns;
    window._rvSnapEdit        = _rvSnapEdit;
    window._rvSnapRemove      = _rvSnapRemove;
    window._rvSnapAdd         = _rvSnapAdd;
    window._rvSnapReset       = _rvSnapReset;
    window._rvSnapOpenPicker  = _rvSnapOpenPicker;
    window._rvSnapClosePicker = _rvSnapClosePicker;
    window._rvToggleWidgetPicker = _rvToggleWidgetPicker;
    window._rvToggleWidget    = _rvToggleWidget;
    window._rvRemoveWidget    = _rvRemoveWidget;
    window._rvNfAdd           = _rvNfAdd;
    window._rvNfToggle        = _rvNfToggle;
    window._rvNfRemove        = _rvNfRemove;
    window._rvSave            = _rvSave;
    window._rvComplete        = _rvComplete;
    window._rvReopen          = _rvReopen;
    window._rvRunAI           = _rvRunAI;
    window._rvAppendAI        = _rvAppendAI;
    window._rvCleanUpAI       = _rvCleanUpAI;
    window._rvViewPlan        = _rvViewPlan;
    window._rvOpenPlanner     = _rvOpenPlanner;
    window.renderRvTemplateDropdown = renderRvTemplateDropdown;
    window._rvApplyTemplate   = _rvApplyTemplate;

    // Expose review state for Journal AI module
    window._rvGetState      = function(type) { return _st[type]; };
    window._rvGetReview     = function(type, key) { return curRev(type, key); };
    window._rvGetTrades     = function(type, key) { return tradesFor(type, key); };
    window._rvCalcMetrics   = function(trades) { return calcMetrics(trades); };
    window._rvPeriodLabel   = function(type, key) { return periodLabel(type, key); };
    window._rvSaveAi        = _rvSaveAi;
    window._rvRenderAiPanel = _rvRenderAiPanel;
    window._rvGetAllKeys    = function(type) {
        var keys = [];
        var revs = (journalData && journalData.reviews) ? journalData.reviews : {};
        var prefix = type + '|';
        Object.keys(revs).forEach(function(k) {
            if (k.indexOf(prefix) === 0) keys.push(k.slice(prefix.length));
        });
        return keys.sort();
    };

}());
