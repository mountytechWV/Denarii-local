// Batch C1: fill-row editing and split on the Trade Reflection page, Webull
// trades read-only, Broker Accounts cards recount when shown.
//
// Same approach as reflection-open-trade.test.js: the real functions are cut
// out of the source and run inside a `with` scope where unknown globals are
// inert. Fill rows are given as the raw values the page serializes, so the
// tests exercise the real save, split and recalculation code.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP  = fs.readFileSync(path.join(ROOT, 'Denarii.js'), 'utf8');
const JNL  = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'journal.js'), 'utf8');
const SET  = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'settings.js'), 'utf8');
const BA   = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'broker-accounts.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const WebullSync = require('../js/services/webull-sync.js');

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

// parts: [[source, [function names]], ...]
function sandbox(parts, vals) {
    const names = [];
    const code = parts.map(([src, fnNames]) => {
        names.push(...fnNames);
        return fnNames.map(n => extractFunction(src, n)).join('\n');
    }).join('\n');
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
        '\nreturn {' + names.join(',') + '};\n})(); }')(scope);
    return { fns, g: target };
}

const JNL_CONSTS = new Function(
    JNL.match(/var _JNL_EXEC_IDS[\s\S]*?var _JNL_PNL_IDS\s*=[^;]*;/)[0] +
    '\nreturn { _JNL_EXEC_IDS: _JNL_EXEC_IDS, _JNL_PNL_IDS: _JNL_PNL_IDS };')();

const clone = o => JSON.parse(JSON.stringify(o));

function makeDocument(opts) {
    opts = opts || {};
    const els = {};
    const absent = new Set(opts.absent || []);
    const mk = id => ({
        id, value: '', style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false,
        className: '', listeners: {}, parentNode: null,
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        querySelector: () => null, querySelectorAll: () => [], focus() {}, click() {}, remove() {},
        closest: () => null,
    });
    return {
        els,
        getElementById: id => (absent.has(id) ? null : (els[id] = els[id] || mk(id))),
        querySelectorAll: sel => (sel === '.jnl-locked-field' ? (opts.locked || []).map(id => els[id] = els[id] || mk(id)) : []),
        createElement: () => mk(''),
    };
}

const APP_FNS = ['_fillsFromRawRows', '_splitTradeByFills', 'finalizeTradeSummary', 'deriveTradeSummaryFromFills',
    '_roundTradeForSave', '_contractMultiplier', '_restoreTradeInPlace', '_ntFindIncompleteFillRow'];
const JNL_FNS = ['_jnlIsWebull', '_jnlFillsEditable', '_jnlChanged', '_jnlReadExecInputs', '_jnlCommitTrade',
    '_jnlFlushCommit', '_jnlRawRowEmpty', '_jnlFillsMsg', '_jnlShowFillError', '_jnlClearFillError',
    'jnlSplitMarkedFills', 'jnlRequestUnlock', '_jnlRenderFillsSection', '_jnlFmtLocal', 'closeJournalEditor',
    '_jnlCanConvertToFills', '_jnlRowsEditable', '_jnlUnlocked', '_jnlRenderConvertedFills', 'jnlUseMultipleFills', 'jnlUseSingleFill'];

const isOpenTrade = t => t.exitPrice == null || !t.exitTime;

