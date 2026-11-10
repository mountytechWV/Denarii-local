// Batch D2: cloud-first load on sign-in and the stale-write guard.
// - The strict cloud loader throws on any table error; the default mode
//   still loads a failed table as empty.
// - _mergeCloudIntoLocal: cloud wins, local-only fields and keys survive,
//   pending rows win, local-only records are hidden and counted, Pelosi demo
//   trades are kept only while the demo broker is in the cloud.
// - _cloudFirstReload: a failed, slow or wrong-account load leaves
//   journalData and IndexedDB untouched and pauses bulk writes.
// - Bulk writes send only changed rows, grouped by key set, never NULL for a
//   field left out; nothing is written with another account's session.
// - New accounts write from an empty baseline and save the demo trades;
//   lock signs out of Supabase (scope local) before reloading.
//
// Same harness as cloud-trade-writes.test.js: real functions are cut out of
// the browser scripts and run in a `with` scope where unknown globals are an
// inert stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const AUTH = read('js/auth.js');
const APP = read('Denarii.js');
const HTML = read('index.html');
const D3 = require('./helpers/d3-auth-fns');
const { fakeSupabase } = require('./helpers/fake-supabase');

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

const clone = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 30); i++) await tick(); }
const OK = { success: true, error: null };
const UID = 'u1';
const DEMO = 'ba_demo_pelosi';

const AUTH_FNS = [
    '_loadJournalFromSupabaseRows', '_fetchAllRows', '_mapSupabaseTradeRow', '_resolveStorageMode',
    '_mapArrayRow', '_mapReviewRows', '_mapPlannerRows', '_mapUserMetaRows', '_toISOOrNull', '_groupRowsByKeySet',
    '_shadowSkipTrades', '_shadowWriteRowsAwaited', '_shadowWriteRows', '_executeShadowWrite',
    '_detectDirtyDomains', '_updateDomainSnapshots',
    '_withTimeout', '_cloudWriteAllowed', '_sessionMatchesAccount', '_mapDomainRows', '_rowKey', '_rowSig',
    '_changedRows', '_markRows', '_savePendingRows', '_loadPendingRows', '_recordPendingRows', '_setCloudBaseline',
    '_enterCloudPaused', '_ensureCloudSessionState', '_overlayRecord', '_mergeCloudIntoLocal',
    '_keepCloudLoadSnapshot', '_cloudFirstReload', '_cloudBackupJournal', '_getSupabaseForBackup',
    '_upsertAuthProfile', '_completeLock',
    // Batch D3: checked writes, tracked deletes, conflicts
    ...D3.D3_FNS,
];
const AUTH_VARS = [
    extractVar(AUTH, /var _SHADOW_DOMAINS = \{[\s\S]*?\n\};/, '_SHADOW_DOMAINS'),
    extractVar(AUTH, /var _USER_META_KEYS = \[[\s\S]*?\];/, '_USER_META_KEYS'),
    extractVar(AUTH, /var _CLOUD_ARRAY_DOMAINS = \[[^\]]*\];/, '_CLOUD_ARRAY_DOMAINS'),
    extractVar(AUTH, /var _CLOUD_KEYED_DOMAINS = \[[^\]]*\];/, '_CLOUD_KEYED_DOMAINS'),
    "var _DEMO_BROKER_ID = 'ba_demo_pelosi';",
    'var _SB_PAGE_SIZE = 1000;',
    D3.d3Vars(AUTH),
].join('\n');

// A fake Supabase client (tests/helpers/fake-supabase.js). Batch D3:
// cloud_primary non-trade writes are inserts / rev-checked updates, so
// `client.upserts` records every write op ({ table, op, rows }).
function fakeClient(tables, opts) {
    return fakeSupabase(clone(tables || {}), opts);
}

