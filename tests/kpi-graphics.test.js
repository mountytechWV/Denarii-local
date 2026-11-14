// Redesign Stage 8b: graphics inside the Dashboard KPI cards.
// - Segment meter, equity curve, win-rate donut, profit-factor gauge and
//   avg win / loss balance bar. Helpers are read-only and never print NaN / Infinity.
// - The seven .stat-value texts are unchanged.
// - Cloud metrics carry no trade history, so the equity curve is local only;
//   in cloud mode Total P&L shows gross won / lost bars (avgWin × winCount,
//   |avgLoss| × lossCount) instead.
//
// Same harness as batch-d3.test.js: real functions are cut out of Denarii.js
// and run in a `with` scope (unknown globals are inert).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
// LF line endings, so a Windows (CRLF) checkout matches.
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const APP = read('Denarii.js');
const CSS = read('css/denarii-ds.css');
const HTML = read('index.html');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(name + ': unbalanced braces');
}

const inert = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
});

function sandbox(fnNames, vals) {
    const code = fnNames.map(n => extractFunction(APP, n)).join('\n');
    const target = Object.assign({}, vals);
    const scope = new Proxy(target, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => {
            if (typeof k !== 'string') return undefined;
            if (k in t) return t[k];
            if (k in globalThis) return globalThis[k];
            return inert;
        },
    });
    const fns = new Function('scope', 'with (scope) { return (function () {\n' + code +
        '\nreturn {' + fnNames.join(',') + '};\n})(); }')(scope);
    return { fns, g: target };
}

const KPI_FNS = ['_kpiClamp01', '_kpiPct', '_kpiSegCounts', '_kpiSegMeter', '_kpiDonut', '_kpiGaugeAngle', '_kpiArcPt',
    '_kpiGauge', '_kpiBalance', '_kpiGross', '_kpiWonLost', '_kpiSparkPoints', '_kpiSparkline', '_dashFmtMoney'];
const K = () => sandbox(KPI_FNS, {}).fns;
const noBadNumbers = html => assert.doesNotMatch(html, /NaN|Infinity|undefined/, html);
const widths = html => [...html.matchAll(/width:([\d.]+)%/g)].map(m => Number(m[1]));
const count = (html, re) => (html.match(re) || []).length;

// ── Helpers ────────────────────────────────────────────────────────────────

test('clamp: NaN / null / negative → 0, Infinity / >1 → 1', () => {
    const k = K();
    assert.equal(k._kpiClamp01(NaN), 0);
    assert.equal(k._kpiClamp01(null), 0);
    assert.equal(k._kpiClamp01(undefined), 0);
    assert.equal(k._kpiClamp01(-1), 0);
    assert.equal(k._kpiClamp01(Infinity), 1);
    assert.equal(k._kpiClamp01(5), 1);
    assert.equal(k._kpiClamp01(0.25), 0.25);
    assert.equal(k._kpiClamp01('0.5'), 0.5);
});