// rows: raw fill rows as typed; each may carry marked: true for Split.
function harness(trades, o) {
    o = o || {};
    const trade = trades[0];
    const document = makeDocument(o.doc);
    const calls = { saveOne: [], saveMany: [], idb: 0, selected: [], confirm: 0 };
    const rows = (o.rows || []).map(r => Object.assign({ querySelector: () => null, closest: () => null }, r));
    const { fns, g } = sandbox([[APP, APP_FNS], [JNL, JNL_FNS]], Object.assign({}, JNL_CONSTS, {
        document,
        window: { _jnlSelectedTradeId: trade.id, _isOpenTrade: isOpenTrade, scrollTo() {}, _denariiSupabaseUid: 'u' },
        console: { warn() {}, log() {}, error() {} },
        WebullSync,
        confirm: () => { calls.confirm++; return true; },
        journalData: { trades, brokerAccounts: [], strategies: [] },
        _jnlDirty: false, _jnlFillsDirty: false, _jnlFillsConverting: false, _jnlSplitting: false, _jnlCommitTimer: null,
        _jnlLoaded: {}, _JNL_STATUS_ID: 'jnl-autosave-status', _jnlSelectedStrategy: null,
        _jnlSerializeFillRows: () => rows.map(r => ({ qty: r.qty || '', entryPrice: r.entryPrice || '', exitPrice: r.exitPrice || '',
            entryTime: r.entryTime || '', exitTime: r.exitTime || '', fees: r.fees || '' })),
        _jnlFillRowEls: () => rows,
        _jnlRowMarked: r => !!r.marked,
        _jnlRenderFillsEditor: (c) => { c.innerHTML = '<div id="jnl-fills-rows"></div>'; },
        _jnlGetNotes: () => document.getElementById('jnl-notes').innerHTML,
        _jnlGetTagsFromRows: () => [], _getRowData: () => [],
        _computeTradeMetrics: () => ({}),
        _jnlRenderEditorHeader: () => {}, _jnlShowOpenHint: () => {}, _jnlRecalcMetrics: () => {},
        _jnlClearDraft: () => {},
        Autosave: { showStatus() {} },
        _isCloudPrimarySave: () => true,
        _mapArrayRow: o.mapArrayRow || (() => ({})),
        _saveTradeToSupabase: async t => { calls.saveOne.push(clone(t)); return o.saveOne || { success: true }; },
        _saveTradesToSupabase: async ts => { calls.saveMany.push(clone(ts)); return o.saveMany || { success: true }; },
        _triggerCloudDashRefresh: () => {},
        saveToIndexedDB: async () => { calls.idb++; if (o.idbThrows) throw new Error('idb'); },
        selectTradeForJournal: id => calls.selected.push(id),
        renderJournalTradeList: () => {}, updateDashboard: () => {},
    }));
    const $ = id => document.getElementById(id);
    // Form inputs as selectTradeForJournal would load them.
    $('jnl-trade-type').value = trade.type || 'long';
    $('jnl-asset-type').value = trade.assetType || 'stock';
    $('jnl-symbol').value = trade.symbol;
    $('jnl-quantity').value = String(trade.quantity ?? '');
    $('jnl-entry-price').value = String(trade.entryPrice ?? '');
    $('jnl-exit-price').value = trade.exitPrice == null ? '' : String(trade.exitPrice);
    $('jnl-commission-fees').value = String(trade.commissionFees ?? '');
    g._jnlLoaded = fns._jnlReadExecInputs();
    return { fns, g, calls, trade, rows, $, document };
}

const T0 = '2026-10-20T14:30';
const T1 = '2026-10-20T15:00';
const fill = (q, ep, xp, fees) => ({
    quantity: q, entryPrice: ep, exitPrice: xp, entryTime: new Date(T0).toISOString(),
    exitTime: new Date(T1).toISOString(), commissionFees: fees, pnl: (xp - ep) * q - fees,
});
const raw = (q, ep, xp, fees, extra) => Object.assign({
    qty: String(q), entryPrice: String(ep), exitPrice: String(xp), entryTime: T0, exitTime: T1, fees: String(fees),
}, extra || {});

function groupedTrade(extra) {
    const fills = [fill(10, 10, 11, 0.333), fill(10, 10.1, 11, 0.333), fill(10, 10.2, 11, 0.333)];
    return Object.assign({
        id: 501, symbol: 'ZZTEST1', type: 'long', assetType: 'stock', source: 'manual', brokerAccountId: 'pelosi',
        quantity: 30, entryPrice: 10.1, exitPrice: 11, entryTime: fills[0].entryTime, exitTime: fills[0].exitTime,
        commissionFees: 0.999, pnl: 26.001, fills, notes: '<p>kept</p>', tags: ['x'], tradeGrade: 'A',
    }, extra || {});
}
const threeRaw = () => [raw(10, 10, 11, 0.333), raw(10, 10.1, 11, 0.333), raw(10, 10.2, 11, 0.333)];

// ── Fill edits ──────────────────────────────────────────────────────────────

test('fill edit: recalculates totals from fills and saves them rounded', async () => {
    const rows = threeRaw();
    rows[1].exitPrice = '11.555';
    const h = harness([groupedTrade()], { rows });
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    assert.equal(await h.fns._jnlCommitTrade({ explicit: true }), true);
    assert.equal(h.calls.saveOne.length, 1);
    const s = h.calls.saveOne[0];
    assert.equal(s.fills.length, 3);
    assert.equal(s.fills[1].exitPrice, 11.555);
    assert.equal(s.quantity, 30);
    assert.equal(s.entryPrice, 10.1);
    assert.equal(s.exitPrice, 11.185);                      // (11 + 11.555 + 11) / 3
    assert.equal(s.commissionFees, 1);                      // 0.999 → cents
    assert.equal(s.pnl, Math.round(((1 + 1.455 + 0.8) * 10 - 0.999) * 100) / 100);
    assert.equal(Math.round(s.pnl * 100), s.pnl * 100);     // cents
    assert.equal(h.g._jnlFillsDirty, false);
});

test('fill edit: viewing and flushing without edits makes no save', async () => {
    const h = harness([groupedTrade()], { rows: threeRaw() });
    assert.equal(await h.fns._jnlFlushCommit(), true);
    assert.equal(h.calls.saveOne.length, 0);
    assert.equal(h.calls.saveMany.length, 0);
});

