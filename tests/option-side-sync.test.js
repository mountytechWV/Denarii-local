// Option Side sync: on New Trade and Trade Reflection, Buy sets Side to Long
// and Sell to Short for an option; Side is read-only there. The sync runs
// only from the Buy/Sell and Asset Type change handlers, never on load, and
// skips Webull trades. A hint shows when a saved option's Side and Buy/Sell
// disagree.
//
// Same approach as reflection-polish.test.js: the real functions are cut out
// of the source and run against a small fake DOM.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP  = fs.readFileSync(path.join(ROOT, 'Denarii.js'), 'utf8');
const JNL  = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'journal.js'), 'utf8');
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

function el(value, extra) {
    return Object.assign({ value: value, disabled: false, style: {}, querySelector: () => null }, extra);
}

function hintEl() {
    const link = { style: {} };
    const lockedText = { style: {} };
    return el('', {
        style: { display: 'none' },
        link, lockedText,
        querySelector: sel => (sel === 'a' ? link : sel === '[data-locked-text]' ? lockedText : null),
    });
}

function load(parts, ids, vals) {
    const names = [];
    const code = parts.map(([src, fnNames]) => {
        names.push(...fnNames);
        return fnNames.map(n => extractFunction(src, n)).join('\n');
    }).join('\n');
    const calls = { recalc: 0 };
    const scope = Object.assign({
        document: { getElementById: id => ids[id] || null },
        window: { _jnlSelectedTradeId: null },
        journalData: { trades: [] },
        _recalcNewMetrics: () => { calls.recalc++; },
        _jnlRecalcMetrics: () => { calls.recalc++; },
    }, vals);
    const fns = new Function('scope', 'with (scope) { return (function () {\n' + code +
        '\nreturn {' + names.join(',') + '};\n})(); }')(scope);
    return { fns, scope, calls };
}

const SHARED = [APP, ['_optionSideFor', '_showOptionSideHint']];

function newTrade(asset, action, side) {
    const ids = {
        'asset-type': el(asset), 'option-action': el(action), 'trade-type': el(side),
        'option-fields-row': el(''), 'option-side-hint': hintEl(),
    };
    const { fns, calls } = load([SHARED, [APP, ['toggleOptionFields', 'ntSyncOptionSide']]], ids);
    return { fns, ids, calls };
}

function reflection(trade, asset, action, side, unlocked) {
    const ids = {
        'jnl-asset-type': el(asset), 'jnl-option-action': el(action, { disabled: !unlocked }),
        'jnl-trade-type': el(side, { disabled: true }), 'jnl-unlock-btn': el('', { disabled: !!unlocked }),
        'jnl-option-side-hint': hintEl(),
    };
    const { fns, scope, calls } = load([SHARED, [JNL, ['_jnlIsWebull', '_jnlSelectedTrade',
        '_jnlUpdateOptionSideHint', '_jnlApplySideLock', '_jnlSyncOptionSide']]], ids);
    scope.journalData.trades = [trade];
    scope.window._jnlSelectedTradeId = trade.id;
    return { fns, ids, calls };
}

// ── New Trade ────────────────────────────────────────────────────────────

test('New Trade: Sell sets Side to Short, Buy sets Long, and Side is read-only', () => {
    const t = newTrade('option', 'sell', 'long');
    t.fns.ntSyncOptionSide();
    assert.equal(t.ids['trade-type'].value, 'short');
    assert.equal(t.ids['trade-type'].disabled, true);
    assert.equal(t.calls.recalc, 1);
    t.ids['option-action'].value = 'buy';
    t.fns.ntSyncOptionSide();
    assert.equal(t.ids['trade-type'].value, 'long');
    assert.equal(t.ids['option-side-hint'].style.display, 'none');
});

test('New Trade: stock keeps Side as chosen and editable', () => {
    const t = newTrade('stock', 'sell', 'long');
    t.fns.ntSyncOptionSide();
    assert.equal(t.ids['trade-type'].value, 'long');
    assert.equal(t.ids['trade-type'].disabled, false);
    assert.equal(t.calls.recalc, 0);
});

