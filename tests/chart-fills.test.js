// Trade chart: one marker per fill (js/pages/stock-chart.js).
// Fill times are local wall-clock strings, which the chart maps to the same
// wall-clock candle times, so these tests do not depend on the machine's TZ.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CHART = fs.readFileSync(path.join(__dirname, '..', 'js/pages/stock-chart.js'), 'utf8');

function chartBox(over) {
    over = over || {};
    const win = { addEventListener() {} };
    new Function('window', 'document', 'journalData', 'LightweightCharts', 'TwelveDataKey', 'fetch', 'openModal', 'closeModal', CHART)(
        win, over.document || {}, over.journalData || { trades: [] }, over.LightweightCharts,
        over.TwelveDataKey, over.fetch, () => {}, () => {});
    return win;
}

const M = chartBox().StockChartMarkers;

// Candles for 2026-11-02, 09:30–10:30, at the given bar size.
function candles(minutes) {
    const out = [];
    for (let m = 0; m <= 60; m += minutes) {
        out.push({ time: Date.UTC(2026, 10, 2, 9, 30 + m) / 1000, open: 1, high: 1, low: 1, close: 1 });
    }
    return out;
}
const bar = (h, m) => Date.UTC(2026, 10, 2, h, m) / 1000;
const at = hms => '2026-11-02T' + hms;

// The TSLA example: bought 6 at 9:30:55, sold 2/1/1/2.
function tsla(extra) {
    const entry = { entryTime: at('09:30:55'), entryPrice: 2.31 };
    return Object.assign({
        symbol: 'TSLA', type: 'long',
        entryTime: at('09:30:55'), exitTime: at('09:37:51'), entryPrice: 2.31, exitPrice: 2.64,
        fills: [
            Object.assign({ quantity: 2, exitTime: at('09:31:05'), exitPrice: 2.59 }, entry),
            Object.assign({ quantity: 1, exitTime: at('09:31:33'), exitPrice: 2.61 }, entry),
            Object.assign({ quantity: 1, exitTime: at('09:32:40'), exitPrice: 2.64 }, entry),
            Object.assign({ quantity: 2, exitTime: at('09:37:51'), exitPrice: 2.20 }, entry),
        ],
    }, extra);
}

test('TSLA 4 fills on 1m: one combined entry, one marker per exit, each on its own candle', () => {
    const mk = M.buildTradeMarkers(tsla(), candles(1), '1m');
    assert.deepEqual(mk.map(m => [m.time, m.text]), [
        [bar(9, 30), 'Buy 6 @ $2.31'],
        [bar(9, 31), 'Sell 2 @ $2.59'],
        [bar(9, 31), 'Sell 1 @ $2.61'],
        [bar(9, 32), 'Sell 1 @ $2.64'],
        [bar(9, 37), 'Sell 2 @ $2.20'],
    ]);
    assert.equal(mk[0].position, 'belowBar');
    assert.equal(mk[0].shape, 'arrowUp');
    assert.ok(mk.slice(1).every(m => m.position === 'aboveBar' && m.shape === 'arrowDown'));
    assert.equal(mk[1].color, '#4CAF50', 'a winning fill is green');
    assert.equal(mk[4].color, '#f44336', 'a losing fill is red');
});

test('5m: three exits on one candle stay separate (stacked by the chart)', () => {
    const mk = M.buildTradeMarkers(tsla(), candles(5), '5m');
    assert.deepEqual(mk.map(m => [m.time, m.text]), [
        [bar(9, 30), 'Buy 6 @ $2.31'],
        [bar(9, 30), 'Sell 2 @ $2.59'],
        [bar(9, 30), 'Sell 1 @ $2.61'],
        [bar(9, 30), 'Sell 1 @ $2.64'],
        [bar(9, 35), 'Sell 2 @ $2.20'],
    ]);
});

test('15m: more than 3 exits on one candle merge into one label', () => {
    assert.equal(M.MAX_EXITS_PER_CANDLE, 3);
    const mk = M.buildTradeMarkers(tsla(), candles(15), '15m');
    assert.equal(mk.length, 2);
    assert.equal(mk[0].text, 'Buy 6 @ $2.31');
    assert.equal(mk[1].text, 'Sell 2 @ $2.59 · 1 @ $2.61 · 1 @ $2.64 · 2 @ $2.20');
    assert.equal(mk[1].time, bar(9, 30));
    // Net of the four: +0.56 +0.30 +0.33 -0.22 > 0
    assert.equal(mk[1].color, '#4CAF50');
});

test('markers are in ascending time order, entries first on a shared candle', () => {
    const t = tsla();
    t.fills.reverse();
    const mk = M.buildTradeMarkers(t, candles(1), '1m');
    for (let i = 1; i < mk.length; i++) assert.ok(mk[i].time >= mk[i - 1].time);
    assert.equal(mk[0].text, 'Buy 6 @ $2.31');
    assert.deepEqual(mk.filter(m => m.time === bar(9, 31)).map(m => m.text), ['Sell 2 @ $2.59', 'Sell 1 @ $2.61'],
        'same-candle exits keep fill time order');
});

test('entries at different times or prices stay separate', () => {
    const t = tsla();
    t.fills[3].entryTime = at('09:33:10');
    t.fills[3].entryPrice = 2.40;
    t.fills[2].entryPrice = 2.35;
    const texts = M.buildTradeMarkers(t, candles(1), '1m').filter(m => m.text.startsWith('Buy')).map(m => m.text);
    assert.deepEqual(texts, ['Buy 3 @ $2.31', 'Buy 1 @ $2.35', 'Buy 2 @ $2.40']);
});

