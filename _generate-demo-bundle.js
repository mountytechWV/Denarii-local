#!/usr/bin/env node
// ── One-time generator: produces js/demo-bundle.js ──────────────────
// Run: node _generate-demo-bundle.js
// This script sources the deterministic demo builders and serializes
// their output into a static JS file. Safe to delete after use.

const fs = require('fs');
const path = require('path');

// ── Load source files as text and eval in this context ──────────────
// demoSeed.js defines: DEMO_BROKER_ID, _makePRNG, _buildDemoBrokerData,
//   _buildDemoReviews, _buildDemoPlanners, _backfillDemoRuleAdherence, etc.
const demoSeedSrc = fs.readFileSync(path.join(__dirname, 'js', 'demoSeed.js'), 'utf8');

// getDemoStrategySeedList is inside Denarii.js — extract just that function.
// We'll define it manually to avoid evaling the entire 10K-line file.

// ── getDemoStrategySeedList (copied from Denarii.js) ────────────────
function getDemoStrategySeedList() {
    var _si = 0;
    function _r(id, text, mandatory, stars, showWhen) {
        return { id: id, text: text, isMandatory: !!mandatory, stars: stars, showWhen: showWhen || 'always' };
    }
    function _g(si, gi, name, rules) { return { id: si * 100 + gi, name: name, rules: rules }; }
    function _strat(name, color, groups) {
        _si++;
        return {
            id: 1000000 + _si, name: name, description: '', color: color,
            groups: groups, created: '2024-07-01T09:30:00.000Z', updated: '2024-07-01T09:30:00.000Z',
            isDemoSeed: true, createdBy: 'System', isFavorite: true,
            ruleVersion: 1
        };
    }
    _si = 0;
    return [
        _strat('Support Bounce', '#3b82f6', [
            _g(1,1,'Market Context', [_r(10101,'Bounce is occurring at a clear support level',true,3),_r(10102,'Support aligns with higher timeframe level or prior key level',false,2),_r(10103,'Market is not aggressively trending against the setup',false,2)]),
            _g(1,2,'Entry Criteria', [_r(10201,'Price shows clear rejection at support',true,3),_r(10202,'Buyers step in with confirmation candle / reclaim',true,3),_r(10203,'Entry is close enough to support to keep risk tight',true,3),_r(10204,'Volume improves on the bounce',false,2)]),
            _g(1,3,'Risk / Invalidation', [_r(10301,'Stop is below support / rejection low',true,3),_r(10302,'Trade is avoided if support has already been tested too many times',false,2)]),
            _g(1,4,'Management / Exit', [_r(10401,'Take partial into first resistance / VWAP / EMA reclaim',false,2,'winner'),_r(10402,'Exit quickly if support breaks after entry',true,3,'loser'),_r(10403,'Let runner work only if reclaim holds cleanly',false,2)])
        ]),
        _strat('VWAP Reclaim', '#10b981', [
            _g(2,1,'Market Context', [_r(20101,'VWAP is acting as a meaningful intraday pivot',true,3),_r(20102,'Price has spent time below VWAP before reclaim attempt',false,2),_r(20103,'Setup has space to next resistance after reclaim',false,2)]),
            _g(2,2,'Entry Criteria', [_r(20201,'Price reclaims VWAP with conviction',true,3),_r(20202,'Candle closes or confirms above VWAP',true,3),_r(20203,'Volume supports reclaim',true,2),_r(20204,'Entry is not too extended above VWAP',true,3)]),
            _g(2,3,'Risk / Invalidation', [_r(20301,'Stop is below VWAP or reclaim candle low',true,3),_r(20302,'Avoid if reclaim happens into major resistance overhead',false,2)]),
            _g(2,4,'Management / Exit', [_r(20401,'Partial at first push away from VWAP',false,2,'winner'),_r(20402,'Exit if price loses VWAP again',true,3,'loser'),_r(20403,'Hold only while VWAP stays supportive',false,2)])
        ]),
        _strat('Trend Continuation', '#f59e0b', [
            _g(3,1,'Market Context', [_r(30101,'Trend is already established before entry',true,3),_r(30102,'Higher timeframe supports trend direction',false,2),_r(30103,'No major opposing resistance/support is too close',false,2)]),
            _g(3,2,'Entry Criteria', [_r(30201,'Pullback or consolidation forms within the trend',true,3),_r(30202,'Entry occurs on continuation break/reclaim',true,3),_r(30203,'Trend EMAs / structure remain intact',true,3),_r(30204,'Volume confirms continuation',false,2)]),
            _g(3,3,'Risk / Invalidation', [_r(30301,'Stop is below pullback low / above pullback high depending direction',true,3),_r(30302,'Avoid if continuation entry is too extended',true,2)]),
            _g(3,4,'Management / Exit', [_r(30401,'Partial into next expansion leg',false,2,'winner'),_r(30402,'Exit if trend structure breaks',true,3,'loser'),_r(30403,'Hold runner while higher lows / lower highs continue',false,2)])
        ]),
        _strat('Reversal', '#ef4444', [
            _g(4,1,'Market Context', [_r(40101,'Setup is occurring at an obvious exhaustion or key level',true,3),_r(40102,'Price is extended into the reversal area',false,2),_r(40103,'There is room for the reversal move back the other way',true,2)]),
            _g(4,2,'Entry Criteria', [_r(40201,'Reversal candle or reclaim/break confirms turn',true,3),_r(40202,'Entry waits for confirmation, not blind guessing',true,3),_r(40203,'Volume or momentum shifts in favor of reversal',false,2)]),
            _g(4,3,'Risk / Invalidation', [_r(40301,'Stop is beyond the extreme high/low of reversal zone',true,3),_r(40302,'Avoid if trying to reverse a very strong trend with no signal',true,3)]),
            _g(4,4,'Management / Exit', [_r(40401,'Take first partial into nearest reclaim area',false,2,'winner'),_r(40402,'Exit fast if reversal confirmation fails',true,3,'loser'),_r(40403,'Be quicker with profits than in continuation setups',false,2)])
        ]),
        _strat('Earnings Play', '#8b5cf6', [
            _g(5,1,'Market Context', [_r(50101,'Earnings catalyst is the reason for the move',true,3),_r(50102,'Stock has elevated volume/liquidity',true,3),_r(50103,'Spread and options/liquidity are acceptable if trading options',true,3),_r(50104,'Daily chart has clean post-earnings space',false,2)]),
            _g(5,2,'Entry Criteria', [_r(50201,'Entry follows clear post-earnings structure, not random volatility',true,3),_r(50202,'Direction is confirmed by price action, not headline bias',true,3),_r(50203,'Entry is on breakout, reclaim, or pullback with structure',true,3)]),
            _g(5,3,'Risk / Invalidation', [_r(50301,'Risk is reduced because of elevated volatility',true,3),_r(50302,'Avoid oversized position due to event volatility',true,3),_r(50303,'Stop is based on structure, not hope',true,3)]),
            _g(5,4,'Management / Exit', [_r(50401,'Take profits faster than usual if move becomes unstable',false,2),_r(50402,'Exit if post-earnings trend loses structure',true,3,'loser'),_r(50403,'Do not overstay once the first clean move is done',false,2)])
        ]),
        _strat('Failed Breakout', '#ec4899', [
            _g(6,1,'Market Context', [_r(60101,'Price attempts breakout through a clear level',true,3),_r(60102,'Breakout level is meaningful on chart',true,3),_r(60103,'Move is extended enough to trap late entries',false,2)]),
            _g(6,2,'Entry Criteria', [_r(60201,'Breakout fails and price comes back below the level',true,3),_r(60202,'Reclaim failure is confirmed, not just one wick',true,3),_r(60203,'Entry is close to the failed level for tight risk',true,3),_r(60204,'Volume fades or rejection volume appears',false,2)]),
            _g(6,3,'Risk / Invalidation', [_r(60301,'Stop is above failed breakout high / reclaim area',true,3),_r(60302,'Avoid if price immediately reclaims breakout level again',true,3)]),
            _g(6,4,'Management / Exit', [_r(60401,'Partial into first flush away from the level',false,2,'winner'),_r(60402,'Exit if failed breakout thesis is invalidated by reclaim',true,3,'loser'),_r(60403,'Hold remainder only if lower highs continue',false,2)])
        ]),
        _strat('Double Bottom', '#3b82f6', [
            _g(7,1,'Market Context', [_r(70101,'Second test occurs near prior low',true,3),_r(70102,'Support area is clear and meaningful',true,3),_r(70103,'There is room back toward resistance / neckline',false,2)]),
            _g(7,2,'Entry Criteria', [_r(70201,'Second bottom holds without breaking down',true,3),_r(70202,'Entry is on reclaim / neckline break / confirmation candle',true,3),_r(70203,'Buyers show clear defense on retest',false,2)]),
            _g(7,3,'Risk / Invalidation', [_r(70301,'Stop is below the double bottom low / support zone',true,3),_r(70302,'Avoid if second bottom is too sloppy or undercuts too deeply',false,2)]),
            _g(7,4,'Management / Exit', [_r(70401,'Partial into neckline / first resistance',false,2,'winner'),_r(70402,'Exit if support fails after entry',true,3,'loser'),_r(70403,'Hold only if breakout from neckline confirms',false,2)])
        ]),
        _strat('Gap Fill', '#10b981', [
            _g(8,1,'Market Context', [_r(80101,'There is a clear gap to fill from prior session',true,3),_r(80102,'Price has realistic room to reach fill target',true,2),_r(80103,'Market conditions support mean reversion or continuation toward fill',false,2)]),
            _g(8,2,'Entry Criteria', [_r(80201,'Entry aligns with direction of the expected fill',true,3),_r(80202,'Price structure confirms move toward gap fill',true,3),_r(80203,'Entry is not taken too close to full fill target',true,2)]),
            _g(8,3,'Risk / Invalidation', [_r(80301,'Stop is based on structure opposing the fill thesis',true,3),_r(80302,'Avoid chasing after most of the fill is already done',true,2)]),
            _g(8,4,'Management / Exit', [_r(80401,'Partial before full gap fill if momentum stalls',false,2,'winner'),_r(80402,'Exit if structure breaks against fill thesis',true,3,'loser'),_r(80403,'Reduce size as fill target gets close',false,1)])
        ]),
        _strat('Pullback to EMA', '#f59e0b', [
            _g(9,1,'Market Context', [_r(90101,'Stock is trending cleanly before pullback',true,3),_r(90102,'EMA being used is acting as dynamic support/resistance',true,3),_r(90103,'Higher timeframe still supports direction',false,2)]),
            _g(9,2,'Entry Criteria', [_r(90201,'Price pulls back into EMA, not far through it',true,3),_r(90202,'EMA holds and price confirms continuation',true,3),_r(90203,'Entry is near EMA for favorable risk',true,3),_r(90204,'Volume or candle quality supports bounce/reject',false,2)]),
            _g(9,3,'Risk / Invalidation', [_r(90301,'Stop is beyond EMA rejection low/high or local structure',true,3),_r(90302,'Avoid if EMA has already failed multiple times',false,2)]),
            _g(9,4,'Management / Exit', [_r(90401,'Partial on push back into trend expansion',false,2,'winner'),_r(90402,'Exit if EMA loses its role and trend breaks',true,3,'loser'),_r(90403,'Hold runner only while trend remains clean',false,2)])
        ]),
        _strat('Opening Range Break', '#ef4444', [
            _g(10,1,'Market Context', [_r(100101,'Opening range is clearly defined',true,3),_r(100102,'Market/open conditions are active enough for ORB',true,2),_r(100103,'Break has room beyond the range',true,2)]),
            _g(10,2,'Entry Criteria', [_r(100201,'Price breaks opening range high/low with confirmation',true,3),_r(100202,'Volume expands on the break',true,3),_r(100203,'Entry is not badly extended beyond the range',true,3),_r(100204,'Break aligns with overall intraday direction',false,2)]),
            _g(10,3,'Risk / Invalidation', [_r(100301,'Stop is on the opposite side of the break structure or inside range',true,3),_r(100302,'Avoid breakout if range is already too wide for acceptable risk',false,2)]),
            _g(10,4,'Management / Exit', [_r(100401,'Partial on first range expansion move',false,2,'winner'),_r(100402,'Exit if price falls back into range and fails',true,3,'loser'),_r(100403,'Hold only while price stays outside the range',false,2)])
        ]),
        _strat('Breakout', '#8b5cf6', [
            _g(11,1,'Market Context', [_r(110101,'Breakout level is clear and meaningful',true,3),_r(110102,'Stock has room above the breakout',true,3),_r(110103,'Consolidation/build-up exists before the break',false,2)]),
            _g(11,2,'Entry Criteria', [_r(110201,'Price breaks key level with confirmation',true,3),_r(110202,'Volume confirms breakout',true,3),_r(110203,'Entry is not too extended from breakout level',true,3),_r(110204,'Breakout occurs from a tight base / clean structure',false,2)]),
            _g(11,3,'Risk / Invalidation', [_r(110301,'Stop is below breakout level / base low',true,3),_r(110302,'Avoid if breakout immediately stalls into resistance',false,2)]),
            _g(11,4,'Management / Exit', [_r(110401,'Partial into first expansion',false,2,'winner'),_r(110402,'Exit if breakout fails and re-enters base',true,3,'loser'),_r(110403,'Hold remainder only if breakout level holds on retest',false,2)])
        ]),
        _strat('Gap N Go', '#ec4899', [
            _g(12,1,'Market Context', [_r(120101,'Stock has meaningful gap up from prior close',true,3),_r(120102,'Pre-market volume is elevated / active',true,3),_r(120103,'Pre-market structure is clean, not chaotic',false,2),_r(120104,'Daily chart has room above / no nearby major resistance',false,2)]),
            _g(12,2,'Entry Criteria', [_r(120201,'Price breaks pre-market high with intent',true,3),_r(120202,'Break occurs near open with strong momentum',true,3),_r(120203,'Volume expands on the break',true,3),_r(120204,'Entry is not badly extended from the break level',true,3)]),
            _g(12,3,'Risk / Invalidation', [_r(120301,'Risk is defined before entry',true,3),_r(120302,'Stop is below valid intraday structure / PMH reclaim level',true,3),_r(120303,'Avoid entry if candle is too extended after breakout',false,2)]),
            _g(12,4,'Management / Exit', [_r(120401,'Partial into first expansion',false,2,'winner'),_r(120402,'Exit if PMH breakout fails quickly',true,3,'loser'),_r(120403,'Hold remainder only while momentum and volume stay intact',false,2)])
        ]),
        _strat('Bull Flag', '#3b82f6', [
            _g(13,1,'Market Context', [_r(130101,'Strong impulse leg exists before the flag',true,3),_r(130102,'Flag is orderly, not choppy breakdown',true,3),_r(130103,'Trend context supports continuation',true,2)]),
            _g(13,2,'Entry Criteria', [_r(130201,'Entry is on flag break or clean reclaim from flag support',true,3),_r(130202,'Volume contracts in flag and expands on break',false,2),_r(130203,'Entry is near the flag break, not extended',true,3)]),
            _g(13,3,'Risk / Invalidation', [_r(130301,'Stop is below flag low / structure low',true,3),_r(130302,'Avoid if flag loses structure or turns into deeper pullback',true,2)]),
            _g(13,4,'Management / Exit', [_r(130401,'Partial on first measured push',false,2,'winner'),_r(130402,'Exit if flag fails and loses support',true,3,'loser'),_r(130403,'Hold runner only if continuation remains clean',false,2)])
        ])
    ];
}

