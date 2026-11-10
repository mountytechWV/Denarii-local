// Webull UI: Settings → Integrations and the Broker Accounts link section
// (window.denariiWebull), and the Merge Trades block for Webull trades
// (Denarii.js). These are browser scripts, so the functions (and the
// constants they use) are cut out of the source, as tests/helpers/auth-mappers.js does.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');

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

function extractConst(src, re, name) {
    const m = re.exec(src);
    if (!m) throw new Error(name + ' not found');
    return m[0];
}

const baSrc = fs.readFileSync(path.join(root, 'js', 'pages', 'broker-accounts.js'), 'utf8');

// ── _dashCheckMergeCompat ──
const dSrc = fs.readFileSync(path.join(root, 'Denarii.js'), 'utf8');
const makeCheck = trades => new Function('journalData',
    extractFunction(dSrc, '_dashCheckMergeCompat') + '\nreturn _dashCheckMergeCompat;')({ trades });

const base = { symbol: 'AAPL', assetType: 'stock', type: 'long', brokerAccountId: 'ba_x' };

test('merge blocked when any selected trade is source webull', () => {
    const check = makeCheck([
        Object.assign({ id: 1, source: 'webull' }, base),
        Object.assign({ id: 2, source: 'csv' }, base),
    ]);
    const r = check([1, 2]);
    assert.equal(r.ok, false);
    assert.match(r.reason, /Webull/);
});

test('merge of CSV trades still passes', () => {
    const check = makeCheck([
        Object.assign({ id: 1, source: 'csv' }, base),
        Object.assign({ id: 2, source: 'csv' }, base),
    ]);
    assert.deepEqual(check([1, 2]), { ok: true, reason: '' });
});

// Deployed regression: Webull accounts hidden, only Pelosi trades selected.
const pelosiAcct = { id: 'ba_pelosi', visible: true };
const wbAcct = { id: 'ba_wb', visible: false };
const mixedTrades = [
    Object.assign({}, base, { id: 1792516300000, brokerAccountId: 'ba_wb', source: 'webull', externalId: 'webull:ba_wb:a:1' }),
    Object.assign({}, base, { id: 1792516300001, brokerAccountId: 'ba_wb', source: 'webull', externalId: 'webull:ba_wb:a:2' }),
    Object.assign({}, base, { id: 1700000000000, brokerAccountId: 'ba_pelosi', source: 'csv' }),
    Object.assign({}, base, { id: 1700000000001, brokerAccountId: 'ba_pelosi', source: 'csv' }),
];

test('Pelosi/CSV selection passes when journalData also holds webull trades', () => {
    const check = makeCheck(mixedTrades);
    assert.deepEqual(check([1700000000000, 1700000000001]), { ok: true, reason: '' });
});

const prune = (journalData, selected) => new Function('journalData', '_dashSelectedIds',
    extractFunction(dSrc, '_dashPruneSelection') + '\n_dashPruneSelection();')(journalData, selected);

test('selection made before hiding Webull accounts is pruned to visible trades, then merge passes', () => {
    const jd = { trades: mixedTrades, brokerAccounts: [pelosiAcct, wbAcct] };
    // Webull trades selected earlier (deployed test step 7), then Pelosi trades added after hiding.
    const selected = new Set([1792516300000, 1792516300001, 1700000000000, 1700000000001]);
    assert.equal(makeCheck(mixedTrades)([...selected]).ok, false);   // the deployed symptom
    prune(jd, selected);
    assert.deepEqual([...selected], [1700000000000, 1700000000001]);
    assert.deepEqual(makeCheck(mixedTrades)([...selected]), { ok: true, reason: '' });
});

test('prune keeps visible-account selections and drops deleted trades', () => {
    const jd = { trades: mixedTrades, brokerAccounts: [pelosiAcct, Object.assign({}, wbAcct, { visible: true })] };
    const selected = new Set([1792516300000, 1700000000000, 42]);
    prune(jd, selected);
    assert.deepEqual([...selected], [1792516300000, 1700000000000]);
});

test('merge of Pelosi demo / manual trades (no source) still passes', () => {
    const pelosi = Object.assign({}, base, { brokerAccountId: 'ba_pelosi' });
    const check = makeCheck([Object.assign({ id: 1 }, pelosi), Object.assign({ id: 2, source: 'manual' }, pelosi)]);
    assert.deepEqual(check([1, 2]), { ok: true, reason: '' });
});

// ── Webull merge (closed trades only; order IDs kept on the merged trade) ──
const engine = require('../js/services/webull-sync.js');

// Real merge path from Denarii.js with the browser/cloud calls stubbed.
function mergeHarness(trades, primaryId, stubs) {
    stubs = stubs || {};
    const calls = { saved: [], deleted: [], alerts: [] };
    const names = ['_isOpenTrade', '_dashUnionOrderIds', '_dashCheckMergeCompat', '_dashExpandTradeToFills',
        '_contractMultiplier', 'deriveTradeSummaryFromFills', 'finalizeTradeSummary',
        '_dashTradesTabActive', '_dashVisibleSelectedIds', '_dashPruneToVisible', '_roundTradeForSave', 'dashConfirmMerge'];
    // The selected rows are the visible Trades-tab rows (Batch A2 visible-only backstop).
    const code = 'var journalData = jd; var _dashSelectedIds = sel; var _dashMergePrimaryId = pid;\n' +
        'var _dashMergePickerActive = true; var _dashVisibleIds = Array.from(sel);\n' +
        'var document = { querySelector: function () { return null; } };\n' +
        // extractFunction starts at "function", so dashConfirmMerge needs its "async" back.
        names.map(n => (n === 'dashConfirmMerge' ? 'async ' : '') + extractFunction(dSrc, n)).join('\n') +
        '\nreturn { run: dashConfirmMerge, trades: function () { return journalData.trades; }, data: function () { return journalData; },' +
        ' finalize: finalizeTradeSummary, check: _dashCheckMergeCompat, union: _dashUnionOrderIds };';
    const h = new Function('jd', 'sel', 'pid', 'confirm', 'alert', '_isCloudPrimarySave', '_saveTradeToSupabase',
        '_deleteTradesFromSupabase', '_triggerCloudDashRefresh', 'saveToIndexedDB', 'updateDashboard', 'WebullSync', code)(
        { trades }, new Set(trades.filter(t => t.selected).map(t => Number(t.id))), primaryId,
        () => true, m => calls.alerts.push(m), () => true,
        async t => { calls.saved.push(JSON.parse(JSON.stringify(t))); return stubs.save ? stubs.save(t) : { success: true }; },
        async ids => { calls.deleted.push(ids); return stubs.del ? stubs.del(ids) : { success: true }; },
        () => {}, async () => {}, () => {}, engine);
    h.calls = calls;
    return h;
}

