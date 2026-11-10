// Batch A2 fixes:
//  1. Dashboard selection clears on filter/account/sort/page/tab/navigation;
//     Delete and Merge act only on visible selected trades; the Delete confirm
//     lists the count, symbols and dates.
//  2. New Trade entry/exit times start blank.
//  3. Reflection: popup under the missing exit field (autosave and Save).
//  4. Stat cards: "-$1.00" / "$2.00".
//  5. Reflection metrics: "--" for realized metrics on a stored-open trade.
//  6. Side sort uses type || direction (Reflection list and dashboard local sort).
//
// Same approach as dashboard-reflection-ui.test.js: the real functions are cut
// out of the source and run inside a `with` scope where unknown globals are inert.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP  = fs.readFileSync(path.join(ROOT, 'Denarii.js'), 'utf8');
const JNL  = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'journal.js'), 'utf8');
const CAL  = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'calendar.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

function extractBlock(src, startIdx, label) {
    let depth = 0;
    for (let i = src.indexOf('{', startIdx); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(startIdx, i + 1);
    }
    throw new Error(label + ': unbalanced braces');
}

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    const isAsync = src.slice(start - 6, start) === 'async ';
    return (isAsync ? 'async ' : '') + extractBlock(src, start, name);
}

const inert = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
});

