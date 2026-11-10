// Batch "Reflection polish": fill-row missing-field popup (New Trade and
// Reflection), 4-decimal fill prices, the split "Leave at least one row"
// message, Webull Side / Asset Type lock, broker card "Updated" from the
// last Webull sync, and sign-before-$ on the Reflection metric cards.
//
// Same approach as batch-c1.test.js: the real functions are cut out of the
// source and run inside a `with` scope where unknown globals are inert.
process.env.TZ = 'America/New_York';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP  = fs.readFileSync(path.join(ROOT, 'Denarii.js'), 'utf8');
const JNL  = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'journal.js'), 'utf8');
const BA   = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'broker-accounts.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CSS  = fs.readFileSync(path.join(ROOT, 'Denarii.css'), 'utf8');

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

// Small tree DOM: getElementById walks from the root, so a removed popup is gone.
function makeDom() {
    const root = node('root');
    function node(id) {
        return {
            id: id || '', style: {}, dataset: {}, attrs: {}, children: [], parentNode: null,
            textContent: '', value: '', disabled: false, listeners: {},
            setAttribute(k, v) { this.attrs[k] = v; },
            appendChild(c) { c.parentNode = this; this.children.push(c); return c; },
            removeChild(c) { this.children = this.children.filter(x => x !== c); c.parentNode = null; },
            querySelector(sel) {
                const m = /^\[([\w-]+)="([^"]*)"\]$/.exec(sel);
                return m ? find(this, n => n.attrs[m[1]] === m[2]) : null;
            },
            addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
            closest() { return null; },
            focus() { doc.focused = this; },
        };
    }
    function find(from, pred) {
        for (const c of from.children) {
            if (pred(c)) return c;
            const r = find(c, pred);
            if (r) return r;
        }
        return null;
    }
    const doc = {
        root, focused: null, selectors: {},
        getElementById: id => find(root, n => n.id === id),
        createElement: () => node(''),
        querySelectorAll: sel => (doc.selectors[sel] ? doc.selectors[sel]() : []),
        add(id, parent) { return (parent || root).appendChild(node(id)); },
        // A fill row whose inputs carry data-<attr>="<key>".
        row(parent, attr, keys) {
            const r = parent.appendChild(node(''));
            keys.forEach((k, i) => {
                const inp = r.appendChild(node(''));
                inp.attrs[attr] = k;
                inp.offsetLeft = 40 + i * 100; inp.offsetTop = 2; inp.offsetHeight = 30;
            });
            return r;
        },
    };
    return doc;
}

const FILL_KEYS = ['qty', 'entry-price', 'exit-price', 'entry-time', 'exit-time', 'fees'];
const POPUP_FNS = ['_showFieldBubble', '_clearFieldBubble', '_fillFieldPopup'];

// ── 1. Missing-field popup ──────────────────────────────────────────────────

test('popup: anchored under the missing fill input, names the field, one at a time', () => {
    const document = makeDom();
    const rows = document.add('rows');
    const r1 = document.row(rows, 'data-nt-fill', FILL_KEYS);
    const r2 = document.row(rows, 'data-nt-fill', FILL_KEYS);
    const { fns } = sandbox([[APP, POPUP_FNS]], { document });
    fns._fillFieldPopup(r1.children[1], 'entry price');
    let pop = document.getElementById('field-bubble');
    assert.equal(pop.textContent, 'Entry price is required');
    assert.equal(pop.attrs.role, 'alert');
    assert.equal(pop.className, 'field-bubble');
    assert.equal(pop.parentNode, r1);
    assert.equal(r1.style.position, 'relative');
    assert.equal(pop.style.left, '140px');
    assert.equal(pop.style.top, '32px');
    assert.equal(pop.children[0].className, 'field-bubble-arrow');
    fns._fillFieldPopup(r2.children[4], 'exit time');
    pop = document.getElementById('field-bubble');
    assert.equal(pop.parentNode, r2);
    assert.equal(pop.textContent, 'Exit time is required');
    assert.equal(r1.children.length, FILL_KEYS.length, 'first popup removed');
    fns._clearFieldBubble();
    assert.equal(document.getElementById('field-bubble'), null);
});

function ntHarness(rawRows, main) {
    const document = makeDom();
    // main: greyed summary inputs by id; uses the real _ntCanCreate.
    if (main) Object.keys(main).forEach(id => { document.add(id).value = main[id]; });
    const rowsC = document.add('nt-fills-rows');
    const box = document.add('nt-fills-error');
    box.style.display = 'none';
    rawRows.forEach(() => document.row(rowsC, 'data-nt-fill', FILL_KEYS));
    document.selectors['#nt-fills-rows .nt-fill-row'] = () => rowsC.children;
    document.selectors['#nt-fills-rows [data-nt-fill]'] = () => rowsC.children.flatMap(r => r.children.filter(c => c.attrs['data-nt-fill']));
    const saves = [];
    const names = ['_ntCommitTrade', '_ntFindIncompleteFillRow', '_ntShowFillError', '_ntClearFillError'].concat(POPUP_FNS);
    const vals = {
        document,
        _ntCanCreate: () => true, _ntFillsEnabled: true,
        _ntSerializeFillRows: () => rawRows,
        _ntBuildTrade: () => { throw new Error('must not build'); },
        _saveTradeToSupabase: async t => { saves.push(t); return { success: true }; },
        journalData: { trades: [] },
    };
    if (main) { names.push('_ntCanCreate'); delete vals._ntCanCreate; }
    const { fns } = sandbox([[APP, names]], vals);
    return { document, rowsC, box, fns, saves };
}

const ROW_OK = { qty: '10', entryPrice: '10', exitPrice: '11', entryTime: '2026-10-28T10:00', exitTime: '2026-10-28T10:05', fees: '' };

test('New Trade: Save with a partly filled row shows the popup, the red line and focus; nothing saves', async () => {
    const h = ntHarness([ROW_OK, Object.assign({}, ROW_OK, { entryPrice: '' })]);
    const ok = await h.fns._ntCommitTrade({ explicit: true });
    assert.equal(ok, false);
    assert.equal(h.saves.length, 0);
    assert.equal(h.box.textContent, 'Row #2: entry price is missing.');
    assert.equal(h.box.style.display, '');
    const input = h.rowsC.children[1].children[1];
    assert.equal(input.style.borderColor, 'var(--danger, #f87171)');
    assert.equal(h.document.focused, input);
    const pop = h.document.getElementById('field-bubble');
    assert.equal(pop.parentNode, h.rowsC.children[1]);
    assert.equal(pop.textContent, 'Entry price is required');
});

