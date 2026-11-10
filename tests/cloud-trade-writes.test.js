// Shadow-write fix: in cloud_primary mode the trades domain is never
// bulk-upserted from the local cache, and each trade write path stops and
// leaves local data unchanged when its own cloud save fails.
//
// The real functions are cut out of the browser scripts (brace matching, as
// in webull-ui.test.js) and run inside a `with` scope: names a test sets are
// used, Node globals pass through, and any other global resolves to an inert
// stub (callable, every property is the stub again) so UI calls are no-ops.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const D3 = require('./helpers/d3-auth-fns');
const { fakeSupabase } = require('./helpers/fake-supabase');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const SRC = {
    auth: read('js/auth.js'),
    app: read('Denarii.js'),
    journal: read('js/pages/journal.js'),
    broker: read('js/pages/broker-accounts.js'),
    demo: read('js/demoSeed.js'),
    chart: read('js/pages/stock-chart.js'),
};

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

function extractVar(src, re, name) {
    const m = re.exec(src);
    if (!m) throw new Error(name + ' not found');
    return m[0];
}

const inert = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
});

// parts: [[src, [functionNames]], ...]; vals: the test's globals.
function sandbox(parts, vals, extraCode) {
    const names = [];
    const code = parts.map(([src, fns]) => fns.map(n => { names.push(n); return extractFunction(src, n); }).join('\n')).join('\n');
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
    const fns = new Function('scope', 'with (scope) { return (function () {\n' + (extraCode || '') + '\n' + code +
        '\nreturn {' + names.join(',') + '};\n})(); }')(scope);
    return { fns, g: target };
}

function el(props) {
    return Object.assign({ value: '', disabled: false, checked: false, style: {}, dataset: {}, textContent: '',
        classList: { add() {}, remove() {} }, querySelector: () => null, querySelectorAll: () => [],
        addEventListener() {}, remove() {}, focus() {}, click() {} }, props);
}
function fakeDocument(els, nullIds) {
    return {
        getElementById: id => ((nullIds || []).includes(id) ? null : (els[id] || (els[id] = el()))),
        querySelector: () => el(),
        addEventListener() {},
    };
}
const clone = v => JSON.parse(JSON.stringify(v));
const FAIL = { success: false, error: 'boom' };
const OK = { success: true, error: null };

// ── 1. Shadow write ─────────────────────────────────────────────────────────

function shadowHarness(mode) {
    // Batch D3: cloud_primary non-trade rows are inserted / rev-checked
    // updates, other modes still upsert; every write op is recorded.
    const fake = fakeSupabase({});
    const upserts = { find: f => fake.writes.map(w => ({ table: w.table, n: w.rows.length })).find(f),
        map: f => fake.writes.map(w => ({ table: w.table, n: w.rows.length })).map(f) };
    const client = fake;
    const jd = {
        trades: [{ id: 1, symbol: 'AAA', type: 'long', quantity: 1 }, { id: 2, symbol: 'BBB', type: 'short', quantity: 2 }],
        strategies: [{ id: 10, name: 'S' }],
        version: 2,
    };
    const auth = SRC.auth;
    const { fns, g } = sandbox([[auth, ['_shadowSkipTrades', '_shadowWriteRowsAwaited', '_shadowWriteRows', '_executeShadowWrite',
        '_detectDirtyDomains', '_updateDomainSnapshots', '_mapArrayRow', '_mapReviewRows', '_mapPlannerRows', '_mapUserMetaRows',
        // Batch D2 helpers used by the shadow write
        '_cloudWriteAllowed', '_sessionMatchesAccount', '_mapDomainRows', '_rowKey', '_rowSig', '_changedRows', '_markRows',
        '_savePendingRows', '_recordPendingRows', '_groupRowsByKeySet', ...D3.D3_FNS]]], {
        // Batch D2: the session belongs to this account and (cloud_primary)
        // a cloud baseline is loaded, empty here, so every row counts as changed.
        window: { _denariiStorageMode: mode, _denariiSupabaseUid: 'u1' },
        SupabaseAuth: { isReady: () => true, getClient: () => client, supabaseGetSession: async () => ({ data: { user: { id: 'u1' } } }) },
        journalData: jd,
        _lastShadowWriteMs: 0, _shadowWriteRunning: false, _shadowWritePending: false, _domainSnapshots: {},
        _cloudBaselineReady: true, _cloudPaused: false, _rowBaseline: {}, _cloudPending: {},
        currentAccountId: 'acct', setSetting: async () => {},
        ...D3.d3State(),
    }, extractVar(auth, /var _SHADOW_DOMAINS = \{[\s\S]*?\n\};/, '_SHADOW_DOMAINS') + '\n' +
       extractVar(auth, /var _USER_META_KEYS = \[[\s\S]*?\];/, '_USER_META_KEYS') + '\n' +
       extractVar(auth, /var _CLOUD_KEYED_DOMAINS = \[[^\]]*\];/, '_CLOUD_KEYED_DOMAINS') + '\n' + D3.d3Vars(auth));
    return { fns, g, jd, upserts, tables: () => upserts.map(u => u.table) };
}

async function settle(g) {
    for (let i = 0; i < 50 && g._shadowWriteRunning; i++) await new Promise(r => setImmediate(r));
}

test('shadow write: cloud_primary skips trades on the awaited first save, other domains still written', async () => {
    const h = shadowHarness('cloud_primary');
    await h.fns._shadowWriteRowsAwaited(h.jd);
    assert.ok(!h.tables().includes('trades'));
    assert.ok(h.tables().includes('strategies'));
    assert.ok(h.tables().includes('user_meta'));
});

test('shadow write: cloud_primary skips trades on later saves, even when trades changed', async () => {
    const h = shadowHarness('cloud_primary');
    h.fns._shadowWriteRows(h.jd);
    await settle(h.g);
    h.jd.trades[0].notes = 'changed';
    h.jd.strategies[0].name = 'S2';
    h.g._lastShadowWriteMs = 0;          // past the 10 s debounce
    h.fns._shadowWriteRows(h.jd);
    await settle(h.g);
    assert.ok(!h.tables().includes('trades'));
    assert.equal(h.tables().filter(t => t === 'strategies').length, 2);
});

for (const mode of ['local_legacy', 'migration_pending']) {
    test('shadow write: ' + mode + ' still upserts trades on both paths', async () => {
        const a = shadowHarness(mode);
        await a.fns._shadowWriteRowsAwaited(a.jd);
        assert.deepEqual(a.upserts.find(u => u.table === 'trades'), { table: 'trades', n: 2 });
        const b = shadowHarness(mode);
        b.fns._shadowWriteRows(b.jd);
        await settle(b.g);
        assert.deepEqual(b.upserts.find(u => u.table === 'trades'), { table: 'trades', n: 2 });
    });
}

// ── 2. Edit trade ───────────────────────────────────────────────────────────
// Batch C2: the old Edit Trade page was removed. Its save and Back cases are
// covered on Trade Reflection by the journal edit tests below.

// ── 3. New trade ────────────────────────────────────────────────────────────

function ntHarness(saveResult, existing) {
    const trades = existing ? [existing] : [{ id: 1, symbol: 'OLD' }];
    const calls = { status: [], cleared: 0, idb: 0, saved: [] };
    const { fns, g } = sandbox([[SRC.app, ['_ntCommitTrade', '_ntCanCreate', '_ntClearDraft', '_restoreTradeInPlace']]], {
        journalData: { trades },
        _ntCreatedTradeId: existing ? existing.id : null,
        _NT_DRAFT_KEY: 'nt-draft',
        _ntBuildTrade: id => ({ id: id || 555, symbol: 'ZZTEST', quantity: 3 }),
        document: fakeDocument({ symbol: el({ value: 'ZZTEST' }), quantity: el({ value: '3' }),
            'entry-price': el({ value: '1' }), 'entry-time': el({ value: '2026-10-24T10:00' }) }),
        Autosave: { showStatus: (id, s) => calls.status.push(s), clear: () => calls.cleared++, load: () => null },
        _isCloudPrimarySave: () => true,
        _saveTradeToSupabase: async t => { calls.saved.push(clone(t)); return saveResult; },
        saveToIndexedDB: async () => { calls.idb++; },
    });
    return { fns, g, before: clone(trades), calls };
}