// Engine fixtures: two closed AAA longs, the second with a scale-out.
const JID = 'ba_wb', WID = 'acct1';
const at = m => new Date(Date.UTC(2026, 6, 1, 14, m)).toISOString();
const wbFill = (orderId, side, qty, price, m, fees) => ({ orderId, symbol: 'AAA', side, positionIntent: null,
    status: 'FILLED', instrumentType: 'EQUITY', filledQty: qty, filledPrice: price, filledAt: at(m), placedAt: null,
    fees: fees || 0, legs: [] });
const wbFills = [
    wbFill('b1', 'BUY', 10, 10, 1, 0.1), wbFill('s1', 'SELL', 10, 12, 2, 0.2),
    wbFill('b2', 'BUY', 5, 11, 3, 0.1), wbFill('s2', 'SELL', 3, 13, 4, 0.1), wbFill('s3', 'SELL', 2, 9, 5, 0.1),
];

function importedTrades() {
    const finalize = mergeHarness([], null).finalize;
    let id = 1000;
    const r = engine.buildPreview(wbFills, [], { journalId: JID, webullAccountId: WID, finalize, nextId: () => id++ });
    assert.equal(r.create.length, 2);
    return r.create.map(t => engine.roundTrade(t));
}

test('all-Webull closed trades merge: order IDs unioned, externalId kept, totals summed', async () => {
    const [a, b] = importedTrades();
    const before = JSON.parse(JSON.stringify([a, b]));
    a.selected = b.selected = true;
    const h = mergeHarness([a, b], a.id);
    await h.run();
    const out = h.trades();
    assert.equal(out.length, 1);
    const m = out[0];
    assert.equal(m.externalId, before[0].externalId);
    assert.deepEqual(m.externalOrderIds, { b1: 10, s1: 10, b2: 5, s2: 3, s3: 2 });
    assert.equal(m.quantity, before[0].quantity + before[1].quantity);
    assert.equal(m.pnl, engine.roundTo(before[0].pnl + before[1].pnl, 2));
    assert.equal(m.commissionFees, engine.roundTo(before[0].commissionFees + before[1].commissionFees, 2));
    assert.deepEqual(h.calls.deleted, [[b.id]]);
    assert.equal(h.calls.alerts.length, 1);   // the existing "Merged N trades" alert
});

test('after a merge, the same fills create nothing and count as alreadyImported', async () => {
    const [a, b] = importedTrades();
    a.selected = b.selected = true;
    const h = mergeHarness([a, b], a.id);
    await h.run();
    const r = engine.buildPreview(wbFills, h.trades(), { journalId: JID, webullAccountId: WID, finalize: h.finalize });
    assert.equal(r.create.length, 0);
    assert.equal(r.update.length, 0);
    assert.equal(r.skipped.length, 0);
    assert.equal(r.alreadyImported, wbFills.length);
});

test('merge from a fresh cloud load (no fills[], direction not type) keeps totals', async () => {
    const [a, b] = importedTrades().map(t => {
        const c = Object.assign({}, t, { direction: t.type });
        delete c.fills; delete c.type;
        return c;
    });
    a.selected = b.selected = true;
    const [pa, pb] = JSON.parse(JSON.stringify([a, b]));   // the primary is changed in place
    const h = mergeHarness([a, b], a.id);
    await h.run();
    const m = h.trades()[0];
    assert.equal(m.quantity, pa.quantity + pb.quantity);
    assert.equal(m.pnl, engine.roundTo(pa.pnl + pb.pnl, 2));
    assert.equal(m.commissionFees, engine.roundTo(pa.commissionFees + pb.commissionFees, 2));
    assert.equal(m.grossPnl, engine.roundTo(pa.grossPnl + pb.grossPnl, 2));
    assert.deepEqual(Object.keys(m.externalOrderIds).sort(), ['b1', 'b2', 's1', 's2', 's3']);
});

test('order ID present in two trades: quantities add', () => {
    const union = mergeHarness([], null).union;
    assert.deepEqual(union([{ externalOrderIds: { x: 3, y: 1 } }, { externalOrderIds: { x: 2 } }, {}]), { x: 5, y: 1 });
});

test('a failed primary save deletes nothing and restores the trades', async () => {
    const [a, b] = importedTrades();
    a.selected = b.selected = true;
    const before = JSON.parse(JSON.stringify([a, b]));
    const h = mergeHarness([a, b], a.id, { save: () => ({ success: false, error: 'boom' }) });
    await h.run();
    assert.deepEqual(h.calls.deleted, []);
    assert.deepEqual(JSON.parse(JSON.stringify(h.trades())), before);
    assert.match(h.calls.alerts[0], /Failed to save merge/);
});

test('a failed delete puts the primary row back and restores the trades', async () => {
    const [a, b] = importedTrades();
    a.selected = b.selected = true;
    const before = JSON.parse(JSON.stringify([a, b]));
    const h = mergeHarness([a, b], a.id, { del: () => ({ success: false, error: 'boom' }) });
    await h.run();
    assert.equal(h.calls.saved.length, 2);                       // merged, then original
    assert.deepEqual(h.calls.saved[1].externalOrderIds, before[0].externalOrderIds);
    assert.deepEqual(JSON.parse(JSON.stringify(h.trades())), before);
    assert.match(h.calls.alerts[0], /Reload the page and try again/);
});