test('New Trade: background autosave with a partly filled row stays quiet (no popup), still blocked', async () => {
    const h = ntHarness([Object.assign({}, ROW_OK, { exitTime: '' })]);
    assert.equal(await h.fns._ntCommitTrade(), false);
    assert.equal(h.saves.length, 0);
    assert.equal(h.document.getElementById('field-bubble'), null);
    assert.equal(h.box.textContent, '');
});

test('New Trade: Save & Journal (reportFillErrors) shows the popup too; clearing removes it', async () => {
    const h = ntHarness([Object.assign({}, ROW_OK, { qty: '' })]);
    assert.equal(await h.fns._ntCommitTrade({ reportFillErrors: true }), false);
    assert.equal(h.document.getElementById('field-bubble').textContent, 'Qty is required');
    h.fns._ntClearFillError();
    assert.equal(h.document.getElementById('field-bubble'), null);
    assert.equal(h.box.style.display, 'none');
    assert.equal(h.rowsC.children[0].children[0].style.borderColor, '');
});

function jnlErrHarness(n) {
    const document = makeDom();
    const rowsC = document.add('jnl-fills-rows');
    const box = document.add('jnl-fills-error');
    for (let i = 0; i < n; i++) document.row(rowsC, 'data-jnl-fill', FILL_KEYS);
    document.selectors['#jnl-fills-rows [data-jnl-fill]'] = () => rowsC.children.flatMap(r => r.children);
    const { fns } = sandbox([[APP, POPUP_FNS], [JNL, ['_jnlShowFillError', '_jnlClearFillError', '_jnlFillsMsg']]], {
        document, _jnlFillRowEls: () => rowsC.children,
    });
    return { document, rowsC, box, fns };
}

test('Reflection: a missing fill field shows the popup, the red line and focus; clearing removes it', () => {
    const h = jnlErrHarness(3);
    h.fns._jnlShowFillError({ row: 3, field: 'exit price', key: 'exit-price' });
    assert.equal(h.box.textContent, 'Row #3: exit price is missing.');
    const input = h.rowsC.children[2].children[2];
    assert.equal(input.style.borderColor, 'var(--danger, #f87171)');
    assert.equal(h.document.focused, input);
    const pop = h.document.getElementById('field-bubble');
    assert.equal(pop.parentNode, h.rowsC.children[2]);
    assert.equal(pop.textContent, 'Exit price is required');
    h.fns._jnlClearFillError();
    assert.equal(h.document.getElementById('field-bubble'), null);
    assert.equal(h.box.style.display, 'none');
});