test('New Trade: load path (toggleOptionFields) never changes Side; a mismatch shows the hint', () => {
    const t = newTrade('option', 'sell', 'long');
    t.fns.toggleOptionFields();
    assert.equal(t.ids['trade-type'].value, 'long');
    assert.equal(t.ids['trade-type'].disabled, true);
    assert.equal(t.ids['option-side-hint'].style.display, '');
    assert.equal(t.ids['option-side-hint'].link.style.display, '');
});

test('Sell + Put, entry 1.5, exit 2, qty 5 prices at -$250 gross once Side is Short', () => {
    const t = newTrade('option', 'sell', 'long');
    t.fns.ntSyncOptionSide();
    const mult = new Function(extractFunction(APP, '_contractMultiplier') + '\nreturn _contractMultiplier;')()('option');
    const side = t.ids['trade-type'].value;
    const gross = side === 'long' ? (2 - 1.5) * 5 * mult : (1.5 - 2) * 5 * mult;
    assert.equal(gross, -250);
});

// ── Trade Reflection ─────────────────────────────────────────────────────

test('Reflection: Sell sets Side to Short after Unlock; Side stays read-only', () => {
    const r = reflection({ id: 1, assetType: 'option', type: 'long' }, 'option', 'sell', 'long', true);
    r.fns._jnlSyncOptionSide();
    assert.equal(r.ids['jnl-trade-type'].value, 'short');
    assert.equal(r.ids['jnl-trade-type'].disabled, true);
    assert.equal(r.calls.recalc, 1);
});

test('Reflection: switching an unlocked trade to Stock makes Side editable again', () => {
    const r = reflection({ id: 1, assetType: 'option', type: 'short' }, 'stock', 'sell', 'short', true);
    r.fns._jnlSyncOptionSide();
    assert.equal(r.ids['jnl-trade-type'].value, 'short');
    assert.equal(r.ids['jnl-trade-type'].disabled, false);
});

test('Reflection: Webull option trades are not synced and show no hint', () => {
    const r = reflection({ id: 1, assetType: 'option', type: 'short', source: 'webull' }, 'option', 'buy', 'short', true);
    r.fns._jnlSyncOptionSide();
    assert.equal(r.ids['jnl-trade-type'].value, 'short');
    assert.equal(r.calls.recalc, 0);
    r.fns._jnlUpdateOptionSideHint();
    assert.equal(r.ids['jnl-option-side-hint'].style.display, 'none');
});

test('Reflection: a locked mismatched trade shows the hint with "Unlock Fields to fix", values untouched', () => {
    const r = reflection({ id: 1, assetType: 'option', type: 'long', optionAction: 'sell' }, 'option', 'sell', 'long', false);
    r.fns._jnlUpdateOptionSideHint();
    const hint = r.ids['jnl-option-side-hint'];
    assert.equal(hint.style.display, '');
    assert.equal(hint.link.style.display, 'none');
    assert.equal(hint.lockedText.style.display, '');
    assert.equal(r.ids['jnl-trade-type'].value, 'long');
    assert.equal(r.ids['jnl-option-action'].value, 'sell');
});

// ── Wiring and save rules ────────────────────────────────────────────────

test('sync is wired only to the Buy/Sell and Asset Type change handlers', () => {
    assert.ok(HTML.includes('<select id="asset-type" onchange="ntSyncOptionSide()">'));
    assert.ok(HTML.includes('<select id="option-action" onchange="ntSyncOptionSide()">'));
    assert.ok(HTML.includes('onchange="_jnlToggleOptionFields(); _jnlSyncOptionSide()"'));
    assert.ok(HTML.includes('id="jnl-option-action" disabled class="jnl-locked-field" onchange="_jnlSyncOptionSide()"'));
    // Load paths never call the sync.
    assert.ok(!extractFunction(JNL, 'selectTradeForJournal').includes('_jnlSyncOptionSide'));
    assert.ok(!extractFunction(APP, '_ntApplyDraft').includes('ntSyncOptionSide'));
    assert.ok(!extractFunction(APP, '_ntResetForm').includes('ntSyncOptionSide'));
});

test('Reflection save: Webull never writes Buy/Sell; a missing one is written only when changed', () => {
    assert.ok(JNL.includes("if (!_isWebull && (trade.optionAction || _optAct !== _jnlLoadedOptionAction)) {"));
    assert.ok(!JNL.includes("trade.optionAction = document.getElementById('jnl-option-action').value;"));
});
