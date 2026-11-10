// Batch C2: the old Edit Trade page is removed; Trade Reflection is the one
// page to edit and reflect on a trade. Its Calculated Metrics card gains the
// Net / Gross / Fees summary and fee-source badge moved from Edit Trade.
//
// Same approach as batch-c1.test.js: the real functions are cut out of the
// source and run inside a `with` scope where unknown globals are inert.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP  = fs.readFileSync(path.join(ROOT, 'Denarii.js'), 'utf8');
const JNL  = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'journal.js'), 'utf8');
const BA   = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'broker-accounts.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');

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

const clone = o => JSON.parse(JSON.stringify(o));

// ── The old page is gone ────────────────────────────────────────────────────

test('index.html: no Edit Trade page, ids or handlers', () => {
    assert.ok(!HTML.includes('id="edit-trade"'));
    assert.ok(!HTML.includes('id="etp-'));
    assert.ok(!HTML.includes('edit-trade-page-form'));
    for (const fn of ['closeEditTradePage', 'etpDeleteTrade', 'etpRequestUnlock', 'etpToggleOptionFields',
        'loadStrategyRulesForEtp', '_recalcEtpMetrics', 'etpAddFillRow', 'etpSeparateMarkedFills']) {
        assert.ok(!HTML.includes(fn + '('), fn);
    }
});

test('Denarii.js: Edit Trade code removed', () => {
    // Lock still clears old Edit Trade drafts (checked below), so skip that key.
    const app = APP.split("'etp-draft-'").join('');
    for (const s of ['_etp','etpDeleteTrade', 'etpSeparateMarkedFills', 'etpAddFillRow', 'editingTradeId',
        'editCurrentEmotion', 'editSelectedStrategy', 'editFollowedRules', "'edit-trade'", 'closeEditTradePage',
        '_recalcEtpMetrics', 'updateEtpRuleScore', '_updateEtpPnlSummary', '#etp-', "'etp-"]) {
        assert.ok(!app.includes(s), s);
    }
});

test('journal.js and broker-accounts.js: no Edit Trade references', () => {
    assert.ok(!BA.includes('etp-broker-account'));
    for (const s of ['openEditTradePage', 'closeEditTradePage', '_etp', 'etp-']) {
        assert.ok(!JNL.includes(s), s);
        assert.ok(!BA.includes(s), s);
    }
});

test('Dashboard ⋮ menu still offers Close Trade, Edit / Reflect and Delete', () => {
    assert.ok(APP.includes('onclick="openCloseTrade(\' + t.id + \')">Close Trade</button>'));
    assert.ok(APP.includes('onclick="openTradeInReflection(\' + t.id + \')">\' + (open ? \'Edit\' : \'Edit / Reflect\') + \'</button>'));
    assert.ok(APP.includes('onclick="deleteTrade(\' + t.id + \')">Delete</button>'));
});

test('kept helpers: _roundTradeForSave and _restoreTradeInPlace still defined and working', () => {
    const { fns } = sandbox([[APP, ['_roundTradeForSave', '_restoreTradeInPlace']]], {
        WebullSync: require('../js/services/webull-sync.js'),
    });
    const t = { pnl: (10.2 - 10.1) * 3, exitPrice: null };
    fns._roundTradeForSave(t);
    assert.equal(t.pnl, 0.3);
    assert.equal(t.exitPrice, null);
    const live = { id: 1, a: 2 };
    fns._restoreTradeInPlace(live, { id: 1, b: 3 });
    assert.deepEqual(live, { id: 1, b: 3 });
});

test('openEditTradePage is a one-line alias that opens Trade Reflection on the same trade', () => {
    const calls = [];
    const { fns } = sandbox([[APP, ['openEditTradePage']]], { openTradeInReflection: id => calls.push(id) });
    fns.openEditTradePage(42);
    assert.deepEqual(calls, [42]);
    assert.equal(extractFunction(APP, 'openEditTradePage').split('\n').length, 1);
});

test('_clearAllDrafts still clears old etp-draft- keys', () => {
    const m = /window\._clearAllDrafts = function \(\) \{[\s\S]*?\n        \};/.exec(APP);
    assert.ok(m);
    assert.ok(m[0].includes("k.indexOf('etp-draft-') === 0"));
});

test('index.html: C2 cache-bust versions', () => {
    // At least the C2 version (later batches bump it again).
    assert.ok(Number(/src="Denarii\.js\?v=(\d+)"/.exec(HTML)[1]) >= 46);
    assert.ok(Number(/src="js\/pages\/broker-accounts\.js\?v=(\d+)"/.exec(HTML)[1]) >= 10);
    assert.ok(Number(/src="js\/pages\/journal\.js\?v=(\d+)"/.exec(HTML)[1]) >= 11);
});

// ── Reflection P&L summary ──────────────────────────────────────────────────

test('index.html: Net / Gross / Fees sit in Calculated Metrics after Realized P&L, display only', () => {
    const i = HTML.indexOf('id="jnl-metric-realized-pnl"');
    const end = HTML.indexOf('id="jnl-metric-runup"');
    assert.ok(i > 0 && end > i);
    const added = HTML.slice(i, end);
    const ids = ['jnl-pnl-net', 'jnl-pnl-net-pct', 'jnl-pnl-gross', 'jnl-pnl-gross-pct', 'jnl-fee-source-badge', 'jnl-pnl-fees'];
    ids.forEach(id => assert.ok(added.includes('id="' + id + '"'), id));
    assert.ok(!/<input|<select|<textarea|<button/.test(added));
    // Same label / value styling as the other metrics.
    assert.equal((added.match(/style="font-size:14px;font-weight:600;color:var\(--text-primary\);">--<\/div>/g) || []).length, 6);
    // Same card as the other metrics.
    const card = HTML.lastIndexOf('Calculated Metrics', i);
    assert.ok(card > HTML.indexOf('id="trade-journal"'));
});