test('Reflection: save with a partly filled row is still blocked before anything changes', () => {
    const body = extractFunction(JNL, '_jnlCommitTrade');
    assert.match(body, /var _badFill = _ntFindIncompleteFillRow\(_jnlSerializeFillRows\(\)\);\s*if \(_badFill\) \{\s*if \(opts\.explicit\) _jnlShowFillError\(_badFill\);\s*return false;/);
});

// ── 2. Fill prices take 4 decimals ──────────────────────────────────────────

test('fill price inputs take up to 4 decimals on New Trade and Reflection; qty and fees unchanged', () => {
    const nt = extractFunction(APP, 'ntAddFillRow');
    assert.match(nt, /data-nt-fill="entry-price"\s+type="number"\s+placeholder="Entry"\s+step="0\.0001"/);
    assert.match(nt, /data-nt-fill="exit-price"\s+type="number"\s+placeholder="Exit"\s+step="0\.0001"/);
    assert.match(nt, /data-nt-fill="qty"\s+type="number"\s+placeholder="Qty"\s+step="1"/);
    assert.match(nt, /data-nt-fill="fees"\s+type="number"\s+placeholder="Fees"\s+step="0\.01"/);
    const jnl = extractFunction(JNL, '_jnlAppendFillRow');
    assert.match(jnl, /data-jnl-fill="entry-price" class="jnl-locked-field" type="number" step="0\.0001"/);
    assert.match(jnl, /data-jnl-fill="exit-price"  class="jnl-locked-field" type="number" step="0\.0001"/);
    assert.match(jnl, /data-jnl-fill="fees"        class="jnl-locked-field" type="number" step="0\.01"/);
    // 11.5555 is a whole number of steps, so the browser accepts it.
    assert.equal(Math.abs(11.5555 / 0.0001 - Math.round(11.5555 / 0.0001)) < 1e-6, true);
});

test('fill prices: totals and save rounding are unchanged', () => {
    assert.match(extractFunction(APP, '_ntRecomputeFromFills'), /ep\.value = summary\.entryPrice != null \? Number\(summary\.entryPrice\)\.toFixed\(4\)/);
    assert.match(extractFunction(JNL, '_jnlRecomputeFills'), /setVal\('jnl-entry-price',\s+Number\(summary\.entryPrice\)\.toFixed\(4\)\)/);
    assert.match(extractFunction(APP, '_ntBuildTrade'), /return _roundTradeForSave\(isOpen \? _trade : finalizeTradeSummary\(_trade\)\);/);
});

// ── 3. "Leave at least one row" ─────────────────────────────────────────────

const LEAVE = 'Leave at least one row on this trade.';

function splitHarness(raw) {
    const document = makeDom();
    const bar = document.add('jnl-fills-split-bar');
    const status = document.add('jnl-fills-split-status');
    const btn = document.add('jnl-fills-split-btn');
    const box = document.add('jnl-fills-error');
    const rows = raw.map(r => ({ marked: !!r.marked }));
    const { fns } = sandbox([[JNL, ['_jnlUpdateSplitBar', '_jnlRawRowEmpty', '_jnlFillsMsg']]], {
        document,
        _jnlFillRowEls: () => rows,
        _jnlRowMarked: r => r.marked,
        _jnlSerializeFillRows: () => raw.map(r => ({ qty: r.qty || '', entryPrice: r.entryPrice || '', exitPrice: r.exitPrice || '' })),
    });
    return { fns, rows, bar, status, btn, box };
}
const filled = { qty: '10', entryPrice: '10', exitPrice: '11' };

test('split: every filled row ticked shows the message and disables Split; unticking one hides it', () => {
    const h = splitHarness([filled, filled, filled]);
    h.rows.forEach(r => { r.marked = true; });
    h.fns._jnlUpdateSplitBar();
    assert.equal(h.box.textContent, LEAVE);
    assert.equal(h.box.style.display, '');
    assert.equal(h.btn.disabled, true);
    h.rows[0].marked = false;
    h.fns._jnlUpdateSplitBar();
    assert.equal(h.box.textContent, '');
    assert.equal(h.box.style.display, 'none');
    assert.equal(h.btn.disabled, false);
    assert.equal(h.bar.style.display, 'flex');
    assert.match(h.status.textContent, /^2 rows marked .* 1 row will remain/);
});

test('split: an empty row does not count as a row left on the trade', () => {
    const h = splitHarness([filled, filled, {}]);
    h.rows[0].marked = h.rows[1].marked = true;
    h.fns._jnlUpdateSplitBar();
    assert.equal(h.box.textContent, LEAVE);
    assert.equal(h.btn.disabled, true);
});

test('split: a valid selection leaves other fill messages alone', () => {
    const h = splitHarness([filled, filled]);
    h.box.textContent = 'Row #2: qty is missing.';
    h.box.style.display = '';
    h.rows[0].marked = true;
    h.fns._jnlUpdateSplitBar();
    assert.equal(h.box.textContent, 'Row #2: qty is missing.');
    assert.equal(h.btn.disabled, false);
});

test('split: ticking a checkbox no longer un-ticks it; the bar decides the message', () => {
    const container = { dataset: {}, listeners: {}, set innerHTML(v) {}, addEventListener(t, fn) { this.listeners[t] = fn; } };
    let updates = 0, cleared = 0;
    const { fns } = sandbox([[JNL, ['_jnlRenderFillsEditor']]], {
        _jnlUnlocked: () => true, _jnlAppendFillRow: () => {}, _jnlUpdateFillRowDisplay: () => {},
        _jnlUpdateSplitBar: () => { updates++; }, _jnlClearFillError: () => { cleared++; },
        _jnlFillRowEls: () => [{}, {}], _jnlRowMarked: () => true,
    });
    fns._jnlRenderFillsEditor(container, { fills: [] });
    const cb = { type: 'checkbox', checked: true, closest: () => ({}) };
    container.listeners.change({ target: cb });
    assert.equal(cb.checked, true);
    assert.equal(cleared, 1);
    assert.equal(updates, 1);
});

// ── 4. Webull: Side and Asset Type stay locked; no P&L confirm ──────────────

const LOCKED = ['jnl-symbol', 'jnl-trade-type', 'jnl-asset-type', 'jnl-setup-x'].concat(JNL_CONSTS._JNL_EXEC_IDS);

function unlockHarness(trade, o) {
    o = o || {};
    const els = {};
    const mk = id => (els[id] = els[id] || { id, disabled: true, textContent: '', style: {} });
    const calls = { confirm: 0 };
    LOCKED.forEach(mk);
    const document = {
        getElementById: id => (id === 'jnl-fills-rows' && !o.fillRows ? null : mk(id)),
        querySelectorAll: sel => (sel === '.jnl-locked-field' ? LOCKED.map(mk) : []),
    };
    const { fns } = sandbox([[JNL, ['jnlRequestUnlock', '_jnlIsWebull']]], Object.assign({}, JNL_CONSTS, {
        document,
        window: { _jnlSelectedTradeId: trade.id },
        journalData: { trades: [trade] },
        confirm: () => { calls.confirm++; return o.confirm !== false; },
    }));
    fns.jnlRequestUnlock();
    return { els, calls };
}

test('Webull trade: Unlock skips the P&L confirm; Side, Asset Type and execution fields stay locked', () => {
    const h = unlockHarness({ id: 1, source: 'webull', externalId: 'wb-1' });
    assert.equal(h.calls.confirm, 0);
    ['jnl-trade-type', 'jnl-asset-type'].concat(JNL_CONSTS._JNL_EXEC_IDS).forEach(id => assert.equal(h.els[id].disabled, true, id));
    assert.equal(h.els['jnl-symbol'].disabled, false);
    assert.equal(h.els['jnl-unlock-btn'].disabled, true);
    assert.equal(h.els['jnl-lock-hint'].style.display, 'none');
});

test('Webull trade with only an externalId counts as Webull too', () => {
    const h = unlockHarness({ id: 1, externalId: 'wb-1' });
    assert.equal(h.calls.confirm, 0);
    assert.equal(h.els['jnl-trade-type'].disabled, true);
    assert.equal(h.els['jnl-asset-type'].disabled, true);
});

test('manual trade: Unlock still asks; Side and Asset Type unlock', () => {
    const h = unlockHarness({ id: 1, source: 'manual' });
    assert.equal(h.calls.confirm, 1);
    LOCKED.forEach(id => assert.equal(h.els[id].disabled, false, id));
});

test('manual trade with fill rows: totals stay locked, Side and Asset Type unlock', () => {
    const h = unlockHarness({ id: 1, source: 'manual' }, { fillRows: true });
    assert.equal(h.calls.confirm, 1);
    JNL_CONSTS._JNL_EXEC_IDS.forEach(id => assert.equal(h.els[id].disabled, true, id));
    assert.equal(h.els['jnl-trade-type'].disabled, false);
    assert.equal(h.els['jnl-asset-type'].disabled, false);
});

test('manual trade: Cancel on the confirm unlocks nothing', () => {
    const h = unlockHarness({ id: 1, source: 'manual' }, { confirm: false });
    assert.equal(h.calls.confirm, 1);
    LOCKED.forEach(id => assert.equal(h.els[id].disabled, true, id));
});

// ── 6. Broker card "Updated" from the last Webull sync ──────────────────────

const NOW = Date.now();
const iso = msAgo => new Date(NOW - msAgo).toISOString();
const DAY = 86400000;

function cardHarness(accts, lastSync, lastTrade) {
    const list = { innerHTML: '' };
    const { fns } = sandbox([[BA, ['renderBrokerAccountsList', 'formatRelativeDate']]], {
        document: { getElementById: id => (id === 'broker-accounts-list' ? list : null) },
        journalData: { brokerAccounts: accts },
        ensureBrokerAccounts: () => {}, getTradeCountForAccount: () => 0,
        getLastTradeDate: id => lastTrade[id] || null, getAccountCashSummary: () => null,
        TRADING_STYLE_LABELS: {}, escapeHtml: s => String(s), _fmtMoney: v => '$' + v,
        wbCardNeedsApproval: new Set(), wbCardLastSync: new Map(Object.entries(lastSync)),
        WB_WARN_STYLE: '', _wbRefreshCardFlags: () => {},
    });
    fns.renderBrokerAccountsList();
    return list.innerHTML;
}
const acct = id => ({ id, displayName: id, broker: 'Webull', color: '#000', tradingStyle: 'day_trading' });

test('card: a synced Webull journal with no trades shows the sync time, not "Never"', () => {
    const html = cardHarness([acct('wb')], { wb: iso(60 * 1000) }, {});
    assert.match(html, /Updated Today/);
    assert.doesNotMatch(html, /Updated Never/);
});

test('card: the last sync wins over an older last trade date', () => {
    const html = cardHarness([acct('wb')], { wb: iso(DAY) }, { wb: iso(10 * DAY) });
    assert.match(html, /Updated Yesterday/);
});

test('card: no link or no sync time keeps the last trade date, or "Never"', () => {
    const html = cardHarness([acct('man'), acct('empty')], {}, { man: iso(3 * DAY) });
    assert.match(html, /Updated 3 days ago/);
    assert.match(html, /Updated Never/);
});

// status() from window.denariiWebull (local database, no Webull call): links carry lastSyncedAt.
function flagsHarness(links, status) {
    let calls = 0;
    let renders = 0;
    const { fns, g } = sandbox([[BA, ['_wbRefreshCardFlags']]], {
        WB_CARD_TTL_MS: 30000, wbCardChecking: false, wbCardCheckedAt: 0, wbCardGen: 0,
        wbCardNeedsApproval: new Set(), wbCardLastSync: new Map(),
        _wbStatus: async () => { calls++; return status && Object.assign({ links }, status); },
        renderBrokerAccountsList: () => { renders++; },
        Date,
    });
    return { fns, g, calls: () => calls, renders: () => renders };
}

test('card flags: reads lastSyncedAt from the status links and re-renders once when it changes', async () => {
    const links = [{ journalId: 'j1', lastSyncedAt: '2026-10-28T14:00:00Z' }, { journalId: 'j2', lastSyncedAt: null }];
    const h = flagsHarness(links, { connected: true, approvalState: 'ok' });
    await h.fns._wbRefreshCardFlags();
    assert.equal(h.calls(), 1);
    assert.equal(h.g.wbCardLastSync.get('j1'), '2026-10-28T14:00:00Z');
    assert.equal(h.g.wbCardLastSync.has('j2'), false);
    assert.equal(h.renders(), 1);
    h.g.wbCardCheckedAt = 0;
    await h.fns._wbRefreshCardFlags();
    assert.equal(h.renders(), 1, 'same data, no re-render');
});

test('card flags: a failed status check keeps the current lines', async () => {
    const h = flagsHarness([], null);
    h.g.wbCardNeedsApproval = new Set(['j1']);
    h.g.wbCardLastSync = new Map([['j1', '2026-10-28T14:00:00Z']]);
    await h.fns._wbRefreshCardFlags();
    assert.equal(h.g.wbCardLastSync.get('j1'), '2026-10-28T14:00:00Z');
    assert.deepEqual([...h.g.wbCardNeedsApproval], ['j1']);
    assert.equal(h.renders(), 0);
});

test('card flags: force skips the 30 s wait (after a sync)', async () => {
    const h = flagsHarness([{ journalId: 'j1', lastSyncedAt: null }], { connected: true, approvalState: 'ok' });
    await h.fns._wbRefreshCardFlags();
    await h.fns._wbRefreshCardFlags();
    assert.equal(h.calls(), 1);
    await h.fns._wbRefreshCardFlags(true);
    assert.equal(h.calls(), 2);
});

test('card flags: needs-approval behavior unchanged', async () => {
    const h = flagsHarness([{ journalId: 'j1', lastSyncedAt: null }], { connected: true, approvalState: 'needs_approval' });
    await h.fns._wbRefreshCardFlags();
    assert.deepEqual([...h.g.wbCardNeedsApproval], ['j1']);
    assert.equal(h.renders(), 1);
});

// ── 7. Negative money: sign before the $ ────────────────────────────────────

// The trades table P&L cell, cut from the source.
const TABLE_EXPR = /var pnlStr = open \? '\\u2014' : (\(\(t\.pnl >= 0 \? '\+' : '-'\) \+ '\$' \+ Math\.abs\(t\.pnl\)\.toFixed\(2\)\));/.exec(APP)[1];
const tableFmt = pnl => new Function('t', 'return ' + TABLE_EXPR)({ pnl });

function metricsDoc() {
    const els = {};
    return { els, getElementById: id => (els[id] = els[id] || { textContent: '', style: {} }) };
}

test('Reflection metric cards: negatives show "-$1.00"; positives unchanged', () => {
    const document = metricsDoc();
    const { fns } = sandbox([[APP, ['_applyMetrics']]], { document });
    fns._applyMetrics('jnl-metric-', { netPnl: -1, drawdown: -4.7, runup: 2, initialTarget: 5,
        tradeRisk: 1, totalPlannedRisk: 1, plannedRMultiple: 2, realizedRMultiple: -1 });
    const t = id => document.els['jnl-metric-' + id].textContent;
    assert.equal(t('realized-pnl'), '-$1.00');
    assert.equal(t('drawdown'), '-$4.70');
    assert.equal(t('runup'), '$2.00');
    assert.equal(t('initial-target'), '$5.00');
    assert.equal(t('realized-r'), '-1.00R');
    assert.equal(document.els['jnl-metric-realized-pnl'].style.color, 'var(--danger)');
    fns._applyMetrics('jnl-metric-', {});
    assert.equal(t('realized-pnl'), '--');
});

test('Reflection Net / Gross match the trades table format', () => {
    const document = metricsDoc();
    const { fns } = sandbox([[APP, ['_updatePnlSummary', '_contractMultiplier']]], { document });
    fns._updatePnlSummary('jnl-', 10, 9.5, 2, 'long', 0.25, 'stock', 'manual');
    assert.equal(document.els['jnl-pnl-gross'].textContent, '-$1.00');
    assert.equal(document.els['jnl-pnl-net'].textContent, '-$1.25');
    assert.equal(document.els['jnl-pnl-net'].textContent, tableFmt(-1.25));
    fns._updatePnlSummary('jnl-', 10, 11, 2, 'long', 0, 'stock');
    assert.equal(document.els['jnl-pnl-net'].textContent, tableFmt(2));
    assert.equal(tableFmt(2), '+$2.00');
});

test('Dashboard stat cards: negatives match the trades table', () => {
    const { fns } = sandbox([[APP, ['_dashFmtMoney']]], {});
    [-1, -241.04000000000002, -0.5].forEach(v => assert.equal(fns._dashFmtMoney(v), tableFmt(v)));
    assert.equal(fns._dashFmtMoney(2), '$2.00');   // no plus on positives (Batch A2)
});

test('money format: stored values are not touched', () => {
    assert.doesNotMatch(extractFunction(APP, '_applyMetrics'), /m\.\w+\s*=[^=]/);
});

test('New Trade: every row missing Entry (greyed summary blank) still shows the popup on row 1 Entry', async () => {
    // Deployed repro: 2 rows with qty + exit only; the greyed summary has no
    // entry price or entry time, so _ntCanCreate is false.
    const blank = { qty: '2', entryPrice: '', exitPrice: '2', entryTime: '', exitTime: '', fees: '' };
    const h = ntHarness([blank, Object.assign({}, blank, { exitPrice: '3' })],
        { symbol: 'ZZTEST2', quantity: '4', 'entry-price': '', 'exit-price': '2.5000', 'entry-time': '', 'exit-time': '' });
    assert.equal(await h.fns._ntCommitTrade({ explicit: true }), false);
    assert.equal(h.saves.length, 0);
    assert.equal(h.box.textContent, 'Row #1: entry price is missing.');
    const input = h.rowsC.children[0].children[1];
    assert.equal(input.style.borderColor, 'var(--danger, #f87171)');
    assert.equal(h.document.focused, input);
    const pop = h.document.getElementById('field-bubble');
    assert.equal(pop.parentNode, h.rowsC.children[0]);
    assert.equal(pop.textContent, 'Entry price is required');
});

test('New Trade: complete fill rows but no symbol still stop quietly at _ntCanCreate', async () => {
    const h = ntHarness([ROW_OK], { symbol: '', quantity: '10', 'entry-price': '10', 'exit-price': '11', 'entry-time': '2026-10-28T10:00', 'exit-time': '' });
    assert.equal(await h.fns._ntCommitTrade({ explicit: true }), false);
    assert.equal(h.document.getElementById('field-bubble'), null);
});

// ── Cache-bust ──────────────────────────────────────────────────────────────

test('index.html: changed scripts bumped', () => {
    // At least these versions (later batches bump them again).
    assert.ok(Number(/src="Denarii\.js\?v=(\d+)"/.exec(HTML)[1]) >= 50);
    assert.ok(Number(/src="js\/pages\/journal\.js\?v=(\d+)"/.exec(HTML)[1]) >= 14);
    assert.ok(Number(/href="Denarii\.css\?v=(\d+)"/.exec(HTML)[1]) >= 14);
    assert.ok(Number(/src="js\/pages\/broker-accounts\.js\?v=(\d+)"/.exec(HTML)[1]) >= 11);
});

// ── Follow-ups: reopen + save on Trade Reflection ───────────────────────────

const WebullSync = require('../js/services/webull-sync.js');
const clone = o => JSON.parse(JSON.stringify(o));

function flatDocument() {
    const els = {};
    const mk = id => ({
        id, value: '', style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false, listeners: {},
        addEventListener(type, fn) { (this.listeners[type] = this.listeners[type] || []).push(fn); },
        querySelector: () => null, querySelectorAll: () => [], focus() {}, closest: () => null,
    });
    return { els, getElementById: id => (els[id] = els[id] || mk(id)), querySelectorAll: () => [], createElement: () => mk('') };
}

// Opens the trade through selectTradeForJournal (with an optional draft),
// then lets the test save through the real _jnlCommitTrade.
function reopenHarness(trade, draft) {
    const document = flatDocument();
    const saves = [];
    let notes = '';
    const { fns, g } = sandbox([
        [APP, ['finalizeTradeSummary', 'deriveTradeSummaryFromFills', '_roundTradeForSave', '_contractMultiplier']],
        [JNL, ['_jnlFmtLocal', '_jnlReadExecInputs', '_jnlChanged', '_jnlSideLabel', '_jnlRenderEditorHeader',
            '_jnlCommitTrade', '_jnlIsWebull', '_jnlFillsEditable', 'selectTradeForJournal']],
    ], Object.assign({}, JNL_CONSTS, {
        document, WebullSync,
        window: { _isOpenTrade: t => !t.exitTime || t.exitPrice == null, scrollTo() {} },
        journalData: { trades: [trade], brokerAccounts: [], strategies: [] },
        _jnlDirty: false, _jnlFillsDirty: false, _jnlSplitting: false, _jnlLoaded: {}, _jnlCommitTimer: null,
        _JNL_STATUS_ID: 'jnl-autosave-status', _jnlSelectedStrategy: null,
        _jnlLoadDraft: () => draft || null, _jnlSaveDraft: () => {}, _jnlClearDraft: () => {},
        _jnlGetNotes: () => notes, _jnlSetNotes: html => { notes = html; },
        _jnlGetTagsFromRows: () => [], _getRowData: () => [], _computeTradeMetrics: () => ({}),
        Autosave: { showStatus() {} }, _isCloudPrimarySave: () => true,
        _saveTradeToSupabase: async t => { saves.push(clone(t)); return { success: true }; },
        _restoreTradeInPlace: () => {}, _triggerCloudDashRefresh: () => {},
        saveToIndexedDB: async () => {}, renderJournalTradeList: () => {}, updateDashboard: () => {},
    }));
    fns.selectTradeForJournal(trade.id);
    const $ = id => document.getElementById(id);
    return { fns, g, saves, $, notes: () => notes };
}

const FT0 = '2026-10-20T18:30:00.000Z', FT1 = '2026-10-20T19:00:00.000Z';
const ffill = (q, ep, xp, fees) => ({ quantity: q, entryPrice: ep, exitPrice: xp, entryTime: FT0, exitTime: FT1,
    commissionFees: fees, pnl: (xp - ep) * q - fees });
function filledTrade() {
    return { id: 601, symbol: 'ZZTEST1', type: 'long', assetType: 'stock', source: 'manual',
        quantity: 20, entryPrice: 10.05, exitPrice: 11, entryTime: FT0, exitTime: FT1, commissionFees: 0.66,
        grossPnl: 19, pnl: 18.34, fills: [ffill(10, 10, 11, 0.33), ffill(10, 10.1, 11, 0.33)], notesUpdatedAt: 1 };
}
// A draft saved while a partly filled row blocked the save: its totals
// came from different rows than the saved fills.
const staleDraft = extra => Object.assign({ ts: 2, notes: '<p>draft note</p>', quickNotes: 'qn', grade: 'B',
    core: { 'jnl-quantity': '30', 'jnl-entry-price': '10.2', 'jnl-exit-price': '11.5', 'jnl-commission-fees': '0.99',
        'jnl-entry-time': '2026-10-20T13:00', 'jnl-exit-time': '2026-10-20T16:00', 'jnl-symbol': 'ZZTEST1' } }, extra || {});

test('reopen: a draft whose totals disagree with the saved fills shows the saved totals; notes still restore', () => {
    const t = filledTrade();
    const h = reopenHarness(t, staleDraft());
    assert.equal(String(h.$('jnl-quantity').value), '20');
    assert.equal(String(h.$('jnl-entry-price').value), '10.05');
    assert.equal(String(h.$('jnl-exit-price').value), '11');
    assert.equal(String(h.$('jnl-commission-fees').value), '0.66');
    assert.equal(h.$('jnl-entry-time').value, '2026-10-20T14:30');
    assert.equal(h.notes(), '<p>draft note</p>');
    assert.equal(h.$('jnl-quick-notes').value, 'qn');
    assert.equal(h.g._jnlDirty, true);
});

test('reopen + save: totals saved match the fills, notes from the draft are saved', async () => {
    const t = filledTrade();
    const h = reopenHarness(t, staleDraft());
    assert.equal(await h.fns._jnlCommitTrade({ explicit: true }), true);
    const s = h.saves[0];
    assert.equal(s.quantity, 20);
    assert.equal(s.entryPrice, 10.05);
    assert.equal(s.exitPrice, 11);
    assert.equal(s.commissionFees, 0.66);
    assert.equal(s.pnl, 18.34);
    assert.equal(s.entryTime, FT0);
    assert.equal(s.fills.length, 2);
    assert.equal(s.notes, '<p>draft note</p>');
});

test('save: summary inputs that differ from the fills are never written when the rows were not edited', async () => {
    const t = filledTrade();
    const h = reopenHarness(t, null);
    h.$('jnl-quantity').value = '99';
    h.$('jnl-exit-price').value = '50';
    h.$('jnl-commission-fees').value = '7';
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.saves[0];
    assert.equal(s.quantity, 20);
    assert.equal(s.exitPrice, 11);
    assert.equal(s.commissionFees, 0.66);
    assert.equal(s.pnl, 18.34);
});

test('reopen: a trade without fills still restores draft totals (unchanged)', () => {
    const t = filledTrade();
    delete t.fills;
    const h = reopenHarness(t, staleDraft());
    assert.equal(h.$('jnl-quantity').value, '30');
    assert.equal(h.$('jnl-entry-price').value, '10.2');
});

test('Unlock: a trade with saved fills keeps the totals locked even before the fill rows render', () => {
    const h = unlockHarness({ id: 1, source: 'manual', fills: [ffill(1, 1, 2, 0)] });
    JNL_CONSTS._JNL_EXEC_IDS.forEach(id => assert.equal(h.els[id].disabled, true, id));
    assert.equal(h.els['jnl-trade-type'].disabled, false);
});

function webullTrade(extra) {
    return Object.assign({ id: 701, symbol: 'SPOT', direction: 'short', assetType: 'stock', source: 'webull',
        externalId: 'wb-701', quantity: 2, entryPrice: 10, exitPrice: 9, entryTime: FT0, exitTime: FT1,
        commissionFees: 0, grossPnl: 2, pnl: 2, notesUpdatedAt: 1 }, extra || {});
}

test('Webull save: stored side and asset type win over the dropdowns', async () => {
    const h = reopenHarness(webullTrade(), null);
    assert.equal(h.$('jnl-trade-type').value, 'short');
    h.$('jnl-trade-type').value = 'long';
    h.$('jnl-asset-type').value = 'option';
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.saves[0];
    assert.equal(s.type, 'short');                 // from direction, as the dropdown loads it
    assert.equal(s.assetType, 'stock');
    assert.equal(s.pnl, 2);
    assert.equal(s.optionType, null);
});

test('Webull save: a draft side / asset type is ignored on reopen and on save', async () => {
    const h = reopenHarness(webullTrade({ type: 'long', direction: 'long', exitPrice: 11, pnl: 2 }),
        staleDraft({ core: { 'jnl-trade-type': 'short', 'jnl-asset-type': 'option', 'jnl-quantity': '50', 'jnl-symbol': 'SPOT' } }));
    assert.equal(h.$('jnl-trade-type').value, 'long');
    assert.equal(h.$('jnl-asset-type').value, 'stock');
    assert.equal(String(h.$('jnl-quantity').value), '2');
    await h.fns._jnlCommitTrade({ explicit: true });
    const s = h.saves[0];
    assert.equal(s.type, 'long');
    assert.equal(s.assetType, 'stock');
    assert.equal(s.quantity, 2);
    assert.equal(s.pnl, 2);
    assert.equal(s.notes, '<p>draft note</p>');
});

test('manual save: Side and Asset Type from the dropdowns still save (unchanged)', async () => {
    const t = filledTrade();
    delete t.fills;
    const h = reopenHarness(t, null);
    h.$('jnl-trade-type').value = 'short';
    await h.fns._jnlCommitTrade({ explicit: true });
    assert.equal(h.saves[0].type, 'short');
    assert.equal(h.saves[0].pnl, -19.66);          // (10.05 - 11) * 20 - 0.66
});

// ── Header after a save ─────────────────────────────────────────────────────

test('header after a save: losses show "-$x.xx", gains "+$x.xx", open "Open"', async () => {
    const t = filledTrade();
    delete t.fills;
    const h = reopenHarness(t, null);
    h.$('jnl-trade-type').value = 'short';
    await h.fns._jnlCommitTrade({ explicit: true });
    assert.equal(h.$('journal-editor-subtitle').textContent, 'Short · -$19.66 P&L');
    h.fns._jnlRenderEditorHeader({ type: 'long', pnl: 2.5, entryTime: FT0 });
    assert.equal(h.$('journal-editor-subtitle').textContent, 'Long · +$2.50 P&L');
    h.fns._jnlRenderEditorHeader({ type: 'long', pnl: null, entryTime: FT0 });
    assert.equal(h.$('journal-editor-subtitle').textContent, 'Long · Open');
});

// ── Single-fill prices take 4 decimals ──────────────────────────────────────

test('single-fill Entry / Exit Price take 4 decimals on New Trade and Reflection; others unchanged', () => {
    ['entry-price', 'exit-price', 'jnl-entry-price', 'jnl-exit-price'].forEach(id =>
        assert.match(HTML, new RegExp('id="' + id + '"[^>]*step="0\\.0001"'), id));
    assert.match(HTML, /id="commission-fees"[^>]*step="0\.01"/);
    assert.match(HTML, /id="jnl-commission-fees"[^>]*step="0\.01"/);
    assert.match(HTML, /id="quantity"[^>]*step="1"/);
});

// ── Exit Time popup position ────────────────────────────────────────────────

test('Exit Time popup sits above the field, clear of the Trade Grade label below', () => {
    const body = extractFunction(JNL, '_jnlShowOpenHint');
    assert.match(body, /_showFieldBubble\(field,[\s\S]*\{ host: group, above: true \}\);/);
    assert.match(CSS, /\.field-bubble--above \{[^}]*transform: translateY\(-100%\);/);
});

// ── One validation bubble; New Trade native validation off ──────────────────

test('New Trade: native validation is off and Save runs the same checks in code', () => {
    assert.match(HTML, /<form id="trade-form" novalidate>/);
    assert.doesNotMatch(APP, /reportValidity\(\)/);
    assert.match(APP, /addEventListener\('submit', async \(e\) => \{\s*e\.preventDefault\(\);\s*if \(!_ntCheckRequired\(e\.currentTarget\)\) return;\s*if \(_ntCommitTimer\)/);
    assert.match(extractFunction(APP, 'saveAndOpenJournal'), /if \(!_ntCheckRequired\(form\)\) return;\s*\/\/ Flush/);
});

// Inputs with the bits of the constraint API _ntCheckRequired reads.
function requiredHarness(fields) {
    const document = makeDom();
    const els = fields.map(f => {
        const group = document.add('');
        const label = document.add('', group);
        label.textContent = f.label;
        const el = document.add(f.id, group);
        Object.assign(el, { value: f.value || '', readOnly: !!f.readOnly, offsetLeft: 0, offsetTop: 20, offsetHeight: 30 });
        el.validity = { valueMissing: !!f.required && el.value === '' };
        el.validationMessage = f.message || (el.validity.valueMissing ? 'Please fill out this field.' : '');
        el.willValidate = !el.readOnly;
        el.checkValidity = () => el.validationMessage === '';
        el.closest = sel => (sel === '.form-group' ? group : null);
        group.querySelector = sel => (sel === 'label' ? label : null);
        return el;
    });
    const form = { querySelectorAll: () => els };
    const { fns } = sandbox([[APP, POPUP_FNS.concat(['_ntCheckRequired'])]], { document });
    return { document, els, form, fns };
}

test('New Trade required check: first blank field gets the app bubble and focus; Save stays blocked', () => {
    const h = requiredHarness([
        { id: 'symbol', label: 'Symbol', required: true },
        { id: 'quantity', label: 'Quantity', required: true },
    ]);
    assert.equal(h.fns._ntCheckRequired(h.form), false);
    const pop = h.document.getElementById('field-bubble');
    assert.equal(pop.className, 'field-bubble');
    assert.equal(pop.textContent, 'Symbol is required');
    assert.equal(pop.parentNode, h.els[0].parentNode);
    assert.equal(h.document.focused, h.els[0]);
    // Editing the field clears the bubble.
    h.els[0].listeners.input[0]();
    assert.equal(h.document.getElementById('field-bubble'), null);
});

test('New Trade required check: greyed (read-only) fields are skipped; other browser errors keep their text', () => {
    let h = requiredHarness([
        { id: 'symbol', label: 'Symbol', required: true, value: 'ZZTEST2' },
        { id: 'entry-price', label: 'Entry Price', required: true, readOnly: true },
    ]);
    assert.equal(h.fns._ntCheckRequired(h.form), true);
    assert.equal(h.document.getElementById('field-bubble'), null);
    h = requiredHarness([{ id: 'quantity', label: 'Quantity', value: '1.5', message: 'Please enter a valid value.' }]);
    assert.equal(h.fns._ntCheckRequired(h.form), false);
    assert.equal(h.document.getElementById('field-bubble').textContent, 'Please enter a valid value.');
});

test('one bubble for all three: New Trade fields, fill rows (both pages) and the Reflection exit fields', () => {
    assert.match(extractFunction(APP, '_ntCheckRequired'), /_showFieldBubble\(el, msg\);/);
    assert.match(extractFunction(APP, '_fillFieldPopup'), /return _showFieldBubble\(input,/);
    assert.match(extractFunction(APP, '_ntShowFillError'), /_fillFieldPopup\(input, bad\.field\);/);
    assert.match(extractFunction(JNL, '_jnlShowFillError'), /_fillFieldPopup\(input, bad\.field\);/);
    assert.match(extractFunction(JNL, '_jnlShowOpenHint'), /_showFieldBubble\(field,/);
    ['_ntShowFillError', '_ntCheckRequired', '_fillFieldPopup'].forEach(n =>
        assert.doesNotMatch(extractFunction(APP, n), /createElement/, n + ' builds no popup of its own'));
    ['_jnlShowFillError', '_jnlShowOpenHint'].forEach(n =>
        assert.doesNotMatch(extractFunction(JNL, n), /createElement/, n + ' builds no popup of its own'));
    assert.ok(!APP.includes('fill-field-popup') && !JNL.includes('jnl-exit-popup'), 'old popups gone');
    // Theme variables only, so it follows every theme.
    const css = CSS.slice(CSS.indexOf('.field-bubble {'));
    ['var(--bg-card)', 'var(--text-primary)', 'var(--border)', 'var(--warning)'].forEach(v => assert.ok(css.includes(v), v));
});

test('Reflection exit bubble: only clears its own bubble, so it never hides a fill-row bubble', () => {
    const document = makeDom();
    const rows = document.add('rows');
    const r1 = document.row(rows, 'data-jnl-fill', FILL_KEYS);
    const hint = document.add('jnl-open-hint');
    const { fns } = sandbox([[APP, POPUP_FNS], [JNL, ['_jnlShowOpenHint']]], { document });
    fns._fillFieldPopup(r1.children[2], 'exit price');
    fns._jnlShowOpenHint(false);
    assert.equal(document.getElementById('field-bubble').textContent, 'Exit price is required');
    // An exit-field bubble is cleared by the same call.
    const group = document.add('');
    const exitTime = document.add('jnl-exit-time', group);
    exitTime.closest = () => group;
    fns._jnlShowOpenHint(true, 'jnl-exit-time');
    const pop = document.getElementById('field-bubble');
    assert.equal(pop.className, 'field-bubble field-bubble--above');
    assert.equal(pop.parentNode, group);
    assert.equal(pop.textContent, 'Exit Time is required to close this trade');
    assert.equal(hint.textContent, 'Enter both exit price and exit time to close this trade.');
    fns._jnlShowOpenHint(false);
    assert.equal(document.getElementById('field-bubble'), null);
});

// ── Back to Trades with an incomplete fill row ──────────────────────────────

function backHarness(rawRows, o) {
    o = o || {};
    const document = makeDom();
    const rowsC = document.add('jnl-fills-rows');
    const box = document.add('jnl-fills-error');
    rawRows.forEach(() => document.row(rowsC, 'data-jnl-fill', FILL_KEYS));
    document.selectors['#jnl-fills-rows [data-jnl-fill]'] = () => rowsC.children.flatMap(r => r.children);
    // The confirm modal, as _jnlConfirmDiscardRow builds it.
    const modal = document.add('jnl-discard-row-modal');
    const cls = new Set(['modal']);
    modal.classList = { add: c => cls.add(c), remove: c => cls.delete(c), contains: c => cls.has(c) };
    ['stay', 'discard'].forEach(k => { document.add('', modal).attrs['data-jnl-discard'] = k; });
    const closed = [];
    const trade = { id: 9, fills: [{}, {}], exitTime: 'x', exitPrice: 1, source: 'manual' };
    const { fns } = sandbox([
        [APP, POPUP_FNS.concat(['_ntFindIncompleteFillRow'])],
        [JNL, ['jnlBackToTrades', '_jnlConfirmDiscardRow', '_jnlShowFillError', '_jnlClearFillError', '_jnlFillsMsg',
            '_jnlFillsEditable', '_jnlIsWebull']],
    ], {
        document, window: { _jnlSelectedTradeId: 9, _isOpenTrade: () => false },
        journalData: { trades: [trade] },
        _jnlFillsDirty: o.dirty !== false,
        _jnlSerializeFillRows: () => rawRows,
        _jnlFillRowEls: () => rowsC.children,
        closeJournalEditor: () => closed.push(true),
    });
    const btn = k => modal.children.find(c => c.attrs['data-jnl-discard'] === k);
    return { document, rowsC, box, modal, cls, btn, closed, fns, rawRows };
}

const JROW = { qty: '10', entryPrice: '10', exitPrice: '11', entryTime: '2026-10-28T10:00', exitTime: '2026-10-28T10:05', fees: '' };
const JPART = { qty: '5', entryPrice: '', exitPrice: '', entryTime: '', exitTime: '', fees: '' };

test('Back to Trades: an incomplete fill row shows the bubble and the in-app confirm; nothing leaves yet', () => {
    const h = backHarness([JROW, JPART]);
    h.fns.jnlBackToTrades();
    assert.equal(h.closed.length, 0);
    assert.ok(h.cls.has('active'), 'confirm open');
    const input = h.rowsC.children[1].children[1];
    const pop = h.document.getElementById('field-bubble');
    assert.equal(pop.textContent, 'Entry price is required');
    assert.equal(pop.parentNode, h.rowsC.children[1]);
    assert.equal(h.box.textContent, 'Row #2: entry price is missing.');
    assert.equal(input.style.borderColor, 'var(--danger, #f87171)');
    // Markup and wording of the modal; no window.confirm.
    const src = extractFunction(JNL, '_jnlConfirmDiscardRow');
    assert.ok(src.includes('This fill row is incomplete and can&#39;t be saved. Discard it?'));
    assert.match(src, />Stay<\/button>/);
    assert.match(src, />Discard<\/button>/);
    assert.match(src, /className = 'modal'/);
    assert.doesNotMatch(src + extractFunction(JNL, 'jnlBackToTrades'), /confirm\(/);
    assert.match(HTML, /onclick="jnlBackToTrades\(\)">← Back to Trades/);
});

test('Back to Trades: Stay keeps the page and the row, back on the missing field', () => {
    const rows = [JROW, Object.assign({}, JPART)];
    const h = backHarness(rows);
    h.fns.jnlBackToTrades();
    h.document.focused = null;
    h.btn('stay').onclick();
    assert.equal(h.closed.length, 0);
    assert.ok(!h.cls.has('active'), 'confirm closed');
    assert.equal(h.rawRows.length, 2);
    assert.equal(h.rawRows[1].qty, '5');
    assert.equal(h.document.focused, h.rowsC.children[1].children[1]);
    assert.equal(h.document.getElementById('field-bubble').textContent, 'Entry price is required');
});

test('Back to Trades: Discard leaves as before', () => {
    const h = backHarness([{ qty: '', entryPrice: '', exitPrice: '3', entryTime: '', exitTime: '', fees: '' }]);
    h.fns.jnlBackToTrades();
    h.btn('discard').onclick();
    assert.equal(h.closed.length, 1);
    assert.ok(!h.cls.has('active'));
});

test('Back to Trades: complete rows, empty rows and unedited rows leave with no confirm', () => {
    const empty = { qty: '', entryPrice: '', exitPrice: '', entryTime: '', exitTime: '', fees: '' };
    let h = backHarness([JROW, empty]);
    h.fns.jnlBackToTrades();
    assert.equal(h.closed.length, 1);
    assert.ok(!h.cls.has('active'));
    h = backHarness([Object.assign({}, JROW, { exitTime: '' })], { dirty: false });
    h.fns.jnlBackToTrades();
    assert.equal(h.closed.length, 1);
    assert.equal(h.document.getElementById('field-bubble'), null);
});