function authBox(over) {
    const settings = {};
    const calls = { snaps: [], saves: [], puts: [], demoSaves: [], reload: 0, signOut: [] };
    const client = over && over.client || fakeClient({});
    const vals = Object.assign({
        window: { _denariiStorageMode: 'cloud_primary', _denariiSupabaseUid: UID },
        SupabaseAuth: {
            isReady: () => true, getClient: () => client,
            supabaseGetSession: async () => ({ data: { user: { id: UID } } }),
        },
        journalData: {},
        sessionDek: 'dek', sessionPassword: 'pw',
        currentAccountId: 'acct',
        _cloudSignInFailed: false, _cloudBaselineReady: false, _cloudPaused: false,
        _rowBaseline: {}, _cloudPending: {}, _cloudLoadStatus: null, _domainSnapshots: {},
        ...D3.d3State(),
        _CLOUD_LOAD_TIMEOUT_MS: 20000,
        _lastShadowWriteMs: 0, _shadowWriteRunning: false, _shadowWritePending: false,
        _lastCloudSaveMs: 0, _firstCloudSaveDone: false,
        STORE_NAME: 'journal',
        makeJournalKey: id => 'journal_' + id,
        getSetting: async k => settings[k],
        setSetting: async (k, v) => { settings[k] = v; },
        storeGet: async () => ({ encrypted: true, data: 'ENC-LOCAL', lastSaved: 't0' }),
        storePut: async (store, val, key) => { calls.puts.push({ key, val }); },
        snapshotJournalRecord: async (id, reason) => { calls.snaps.push(reason); return 'snapshot:' + id; },
        saveJournalRecord: async (id, rec) => { calls.saves.push(rec); },
        encrypt: d => 'ENC:' + JSON.stringify(d),
        _saveTradesToSupabase: async t => { calls.demoSaves.push(clone(t)); return OK; },
        location: { reload: () => { calls.reload++; } },
    }, over && over.vals);
    const box = sandbox([[AUTH, AUTH_FNS]], vals, AUTH_VARS);
    return Object.assign(box, { client, settings, calls });
}

// ── Static checks ───────────────────────────────────────────────────────────

test('index.html: auth.js and Denarii.js bumped for D2', () => {
    // At least the D2 versions (later batches bump them again).
    assert.ok(Number(/src="js\/auth\.js\?v=(\d+)"/.exec(HTML)[1]) >= 35);
    assert.ok(Number(/src="Denarii\.js\?v=(\d+)"/.exec(HTML)[1]) >= 44);
});

test('cloud fetch timeout is 20 s, and every cloud row load is strict', () => {
    assert.match(AUTH, /var _CLOUD_LOAD_TIMEOUT_MS = 20000;/);
    const calls = AUTH.match(/_loadJournalFromSupabaseRows\([^)]*\)/g).filter(c => !c.includes('opts'));
    assert.ok(calls.length >= 3);
    // Batch D3: the option object may also carry revs.
    for (const c of calls) assert.match(c, /\{ strict: true[ ,]/, c);
});

// ── Strict loader ───────────────────────────────────────────────────────────

test('loader: strict mode throws when any table fails', async () => {
    for (const table of ['trades', 'reviews', 'user_meta', 'tags']) {
        const h = authBox();
        const client = fakeClient({ trades: [{ id: 1, symbol: 'A' }] }, { fail: table });
        await assert.rejects(h.fns._loadJournalFromSupabaseRows(client, UID, { strict: true }), new RegExp(table));
    }
});

test('loader: default mode still loads a failed table as empty and adds defaults', async () => {
    const h = authBox();
    const client = fakeClient({ strategies: [{ id: 's1', name: 'S' }] }, { fail: 'trades' });
    const jd = await h.fns._loadJournalFromSupabaseRows(client, UID);
    assert.deepEqual(jd.trades, []);
    assert.equal(jd.strategies.length, 1);
    assert.equal(jd.version, 2);
    assert.ok(jd.created);
});

test('loader: strict mode adds no version/created defaults; user_meta values load', async () => {
    const h = authBox();
    const client = fakeClient({ user_meta: [{ key: '_demoImportVersion', value: '7' }] });
    const jd = await h.fns._loadJournalFromSupabaseRows(client, UID, { strict: true });
    assert.equal(jd.version, undefined);
    assert.equal(jd.created, undefined);
    assert.equal(jd._demoImportVersion, 7);
});

test('loader: a column missing from the row leaves the field unset', async () => {
    const h = authBox();
    const client = fakeClient({
        tags: [{ id: 't1', name: 'A' }, { id: 't2', name: 'B', is_starter: true }],
        note_templates: [{ id: 'n1', name: 'N', body: 'x' }, { id: 'n2', name: 'M', body: 'y', is_favorite: true, timeframes: ['1d'] }],
    });
    const jd = await h.fns._loadJournalFromSupabaseRows(client, UID, { strict: true });
    assert.equal('isStarter' in jd.tags[0], false);
    assert.equal(jd.tags[1].isStarter, true);
    assert.equal('isFavorite' in jd.noteTemplates[0], false);
    assert.equal('timeframes' in jd.noteTemplates[0], false);
    assert.equal(jd.noteTemplates[1].isFavorite, true);
    assert.deepEqual(jd.noteTemplates[1].timeframes, ['1d']);
});

// ── Merge ───────────────────────────────────────────────────────────────────

const merge = (local, cloud, pending) => authBox().fns._mergeCloudIntoLocal(local, cloud, pending);