test('new trade: failed first save removes the trade and keeps the form and draft', async () => {
    const h = ntHarness(FAIL);
    assert.equal(await h.fns._ntCommitTrade({ explicit: true }), false);
    assert.equal(h.calls.saved[0].id, 555);
    assert.deepEqual(h.g.journalData.trades, h.before);
    // The id is kept so the retry upserts the same trade.
    assert.equal(h.g._ntCreatedTradeId, 555);
    assert.equal(h.calls.idb, 0);
    assert.equal(h.calls.cleared, 0);
    assert.deepEqual(h.calls.status, ['saving', 'failed']);
});

test('new trade: failed update of the created trade restores it', async () => {
    const h = ntHarness(FAIL, { id: 555, symbol: 'ZZTEST', quantity: 1, notes: 'keep' });
    assert.equal(await h.fns._ntCommitTrade(), false);
    assert.deepEqual(h.g.journalData.trades, h.before);
    assert.equal(h.g._ntCreatedTradeId, 555);
    assert.equal(h.calls.idb, 0);
});

test('new trade: successful save keeps the trade and saves locally', async () => {
    const h = ntHarness(OK);
    assert.equal(await h.fns._ntCommitTrade(), true);
    assert.equal(h.g.journalData.trades.length, 2);
    assert.equal(h.calls.idb, 1);
});

// ── 3b. New Trade: one entry = one trade ────────────────────────────────────

// results: cloud results in call order (last one repeats). Each build gets a
// fresh Date.now()-style id unless the form already has one.
function ntQueueHarness(results, vals) {
    const trades = [{ id: 1, symbol: 'OLD' }];
    const calls = { status: [], saved: [], drafts: [], idb: 0 };
    let nextId = 1000, n = 0;
    const statusEl = el();
    const { fns, g } = sandbox([[SRC.app, ['_ntCommitTrade', '_ntQueueCommit', '_ntCanCreate', '_ntClearDraft', '_restoreTradeInPlace',
        '_ntTradeWasDeleted', '_ntTradesLoaded']]], Object.assign({
        window: { _denariiStorageMode: 'cloud_primary' }, _cloudBaselineReady: true, _cloudPaused: false,
        journalData: { trades },
        _ntCreatedTradeId: null, _ntCreatedSaved: false, _ntFormGen: 0,
        _ntCommitTail: Promise.resolve(), _ntCommitWaiting: null,
        _NT_DRAFT_KEY: 'nt-draft',
        _ntBuildTrade: id => ({ id: id || nextId++, symbol: 'AAAA', quantity: 3 }),
        _ntSaveDraft: () => calls.drafts.push(g._ntCreatedTradeId + ':' + g._ntCreatedSaved),
        document: fakeDocument({ symbol: el({ value: 'AAAA' }), quantity: el({ value: '3' }),
            'entry-price': el({ value: '1' }), 'entry-time': el({ value: '2026-11-08T10:00' }),
            'nt-autosave-status': statusEl }),
        Autosave: { showStatus: (id, s) => { calls.status.push(s); statusEl.textContent = s; }, clear() {}, load: () => null },
        _isCloudPrimarySave: () => true,
        _saveTradeToSupabase: async t => {
            calls.saved.push(t.id);
            await new Promise(r => setImmediate(r));
            return results[Math.min(n++, results.length - 1)];
        },
        saveToIndexedDB: async () => { calls.idb++; },
    }, vals || {}));
    return { fns, g, calls, statusEl, aaaa: () => g.journalData.trades.filter(t => t.symbol === 'AAAA') };
}

test('new trade: change + focusout + leaving at once create exactly one trade, all with one id', async () => {
    const h = ntQueueHarness([OK]);
    const all = await Promise.all([h.fns._ntQueueCommit(), h.fns._ntQueueCommit(), h.fns._ntQueueCommit()]);
    assert.ok(all.every(Boolean));
    assert.equal(h.aaaa().length, 1);
    assert.ok(h.calls.saved.length >= 1 && h.calls.saved.every(id => id === 1000));
    assert.equal(h.g._ntCreatedTradeId, 1000);
    assert.equal(h.g._ntCreatedSaved, true);
});

test('new trade: saves never overlap, and waiting background requests share one save', async () => {
    let running = 0, maxRunning = 0;
    const h = ntQueueHarness([OK]);
    const inner = h.g._saveTradeToSupabase;
    h.g._saveTradeToSupabase = async t => { running++; maxRunning = Math.max(maxRunning, running); const r = await inner(t); running--; return r; };
    const first = h.fns._ntQueueCommit();
    await new Promise(r => setImmediate(r));   // the first save is now running
    await Promise.all([first, h.fns._ntQueueCommit(), h.fns._ntQueueCommit(), h.fns._ntQueueCommit()]);
    assert.equal(maxRunning, 1);
    assert.equal(h.calls.saved.length, 2);   // the first, then one shared follow-up
    assert.equal(h.aaaa().length, 1);
});

test('new trade: a failed first save, then a retry, reuses the same id (one trade)', async () => {
    const h = ntQueueHarness([FAIL, OK]);
    assert.equal(await h.fns._ntQueueCommit(), false);
    assert.equal(h.aaaa().length, 0);
    assert.equal(h.g._ntCreatedTradeId, 1000);
    assert.equal(h.g._ntCreatedSaved, false);
    assert.equal(await h.fns._ntQueueCommit(), true);
    assert.deepEqual(h.calls.saved, [1000, 1000]);
    assert.equal(h.aaaa().length, 1);
});

test('new trade: a failed create overlapping a later save never produces a second id', async () => {
    const h = ntQueueHarness([FAIL, OK]);
    const [a, b] = await Promise.all([h.fns._ntQueueCommit(), h.fns._ntQueueCommit({ explicit: true })]);
    assert.equal(a, false);
    assert.equal(b, true);
    assert.deepEqual(h.calls.saved, [1000, 1000]);
    assert.equal(h.aaaa().length, 1);
});

test('new trade: the id reaches the draft before the first save; the saved flag after it', async () => {
    const h = ntQueueHarness([OK]);
    await h.fns._ntQueueCommit();
    assert.deepEqual(h.calls.drafts, ['1000:false', '1000:true']);
});

test('new trade: a trade saved earlier and now missing (deleted elsewhere) is not recreated', async () => {
    const h = ntQueueHarness([OK], { _ntCreatedTradeId: 777, _ntCreatedSaved: true });
    assert.equal(await h.fns._ntQueueCommit(), false);
    assert.equal(await h.fns._ntQueueCommit({ explicit: true }), false);
    assert.deepEqual(h.calls.saved, []);
    assert.equal(h.aaaa().length, 0);
    assert.deepEqual(h.calls.status, ['failed', 'failed']);
    assert.equal(h.statusEl.textContent, 'This trade was deleted');
});

test('new trade: before the trades finish loading a missing trade is a plain failed save, never recreated', async () => {
    for (const flags of [{ _cloudBaselineReady: false, _cloudPaused: false }, { _cloudBaselineReady: false, _cloudPaused: true }]) {
        const h = ntQueueHarness([OK], Object.assign({ _ntCreatedTradeId: 777, _ntCreatedSaved: true }, flags));
        assert.equal(h.fns._ntTradeWasDeleted(), false);
        assert.equal(await h.fns._ntQueueCommit(), false);
        assert.deepEqual(h.calls.saved, []);
        assert.equal(h.aaaa().length, 0);
        assert.equal(h.statusEl.textContent, 'failed');   // the generic label, not "deleted"
        // Once loaded (trade back in the list): the normal update of that id.
        h.g._cloudBaselineReady = true; h.g._cloudPaused = false;
        h.g.journalData.trades.push({ id: 777, symbol: 'AAAA' });
        assert.equal(await h.fns._ntQueueCommit(), true);
        assert.deepEqual(h.calls.saved, [777]);
        assert.equal(h.aaaa().length, 1);
    }
});

test('new trade: after a reload with string ids loaded, it finds and updates its own trade (stored id kept)', async () => {
    // Draft id is a number; the cloud-loaded trade has the same id as a string.
    const h = ntQueueHarness([OK], { _ntCreatedTradeId: 1794179806208, _ntCreatedSaved: true });
    h.g.journalData.trades.push({ id: '1794179806208', symbol: 'AAAA', notes: 'keep' });
    assert.equal(h.fns._ntTradeWasDeleted(), false);
    assert.equal(await h.fns._ntQueueCommit(), true);
    assert.equal(await h.fns._ntQueueCommit(), true);
    assert.deepEqual(h.calls.saved, ['1794179806208', '1794179806208']);   // upserted under the stored id
    assert.equal(h.aaaa().length, 1);                                      // no duplicate
    assert.equal(h.aaaa()[0].id, '1794179806208');                         // id type unchanged
    assert.equal(h.g._ntCreatedTradeId, '1794179806208');
    assert.ok(!h.calls.status.includes('failed'));
    assert.notEqual(h.statusEl.textContent, 'This trade was deleted');
});