// ── Eval demoSeed.js in this context ────────────────────────────────
// The file uses browser globals but all the builder functions we need
// are pure. Replace const with var so declarations leak from eval scope.
eval(demoSeedSrc.replace(/\bconst\b/g, 'var'));

// ── Generate the bundle ─────────────────────────────────────────────
const data = _buildDemoBrokerData();
const strategies = getDemoStrategySeedList();

const bundle = {
    version: DEMO_BROKER_DATA_VERSION,
    generatedAt: new Date().toISOString(),
    broker: data.brokerAccount,
    trades: data.trades,
    tags: data.tags,
    tagCategories: data.tagCategories,
    reviews: data.reviews,
    dailyPlanners: data.dailyPlanners,
    weeklyPlanners: data.weeklyPlanners,
    strategies: strategies
};

// ── Stats ───────────────────────────────────────────────────────────
console.log('Bundle stats:');
console.log('  version:', bundle.version);
console.log('  trades:', bundle.trades.length);
console.log('  tags:', bundle.tags.length);
console.log('  tagCategories:', bundle.tagCategories.length);
console.log('  reviews:', Object.keys(bundle.reviews).length);
console.log('  dailyPlanners:', Object.keys(bundle.dailyPlanners).length);
console.log('  weeklyPlanners:', Object.keys(bundle.weeklyPlanners).length);
console.log('  strategies:', bundle.strategies.length);

// ── Write js/demo-bundle.js ─────────────────────────────────────────
const header = `// ── Denarii Demo Bundle (read-only, auto-generated) ──────────────────
// This file contains the canonical Pelosi/demo dataset as a static
// constant. It is the central read-only repository for demo content.
//
// DO NOT EDIT BY HAND. Regenerate with: node _generate-demo-bundle.js
//
// Generated: ${bundle.generatedAt}
// Version: ${bundle.version}
// Trades: ${bundle.trades.length}
// Strategies: ${bundle.strategies.length}
// Tags: ${bundle.tags.length}
// Reviews: ${Object.keys(bundle.reviews).length}
// Daily planners: ${Object.keys(bundle.dailyPlanners).length}
// Weekly planners: ${Object.keys(bundle.weeklyPlanners).length}

`;

const output = header + 'var DEMO_BUNDLE = ' + JSON.stringify(bundle, null, 0) + ';\n';

fs.writeFileSync(path.join(__dirname, 'js', 'demo-bundle.js'), output, 'utf8');

const sizeKB = Math.round(output.length / 1024);
console.log('\nWrote js/demo-bundle.js (' + sizeKB + ' KB)');