test('merge: cloud wins; local-only fields and keys survive', () => {
    const local = {
        strategies: [{ id: 's1', name: 'old', localOnly: 'keep' }],
        dashLayout: { cols: 3 }, version: 3,
        tags: [{ id: 't1', name: 'T', isStarter: true }],
    };
    const cloud = { strategies: [{ id: 's1', name: 'new' }], tags: [{ id: 't1', name: 'T2' }], version: 3 };
    const before = clone(local);
    const m = merge(local, cloud, {});
    assert.equal(m.jd.strategies[0].name, 'new');
    assert.equal(m.jd.strategies[0].localOnly, 'keep');
    assert.deepEqual(m.jd.dashLayout, { cols: 3 });
    assert.equal(m.jd.tags[0].isStarter, true, 'missing cloud field keeps local value');
    assert.equal(m.jd.tags[0].name, 'T2');
    assert.equal(m.hidden, 0);
    assert.equal(m.changed, true);
    assert.deepEqual(local, before, 'local copy is not mutated');
});

test('merge: cloud-only records are added; local-only records are hidden and counted', () => {
    const local = {
        strategies: [{ id: 's1', name: 'A' }, { id: 'gone', name: 'deleted elsewhere' }],
        reviews: { 'daily|d1': { t: 'a' }, 'daily|old': { t: 'x' } },
        dailyPlanners: { 'dp|1': { p: 1 } },
    };
    const cloud = {
        strategies: [{ id: 's1', name: 'A' }, { id: 's2', name: 'B' }],
        reviews: { 'daily|d1': { t: 'a' }, 'daily|d2': { t: 'b' } },
        dailyPlanners: {},
    };
    const m = merge(local, cloud, {});
    assert.deepEqual(m.jd.strategies.map(s => s.id), ['s1', 's2']);
    assert.deepEqual(Object.keys(m.jd.reviews).sort(), ['daily|d1', 'daily|d2']);
    assert.deepEqual(m.jd.dailyPlanners, {});
    assert.equal(m.hidden, 3);
});

test('merge: pending rows win over the cloud, including ones the cloud lacks', () => {
    const local = {
        strategies: [{ id: 's1', name: 'offline edit' }, { id: 's9', name: 'made offline' }],
        reviews: { 'daily|d1': { t: 'offline' } },
        tagCategories: ['Local'],
    };
    const cloud = { strategies: [{ id: 's1', name: 'cloud' }], reviews: { 'daily|d1': { t: 'cloud' } }, tagCategories: ['Cloud'] };
    const pending = { strategies: { s1: true, s9: true }, reviews: { 'daily|d1': true }, _meta: { tagCategories: true } };
    const m = merge(local, cloud, pending);
    assert.deepEqual(m.jd.strategies.map(s => s.name), ['offline edit', 'made offline']);
    assert.equal(m.jd.reviews['daily|d1'].t, 'offline');
    assert.deepEqual(m.jd.tagCategories, ['Local']);
    assert.equal(m.hidden, 0);
});

test('merge: user_meta keys in the cloud win; keys the cloud lacks stay local', () => {
    const m = merge({ _demoImportDismissed: false, aiPromptFavorites: ['a'] }, { _demoImportDismissed: true }, {});
    assert.equal(m.jd._demoImportDismissed, true);
    assert.deepEqual(m.jd.aiPromptFavorites, ['a']);
});

test('merge: identical data reports no change', () => {
    const jd = { strategies: [{ id: 's1', name: 'A' }], reviews: { 'w|1': { x: 1 } } };
    assert.equal(merge(clone(jd), clone(jd), {}).changed, false);
});

test('merge: Pelosi demo trades missing from the cloud are kept while the demo broker is in the cloud', () => {
    const local = {
        brokerAccounts: [{ id: DEMO }],
        trades: [{ id: 1, brokerAccountId: DEMO }, { id: 2, brokerAccountId: 'ba_real' }, { id: 3, brokerAccountId: 'ba_real' }],
    };
    const cloud = { brokerAccounts: [{ id: DEMO }], trades: [{ id: 3, brokerAccountId: 'ba_real' }] };
    const m = merge(local, cloud, {});
    assert.deepEqual(m.jd.trades.map(t => t.id), [1, 3]);
    assert.deepEqual(m.demoTrades.map(t => t.id), [1]);
    assert.equal(m.hidden, 1, 'the real local-only trade is hidden');
});

