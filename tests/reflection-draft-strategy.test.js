// Trade Reflection draft restore (port 2): a draft's strategy is restored only
// when it is still in the Strategy list. A draft saved before a rename follows
// the rename; a draft whose strategy was deleted keeps the trade's own
// strategy and does not apply its rule answers to it. Draft rule answers are
// marked answered.
//
// Same approach as reflection-polish.test.js: the real functions are cut out
// of the source and run inside a `with` scope where unknown globals are inert.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'Denarii.js'), 'utf8');
const JNL = fs.readFileSync(path.join(__dirname, '..', 'js', 'pages', 'journal.js'), 'utf8');
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

// The Strategy select lists these names (as the page does after a rename).
const OPTIONS = ['', 'Breakout', 'New Name'];

function flatDocument() {
    const els = {};
    const mk = id => ({
        id, value: '', style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false, listeners: {},
        checked: false,
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        querySelector: () => null, querySelectorAll: () => [], focus() {}, closest: () => null,
    });
    const select = mk('jnl-setup-type');
    select.options = OPTIONS.map(v => ({ value: v }));
    els['jnl-setup-type'] = select;
    return { els, getElementById: id => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], createElement: () => mk('') };
}

function open(draft) {
    const trade = { id: 701, symbol: 'ZZTESTR', type: 'long', assetType: 'stock', source: 'manual',
        quantity: 1, entryPrice: 1, exitPrice: 2, entryTime: '2026-10-20T18:30:00.000Z', exitTime: '2026-10-20T19:00:00.000Z',
        commissionFees: 0, pnl: 1, setupType: 'Breakout', notesUpdatedAt: 1 };
    const document = flatDocument();
    const loaded = [];
    const marked = [];
    const { fns } = sandbox([
        [APP, ['finalizeTradeSummary', 'deriveTradeSummaryFromFills', '_roundTradeForSave', '_contractMultiplier']],
        [JNL, ['_jnlFmtLocal', '_jnlReadExecInputs', '_jnlChanged', '_jnlSideLabel', '_jnlRenderEditorHeader',
            '_jnlCommitTrade', '_jnlIsWebull', '_jnlFillsEditable', 'selectTradeForJournal']],
    ], Object.assign({}, JNL_CONSTS, {
        document, WebullSync,
        window: { _isOpenTrade: t => !t.exitTime || t.exitPrice == null, scrollTo() {} },
        journalData: { trades: [trade], brokerAccounts: [], strategies: [] },
        DenariiFilters: { currentStrategyName: n => (n === 'Old Name' ? 'New Name' : n) },
        _jnlDirty: false, _jnlFillsDirty: false, _jnlSplitting: false, _jnlLoaded: {}, _jnlCommitTimer: null,
        _JNL_STATUS_ID: 'jnl-autosave-status', _jnlSelectedStrategy: null,
        _jnlLoadDraft: () => draft, _jnlSaveDraft: () => {}, _jnlClearDraft: () => {},
        _jnlGetNotes: () => '', _jnlSetNotes: () => {},
        _jnlGetTagsFromRows: () => [], _getRowData: () => [], _computeTradeMetrics: () => ({}),
        _jnlLoadStrategyRules: name => { loaded.push(name); },
        _jnlMarkRuleAnswered: cb => { if (cb) marked.push(cb.id); },
        _jnlUpdateRuleScore: () => {},
        Autosave: { showStatus() {} },
        saveToIndexedDB: async () => {}, renderJournalTradeList: () => {}, updateDashboard: () => {},
    }));
    document.els['jnl-setup-type'].value = trade.setupType;
    fns.selectTradeForJournal(trade.id);
    return { document, loaded, marked, $: id => document.getElementById(id) };
}

test('draft restore: a draft saved before a rename follows the new name', () => {
    const h = open({ ts: 2, setup: 'Old Name', rules: ['7'], answered: ['7', '8'] });
    assert.equal(h.$('jnl-setup-type').value, 'New Name');
    assert.deepEqual(h.loaded, ['New Name']);
    assert.equal(h.$('jnl-rule-7').checked, true);
    assert.deepEqual(h.marked.sort(), ['jnl-rule-7', 'jnl-rule-7', 'jnl-rule-8']);
});

test('draft restore: a deleted strategy keeps the trade\'s own and its rule answers are not applied', () => {
    const h = open({ ts: 2, setup: 'Deleted Strategy', rules: ['7'], answered: ['7'] });
    assert.equal(h.$('jnl-setup-type').value, 'Breakout');
    assert.deepEqual(h.loaded, ['Breakout']);
    assert.equal(h.$('jnl-rule-7').checked, false);
    assert.deepEqual(h.marked, []);
});

test('draft restore: a draft with no strategy still restores its rule answers', () => {
    const h = open({ ts: 2, setup: '', rules: ['7'], answered: ['7'] });
    assert.deepEqual(h.loaded, ['Breakout']);
    assert.equal(h.$('jnl-rule-7').checked, true);
});

test('draft restore: an older draft (not newer than the save) is ignored', () => {
    const h = open({ ts: 0, setup: 'New Name', rules: ['7'] });
    assert.equal(h.$('jnl-setup-type').value, 'Breakout');
    assert.deepEqual(h.loaded, ['Breakout']);
    assert.equal(h.$('jnl-rule-7').checked, false);
});
