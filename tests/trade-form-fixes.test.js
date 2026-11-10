// Trade fixes found in deployed testing on 2026-10-24:
//  A. deleteTrade on an open trade (pnl null) threw in the confirm text.
//  B. New Trade with multiple fills dropped a partly filled row silently;
//     Save is now blocked with an inline message naming the row and field.
//
// Same approach as cloud-trade-writes.test.js: the real functions are cut out
// of Denarii.js and run inside a `with` scope where unknown globals are inert.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'Denarii.js'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    const isAsync = src.slice(start - 6, start) === 'async ';
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return (isAsync ? 'async ' : '') + src.slice(start, i + 1);
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

function el(props) {
    return Object.assign({ value: '', style: {}, readOnly: false, textContent: '',
        querySelector: () => null, querySelectorAll: () => [], focus() {}, click() {} }, props);
}

// ── A. deleteTrade ─────────────────────────────────────────────────────────

function delHarness(trade) {
    const calls = { confirms: [], cloudDeletes: [], idb: 0 };
    const { fns, g } = sandbox(['deleteTrade'], {
        journalData: { trades: [trade, { id: 2, symbol: 'KEEP', pnl: 1 }] },
        confirm: msg => { calls.confirms.push(msg); return true; },
        _displaySymbol: s => s,
        _isCloudPrimarySave: () => true,
        _deleteTradeFromSupabase: async id => { calls.cloudDeletes.push(id); return { success: true }; },
        _triggerCloudDashRefresh: () => {},
        saveToIndexedDB: async () => { calls.idb++; },
        updateDashboard: () => {},
    });
    return { fns, g, calls };
}

test('delete: open trade (pnl null) confirms with "Open" and deletes', async () => {
    const h = delHarness({ id: 1, symbol: 'ZZTESTA', pnl: null, exitPrice: null });
    await h.fns.deleteTrade(1);
    assert.equal(h.calls.confirms[0], 'Delete ZZTESTA trade (Open)? This cannot be undone.');
    assert.deepEqual(h.g.journalData.trades.map(t => t.id), [2]);
    assert.deepEqual(h.calls.cloudDeletes, [1]);
    assert.equal(h.calls.idb, 1);
});

test('delete: closed trade message and delete are unchanged', async () => {
    const win = delHarness({ id: 1, symbol: 'ZZTESTB', pnl: 12.5 });
    await win.fns.deleteTrade(1);
    assert.equal(win.calls.confirms[0], 'Delete ZZTESTB trade (+$12.50)? This cannot be undone.');
    assert.deepEqual(win.g.journalData.trades.map(t => t.id), [2]);
    assert.deepEqual(win.calls.cloudDeletes, [1]);
    const loss = delHarness({ id: 1, symbol: 'ZZTESTB', pnl: -3 });
    await loss.fns.deleteTrade(1);
    assert.equal(loss.calls.confirms[0], 'Delete ZZTESTB trade ($-3.00)? This cannot be undone.');
});

// ── B. New Trade fill rows ─────────────────────────────────────────────────

const T1 = '2026-10-24T10:00', T2 = '2026-10-24T10:05';
const row = o => Object.assign({ qty: '', entryPrice: '', exitPrice: '', entryTime: '', exitTime: '', fees: '' }, o);
const FULL1 = row({ qty: '1', entryPrice: '1', exitPrice: '2', entryTime: T1, exitTime: T2 });
const FULL2 = row({ qty: '1', entryPrice: '1', exitPrice: '3', entryTime: T1, exitTime: T2 });
const NO_TIMES2 = row({ qty: '1', entryPrice: '1', exitPrice: '3' });

// rows: the fill rows on the form; built trade quantity follows the rows.
function ntHarness(opts) {
    const state = { rows: opts.rows || [] };
    const calls = { saved: [], status: [], errorBox: el({ style: { display: 'none' } }) };
    const els = {
        symbol: el({ value: 'ZZTESTC' }), quantity: el({ value: '1' }),
        'entry-price': el({ value: '1' }), 'entry-time': el({ value: T1 }),
        'nt-fills-error': calls.errorBox,
    };
    const { fns, g } = sandbox(['_ntCommitTrade', '_ntCanCreate', '_ntFindIncompleteFillRow', '_ntShowFillError', '_restoreTradeInPlace'], {
        journalData: { trades: [{ id: 1, symbol: 'OLD' }] },
        _ntCreatedTradeId: null,
        _ntFillsEnabled: opts.fills !== false,
        _NT_DRAFT_KEY: 'nt-draft',
        _ntSerializeFillRows: () => state.rows,
        _ntBuildTrade: id => {
            const valid = state.rows.filter(r => r.qty && r.entryTime && r.exitTime);
            const t = { id: id || 555, symbol: 'ZZTESTC', quantity: valid.length ? valid.reduce((s, r) => s + +r.qty, 0) : 1 };
            if (valid.length > 1) t.fills = valid.map(r => ({ quantity: +r.qty }));
            return t;
        },
        _ntClearDraft: () => {},
        _ntResetForm: () => {},
        updateDashboard: () => {},
        document: {
            getElementById: id => els[id] || (els[id] = el()),
            querySelector: () => el(),
            querySelectorAll: () => [],
        },
        Autosave: { showStatus: (id, s) => calls.status.push(s), load: () => null },
        _isCloudPrimarySave: () => true,
        _saveTradeToSupabase: async t => { calls.saved.push(JSON.parse(JSON.stringify(t))); return { success: true }; },
        _triggerCloudDashRefresh: () => {},
        saveToIndexedDB: async () => {},
    });
    return { fns, g, state, calls };
}