test('merge records the absorbed trades\' orders as ignored (W5); the primary\'s stay importable', async () => {
    const [a, b] = importedTrades();
    a.selected = b.selected = true;
    const h = mergeHarness([a, b], a.id);
    await h.run();
    assert.deepEqual(h.data().webullIgnoredOrders, { [JID]: { b2: true, s2: true, s3: true } });
    // The same fills still create nothing: absorbed orders are dropped, the primary's count as imported.
    const plan = engine.planBatch({ journalId: JID, webullAccountId: WID, fills: wbFills }, h.data(), { finalize: h.finalize });
    assert.equal(plan.creates.length + plan.updates.length, 0);
    assert.equal(plan.ignored, 3);
});

test('a failed merge save restores webullIgnoredOrders (W5)', async () => {
    const [a, b] = importedTrades();
    a.selected = b.selected = true;
    const h = mergeHarness([a, b], a.id, { save: () => ({ success: false, error: 'boom' }) });
    h.data().webullIgnoredOrders = { other: { z: true } };
    await h.run();
    assert.deepEqual(h.data().webullIgnoredOrders, { other: { z: true } });

    const [c, d] = importedTrades();
    c.selected = d.selected = true;
    const h2 = mergeHarness([c, d], c.id, { save: () => ({ success: false, error: 'boom' }) });
    await h2.run();
    assert.equal('webullIgnoredOrders' in h2.data(), false);
});

test('mixed, open, partly closed, and missing-ID Webull selections are blocked', () => {
    const [a, b] = importedTrades();
    const csv = Object.assign({}, a, { id: 5, source: 'csv' });
    delete csv.externalId; delete csv.externalOrderIds;
    const check = list => mergeHarness(list, null).check(list.map(t => t.id));
    assert.match(check([a, csv]).reason, /only be merged with other imported Webull/);
    assert.match(check([a, Object.assign({}, b, { exitTime: null, exitPrice: null })]).reason, /Open Webull trades/);
    assert.match(check([a, Object.assign({}, b, { webullPartials: [] })]).reason, /Open Webull trades/);
    assert.match(check([a, Object.assign({}, b, { externalId: null })]).reason, /missing its import IDs/);
    assert.match(check([a, Object.assign({}, b, { externalOrderIds: {} })]).reason, /missing its import IDs/);
    assert.deepEqual(check([a, b]), { ok: true, reason: '' });
});

const csvPair = () => [
    Object.assign({ id: 1, selected: true, source: 'csv', quantity: 10, entryPrice: 1, exitPrice: 2,
        entryTime: at(1), exitTime: at(2), commissionFees: 0, pnl: 10 }, base),
    Object.assign({ id: 2, selected: true, source: 'csv', quantity: 5, entryPrice: 1, exitPrice: 3,
        entryTime: at(3), exitTime: at(4), commissionFees: 0, pnl: 10 }, base),
];

test('non-Webull merge: a failed primary save deletes nothing and restores the trades', async () => {
    const [t1, t2] = csvPair();
    const before = JSON.parse(JSON.stringify([t1, t2]));
    const h = mergeHarness([t1, t2], 1, { save: () => ({ success: false, error: 'boom' }) });
    await h.run();
    assert.deepEqual(h.calls.deleted, []);
    assert.deepEqual(JSON.parse(JSON.stringify(h.trades())), before);
    assert.match(h.calls.alerts[0], /Failed to save merge/);
    assert.match(h.calls.alerts[0], /Your data was not changed/);
});

test('non-Webull merge: a failed delete puts the primary row back and restores the trades', async () => {
    const [t1, t2] = csvPair();
    const before = JSON.parse(JSON.stringify([t1, t2]));
    const h = mergeHarness([t1, t2], 1, { del: () => ({ success: false, error: 'boom' }) });
    await h.run();
    assert.equal(h.calls.saved.length, 2);                       // merged, then original
    assert.equal(h.calls.saved[1].quantity, before[0].quantity);
    assert.equal(h.calls.saved[1].pnl, before[0].pnl);
    assert.deepEqual(JSON.parse(JSON.stringify(h.trades())), before);
    assert.match(h.calls.alerts[0], /Reload the page and try again/);
});

test('non-Webull merge stores rounded money and prices', async () => {
    const pair = csvPair().map(t => Object.assign(t, { quantity: 3, entryPrice: 10.1, exitPrice: 10.2, pnl: (10.2 - 10.1) * 3, commissionFees: 0.1 + 0.2 }));
    const h = mergeHarness(pair, 1);
    await h.run();
    const saved = h.calls.saved[0];
    assert.equal(saved.pnl, Math.round(saved.pnl * 100) / 100);
    assert.equal(saved.commissionFees, Math.round(saved.commissionFees * 100) / 100);
    assert.equal(saved.entryPrice, Math.round(saved.entryPrice * 10000) / 10000);
    assert.equal(h.trades()[0].pnl, saved.pnl);
});

test('non-Webull merge success unchanged: absorbed trade deleted, no Webull fields', async () => {
    const [t1, t2] = csvPair();
    const h = mergeHarness([t1, t2], 1);
    await h.run();
    assert.equal(h.trades().length, 1);
    assert.deepEqual(h.calls.deleted, [[2]]);
    assert.equal(h.trades()[0].pnl, 20);
    assert.equal(h.trades()[0].externalOrderIds, undefined);
    assert.match(h.calls.alerts[0], /Merged 2 trades/);
});

// ── Webull UI (docs/webull-local-plan.md §9, §11) ──
const J1 = 'ba_1792516090168_r2mg8', J2 = 'ba_1792516127580_nww4g';
const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const settingsSrc = fs.readFileSync(path.join(root, 'js', 'pages', 'settings.js'), 'utf8');