test('fill edit: a reflection-only save leaves fills and totals as stored', async () => {
    const rows = threeRaw();
    rows[0].qty = '99';                                     // differs, but not marked as a fill edit
    const t = groupedTrade();
    const h = harness([t], { rows });
    h.$('jnl-notes').innerHTML = '<p>new</p>';
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.calls.saveOne[0];
    assert.deepEqual(s.fills, groupedTrade().fills.map(f => WebullSync.roundTrade({ fills: [f] }).fills[0]));
    assert.equal(s.quantity, 30);
    assert.equal(s.notes, '<p>new</p>');
});

test('fill edit: partly filled row blocks save with "Row #N: field is missing."', async () => {
    const rows = threeRaw().concat([{ qty: '5' }]);
    const h = harness([groupedTrade()], { rows });
    const before = clone(h.trade);
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    assert.equal(await h.fns._jnlCommitTrade({ explicit: true }), false);
    assert.equal(h.$('jnl-fills-error').textContent, 'Row #4: entry price is missing.');
    assert.equal(h.calls.saveOne.length, 0);
    assert.deepEqual(h.trade, before);
    assert.equal(h.g._jnlDirty, true);                      // still unsaved
});

// Batch C2: ported from the removed Edit Trade tests (trade-form-fixes.test.js).
test('fill edit: background autosave with a partly filled row writes nothing and shows nothing', async () => {
    const rows = threeRaw().concat([{ qty: '5' }]);
    const h = harness([groupedTrade()], { rows });
    const before = clone(h.trade);
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    assert.equal(await h.fns._jnlCommitTrade(), false);
    assert.equal(await h.fns._jnlFlushCommit(), false);
    assert.equal(h.$('jnl-fills-error').textContent, '');
    assert.equal(h.calls.saveOne.length, 0);
    assert.equal(h.calls.idb, 0);
    assert.deepEqual(h.trade, before);
});

// Batch C2: ported. Edit Trade's Back stayed open on a partial row; Reflection's
// Back to Trades closes, saves nothing and keeps the draft so the edit comes back.
test('fill edit: Back to Trades with a partly filled row saves nothing and keeps the draft', async () => {
    const rows = threeRaw().concat([{ qty: '5' }]);
    const h = harness([groupedTrade()], { rows });
    const before = clone(h.trade);
    const cleared = [];
    h.g._jnlClearDraft = id => cleared.push(id);
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    h.fns.closeJournalEditor();
    await new Promise(r => setImmediate(r));
    assert.equal(h.calls.saveOne.length, 0);
    assert.deepEqual(cleared, []);
    assert.deepEqual(h.trade, before);
});

test('fill edit: a fully empty row is ignored', async () => {
    const rows = threeRaw().concat([{}]);
    const h = harness([groupedTrade()], { rows });
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    assert.equal(await h.fns._jnlCommitTrade({ explicit: true }), true);
    assert.equal(h.calls.saveOne[0].fills.length, 3);
});

test('fill edit: a failed cloud save restores the trade and keeps the edit dirty', async () => {
    const rows = threeRaw();
    rows[0].qty = '20';
    const h = harness([groupedTrade()], { rows, saveOne: { success: false, error: 'x' } });
    const before = clone(h.trade);
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    assert.equal(await h.fns._jnlCommitTrade({ explicit: true }), false);
    assert.deepEqual(h.trade, before);
    assert.equal(h.g._jnlFillsDirty, true);
    assert.equal(h.g._jnlDirty, true);
});

// ── Split ───────────────────────────────────────────────────────────────────

test('split: marked rows become one new trade; the original keeps the rest', async () => {
    const rows = threeRaw();
    rows[2].marked = true;
    const h = harness([groupedTrade(), { id: 777, symbol: 'OTHER' }], { rows });
    await h.fns.jnlSplitMarkedFills();
    assert.equal(h.calls.saveMany.length, 1);
    const [u, c] = h.calls.saveMany[0];
    assert.equal(u.id, 501);
    assert.equal(u.fills.length, 2);
    assert.equal(u.quantity, 20);
    assert.equal(u.entryPrice, 10.05);
    assert.equal(u.notes, '<p>kept</p>');
    assert.notEqual(c.id, 501);
    assert.equal(c.symbol, 'ZZTEST1');
    assert.equal(c.brokerAccountId, 'pelosi');
    assert.equal(c.source, 'manual');
    assert.equal(c.fills.length, 1);
    assert.equal(c.quantity, 10);
    assert.equal(c.entryPrice, 10.2);
    assert.equal(c.pnl, 7.67);                              // (11 - 10.2) * 10 - 0.333, rounded
    assert.equal(c.notes, undefined);
    assert.equal(c.externalId, undefined);
    assert.equal(h.g.journalData.trades.length, 3);
    assert.equal(h.trade.quantity, 20);                     // updated in place
    assert.deepEqual(h.calls.selected, [501]);
    assert.equal(h.calls.idb, 1);
});