function el() {
    return { value: '', textContent: '', title: '', style: {} };
}

// inputs: the Reflection form values as typed; trade: the stored trade.
function pnlHarness(trade, inputs) {
    const els = {};
    const document = { getElementById: id => (els[id] = els[id] || el()) };
    Object.keys(inputs).forEach(k => { document.getElementById(k).value = inputs[k]; });
    const { fns } = sandbox([[APP, ['_updatePnlSummary', '_contractMultiplier', '_sf', '_sfId']], [JNL, ['_jnlRecalcMetrics']]], {
        document,
        journalData: { trades: [trade] },
        window: { _jnlSelectedTradeId: trade.id, _isOpenTrade: t => !t.exitTime || t.exitPrice == null },
        _computeTradeMetrics: () => ({}), _applyMetrics: () => {}, _getRowData: () => [],
    });
    const before = clone(trade);
    fns._jnlRecalcMetrics();
    const text = id => els[id].textContent;
    return { els, text, before, trade };
}

const closed = extra => Object.assign({ id: 1, symbol: 'ZZTEST', type: 'long', assetType: 'stock', quantity: 10,
    entryPrice: 10, exitPrice: 11, entryTime: '2026-10-20T14:30:00Z', exitTime: '2026-10-20T15:00:00Z',
    commissionFees: 1.5, pnl: 8.5 }, extra || {});
const formOf = t => ({ 'jnl-trade-type': t.type, 'jnl-asset-type': t.assetType, 'jnl-quantity': String(t.quantity ?? ''),
    'jnl-entry-price': String(t.entryPrice ?? ''), 'jnl-exit-price': t.exitPrice == null ? '' : String(t.exitPrice),
    'jnl-commission-fees': t.commissionFees == null ? '' : String(t.commissionFees) });

test('P&L summary: closed Webull trade shows Net, Gross, Fees and the "actual" badge', () => {
    const t = closed({ source: 'webull', externalId: 'wb-1', feeSource: 'actual' });
    const h = pnlHarness(t, formOf(t));
    assert.equal(h.text('jnl-pnl-net'), '+$8.50');
    assert.equal(h.els['jnl-pnl-net'].style.color, 'var(--success)');
    assert.equal(h.text('jnl-pnl-gross'), '+$10.00');
    assert.equal(h.text('jnl-pnl-fees'), '$1.50');
    assert.equal(h.text('jnl-fee-source-badge'), 'actual');
    assert.equal(h.els['jnl-fee-source-badge'].style.display, '');
    assert.deepEqual(h.trade, h.before);                    // display only
});

test('P&L summary: short option uses 100x and shows the "est." badge', () => {
    const t = closed({ type: 'short', assetType: 'option', quantity: 1, entryPrice: 2, exitPrice: 2.5,
        commissionFees: 0.65, feeSource: 'estimated' });
    const h = pnlHarness(t, formOf(t));
    // Sign before the $, as in the trades table (Reflection polish).
    assert.equal(h.text('jnl-pnl-gross'), '-$50.00');
    assert.equal(h.text('jnl-pnl-net'), '-$50.65');
    assert.equal(h.els['jnl-pnl-net'].style.color, 'var(--danger)');
    assert.equal(h.text('jnl-pnl-fees'), '$0.65');
    assert.equal(h.text('jnl-fee-source-badge'), 'est.');
});

test('P&L summary: open trade hides Net and Gross, even with an unsaved exit price; fees and "manual" still show', () => {
    const t = closed({ exitPrice: null, exitTime: null, pnl: null, commissionFees: 1, feeSource: 'manual' });
    const h = pnlHarness(t, Object.assign(formOf(t), { 'jnl-exit-price': '12' }));
    assert.equal(h.text('jnl-pnl-net'), '--');
    assert.equal(h.text('jnl-pnl-gross'), '--');
    assert.equal(h.els['jnl-pnl-net'].style.color, 'var(--text-primary)');
    assert.equal(h.text('jnl-pnl-fees'), '$1.00');
    assert.equal(h.text('jnl-fee-source-badge'), 'manual');
    assert.deepEqual(h.trade, h.before);
});

test('P&L summary: missing values show -- instead of $0.00', () => {
    // No fees: Fees and its badge are hidden; Net equals Gross.
    const noFee = closed({ commissionFees: null, feeSource: 'actual' });
    const a = pnlHarness(noFee, formOf(noFee));
    assert.equal(a.text('jnl-pnl-fees'), '--');
    assert.equal(a.els['jnl-fee-source-badge'].style.display, 'none');
    assert.equal(a.text('jnl-pnl-net'), '+$10.00');
    // Blank quantity or entry price: no P&L at all.
    const b = pnlHarness(closed(), Object.assign(formOf(closed()), { 'jnl-quantity': '' }));
    assert.equal(b.text('jnl-pnl-net'), '--');
    assert.equal(b.text('jnl-pnl-gross'), '--');
    const c = pnlHarness(closed(), Object.assign(formOf(closed()), { 'jnl-entry-price': '' }));
    assert.equal(c.text('jnl-pnl-gross'), '--');
    // No feeSource: no badge.
    const d = pnlHarness(closed(), formOf(closed()));
    assert.equal(d.text('jnl-fee-source-badge'), '');
    assert.equal(d.els['jnl-fee-source-badge'].style.display, 'none');
});