test('fills: two filled rows, one with blank times, blocks Save and names the row', async () => {
    const h = ntHarness({ rows: [FULL1, NO_TIMES2] });
    assert.deepEqual(h.fns._ntFindIncompleteFillRow(h.state.rows), { row: 2, field: 'entry time', key: 'entry-time' });
    assert.equal(await h.fns._ntCommitTrade({ explicit: true }), false);
    assert.equal(h.calls.errorBox.textContent, 'Row #2: entry time is missing.');
    assert.equal(h.calls.errorBox.style.display, '');
    assert.equal(h.g.journalData.trades.length, 1);
    assert.equal(h.calls.saved.length, 0);
    assert.deepEqual(h.calls.status, []);
    // Background autosave also stops, but shows nothing.
    const auto = ntHarness({ rows: [FULL1, NO_TIMES2] });
    assert.equal(await auto.fns._ntCommitTrade(), false);
    assert.equal(auto.calls.errorBox.textContent, '');
    assert.equal(auto.calls.saved.length, 0);
    // Save & Journal reports it too.
    const sj = ntHarness({ rows: [FULL1, NO_TIMES2] });
    assert.equal(await sj.fns._ntCommitTrade({ reportFillErrors: true }), false);
    assert.equal(sj.calls.errorBox.textContent, 'Row #2: entry time is missing.');
});

test('fills: a row with qty and times but a blank exit price is blocked', async () => {
    const h = ntHarness({ rows: [FULL1, row({ qty: '1', entryPrice: '1', entryTime: T1, exitTime: T2 })] });
    assert.equal(await h.fns._ntCommitTrade({ explicit: true }), false);
    assert.equal(h.calls.errorBox.textContent, 'Row #2: exit price is missing.');
    assert.equal(h.calls.saved.length, 0);
});

test('fills: a completely empty row is still ignored', async () => {
    const h = ntHarness({ rows: [FULL1, row({}), row({ fees: '1', entryTime: T1 })] });
    assert.equal(h.fns._ntFindIncompleteFillRow(h.state.rows), null);
    assert.equal(await h.fns._ntCommitTrade({ explicit: true }), true);
    assert.equal(h.calls.saved.length, 1);
    assert.equal(h.calls.saved[0].quantity, 1);
    assert.equal(h.calls.errorBox.textContent, '');
});

test('fills: single-fill trades skip the check and save as before; two complete rows keep fills', async () => {
    // Multiple fills off: leftover row data is never looked at.
    const single = ntHarness({ fills: false, rows: [NO_TIMES2] });
    assert.equal(await single.fns._ntCommitTrade({ explicit: true }), true);
    assert.equal(single.calls.saved.length, 1);
    assert.equal(single.calls.errorBox.textContent, '');
    const two = ntHarness({ rows: [FULL1, FULL2] });
    assert.equal(await two.fns._ntCommitTrade({ explicit: true }), true);
    assert.equal(two.calls.saved[0].quantity, 2);
    assert.equal(two.calls.saved[0].fills.length, 2);
});

test('fills: autosave created the trade from row #1; explicit save updates the same id to qty 2', async () => {
    const h = ntHarness({ rows: [FULL1] });
    assert.equal(await h.fns._ntCommitTrade(), true);
    assert.equal(h.g._ntCreatedTradeId, 555);
    assert.equal(h.g.journalData.trades.length, 2);
    // Row #2 added but unfinished: autosave waits, explicit save blocks.
    h.state.rows = [FULL1, NO_TIMES2];
    assert.equal(await h.fns._ntCommitTrade(), false);
    assert.equal(await h.fns._ntCommitTrade({ explicit: true }), false);
    // Row #2 completed: the explicit save updates trade 555 in place.
    h.state.rows = [FULL1, FULL2];
    assert.equal(await h.fns._ntCommitTrade({ explicit: true }), true);
    const created = h.g.journalData.trades.filter(t => t.id !== 1);
    assert.equal(created.length, 1);
    assert.equal(created[0].id, 555);
    assert.equal(created[0].quantity, 2);
    assert.deepEqual(h.calls.saved.map(t => [t.id, t.quantity]), [[555, 1], [555, 2]]);
});

// Batch C2: the old Edit Trade page (C/D: its Delete button and fill rows) was
// removed. Delete is covered by A above; fill rows and split on Trade
// Reflection are covered in batch-c1.test.js and batch-c2.test.js.