test('merge: deleted Pelosi stays deleted (broker gone from the cloud, or demo dismissed)', () => {
    const local = { brokerAccounts: [{ id: DEMO }], trades: [{ id: 1, brokerAccountId: DEMO }] };
    const gone = merge(clone(local), { brokerAccounts: [], trades: [] }, {});
    assert.deepEqual(gone.jd.brokerAccounts, []);
    assert.deepEqual(gone.jd.trades, []);
    assert.equal(gone.demoTrades.length, 0);
    const dismissed = merge(clone(local), { brokerAccounts: [{ id: DEMO }], trades: [], _demoImportDismissed: true }, {});
    assert.deepEqual(dismissed.jd.trades, []);
    assert.equal(dismissed.demoTrades.length, 0);
});

// ── _cloudFirstReload ───────────────────────────────────────────────────────

const AUTH_REC = { id: 'acct', supabaseUid: UID, storageMode: 'cloud_primary' };

function reloadBox(local, client, vals) {
    return authBox({ client, vals: Object.assign({ journalData: local }, vals) });
}

async function expectUntouched(h, local, before) {
    assert.equal(h.g.journalData, local, 'journalData is the same object');
    assert.deepEqual(h.g.journalData, before, 'journalData content unchanged');
    assert.equal(h.calls.saves.length, 0, 'IndexedDB journal not written');
    assert.equal(h.calls.snaps.length + h.calls.puts.length, 0, 'no snapshot written');
    assert.equal(h.g._cloudPaused, true);
    assert.equal(h.fns._cloudWriteAllowed(), false);
    assert.equal(h.g._cloudLoadStatus.ok, false);
    await settle();
    assert.equal(h.client.upserts.length, 0, 'nothing written to the cloud');
}

test('cloud-first: a failed fetch leaves journalData and IndexedDB untouched and pauses writes', async () => {
    const local = { strategies: [{ id: 's1', name: 'local' }], reviews: { 'daily|d1': { t: 1 } } };
    const before = clone(local);
    const h = reloadBox(local, fakeClient({ strategies: [{ id: 's1', name: 'cloud' }] }, { fail: 'reviews' }));
    const r = await h.fns._cloudFirstReload(AUTH_REC);
    assert.equal(r.ok, false);
    await expectUntouched(h, local, before);
});

test('cloud-first: a slow fetch times out with the same result', async () => {
    const local = { strategies: [{ id: 's1', name: 'local' }] };
    const before = clone(local);
    const h = reloadBox(local, fakeClient({}, { hang: 'trades' }), { _CLOUD_LOAD_TIMEOUT_MS: 20 });
    const r = await h.fns._cloudFirstReload(AUTH_REC);
    assert.match(r.reason, /timed out/);
    await expectUntouched(h, local, before);
});

test('cloud-first: a session for another account, or a failed sign-in, never fetches', async () => {
    for (const vals of [
        { SupabaseAuth: { isReady: () => true, getClient: () => ({ from() { throw new Error('fetched with another account'); } }),
            supabaseGetSession: async () => ({ data: { user: { id: 'other' } } }) } },
        { _cloudSignInFailed: true },
        { SupabaseAuth: { isReady: () => false } },
    ]) {
        const local = { strategies: [{ id: 's1' }] };
        const before = clone(local);
        let fetched = false;
        const client = fakeClient({});
        const from = client.from;
        client.from = t => { fetched = true; return from(t); };
        const h = reloadBox(local, client, vals);
        await h.fns._cloudFirstReload(AUTH_REC);
        assert.equal(fetched, false);
        await expectUntouched(h, local, before);
    }
});

test('cloud-first: not cloud_primary → no fetch and no pause', async () => {
    const local = { strategies: [] };
    const h = reloadBox(local, fakeClient({}), { window: { _denariiStorageMode: 'migration_pending' } });
    const r = await h.fns._cloudFirstReload({ id: 'acct', supabaseUid: UID, storageMode: 'migration_pending' });
    assert.equal(r.ok, false);
    assert.equal(h.g._cloudPaused, false);
    assert.equal(h.g.journalData, local);
});