function between(src, start, end) {
    const i = src.indexOf(start);
    const j = src.indexOf(end, i);
    if (i < 0 || j < 0) throw new Error('block not found: ' + start);
    return src.slice(i, j);
}

// Records preload calls; each method answers from `answers` (value or function of the argument).
function fakeWebull(answers) {
    const calls = [];
    const listeners = [];
    const api = { calls, listeners };
    for (const m of ['status', 'connect', 'checkApproval', 'resendCode', 'disconnect', 'setLink', 'removeLink', 'syncNow']) {
        api[m] = async arg => {
            calls.push([m, arg === undefined ? undefined : JSON.parse(JSON.stringify(arg))]);
            const a = answers[m];
            return typeof a === 'function' ? a(arg) : (a === undefined ? { ok: true } : a);
        };
    }
    api.onStatus = cb => { listeners.push(cb); return () => {}; };
    return api;
}

function fakeEl(id, extra) {
    return Object.assign({ id, value: '', innerHTML: '', textContent: '', disabled: false, style: {},
        addEventListener() {} }, extra);
}

const progressEvent = { kind: 'progress', journalId: J1, windowIndex: 12, windowCount: 35,
    windowStart: '2021-03-15T00:00:00.000Z', windowEnd: '2021-06-13T00:00:00.000Z', ordersSoFar: 1240 };
const PROGRESS_TEXT = 'Importing Webull history: Mar 2021 - Jun 2021 (window 12 of 35, 1,240 orders)';

const okStatus = (links, extra) => Object.assign({
    connected: true, last4: 'AB12', approvalState: 'ok', approvalExpiresAt: '2026-12-01T00:00:00.000Z',
    accounts: [{ id: 'acct-9', label: 'Margin ••1234' }, { id: 'acct-7', label: 'Cash ••5678' }],
    defaultStartDate: '2021-03-01', links: links || []
}, extra);

test('progressText formats a main progress event', () => {
    assert.equal(engine.progressText(progressEvent), PROGRESS_TEXT);
    assert.equal(engine.progressText(null), '');
    assert.equal(engine.progressText({ windowStart: 'x', windowEnd: null }), '');
});

test('"not available" copy, auto-import toggle and in-page auto-sync are gone', () => {
    for (const src of [settingsSrc, baSrc, dSrc]) {
        assert.equal(src.indexOf("isn't available in this version"), -1);
        assert.equal(src.indexOf('_wbAutoSyncOnLoad'), -1);
    }
    const wb = between(baSrc, '// ── Webull link (per-journal', "document.getElementById('ba-broker')?.addEventListener");
    for (const gone of ['ba-wb-auto', 'Auto-import', '_wbAutoRun', 'localStorage', 'navigator.locks', 'webull_journal_imports', '/api/webull', 'SupabaseAuth']) {
        assert.equal(wb.indexOf(gone), -1, gone);
    }
    const sw = between(settingsSrc, '// ── Webull (Settings → Integrations) ──', '// ── Tags Management ──');
    for (const gone of ['/api/webull', 'SupabaseAuth', 'Sign in to your cloud account']) assert.equal(sw.indexOf(gone), -1, gone);
});

// Settings → Integrations
function settingsHarness(answers, opts) {
    opts = opts || {};
    const els = {};
    const panel = fakeEl('settings-integrations', {
        classList: { contains: c => c === 'active' },
        appendChild(el) { els[el.id] = el; }
    });
    els['settings-integrations'] = panel;
    const document = {
        getElementById: id => els[id] || null,
        createElement: () => fakeEl('')
    };
    const wb = opts.unavailable ? null : fakeWebull(answers || {});
    const window = { denariiWebull: wb, confirm: () => true };
    const fns = new Function('document', 'window', 'escapeHtml', 'WebullSync', 'journalData', 'setTimeout', 'clearTimeout',
        between(settingsSrc, '// ── Webull (Settings → Integrations) ──', '// ── Tags Management ──') +
        '\nreturn { webullUi, loadWebullSection, renderWebullSection, connectWebull, syncWebullNow, disconnectWebull };')(
        document, window, escapeHtml, engine, { brokerAccounts: [{ id: J1, displayName: 'WB-Margin' }, { id: J2, displayName: 'WB-Cash' }] },
        () => 0, () => {});
    return Object.assign({ els, wb, html: () => (els['settings-webull'] || {}).innerHTML || '' }, fns);
}

test('Settings: hidden without window.denariiWebull', async () => {
    const h = settingsHarness(null, { unavailable: true });
    await h.loadWebullSection();
    assert.equal(h.els['settings-webull'].style.display, 'none');
    assert.equal(h.html(), '');
});

test('Settings: connect form has the start date field', async () => {
    const h = settingsHarness({ status: { connected: false } });
    await h.loadWebullSection();
    const html = h.html();
    assert.match(html, /<label for="settings-webull-start">Import trades starting from<\/label>/);
    assert.match(html, /<input type="date" id="settings-webull-start" min="2018-05-21" max="\d{4}-\d{2}-\d{2}">/);
    assert.match(html, /Leave empty to import all history\./);
    assert.match(html, /id="settings-webull-secret"/);
});

