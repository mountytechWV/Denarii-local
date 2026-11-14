// Quick Notes UI removed (port 1). A trade that already carries quickNotes
// keeps it, untouched, through:
//  - a New Trade update (the built trade has no quickNotes; the update merges),
//  - export and import of a backup (the whole journal round-trips).
// Reflection saves are covered in dashboard-reflection-ui.test.js.
// Also: the legal bundle version is unchanged by the port.
//
// Same approach as reflection-open-trade.test.js: the real functions are cut
// out of the source and run inside a `with` scope where unknown globals are inert.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP = fs.readFileSync(path.join(ROOT, 'Denarii.js'), 'utf8');
const LEGAL = fs.readFileSync(path.join(ROOT, 'js', 'legal-bundle.js'), 'utf8');

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

function makeDocument() {
    const els = {};
    const mk = id => ({
        id, value: '', style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false,
        listeners: {}, classList: { add() {}, remove() {} },
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

const oldTrade = () => ({
    id: 1761500000001, symbol: 'ZZTESTQ', type: 'long', assetType: 'stock', quantity: 1,
    entryPrice: 1, exitPrice: 2, entryTime: '2026-10-24T21:45:00.000Z', exitTime: '2026-10-24T21:50:00.000Z',
    pnl: 1, commissionFees: 0, notes: '', quickNotes: 'kept from before',
});

// ── New Trade update ────────────────────────────────────────────────────────

test('new trade: the built trade has no quickNotes, and the update merge keeps a stored one', () => {
    const document = makeDocument();
    const fields = {
        'entry-price': '1', 'exit-price': '3', quantity: '1', 'trade-type': 'long',
        'commission-fees': '', 'entry-time': '2026-10-24T17:45', 'exit-time': '2026-10-24T17:46',
        'asset-type': 'stock', symbol: 'zztestq', 'trade-broker-account': '', 'setup-type': '',
    };
    Object.entries(fields).forEach(([id, v]) => { document.getElementById(id).value = v; });
    const { fns } = sandbox(APP, ['_ntBuildTrade', '_contractMultiplier', '_roundTradeForSave'], {
        WebullSync: undefined,
        document, _ntFillsEnabled: false, selectedStrategyForTrade: null, followedRules: [],
        _getRowData: () => [], _computeTradeMetrics: () => ({}),
        _ntGetTagsFromRows: () => [], _ntGetNotes: () => '', finalizeTradeSummary: t => t,
    });
    const existing = oldTrade();
    const updated = fns._ntBuildTrade(existing.id);
    assert.equal('quickNotes' in updated, false);
    Object.assign(existing, updated);
    assert.equal(existing.quickNotes, 'kept from before');
    assert.equal(existing.exitPrice, 3);
});

test('new trade: an update merges into the stored trade instead of replacing it', () => {
    assert.match(extractFunction(APP, '_ntCommitTrade'), /Object\.assign\(existing, updated\);/);
});

// ── Export and import ───────────────────────────────────────────────────────

test('export then import: a trade keeps its quickNotes', async () => {
    const journal = { version: 2, trades: [oldTrade()], strategies: [], brokerAccounts: [] };
    // Encryption stands in as JSON: the test is about what the journal carries.
    const encrypt = d => JSON.stringify(d);
    const decrypt = s => JSON.parse(s);

    // Export
    let blobText = null;
    const exp = sandbox(APP, ['exportBackup'], {
        journalData: journal, sessionDek: 'dek', sessionPassword: null, currentAccountId: 'acc1',
        encrypt, getAuthRecord: async () => null, CURRENT_EXPORT_VERSION: 1,
        DekCrypto: { hasPasswordWrap: () => false },
        Blob: class { constructor(parts) { blobText = parts.join(''); } },
        URL: { createObjectURL: () => 'blob:x', revokeObjectURL() {} },
        document: makeDocument(), markLastBackup: async () => {}, alert() {},
        _lockPending: false, closeExportModal() {},
    });
    await exp.fns.exportBackup();
    assert.ok(blobText);
    const fileData = JSON.parse(blobText);
    assert.equal(fileData.encrypted, true);

    // Import
    const document = makeDocument();
    let loading = null;
    let saved = null;
    const prompts = ['pw-12345678', 'trader'];
    const imp = sandbox(APP, ['importFromJSON'], {
        document, decrypt, CURRENT_EXPORT_VERSION: 1, CURRENT_SCHEMA_VERSION: 2,
        LEGAL_BUNDLE_VERSION: '2.0',
        FileReader: class { readAsText(text) { loading = this.onload({ target: { result: text } }); } },
        window: { showPromptModal: async () => prompts.shift() },
        DekCrypto: { isWrapReadable: () => false, hashSecret: async s => 'h:' + s.length },
        initDB: async () => {}, currentAccountId: null,
        getAuthRecordByUsername: async () => null, generateRecoveryKey: () => 'RK',
        saveAuthRecord: async r => Object.assign({ id: 'acc2' }, r),
        setActiveAccount: async () => {},
        getAuthRecordById: async () => ({ legalAcceptedVersion: '2.0' }),
        unlockApp() {}, showLegalAcceptanceModal() {}, alert() {},
    });
    imp.g.saveToIndexedDB = async () => { saved = JSON.parse(JSON.stringify(imp.g.journalData)); };
    await imp.fns.importFromJSON();
    document.getElementById('json-input').onchange({ target: { files: [blobText] } });
    await loading;
    assert.ok(saved, 'imported journal was saved');
    assert.equal(saved.trades.length, 1);
    assert.equal(saved.trades[0].quickNotes, 'kept from before');
});

// ── Legal text unchanged ────────────────────────────────────────────────────

test('legal bundle version is unchanged (2.0)', () => {
    assert.match(LEGAL, /const LEGAL_BUNDLE_VERSION = '2\.0';/);
});