test('new trade: a mid-session re-sync to string ids keeps updating the same trade', async () => {
    const h = ntQueueHarness([OK]);
    assert.equal(await h.fns._ntQueueCommit(), true);                      // created as number 1000
    h.g.journalData.trades = h.g.journalData.trades.map(t => Object.assign({}, t, { id: String(t.id) }));
    assert.equal(h.fns._ntTradeWasDeleted(), false);
    assert.equal(await h.fns._ntQueueCommit(), true);
    assert.deepEqual(h.calls.saved, [1000, '1000']);
    assert.equal(h.aaaa().length, 1);
    assert.equal(h.aaaa()[0].id, '1000');
});

test('new trade: with string ids loaded, a truly deleted trade is still reported as deleted', async () => {
    const h = ntQueueHarness([OK], { _ntCreatedTradeId: 1794179806208, _ntCreatedSaved: true });
    h.g.journalData.trades.push({ id: '1794179806999', symbol: 'OTHER' });
    assert.equal(h.fns._ntTradeWasDeleted(), true);
    assert.equal(await h.fns._ntQueueCommit(), false);
    assert.deepEqual(h.calls.saved, []);
    assert.equal(h.aaaa().length, 0);
    assert.equal(h.statusEl.textContent, 'This trade was deleted');
});

test('leave New Trade: after a reload with string ids, its own trade is not called deleted', async () => {
    const h = leaveHarness({ _ntCreatedTradeId: 1794179806208, _ntCreatedSaved: true,
        journalData: { trades: [{ id: '1794179806208', symbol: 'AAAA' }] } });
    h.els.symbol.value = 'AAAA';
    assert.equal(h.fns._ntBeforeLeave('dashboard'), false);
    await tick();
    assert.equal(h.calls.flush, 1);                                        // the normal save, no deleted dialog
    assert.deepEqual(h.calls.to, ['dashboard']);
    assert.equal(h.calls.confirm, null);
});

test('new trade: outside cloud_primary the trades count as loaded', () => {
    const h = ntQueueHarness([OK], { window: { _denariiStorageMode: 'local_legacy' }, _cloudBaselineReady: false,
        _ntCreatedTradeId: 777, _ntCreatedSaved: true });
    assert.equal(h.fns._ntTradesLoaded(), true);
    assert.equal(h.fns._ntTradeWasDeleted(), true);
});

test('new trade: old drafts (no saved flag) update their trade, or stop if it was deleted; one trade at most', async () => {
    // Restored as saved (see the draft test below): trade present → updated in place.
    const present = ntQueueHarness([OK], { _ntCreatedTradeId: 777, _ntCreatedSaved: true });
    present.g.journalData.trades.push({ id: 777, symbol: 'AAAA' });
    assert.equal(await present.fns._ntQueueCommit(), true);
    assert.equal(await present.fns._ntQueueCommit(), true);
    assert.deepEqual(present.calls.saved, [777, 777]);
    assert.equal(present.aaaa().length, 1);
    // Trade deleted: never recreated.
    const gone = ntQueueHarness([OK], { _ntCreatedTradeId: 777, _ntCreatedSaved: true });
    assert.equal(await gone.fns._ntQueueCommit(), false);
    assert.equal(gone.aaaa().length, 0);
    // No trade id in the draft: several saves make exactly one trade.
    const none = ntQueueHarness([OK]);
    for (let i = 0; i < 3; i++) assert.equal(await none.fns._ntQueueCommit(), true);
    assert.equal(none.aaaa().length, 1);
    assert.ok(none.calls.saved.every(id => id === 1000));
});

test('new trade: a save finishing after the form was cleared does not mark the new form as saved', async () => {
    const h = ntQueueHarness([OK]);
    const p = h.fns._ntQueueCommit();
    await new Promise(r => setImmediate(r));
    h.g._ntFormGen++; h.g._ntCreatedTradeId = null; h.g._ntCreatedSaved = false;   // _ntResetForm
    assert.equal(await p, true);
    assert.equal(h.g._ntCreatedSaved, false);
    assert.equal(h.g._ntCreatedTradeId, null);
});

test('new trade draft: written with the id and saved flag; restored before trades load', () => {
    let saved = null;
    const draftH = sandbox([[SRC.app, ['_ntSaveDraft']]], {
        document: fakeDocument({}), _ntCreatedTradeId: 1000, _ntCreatedSaved: true, _ntFillsEnabled: false,
        Autosave: { save: (k, v) => { saved = v; } },
    });
    draftH.fns._ntSaveDraft();
    assert.equal(saved.createdTradeId, 1000);
    assert.equal(saved.createdTradeSaved, true);

    const restore = draft => {
        const r = sandbox([[SRC.app, ['_ntApplyDraft']]], {
            document: fakeDocument({}), journalData: { trades: [], brokerAccounts: [] },
            _ntCreatedTradeId: null, _ntCreatedSaved: false, _ntFormDirty: false, _ntFormGen: 0,
        });
        r.fns._ntApplyDraft(draft);
        return r.g;
    };
    // Trades not loaded yet: the id is still continued, never dropped.
    const fresh = restore({ core: {}, createdTradeId: 1000, createdTradeSaved: false });
    assert.equal(fresh._ntCreatedTradeId, 1000);
    assert.equal(fresh._ntCreatedSaved, false);
    assert.equal(fresh._ntFormDirty, true);
    // Older drafts (no flag) count as saved, so they are never recreated.
    assert.equal(restore({ core: {}, createdTradeId: 1000 })._ntCreatedSaved, true);
});

// Leaving New Trade.
function leaveHarness(vals) {
    const calls = { reset: 0, to: [], confirm: null, flush: 0, bubble: null, fillError: null };
    const group = { querySelector: () => ({ textContent: 'Symbol' }) };
    const els = { symbol: el({ value: '', closest: () => group }), quantity: el({ value: '3' }),
        'entry-price': el({ value: '1' }), 'entry-time': el({ value: '2026-11-08T10:00' }) };
    const { fns, g } = sandbox([[SRC.app, ['_ntBeforeLeave', '_ntFirstMissingField', '_ntAskFailedLeave', '_ntAskDeletedLeave',
        '_ntTradeWasDeleted', '_ntTradesLoaded']]], Object.assign({
        document: fakeDocument(els),
        window: { _denariiStorageMode: 'cloud_primary' }, _cloudBaselineReady: true, _cloudPaused: false,
        journalData: { trades: [{ id: 5, symbol: 'AAAA' }] },
        _ntFormDirty: true, _ntFillsEnabled: false, _ntCreatedTradeId: null, _ntCreatedSaved: false,
        _ntLeaveTarget: null, _ntLeaveAnyway: false, _NT_LEAVE_TIMEOUT_MS: 10000,
        _ntFindIncompleteFillRow: () => null, _ntSerializeFillRows: () => [],
        _ntFlushCommit: async () => { calls.flush++; return true; },
        _ntResetForm: () => { calls.reset++; g._ntFormDirty = false; },
        // The real activateSection runs the leave guard first.
        activateSection: s => { if (fns._ntBeforeLeave(s)) calls.to.push(s); },
        _ntConfirmLeave: (text, label, go, stay) => { calls.confirm = { text, label, go, stay, discard: go }; },
        _ntShowFillError: b => { calls.fillError = b; },
        _showFieldBubble: (e, m) => { calls.bubble = m; },
    }, vals || {}));
    return { fns, g, calls, els };
}
const tick = () => new Promise(r => setImmediate(r));

test('leave New Trade: an untouched form leaves at once, with no save and no prompt', () => {
    const h = leaveHarness({ _ntFormDirty: false });
    assert.equal(h.fns._ntBeforeLeave('dashboard'), true);
    assert.equal(h.calls.flush, 0);
    assert.equal(h.calls.confirm, null);
});

test('leave New Trade: a complete (open) trade is saved, then the form clears and the page switches', async () => {
    const h = leaveHarness();
    h.els.symbol.value = 'AAAA';   // no exit fields: an open trade counts as complete
    assert.equal(h.fns._ntBeforeLeave('dashboard'), false);
    await tick();
    assert.equal(h.calls.flush, 1);
    assert.equal(h.calls.reset, 1);
    assert.deepEqual(h.calls.to, ['dashboard']);
});

