// Dashboard trades list + Trade Reflection UI fixes:
//  1/2. Row menu Edit and row click open the trade on the Reflection page.
//  3.   Reflection list Side reads type or direction; losing P&L has a minus;
//       open trades show "Open" (Exit) and a dash (P&L).
//  4/5. Header side for cloud rows; close-trade hint under Save Reflection.
//  6.   Quick Notes editable and saved only after a real edit.
//  7.   Account column before P&L, sortable, display name.
//  Also: a cloud-loaded short (direction only) opens as Short and a price
//  edit recalculates P&L as a short.
//
// Same approach as trade-form-fixes.test.js: the real functions are cut out
// of the source and run inside a `with` scope where unknown globals are inert.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP  = fs.readFileSync(path.join(ROOT, 'Denarii.js'), 'utf8');
const JNL  = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'journal.js'), 'utf8');
const AUTH = fs.readFileSync(path.join(ROOT, 'js', 'auth.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

const isOpenTrade = t => !t.exitTime || t.exitPrice == null;

const JNL_CONSTS = new Function(
    JNL.match(/var _JNL_EXEC_IDS[\s\S]*?var _JNL_PNL_IDS\s*=[^;]*;/)[0] +
    '\nreturn { _JNL_EXEC_IDS: _JNL_EXEC_IDS, _JNL_PNL_IDS: _JNL_PNL_IDS };')();

function makeDocument() {
    const els = {};
    const mk = id => ({
        id, value: '', style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false,
        listeners: {}, parentNode: null,
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        querySelector: () => null, querySelectorAll: () => [], closest: () => null,
        focus() {}, click() {}, remove() {}, appendChild() {},
    });
    return {
        els,
        getElementById: id => (els[id] = els[id] || mk(id)),
        querySelectorAll: () => [],
        createElement: () => mk(''),
    };
}

const JNL_FNS = ['_jnlFmtLocal', '_jnlReadExecInputs', '_jnlChanged', '_jnlShowOpenHint',
    '_jnlSideLabel', '_jnlFmtPnl', '_jnlRenderEditorHeader', '_jnlCommitTrade', '_jnlIsWebull',
    '_jnlScheduleCommit', '_jnlFlushCommit', 'selectTradeForJournal'];

function jnlHarness(trades, openId) {
    const document = makeDocument();
    const saves = [], warns = [], alerts = [];
    const window = { _isOpenTrade: isOpenTrade, scrollTo() {} };
    const { fns, g } = sandbox(JNL, JNL_FNS, Object.assign({}, JNL_CONSTS, {
        document, window,
        console: { warn: (...a) => warns.push(a), log() {}, error() {} },
        alert: m => alerts.push(m),
        journalData: { trades, brokerAccounts: [], strategies: [] },
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
    if (openId !== undefined) fns.selectTradeForJournal(openId);
    return { fns, g, saves, warns, alerts, $, fire, window };
}

// Cloud-loaded rows (_mapSupabaseTradeRow) carry direction, not type.
const cloudShort = () => ({
    id: 1761400000001, symbol: 'ZZTESTJ', direction: 'short', assetType: 'stock', quantity: 1,
    entryPrice: 5, exitPrice: 6, entryTime: '2026-10-25T14:10:00.000Z',
    exitTime: '2026-10-25T14:20:00.000Z', pnl: -1, grossPnl: -1, commissionFees: 0,
    quickNotes: 'qn1', notes: '',
});

// ── 3. Reflection list Side / P&L / Exit ────────────────────────────────────

test('list: Side label reads type, then direction, else a dash', () => {
    const { fns } = sandbox(JNL, ['_jnlSideLabel'], {});
    assert.equal(fns._jnlSideLabel({ type: 'long' }), 'Long');
    assert.equal(fns._jnlSideLabel({ type: 'short' }), 'Short');
    assert.equal(fns._jnlSideLabel({ direction: 'short' }), 'Short');
    assert.equal(fns._jnlSideLabel({ direction: 'long' }), 'Long');
    assert.equal(fns._jnlSideLabel({}), '—');
});

test('list: P&L format matches the dashboard; open trades show a dash', () => {
    const { fns } = sandbox(JNL, ['_jnlFmtPnl'], { window: { _isOpenTrade: isOpenTrade } });
    const closed = pnl => ({ pnl, exitPrice: 1, exitTime: '2026-10-25T14:20:00Z' });
    assert.equal(fns._jnlFmtPnl(closed(-24.76)), '-$24.76');
    assert.equal(fns._jnlFmtPnl(closed(2)), '+$2.00');
    assert.equal(fns._jnlFmtPnl(closed(0)), '+$0.00');
    assert.equal(fns._jnlFmtPnl({ pnl: null, exitPrice: null, exitTime: null }), '—');
});

// The real shared filter, reading the given fake document.
function sharedFilters(document) {
    const w = {};
    new Function('window', 'document', fs.readFileSync(path.join(ROOT, 'js', 'shared', 'filter-bar.js'), 'utf8'))(w, document);
    return w.DenariiFilters;
}

test('list: rendered rows show Short for direction-only, minus sign, and Open exit', () => {
    const document = makeDocument();
    const trades = [
        Object.assign(cloudShort(), { pnl: -24.76 }),
        { id: 2, symbol: 'ZZOPEN', type: 'long', quantity: 1, entryPrice: 1, exitPrice: null,
          entryTime: '2026-10-25T14:00:00.000Z', exitTime: null, pnl: null },
    ];
    const { fns } = sandbox(JNL, ['renderJournalTradeList', '_jnlSideLabel', '_jnlFmtPnl'], {
        DenariiFilters: sharedFilters(document),
        document, window: { _isOpenTrade: isOpenTrade },
        journalData: { trades, brokerAccounts: [] },
        getGlobalFilteredTrades: t => t,
        escapeHtml: v => String(v),
        _jnlListPage: 1, _jnlListPageSize: 50,
    });
    fns.renderJournalTradeList();
    const html = document.getElementById('journal-trade-list-body').innerHTML;
    const rows = html.split('<tr').slice(1);
    const shortRow = rows.find(r => r.includes('ZZTESTJ'));
    const openRow  = rows.find(r => r.includes('ZZOPEN'));
    assert.match(shortRow, />Short</);
    assert.match(shortRow, />-\$24\.76</);
    assert.match(openRow, />Open</);
    assert.match(openRow, />—</);
    assert.doesNotMatch(openRow, /\+\$0\.00/);
});

// ── 1/2. Row menu + row click open the trade by id ──────────────────────────

function openHarness() {
    const calls = [];
    const { fns } = sandbox(APP, ['openTradeInReflection', '_dashRowClick'], {
        activateSection: s => calls.push(['activate', s]),
        selectTradeForJournal: id => calls.push(['select', id]),
    });
    return { fns, calls };
}

test('dashboard: openTradeInReflection switches page then opens the trade', () => {
    const h = openHarness();
    h.fns.openTradeInReflection(42);
    assert.deepEqual(h.calls, [['activate', 'trade-journal'], ['select', 42]]);
});

test('dashboard: row click opens the trade, except on checkbox or menu cell', () => {
    const h = openHarness();
    const target = hit => ({ closest: sel => (sel === 'input, .dt-actions-cell' && hit ? {} : null) });
    h.fns._dashRowClick({ target: target(true) }, 7);    // checkbox / ⋮ / menu item
    assert.deepEqual(h.calls, []);
    h.fns._dashRowClick({ target: target(false) }, 7);   // any other cell
    assert.deepEqual(h.calls, [['activate', 'trade-journal'], ['select', 7]]);
});

test('dashboard: rows and both menu labels use the shared opener', () => {
    assert.ok(APP.includes(`onclick="_dashRowClick(event, ' + t.id + ')"`));
    assert.ok(APP.includes(`onclick="openTradeInReflection(' + t.id + ')">' + (open ? 'Edit' : 'Edit / Reflect')`));
    assert.ok(!APP.includes(`selectTradeForJournal(' + t.id + ')">' + (open ? 'Edit'`));
});

test('reflection: selectTradeForJournal finds a trade by string or number id', () => {
    const h1 = jnlHarness([cloudShort()], String(cloudShort().id));
    assert.equal(h1.window._jnlSelectedTradeId, cloudShort().id);
    assert.equal(h1.$('jnl-view-entry').style.display, '');
    const h2 = jnlHarness([cloudShort()], cloudShort().id);
    assert.equal(h2.window._jnlSelectedTradeId, cloudShort().id);
});

test('reflection: unknown id logs a warning and leaves the list showing', () => {
    const h = jnlHarness([cloudShort()], 999);
    assert.equal(h.warns.length, 1);
    assert.equal(h.window._jnlSelectedTradeId, undefined);
    assert.equal(h.$('jnl-view-entry').style.display, undefined);
});

// ── 4 + decision 5. Cloud short opens as Short; price edit P&L as short ─────

test('reflection: cloud short (direction only) opens as Short', () => {
    const h = jnlHarness([cloudShort()], cloudShort().id);
    assert.equal(h.$('jnl-trade-type').value, 'short');
    assert.equal(h.$('journal-editor-subtitle').textContent, 'Short · -$1.00 P&L');
});

test('reflection: price edit on a cloud short recalculates P&L as a short', async () => {
    const h = jnlHarness([cloudShort()], cloudShort().id);
    h.$('jnl-exit-price').value = '4';
    h.fire('jnl-exit-price', 'input');
    await h.fns._jnlFlushCommit();
    const s = h.saves[0];
    assert.equal(s.exitPrice, 4);
    assert.equal(s.pnl, 1);              // (5 - 4) x 1, short
    assert.equal(s.direction, 'short');
    assert.equal(s.type, 'short');
});

// ── 6. Quick Notes ──────────────────────────────────────────────────────────

test('reflection: Quick Notes load, and a view/click/flush makes no save', async () => {
    const h = jnlHarness([cloudShort()], cloudShort().id);
    assert.equal(h.$('jnl-quick-notes').value, 'qn1');
    h.fire('jnl-quick-notes', 'click');
    await h.fns._jnlFlushCommit();
    assert.equal(h.saves.length, 0);
});

test('reflection: typed Quick Notes edit saves quickNotes', async () => {
    const h = jnlHarness([cloudShort()], cloudShort().id);
    h.$('jnl-quick-notes').value = 'qn2';
    h.fire('jnl-quick-notes', 'input');
    await h.fns._jnlFlushCommit();
    assert.equal(h.saves.length, 1);
    assert.equal(h.saves[0].quickNotes, 'qn2');
    assert.equal(h.saves[0].pnl, -1);    // execution fields untouched
});

test('reflection: Quick Notes edit on an open trade keeps it open', async () => {
    const t = { id: 5, symbol: 'ZZTESTK', type: 'long', quantity: 1, entryPrice: 1, exitPrice: null,
        entryTime: '2026-10-25T14:00:00.000Z', exitTime: null, pnl: null, commissionFees: 0, notes: '' };
    const h = jnlHarness([t], 5);
    h.$('jnl-quick-notes').value = 'note';
    h.fire('jnl-quick-notes', 'input');
    await h.fns._jnlFlushCommit();
    assert.equal(h.saves[0].quickNotes, 'note');
    assert.equal(h.saves[0].pnl, null);
    assert.equal(h.saves[0].exitPrice, null);
});

test('index.html: Quick Notes is editable with the new label and placeholder', () => {
    const m = HTML.match(/<textarea id="jnl-quick-notes"[^>]*>/);
    assert.ok(m);
    assert.doesNotMatch(m[0], /readonly/);
    assert.match(m[0], /placeholder="Add quick notes\.\.\."/);
    assert.ok(!HTML.includes('(captured at entry)'));
});

// ── 5. Close-trade hint under Save Reflection ───────────────────────────────

test('reflection: hint is written to the message under Save, no alert', async () => {
    const t = { id: 6, symbol: 'ZZTESTK', type: 'long', quantity: 1, entryPrice: 1, exitPrice: null,
        entryTime: '2026-10-25T14:00:00.000Z', exitTime: null, pnl: null, commissionFees: 0, notes: '' };
    const h = jnlHarness([t], 6);
    assert.equal(h.$('jnl-open-hint').style.display, 'none');
    h.$('jnl-exit-price').value = '3';
    await h.fns._jnlCommitTrade({ explicit: true });
    assert.equal(h.$('jnl-open-hint').textContent, 'Enter both exit price and exit time to close this trade.');
    assert.equal(h.$('jnl-open-hint').style.display, '');
    assert.equal(h.alerts.length, 0);
    assert.equal(h.saves[0].pnl, null);
});

test('index.html: hint element sits right under the Save Reflection button', () => {
    assert.match(HTML, /Save Reflection<\/button>\s*<div id="jnl-open-hint" style="display:none;[^"]*color:var\(--danger/);
});

test('index.html: header subtitle is bold and uses existing tokens', () => {
    assert.match(HTML, /<p style="color:var\(--text-primary\);font-size:15px;font-weight:600;[^"]*" id="journal-editor-subtitle">/);
});

// ── 7. Account column ───────────────────────────────────────────────────────

test('dashboard: Account cell shows the broker display name', () => {
    const { fns } = sandbox(APP, ['_dashBrokerMap', '_dashBrokerName'], {
        journalData: { brokerAccounts: [
            { id: 'a1', displayName: 'WB-Margin', broker: 'webull' },
            { id: 'a2', broker: 'Pelosi Demo' },
        ] },
    });
    const map = fns._dashBrokerMap();
    assert.equal(fns._dashBrokerName({ brokerAccountId: 'a1' }, map), 'WB-Margin');
    assert.equal(fns._dashBrokerName({ brokerAccountId: 'a2' }, map), 'Pelosi Demo');
    assert.equal(fns._dashBrokerName({ brokerAccountId: 'zz' }, map), '');
    assert.equal(fns._dashBrokerName({}, map), '');
});

test('dashboard: Account column is on, sortable, and placed before P&L', () => {
    const cols = new Function('return ' + APP.match(/var _DASH_COLUMNS = (\[[\s\S]*?\]);/)[1])();
    const keys = cols.map(c => c.key);
    const broker = cols.find(c => c.key === 'broker');
    assert.equal(keys.indexOf('broker'), keys.indexOf('pnl') - 1);
    assert.equal(broker.label, 'Account');
    assert.equal(broker.sortField, 'broker');
    assert.equal(broker.defaultOn, true);
    assert.match(APP, /case 'broker':\s+va = _dashBrokerName\(a, _sortBrokerMap\)/);
});

test('cloud sort map sorts Account by broker_account_id', () => {
    const map = new Function('return ' + AUTH.match(/var _CLOUD_DASH_SORT_MAP = (\{[\s\S]*?\});/)[1])();
    assert.equal(map.broker, 'broker_account_id');
    assert.equal(map.pnl, 'pnl');
});