test('cloud-first: success replaces journalData, keeps a never-pruned snapshot of hidden records, sets the baseline', async () => {
    const local = { strategies: [{ id: 's1', name: 'stale' }, { id: 'local-only' }], dashLayout: 'L' };
    const client = fakeClient({ strategies: [{ id: 's1', name: 'fresh' }] });
    const h = reloadBox(local, client);
    const r = await h.fns._cloudFirstReload(AUTH_REC);
    assert.deepEqual(r, { ok: true, hidden: 1 });
    assert.deepEqual(h.g.journalData.strategies.map(s => s.name), ['fresh']);
    assert.equal(h.g.journalData.dashLayout, 'L');
    assert.equal(h.calls.puts.length, 1);
    assert.match(h.calls.puts[0].key, /^cloudload:acct:/);
    assert.equal(h.calls.puts[0].val.data, 'ENC-LOCAL', 'snapshot holds the old local copy');
    assert.equal(h.calls.snaps.length, 0);
    assert.equal(h.calls.saves.length, 1);
    assert.equal(h.calls.saves[0].data, 'ENC:' + JSON.stringify(h.g.journalData));
    assert.equal(h.g._cloudBaselineReady, true);
    assert.equal(h.fns._cloudWriteAllowed(), true);
    assert.deepEqual(h.g._cloudLoadStatus, { ok: true, hidden: 1, hiddenKeys: ['strategies:local-only'], reason: null });
    await settle();
    assert.equal(client.upserts.length, 0, 'loading writes nothing back');
});

test('cloud-first: a change with nothing hidden uses the normal pruned snapshot', async () => {
    const h = reloadBox({ strategies: [{ id: 's1', name: 'stale' }] }, fakeClient({ strategies: [{ id: 's1', name: 'fresh' }] }));
    await h.fns._cloudFirstReload(AUTH_REC);
    assert.deepEqual(h.calls.snaps, ['pre-cloud-load']);
    assert.equal(h.calls.puts.length, 0);
});

test('cloud-first: a second sign-in with no cloud change writes no snapshot and no IndexedDB copy', async () => {
    const client = fakeClient({ strategies: [{ id: 's1', name: 'same' }], reviews: [{ review_type: 'daily', review_key: 'd1', data: { t: 1 } }] });
    const first = reloadBox({ strategies: [{ id: 's1', name: 'same' }] }, client);
    await first.fns._cloudFirstReload(AUTH_REC);
    const h = reloadBox(clone(first.g.journalData), client);
    const r = await h.fns._cloudFirstReload(AUTH_REC);
    assert.equal(r.ok, true);
    assert.equal(h.calls.saves.length + h.calls.snaps.length + h.calls.puts.length, 0);
});

test('cloud-first: a failed snapshot leaves journalData untouched and pauses', async () => {
    const local = { strategies: [{ id: 's1', name: 'stale' }] };
    const before = clone(local);
    const h = reloadBox(local, fakeClient({ strategies: [{ id: 's1', name: 'fresh' }] }),
        { snapshotJournalRecord: async () => { throw new Error('disk full'); } });
    const r = await h.fns._cloudFirstReload(AUTH_REC);
    assert.equal(r.ok, false);
    assert.equal(h.g.journalData, local);
    assert.deepEqual(local, before);
    assert.equal(h.g._cloudPaused, true);
});

test('cloud-first: pending rows win and are pushed (only those), then cleared', async () => {
    const local = {
        strategies: [{ id: 's1', name: 'S' }],
        reviews: { 'daily|d1': { t: 'offline' }, 'daily|d2': { t: 'same' } },
    };
    const client = fakeClient({
        strategies: [{ id: 's1', name: 'S' }],
        reviews: [{ review_type: 'daily', review_key: 'd1', data: { t: 'cloud' } }, { review_type: 'daily', review_key: 'd2', data: { t: 'same' } }],
    });
    const h = reloadBox(local, client);
    h.settings['cloudPending:acct'] = { reviews: { 'daily|d1': true } };
    await h.fns._cloudFirstReload(AUTH_REC);
    assert.equal(h.g.journalData.reviews['daily|d1'].t, 'offline');
    await settle();
    const sent = client.upserts.flatMap(u => u.rows.map(r => u.table + ':' + (r.review_key || r.key || r.id)));
    assert.deepEqual(sent, ['reviews:d1']);
    assert.equal(client.upserts[0].rows[0].data.t, 'offline');
    assert.equal(h.settings['cloudPending:acct'], null, 'pending list cleared after the push');
});

test('cloud-first: kept Pelosi demo trades are saved through _saveTradesToSupabase', async () => {
    const local = { brokerAccounts: [{ id: DEMO }], trades: [{ id: 1, brokerAccountId: DEMO }] };
    const h = reloadBox(local, fakeClient({ broker_accounts: [{ id: DEMO }] }));
    await h.fns._cloudFirstReload(AUTH_REC);
    await settle();
    assert.deepEqual(h.calls.demoSaves.map(ts => ts.map(t => t.id)), [[1]]);
    assert.deepEqual(h.g.journalData.trades.map(t => t.id), [1]);
});

// ── Changed rows only ──────────────────────────────────────────────────────

function baselined(jd, client) {
    const h = authBox({ client, vals: { journalData: jd } });
    h.fns._setCloudBaseline(jd, true);
    return h;
}