test('split: ticking every row is blocked and saves nothing', async () => {
    const rows = threeRaw().map(r => Object.assign(r, { marked: true }));
    const h = harness([groupedTrade()], { rows });
    await h.fns.jnlSplitMarkedFills();
    assert.equal(h.calls.saveMany.length, 0);
    assert.equal(h.calls.confirm, 0);
    assert.equal(h.$('jnl-fills-error').textContent, 'Leave at least one row on this trade.');
});

test('split: a cloud failure changes nothing', async () => {
    const rows = threeRaw();
    rows[0].marked = true;
    const h = harness([groupedTrade()], { rows, saveMany: { success: false, error: 'offline' } });
    const before = clone(h.g.journalData.trades);
    await h.fns.jnlSplitMarkedFills();
    assert.equal(h.calls.saveMany.length, 1);
    assert.deepEqual(h.g.journalData.trades, before);
    assert.equal(h.calls.idb, 0);
    assert.equal(h.calls.selected.length, 0);
    assert.match(h.$('jnl-fills-error').textContent, /Nothing was changed/);
    assert.equal(h.g._jnlSplitting, false);
});

test('split: a row that fails to map stops the save; nothing changes', async () => {
    const rows = threeRaw();
    rows[0].marked = true;
    const h = harness([groupedTrade()], { rows, mapArrayRow: (u, tbl, t) => (t.id === 501 ? {} : null) });
    const before = clone(h.g.journalData.trades);
    await h.fns.jnlSplitMarkedFills();
    assert.equal(h.calls.saveMany.length, 0);
    assert.deepEqual(h.g.journalData.trades, before);
});

test('split: cloud saved but local save fails keeps the split', async () => {
    const rows = threeRaw();
    rows[0].marked = true;
    const h = harness([groupedTrade()], { rows, idbThrows: true });
    await h.fns.jnlSplitMarkedFills();
    assert.equal(h.g.journalData.trades.length, 2);
    assert.equal(h.trade.quantity, 20);
});

test('split: an incomplete row blocks the split', async () => {
    const rows = threeRaw().concat([{ qty: '5', marked: true }]);
    rows[0].marked = true;
    const h = harness([groupedTrade()], { rows });
    await h.fns.jnlSplitMarkedFills();
    assert.equal(h.calls.saveMany.length, 0);
    assert.equal(h.$('jnl-fills-error').textContent, 'Row #4: entry price is missing.');
});

// ── Webull trades ───────────────────────────────────────────────────────────

const webullTrade = () => groupedTrade({ id: 601, symbol: 'MSFT', source: 'webull', externalId: 'wb-1', externalOrderIds: ['o1'] });