function sandboxCode(code, names, vals) {
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

function sandbox(src, fnNames, vals) {
    return sandboxCode(fnNames.map(n => extractFunction(src, n)).join('\n'), fnNames, vals);
}

const isOpenTrade = t => !t.exitTime || t.exitPrice == null;

// ── 1. Dashboard selection ──────────────────────────────────────────────────

const SEL_FNS = ['_dashResetSelection', '_dashSyncSelectionViewKey', '_dashTradesTabActive',
    '_dashVisibleSelectedIds', '_dashPruneToVisible', '_dashDeleteConfirmText', 'dashDeleteSelected',
    '_dashCheckMergeCompat', 'dashStartMergePicker', 'dashClearSelection', 'dashToggleTradeSelection'];

const mkTrade = (id, symbol, extra) => Object.assign({
    id, symbol, type: 'long', assetType: 'stock', brokerAccountId: 'pelosi', quantity: 1,
    entryPrice: 2, exitPrice: 1, entryTime: '2026-10-25T14:00:00.000Z',
    exitTime: '2026-10-25T14:10:00.000Z', pnl: -1,
}, extra || {});

function selHarness(opts) {
    opts = opts || {};
    const trades = opts.trades;
    const calls = { deleted: [], confirms: [], alerts: [], renders: 0 };
    const filters = { symbol: 'ZZTESTA1', brokerAccountId: 'all' };
    let activeTab = opts.tab || 'trades';
    const document = {
        querySelector: sel => (sel === '.dash-view-tab.active'
            ? { getAttribute: () => activeTab } : null),
        getElementById: () => null,
    };
    const visible = opts.visible || trades;
    const { fns, g } = sandbox(APP, SEL_FNS, {
        document,
        journalData: { trades: trades.slice(), brokerAccounts: [] },
        _dashSelectedIds: new Set(opts.selected || []),
        _dashMergePickerActive: false, _dashMergePrimaryId: null,
        _dashVisibleIds: visible.map(t => Number(t.id)),
        _dashVisibleTrades: visible,
        _dashSelectionViewKey: null,
        _dashSortField: 'exitTime', _dashSortDir: 'desc',
        _cloudDash: { page: 1 },
        _cloudDashGetFilters: () => Object.assign({}, filters),
        _isOpenTrade: isOpenTrade,
        _displaySymbol: s => s,
        confirm: m => { calls.confirms.push(m); return opts.confirm !== false; },
        alert: m => calls.alerts.push(m),
        _isCloudPrimarySave: () => true,
        _deleteTradesFromSupabase: async ids => { calls.deleted.push(ids.slice()); return { success: true }; },
        _triggerCloudDashRefresh: () => {},
        saveToIndexedDB: async () => {},
        updateDashboard: () => { calls.renders++; },
    });
    return { fns, g, calls, filters, setTab: t => { activeTab = t; } };
}

test('selection: a filter change clears it; an unchanged view keeps it', () => {
    const h = selHarness({ trades: [mkTrade(1, 'ZZTESTA1')] });
    h.fns._dashSyncSelectionViewKey(false);              // first render: baseline
    h.g._dashSelectedIds.add(1);
    h.fns._dashSyncSelectionViewKey(false);              // re-render, same view
    assert.deepEqual([...h.g._dashSelectedIds], [1]);
    h.filters.symbol = 'ZZTESTA2';                       // Symbol filter
    h.fns._dashSyncSelectionViewKey(false);
    assert.equal(h.g._dashSelectedIds.size, 0);
});

test('selection: account selector, period, sort and page changes each clear it', () => {
    const h = selHarness({ trades: [mkTrade(1, 'ZZTESTA1')] });
    h.fns._dashSyncSelectionViewKey(true);
    const steps = [
        () => { h.filters.brokerAccountId = 'pelosi'; },
        () => { h.filters.dateFrom = '2026-10-01'; },
        () => { h.g._dashSortField = 'symbol'; },
        () => { h.g._dashSortDir = 'asc'; },
        () => { h.g._cloudDash.page = 2; },
    ];
    steps.forEach((change, i) => {
        h.g._dashSelectedIds.add(1);
        h.g._dashMergePickerActive = true;
        change();
        h.fns._dashSyncSelectionViewKey(true);
        assert.equal(h.g._dashSelectedIds.size, 0, 'step ' + i);
        assert.equal(h.g._dashMergePickerActive, false, 'step ' + i);
    });
});

test('selection: toggling a row does not count as a view change', () => {
    const h = selHarness({ trades: [mkTrade(1, 'ZZTESTA1'), mkTrade(2, 'ZZTESTA1')] });
    h.fns._dashSyncSelectionViewKey(false);
    h.fns.dashToggleTradeSelection(1);
    h.fns._dashSyncSelectionViewKey(false);
    h.fns.dashToggleTradeSelection(2);
    h.fns._dashSyncSelectionViewKey(false);
    assert.deepEqual([...h.g._dashSelectedIds].sort(), [1, 2]);
});

test('selection: switchDashView clears it on every tab change and re-renders Trades', () => {
    const start = CAL.indexOf('window.switchDashView = function');
    const body = extractBlock(CAL, start, 'switchDashView');
    let resets = 0, renders = 0;
    const el = { style: {}, classList: { toggle() {} }, getAttribute: () => 'trades', value: 'all' };
    const { fns } = sandboxCode('var window = {};\n' + body + '\nvar switchDashView = window.switchDashView;',
        ['switchDashView'], {
            _dashResetSelection: () => { resets++; },
            updateDashboard: () => { renders++; },
            document: { querySelectorAll: () => [el], getElementById: () => el },
            _savedPeriod: null, _dashLastView: 'trades', _dashRememberLastView: false,
            init: () => {}, setDashPeriod: () => {},
        });
    ['calendar', 'dayview', 'weekview', 'trades'].forEach(v => fns.switchDashView(v));
    assert.equal(resets, 4);
    assert.equal(renders, 1);  // back on Trades: the cleared selection is drawn
});

test('selection: activateSection (leaving or returning to the dashboard) clears it', () => {
    let resets = 0;
    const { fns } = sandbox(APP, ['activateSection'], {
        _dashResetSelection: () => { resets++; },
    });
    fns.activateSection('trade-journal');
    fns.activateSection('dashboard');
    assert.equal(resets, 2);
});

test('delete: a stale hidden id is pruned; only the visible trade is deleted', async () => {
    const a = mkTrade(1, 'ZZTESTA2');
    const hidden = mkTrade(2, 'AMZN', { source: 'webull', brokerAccountId: 'wb' });
    const h = selHarness({ trades: [a, hidden], visible: [a], selected: [1, 2] });
    await h.fns.dashDeleteSelected();
    assert.deepEqual(h.calls.deleted, [[1]]);
    assert.ok(h.g.journalData.trades.some(t => t.id === 2), 'hidden trade kept locally');
    assert.ok(!h.g.journalData.trades.some(t => t.id === 1));
    assert.match(h.calls.confirms[0], /^Delete 1 trade\?/);
    assert.doesNotMatch(h.calls.confirms[0], /AMZN/);
});

test('delete: only a hidden id selected deletes nothing and shows no confirm', async () => {
    const a = mkTrade(1, 'ZZTESTA2');
    const hidden = mkTrade(2, 'AMZN', { source: 'webull' });
    const h = selHarness({ trades: [a, hidden], visible: [a], selected: [2] });
    await h.fns.dashDeleteSelected();
    assert.deepEqual(h.calls.deleted, []);
    assert.equal(h.calls.confirms.length, 0);
    assert.equal(h.g._dashSelectedIds.size, 0);
});

test('delete: nothing deleted while the page is loading or off the Trades tab', async () => {
    const a = mkTrade(1, 'ZZTESTA2');
    const loading = selHarness({ trades: [a], visible: [], selected: [1] });
    await loading.fns.dashDeleteSelected();
    assert.deepEqual(loading.calls.deleted, []);

    const offTab = selHarness({ trades: [a], selected: [1], tab: 'calendar' });
    await offTab.fns.dashDeleteSelected();
    assert.deepEqual(offTab.calls.deleted, []);
    assert.equal(offTab.calls.confirms.length, 0);
});

test('delete: Cancel on the confirm deletes nothing', async () => {
    const a = mkTrade(1, 'ZZTESTA2');
    const h = selHarness({ trades: [a], selected: [1], confirm: false });
    await h.fns.dashDeleteSelected();
    assert.deepEqual(h.calls.deleted, []);
    assert.equal(h.g.journalData.trades.length, 1);
});

test('delete confirm: exact count, symbol and date per trade, first 10 then "and N more"', () => {
    const trades = [];
    for (let i = 1; i <= 12; i++) trades.push(mkTrade(i, 'ZZTEST' + i));
    const h = selHarness({ trades });
    const txt = h.fns._dashDeleteConfirmText(trades.map(t => t.id));
    const lines = txt.split('\n');
    assert.equal(lines[0], 'Delete 12 trades? This cannot be undone.');
    assert.equal(lines[2], '  ZZTEST1  10/25/2026');
    assert.ok(txt.includes('ZZTEST10  10/25/2026'));
    assert.ok(!txt.includes('ZZTEST11'));
    assert.equal(lines[lines.length - 1], '  and 2 more');

    const one = h.fns._dashDeleteConfirmText([3]);
    assert.equal(one, 'Delete 1 trade? This cannot be undone.\n\n  ZZTEST3  10/25/2026');
});

test('merge picker: a stale hidden id is pruned before the compat check', () => {
    const a = mkTrade(1, 'ZZTESTM'), b = mkTrade(2, 'ZZTESTM', { entryTime: '2026-10-25T13:00:00.000Z' });
    const hidden = mkTrade(3, 'ZZTESTM');
    const h = selHarness({ trades: [a, b, hidden], visible: [a, b], selected: [1, 2, 3] });
    h.fns.dashStartMergePicker();
    assert.deepEqual([...h.g._dashSelectedIds].sort(), [1, 2]);
    assert.equal(h.g._dashMergePickerActive, true);
    assert.equal(h.g._dashMergePrimaryId, 2);   // earliest visible trade
    assert.equal(h.calls.alerts.length, 0);
});

test('merge picker: one visible + one hidden selected cannot merge', () => {
    const a = mkTrade(1, 'ZZTESTM'), hidden = mkTrade(3, 'ZZTESTM');
    const h = selHarness({ trades: [a, hidden], visible: [a], selected: [1, 3] });
    h.fns.dashStartMergePicker();
    assert.equal(h.g._dashMergePickerActive, false);
    assert.match(h.calls.alerts[0], /Select 2 or more/);
});

// ── 2. New Trade times blank ────────────────────────────────────────────────

test('new trade: no code pre-fills Entry Time or Exit Time', () => {
    assert.doesNotMatch(APP, /getElementById\('entry-time'\)\.value\s*=\s*now/);
    assert.doesNotMatch(APP, /getElementById\('exit-time'\)\.value\s*=\s*now/);
    assert.match(HTML, /<input type="datetime-local" id="entry-time" required>/);
    assert.match(HTML, /<input type="datetime-local" id="exit-time">/);
});

// ── 3. Popup under the missing exit field ───────────────────────────────────

const JNL_CONSTS = new Function(
    JNL.match(/var _JNL_EXEC_IDS[\s\S]*?var _JNL_PNL_IDS\s*=[^;]*;/)[0] +
    '\nreturn { _JNL_EXEC_IDS: _JNL_EXEC_IDS, _JNL_PNL_IDS: _JNL_PNL_IDS };')();

// Each element has its own .form-group, so the popup's placement is visible.
function makeDocument() {
    const els = {};
    const all = () => Object.values(els).flatMap(e => [e].concat(e._group.children));
    const mk = id => {
        const el = {
            id, value: '', style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false,
            listeners: {}, parentNode: null,
            addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
            setAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
            focus() {}, click() {}, remove() {}, appendChild() {},
        };
        el._group = {
            style: {}, children: [],
            appendChild(c) { c.parentNode = this; this.children.push(c); },
            removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
        };
        el.closest = sel => (sel === '.form-group' ? el._group : null);
        return el;
    };
    return {
        els,
        getElementById: id => {
            if (id === 'field-bubble') return all().find(e => e.id === id) || null;
            return (els[id] = els[id] || mk(id));
        },
        querySelectorAll: () => [],
        createElement: () => { const e = mk(''); e._group = { children: [] }; return e; },
    };
}

const JNL_FNS = ['_jnlFmtLocal', '_jnlReadExecInputs', '_jnlChanged', '_jnlShowOpenHint',
    '_jnlSideLabel', '_jnlFmtPnl', '_jnlRenderEditorHeader', '_jnlCommitTrade', '_jnlIsWebull',
    '_jnlScheduleCommit', '_jnlFlushCommit', '_jnlRecalcMetrics', 'selectTradeForJournal'];

function jnlHarness(trades, openId, metrics) {
    const document = makeDocument();
    const saves = [], alerts = [], applied = [];
    const window = { _isOpenTrade: isOpenTrade, scrollTo() {} };
    // The exit popup is the app's shared field bubble from Denarii.js.
    const bubble = sandbox(APP, ['_showFieldBubble', '_clearFieldBubble'], { document }).fns;
    const { fns, g } = sandbox(JNL, JNL_FNS, Object.assign({}, JNL_CONSTS, {
        document, window,
        _showFieldBubble: bubble._showFieldBubble, _clearFieldBubble: bubble._clearFieldBubble,
        console: { warn() {}, log() {}, error() {} },
        alert: m => alerts.push(m),
        setTimeout: fn => { fn(); return 1; }, clearTimeout: () => {},
        journalData: { trades, brokerAccounts: [], strategies: [] },
        _jnlDirty: false, _jnlFillsDirty: false, _jnlSplitting: false, _jnlLoaded: {}, _jnlCommitTimer: null, _jnlCommitDebounceMs: 1000,
        _JNL_STATUS_ID: 'jnl-autosave-status', _jnlSelectedStrategy: null,
        _jnlLoadDraft: () => null, _jnlSaveDraft: () => {}, _jnlClearDraft: () => {},
        _jnlGetNotes: () => document.getElementById('jnl-notes').innerHTML,
        _jnlSetNotes: html => { document.getElementById('jnl-notes').innerHTML = html; },
        _jnlGetTagsFromRows: () => [], _getRowData: () => [],
        _contractMultiplier: a => (a === 'option' ? 100 : 1),
        _computeTradeMetrics: () => Object.assign({}, metrics || {}),
        _applyMetrics: (prefix, m) => applied.push(m),
        _sfId: id => parseFloat(document.getElementById(id).value) || 0,
        Autosave: { showStatus() {} },
        _isCloudPrimarySave: () => true,
        _saveTradeToSupabase: async t => { saves.push(JSON.parse(JSON.stringify(t))); return { success: true }; },
        _restoreTradeInPlace: () => {}, _triggerCloudDashRefresh: () => {},
        saveToIndexedDB: async () => {}, renderJournalTradeList: () => {}, updateDashboard: () => {},
    }));
    const $ = id => document.getElementById(id);
    if (openId !== undefined) fns.selectTradeForJournal(openId);
    return { fns, g, saves, alerts, applied, $, document, window };
}

const openTrade = () => ({ id: 6, symbol: 'ZZTESTA3', type: 'short', quantity: 1, entryPrice: 1,
    exitPrice: null, entryTime: '2026-10-25T14:00:00.000Z', exitTime: null, pnl: null,
    commissionFees: 0, notes: '' });

const popupOf = h => h.document.getElementById('field-bubble');

test('popup: exit price only → popup under Exit Time on autosave, hint kept, no alert', async () => {
    const h = jnlHarness([openTrade()], 6);
    h.$('jnl-exit-price').value = '0.5';
    h.fns._jnlScheduleCommit();               // autosave path (timer fires immediately here)
    await new Promise(r => setImmediate(r));
    const pop = popupOf(h);
    assert.ok(pop, 'popup shown');
    assert.equal(pop.textContent, 'Exit Time is required to close this trade');
    assert.equal(pop.parentNode, h.$('jnl-exit-time')._group);
    assert.equal(h.$('jnl-exit-time')._group.style.position, 'relative');
    assert.equal(h.$('jnl-open-hint').textContent, 'Enter both exit price and exit time to close this trade.');
    assert.equal(h.alerts.length, 0);
    assert.equal(h.saves[0].exitPrice, null);
    assert.equal(h.saves[0].pnl, null);
});

test('popup: exit time only → popup under Exit Price on Save', async () => {
    const h = jnlHarness([openTrade()], 6);
    h.$('jnl-exit-time').value = '2026-10-25T10:20';
    await h.fns._jnlCommitTrade({ explicit: true });
    const pop = popupOf(h);
    assert.equal(pop.textContent, 'Exit Price is required to close this trade');
    assert.equal(pop.parentNode, h.$('jnl-exit-price')._group);
    assert.equal(h.saves[0].exitTime, null);
});

test('popup: only one popup at a time; cleared once both fields close the trade', async () => {
    const h = jnlHarness([openTrade()], 6);
    h.$('jnl-exit-price').value = '0.5';
    await h.fns._jnlCommitTrade({});
    await h.fns._jnlCommitTrade({});
    assert.equal(h.$('jnl-exit-time')._group.children.length, 1);
    h.$('jnl-exit-time').value = '2026-10-25T10:20';
    await h.fns._jnlCommitTrade({});
    assert.equal(popupOf(h), null);
    assert.equal(h.$('jnl-open-hint').style.display, 'none');
    assert.equal(h.saves[h.saves.length - 1].exitPrice, 0.5);
});

test('popup: opening another trade removes it', async () => {
    const other = Object.assign(openTrade(), { id: 7, symbol: 'ZZTESTA4' });
    const h = jnlHarness([openTrade(), other], 6);
    h.$('jnl-exit-price').value = '0.5';
    await h.fns._jnlCommitTrade({});
    assert.ok(popupOf(h));
    h.fns.selectTradeForJournal(7);
    assert.equal(popupOf(h), null);
});

// ── 4. Stat card format ─────────────────────────────────────────────────────

test('stat cards: sign before the $, no plus on positives', () => {
    const { fns } = sandbox(APP, ['_dashFmtMoney'], {});
    assert.equal(fns._dashFmtMoney(-1), '-$1.00');
    assert.equal(fns._dashFmtMoney(2), '$2.00');
    assert.equal(fns._dashFmtMoney(0), '$0.00');
    assert.equal(fns._dashFmtMoney(-241.04000000000002), '-$241.04');
    ['_mTotalPnL', '_mAvgWin', '_mAvgLoss'].forEach(v => {
        assert.ok(APP.includes('${_dashFmtMoney(' + v + ')}'), v + ' uses _dashFmtMoney');
        assert.ok(!APP.includes('$${' + v + '.toFixed(2)}'), v + ' old format gone');
    });
});

// ── 5. Metrics panel ────────────────────────────────────────────────────────

const METRICS = { netPnl: 2, realizedRMultiple: 1, runup: 1, drawdown: 0.5,
    initialTarget: 5, tradeRisk: 1, plannedRMultiple: 2, totalPlannedRisk: 1 };

test('metrics: open trade with an unsaved exit price shows -- for realized metrics', () => {
    const h = jnlHarness([openTrade()], 6, METRICS);
    h.$('jnl-exit-price').value = '0.5';
    h.applied.length = 0;
    h.fns._jnlRecalcMetrics();
    const m = h.applied[0];
    assert.equal(m.netPnl, null);
    assert.equal(m.realizedRMultiple, null);
    assert.equal(m.runup, null);
    assert.equal(m.drawdown, null);
    assert.equal(m.initialTarget, 5);        // planned metrics still shown
    assert.equal(m.plannedRMultiple, 2);
});

test('metrics: a closed trade shows realized metrics', () => {
    const closed = Object.assign(openTrade(), { exitPrice: 0.5, exitTime: '2026-10-25T14:20:00.000Z', pnl: 0.5 });
    const h = jnlHarness([closed], 6, METRICS);
    h.applied.length = 0;
    h.fns._jnlRecalcMetrics();
    assert.equal(h.applied[0].netPnl, 2);
    assert.equal(h.applied[0].runup, 1);
});

test('metrics: closing the trade by autosave then shows realized metrics', async () => {
    const h = jnlHarness([openTrade()], 6, METRICS);
    h.$('jnl-exit-price').value = '0.5';
    h.$('jnl-exit-time').value = '2026-10-25T10:20';
    h.applied.length = 0;
    await h.fns._jnlCommitTrade({});
    assert.equal(h.applied[h.applied.length - 1].netPnl, 2);
});

// ── 6. Side sort uses type || direction ─────────────────────────────────────

// The real shared filter, reading the given fake document.
function sharedFilters(document) {
    const w = {};
    new Function('window', 'document', fs.readFileSync(path.join(ROOT, 'js', 'shared', 'filter-bar.js'), 'utf8'))(w, document);
    return w.DenariiFilters;
}

test('reflection list: Side sort works for direction-only rows', () => {
    const rows = [
        { id: 1, symbol: 'ZZTESTS', direction: 'short', quantity: 1, entryPrice: 1, exitPrice: 2,
          entryTime: '2026-10-25T14:00:00.000Z', exitTime: '2026-10-25T14:10:00.000Z', pnl: -1 },
        { id: 2, symbol: 'ZZTESTL', direction: 'long', quantity: 1, entryPrice: 1, exitPrice: 2,
          entryTime: '2026-10-25T14:00:00.000Z', exitTime: '2026-10-25T14:10:00.000Z', pnl: 1 },
        { id: 3, symbol: 'ZZTESTT', type: 'long', quantity: 1, entryPrice: 1, exitPrice: 2,
          entryTime: '2026-10-25T14:00:00.000Z', exitTime: '2026-10-25T14:10:00.000Z', pnl: 1 },
    ];
    const order = dir => {
        const document = makeDocument();
        const { fns } = sandbox(JNL, ['renderJournalTradeList', '_jnlSideLabel', '_jnlFmtPnl'], {
            DenariiFilters: sharedFilters(document),
            document, window: { _isOpenTrade: isOpenTrade, _jnlSortField: 'type', _jnlSortDir: dir },
            journalData: { trades: rows.slice(), brokerAccounts: [] },
            getGlobalFilteredTrades: t => t,
            escapeHtml: v => String(v),
            _jnlListPage: 1, _jnlListPageSize: 50,
        });
        fns.renderJournalTradeList();
        const html = document.getElementById('journal-trade-list-body').innerHTML;
        return html.split('<tr').slice(1).map(r => (r.match(/ZZTEST[A-Z]/) || [''])[0]);
    };
    assert.equal(order('asc')[2], 'ZZTESTS');   // longs first, short last
    assert.equal(order('desc')[0], 'ZZTESTS');
});

test('dashboard local sort: Side reads type || direction', () => {
    const line = APP.match(/case 'type':\s+va = \(a\.type\|\|a\.direction\|\|''\);[^\n]*/);
    assert.ok(line, 'dashboard Side sort uses type || direction');
    const cmp = new Function('a', 'b', '_sd', "switch ('type') { " + line[0] + ' }');
    const short = { direction: 'short' }, long = { direction: 'long' };
    assert.ok(cmp(long, short, 'asc') < 0);
    assert.ok(cmp(long, short, 'desc') > 0);
    assert.ok(cmp({ type: 'long' }, short, 'asc') < 0);
});

// ── Cache-bust ──────────────────────────────────────────────────────────────

test('index.html: cache-bust versions bumped', () => {
    // At least the A2 versions (later batches bump them again).
    const ver = file => Number(HTML.split('src="' + file + '?v=')[1].split('"')[0]);
    assert.ok(ver('Denarii.js') >= 41);
    assert.ok(ver('js/pages/journal.js') >= 8);
    assert.ok(ver('js/pages/calendar.js') >= 7);
});