test('bulk write: editing one review sends that one row; unchanged domains and meta are not sent', async () => {
    const jd = {
        strategies: [{ id: 's1', name: 'S' }],
        reviews: { 'daily|d1': { t: 1 }, 'daily|d2': { t: 2 }, 'daily|d3': { t: 3 } },
        tagCategories: ['A'], version: 3,
    };
    const client = fakeClient({});
    const h = baselined(jd, client);
    jd.reviews['daily|d2'] = { t: 'edited' };
    await h.fns._shadowWriteRowsAwaited(jd);
    assert.equal(client.upserts.length, 1);
    assert.equal(client.upserts[0].table, 'reviews');
    assert.deepEqual(client.upserts[0].rows.map(r => r.review_key), ['d2']);
    // A second save with no change sends nothing.
    await h.fns._shadowWriteRowsAwaited(jd);
    assert.equal(client.upserts.length, 1);
});

test('bulk write: a changed user_meta key is sent alone', async () => {
    const jd = { strategies: [{ id: 's1' }], tagCategories: ['A'], version: 3, aiPromptFavorites: ['x'] };
    const client = fakeClient({});
    const h = baselined(jd, client);
    jd.tagCategories = ['A', 'B'];
    jd.strategies[0].name = 'renamed';
    await h.fns._shadowWriteRowsAwaited(jd);
    const meta = client.upserts.find(u => u.table === 'user_meta');
    assert.deepEqual(meta.rows.map(r => r.key), ['tagCategories']);
});

test('bulk write: a failed upsert keeps the rows pending and retries them on the next save', async () => {
    const jd = { strategies: [{ id: 's1', name: 'A' }] };
    const client = fakeClient({}, { upsertError: true });
    const h = baselined(jd, client);
    jd.strategies[0].name = 'B';
    await h.fns._shadowWriteRowsAwaited(jd);
    assert.deepEqual(h.g._cloudPending, { strategies: { s1: true } });
    await settle();
    assert.deepEqual(h.settings['cloudPending:acct'], { strategies: { s1: true } });
    await h.fns._shadowWriteRowsAwaited(jd);
    assert.equal(client.upserts.filter(u => u.table === 'strategies').length, 2, 'retried');
});

test('bulk write: rows are grouped by key set and a field left out is never sent as NULL', async () => {
    // migration_pending still bulk-writes trades; D1 trade fields are optional.
    const jd = { trades: [
        { id: 1, symbol: 'A', type: 'long', grossPnl: 5 },
        { id: 2, symbol: 'B', type: 'long' },
        { id: 3, symbol: 'C', type: 'long', grossPnl: 7 },
    ] };
    const client = fakeClient({});
    const h = authBox({ client, vals: { journalData: jd, window: { _denariiStorageMode: 'migration_pending', _denariiSupabaseUid: UID } } });
    await h.fns._shadowWriteRowsAwaited(jd);
    const trades = client.upserts.filter(u => u.table === 'trades');
    assert.equal(trades.length, 2);
    for (const u of trades) {
        const sig = Object.keys(u.rows[0]).sort().join(',');
        for (const r of u.rows) assert.equal(Object.keys(r).sort().join(','), sig, 'one key set per request');
    }
    const row2 = trades.flatMap(u => u.rows).find(r => r.id === 2);
    assert.equal('gross_pnl' in row2, false);
});

// ── Write checks ───────────────────────────────────────────────────────────

test('write check: a session for another account writes nothing (any storage mode)', async () => {
    for (const mode of ['cloud_primary', 'migration_pending', 'local_legacy']) {
        const jd = { strategies: [{ id: 's1' }], version: 2 };
        const client = fakeClient({});
        const h = authBox({ client, vals: { journalData: jd, window: { _denariiStorageMode: mode, _denariiSupabaseUid: mode === 'local_legacy' ? null : 'me' } } });
        h.fns._setCloudBaseline({}, true);
        await h.fns._shadowWriteRowsAwaited(jd);
        assert.equal(client.upserts.length, 0, mode);
    }
});

test('write check: no baseline (paused) writes nothing and records the changed rows as pending', async () => {
    const jd = { strategies: [{ id: 's1', name: 'A' }], reviews: { 'daily|d1': { t: 1 } }, tagCategories: ['A'] };
    const client = fakeClient({});
    const h = authBox({ client, vals: { journalData: jd } });
    h.g.journalData = jd;
    h.fns._enterCloudPaused('offline');
    jd.strategies[0].name = 'B';
    jd.reviews['daily|d2'] = { t: 'new' };
    jd.tagCategories = ['A', 'B'];
    await h.fns._shadowWriteRowsAwaited(jd);
    h.fns._shadowWriteRows(jd);
    await settle();
    assert.equal(client.upserts.length, 0);
    assert.deepEqual(h.settings['cloudPending:acct'], {
        strategies: { s1: true }, reviews: { 'daily|d2': true }, _meta: { tagCategories: true },
    });
});

