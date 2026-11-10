// Trade Reflection open-trade fix (bug seen live 2026-10-24): viewing an
// open trade saved it as closed with a fake loss.
//  A. The Reflection page saves only after a real edit, keeps an open trade
//     open unless both exit fields are entered, and leaves stored execution
//     fields alone on a reflection-only save.
//  B. New Trade saves exitTime null when the exit price is blank.
//
// Same approach as trade-form-fixes.test.js: the real functions are cut out
// of the source and run inside a `with` scope where unknown globals are inert.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'Denarii.js'), 'utf8');
const JNL = fs.readFileSync(path.join(__dirname, '..', 'js', 'pages', 'journal.js'), 'utf8');

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

function sandbox(src, fnNames, vals) {
    const code = fnNames.map(n => extractFunction(src, n)).join('\n');
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

// Module-level constants, taken from journal.js so the test follows the source.
const JNL_CONSTS = new Function(
    JNL.match(/var _JNL_EXEC_IDS[\s\S]*?var _JNL_PNL_IDS\s*=[^;]*;/)[0] +
    '\nreturn { _JNL_EXEC_IDS: _JNL_EXEC_IDS, _JNL_PNL_IDS: _JNL_PNL_IDS };')();

function makeDocument() {
    const els = {};
    const mk = id => ({
        id, value: '', style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false,
        listeners: {}, parentNode: null,
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        querySelector: () => null, querySelectorAll: () => [], focus() {}, click() {}, remove() {},
    });
    return {
        els,
        getElementById: id => (els[id] = els[id] || mk(id)),
        querySelectorAll: () => [],
        createElement: () => mk(''),
    };
}

const JNL_FNS = ['_jnlFmtLocal', '_jnlReadExecInputs', '_jnlChanged', '_jnlShowOpenHint',
    '_jnlSideLabel', '_jnlRenderEditorHeader', '_jnlCommitTrade', '_jnlIsWebull', '_jnlScheduleCommit', '_jnlFlushCommit',
    'selectTradeForJournal'];

function jnlHarness(trade) {
    const document = makeDocument();
    const saves = [];
    const window = { _isOpenTrade: t => !t.exitTime || t.exitPrice == null, scrollTo() {} };
    const { fns, g } = sandbox(JNL, JNL_FNS, Object.assign({}, JNL_CONSTS, {
        document, window,
        journalData: { trades: [trade], brokerAccounts: [], strategies: [] },
        _jnlDirty: false, _jnlFillsDirty: false, _jnlSplitting: false, _jnlLoaded: {}, _jnlCommitTimer: null, _jnlCommitDebounceMs: 1000,
        _JNL_STATUS_ID: 'jnl-autosave-status', _jnlSelectedStrategy: null,
        _jnlLoadDraft: () => null, _jnlSaveDraft: () => {}, _jnlClearDraft: () => {},
        _jnlGetNotes: () => document.getElementById('jnl-notes').innerHTML,
        _jnlSetNotes: html => { document.getElementById('jnl-notes').innerHTML = html; },
        _jnlGetTagsFromRows: () => [], _getRowData: () => [],
        _contractMultiplier: a => (a === 'option' ? 100 : 1),
        _computeTradeMetrics: () => ({}),
        Autosave: { showStatus() {} },
        _isCloudPrimarySave: () => true,
        _saveTradeToSupabase: async t => { saves.push(JSON.parse(JSON.stringify(t))); return { success: true }; },
        _restoreTradeInPlace: () => {}, _triggerCloudDashRefresh: () => {},
        saveToIndexedDB: async () => {}, renderJournalTradeList: () => {}, updateDashboard: () => {},
    }));
    const $ = id => document.getElementById(id);
    const fire = (id, type) => $(id).listeners[type].forEach(fn => fn({ type, target: $(id) }));
    fns.selectTradeForJournal(trade.id);
    return { fns, g, saves, trade, $, fire, window };
}

const openTrade = () => ({
    id: 101, symbol: 'ZZTESTG', type: 'long', assetType: 'stock', quantity: 1,
    entryPrice: 1, exitPrice: null, entryTime: '2026-10-24T21:45:00.000Z',
    // New Trade's defaulted exit time, as stored before the fix.
    exitTime: '2026-10-24T21:46:00.000Z', pnl: null, grossPnl: null, holdSeconds: null,
    commissionFees: 0, notes: '',
});

const closedImport = () => ({
    id: 202, symbol: 'AAPL', type: 'long', assetType: 'stock', quantity: 10,
    entryPrice: 100.25, exitPrice: 101.5, entryTime: '2026-10-20T14:31:12.345Z',
    exitTime: '2026-10-20T15:02:47.891Z', holdSeconds: 1895.546, grossPnl: 12.5,
    pnl: 11.499999999999998, commissionFees: 1.0000000000000002, feeSource: 'webull', notes: '',
});

// ── A. Trade Reflection ─────────────────────────────────────────────────────

test('reflection: open trade shows Exit Time and Exit Price blank', () => {
    const h = jnlHarness(openTrade());
    assert.equal(h.$('jnl-exit-time').value, '');
    assert.equal(h.$('jnl-exit-price').value, '');
    assert.equal(h.$('journal-editor-subtitle').textContent, 'Long · Open');
});

test('reflection: open trade viewed, clicked, blurred, flushed makes no save', async () => {
    const h = jnlHarness(openTrade());
    h.fire('jnl-quantity', 'click');
    h.fire('jnl-symbol', 'click');
    assert.equal(await h.fns._jnlFlushCommit(), true);   // Back to Trades / tab hide path
    assert.equal(h.saves.length, 0);
    assert.equal(h.trade.pnl, null);
    assert.equal(h.trade.exitPrice, null);
});

test('reflection: reflection text saved on an open trade keeps it open', async () => {
    const h = jnlHarness(openTrade());
    const before = openTrade();
    h.$('jnl-notes').innerHTML = '<p>test reflection</p>';
    await h.fns._jnlCommitTrade({ explicit: true });     // Save Reflection
    assert.equal(h.saves.length, 1);
    const s = h.saves[0];
    assert.equal(s.notes, '<p>test reflection</p>');
    assert.equal(s.pnl, null);
    assert.equal(s.grossPnl, null);
    assert.equal(s.exitPrice, null);
    assert.equal(s.exitTime, before.exitTime);            // stored value untouched
    assert.equal(s.entryTime, before.entryTime);
    assert.equal(s.holdSeconds, null);
});

test('reflection: typed notes autosave on an open trade keeps it open', async () => {
    const h = jnlHarness(openTrade());
    h.$('jnl-quick-notes').value = 'note';
    h.fire('jnl-quick-notes', 'input');
    await h.fns._jnlFlushCommit();
    assert.equal(h.saves.length, 1);
    assert.equal(h.saves[0].pnl, null);
    assert.equal(h.saves[0].exitPrice, null);
});

test('reflection: exit price only on an open trade stays open and never becomes 0', async () => {
    const h = jnlHarness(openTrade());
    h.$('jnl-exit-price').value = '3';
    h.fire('jnl-exit-price', 'input');
    await h.fns._jnlFlushCommit();
    const s = h.saves[0];
    assert.equal(s.exitPrice, null);
    assert.equal(s.pnl, null);
    assert.equal(h.$('jnl-open-hint').style.display, '');
});

test('reflection: exit time only on an open trade stays open', async () => {
    const h = jnlHarness(openTrade());
    h.$('jnl-exit-time').value = '2026-10-24T18:30';
    h.fire('jnl-exit-time', 'change');
    await Promise.resolve();
    const s = h.saves[0];
    assert.equal(s.exitPrice, null);
    assert.equal(s.pnl, null);
    assert.equal(s.exitTime, openTrade().exitTime);
});

test('reflection: blank exit price on an open trade never yields a P&L', async () => {
    const h = jnlHarness(openTrade());
    h.$('jnl-exit-time').value = '2026-10-24T18:30';
    h.$('jnl-exit-price').value = '';
    await h.fns._jnlCommitTrade({ explicit: true });
    assert.equal(h.saves[0].exitPrice, null);
    assert.equal(h.saves[0].pnl, null);
});

test('reflection: both exit fields close the trade with correct P&L', async () => {
    const h = jnlHarness(openTrade());
    h.$('jnl-exit-price').value = '3';
    h.$('jnl-exit-time').value = '2026-10-24T18:30';
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.saves[0];
    assert.equal(s.exitPrice, 3);
    assert.equal(s.exitTime, new Date('2026-10-24T18:30').toISOString());
    assert.equal(s.exitTime, '2026-10-24T22:30:00.000Z');
    assert.equal(s.pnl, 2);
    assert.equal(s.holdSeconds, 45 * 60);
    assert.equal(h.$('jnl-open-hint').style.display, 'none');
});

test('reflection: closing an open option uses the 100x multiplier', async () => {
    const t = Object.assign(openTrade(), { assetType: 'option', entryPrice: 1.2, exitTime: null });
    const h = jnlHarness(t);
    h.$('jnl-exit-price').value = '1.5';
    h.$('jnl-exit-time').value = '2026-10-24T18:30';
    await h.fns._jnlCommitTrade({ explicit: true });
    assert.equal(Math.round(h.saves[0].pnl * 100) / 100, 30);
});

test('reflection: closed trade re-saved keeps exact stored times, P&L and feeSource', async () => {
    const h = jnlHarness(closedImport());
    const before = closedImport();
    assert.equal(h.$('jnl-exit-time').value, '2026-10-20T11:02');
    h.$('jnl-notes').innerHTML = '<p>lesson</p>';
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.saves[0];
    for (const k of ['entryTime', 'exitTime', 'holdSeconds', 'pnl', 'grossPnl',
                     'commissionFees', 'feeSource', 'entryPrice', 'exitPrice', 'quantity']) {
        assert.equal(s[k], before[k], k);
    }
});

test('reflection: closed trade with an edited exit price recomputes P&L', async () => {
    const h = jnlHarness(closedImport());
    h.$('jnl-exit-price').value = '102.5';
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.saves[0];
    assert.equal(s.exitPrice, 102.5);
    assert.equal(Math.round(s.pnl * 100) / 100, 21.5);
    assert.equal(s.exitTime, closedImport().exitTime);    // time not edited, kept exactly
});

test('reflection: Webull open trade (webullPartials) saved for reflection keeps pnl null', async () => {
    const t = Object.assign(openTrade(), {
        id: 303, exitTime: null, source: 'webull', entryTime: '2026-10-22T13:35:09.120Z',
        webullPartials: [{ fillId: 'p1', qty: 1, price: 1 }],
    });
    const h = jnlHarness(t);
    h.$('jnl-notes').innerHTML = '<p>webull note</p>';
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.saves[0];
    assert.equal(s.pnl, null);
    assert.equal(s.exitTime, null);
    assert.equal(s.entryTime, '2026-10-22T13:35:09.120Z');
    assert.deepEqual(s.webullPartials, t.webullPartials);
});

test('reflection: grade pill click counts as an edit, plain field click does not', async () => {
    const h = jnlHarness(closedImport());
    h.fire('jnl-quantity', 'click');
    await h.fns._jnlFlushCommit();
    assert.equal(h.saves.length, 0);
    h.fire('jnl-grade-pills', 'click');
    await Promise.resolve();
    assert.equal(h.saves.length, 1);
});

test('reflection: date display matches the stored local date', () => {
    const { fns } = sandbox(JNL, ['_jnlFmtLocal'], {});
    assert.equal(fns._jnlFmtLocal('2026-10-24T21:45:00.000Z'), '2026-10-24T17:45');  // 5:45 PM EDT
    assert.equal(fns._jnlFmtLocal('2026-10-25T03:30:00.000Z'), '2026-10-24T23:30');  // late evening stays 10/24
    assert.equal(fns._jnlFmtLocal('2026-10-24T04:15:00.000Z'), '2026-10-24T00:15');  // just after midnight
    assert.equal(fns._jnlFmtLocal(null), '');
    // Round-trip through a datetime-local value gives the same instant (to the minute).
    assert.equal(new Date(fns._jnlFmtLocal('2026-10-24T21:45:00.000Z')).toISOString(), '2026-10-24T21:45:00.000Z');
});

// ── B. New Trade: no exit price saves exitTime null ─────────────────────────

function ntHarness(fields) {
    const document = makeDocument();
    const base = {
        'entry-price': '1', 'exit-price': '', quantity: '1', 'trade-type': 'long',
        'commission-fees': '', 'entry-time': '2026-10-24T17:45', 'exit-time': '2026-10-24T17:46',
        'asset-type': 'stock', symbol: 'zztesth', 'trade-broker-account': '', 'setup-type': '',
        'quick-notes': '',
    };
    Object.entries(Object.assign(base, fields)).forEach(([id, v]) => { document.getElementById(id).value = v; });
    // _roundTradeForSave (Batch B) is a no-op here: WebullSync is not loaded.
    const { fns } = sandbox(APP, ['_ntBuildTrade', '_contractMultiplier', '_roundTradeForSave'], {
        WebullSync: undefined,
        document, _ntFillsEnabled: false, selectedStrategyForTrade: null, followedRules: [],
        _getRowData: () => [], _computeTradeMetrics: () => ({}),
        _ntGetTagsFromRows: () => [], _ntGetNotes: () => '', finalizeTradeSummary: t => t,
    });
    return fns;
}

test('new trade: blank exit price saves exitTime null and pnl null', () => {
    const t = ntHarness({})._ntBuildTrade(1);
    assert.equal(t.exitPrice, null);
    assert.equal(t.exitTime, null);
    assert.equal(t.pnl, null);
    assert.equal(t.holdSeconds, null);
    assert.equal(t.entryTime, new Date('2026-10-24T17:45').toISOString());
});

test('new trade: with an exit price, exit time and P&L are unchanged', () => {
    const t = ntHarness({ 'exit-price': '3' })._ntBuildTrade(1);
    assert.equal(t.exitPrice, 3);
    assert.equal(t.exitTime, new Date('2026-10-24T17:46').toISOString());
    assert.equal(t.pnl, 2);
    assert.equal(t.holdSeconds, 60);
});

test('new trade: exit price with blank exit time stays open', () => {
    const t = ntHarness({ 'exit-price': '3', 'exit-time': '' })._ntBuildTrade(1);
    assert.equal(t.exitTime, null);
    assert.equal(t.pnl, null);
});