test('webull: fills are not editable and the panel shows the note', () => {
    const h = harness([webullTrade()]);
    assert.equal(h.fns._jnlFillsEditable(h.trade), false);
    assert.equal(h.fns._jnlFillsEditable(groupedTrade()), true);
    const ext = groupedTrade({ source: 'manual', externalId: 'wb-2' });
    assert.equal(h.fns._jnlFillsEditable(ext), false);
    h.fns._jnlRenderFillsSection(h.trade);
    const html = h.$('jnl-fills-section').innerHTML;
    assert.match(html, /Fills come from Webull and can't be edited/);
    assert.doesNotMatch(html, /jnl-fills-rows/);
});

test('webull: without cached fills the note still shows', () => {
    const t = webullTrade(); delete t.fills;
    const h = harness([t]);
    h.fns._jnlRenderFillsSection(t);
    assert.match(h.$('jnl-fills-section').innerHTML, /Fills come from Webull/);
});

test('webull: a commit never rewrites fills, and split does nothing', async () => {
    const rows = threeRaw();
    rows[0].qty = '50'; rows[1].marked = true;
    const h = harness([webullTrade()], { rows });
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    await h.fns._jnlCommitTrade({ explicit: true });
    assert.deepEqual(h.calls.saveOne[0].fills.map(f => f.quantity), [10, 10, 10]);
    await h.fns.jnlSplitMarkedFills();
    assert.equal(h.calls.saveMany.length, 0);
});

test('webull: Unlock Fields keeps quantity, prices, times and fees locked', () => {
    const locked = ['jnl-symbol', 'jnl-setup-type'].concat(JNL_CONSTS._JNL_EXEC_IDS);
    const h = harness([webullTrade()], { doc: { locked, absent: ['jnl-fills-rows'] } });
    h.g.confirm = () => true;
    locked.forEach(id => { h.$(id).disabled = true; });
    h.fns.jnlRequestUnlock();
    JNL_CONSTS._JNL_EXEC_IDS.forEach(id => assert.equal(h.$(id).disabled, true, id));
    assert.equal(h.$('jnl-symbol').disabled, false);
});

test('webull: changed execution inputs are not saved', async () => {
    const h = harness([webullTrade()]);
    h.$('jnl-quantity').value = '99';
    h.$('jnl-entry-price').value = '1';
    h.$('jnl-commission-fees').value = '5';
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.calls.saveOne[0];
    assert.equal(s.quantity, 30);
    assert.equal(s.entryPrice, 10.1);
    assert.equal(s.commissionFees, 1);
});

test('non-webull trade without fills: Unlock opens the execution fields', () => {
    const locked = ['jnl-symbol'].concat(JNL_CONSTS._JNL_EXEC_IDS);
    const t = groupedTrade(); delete t.fills;
    const h = harness([t], { doc: { locked, absent: ['jnl-fills-rows'] } });
    h.g.confirm = () => true;
    h.fns.jnlRequestUnlock();
    JNL_CONSTS._JNL_EXEC_IDS.forEach(id => assert.equal(h.$(id).disabled, false, id));
});

test('trade with editable fills: Unlock keeps the six totals locked', () => {
    const locked = ['jnl-symbol'].concat(JNL_CONSTS._JNL_EXEC_IDS);
    const h = harness([groupedTrade()], { doc: { locked } });
    h.g.confirm = () => true;
    h.fns.jnlRequestUnlock();
    JNL_CONSTS._JNL_EXEC_IDS.forEach(id => assert.equal(h.$(id).disabled, true, id));
});

// ── Open trades ─────────────────────────────────────────────────────────────

test('open trade with fills: no editor, and it stays open on save', async () => {
    const t = groupedTrade({ exitPrice: null, exitTime: null, pnl: null });
    const h = harness([t], { rows: threeRaw() });
    assert.equal(h.fns._jnlFillsEditable(t), false);
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    h.$('jnl-notes').innerHTML = '<p>r</p>';
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.calls.saveOne[0];
    assert.equal(s.exitTime, null);
    assert.equal(s.exitPrice, null);
    assert.equal(s.pnl, null);
});

test('trade without cached fills: no editor, and viewing saves nothing', async () => {
    const t = groupedTrade(); delete t.fills;
    const h = harness([t]);
    assert.equal(h.fns._jnlFillsEditable(t), false);
    h.fns._jnlRenderFillsSection(t);
    assert.equal(await h.fns._jnlFlushCommit(), true);
    assert.equal(h.calls.saveOne.length, 0);
});

// ── Shared helpers ──────────────────────────────────────────────────────────

test('helpers: _fillsFromRawRows is option- and short-aware and skips empty rows', () => {
    const { fns } = sandbox([[APP, ['_fillsFromRawRows', '_contractMultiplier']]], {});
    const f = fns._fillsFromRawRows([raw(1, 2, 3, 1), {}], 'long', 'option');
    assert.equal(f.length, 1);
    assert.equal(f[0].pnl, 99);
    assert.equal(fns._fillsFromRawRows([raw(1, 3, 2, 0)], 'short', 'stock')[0].pnl, 1);
});

test('helpers: _splitTradeByFills does not change the trade passed in', () => {
    const { fns } = sandbox([[APP, APP_FNS]], { WebullSync });
    const t = groupedTrade();
    const before = clone(t);
    const parts = fns._splitTradeByFills(t, t.fills, [0], 9);
    assert.deepEqual(t, before);
    assert.equal(parts.created.id, 9);
    assert.equal(fns._splitTradeByFills(t, t.fills, [0, 1, 2], 9), null);
    assert.equal(fns._splitTradeByFills(t, t.fills, [], 9), null);
});

// ── Broker Accounts cards ───────────────────────────────────────────────────

test('broker cards: showing the Broker Accounts tab re-renders the cards', () => {
    let renders = 0;
    const { fns } = sandbox([[SET, ['switchSettingsTab']]], {
        document: { querySelectorAll: () => [] },
        window: { renderBrokerAccountsList: () => { renders++; } },
    });
    fns.switchSettingsTab('settings-profile');
    assert.equal(renders, 0);
    fns.switchSettingsTab('settings-broker-accounts');
    assert.equal(renders, 1);
});

test('broker cards: the count follows the current trades after a delete', () => {
    const journalData = { trades: [{ brokerAccountId: 'p' }, { brokerAccountId: 'p' }, { brokerAccountId: 'w' }] };
    const { fns } = sandbox([[BA, ['getTradeCountForAccount']]], { journalData });
    assert.equal(fns.getTradeCountForAccount('p'), 2);
    journalData.trades.splice(0, 1);
    assert.equal(fns.getTradeCountForAccount('p'), 1);
});

test('broker cards: the end of a Webull run re-renders the cards', () => {
    const body = extractFunction(BA, '_wbOnStatus');
    const i = body.indexOf("ev.kind === 'run'");
    assert.ok(i > 0 && body.indexOf('renderBrokerAccountsList()', i) > i);
});

test('index.html: cache-bust versions bumped for C1', () => {
    // At least the C1 version (later batches bump it again).
    const m = /src="Denarii\.js\?v=(\d+)"/.exec(HTML);
    assert.ok(m && Number(m[1]) >= 43);
    assert.ok(Number(/src="js\/pages\/journal\.js\?v=(\d+)"/.exec(HTML)[1]) >= 10);
    assert.ok(Number(/src="js\/pages\/settings\.js\?v=(\d+)"/.exec(HTML)[1]) >= 6);
    assert.ok(Number(/src="js\/pages\/broker-accounts\.js\?v=(\d+)"/.exec(HTML)[1]) >= 9);
});

// ── Batch D1: fills survive a cloud load ────────────────────────────────────

const { _mapArrayRow: _d1Map, _mapSupabaseTradeRow: _d1Load } = require('./helpers/auth-mappers.js');
// Save through the real mapper and load back as a fresh browser does
// (JSON transport, TEXT id column).
const viaCloud = t => { const r = JSON.parse(JSON.stringify(_d1Map('U', 'trades', t))); r.id = String(r.id); return _d1Load(r); };

test('D1: a grouped trade loaded from the cloud keeps its fills and its fill editor', () => {
    const t = viaCloud(groupedTrade());
    assert.equal(t.fills.length, 3);
    assert.equal(t.type, 'long');
    const h = harness([t]);
    assert.equal(h.fns._jnlFillsEditable(t), true);
    h.fns._jnlRenderFillsSection(t);
    assert.match(h.$('jnl-fills-section').innerHTML, /jnl-fills-rows/);
});

test('D1: split works on a trade loaded from the cloud, and both halves map with fills', async () => {
    const rows = threeRaw();
    rows[2].marked = true;
    const h = harness([viaCloud(groupedTrade())], { rows });
    await h.fns.jnlSplitMarkedFills();
    assert.equal(h.calls.saveMany.length, 1);
    const [u, c] = h.calls.saveMany[0];
    assert.equal(u.id, '501');
    assert.equal(u.quantity, 20);
    assert.equal(c.quantity, 10);
    assert.equal(_d1Map('U', 'trades', u).fills.length, 2);
    assert.equal(_d1Map('U', 'trades', c).fills.length, 1);
});

test('D1: a Webull trade loaded from the cloud shows the note, not the editor', () => {
    const t = viaCloud(webullTrade());
    assert.equal(t.fills.length, 3);
    const h = harness([t]);
    assert.equal(h.fns._jnlFillsEditable(t), false);
    h.fns._jnlRenderFillsSection(t);
    assert.match(h.$('jnl-fills-section').innerHTML, /Fills come from Webull/);
    assert.doesNotMatch(h.$('jnl-fills-section').innerHTML, /jnl-fills-rows/);
});

// ── Use Multiple Fills on a saved single-fill trade ─────────────────────────

function singleTrade(extra) {
    return Object.assign({
        id: 601, symbol: 'CCCC', type: 'long', assetType: 'stock', source: 'manual', brokerAccountId: 'pelosi',
        quantity: 20, entryPrice: 2, exitPrice: 6, entryTime: new Date(T0).toISOString(), exitTime: new Date(T1).toISOString(),
        commissionFees: 0, grossPnl: 80, pnl: 80, notes: '<p>kept</p>', tags: [], tradeGrade: '',
    }, extra || {});
}
// Records what the (stubbed) editor was asked to draw.
function convHarness(trade, o) {
    const h = harness([trade], o);
    h.drawn = [];
    h.g._jnlRenderFillsEditor = (c, t) => { h.drawn.push(clone(t)); c.innerHTML = '<div id="jnl-fills-rows"></div>'; };
    h.unlock = () => { h.$('jnl-unlock-btn').disabled = true; };
    h.section = () => h.$('jnl-fills-section').innerHTML;
    return h;
}

test('convert: a closed manual trade without fills shows "Use Multiple Fills" only after Unlock Fields', () => {
    const h = convHarness(singleTrade());
    h.fns._jnlRenderFillsSection(h.trade);
    assert.ok(!h.section().includes('jnlUseMultipleFills()'));
    h.fns.jnlRequestUnlock();
    assert.ok(h.section().includes('jnlUseMultipleFills()'));
    assert.ok(h.section().includes('Use Multiple Fills'));
    assert.equal(h.drawn.length, 0);
});

test('convert: no button for Webull, open or already-filled trades', () => {
    for (const t of [singleTrade({ source: 'webull', externalId: 'wb-1' }),
                     singleTrade({ exitPrice: null, exitTime: null, pnl: null })]) {
        const h = convHarness(t);
        h.unlock();
        h.fns._jnlRenderFillsSection(t);
        assert.ok(!h.section().includes('jnlUseMultipleFills()'));
        assert.equal(h.fns._jnlCanConvertToFills(t), false);
    }
    const g = convHarness(groupedTrade());
    g.unlock();
    g.fns._jnlRenderFillsSection(g.trade);
    assert.equal(g.drawn.length, 1);
    assert.equal(g.drawn[0].fills.length, 3);              // the unchanged editor on the real fills
    assert.ok(!g.section().includes('jnlUseMultipleFills()'));
});

test('convert: the button shows row #1 from the trade, changes nothing and saves nothing', async () => {
    const t = singleTrade();
    const before = clone(t);
    const h = convHarness(t);
    h.unlock();
    await h.fns.jnlUseMultipleFills();
    assert.equal(h.g._jnlFillsConverting, true);
    assert.equal(h.drawn.length, 1);
    assert.deepEqual(h.drawn[0].fills, [{ quantity: 20, entryPrice: 2, exitPrice: 6,
        entryTime: before.entryTime, exitTime: before.exitTime, commissionFees: 0 }]);
    assert.deepEqual(t, before);                            // the trade object is untouched
    assert.equal(h.$('jnl-quantity').value, '20');          // summary inputs unchanged ...
    for (const id of JNL_CONSTS._JNL_EXEC_IDS) assert.equal(h.$(id).disabled, true, id);   // ... and locked
    assert.equal(h.g._jnlDirty, false);
    assert.equal(h.g._jnlFillsDirty, false);
    assert.equal(await h.fns._jnlFlushCommit(), true);       // viewing / leaving saves nothing
    assert.equal(h.calls.saveOne.length, 0);
});

test('convert: needs Unlock Fields and a convertible trade; a second click does nothing', async () => {
    const h = convHarness(singleTrade());
    await h.fns.jnlUseMultipleFills();                      // still locked
    assert.equal(h.g._jnlFillsConverting, false);
    h.unlock();
    await h.fns.jnlUseMultipleFills();
    await h.fns.jnlUseMultipleFills();
    assert.equal(h.drawn.length, 1);
    const w = convHarness(singleTrade({ source: 'webull', externalId: 'wb-1' }));
    w.unlock();
    await w.fns.jnlUseMultipleFills();
    assert.equal(w.g._jnlFillsConverting, false);
});

test('convert: unsaved top-field edits are saved first; row #1 comes from the saved trade', async () => {
    const h = convHarness(singleTrade());
    h.unlock();
    h.$('jnl-exit-price').value = '7';
    await h.fns.jnlUseMultipleFills();
    assert.equal(h.calls.saveOne.length, 1);
    assert.equal(h.calls.saveOne[0].exitPrice, 7);
    assert.equal(h.calls.saveOne[0].fills, undefined);      // that save is a plain edit, no fills
    assert.equal(h.drawn[0].fills[0].exitPrice, 7);
    assert.equal(h.g._jnlFillsConverting, true);
});

test('convert: if saving the top-field edits fails, nothing is converted', async () => {
    const t = singleTrade();
    const h = convHarness(t, { saveOne: { success: false, error: 'boom' } });
    h.unlock();
    h.$('jnl-exit-price').value = '7';
    await h.fns.jnlUseMultipleFills();
    assert.equal(h.g._jnlFillsConverting, false);
    assert.equal(h.drawn.length, 0);
    assert.equal(t.exitPrice, 6);
});

test('convert: the first row edit saves fills in the existing shape, totals from the rows', async () => {
    const t = singleTrade();
    const h = convHarness(t, { rows: [raw(10, 2, 6, 0), raw(10, 2, 8, 0)] });
    h.unlock();
    await h.fns.jnlUseMultipleFills();
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;        // typed in the rows
    assert.equal(await h.fns._jnlCommitTrade(), true);
    const s = h.calls.saveOne[0];
    assert.equal(s.fills.length, 2);
    assert.deepEqual(Object.keys(s.fills[0]).sort(),
        ['commissionFees', 'entryPrice', 'entryTime', 'exitPrice', 'exitTime', 'pnl', 'quantity']);
    assert.equal(s.quantity, 20);
    assert.equal(s.entryPrice, 2);
    assert.equal(s.exitPrice, 7);
    assert.equal(s.pnl, 100);
    assert.equal(h.g._jnlFillsConverting, false);           // now a normal fills trade: no undo
    assert.equal(h.fns._jnlFillsEditable(t), true);
});

test('convert: an unchanged single row saves the same totals', async () => {
    const t = singleTrade();
    const h = convHarness(t, { rows: [raw(20, 2, 6, 0)] });
    h.unlock();
    await h.fns.jnlUseMultipleFills();
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    await h.fns._jnlCommitTrade();
    const s = h.calls.saveOne[0];
    assert.equal(s.quantity, 20); assert.equal(s.entryPrice, 2); assert.equal(s.exitPrice, 6);
    assert.equal(s.pnl, 80); assert.equal(s.commissionFees, 0);
});

test('convert: a notes-only save after converting writes no fills and keeps the totals', async () => {
    const t = singleTrade();
    const h = convHarness(t, { rows: [raw(10, 2, 6, 0), raw(10, 2, 8, 0)] });
    h.unlock();
    await h.fns.jnlUseMultipleFills();
    h.$('jnl-notes').innerHTML = '<p>new</p>';
    h.g._jnlDirty = true;
    assert.equal(await h.fns._jnlCommitTrade(), true);
    const s = h.calls.saveOne[0];
    assert.equal(s.fills, undefined);
    assert.equal(s.quantity, 20); assert.equal(s.exitPrice, 6); assert.equal(s.pnl, 80);
    assert.equal(h.g._jnlFillsConverting, true);
});

test('convert: a failed save of edited rows restores the trade without fills and keeps the rows dirty', async () => {
    const t = singleTrade();
    const before = clone(t);
    const h = convHarness(t, { rows: [raw(10, 2, 6, 0), raw(10, 2, 8, 0)], saveOne: { success: false, error: 'boom' } });
    h.unlock();
    await h.fns.jnlUseMultipleFills();
    h.g._jnlFillsDirty = true; h.g._jnlDirty = true;
    assert.equal(await h.fns._jnlCommitTrade(), false);
    assert.deepEqual(t, before);
    assert.equal(h.g._jnlFillsDirty, true);
    assert.equal(h.g._jnlFillsConverting, true);
});

test('convert: Use Single Fill before the first save restores the six inputs and saves nothing', async () => {
    const t = singleTrade();
    const before = clone(t);
    const h = convHarness(t);
    h.unlock();
    await h.fns.jnlUseMultipleFills();
    h.$('jnl-quantity').value = '10';                       // as _jnlRecomputeFills writes after a row edit
    h.$('jnl-exit-price').value = '7.0000';
    h.g._jnlFillsDirty = true;
    h.fns.jnlUseSingleFill();
    assert.equal(h.g._jnlFillsConverting, false);
    assert.equal(h.g._jnlFillsDirty, false);
    assert.equal(h.$('jnl-quantity').value, '20');
    assert.equal(h.$('jnl-exit-price').value, '6');
    for (const id of JNL_CONSTS._JNL_EXEC_IDS) assert.equal(h.$(id).disabled, false, id);
    assert.ok(h.section().includes('jnlUseMultipleFills()'));   // back to the button
    assert.deepEqual(t, before);
    assert.equal(await h.fns._jnlFlushCommit(), true);
    assert.equal(h.calls.saveOne.length, 0);
});

test('convert: Use Single Fill is offered next to + Add Fill Row, and does nothing once fills are saved', async () => {
    let inserted = null;
    const addBtn = { parentNode: { insertBefore: n => { inserted = n; } } };
    const container = { innerHTML: '', querySelector: s => (s === '[onclick="jnlAddFillRow()"]' ? addBtn : null) };
    const h = convHarness(singleTrade());
    h.fns._jnlRenderConvertedFills(container, h.trade);
    assert.equal(inserted.id, 'jnl-fills-single-btn');
    assert.equal(inserted.textContent, 'Use Single Fill');
    // After the rows are saved the trade has fills: undo is refused.
    const g = convHarness(groupedTrade());
    g.g._jnlFillsConverting = true;
    g.fns.jnlUseSingleFill();
    assert.equal(g.g._jnlFillsConverting, true);
    assert.equal(g.drawn.length, 0);
});

test('convert: Split before the rows are saved shows a short message instead of failing silently', async () => {
    const h = convHarness(singleTrade(), { rows: [raw(10, 2, 6, 0), raw(10, 2, 8, 0, { marked: true })] });
    h.unlock();
    await h.fns.jnlUseMultipleFills();
    await h.fns.jnlSplitMarkedFills();
    assert.equal(h.$('jnl-fills-error').textContent, 'Saving rows... try Split again in a moment');
    assert.equal(h.calls.saveMany.length, 0);
    assert.equal(h.calls.confirm, 0);                       // no split confirm was shown
});

test('convert: opening another trade or closing the editor ends the conversion', () => {
    assert.ok(/_jnlFillsDirty = false;\s*_jnlFillsConverting = false;/.test(extractFunction(JNL, 'selectTradeForJournal')));
    assert.ok(extractFunction(JNL, 'closeJournalEditor').includes('_jnlFillsConverting = false;'));
    assert.ok(extractFunction(JNL, 'jnlBackToTrades').includes('_jnlRowsEditable(trade)'));
});