test('segment meter: counts always add up to 10, never negative; 0 trades → all rest', () => {
    const k = K();
    const sum = c => c.win + c.loss + c.rest;
    const cases = [[838, 732, 1600], [0, 0, 0], [0, 0, 5], [5, 0, 5], [0, 5, 5], [1, 1, 3], [2, 1, 5],
        [45, 45, 100], [46, 46, 100], [3, 3, 6], [1, 0, 1000], [NaN, 1, 2], [1, 1, NaN], [-1, 2, 3]];
    for (const [w, l, t] of cases) {
        const c = k._kpiSegCounts(w, l, t);
        assert.equal(sum(c), 10, JSON.stringify([w, l, t, c]));
        for (const v of [c.win, c.loss, c.rest]) assert.ok(Number.isInteger(v) && v >= 0, JSON.stringify([w, l, t, c]));
    }
    assert.deepEqual(k._kpiSegCounts(0, 0, 0), { win: 0, loss: 0, rest: 10 });
    assert.deepEqual(k._kpiSegCounts(838, 732, 1600), { win: 5, loss: 5, rest: 0 });
    assert.deepEqual(k._kpiSegCounts(2, 1, 5), { win: 4, loss: 2, rest: 4 });
    assert.deepEqual(k._kpiSegCounts(46, 46, 100), { win: 5, loss: 5, rest: 0 }, 'losses capped by what wins leave');
    const html = k._kpiSegMeter({ win: 4, loss: 2, rest: 4 });
    assert.equal(count(html, /class="kpi-seg /g), 10);
    assert.equal(count(html, /kpi-seg kpi-win/g), 4);
    assert.equal(count(html, /kpi-seg kpi-loss/g), 2);
    assert.equal(count(html, /kpi-seg kpi-rest/g), 4);
    assert.match(html, /^<div class="kpi-viz kpi-meter" aria-hidden="true"><span class="kpi-seg kpi-win">/, 'wins first');
});

test('donut: dash arrays for 0, 53.4 and 100; text rounded; track only without data', () => {
    const k = K();
    const zero = k._kpiDonut(0, true);
    assert.doesNotMatch(zero, /kpi-donut-win/);
    assert.match(zero, /kpi-donut-rest"[^>]*stroke-dasharray="100\.00 100" stroke-dashoffset="0\.00"/);
    assert.match(zero, />0%<\/text>/);
    const mid = k._kpiDonut('53.4', true);
    assert.match(mid, /kpi-donut-win"[^>]*stroke-dasharray="53\.40 100"/);
    assert.match(mid, /kpi-donut-rest"[^>]*stroke-dasharray="46\.60 100" stroke-dashoffset="-53\.40"/);
    assert.match(mid, />53%<\/text>/);
    assert.match(k._kpiDonut(53.5, true), />54%<\/text>/);
    const full = k._kpiDonut(100, true);
    assert.match(full, /kpi-donut-win"[^>]*stroke-dasharray="100\.00 100"/);
    assert.doesNotMatch(full, /kpi-donut-rest/);
    assert.match(full, />100%<\/text>/);
    const none = k._kpiDonut(0, false);
    assert.match(none, /kpi-donut-track/);
    assert.doesNotMatch(none, /kpi-donut-win|kpi-donut-rest/);
    for (const v of [NaN, null, undefined, -5, 250, Infinity]) noBadNumbers(k._kpiDonut(v, true));
    assert.match(zero, /aria-hidden="true"/);
});

test('gauge: needle angle maps 0..3 to 0..180°, clamped; Infinity → 180; NaN / null → no needle', () => {
    const k = K();
    const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, a + ' vs ' + b);
    near(k._kpiGaugeAngle(0), 0);
    near(k._kpiGaugeAngle(0.5), 30);
    near(k._kpiGaugeAngle(1), 60);
    near(k._kpiGaugeAngle(1.72), 103.2);
    near(k._kpiGaugeAngle(2), 120);
    near(k._kpiGaugeAngle(3), 180);
    near(k._kpiGaugeAngle(10), 180);
    near(k._kpiGaugeAngle(Infinity), 180);
    near(k._kpiGaugeAngle(-2), 0);
    assert.equal(k._kpiGaugeAngle(NaN), null);
    assert.equal(k._kpiGaugeAngle(null), null);
    assert.equal(k._kpiGaugeAngle(undefined), null);
    // Needle tip: 0 points left, 1.5 straight up, Infinity right.
    assert.match(k._kpiGauge(0), /x2="16\.00" y2="50\.00"/);
    assert.match(k._kpiGauge(1.5), /x2="50\.00" y2="16\.00"/);
    assert.match(k._kpiGauge(Infinity), /x2="84\.00" y2="50\.00"/);
    for (const v of [0, 0.5, 1, 1.72, 2, 3, 10, Infinity, NaN, null]) {
        const html = k._kpiGauge(v);
        const hasNeedle = !(v == null || Number.isNaN(v));
        assert.equal(count(html, /class="kpi-zone /g), 3, String(v));
        assert.match(html, /kpi-zone-loss[\s\S]*kpi-zone-mid[\s\S]*kpi-zone-win/);
        assert.equal(count(html, /kpi-gauge-needle/g), hasNeedle ? 1 : 0, String(v));
        assert.equal(count(html, /kpi-gauge-pivot/g), hasNeedle ? 1 : 0, String(v));
        noBadNumbers(html);
    }
});

test('balance bar: larger side fills its half, smaller proportional; ratio text and dimming', () => {
    const k = K();
    const win = k._kpiBalance(260.32, -124.92, 'win');
    assert.match(win, /kpi-bal-win" style="width:50\.00%/);
    assert.match(win, /kpi-bal-loss kpi-dim" style="width:23\.99%/);
    assert.match(win, /<div class="kpi-ratio">2\.08R payoff<\/div>/);
    assert.match(win, /kpi-bal-mid/);
    const loss = k._kpiBalance(260.32, -124.92, 'loss');
    assert.match(loss, /kpi-bal-win kpi-dim" style="width:50\.00%/);
    assert.match(loss, /kpi-bal-loss" style="width:23\.99%/);
    assert.match(loss, /2\.08R payoff/);
    const lossBigger = k._kpiBalance(40, -80, 'win');
    assert.deepEqual(widths(lossBigger), [25, 50]);
    assert.match(lossBigger, /0\.50R payoff/);
    // One side zero: bar for the other, no ratio.
    const onlyWin = k._kpiBalance(50, 0, 'win');
    assert.deepEqual(widths(onlyWin), [50]);
    assert.doesNotMatch(onlyWin, /kpi-ratio/);
    // Both zero: track and centre marker only.
    const both = k._kpiBalance(0, 0, 'loss');
    assert.doesNotMatch(both, /kpi-bal-win|kpi-bal-loss|kpi-ratio/);
    assert.match(both, /kpi-bal-track[\s\S]*kpi-bal-mid/);
    // Non-finite or overflowing: treated as missing, never printed.
    for (const [w, l] of [[NaN, -10], [Infinity, -10], [10, -Infinity], [null, undefined], [1e300, -1e-300]]) {
        const html = k._kpiBalance(w, l, 'win');
        assert.doesNotMatch(html, /kpi-ratio/, JSON.stringify([w, l]));
        noBadNumbers(html);
    }
});

test('gross won / lost: avgWin × winCount and |avgLoss| × lossCount; 0 and non-finite → 0', () => {
    const k = K();
    assert.deepEqual(k._kpiGross(20, 3, -22, 5), { won: 60, lost: 110 });
    assert.deepEqual(k._kpiGross(0, 0, -22, 5), { won: 0, lost: 110 }, '0 wins');
    assert.deepEqual(k._kpiGross(20, 3, 0, 0), { won: 60, lost: 0 }, '0 losses');
    assert.deepEqual(k._kpiGross(0, 0, 0, 0), { won: 0, lost: 0 });
    assert.deepEqual(k._kpiGross(Infinity, 3, -22, 5), { won: 0, lost: 110 });
    assert.deepEqual(k._kpiGross(20, 3, NaN, 5), { won: 60, lost: 0 });
    assert.deepEqual(k._kpiGross(null, undefined, -Infinity, 2), { won: 0, lost: 0 });
    assert.deepEqual(k._kpiGross('20', '3', '-22', '5'), { won: 60, lost: 110 });
    assert.deepEqual(k._kpiGross(-5, 2, -1, -3), { won: 0, lost: 0 }, 'never negative');
});

test('won / lost bars: larger full width, other proportional, dashboard money format; empty when both 0', () => {
    const k = K();
    const html = k._kpiWonLost({ won: 60, lost: 110 });
    assert.match(html, /kpi-wl-row kpi-win"><div class="kpi-wl-label">Won \$60\.00<\/div><div class="kpi-wl-bar" aria-hidden="true"><span style="width:54\.55%;">/);
    assert.match(html, /kpi-wl-row kpi-loss"><div class="kpi-wl-label">Lost \$110\.00<\/div><div class="kpi-wl-bar" aria-hidden="true"><span style="width:100\.00%;">/);
    assert.ok(html.indexOf('Won') < html.indexOf('Lost'), 'won stacked above lost');
    const noLoss = k._kpiWonLost({ won: 1234.5, lost: 0 });
    assert.match(noLoss, /Won \$1234\.50[\s\S]*width:100\.00%/);
    assert.match(noLoss, /Lost \$0\.00<\/div><div class="kpi-wl-bar" aria-hidden="true"><\/div>/);
    assert.equal(k._kpiWonLost({ won: 0, lost: 0 }), '');
    assert.equal(k._kpiWonLost(k._kpiGross(NaN, 1, Infinity, 1)), '');
    noBadNumbers(noLoss);
});

const trade = (pnl, day, extra) => Object.assign({ pnl, exitTime: '2024-01-' + String(day).padStart(2, '0') + 'T10:00', exitPrice: 1 }, extra);

test('spark points: start at 0, follow exit time (input not changed), end on the total', () => {
    const k = K();
    assert.deepEqual(k._kpiSparkPoints([], 120), []);
    assert.deepEqual(k._kpiSparkPoints(null, 120), []);
    assert.deepEqual(k._kpiSparkPoints([trade(5, 1)], 120), [0, 5]);
    const input = [trade(10, 3), trade(-4, 1), trade(7, 2)];
    const before = JSON.stringify(input);
    assert.deepEqual(k._kpiSparkPoints(input, 120), [0, -4, 3, 13]);
    assert.equal(JSON.stringify(input), before, 'input array untouched');
});

test('spark points: 5,000 trades are cut to at most 2 × 120 + 2 points, keep the extremes and the final total', () => {
    const k = K();
    const many = [];
    let total = 0;
    for (let i = 0; i < 5000; i++) {
        const p = i === 2500 ? -10000 : ((i * 37) % 11) - 5;
        total += p;
        many.push(trade(p, 1, { exitTime: new Date(Date.UTC(2020, 0, 1) + i * 60000).toISOString() }));
    }
    const pts = k._kpiSparkPoints(many, 120);
    assert.ok(pts.length <= 242, String(pts.length));
    assert.equal(pts[0], 0);
    assert.ok(Math.abs(pts[pts.length - 1] - total) < 1e-6);
    assert.ok(Math.min(...pts) <= -9000, 'the big loss survives downsampling');
});

test('sparkline: 40-unit viewBox; empty under 2 points; flat, all-negative and crossing series draw without NaN', () => {
    const k = K();
    assert.equal(k._kpiSparkline([], 0), '');
    assert.equal(k._kpiSparkline([0], 0), '');
    const flat = k._kpiSparkline([0, 0, 0], 0);
    assert.match(flat, /kpi-spark kpi-win/);
    assert.match(flat, /viewBox="0 0 100 40"/);
    noBadNumbers(flat);
    const neg = k._kpiSparkline([0, -5, -12], -12);
    assert.match(neg, /kpi-spark kpi-loss/);
    assert.doesNotMatch(neg, /kpi-spark-zero/, 'zero is the top edge, no dashed line');
    noBadNumbers(neg);
    const cross = k._kpiSparkline([0, -5, 8], 8);
    assert.match(cross, /kpi-spark-zero/);
    assert.match(cross, /kpi-spark-area/);
    assert.match(cross, /preserveAspectRatio="none"/);
    noBadNumbers(cross);
});

// ── updateDashboard ────────────────────────────────────────────────────────

const DASH_FNS = ['updateDashboard', '_isOpenTrade', '_grossProfitFactor', ...KPI_FNS];

// 2 wins, 1 loss, 1 breakeven, 1 open.
const FIXTURE = [
    trade(100, 1, { id: 1 }),
    trade(-40, 2, { id: 2 }),
    trade(60, 3, { id: 3 }),
    trade(0, 4, { id: 4 }),
    { id: 5, pnl: null, entryTime: '2024-01-05T10:00' },
];

function renderDash(over) {
    const els = {};
    const vals = Object.assign({
        window: {},
        journalData: { trades: FIXTURE, brokerAccounts: [{ id: 'a' }] },
        getDashFilteredTrades: t => t,
        getAccountCashSummary: () => ({ openingBalance: 1000, netCashFlow: 0, realizedPnlAllTime: 120, accruedRecurringFees: 0 }),
        _cloudDashActive: () => false,
        _cloudDash: { loading: false, metricsReady: false, metrics: {} },
        _dashSelectedIds: new Set(),
        document: { getElementById: id => (els[id] = els[id] || { innerHTML: '', id }) },
    }, over);
    const box = sandbox(DASH_FNS, vals);
    try { box.fns.updateDashboard(); } catch (e) { /* the trade table after the KPI row needs more of the app */ }
    return els['dashboard-stats'].innerHTML;
}

const values = html => [...html.matchAll(/<div class="stat-value ([a-z]+)">([^<]*)<\/div>/g)].map(m => m[1] + ' ' + m[2]);
const cards = html => html.split('<div class="stat-card">').slice(1);

test('dashboard: seven cards, .stat-value classes and text unchanged', () => {
    const html = renderDash();
    assert.equal(cards(html).length, 7);
    assert.deepEqual(values(html), [
        'neutral 5', 'positive $120.00', 'positive 50.0%', 'positive 4.00',
        'positive $80.00', 'negative -$40.00', 'positive $1120.00',
    ]);
    assert.match(html, /<div class="stat-subtitle">2W \/ 1L<\/div>/);
    noBadNumbers(html);
});

test('dashboard: each card gets its graphic; Account Value gets none', () => {
    const c = cards(renderDash());
    // Total Trades: 2 / 5 wins, 1 / 5 losses → 4 / 2 / 4 blocks, meter above the subtitle.
    assert.equal(count(c[0], /kpi-seg kpi-win/g), 4);
    assert.equal(count(c[0], /kpi-seg kpi-loss/g), 2);
    assert.equal(count(c[0], /kpi-seg kpi-rest/g), 4);
    assert.ok(c[0].indexOf('kpi-meter') < c[0].indexOf('stat-subtitle'));
    assert.match(c[1], /class="kpi-spark kpi-win"/);
    // Win Rate: the .stat-value stays in the DOM beside the donut.
    assert.match(c[2], /class="kpi-donut-row">\s*<div class="stat-value positive">50\.0%<\/div>\s*<svg class="kpi-donut"/);
    assert.match(c[2], /kpi-donut-win"[^>]*stroke-dasharray="50\.00 100"/);
    assert.match(c[2], />50%<\/text>/);
    // Profit Factor 4.00 → needle at the right end.
    assert.match(c[3], /kpi-gauge-needle" x1="50" y1="50" x2="84\.00" y2="50\.00"/);
    // Avg Win $80 vs Avg Loss $40 → green full half, red a quarter; 2.00R.
    assert.match(c[4], /kpi-bal-win" style="width:50\.00%/);
    assert.match(c[4], /kpi-bal-loss kpi-dim" style="width:25\.00%/);
    assert.match(c[4], /2\.00R payoff/);
    assert.match(c[5], /kpi-bal-win kpi-dim" style="width:50\.00%/);
    assert.match(c[5], /kpi-bal-loss" style="width:25\.00%/);
    assert.doesNotMatch(c[6], /kpi-/);
});

test('dashboard: no trades → empty meter, track-only donut, needle at 0, bare balance bar, no sparkline, no NaN', () => {
    const html = renderDash({ journalData: { trades: [], brokerAccounts: [] } });
    const c = cards(html);
    assert.equal(c.length, 7);
    assert.equal(count(c[0], /kpi-seg kpi-rest/g), 10);
    assert.doesNotMatch(c[1], /kpi-spark/);
    assert.match(c[2], /kpi-donut-track/);
    assert.doesNotMatch(c[2], /kpi-donut-win|kpi-donut-rest/);
    assert.match(c[3], /x2="16\.00" y2="50\.00"/);
    assert.doesNotMatch(c[4] + c[5], /kpi-bal-win|kpi-bal-loss|kpi-ratio/);
    assert.deepEqual(values(html).slice(0, 6), [
        'neutral 0', 'positive $0.00', 'negative 0%', 'negative 0.00', 'positive $0.00', 'negative $0.00',
    ]);
    noBadNumbers(html);
});

test('dashboard: Profit Factor of Infinity (no losses) prints ∞ and points the needle at 3', () => {
    const html = renderDash({ journalData: { trades: [trade(10, 1, { id: 1 })], brokerAccounts: [] } });
    const c = cards(html);
    assert.match(c[3], /∞/);
    assert.match(c[3], /x2="84\.00" y2="50\.00"/);
    assert.match(c[1], /kpi-spark kpi-win/);
    assert.doesNotMatch(c[4], /kpi-ratio/, 'no losses → no payoff ratio');
    noBadNumbers(html);
});

test('dashboard: negative total draws a red sparkline', () => {
    const html = renderDash({ journalData: { trades: [trade(-10, 1, { id: 1 }), trade(-5, 2, { id: 2 })], brokerAccounts: [] } });
    assert.match(cards(html)[1], /kpi-spark kpi-loss/);
});

test('dashboard: with cloud metrics Total P&L shows won / lost bars, never the curve; the rest use cloud values', () => {
    const html = renderDash({
        _cloudDashActive: () => true,
        _cloudDash: {
            loading: true, metricsReady: true, tradesPage: [],
            metrics: { totalTrades: 10, closedTrades: 8, totalPnl: -50, winCount: 3, lossCount: 5,
                avgWin: 20, avgLoss: -22, profitFactor: 0.5454 },
        },
    });
    const c = cards(html);
    assert.doesNotMatch(c[1], /kpi-spark/);
    assert.match(c[1], /stat-value negative">-\$50\.00/);
    // 20 × 3 = 60 won, 22 × 5 = 110 lost.
    assert.match(c[1], /Won \$60\.00[\s\S]*width:54\.55%[\s\S]*Lost \$110\.00[\s\S]*width:100\.00%/);
    assert.equal(count(c[0], /kpi-seg kpi-win/g), 3);
    assert.equal(count(c[0], /kpi-seg kpi-loss/g), 5);
    assert.match(c[2], /kpi-donut-win"[^>]*stroke-dasharray="37\.50 100"/);
    assert.match(c[2], />38%<\/text>/);
    assert.match(c[5], /0\.91R payoff/);
});

test('dashboard: local mode keeps the curve without won / lost; cloud with no wins or losses shows nothing', () => {
    assert.doesNotMatch(cards(renderDash())[1], /kpi-wonlost/);
    const html = renderDash({
        _cloudDashActive: () => true,
        _cloudDash: {
            loading: true, metricsReady: true, tradesPage: [],
            metrics: { totalTrades: 2, closedTrades: 0, totalPnl: 0, winCount: 0, lossCount: 0,
                avgWin: 0, avgLoss: 0, profitFactor: 0 },
        },
    });
    assert.doesNotMatch(cards(html)[1], /kpi-/);
    noBadNumbers(html);
});

// ── CSS / HTML ─────────────────────────────────────────────────────────────

test('CSS: theme tokens only; flex-column cards; donut / gauge shrink (not hide) in narrow cards; old bars gone', () => {
    const block = CSS.slice(CSS.indexOf('/* ── KPI graphics'), CSS.indexOf('/* ── Shared filter bar'));
    assert.ok(block.length > 100, 'KPI graphics block present');
    assert.doesNotMatch(block, /#[0-9a-f]{3,8}\b|rgba?\(/i, 'no hard-coded colours');
    for (const t of ['--success', '--danger', '--warning', '--border', '--text-muted', '--text-primary']) assert.ok(block.includes('var(' + t + ')'), t);
    assert.match(block, /#dashboard-stats > \.stat-card \{[^}]*display: flex;[^}]*flex-direction: column;/);
    assert.match(block, /@container \(max-width: 110px\) \{\s*\.kpi-donut \{ width: 52px; height: 52px; \}\s*\.kpi-gauge svg \{ height: 46px; \}/);
    assert.match(block, /\.kpi-donut-row > \.stat-value \{[^}]*clip-path: inset\(50%\);/, 'win rate value visually hidden, still in the DOM');
    assert.match(block, /:has\(> \.kpi-gauge\) > \.stat-value \{ order: 2; text-align: center; \}/);
    assert.match(block, /\.kpi-donut \{ display: block; width: 72px; height: 72px; \}/);
    assert.match(block, /\.kpi-wl-bar \{[^}]*height: 8px;/);
    // Small text (won / lost labels, payoff ratio, W / L subtitle): body font, 12px, tabular figures;
    // 11px in narrow cards. The figure font is left to the donut percent only.
    assert.match(block, /#dashboard-stats \.stat-subtitle,\s*\.kpi-wl-label,\s*\.kpi-ratio \{[^}]*font-family: var\(--ds-font-body\);[^}]*font-size: var\(--ds-text-sm\);[^}]*font-variant-numeric: tabular-nums;/);
    assert.match(block, /\.kpi-wl-label \{ font-weight: var\(--ds-weight-semibold\); \}/);
    assert.match(block, /@container \(max-width: 110px\) \{[^}]*\}[^}]*\}\s*#dashboard-stats \.stat-subtitle,\s*\.kpi-wl-label,\s*\.kpi-ratio \{ font-size: var\(--ds-text-xs\); \}/);
    assert.equal(count(block, /font-family: var\(--ds-font-figure\)/g), 1, 'figure font only on .kpi-donut-text');
    assert.match(block, /\.kpi-donut-text \{[^}]*font-family: var\(--ds-font-figure\);/);
    assert.doesNotMatch(block, /display: none|@keyframes|animation:\s*(?!none)[a-z]|transition:\s*(?!none)[a-z]/);
    assert.doesNotMatch(CSS + APP, /kpi-bar|stat-ring|stat-viz|_kpiRing|_kpiBar\(/, 'Stage 8b v1 graphics removed');
});

test('index.html: Denarii.js and denarii-ds.css versions bumped for KPI graphics (local numbering)', () => {
    assert.ok(Number(/src="Denarii\.js\?v=(\d+)"/.exec(HTML)[1]) >= 83);
    assert.ok(Number(/href="css\/denarii-ds\.css\?v=(\d+)"/.exec(HTML)[1]) >= 34);
});