test('option trades get the "opt" suffix on every label', () => {
    const mk = M.buildTradeMarkers(tsla({ assetType: 'option' }), candles(1), '1m');
    assert.ok(mk.every(m => m.text.endsWith(' opt')), mk.map(m => m.text).join('\n'));
    assert.equal(mk[0].text, 'Buy 6 @ $2.31 opt');
    const merged = M.buildTradeMarkers(tsla({ assetType: 'option' }), candles(15), '15m');
    assert.ok(merged[1].text.endsWith('2 @ $2.20 opt'));
});

test('short trades flip the labels: Sell to open, Buy to close', () => {
    const mk = M.buildTradeMarkers(tsla({ type: 'short' }), candles(1), '1m');
    assert.equal(mk[0].text, 'Sell 6 @ $2.31');
    assert.equal(mk[0].position, 'aboveBar');
    assert.ok(mk.slice(1).every(m => m.text.startsWith('Buy ') && m.position === 'belowBar'));
    assert.equal(mk[4].color, '#4CAF50', 'covering below the entry wins on a short');
    assert.equal(mk[1].color, '#f44336');
    // Cloud-loaded rows carry direction instead of type.
    const cloud = tsla({ direction: 'short' });
    delete cloud.type;
    assert.equal(M.buildTradeMarkers(cloud, candles(1), '1m')[0].text, 'Sell 6 @ $2.31');
});

test('no side field defaults to long labels', () => {
    const t = tsla();
    delete t.type;
    assert.equal(M.buildTradeMarkers(t, candles(1), '1m')[0].text, 'Buy 6 @ $2.31');
});

test('trades without fills keep the single Entry / Exit markers', () => {
    const t = tsla();
    delete t.fills;
    const mk = M.buildTradeMarkers(t, candles(1), '1m');
    assert.deepEqual(mk.map(m => [m.time, m.text, m.position]), [
        [bar(9, 30), 'Entry @ $2.31', 'belowBar'],
        [bar(9, 37), 'Exit @ $2.64', 'aboveBar'],
    ]);
    assert.deepEqual(M.buildTradeMarkers(Object.assign(t, { fills: [] }), candles(1), '1m').length, 2);
});

test('fills with no usable times or prices fall back to the single markers', () => {
    const t = tsla({ entryTime: null });
    t.fills = [{ quantity: 2, entryPrice: '', exitPrice: null }];
    t.entryTime = at('09:30:55');
    const mk = M.buildTradeMarkers(t, candles(1), '1m');
    assert.deepEqual(mk.map(m => m.text), ['Entry @ $2.31', 'Exit @ $2.64']);
});

test('an open fill (no exit yet) shows its entry only', () => {
    const t = tsla();
    t.fills = [{ quantity: 3, entryTime: at('09:30:55'), entryPrice: 2.31, exitTime: null, exitPrice: null }];
    assert.deepEqual(M.buildTradeMarkers(t, candles(1), '1m').map(m => m.text), ['Buy 3 @ $2.31']);
});

test('building markers never changes the saved trade', () => {
    const t = tsla({ assetType: 'option' });
    const before = JSON.stringify(t);
    M.buildTradeMarkers(t, candles(15), '15m');
    M.buildTradeMarkers(t, candles(1), '1m');
    assert.equal(JSON.stringify(t), before);
});

// ── Through openChartForTrade ─────────────────────────────────────────────

function domStub() {
    const els = {};
    return {
        els,
        getElementById(id) {
            return els[id] || (els[id] = { id, textContent: '', innerHTML: '', style: {}, value: '', clientWidth: 800 });
        },
    };
}

test('openChartForTrade draws fill markers, shows the fill count and the option note', async () => {
    const trade = tsla({ id: '7', assetType: 'option' });
    const doc = domStub();
    doc.getElementById('chart-timeframe').value = '1m';
    let marks = null;
    const series = { setData() {}, setMarkers(m) { marks = m; } };
    const LightweightCharts = {
        CrosshairMode: { Normal: 0 },
        createChart: () => ({ addCandlestickSeries: () => series, timeScale: () => ({ fitContent() {} }), remove() {} }),
    };
    const values = candles(1).map(c => {
        const d = new Date(c.time * 1000);
        const hh = String(d.getUTCHours()).padStart(2, '0'), mm = String(d.getUTCMinutes()).padStart(2, '0');
        return { datetime: `2026-11-02 ${hh}:${mm}:00`, open: '1', high: '1', low: '1', close: '1' };
    });
    const win = chartBox({
        document: doc,
        journalData: { trades: [trade] },
        LightweightCharts,
        TwelveDataKey: { isLoaded: () => true, getKey: () => 'USERKEY', loadApiKey: async () => {} },
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', values }) }),
    });
    win.openChartForTrade(7);
    await new Promise(r => setTimeout(r, 20));
    assert.ok(marks, 'markers were set');
    assert.equal(marks.length, 5);
    assert.equal(marks[0].text, 'Buy 6 @ $2.31 opt');
    const info = doc.els['chart-trade-info'].textContent;
    assert.match(info, /4 fills/);
    assert.match(info, /Option trade: chart shows the underlying; markers mark fill times; prices are option premiums/);
});