test('write check: unlock without a cloud load pauses a cloud_primary session; other modes are untouched', () => {
    const h = authBox({ vals: { journalData: { strategies: [] } } });
    h.fns._ensureCloudSessionState();
    assert.equal(h.g._cloudPaused, true);
    assert.equal(h.fns._cloudWriteAllowed(), false);
    const m = authBox({ vals: { window: { _denariiStorageMode: 'migration_pending', _denariiSupabaseUid: UID } } });
    m.fns._ensureCloudSessionState();
    assert.equal(m.g._cloudPaused, false);
    assert.equal(m.fns._cloudWriteAllowed(), true);
});

function backupBox(vals) {
    const upserts = [];
    const client = { from: t => ({ upsert: async row => { upserts.push(t); return { error: null }; } }) };
    const h = authBox({ vals: Object.assign({ SupabaseAuth: {
        isReady: () => true, getClient: () => client, supabaseGetSession: async () => ({ data: { user: { id: UID } } }),
    } }, vals) });
    return Object.assign(h, { upserts });
}

test('journal_backups: never written for cloud_primary (Batch D3); other modes unchanged, never with another account\'s session', async () => {
    const paused = backupBox();
    await paused.fns._cloudBackupJournal('ENC');
    assert.deepEqual(paused.upserts, []);
    const ready = backupBox({ _cloudBaselineReady: true });
    await ready.fns._cloudBackupJournal('ENC');
    assert.deepEqual(ready.upserts, [], 'retired for cloud_primary');
    const other = backupBox({ window: { _denariiStorageMode: 'migration_pending', _denariiSupabaseUid: 'someone-else' } });
    await other.fns._cloudBackupJournal('ENC');
    assert.deepEqual(other.upserts, []);
    const legacy = backupBox({ window: { _denariiStorageMode: 'migration_pending', _denariiSupabaseUid: UID } });
    await legacy.fns._cloudBackupJournal('ENC');
    assert.deepEqual(legacy.upserts, ['journal_backups'], 'other modes unchanged');
});

test('user_profiles: an auth record is never written with another account\'s session', async () => {
    const h = backupBox();
    await h.fns._upsertAuthProfile({ id: 'b', username: 'B' });
    await h.fns._upsertAuthProfile({ id: 'c', username: 'C', supabaseUid: 'other' });
    assert.deepEqual(h.upserts, []);
    await h.fns._upsertAuthProfile({ id: 'a', username: 'A', supabaseUid: UID });
    assert.deepEqual(h.upserts, ['user_profiles']);
});

// ── Registration / new account ─────────────────────────────────────────────

test('registration: the empty baseline lets the first saves write every row', async () => {
    assert.match(extractFunction(AUTH, 'createNewJournal'), /_setCloudBaseline\(\{\}, true\)[\s\S]*await saveToIndexedDB\(\)/);
    const client = fakeClient({});
    const h = authBox({ client });
    h.fns._setCloudBaseline({}, true);
    const jd = { version: 1, created: 'c', brokerAccounts: [{ id: DEMO }], reviews: { 'daily|d1': {} }, trades: [{ id: 1 }] };
    h.g.journalData = jd;
    await h.fns._shadowWriteRowsAwaited(jd);
    const tables = client.upserts.map(u => u.table);
    assert.ok(tables.includes('broker_accounts'));
    assert.ok(tables.includes('reviews'));
    assert.ok(tables.includes('user_meta'));
    assert.ok(!tables.includes('trades'), 'trades still go only through per-trade saves');
});