test('leave New Trade: a failed save asks Stay / Leave; Stay retries later, Leave keeps the draft', async () => {
    const h = leaveHarness({ _ntFlushCommit: async () => false });
    h.els.symbol.value = 'AAAA';
    assert.equal(h.fns._ntBeforeLeave('dashboard'), false);
    await tick();
    assert.equal(h.calls.confirm.text, 'Save failed. Stay to retry, or Leave and keep your draft.');
    assert.equal(h.calls.confirm.label, 'Leave');
    // Stay: still on New Trade, input kept.
    h.calls.confirm.stay();
    assert.equal(h.calls.reset, 0);
    assert.deepEqual(h.calls.to, []);
    // A later leave retries the save, then offers Leave again.
    h.calls.confirm = null;
    h.fns._ntBeforeLeave('dashboard');
    await tick();
    assert.equal(h.calls.confirm.label, 'Leave');
    // Leave: the page switches, the form and draft are not cleared.
    h.calls.confirm.go();
    assert.deepEqual(h.calls.to, ['dashboard']);
    assert.equal(h.calls.reset, 0);
    assert.equal(h.g._ntFormDirty, true);
    // The bypass covered that one switch only.
    assert.equal(h.g._ntLeaveAnyway, false);
    assert.equal(h.fns._ntBeforeLeave('trade-journal'), false);
});

test('leave New Trade: a leave save still running after the timeout asks Stay / Leave; a late save keeps its id', async () => {
    let done;
    const h = leaveHarness({ _NT_LEAVE_TIMEOUT_MS: 5, _ntFlushCommit: () => new Promise(r => { done = r; }) });
    h.els.symbol.value = 'AAAA';
    h.fns._ntBeforeLeave('dashboard');
    await new Promise(r => setTimeout(r, 20));
    assert.equal(h.calls.confirm.text, 'Save failed. Stay to retry, or Leave and keep your draft.');
    assert.equal(h.g._ntLeaveTarget, null);   // not stuck: clicks lead somewhere again
    // The late result is ignored here: no clear, no switch, no second dialog.
    h.calls.confirm.stay();
    h.calls.confirm = null;
    done(true);
    await tick();
    assert.equal(h.calls.reset, 0);
    assert.deepEqual(h.calls.to, []);
    assert.equal(h.calls.confirm, null);
});

test('leave New Trade: a deleted trade asks to Discard the draft, without trying to save', async () => {
    for (const complete of [true, false]) {
        const h = leaveHarness({ _ntCreatedTradeId: 777, _ntCreatedSaved: true });
        if (complete) h.els.symbol.value = 'AAAA';
        assert.equal(h.fns._ntBeforeLeave('dashboard'), false);
        await tick();
        assert.equal(h.calls.flush, 0);
        assert.equal(h.calls.confirm.text, 'This trade was deleted. Discard this draft?');
        assert.equal(h.calls.confirm.label, 'Discard');
        h.calls.confirm.stay();
        assert.deepEqual(h.calls.to, []);
        h.calls.confirm.go();
        assert.equal(h.calls.reset, 1);
        assert.deepEqual(h.calls.to, ['dashboard']);
    }
});

test('leave New Trade: before the trades load, a missing saved trade is not called deleted', async () => {
    let flushes = 0;
    const h = leaveHarness({ _ntCreatedTradeId: 777, _ntCreatedSaved: true, _cloudBaselineReady: false,
        _ntFlushCommit: async () => { flushes++; return false; } });
    h.els.symbol.value = 'AAAA';
    h.fns._ntBeforeLeave('dashboard');
    await tick();
    assert.equal(flushes, 1);   // the normal save path ran
    assert.equal(h.calls.confirm.text, 'Save failed. Stay to retry, or Leave and keep your draft.');
});

test('leave New Trade: a second click while the leave save runs goes to the latest page', async () => {
    let done;
    const h = leaveHarness({ _ntFlushCommit: () => new Promise(r => { done = r; }) });
    h.els.symbol.value = 'AAAA';
    h.fns._ntBeforeLeave('dashboard');
    assert.equal(h.fns._ntBeforeLeave('trade-journal'), false);
    done(true);
    await tick();
    assert.equal(h.calls.reset, 1);
    assert.deepEqual(h.calls.to, ['trade-journal']);
});

test('leave New Trade: incomplete asks Stay / Discard naming the first missing field', () => {
    const h = leaveHarness();
    assert.equal(h.fns._ntBeforeLeave('dashboard'), false);
    assert.equal(h.calls.flush, 0);
    assert.equal(h.calls.confirm.text,
        'This trade isn’t complete. Missing: Symbol. Stay to finish it, or Discard to clear the form.');
    // Stay: nothing cleared or saved, back on the missing field.
    h.calls.confirm.stay();
    assert.equal(h.calls.reset, 0);
    assert.deepEqual(h.calls.to, []);
    assert.equal(h.calls.bubble, 'Symbol is required');
    // Discard: the form clears and the page switches, with no save.
    h.calls.confirm.discard();
    assert.equal(h.calls.reset, 1);
    assert.deepEqual(h.calls.to, ['dashboard']);
    assert.equal(h.calls.flush, 0);
});

test('leave New Trade: a half-filled fill row is incomplete; an earlier saved version is mentioned', () => {
    const bad = { row: 2, field: 'exit time', key: 'exit-time' };
    const h = leaveHarness({ _ntFillsEnabled: true, _ntCreatedTradeId: 5, _ntCreatedSaved: true, _ntFindIncompleteFillRow: () => bad });
    h.els.symbol.value = 'AAAA';
    h.fns._ntBeforeLeave('journal');   // clicking New Trade again counts as leaving
    assert.equal(h.calls.confirm.text,
        'This trade isn’t complete. Missing: Row #2 exit time. Stay to finish it, or Discard to clear the form.'
        + ' The version saved earlier will be kept.');
    h.calls.confirm.stay();
    assert.equal(h.calls.fillError, bad);
});