test('Settings: connect sends key, secret and date, then clears the secret field', async () => {
    const h = settingsHarness({ status: { connected: false }, connect: { ok: true, approvalState: 'needs_approval', last4: 'AB12' } });
    await h.loadWebullSection();
    h.els['settings-webull-key'] = fakeEl('settings-webull-key', { value: 'KEY-123' });
    h.els['settings-webull-secret'] = fakeEl('settings-webull-secret', { value: 'SECRET-456' });
    h.els['settings-webull-start'] = fakeEl('settings-webull-start', { value: '2021-03-01' });
    await h.connectWebull();
    assert.deepEqual(h.wb.calls.find(c => c[0] === 'connect')[1], { appKey: 'KEY-123', appSecret: 'SECRET-456', startDate: '2021-03-01' });
    assert.equal(h.els['settings-webull-secret'].value, '');
    assert.equal(h.els['settings-webull-key'].value, '');
    assert.ok(!h.html().includes('SECRET-456'));
    assert.match(h.html(), /Webull connected · key ••••AB12/);
    assert.match(h.html(), /I've approved it, check again/);
    assert.match(h.html(), /Send new code/);
    assert.match(h.html(), /Also revoke the App Key in Webull's developer portal if you no longer use it\./);
});

test('Settings: empty start date means all history; a failed connect still clears the secret', async () => {
    const h = settingsHarness({ status: { connected: false }, connect: { ok: false, error: 'Webull rejected the credentials' } });
    await h.loadWebullSection();
    h.els['settings-webull-key'] = fakeEl('settings-webull-key', { value: 'KEY-123' });
    h.els['settings-webull-secret'] = fakeEl('settings-webull-secret', { value: 'SECRET-456' });
    h.els['settings-webull-start'] = fakeEl('settings-webull-start', { value: '' });
    await h.connectWebull();
    assert.equal(h.wb.calls.find(c => c[0] === 'connect')[1].startDate, null);
    assert.equal(h.els['settings-webull-secret'].value, '');
    assert.match(h.html(), /alert-danger[^>]*>Webull rejected the credentials</);
});

test('Settings: connected shows last sync, progress, errors, Sync now and the revoke note', async () => {
    const links = [
        { journalId: J1, webullAccountId: 'acct-9', startDate: null, lastSyncedAt: '2026-11-09T15:00:00.000Z', status: 'running', error: null, progress: progressEvent },
        { journalId: J2, webullAccountId: 'acct-7', startDate: null, lastSyncedAt: null, status: 'error', error: 'Webull is unavailable', progress: null },
    ];
    const h = settingsHarness({ status: okStatus(links) });
    await h.loadWebullSection();
    const html = h.html();
    assert.match(html, /Margin ••1234/);
    assert.match(html, /Webull approval expires /);
    assert.match(html, /Last synced: (?!Never)/);
    assert.ok(html.includes('WB-Margin: ' + PROGRESS_TEXT));
    assert.match(html, /alert-danger[^>]*>WB-Cash: Webull is unavailable</);
    assert.match(html, /onclick="syncWebullNow\(\)" disabled>Syncing…</);   // a journal is running
    assert.ok(html.indexOf('Disconnect') < html.indexOf("Also revoke the App Key in Webull's developer portal if you no longer use it."));
});

test('Settings: Sync now starts a run; progress and error events render', async () => {
    const link = { journalId: J1, webullAccountId: 'acct-9', startDate: '2021-03-01', lastSyncedAt: null, status: 'ok', error: null, progress: null };
    let status = okStatus([link]);
    const h = settingsHarness({ status: () => status, syncNow: { ok: true, started: true } });
    await h.loadWebullSection();
    assert.match(h.html(), /onclick="syncWebullNow\(\)">Sync now</);
    assert.match(h.html(), /Last synced: Never/);
    await h.syncWebullNow();
    assert.deepEqual(h.wb.calls.filter(c => c[0] === 'syncNow'), [['syncNow', undefined]]);

    const emit = ev => h.wb.listeners.forEach(cb => cb(ev));
    emit(progressEvent);
    assert.ok(h.html().includes(PROGRESS_TEXT));
    status = okStatus([Object.assign({}, link, { progress: null, status: 'needs_approval', error: 'Your Webull approval expired. Tap Send new code.' })]);
    emit({ kind: 'journal', journalId: J1, status: 'needs_approval', error: 'Your Webull approval expired. Tap Send new code.' });
    emit({ kind: 'run', running: false });
    await new Promise(r => setImmediate(r));
    assert.ok(!h.html().includes(PROGRESS_TEXT));
    assert.match(h.html(), /alert-warning[^>]*>WB-Margin: Your Webull approval expired/);
    assert.match(h.html(), /onclick="syncWebullNow\(\)">Sync now</);
});

test('Settings: Sync now while busy shows a message; no links shows the link hint', async () => {
    const link = { journalId: J1, webullAccountId: 'acct-9', status: 'ok', error: null, progress: null };
    const h = settingsHarness({ status: okStatus([link]), syncNow: { ok: true, busy: true } });
    await h.loadWebullSection();
    await h.syncWebullNow();
    assert.match(h.html(), /A Webull sync is already running\./);
    const none = settingsHarness({ status: okStatus([]) });
    await none.loadWebullSection();
    assert.match(none.html(), /Link a broker account to Webull in Settings → Broker Accounts/);
    assert.ok(!none.html().includes('syncWebullNow'));
});

test('Settings: disconnect shows the revoke note', async () => {
    const h = settingsHarness({ status: okStatus([]), disconnect: { ok: true } });
    await h.loadWebullSection();
    await h.disconnectWebull();
    assert.match(h.html(), /alert-warning[^>]*>Also revoke the App Key in Webull's developer portal if you no longer use it\.</);
    assert.match(h.html(), /id="settings-webull-start"/);
});

// Broker Accounts → Webull link
const BA_WB_SRC = between(baSrc, '// ── Webull link (per-journal', "document.getElementById('ba-broker')?.addEventListener") +
    '\nreturn { wbUi, _wbInitSection, _wbRender, _wbPrepareSave, _wbCommitSave, _wbRunSave, _wbLinkChanged, _wbOnStatus,' +
    ' _wbSyncNow, _wbOverlapNote, _wbValidStartDate, _wbRefreshCardFlags, _clearBrokerCardCache, _wbReviewAction, _wbCardReviewHtml,' +
    ' WB_REMOVE_CONFIRM, WB_START_WARN, WB_LINK_FAILED_MSG, WB_SAVE_MSG, WB_DATE_MSG, syncRunning: () => wbSyncRunning };';

function baHarness(answers, opts) {
    opts = Object.assign({ broker: 'Webull', confirm: true, trades: [] }, opts);
    const els = { 'ba-broker': fakeEl('ba-broker', { value: opts.broker }) };
    const section = fakeEl('ba-webull-section');
    els['ba-webull-section'] = section;
    const calls = { confirms: [], lists: 0 };
    const document = { getElementById: id => els[id] || null, createElement: () => fakeEl('') };
    const wb = fakeWebull(answers || {});
    const fns = new Function('document', 'window', 'escapeHtml', 'WebullSync', 'journalData', 'confirm', 'renderBrokerAccountsList', BA_WB_SRC)(
        document, { denariiWebull: wb }, escapeHtml, opts.webullSync || engine,
        Object.assign({ trades: opts.trades, brokerAccounts: [{ id: J1, displayName: 'WB-Margin' }, { id: J2, displayName: 'WB-Cash' }] }, opts.journal),
        m => { calls.confirms.push(m); return opts.confirm; }, () => { calls.lists++; });
    const open = async id => { fns._wbInitSection(id); await new Promise(r => setImmediate(r)); };
    return Object.assign({ els, wb, calls, open, html: () => section.innerHTML }, fns);
}

const savedLink = (extra) => Object.assign({ journalId: J1, webullAccountId: 'acct-9', startDate: '2022-01-03',
    lastSyncedAt: '2026-11-09T15:00:00.000Z', status: 'ok', error: null, progress: null }, extra);

test('Broker: a new link starts from the connection date; no auto-import toggle', async () => {
    const h = baHarness({ status: okStatus([]) });
    await h.open(J1);
    assert.equal(h.wbUi.draft.startDate, '2021-03-01');
    assert.match(h.html(), /<label for="ba-wb-start">Import trades starting from<\/label>/);
    assert.match(h.html(), /id="ba-wb-start" min="2018-05-21" max="\d{4}-\d{2}-\d{2}" value="2021-03-01"/);
    assert.match(h.html(), /<option value="acct-9">Margin ••1234<\/option>/);
    assert.ok(!h.html().includes('Auto-import'));
    assert.ok(!h.html().includes('ba-wb-sync'));   // nothing saved yet
});

test('Broker: hidden without window.denariiWebull or for a non-Webull account with no link', async () => {
    const h = baHarness({ status: okStatus([]) }, { broker: 'Robinhood' });
    await h.open(J1);
    assert.equal(h.els['ba-webull-section'].style.display, 'none');
});

test('Broker: saved link shows its date, status, progress, error and Sync now', async () => {
    const running = baHarness({ status: okStatus([savedLink({ status: 'running', progress: progressEvent })]) });
    await running.open(J1);
    assert.match(running.html(), /value="2022-01-03"/);
    assert.match(running.html(), /Status: <span id="ba-wb-status">Running<\/span>/);
    assert.ok(running.html().includes('<div id="ba-wb-progress">' + PROGRESS_TEXT + '</div>'));
    assert.match(running.html(), /id="ba-wb-sync"/);

    const failed = baHarness({ status: okStatus([savedLink({ status: 'offline', error: 'Could not reach Webull.' })]) });
    await failed.open(J1);
    assert.match(failed.html(), /Status: <span id="ba-wb-status">Offline<\/span>/);
    assert.match(failed.html(), /color:var\(--danger\);">Could not reach Webull\.</);
    assert.match(failed.html(), /<div id="ba-wb-progress" style="display:none;"><\/div>/);
});

test('Broker: progress events update status and progress in place; the end reloads status', async () => {
    let status = okStatus([savedLink()]);
    const h = baHarness({ status: () => status });
    await h.open(J1);
    h.els['ba-wb-status'] = fakeEl('ba-wb-status');
    h.els['ba-wb-progress'] = fakeEl('ba-wb-progress');
    const before = h.html();
    h._wbOnStatus({ kind: 'run', running: true });
    h._wbOnStatus(progressEvent);
    assert.equal(h.els['ba-wb-progress'].textContent, PROGRESS_TEXT);
    assert.equal(h.els['ba-wb-status'].textContent, 'Running');
    assert.equal(h.html(), before);   // inputs not re-rendered
    h._wbOnStatus(Object.assign({}, progressEvent, { journalId: J2, ordersSoFar: 5 }));   // another journal
    assert.equal(h.els['ba-wb-progress'].textContent, PROGRESS_TEXT);

    status = okStatus([savedLink({ lastSyncedAt: '2026-11-10T15:00:00.000Z', status: 'error', error: 'Webull is busy. Try again in a minute.' })]);
    h._wbOnStatus({ kind: 'journal', journalId: J1, status: 'error', error: 'Webull is busy. Try again in a minute.' });
    h._wbOnStatus({ kind: 'run', running: false });
    await new Promise(r => setImmediate(r));
    assert.equal(h.syncRunning(), false);
    assert.ok(h.calls.lists >= 1);
    assert.match(h.html(), /Webull is busy\. Try again in a minute\./);
    assert.ok(!h.html().includes(PROGRESS_TEXT));
});

test('Broker: Sync now asks main for this journal', async () => {
    const h = baHarness({ status: okStatus([savedLink()]), syncNow: { ok: true, started: true } });
    await h.open(J1);
    await h._wbSyncNow();
    assert.deepEqual(h.wb.calls.filter(c => c[0] === 'syncNow'), [['syncNow', J1]]);
    assert.equal(h.syncRunning(), true);
    await h._wbSyncNow();   // already running: no second call
    assert.equal(h.wb.calls.filter(c => c[0] === 'syncNow').length, 1);
});

test('Broker: save calls setLink with the date (empty = all history), then starts a sync', async () => {
    const h = baHarness({ status: okStatus([]) });
    await h.open(J1);
    h.wbUi.draft.accountId = 'acct-9';
    assert.equal(h._wbLinkChanged(), true);
    const plan = await h._wbPrepareSave();
    assert.equal(await h._wbCommitSave(plan), null);
    assert.deepEqual(h.wb.calls.filter(c => c[0] === 'setLink' || c[0] === 'syncNow'),
        [['setLink', { journalId: J1, webullAccountId: 'acct-9', startDate: '2021-03-01' }], ['syncNow', J1]]);

    const all = baHarness({ status: okStatus([]) });
    await all.open(J1);
    Object.assign(all.wbUi.draft, { accountId: 'acct-9', startDate: '' });
    await all._wbCommitSave(await all._wbPrepareSave());
    assert.equal(all.wb.calls.find(c => c[0] === 'setLink')[1].startDate, null);
});

test('Broker: a bad date or an account linked elsewhere blocks the save before any write', async () => {
    const h = baHarness({ status: okStatus([]) });
    await h.open(J1);
    Object.assign(h.wbUi.draft, { accountId: 'acct-9', startDate: '2017-12-31' });
    assert.equal(await h._wbPrepareSave(), null);
    assert.equal(h.wbUi.msg, h.WB_DATE_MSG);
    assert.equal(h._wbValidStartDate('2999-01-01'), false);
    assert.equal(h._wbValidStartDate('2021-02-30'), false);
    assert.equal(h._wbValidStartDate(''), true);

    const dup = baHarness({ status: okStatus([savedLink({ journalId: J2 })]) });
    await dup.open(J1);
    dup.wbUi.draft.accountId = 'acct-9';
    assert.equal(await dup._wbPrepareSave(), null);
    assert.equal(dup.wbUi.msg, 'This Webull account is linked to "WB-Cash". Unlink it there first (its trades stay).');
    assert.equal(dup.wb.calls.filter(c => c[0] === 'setLink').length, 0);
});

test('Broker: setLink errors come back for the link-failed message and keep the draft', async () => {
    const h = baHarness({ status: okStatus([]), setLink: { ok: false, error: 'This Webull account is already linked to another journal.' } });
    await h.open(J1);
    h.wbUi.draft.accountId = 'acct-9';
    const plan = await h._wbPrepareSave();
    assert.equal(await h._wbCommitSave(plan), 'This Webull account is already linked to another journal.');
    assert.equal(h.wbUi.draft.accountId, 'acct-9');
    assert.equal(h.wb.calls.filter(c => c[0] === 'syncNow').length, 0);
});

test('Broker: unlink confirms, then removeLink; cancel writes nothing', async () => {
    const no = baHarness({ status: okStatus([savedLink()]) }, { confirm: false });
    await no.open(J1);
    no.wbUi.draft.accountId = '';
    assert.equal(await no._wbPrepareSave(), null);
    assert.deepEqual(no.calls.confirms, [no.WB_REMOVE_CONFIRM]);

    const yes = baHarness({ status: okStatus([savedLink()]) });
    await yes.open(J1);
    yes.wbUi.draft.accountId = '';
    const plan = await yes._wbPrepareSave();
    assert.equal(plan.remove, true);
    assert.equal(await yes._wbCommitSave(plan), null);
    assert.deepEqual(yes.wb.calls.filter(c => c[0] === 'removeLink' || c[0] === 'setLink' || c[0] === 'syncNow'), [['removeLink', J1]]);
});

test('Broker: moving the start date with imported trades asks first', async () => {
    const trades = [{ source: 'webull', brokerAccountId: J1 }];
    const h = baHarness({ status: okStatus([savedLink()]) }, { confirm: false, trades });
    await h.open(J1);
    h.wbUi.draft.startDate = '2021-06-01';
    assert.equal(await h._wbPrepareSave(), null);
    assert.deepEqual(h.calls.confirms, [h.WB_START_WARN]);
});

test('Broker: Save Account order is unchanged', async () => {
    const h = baHarness({ status: okStatus([]) });
    const order = [];
    const deps = {
        linkChanged: () => true,
        prepare: async () => { order.push('prepare'); return { plan: 1 }; },
        saveAccount: async () => { order.push('save'); },
        commit: async () => { order.push('commit'); return 'boom'; },
        refresh: () => order.push('refresh'),
        showLinkError: t => order.push('error:' + t),
        close: () => order.push('close'),
    };
    assert.equal(await h._wbRunSave(deps), 'link-failed');
    assert.deepEqual(order, ['prepare', 'save', 'commit', 'refresh', 'error:' + h.WB_LINK_FAILED_MSG + ' boom']);
});

// Overlap note
const ZZ = 'ba_zz';
const imported = (journal, account, entry, exit) => ({ source: 'webull', brokerAccountId: journal,
    externalId: 'webull:' + journal + ':' + account + ':o' + entry, entryTime: entry, exitTime: exit });
const overlapAccts = [{ id: J1, displayName: 'WB-Margin' }, { id: J2, displayName: 'WB-Cash' }];
const overlapTrades = [
    imported(J1, 'acct-9', '2026-10-20T14:00:00.000Z', '2026-10-21T15:00:00.000Z'),
    // 22:00 New York on Oct 22 (02:00Z Oct 23): market date Oct 22
    imported(J1, 'acct-9', '2026-10-22T14:00:00.000Z', '2026-10-23T02:00:00.000Z'),
    imported(J2, 'acct-7', '2026-10-25T14:00:00.000Z', null),
    imported(ZZ, 'acct-9', '2026-10-26T14:00:00.000Z', null),
    { source: 'csv', brokerAccountId: J1, entryTime: '2026-10-26T14:00:00.000Z' },
];

test('overlap note: shown when the start date is before the newest other-journal trade', () => {
    const { _wbOverlapNote } = baHarness({});
    assert.equal(_wbOverlapNote(ZZ, 'acct-9', '2026-10-01', overlapTrades, overlapAccts),
        'WB-Margin already has trades from this account through Oct 22, 2026. An earlier start date will copy them here too.');
});

test('overlap note: shown on the same day as the newest trade, hidden the day after', () => {
    const { _wbOverlapNote } = baHarness({});
    assert.match(_wbOverlapNote(ZZ, 'acct-9', '2026-10-22', overlapTrades, overlapAccts), /through Oct 22, 2026/);
    assert.equal(_wbOverlapNote(ZZ, 'acct-9', '2026-10-23', overlapTrades, overlapAccts), '');
});

test('overlap note: not shown for another Webull account, own trades, or no account/date', () => {
    const { _wbOverlapNote } = baHarness({});
    assert.equal(_wbOverlapNote(ZZ, 'acct-5', '2026-01-01', overlapTrades, overlapAccts), '');
    assert.equal(_wbOverlapNote(J1, 'acct-9', '2026-01-01', overlapTrades.filter(t => t.brokerAccountId !== ZZ), overlapAccts), '');
    assert.equal(_wbOverlapNote(ZZ, '', '2026-01-01', overlapTrades, overlapAccts), '');
    assert.equal(_wbOverlapNote(ZZ, 'acct-9', '', overlapTrades, overlapAccts), '');
    assert.match(_wbOverlapNote(J1, 'acct-7', '2026-10-25', overlapTrades, overlapAccts), /^WB-Cash .* through Oct 25, 2026/);
});

test('overlap note: found from trade ids alone (other journal unlinked or deleted)', () => {
    const { _wbOverlapNote } = baHarness({});
    assert.match(_wbOverlapNote(ZZ, 'acct-9', '2026-10-01', overlapTrades, []), /^Another journal already has trades/);
});

// ── Broker: Needs review panel (W5) ──
// An open AAA trade the user edited, with a held SELL, plus two BBB fills
// held as older than the first BBB trade.
function reviewJournal() {
    const finalize = mergeHarness([], null).finalize;
    const buy = Object.assign(wbFill('rb1', 'BUY', 10, 10, 1), {});
    const plan = engine.planBatch({ journalId: J1, webullAccountId: 'acct-9', fills: [buy] }, { trades: [] },
        { finalize, nextId: () => 4242 });
    const trade = plan.creates[0];
    trade.quantity = 12;                                    // user edit
    const held = (f, reason) => ({ fill: f, reason, heldAt: '2026-07-02T00:00:00.000Z', webullAccountId: 'acct-9' });
    const bbb = (id, side, m) => Object.assign(wbFill(id, side, 5, 20, m), { symbol: 'BBB' });
    return {
        trades: [trade],
        journal: { webullReview: { [J1]: {
            rs1: held(wbFill('rs1', 'SELL', 10, 12, 30), engine.EDITED),
            ob1: held(bbb('ob1', 'BUY', 2), engine.BEFORE_EXISTING),
            os1: held(bbb('os1', 'SELL', 3), engine.BEFORE_EXISTING),
        } } },
    };
}

test('Broker: Needs review lists the edited trade, its held fill and held older fills', async () => {
    const j = reviewJournal();
    const h = baHarness({ status: okStatus([savedLink()]) }, { trades: j.trades, journal: j.journal });
    await h.open(J1);
    const html = h.html();
    assert.match(html, /Needs review \(4\)/);
    assert.match(html, /AAA · [^<]+ · Long · 12 @ 10 · <span[^>]*>Edited after import</);
    assert.match(html, /Held: AAA · [^<]+ · SELL · 10 @ 12/);
    assert.match(html, /data-wb-review="keep" data-wb-arg="4242">Keep my edits</);
    assert.match(html, /data-wb-review="webull" data-wb-arg="4242">Use Webull's data</);
    assert.equal((html.match(/Before earliest Webull trade/g) || []).length, 2);
    assert.match(html, /data-wb-review="import" data-wb-arg="Before existing Webull trades \(start date moved earlier\)\|EQ\|BBB">Import</);
    assert.match(h._wbCardReviewHtml(J1), /Webull: 4 need review/);
    assert.equal(h._wbCardReviewHtml(J2), '');

    // Nothing to review: no panel, no card line.
    const none = baHarness({ status: okStatus([savedLink()]) });
    await none.open(J1);
    assert.ok(!none.html().includes('Needs review'));
});

test('Broker: a review action calls resolveReview, shows its message and refreshes the cards', async () => {
    const j = reviewJournal();
    const calls = [];
    let answer = { ok: true, message: 'Kept your edits. Applied 1 held fill.' };
    const webullSync = Object.assign({}, engine, { resolveReview: async (...a) => { calls.push(a); return answer; } });
    const h = baHarness({ status: okStatus([savedLink()]) }, { trades: j.trades, journal: j.journal, webullSync });
    await h.open(J1);
    const lists = h.calls.lists;
    await h._wbReviewAction('keep', '4242');
    assert.deepEqual(calls[0].slice(0, 3), [J1, 'keep', { tradeId: '4242' }]);
    assert.equal(calls[0][3].webullAccountId, 'acct-9');
    assert.match(h.html(), /alert-success[^>]*>Kept your edits\. Applied 1 held fill\.</);
    assert.ok(h.calls.lists > lists);

    // Ignore and Use Webull's data ask first; a cancel calls nothing.
    const c = baHarness({ status: okStatus([savedLink()]) }, { trades: j.trades, journal: j.journal, webullSync, confirm: false });
    await c.open(J1);
    await c._wbReviewAction('ignore', 'x');
    await c._wbReviewAction('webull', '4242');
    assert.equal(calls.length, 1);
    assert.equal(c.calls.confirms.length, 2);

    answer = { ok: false, error: 'These fills leave 5 open, which would overlap the later Webull trades. Nothing imported.' };
    await h._wbReviewAction('import', 'g');
    assert.deepEqual(calls[1][2], { groupId: 'g' });
    assert.match(h.html(), /alert-danger[^>]*>These fills leave 5 open/);
});