function unlockBox(jd, mode) {
    const calls = { demoSaves: [], alerts: [], saves: 0 };
    const auth = { id: 'acct', username: 'u', supabaseUid: UID, storageMode: mode };
    const box = sandbox([[APP, ['unlockApp']], [AUTH, ['_resolveStorageMode']]], {
        window: { migrateBrokerAccounts: () => false, populateBrokerAccountDropdowns() {}, renderBrokerAccountsList() {} },
        journalData: jd,
        getAuthRecord: async () => auth,
        DEMO_BROKER_ID: DEMO, DEMO_BROKER_DATA_VERSION: 7,
        sessionDek: 'dek', sessionPassword: 'pw',
        CURRENT_SCHEMA_VERSION: 3, SCHEMA_MIGRATIONS: {},
        ensureDemoStrategiesExist: () => false, backfillStrategiesFromExistingTrades: () => false,
        ensureStarterTags: () => false, migrateNotesFields: () => false, seedSystemTemplates: () => false,
        _importFromDemoBundle: d => {
            d.brokerAccounts.push({ id: DEMO });
            d.trades.push({ id: 'd1', brokerAccountId: DEMO }, { id: 'd2', brokerAccountId: DEMO });
            d._demoImportVersion = 7;
            return true;
        },
        _saveTradesToSupabase: async t => { calls.demoSaves.push(t.map(x => x.id)); return OK; },
        saveToIndexedDB: async () => { calls.saves++; },
        alert: m => calls.alerts.push(m),
        _runCloudMigration: undefined,
        _startBackfillIfNeeded: undefined,
        setTimeout: () => 0,
    });
    return Object.assign(box, { calls });
}

test('new account: Pelosi seeds on first unlock and its trades are saved to the cloud (cloud_primary)', async () => {
    const h = unlockBox({ version: 3, trades: [], strategies: [], brokerAccounts: [] }, 'cloud_primary');
    await h.fns.unlockApp();
    await settle();
    assert.deepEqual(h.calls.alerts, []);
    assert.deepEqual(h.g.journalData.trades.map(t => t.id), ['d1', 'd2']);
    assert.deepEqual(h.calls.demoSaves, [['d1', 'd2']]);
    assert.equal(h.calls.saves, 1);
});

test('new account: a failed demo cloud save is logged and never blocks unlock', async () => {
    const h = unlockBox({ version: 3, trades: [], strategies: [], brokerAccounts: [] }, 'cloud_primary');
    h.g._saveTradesToSupabase = async () => ({ success: false, error: 'offline' });
    await h.fns.unlockApp();
    await settle();
    assert.deepEqual(h.calls.alerts, []);
    assert.equal(h.g.journalData.trades.length, 2);
});

test('new account: other storage modes seed Pelosi without a per-trade cloud save', async () => {
    const h = unlockBox({ version: 3, trades: [], strategies: [], brokerAccounts: [] }, 'local_legacy');
    await h.fns.unlockApp();
    await settle();
    assert.equal(h.g.journalData.trades.length, 2);
    assert.deepEqual(h.calls.demoSaves, []);
});

test('deleted Pelosi stays deleted: no re-import and no demo cloud save', async () => {
    const h = unlockBox({ version: 3, trades: [], strategies: [], brokerAccounts: [], _demoBrokerVersion: 6 }, 'cloud_primary');
    await h.fns.unlockApp();
    await settle();
    assert.equal(h.g.journalData._demoImportDismissed, true);
    assert.deepEqual(h.g.journalData.trades, []);
    assert.deepEqual(h.calls.demoSaves, []);
});

// ── Lock ───────────────────────────────────────────────────────────────────

function lockBox(signOut) {
    const calls = { reload: 0, scopes: [], timers: [] };
    const h = authBox({ vals: {
        SupabaseAuth: { isReady: () => true, getClient: () => ({ auth: { signOut: o => { calls.scopes.push(o); return signOut(); } } }) },
        location: { reload: () => { calls.reload++; } },
        setTimeout: (fn, ms) => { calls.timers.push({ fn, ms }); return 0; },
        window: {},
    } });
    return Object.assign(h, { lockCalls: calls });
}

test('lock: signs out of Supabase (scope local) before reloading', async () => {
    let resolveSignOut;
    const h = lockBox(() => new Promise(r => { resolveSignOut = r; }));
    h.fns._completeLock();
    assert.deepEqual(h.lockCalls.scopes, [{ scope: 'local' }]);
    assert.equal(h.lockCalls.reload, 0, 'waits for sign-out');
    resolveSignOut({ error: null });
    await settle();
    assert.equal(h.lockCalls.reload, 1);
    assert.equal(h.g.sessionPassword, null);
    assert.equal(h.g.sessionDek, null);
});

test('lock: a sign-out that hangs still reloads after 2 s; a failed one reloads at once', async () => {
    const hang = lockBox(() => new Promise(() => {}));
    hang.fns._completeLock();
    assert.equal(hang.lockCalls.timers[0].ms, 2000);
    hang.lockCalls.timers[0].fn();
    await settle();
    assert.equal(hang.lockCalls.reload, 1);
    const fail = lockBox(() => Promise.reject(new Error('offline')));
    fail.fns._completeLock();
    await settle();
    assert.equal(fail.lockCalls.reload, 1);
});