test('New Trade wiring: leave guard first in activateSection; saves go through the queue; reset clears the id', () => {
    const act = extractFunction(SRC.app, 'activateSection');
    assert.ok(/^function activateSection\(sectionId\) \{\s*\/\/[^\n]*\n(\s*\/\/[^\n]*\n)*\s*var _ntActive = document\.querySelector\('\.tab-content\.active'\);\s*if \(_ntActive && _ntActive\.id === 'journal' && typeof _ntBeforeLeave === 'function' && !_ntBeforeLeave\(sectionId\)\) return;/.test(act));
    assert.ok(!act.includes('_ntFlushCommit'));
    assert.ok(extractFunction(SRC.app, '_ntFlushCommit').includes('return _ntQueueCommit()'));
    assert.ok(extractFunction(SRC.app, '_ntScheduleCommit').includes('_ntQueueCommit()'));
    assert.ok(extractFunction(SRC.app, 'saveAndOpenJournal').includes('await _ntQueueCommit({ reportFillErrors: true })'));
    assert.ok(SRC.app.includes('const ok = await _ntQueueCommit({ explicit: true });'));
    const reset = extractFunction(SRC.app, '_ntResetForm');
    ['_ntCreatedTradeId = null;', '_ntCreatedSaved = false;', '_ntFormDirty = false;', '_ntClearDraft();']
        .forEach(s => assert.ok(reset.includes(s), s));
});

// ── 4. Journal edit ─────────────────────────────────────────────────────────

function jnlHarness(saveResult) {
    const trade = { id: 9, symbol: 'AAA', type: 'long', quantity: 10, entryPrice: 5, exitPrice: 6, notes: 'old', tradeGrade: 'B' };
    const calls = { status: [], cleared: [], idb: 0, saved: [] };
    const { fns, g } = sandbox([[SRC.journal, ['_jnlCommitTrade', '_jnlFlushCommit', 'closeJournalEditor', '_jnlIsWebull']],
        [SRC.app, ['_restoreTradeInPlace']]], {
        _jnlFillsDirty: false, _jnlSplitting: false,
        journalData: { trades: [trade] },
        window: { _jnlSelectedTradeId: 9, scrollTo() {} },
        _jnlCommitTimer: null,
        _JNL_STATUS_ID: 'jnl-autosave-status',
        _jnlGetNotes: () => 'new note',
        document: fakeDocument({ 'jnl-trade-grade': el({ value: 'A' }), 'jnl-symbol': el({ value: 'aaa' }) }),
        Autosave: { showStatus: (id, s) => calls.status.push(s) },
        _jnlClearDraft: id => calls.cleared.push(id),
        _isCloudPrimarySave: () => true,
        _saveTradeToSupabase: async t => { calls.saved.push(clone(t)); return saveResult; },
        saveToIndexedDB: async () => { calls.idb++; },
    });
    return { fns, g, trade, before: clone(trade), calls };
}

test('journal edit: cloud failure restores the trade, skips the local save, keeps the draft', async () => {
    const h = jnlHarness(FAIL);
    assert.equal(await h.fns._jnlCommitTrade({ explicit: true }), false);
    assert.equal(h.calls.saved[0].notes, 'new note');
    assert.deepEqual(h.trade, h.before);
    assert.equal(h.calls.idb, 0);
    assert.deepEqual(h.calls.status, ['saving', 'failed']);
    assert.deepEqual(h.calls.cleared, []);
});

test('journal edit: Back to Trades after a failed save keeps the draft; a good save clears it', async () => {
    const bad = jnlHarness(FAIL);
    bad.fns.closeJournalEditor();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(bad.calls.cleared, []);
    assert.deepEqual(bad.trade, bad.before);
    const good = jnlHarness(OK);
    good.fns.closeJournalEditor();
    await new Promise(r => setImmediate(r));
    assert.deepEqual(good.calls.cleared, [9]);
    assert.equal(good.trade.notes, 'new note');
});

// ── 5. Split ────────────────────────────────────────────────────────────────
// Batch C2: the old Edit Trade split was removed. Split now runs only on
// Trade Reflection (jnlSplitMarkedFills), tested in batch-c1.test.js.

// ── 6. CSV / broker import ──────────────────────────────────────────────────

function importHarness(mode, opts) {
    opts = opts || {};
    const existing = [{ id: 1, symbol: 'AAA' }, { id: 2, symbol: 'BBB' }];
    const incoming = { _tempId: 't1', symbol: 'NEW', quantity: 1 };
    const calls = { alerts: [], idb: 0, saved: [] };
    const { fns, g } = sandbox([[SRC.app, ['confirmBrokerImport']]], {
        journalData: { trades: existing.slice() },
        getBrokerImportMode: () => mode,
        document: fakeDocument({ 'broker-import-account-select': el({ value: 'ba_test' }) }),
        brokerImportState: {
            matchedTrades: [incoming], newTrades: [incoming], exactDuplicates: [],
            possibleDuplicates: opts.possible ? [{ incoming: { _tempId: 't2', symbol: 'AAA2' }, existing: existing[0] }] : [],
            duplicateDecisions: opts.possible ? { t2: 'replace-existing' } : {},
            splitDecisions: {}, unmatchedDecisions: {}, unmatchedActivity: [], importSummaries: [],
        },
        finalizeTradeSummary: t => t,
        alert: m => calls.alerts.push(m),
        _isCloudPrimarySave: () => opts.cloud !== false,
        _saveTradesToSupabase: async ts => { calls.saved.push(ts.length); return opts.save || OK; },
        saveToIndexedDB: async () => { calls.idb++; },
    });
    return { fns, g, before: clone(existing), calls };
}

test('import: Replace All is blocked in cloud_primary before anything changes', async () => {
    const h = importHarness('replace-all');
    await h.fns.confirmBrokerImport();
    assert.deepEqual(h.calls.alerts, ['Replace All Trades is not available for cloud accounts. Choose another import mode.']);
    assert.deepEqual(h.g.journalData.trades, h.before);
    assert.deepEqual(h.calls.saved, []);
    assert.equal(h.calls.idb, 0);
});

test('import: Replace All still runs in local modes', async () => {
    const h = importHarness('replace-all', { cloud: false });
    await h.fns.confirmBrokerImport();
    assert.deepEqual(h.g.journalData.trades.map(t => t.symbol), ['NEW']);
    assert.equal(h.calls.idb, 1);
    assert.ok(!h.calls.alerts.some(a => /Replace All/.test(a)));
});

test('import: failed cloud save restores local trades and skips the local save', async () => {
    for (const opts of [{ save: FAIL }, { save: FAIL, possible: true }]) {
        const h = importHarness(opts.possible ? 'smart-merge' : 'add-new', opts);
        await h.fns.confirmBrokerImport();
        assert.ok(h.calls.saved.length === 1);
        assert.deepEqual(h.g.journalData.trades, h.before);
        assert.equal(h.calls.idb, 0);
        assert.deepEqual(h.calls.alerts, ['Failed to save import: boom\nYour data was not changed. Please try again.']);
    }
});

test('import: successful add-new saves locally', async () => {
    const h = importHarness('add-new');
    await h.fns.confirmBrokerImport();
    assert.equal(h.g.journalData.trades.length, 3);
    assert.equal(h.calls.idb, 1);
});

// ── 7. Broker delete with reassign ──────────────────────────────────────────

function reassignHarness(cloud, saveResult) {
    const trades = [{ id: 1, brokerAccountId: 'ba_old' }, { id: 2, brokerAccountId: 'ba_keep' }];
    const accounts = [{ id: 'ba_old', displayName: 'Old' }, { id: 'ba_keep', displayName: 'Keep' }];
    const calls = { alerts: [], idb: 0, brokerDeleted: [] };
    const { fns, g } = sandbox([[SRC.broker, ['confirmBrokerDeleteReassign']]], {
        journalData: { trades, brokerAccounts: accounts },
        _pendingDeleteBrokerId: 'ba_old',
        document: fakeDocument({ 'broker-delete-reassign-select': el({ value: 'ba_keep' }) }),
        getBrokerAccount: id => accounts.find(a => a.id === id),
        getTradeCountForAccount: () => 1,
        confirm: () => true,
        alert: m => calls.alerts.push(m),
        _isCloudPrimarySave: () => cloud,
        _saveTradesToSupabase: async () => saveResult,
        _deleteBrokerAccountFromSupabase: async id => { calls.brokerDeleted.push(id); return OK; },
        saveToIndexedDB: async () => { calls.idb++; },
        window: {},
    });
    return { fns, g, before: clone({ trades, brokerAccounts: accounts }), calls };
}

test('broker reassign: cloud failure puts trades back and keeps the broker', async () => {
    const h = reassignHarness(true, FAIL);
    await h.fns.confirmBrokerDeleteReassign();
    assert.deepEqual(clone(h.g.journalData), h.before);
    assert.deepEqual(h.calls.brokerDeleted, []);
    assert.equal(h.calls.idb, 0);
    assert.equal(h.g._pendingDeleteBrokerId, 'ba_old');
    assert.deepEqual(h.calls.alerts, ['Failed to reassign trades: boom\nYour data was not changed. Please try again.']);
});

test('broker reassign: local modes carry on as before when the cloud is not available', async () => {
    const h = reassignHarness(false, { success: false, error: 'Cloud save not available' });
    await h.fns.confirmBrokerDeleteReassign();
    assert.deepEqual(h.g.journalData.trades.map(t => t.brokerAccountId), ['ba_keep', 'ba_keep']);
    assert.deepEqual(h.g.journalData.brokerAccounts.map(a => a.id), ['ba_keep']);
    assert.equal(h.calls.idb, 1);
    assert.deepEqual(h.calls.alerts, []);
});

// ── 8. Restore Demo ─────────────────────────────────────────────────────────

function demoHarness(cloud, saveResult, bundle) {
    const jd = {
        brokerAccounts: [{ id: 'ba_demo_pelosi' }, { id: 'ba_wb' }],
        trades: [{ id: 1, brokerAccountId: 'ba_demo_pelosi', notes: 'edited' }, { id: 50, brokerAccountId: 'ba_wb' }],
        reviews: { 'd:1': { _isDemo: true } }, tags: [], _demoBrokerVersion: 6,
    };
    const calls = { alerts: [], persisted: 0, saved: [] };
    const { fns, g } = sandbox([[SRC.demo, ['restoreDemoBroker', '_importFromDemoBundle', '_removeDemoBrokerData']]], {
        journalData: jd,
        DEMO_BROKER_ID: 'ba_demo_pelosi',
        DEMO_BUNDLE: bundle === undefined ? {
            version: 6, broker: { id: 'ba_demo_pelosi' },
            trades: [{ id: 1, brokerAccountId: 'ba_demo_pelosi', notes: '' }, { id: 2, brokerAccountId: 'ba_demo_pelosi', notes: '' }],
            tags: [], tagCategories: [], reviews: {}, dailyPlanners: {}, weeklyPlanners: {},
        } : bundle,
        seedDemoBroker: () => false,
        alert: m => calls.alerts.push(m),
        _isCloudPrimarySave: () => cloud,
        _saveTradesToSupabase: async ts => { calls.saved.push(clone(ts)); return saveResult; },
        _persistAndRefreshUI: async () => { calls.persisted++; },
    });
    return { fns, g, jd, before: clone(jd), calls };
}

test('restore demo: cloud failure leaves local data unchanged', async () => {
    const h = demoHarness(true, FAIL);
    await h.fns.restoreDemoBroker();
    assert.deepEqual(h.calls.saved.map(ts => ts.map(t => t.id)), [[1, 2]]);
    assert.deepEqual(clone(h.g.journalData), h.before);
    assert.equal(h.calls.persisted, 0);
    assert.deepEqual(h.calls.alerts, ['Failed to restore demo: boom\nYour data was not changed. Please try again.']);
});

test('restore demo: blocked in cloud_primary when the bundle is missing', async () => {
    const h = demoHarness(true, OK, null);
    await h.fns.restoreDemoBroker();
    assert.deepEqual(h.calls.saved, []);
    assert.deepEqual(clone(h.g.journalData), h.before);
    assert.match(h.calls.alerts[0], /^Failed to restore demo: demo data is not loaded/);
});

test('restore demo: cloud success saves first, then restores locally', async () => {
    const h = demoHarness(true, OK);
    await h.fns.restoreDemoBroker();
    assert.equal(h.calls.saved.length, 1);
    assert.deepEqual(h.g.journalData.trades.map(t => t.id).sort(), [1, 2, 50]);
    assert.equal(h.calls.persisted, 1);
});

test('restore demo: local modes skip the cloud save', async () => {
    const h = demoHarness(false, FAIL);
    await h.fns.restoreDemoBroker();
    assert.deepEqual(h.calls.saved, []);
    assert.equal(h.calls.persisted, 1);
});

// ── 9. Batch B: rounding on every save path ────────────────────────────────

const WebullSync = require('../js/services/webull-sync.js');
// (10.20 - 10.10) * 3 in floating point
const FLOAT_PNL = (10.2 - 10.1) * 3;

test('rounding helper: money to cents, prices to 4 dp, null kept, never more than half a unit', () => {
    const { fns } = sandbox([[SRC.app, ['_roundTradeForSave']]], { WebullSync });
    assert.notEqual(FLOAT_PNL, 0.3);
    const t = { pnl: FLOAT_PNL, grossPnl: -241.04000000000002, commissionFees: 0.1 + 0.2, entryPrice: 10.123456, exitPrice: null,
        fills: [{ pnl: -161.99999999999818, entryPrice: 1.000049 }] };
    const fills = t.fills;
    assert.strictEqual(fns._roundTradeForSave(t), t);            // same object, rounded in place
    assert.deepEqual([t.pnl, t.grossPnl, t.commissionFees, t.entryPrice, t.exitPrice], [0.3, -241.04, 0.3, 10.1235, null]);
    assert.deepEqual([t.fills[0].pnl, t.fills[0].entryPrice], [-162, 1]);
    assert.notStrictEqual(t.fills, fills);
    const open = { pnl: null, grossPnl: null, exitPrice: null, entryPrice: 5 };
    fns._roundTradeForSave(open);
    assert.deepEqual(open, { pnl: null, grossPnl: null, exitPrice: null, entryPrice: 5 });
    let seed = 7;
    const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    for (let i = 0; i < 5000; i++) {
        const money = (rnd() - 0.5) * 2e6, price = rnd() * 5000;
        const r = fns._roundTradeForSave({ pnl: money, entryPrice: price });
        assert.ok(Math.abs(r.pnl - money) <= 0.005 + 1e-9, 'pnl ' + money);
        assert.ok(Math.abs(r.entryPrice - price) <= 0.00005 + 1e-9, 'price ' + price);
    }
});

test('rounding helper: Webull rounding unchanged (same roundTrade, rounding twice is a no-op)', () => {
    const { fns } = sandbox([[SRC.app, ['_roundTradeForSave']]], { WebullSync });
    const wb = { source: 'webull', pnl: -24.755, grossPnl: -24.7549, commissionFees: 0.005, entryPrice: 231.12345, exitPrice: 230.9,
        webullPartials: [{ pnl: 1.005, exitPrice: 1.23456, source: { entryCommissionFees: 0.0049 } }] };
    const once = WebullSync.roundTrade(wb);
    assert.deepEqual(fns._roundTradeForSave(clone(wb)), once);
    assert.deepEqual(WebullSync.roundTrade(once), once);
    assert.deepEqual(fns._roundTradeForSave(clone(once)), once);
});

test('rounding helper: saves unrounded when WebullSync is not loaded', () => {
    const { fns } = sandbox([[SRC.app, ['_roundTradeForSave']]], { WebullSync: undefined });
    assert.equal(fns._roundTradeForSave({ pnl: FLOAT_PNL }).pnl, FLOAT_PNL);
});

function ntBuildHarness(exitPrice) {
    const els = {
        symbol: el({ value: 'zztestb1' }), quantity: el({ value: '3' }), 'trade-type': el({ value: 'long' }),
        'entry-price': el({ value: '10.10' }), 'exit-price': el({ value: exitPrice }), 'commission-fees': el({ value: '0' }),
        'entry-time': el({ value: '2026-10-27T10:00' }), 'exit-time': el({ value: '2026-10-27T11:00' }), 'asset-type': el({ value: 'stock' }),
    };
    return sandbox([[SRC.app, ['_ntBuildTrade', '_roundTradeForSave', '_contractMultiplier']]], {
        WebullSync, document: fakeDocument(els), _getRowData: () => [], _computeTradeMetrics: () => ({}),
        selectedStrategyForTrade: null, _ntFillsEnabled: false, _ntGetTagsFromRows: () => [], _ntGetNotes: () => '',
        finalizeTradeSummary: t => t,
    }).fns;
}

test('new trade: stores rounded P&L', () => {
    const t = ntBuildHarness('10.20')._ntBuildTrade(null);
    assert.equal(t.pnl, 0.3);
    assert.equal(t.grossPnl, 0.3);
    assert.equal(t.entryPrice, 10.1);
});

test('new trade: an open trade keeps pnl, grossPnl and exit price null', () => {
    const t = ntBuildHarness('')._ntBuildTrade(null);
    assert.equal(t.pnl, null);
    assert.equal(t.grossPnl, null);
    assert.equal(t.exitPrice, null);
    assert.equal(t.exitTime, null);
});

function jnlRoundHarness(trade, els) {
    const calls = { saved: [] };
    const { fns } = sandbox([[SRC.journal, ['_jnlCommitTrade', '_jnlIsWebull']],
        [SRC.app, ['_restoreTradeInPlace', '_roundTradeForSave', '_contractMultiplier']]], {
        _jnlFillsDirty: false, _jnlSplitting: false,
        WebullSync,
        journalData: { trades: [trade] },
        window: { _jnlSelectedTradeId: trade.id, scrollTo() {} },
        _JNL_STATUS_ID: 'jnl-autosave-status', _JNL_PNL_IDS: [], _jnlChanged: () => false,
        _jnlGetNotes: () => '', _jnlGetTagsFromRows: () => [], _getRowData: () => [], _computeTradeMetrics: () => ({}),
        _jnlSelectedStrategy: null,
        document: fakeDocument(Object.assign({ 'jnl-trade-type': el({ value: 'long' }), 'jnl-asset-type': el({ value: 'stock' }),
            'jnl-symbol': el({ value: trade.symbol }) }, els)),
        Autosave: { showStatus() {} },
        _isCloudPrimarySave: () => true,
        _saveTradeToSupabase: async t => { calls.saved.push(clone(t)); return OK; },
        saveToIndexedDB: async () => {},
    });
    return { fns, trade, calls };
}

test('reflection: re-saving a trade with float noise stores it rounded', async () => {
    const h = jnlRoundHarness({ id: 11, symbol: 'XOM', type: 'long', quantity: 1, entryPrice: 100, exitPrice: 98.38,
        entryTime: '2026-10-01T14:00:00.000Z', exitTime: '2026-10-01T15:00:00.000Z', pnl: -161.99999999999818, commissionFees: 0 });
    assert.equal(await h.fns._jnlCommitTrade(), true);
    assert.equal(h.calls.saved[0].pnl, -162);
    assert.equal(h.trade.pnl, -162);
});

test('reflection: closing an open trade stores rounded P&L; staying open keeps pnl null', async () => {
    const open = () => ({ id: 12, symbol: 'ZZTESTB2', type: 'long', quantity: 3, entryPrice: 10.1, exitPrice: null,
        entryTime: '2026-10-27T14:00:00.000Z', exitTime: null, pnl: null, grossPnl: null, commissionFees: 0 });
    const closing = jnlRoundHarness(open(), { 'jnl-exit-price': el({ value: '10.20' }), 'jnl-exit-time': el({ value: '2026-10-27T11:00' }) });
    assert.equal(await closing.fns._jnlCommitTrade(), true);
    assert.equal(closing.calls.saved[0].pnl, 0.3);
    assert.equal(closing.calls.saved[0].grossPnl, 0.3);
    const still = jnlRoundHarness(open(), {});
    assert.equal(await still.fns._jnlCommitTrade(), true);
    assert.equal(still.calls.saved[0].pnl, null);
    assert.equal(still.calls.saved[0].exitPrice, null);
});

function importRoundHarness(mode, opts) {
    opts = opts || {};
    const existing = [{ id: 1, symbol: 'AAA', pnl: 5 }, { id: 2, symbol: 'BBB', pnl: 6 }];
    const fill = (m, p) => ({ quantity: 3, entryPrice: 10.1, exitPrice: 10.2, entryTime: '2026-10-01T14:0' + m + ':00Z',
        exitTime: '2026-10-01T15:0' + m + ':00Z', pnl: p, commissionFees: 0.1 + 0.2 });
    const keep = { _tempId: 't1', symbol: 'KEEP', quantity: 3, entryPrice: 10.123456, exitPrice: 10.2, pnl: FLOAT_PNL, commissionFees: 0 };
    const grouped = { _tempId: 't3', symbol: 'SPLT', type: 'long', fills: [fill(1, FLOAT_PNL), fill(2, FLOAT_PNL)] };
    const calls = { alerts: [], idb: 0, saved: [], deleted: [] };
    const { fns, g } = sandbox([[SRC.app, ['confirmBrokerImport', '_roundTradeForSave']]], {
        WebullSync,
        journalData: { trades: existing.slice() },
        getBrokerImportMode: () => mode,
        document: fakeDocument({ 'broker-import-account-select': el({ value: 'ba_test' }) }),
        brokerImportState: {
            matchedTrades: [], newTrades: opts.replaceOnly ? [] : [keep, grouped], exactDuplicates: [],
            possibleDuplicates: opts.replace ? [{ incoming: { _tempId: 't2', symbol: 'AAA2', pnl: 1 }, existing: existing[0] }] : [],
            duplicateDecisions: opts.replace ? { t2: 'replace-existing' } : {},
            splitDecisions: { t3: 'split' },
            unmatchedDecisions: { u1: 'import_open_trade' },
            unmatchedActivity: opts.replaceOnly ? [] : [{ type: 'unmatched_open', _umaId: 'u1', symbol: 'opn', quantity: 2, price: 1.2345678, timestamp: '2026-10-01T14:00:00Z' }],
            importSummaries: [],
        },
        finalizeTradeSummary: t => t,
        normalizeTimestamp: ts => new Date(ts),
        _tradeFingerprint: t => JSON.stringify(t),
        alert: m => calls.alerts.push(m),
        _isCloudPrimarySave: () => opts.cloud !== false,
        _saveTradesToSupabase: async ts => { calls.saved.push(clone(ts)); return OK; },
        _deleteTradesFromSupabase: async ids => { calls.deleted.push(ids); return (opts.del && opts.del(ids)) || OK; },
        saveToIndexedDB: async () => { calls.idb++; },
    });
    return { fns, g, before: clone(existing), calls };
}

test('import: grouped, split and open trades are saved rounded; open trades keep pnl null', async () => {
    const h = importRoundHarness('add-new');
    await h.fns.confirmBrokerImport();
    const saved = h.calls.saved[0];
    const bySym = s => saved.filter(t => t.symbol === s);
    assert.equal(bySym('KEEP')[0].pnl, 0.3);
    assert.equal(bySym('KEEP')[0].entryPrice, 10.1235);
    assert.equal(bySym('SPLT').length, 2);
    bySym('SPLT').forEach(t => { assert.equal(t.pnl, 0.3); assert.equal(t.commissionFees, 0.3); });
    assert.equal(bySym('OPN')[0].pnl, null);
    assert.equal(bySym('OPN')[0].grossPnl, null);
    assert.equal(bySym('OPN')[0].entryPrice, 1.2346);
    assert.deepEqual(h.calls.deleted, []);
});

// ── 10. Batch B: deletes keep the trade when the cloud delete fails ────────

const DEL_FAIL_MSG = 'Failed to delete: boom\nYour data was not changed. Please try again.';

test('import smart-merge replace: the replaced trade is deleted in the cloud', async () => {
    const h = importRoundHarness('smart-merge', { replace: true, replaceOnly: true });
    await h.fns.confirmBrokerImport();
    assert.deepEqual(h.calls.deleted, [[1]]);
    assert.deepEqual(h.g.journalData.trades.map(t => t.symbol).sort(), ['AAA2', 'BBB']);
    assert.equal(h.calls.idb, 1);
    assert.deepEqual(h.calls.alerts, []);
});

test('import smart-merge replace: failed delete removes the new rows, changes nothing, alerts', async () => {
    const h = importRoundHarness('smart-merge', { replace: true, replaceOnly: true, del: ids => (ids[0] === 1 ? FAIL : OK) });
    await h.fns.confirmBrokerImport();
    const newIds = h.calls.saved[0].map(t => t.id);
    assert.deepEqual(h.calls.deleted, [[1], newIds]);
    assert.deepEqual(h.g.journalData.trades, h.before);
    assert.equal(h.calls.idb, 0);
    assert.deepEqual(h.calls.alerts, [DEL_FAIL_MSG]);
});

function rowDeleteHarness(fnName, delResult, cloud) {
    const trades = [{ id: 1, symbol: 'ZZTESTB1', pnl: 0.3 }, { id: 2, symbol: 'KEEP', pnl: null }];
    const calls = { alerts: [], idb: 0, dash: 0 };
    const { fns, g } = sandbox([[SRC.app, [fnName]]], {
        journalData: { trades: trades.slice() },
        _displaySymbol: s => s,
        confirm: () => true,
        alert: m => calls.alerts.push(m),
        _isCloudPrimarySave: () => cloud !== false,
        _deleteTradeFromSupabase: async () => delResult,
        saveToIndexedDB: async () => { calls.idb++; },
        updateDashboard: () => { calls.dash++; },
        _triggerCloudDashRefresh: () => {},
    });
    return { fns, g, before: clone(trades), calls };
}

// Batch C2: the old Edit Trade Delete button (etpDeleteTrade) was removed;
// the Dashboard ⋮ Delete (deleteTrade) is the one delete for a single trade.
for (const fnName of ['deleteTrade']) {
    test(fnName + ': failed cloud delete keeps the trade, saves nothing, alerts', async () => {
        const h = rowDeleteHarness(fnName, FAIL);
        await h.fns.deleteTrade(1);
        assert.deepEqual(h.g.journalData.trades, h.before);
        assert.equal(h.calls.idb, 0);
        assert.equal(h.calls.dash, 0);
        assert.deepEqual(h.calls.alerts, [DEL_FAIL_MSG]);
    });

    test(fnName + ': success, and local modes, delete as before', async () => {
        for (const [res, cloud] of [[OK, true], [{ success: false, error: 'Cloud save not available' }, false]]) {
            const h = rowDeleteHarness(fnName, res, cloud);
            await h.fns.deleteTrade(1);
            assert.deepEqual(h.g.journalData.trades.map(t => t.id), [2]);
            assert.equal(h.calls.idb, 1);
            assert.deepEqual(h.calls.alerts, []);
        }
    });
}

// Cloud-loaded trades have string ids; the ⋮ menu passes the id unquoted, as a number.
function stringIdDeleteHarness(confirmed) {
    const trades = [{ id: '1794179806208', symbol: 'ZZTESTB1', pnl: 0.3 }, { id: '1794179806209', symbol: 'KEEP', pnl: null }];
    const calls = { confirms: 0, deleted: [], idb: 0 };
    const { fns, g } = sandbox([[SRC.app, ['deleteTrade']]], {
        journalData: { trades: trades.slice() },
        _displaySymbol: s => s,
        confirm: () => { calls.confirms++; return confirmed; },
        alert: () => {},
        _isCloudPrimarySave: () => true,
        _deleteTradeFromSupabase: async id => { calls.deleted.push(id); return OK; },
        saveToIndexedDB: async () => { calls.idb++; },
        updateDashboard: () => {},
        _triggerCloudDashRefresh: () => {},
    });
    return { fns, g, before: clone(trades), calls };
}

test('deleteTrade: a numeric id finds a string-id trade, asks first, then removes only that trade', async () => {
    const h = stringIdDeleteHarness(true);
    await h.fns.deleteTrade(1794179806208);
    assert.equal(h.calls.confirms, 1);
    assert.deepEqual(h.calls.deleted, ['1794179806208']);   // the stored id, not the number
    assert.deepEqual(h.g.journalData.trades.map(t => t.id), ['1794179806209']);
    assert.equal(h.calls.idb, 1);
});

test('deleteTrade: declining the confirm deletes nothing', async () => {
    const h = stringIdDeleteHarness(false);
    await h.fns.deleteTrade(1794179806208);
    assert.equal(h.calls.confirms, 1);
    assert.deepEqual(h.calls.deleted, []);
    assert.deepEqual(h.g.journalData.trades, h.before);
    assert.equal(h.calls.idb, 0);
});

test('deleteTrade: a string id still finds a numeric-id trade; an unknown id does nothing', async () => {
    const h = rowDeleteHarness('deleteTrade', OK);
    await h.fns.deleteTrade('1');
    assert.deepEqual(h.g.journalData.trades.map(t => t.id), [2]);
    const none = stringIdDeleteHarness(true);
    await none.fns.deleteTrade(42);
    assert.equal(none.calls.confirms, 0);
    assert.deepEqual(none.g.journalData.trades, none.before);
});

test('openChartForTrade: finds the trade whether the id is a number or a string', () => {
    for (const [stored, passed] of [['1794179806208', 1794179806208], [1794179806208, '1794179806208'], [5, 5]]) {
        const opened = [];
        const trade = { id: stored, symbol: 'ZZTEST', entryTime: 'a', exitTime: 'b', entryPrice: 1, exitPrice: 2 };
        const { fns, g } = sandbox([[SRC.chart, ['openChartForTrade']]], {
            journalData: { trades: [{ id: 'other', symbol: 'NO' }, trade] },
            currentChartTrade: null, currentChartSymbolOnly: 'x',
            openStockChart: (...a) => opened.push(a),
            getSelectedChartTimeframe: () => '5m',
        });
        fns.openChartForTrade(passed);
        assert.equal(g.currentChartTrade, trade);
        assert.equal(g.currentChartSymbolOnly, null);
        // The trade itself is passed last, for its per-fill markers.
        assert.deepEqual(opened, [['ZZTEST', 'a', 'b', 1, 2, '5m', trade]]);
    }
});

function bulkDeleteHarness(delResult) {
    const trades = [{ id: 1, symbol: 'ZZTESTB1' }, { id: 2, symbol: 'ZZTESTB2' }, { id: 3, symbol: 'KEEP' }];
    const calls = { alerts: [], idb: 0 };
    const sel = new Set([1, 2]);
    const { fns, g } = sandbox([[SRC.app, ['dashDeleteSelected']]], {
        journalData: { trades: trades.slice() },
        _dashSelectedIds: sel, _dashMergePickerActive: false, _dashMergePrimaryId: null,
        _dashPruneToVisible: () => [1, 2], _dashDeleteConfirmText: () => 'Delete 2 trades?',
        confirm: () => true, alert: m => calls.alerts.push(m),
        _isCloudPrimarySave: () => true,
        _deleteTradesFromSupabase: async () => delResult,
        saveToIndexedDB: async () => { calls.idb++; },
        updateDashboard: () => {}, _triggerCloudDashRefresh: () => {},
    });
    return { fns, g, sel, before: clone(trades), calls };
}

test('Delete Selected: failed cloud delete keeps the trades and the selection, alerts', async () => {
    const h = bulkDeleteHarness(FAIL);
    await h.fns.dashDeleteSelected();
    assert.deepEqual(h.g.journalData.trades, h.before);
    assert.equal(h.calls.idb, 0);
    assert.deepEqual([...h.sel], [1, 2]);
    assert.deepEqual(h.calls.alerts, [DEL_FAIL_MSG]);
});

test('Delete Selected: success deletes and clears the selection', async () => {
    const h = bulkDeleteHarness(OK);
    await h.fns.dashDeleteSelected();
    assert.deepEqual(h.g.journalData.trades.map(t => t.id), [3]);
    assert.equal(h.sel.size, 0);
    assert.equal(h.calls.idb, 1);
});

function brokerDeleteHarness(fnName, opts) {
    const trades = opts.noTrades ? [{ id: 3, brokerAccountId: 'ba_keep' }]
        : [{ id: 1, brokerAccountId: 'ba_old' }, { id: 3, brokerAccountId: 'ba_keep' }];
    const accounts = [{ id: 'ba_old', displayName: 'Old' }, { id: 'ba_keep', displayName: 'Keep' }];
    const calls = { alerts: [], idb: 0, tradesDeleted: [], brokerDeleted: [], closed: [] };
    const { fns, g } = sandbox([[SRC.broker, [fnName]]], {
        journalData: { trades: trades.slice(), brokerAccounts: accounts.slice() },
        _pendingDeleteBrokerId: 'ba_old',
        ensureBrokerAccounts: () => {},
        getBrokerAccount: id => accounts.find(a => a.id === id),
        getTradeCountForAccount: id => trades.filter(t => t.brokerAccountId === id).length,
        confirm: () => true, alert: m => calls.alerts.push(m),
        _isCloudPrimarySave: () => opts.cloud !== false,
        _deleteTradesFromSupabase: async ids => { calls.tradesDeleted.push(ids); return opts.tradesDel || OK; },
        _deleteBrokerAccountFromSupabase: async id => { calls.brokerDeleted.push(id); return opts.brokerDel || OK; },
        closeModal: id => calls.closed.push(id),
        saveToIndexedDB: async () => { calls.idb++; },
        window: {},
    });
    return { fns, g, before: clone({ trades, brokerAccounts: accounts }), calls };
}

test('broker delete with its trades: failed cloud trade delete keeps the broker and trades, modal open', async () => {
    const h = brokerDeleteHarness('confirmBrokerDeleteAll', { tradesDel: FAIL });
    await h.fns.confirmBrokerDeleteAll();
    assert.deepEqual(clone(h.g.journalData), h.before);
    assert.deepEqual(h.calls.brokerDeleted, []);
    assert.deepEqual(h.calls.closed, []);
    assert.equal(h.calls.idb, 0);
    assert.equal(h.g._pendingDeleteBrokerId, 'ba_old');
    assert.deepEqual(h.calls.alerts, [DEL_FAIL_MSG]);
});

test('broker delete with its trades: success, and local modes, delete as before', async () => {
    for (const opts of [{}, { cloud: false, tradesDel: { success: false, error: 'Cloud save not available' } }]) {
        const h = brokerDeleteHarness('confirmBrokerDeleteAll', opts);
        await h.fns.confirmBrokerDeleteAll();
        assert.deepEqual(h.g.journalData.trades.map(t => t.id), [3]);
        assert.deepEqual(h.g.journalData.brokerAccounts.map(a => a.id), ['ba_keep']);
        assert.equal(h.calls.idb, 1);
        assert.deepEqual(h.calls.alerts, []);
    }
});

test('broker delete with no trades: failed cloud delete keeps the broker, alerts', async () => {
    const h = brokerDeleteHarness('deleteBrokerAccount', { noTrades: true, brokerDel: FAIL });
    await h.fns.deleteBrokerAccount('ba_old');
    assert.deepEqual(h.calls.brokerDeleted, ['ba_old']);
    assert.deepEqual(clone(h.g.journalData), h.before);
    assert.equal(h.calls.idb, 0);
    assert.deepEqual(h.calls.alerts, [DEL_FAIL_MSG]);
});

test('broker delete with no trades: success, and local modes, delete as before', async () => {
    for (const opts of [{ noTrades: true }, { noTrades: true, cloud: false, brokerDel: { success: false, error: 'Cloud save not available' } }]) {
        const h = brokerDeleteHarness('deleteBrokerAccount', opts);
        await h.fns.deleteBrokerAccount('ba_old');
        assert.deepEqual(h.g.journalData.brokerAccounts.map(a => a.id), ['ba_keep']);
        assert.equal(h.calls.idb, 1);
        assert.deepEqual(h.calls.alerts, []);
    }
});
