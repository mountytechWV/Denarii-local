// Batch D3: every non-trade data type checked and complete in Supabase.
// - Loader: late columns (is_starter, is_favorite, timeframes) left unset
//   when NULL; `extra` fields added under the mapped ones; revs collected
//   outside journalData.
// - Mapper: fields without a column go to `extra` (sorted, no '_' keys).
// - Baseline from the cloud: fields / meta keys the cloud lacks are sent once.
// - Checked saves: insert new rows, update known rows only where rev
//   matches; a conflict → the cloud wins, an encrypted copy is kept.
// - Deletes: queued offline, pushed later; an item edited elsewhere is kept.
// - Re-sync on "online" / visible; paused sessions resume.
// - journal_backups retired for cloud_primary; Gemini key checked + per
//   account; drafts encrypted; the four bugs; DenariiCloudCheck read-only.
//
// Same harness as batch-d2.test.js: real functions are cut out of the
// browser scripts and run in a `with` scope (unknown globals are inert).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D3 = require('./helpers/d3-auth-fns');
const { fakeSupabase } = require('./helpers/fake-supabase');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const AUTH = read('js/auth.js');
const APP = read('Denarii.js');
const HTML = read('index.html');
const SETTINGS = read('js/pages/settings.js');
const GEMINI = read('js/services/ai/gemini.js');
const AUTOSAVE = read('js/services/autosave.js');
const CHECK = read('js/services/cloud-check.js');

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
async function settle(n) { for (let i = 0; i < (n || 40); i++) await tick(); }
const UID = 'u1';
const DEMO = 'ba_demo_pelosi';

// Fake encryption: readable in tests, fails with the wrong key.
const encrypt = (d, k) => 'E:' + k + ':' + JSON.stringify(d);
const decrypt = (s, k) => (typeof s === 'string' && s.indexOf('E:' + k + ':') === 0 ? JSON.parse(s.slice(('E:' + k + ':').length)) : null);

const AUTH_FNS = [
    '_loadJournalFromSupabaseRows', '_fetchAllRows', '_mapSupabaseTradeRow', '_resolveStorageMode',
    '_mapArrayRow', '_mapReviewRows', '_mapPlannerRows', '_mapUserMetaRows', '_toISOOrNull', '_groupRowsByKeySet',
    '_shadowSkipTrades', '_shadowWriteRowsAwaited', '_shadowWriteRows', '_executeShadowWrite',
    '_detectDirtyDomains', '_updateDomainSnapshots',
    '_withTimeout', '_cloudWriteAllowed', '_sessionMatchesAccount', '_mapDomainRows', '_rowKey', '_rowSig',
    '_changedRows', '_markRows', '_savePendingRows', '_loadPendingRows', '_recordPendingRows', '_setCloudBaseline',
    '_enterCloudPaused', '_ensureCloudSessionState', '_overlayRecord', '_mergeCloudIntoLocal',
    '_keepCloudLoadSnapshot', '_cloudFirstReload', '_cloudBackupJournal', '_getSupabaseForBackup',
    '_showCloudLoadBanner', '_deleteBrokerAccountFromSupabase', '_saveStrategyToSupabase', '_deleteStrategyFromSupabase',
    '_saveTagToSupabase', '_deleteTagFromSupabase', '_saveAiPromptFavoritesToSupabase', '_deleteSupabaseAccount',
    'loadFromIndexedDB',
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

function authBox(over) {
    over = over || {};
    const settings = Object.assign({}, over.settings);
    const calls = { snaps: [], saves: [], puts: [], demoSaves: [], refresh: 0, dash: 0, signOut: [] };
    const client = over.client || fakeSupabase({}, { pk: true, rev: true });
    const win = Object.assign({ _denariiStorageMode: 'cloud_primary', _denariiSupabaseUid: UID,
        _denariiRefreshUI: () => { calls.refresh++; }, _invalidateCloudDash: () => { calls.dash++; } }, over.window);
    const vals = Object.assign({
        window: win,
        SupabaseAuth: {
            isReady: () => true, getClient: () => client,
            supabaseGetSession: async () => ({ data: { user: { id: over.sessionUid || UID } } }),
        },
        journalData: {},
        sessionDek: 'dek', sessionPassword: 'pw',
        currentAccountId: 'acct',
        _cloudSignInFailed: false, _cloudBaselineReady: false, _cloudPaused: false,
        _rowBaseline: {}, _cloudPending: {}, _cloudLoadStatus: null, _domainSnapshots: {},
        _CLOUD_LOAD_TIMEOUT_MS: 20000,
        _lastShadowWriteMs: 0, _shadowWriteRunning: false, _shadowWritePending: false,
        _lastCloudSaveMs: 0, _firstCloudSaveDone: false,
        ...D3.d3State(),
        STORE_NAME: 'journal',
        makeJournalKey: id => 'journal_' + id,
        getSetting: async k => settings[k],
        setSetting: async (k, v) => { settings[k] = v; },
        storeGet: async () => ({ encrypted: true, data: 'ENC-LOCAL', lastSaved: 't0' }),
        storePut: async (store, val, key) => { calls.puts.push({ key, val }); },
        snapshotJournalRecord: async (id, reason) => { calls.snaps.push(reason); return 'snapshot:' + id; },
        saveJournalRecord: async (id, rec) => { calls.saves.push(rec); },
        encrypt, decrypt,
        _saveTradesToSupabase: async t => { calls.demoSaves.push(clone(t)); return { success: true, error: null }; },
        updateDashboard: () => { calls.dash++; },
        navigator: { onLine: true },
        document: { getElementById: () => null, body: null },
    }, over.vals);
    const box = sandbox([[AUTH, AUTH_FNS]], vals, AUTH_VARS);
    return Object.assign(box, { client, settings, calls });
}

// A box whose journalData came from a cloud load of `tables` (revs known).
async function loadedBox(tables, over) {
    const client = fakeSupabase(clone(tables), { pk: true, rev: true });
    const h = authBox(Object.assign({ client }, over));
    const revs = {};
    const cloud = await h.fns._loadJournalFromSupabaseRows(client, UID, { strict: true, revs });
    h.g.journalData = clone(cloud);
    h.g._rowRev = revs;
    h.fns._setCloudBaseline(h.g.journalData, true, cloud);
    client.writes.length = 0;
    return h;
}

const writesOf = (client, table) => client.writes.filter(w => w.table === table);
const stored = (client, table, id) => (client.tables[table] || []).find(r => String(r.id) === String(id));

// ── Static checks ───────────────────────────────────────────────────────────

test('index.html: D3 versions and cloud-check.js right after auth.js', () => {
    assert.ok(Number(/src="js\/auth\.js\?v=(\d+)"/.exec(HTML)[1]) >= 36);
    // At least the D3 version (later batches bump it again).
    assert.ok(Number(/src="Denarii\.js\?v=(\d+)"/.exec(HTML)[1]) >= 45);
    assert.ok(Number(/src="js\/pages\/settings\.js\?v=(\d+)"/.exec(HTML)[1]) >= 7);
    assert.ok(Number(HTML.split('src="js/services/autosave.js?v=')[1].split('"')[0]) >= 2);
    assert.ok(Number(/src="js\/services\/ai\/gemini\.js\?v=(\d+)"/.exec(HTML)[1]) >= 2);
    assert.match(HTML, /src="js\/auth\.js\?v=\d+" defer><\/script>\s*<script src="js\/services\/cloud-check\.js\?v=\d+" defer><\/script>/);
});

test('meta keys include the page layouts, dashPrefs and _systemTemplatesVersion', () => {
    const h = authBox();
    const jd = { snapshotLayout: [1], perfTrendsLayout: [2], setupsLayout: [3], timingLayout: [4], symbolsLayout: [5],
        riskLayout: [6], disciplineLayout: [7], reviewLayouts: { a: 1 }, _systemTemplatesVersion: 3, dashPrefs: { defaultView: 'calendar' },
        tagCategories: ['A'] };
    const keys = h.fns._mapUserMetaRows(UID, jd).map(r => r.key).sort();
    assert.deepEqual(keys, Object.keys(jd).sort());
});

// ── Loader / mapper ─────────────────────────────────────────────────────────

test('loader: NULL late columns leave the field unset; extra fields are added, columns win; revs collected outside journalData', async () => {
    const client = fakeSupabase({
        tags: [{ id: 't1', name: 'A', is_starter: null, rev: 4 }, { id: 't2', name: 'B', is_starter: true, extra: { isDemoSeed: true, name: 'X' } }],
        note_templates: [{ id: 'n1', name: 'N', body: 'b', is_favorite: null, timeframes: null, rev: 2 }],
        strategies: [{ id: 1000001, name: 'S', extra: { isDemoSeed: true, ruleVersion: 1 }, rev: 9 }],
        reviews: [{ review_type: 'daily', review_key: 'd1', data: { t: 1 }, rev: 3 }],
        user_meta: [{ key: 'dashPrefs', value: '{"defaultView":"calendar"}', rev: 5 }],
    });
    const h = authBox({ client });
    const revs = {};
    const jd = await h.fns._loadJournalFromSupabaseRows(client, UID, { strict: true, revs });
    assert.equal('isStarter' in jd.tags[0], false);
    assert.equal(jd.tags[1].isStarter, true);
    assert.equal(jd.tags[1].isDemoSeed, true);
    assert.equal(jd.tags[1].name, 'B', 'column wins over extra');
    assert.equal('isFavorite' in jd.noteTemplates[0], false);
    assert.equal('timeframes' in jd.noteTemplates[0], false);
    assert.deepEqual([jd.strategies[0].isDemoSeed, jd.strategies[0].ruleVersion], [true, 1]);
    assert.deepEqual(jd.dashPrefs, { defaultView: 'calendar' });
    assert.deepEqual(revs, { tags: { t1: 4 }, noteTemplates: { n1: 2 }, strategies: { 1000001: 9 }, reviews: { 'daily|d1': 3 }, _meta: { dashPrefs: 5 } });
    assert.equal(JSON.stringify(jd).includes('"rev"'), false, 'no rev inside journalData');
});

test('mapper: fields without a column go to extra (sorted, no _ keys); left out when empty; trades never get extra', () => {
    const h = authBox();
    const row = h.fns._mapArrayRow(UID, 'strategies', { id: 1, name: 'S', ruleVersion: 2, isDemoSeed: true, _tmp: 1, u: undefined });
    assert.deepEqual(Object.keys(row.extra), ['isDemoSeed', 'ruleVersion']);
    assert.equal('extra' in h.fns._mapArrayRow(UID, 'tags', { id: 't', name: 'T' }), false);
    assert.equal('extra' in h.fns._mapArrayRow(UID, 'trades', { id: 1, symbol: 'A', foo: 1 }), false);
});

test('signature: key order and timestamp format do not count as a change', () => {
    const h = authBox();
    const a = h.fns._rowSig('strategies', { id: '1', groups: [{ b: 1, a: 2 }], created_at: '2024-07-01T09:30:00.000Z' });
    const b = h.fns._rowSig('strategies', { created_at: '2024-07-01T09:30:00+00:00', groups: [{ a: 2, b: 1 }], id: '1' });
    assert.equal(a, b);
});

// ── Baseline from the cloud ────────────────────────────────────────────────

test('cloud-first: a NULL late column, extra fields and a meta key the cloud lacks are sent once; equal rows are not', async () => {
    const local = {
        tags: [{ id: 't1', name: 'Starter', isStarter: true }, { id: 't2', name: 'Same', category: '', description: '' }],
        strategies: [{ id: 1000001, name: 'S', isDemoSeed: true, ruleVersion: 1 }],
        snapshotLayout: ['a', 'b'],
    };
    const client = fakeSupabase({
        tags: [{ id: 't1', name: 'Starter', is_starter: null, rev: 1 }, { id: 't2', name: 'Same', rev: 1 }],
        strategies: [{ id: '1000001', name: 'S', rev: 1 }],
    }, { pk: true, rev: true });
    const h = authBox({ client, vals: { journalData: local } });
    const r = await h.fns._cloudFirstReload({ id: 'acct', supabaseUid: UID, storageMode: 'cloud_primary' });
    assert.equal(r.ok, true);
    await settle();
    assert.equal(stored(client, 'tags', 't1').is_starter, true);
    assert.equal(stored(client, 'tags', 't1').rev, 2);
    assert.equal(writesOf(client, 'tags').length, 1, 't2 is equal and not sent');
    assert.deepEqual(stored(client, 'strategies', '1000001').extra, { isDemoSeed: true, ruleVersion: 1 });
    assert.deepEqual(client.tables.user_meta.map(m => m.key), ['snapshotLayout']);
    // Next sign-in: nothing differs, nothing is sent.
    client.writes.length = 0;
    const again = authBox({ client, vals: { journalData: clone(h.g.journalData) } });
    await again.fns._cloudFirstReload({ id: 'acct', supabaseUid: UID, storageMode: 'cloud_primary' });
    await settle();
    assert.equal(client.writes.length, 0);
});

// ── Checked saves ──────────────────────────────────────────────────────────

test('checked save: a new row is inserted; a known row is updated only where rev matches, with only its own keys', async () => {
    const h = await loadedBox({ strategies: [{ id: 's1', name: 'A', rev: 3 }] });
    h.g.journalData.strategies.push({ id: 's2', name: 'New' });
    h.g.journalData.strategies[0].name = 'B';
    await h.fns._shadowWriteRowsAwaited(h.g.journalData);
    const ops = writesOf(h.client, 'strategies').map(w => w.op);
    assert.deepEqual(ops.sort(), ['insert', 'update']);
    const up = writesOf(h.client, 'strategies').find(w => w.op === 'update').rows[0];
    assert.equal(up.rev, 3, 'filtered on the rev last seen');
    assert.equal(up.name, 'B');
    assert.equal(stored(h.client, 'strategies', 's1').rev, 4);
    assert.equal(h.g._rowRev.strategies.s1, 4);
    assert.equal(h.g._rowRev.strategies.s2, 1);
    assert.equal(h.client.writes.some(w => w.op === 'upsert'), false, 'cloud_primary never upserts non-trade rows');
});

test('checked save: a field left out locally is not sent (cloud value kept)', async () => {
    const h = await loadedBox({ note_templates: [{ id: 'n1', name: 'N', body: 'b', is_favorite: true, timeframes: ['1d'], rev: 1 }] });
    const t = h.g.journalData.noteTemplates[0];
    t.name = 'N2';
    await h.fns._shadowWriteRowsAwaited(h.g.journalData);
    const s = stored(h.client, 'note_templates', 'n1');
    assert.equal(s.name, 'N2');
    assert.equal(s.is_favorite, true);
    assert.deepEqual(s.timeframes, ['1d']);
});

test('conflict: another device changed the row → the cloud wins, an encrypted copy is kept, banner count, pending cleared', async () => {
    const h = await loadedBox({ strategies: [{ id: 's1', name: 'A', description: '', rev: 1 }] });
    // Another device edits first.
    Object.assign(stored(h.client, 'strategies', 's1'), { description: 'from A', rev: 2 });
    h.g.journalData.strategies[0].description = 'from B';
    const res = await h.fns._saveStrategyToSupabase(h.g.journalData.strategies[0]);
    assert.equal(res.success, true);
    assert.equal(res.conflicts, 1);
    assert.equal(stored(h.client, 'strategies', 's1').description, 'from A', 'cloud not overwritten');
    assert.equal(h.g.journalData.strategies[0].description, 'from A', 'this browser shows the cloud version');
    assert.equal(h.g._cloudConflictCount, 1);
    await settle();
    await new Promise(r => setTimeout(r, 5));   // the coalesced redraw runs on a 0 ms timer
    const copies = h.settings['cloudConflicts:acct'];
    assert.equal(copies.length, 1);
    assert.equal(copies[0].key, 's1');
    assert.equal(decrypt(copies[0].local, 'dek').description, 'from B');
    assert.equal(h.g._cloudPending.strategies, undefined);
    assert.ok(h.calls.refresh >= 1, 'UI redrawn');
});

test('conflict: same content on both sides is not a conflict (rev adopted)', async () => {
    const h = await loadedBox({ tags: [{ id: 't1', name: 'A', rev: 1 }] });
    Object.assign(stored(h.client, 'tags', 't1'), { name: 'B', rev: 2 });
    h.g.journalData.tags[0].name = 'B';
    const res = await h.fns._saveTagToSupabase(h.g.journalData.tags[0]);
    assert.equal(res.success, true);
    assert.equal(h.g._cloudConflictCount, 0);
    assert.equal(h.g._rowRev.tags.t1, 2);
});

test('conflict: a row another device created first (duplicate key) → the cloud wins; same content → no conflict', async () => {
    const h = await loadedBox({});
    h.client.tables.daily_planners = [{ user_id: UID, planner_key: 'dp|1', data: { plan: 'A' }, rev: 1 },
        { user_id: UID, planner_key: 'dp|2', data: { plan: 'same' }, rev: 1 }];
    h.g.journalData.dailyPlanners = { 'dp|1': { plan: 'B' }, 'dp|2': { plan: 'same' } };
    await h.fns._shadowWriteRowsAwaited(h.g.journalData);
    assert.equal(h.g.journalData.dailyPlanners['dp|1'].plan, 'A');
    assert.equal(h.g._cloudConflictCount, 1);
    assert.equal(h.g._rowRev.dailyPlanners['dp|2'], 1);
});

test('known row with no rev (baseline from before D3): the cloud still holds what this browser saw → write over it', async () => {
    const client = fakeSupabase({ reviews: [{ user_id: UID, review_type: 'daily', review_key: 'd1', data: { t: 1 }, rev: 7 }] }, { pk: true, rev: true });
    const jd = { reviews: { 'daily|d1': { t: 1 } } };
    const h = authBox({ client, vals: { journalData: jd } });
    h.fns._setCloudBaseline(jd, true);
    jd.reviews['daily|d1'] = { t: 2 };
    await h.fns._shadowWriteRowsAwaited(jd);
    assert.deepEqual(client.tables.reviews[0].data, { t: 2 });
    assert.equal(h.g._cloudConflictCount, 0);
});

test('network failure keeps the row pending and it is retried; paused or another account writes nothing', async () => {
    const h = await loadedBox({ strategies: [{ id: 's1', name: 'A', rev: 1 }] });
    h.g.journalData.strategies[0].name = 'B';
    const realFrom = h.client.from;
    h.client.from = () => { throw new Error('Failed to fetch'); };
    const r1 = await h.fns._saveStrategyToSupabase(h.g.journalData.strategies[0]);
    assert.equal(r1.success, false);
    assert.deepEqual(h.g._cloudPending, { strategies: { s1: true } });
    h.client.from = realFrom;
    await h.fns._shadowWriteRowsAwaited(h.g.journalData);
    assert.equal(stored(h.client, 'strategies', 's1').name, 'B');
    assert.deepEqual(h.g._cloudPending, {});

    const paused = await loadedBox({ tags: [{ id: 't1', name: 'A', rev: 1 }] });
    paused.fns._enterCloudPaused('offline');
    paused.g.journalData.tags[0].name = 'B';
    await paused.fns._saveTagToSupabase(paused.g.journalData.tags[0]);
    assert.equal(paused.client.writes.length, 0);
    assert.deepEqual(paused.g._cloudPending, { tags: { t1: true } });

    const other = await loadedBox({ tags: [{ id: 't1', name: 'A', rev: 1 }] }, { sessionUid: 'someone-else' });
    other.g.journalData.tags[0].name = 'B';
    await other.fns._saveTagToSupabase(other.g.journalData.tags[0]);
    await other.fns._shadowWriteRowsAwaited(other.g.journalData);
    assert.equal(other.client.writes.length, 0);
});

test('prompt favorites go through the checked user_meta save', async () => {
    const h = await loadedBox({ user_meta: [{ key: 'aiPromptFavorites', value: '["a"]', rev: 2 }] });
    h.g.journalData.aiPromptFavorites = ['a', 'b'];
    await h.fns._saveAiPromptFavoritesToSupabase();
    const w = writesOf(h.client, 'user_meta')[0];
    assert.equal(w.op, 'update');
    assert.equal(w.rows[0].rev, 2);
    assert.equal(h.client.tables.user_meta[0].value, '["a","b"]');
});

// ── Deletes ────────────────────────────────────────────────────────────────

test('delete online: removed only where rev matches; the rev is forgotten', async () => {
    const h = await loadedBox({ tags: [{ id: 't1', name: 'A', rev: 3 }, { id: 't2', name: 'B', rev: 1 }] });
    h.g.journalData.tags = h.g.journalData.tags.filter(t => t.id !== 't1');
    const r = await h.fns._deleteTagFromSupabase('t1');
    assert.deepEqual([r.success, r.queued], [true, false]);
    const del = writesOf(h.client, 'tags').find(w => w.op === 'delete');
    assert.equal(del.rows[0].rev, 3);
    assert.deepEqual(h.client.tables.tags.map(t => t.id), ['t2']);
    assert.equal(h.g._rowRev.tags.t1, undefined);
    assert.equal(h.settings['cloudDeletes:acct'], null);
});

test('delete offline: queued and saved; the next load keeps the item out; pushed on reconnect', async () => {
    const h = await loadedBox({ strategies: [{ id: 's1', name: 'A', rev: 1 }, { id: 's2', name: 'B', rev: 1 }] });
    const realFrom = h.client.from;
    h.client.from = () => { throw new Error('Failed to fetch'); };
    h.g.journalData.strategies = h.g.journalData.strategies.filter(s => s.id !== 's1');
    const r = await h.fns._deleteStrategyFromSupabase('s1');
    assert.deepEqual([r.success, r.queued], [true, true]);
    await settle();
    assert.deepEqual(h.settings['cloudDeletes:acct'], { strategies: { s1: true } });
    // A cloud load (sign-in / re-sync) does not bring it back.
    h.client.from = realFrom;
    const cloud = await h.fns._loadJournalFromSupabaseRows(h.client, UID, { strict: true });
    const m = h.fns._mergeCloudIntoLocal(h.g.journalData, cloud, {}, h.g._cloudDeletes);
    assert.deepEqual(m.jd.strategies.map(s => s.id), ['s2']);
    // Reconnect: the next save pushes it.
    h.g.journalData.strategies[0].name = 'B2';
    await h.fns._shadowWriteRowsAwaited(h.g.journalData);
    assert.deepEqual(h.client.tables.strategies.map(s => s.id), ['s2']);
    assert.deepEqual(h.g._cloudDeletes, {});
});

test('delete vs edit: an item edited on another device after this browser deleted it is kept', async () => {
    const h = await loadedBox({ tags: [{ id: 't1', name: 'A', rev: 1 }] });
    h.g.journalData.tags = [];
    Object.assign(stored(h.client, 'tags', 't1'), { name: 'edited elsewhere', rev: 2 });
    await h.fns._deleteTagFromSupabase('t1');
    assert.equal(h.client.tables.tags.length, 1, 'not deleted');
    assert.deepEqual(h.g.journalData.tags.map(t => t.name), ['edited elsewhere'], 'restored here');
    assert.equal(h.g._cloudConflictCount, 1);
    assert.deepEqual(h.g._cloudDeletes, {});
});

test('broker account delete stays online-only and checks the session', async () => {
    const h = await loadedBox({ broker_accounts: [{ id: 'ba1', rev: 1 }] }, { sessionUid: 'someone-else' });
    const r = await h.fns._deleteBrokerAccountFromSupabase('ba1');
    assert.equal(r.success, false);
    assert.equal(h.client.tables.broker_accounts.length, 1);
});

// ── Offline edit detected after reconnect / sign-in ──────────────────────

test('offline edit: the rev seen before the edit is kept, so a change made meanwhile elsewhere is a conflict', async () => {
    const h = await loadedBox({ strategies: [{ id: 's1', name: 'X', description: '', rev: 1 }] });
    h.fns._enterCloudPaused('offline');
    h.g.journalData.strategies[0].description = 'offline B';
    await h.fns._shadowWriteRowsAwaited(h.g.journalData);  // recorded as pending
    Object.assign(stored(h.client, 'strategies', 's1'), { description: 'online A', rev: 2 });
    const r = await h.fns._cloudResync('online');
    assert.equal(r.ok, true);
    assert.equal(h.g._cloudPaused, false, 'resumed');
    assert.equal(stored(h.client, 'strategies', 's1').description, 'online A');
    assert.equal(h.g.journalData.strategies[0].description, 'online A');
    assert.equal(h.g._cloudConflictCount, 1);
});

test('pending row with no known rev (from before D3) still wins, as in D2', async () => {
    const client = fakeSupabase({ reviews: [{ user_id: UID, review_type: 'daily', review_key: 'd1', data: { t: 'cloud' }, rev: 4 }] }, { pk: true, rev: true });
    const h = authBox({ client, vals: { journalData: { reviews: { 'daily|d1': { t: 'offline' } } } },
        settings: { 'cloudPending:acct': { reviews: { 'daily|d1': true } } } });
    await h.fns._cloudFirstReload({ id: 'acct', supabaseUid: UID, storageMode: 'cloud_primary' });
    await settle();
    assert.deepEqual(client.tables.reviews[0].data, { t: 'offline' });
    assert.equal(h.g._cloudConflictCount, 0);
});

test('re-sync: an unsent (debounced) local change is kept and sent, a failed load changes nothing', async () => {
    const h = await loadedBox({ tags: [{ id: 't1', name: 'A', rev: 1 }] });
    h.g._lastShadowWriteMs = Date.now();   // inside the 10 s debounce
    h.g.journalData.tags.push({ id: 't9', name: 'just made' });
    h.fns._shadowWriteRows(h.g.journalData);
    assert.equal(h.client.writes.length, 0);
    const r = await h.fns._cloudResync('visible');
    assert.equal(r.ok, true);
    assert.deepEqual(h.g.journalData.tags.map(t => t.id).sort(), ['t1', 't9']);
    assert.ok(stored(h.client, 'tags', 't9'));

    const f = await loadedBox({ tags: [{ id: 't1', name: 'A', rev: 1 }] });
    const before = f.g.journalData;
    f.client.from = () => ({ select: () => ({ eq: () => ({ range: async () => ({ data: null, error: { message: 'down' } }) }) }) });
    const r2 = await f.fns._cloudResync('online');
    assert.equal(r2.ok, false);
    assert.equal(f.g.journalData, before);
});

test('re-sync: listeners for "online" and tab-visible after 5 minutes are installed', () => {
    assert.match(AUTH, /window\.addEventListener\('online', function \(\) \{ _cloudResync\('online'\); \}\);/);
    assert.match(AUTH, /visibilitychange[\s\S]{0,200}_CLOUD_RESYNC_IDLE_MS/);
    assert.match(AUTH, /var _CLOUD_RESYNC_IDLE_MS = 5 \* 60 \* 1000;/);
});

// ── journal_backups ────────────────────────────────────────────────────────

test('journal_backups: cloud_primary never restores the blob at sign-in', async () => {
    let fetched = 0;
    const h = authBox({ vals: { db: {}, getJournalRecord: async () => null, _fetchJournalFromCloud: async () => { fetched++; return null; } } });
    assert.equal(await h.fns.loadFromIndexedDB({ skipCloudBlob: true }), false);
    assert.equal(fetched, 0);
    await h.fns.loadFromIndexedDB();
    assert.equal(fetched, 1, 'other modes unchanged');
    assert.match(AUTH, /loadFromIndexedDB\(\{ skipCloudBlob: _resolveStorageMode\(auth\) === 'cloud_primary' \}\)/);
});

// ── Gemini key ─────────────────────────────────────────────────────────────

function geminiBox(cloudRows, over) {
    over = over || {};
    const client = fakeSupabase({ user_settings: cloudRows || [] }, { rev: true });
    const settings = Object.assign({}, over.settings);
    const conflicts = [];
    const win = {
        encrypt, decrypt,
        setAppSetting: async (k, v) => { settings[k] = v; },
        getAppSetting: async k => settings[k],
        deleteAppSetting: async k => { delete settings[k]; },
        _sessionMatchesAccount: uid => uid === UID,
        _recordCloudConflict: (...a) => conflicts.push(a),
    };
    const SupabaseAuth = { isReady: () => true, getClient: () => client,
        supabaseGetSession: async () => ({ data: { user: { id: over.sessionUid || UID } } }) };
    new Function('window', 'SupabaseAuth', 'sessionDek', 'sessionPassword', 'currentAccountId', 'localStorage', GEMINI)(
        win, SupabaseAuth, 'dek', 'pw', over.acct || 'acct', { getItem: () => null, removeItem() {} });
    return { api: win._DenAriiAIGemini, client, settings, conflicts };
}

test('gemini: the cache is per account; the old device-wide copy moves only when it decrypts for this account', async () => {
    const mine = geminiBox([], { settings: { 'gemini-api-key': encrypt('KEY1', 'dek') } });
    await mine.api.loadApiKey();
    assert.equal(mine.api.hasUserKey(), true);
    assert.equal(mine.settings['gemini-api-key:acct'], encrypt('KEY1', 'dek'));
    assert.equal(mine.settings['gemini-api-key'], undefined);
    const other = geminiBox([], { settings: { 'gemini-api-key': encrypt('KEY1', 'other-dek') } });
    await other.api.loadApiKey();
    assert.equal(other.api.hasUserKey(), false);
    assert.ok(other.settings['gemini-api-key'], 'another account\'s copy is left alone');
});

test('gemini: load reads the cloud first; save updates where rev matches; a change elsewhere wins', async () => {
    const g = geminiBox([{ user_id: UID, gemini_key_encrypted: encrypt('CLOUD', 'dek'), rev: 3 }],
        { settings: { 'gemini-api-key:acct': encrypt('STALE', 'dek') } });
    await g.api.loadApiKey();
    assert.equal(g.settings['gemini-api-key:acct'], encrypt('CLOUD', 'dek'));
    await g.api.saveApiKey('NEW');
    await settle();
    const up = g.client.writes.find(w => w.op === 'update');
    assert.equal(up.rows[0].rev, 3);
    assert.equal(g.client.tables.user_settings[0].gemini_key_encrypted, encrypt('NEW', 'dek'));
    // Another device changes it; this browser's next save loses.
    Object.assign(g.client.tables.user_settings[0], { gemini_key_encrypted: encrypt('OTHER', 'dek'), rev: 9 });
    await g.api.saveApiKey('MINE');
    await settle();
    assert.equal(g.client.tables.user_settings[0].gemini_key_encrypted, encrypt('OTHER', 'dek'));
    assert.equal(g.settings['gemini-api-key:acct'], encrypt('OTHER', 'dek'));
    assert.equal(g.conflicts.length, 1);
});

test('gemini: nothing is written with another account\'s session', async () => {
    const g = geminiBox([], { sessionUid: 'someone-else' });
    await g.api.saveApiKey('K');
    await settle();
    assert.equal(g.client.writes.length, 0);
});

// ── Drafts ─────────────────────────────────────────────────────────────────

function autosaveBox(key) {
    const store = {};
    const ls = { setItem: (k, v) => { store[k] = v; }, getItem: k => (k in store ? store[k] : null), removeItem: k => { delete store[k]; } };
    const win = {};
    new Function('window', 'localStorage', 'encrypt', 'decrypt', 'sessionDek', 'sessionPassword', 'document', AUTOSAVE)(
        win, ls, encrypt, decrypt, key, null, {});
    return { A: win.Autosave, store };
}

test('drafts: saved encrypted (only the timestamp readable); old plain drafts still load; another account\'s draft is null', () => {
    const a = autosaveBox('dek');
    a.A.save('new-trade-draft', { core: { symbol: 'AAPL' } });
    assert.equal(a.store['new-trade-draft'].includes('AAPL'), true, 'fake cipher is readable in tests');
    const raw = JSON.parse(a.store['new-trade-draft']);
    assert.deepEqual(Object.keys(raw).sort(), ['enc', 'ts']);
    assert.equal(a.A.load('new-trade-draft').core.symbol, 'AAPL');
    assert.equal(typeof a.A.load('new-trade-draft').ts, 'number');
    a.store['rv-draft-x'] = JSON.stringify({ content: 'old', ts: 5 });
    assert.equal(a.A.load('rv-draft-x').content, 'old');
    const b = autosaveBox('other-dek');
    b.store['new-trade-draft'] = a.store['new-trade-draft'];
    assert.equal(b.A.load('new-trade-draft'), null);
});

test('drafts: lock / account delete also clear review drafts', () => {
    assert.match(APP, /k\.indexOf\('rv-draft-'\) === 0/);
});

// ── The four bugs ──────────────────────────────────────────────────────────

test('bug: new account — the Dashboard is refreshed after the demo trades reach the cloud', async () => {
    const calls = { dash: 0, refresh: 0 };
    const auth = { id: 'acct', username: 'u', supabaseUid: UID, storageMode: 'cloud_primary' };
    const box = sandbox([[APP, ['unlockApp']], [AUTH, ['_resolveStorageMode']]], {
        window: { migrateBrokerAccounts: () => false, populateBrokerAccountDropdowns() {}, renderBrokerAccountsList() {}, _denariiStorageMode: 'cloud_primary' },
        journalData: { version: 3, trades: [], strategies: [], brokerAccounts: [] },
        getAuthRecord: async () => auth,
        DEMO_BROKER_ID: DEMO, DEMO_BROKER_DATA_VERSION: 7, sessionDek: 'dek', sessionPassword: 'pw',
        CURRENT_SCHEMA_VERSION: 3, SCHEMA_MIGRATIONS: {},
        ensureDemoStrategiesExist: () => false, backfillStrategiesFromExistingTrades: () => false,
        ensureStarterTags: () => false, migrateNotesFields: () => false, seedSystemTemplates: () => false,
        _importFromDemoBundle: d => { d.brokerAccounts.push({ id: DEMO }); d.trades.push({ id: 'd1', brokerAccountId: DEMO }); d._demoImportVersion = 7; return true; },
        _saveTradesToSupabase: async () => ({ success: true, error: null }),
        _triggerCloudDashRefresh: () => { calls.refresh++; },
        updateDashboard: () => { calls.dash++; },
        saveToIndexedDB: async () => {}, alert: () => {}, _runCloudMigration: undefined, _startBackfillIfNeeded: undefined,
        setTimeout: () => 0,
    });
    await box.fns.unlockApp();
    await settle();
    assert.equal(calls.refresh, 1);
    assert.ok(calls.dash >= 2, 'once at unlock, again after the upload');
});

test('bug: cloud-first kept demo trades also refresh the Dashboard after saving', async () => {
    const h = authBox({ vals: { journalData: { brokerAccounts: [{ id: DEMO }], trades: [{ id: 1, brokerAccountId: DEMO }] } },
        client: fakeSupabase({ broker_accounts: [{ id: DEMO, rev: 1 }] }, { pk: true, rev: true }) });
    await h.fns._cloudFirstReload({ id: 'acct', supabaseUid: UID, storageMode: 'cloud_primary' });
    await settle();
    assert.deepEqual(h.calls.demoSaves.map(ts => ts.map(t => t.id)), [[1]]);
    assert.ok(h.calls.dash >= 1);
});

test('bug: Duplicate / Edit / favorite work when strategy ids came back from the cloud as strings', () => {
    const jd = { strategies: [{ id: '1000001', name: 'Support Bounce', groups: [{ id: 1, rules: [{ id: 2 }] }], createdBy: 'System', isDemoSeed: true }] };
    const saved = [];
    const box = sandbox([[APP, ['duplicateStrategy', 'toggleStrategyFavorite']]], {
        journalData: jd, currentUsername: 'me',
        normalizeStrategyName: n => String(n || '').trim(),
        _isCloudPrimarySave: () => true, _saveStrategyToSupabase: s => saved.push(s.name),
        saveToIndexedDB() {}, updateStrategiesList() {}, updateStrategyDropdown() {},
    });
    box.fns.duplicateStrategy(1000001);     // the button passes a number
    assert.deepEqual(jd.strategies.map(s => s.name), ['Support Bounce', 'Support Bounce (Copy)']);
    assert.deepEqual(saved, ['Support Bounce (Copy)']);
    box.fns.toggleStrategyFavorite(1000001);
    assert.equal(jd.strategies[0].isFavorite, true);
    assert.match(extractFunction(APP, 'editStrategy'), /String\(s\.id\) === String\(id\)/);
    assert.match(extractFunction(AUTH, '_applyStrategyDeleteToLocal'), /String\(s\.id\) !== String\(strategyId\)/);
});

test('bug: offline, paused or after a failed page fetch the Dashboard uses this browser\'s trades', () => {
    const make = (vals) => sandbox([[APP, ['_cloudDashActive']]], Object.assign({
        window: { _denariiStorageMode: 'cloud_primary' }, SupabaseAuth: { isReady: () => true },
        _cloudPaused: false, navigator: { onLine: true }, _cloudDash: { failed: false },
    }, vals)).fns._cloudDashActive();
    assert.equal(make({}), true);
    assert.equal(make({ _cloudPaused: true }), false);
    assert.equal(make({ navigator: { onLine: false } }), false);
    assert.equal(make({ _cloudDash: { failed: true } }), false);
    assert.match(APP, /console\.warn\('\[CloudDash\] Page fetch failed — rendering from cache\.'\);\s*_cloudDash\.failed = true;/);
});

test('bug: account delete signs out of this browser only (scope local)', async () => {
    const scopes = [];
    const h = authBox({ vals: {
        SupabaseAuth: { isReady: () => true, supabaseGetSession: async () => ({ data: { access_token: 't', user: { id: UID } } }),
            supabaseSignOut: () => { throw new Error('global sign-out used'); },
            getClient: () => ({ auth: { signOut: o => { scopes.push(o); return Promise.resolve({ error: null }); } } }) },
        fetch: async () => ({ ok: true, json: async () => ({}) }),
    } });
    await h.fns._deleteSupabaseAccount(UID);
    assert.deepEqual(scopes, [{ scope: 'local' }]);
    assert.doesNotMatch(SETTINGS, /SupabaseAuth\.supabaseSignOut\(\)/);
    assert.match(SETTINGS, /signOut\(\{ scope: 'local' \}\)/);
});

// ── Dashboard prefs ────────────────────────────────────────────────────────

test('dashboard prefs: loaded from the account (dashPrefs) first, the device settings only as fallback; saving updates dashPrefs', async () => {
    const settings = { dashVisibleCols: ['symbol'], dashDefaultView: 'trades', dashLastView: 'calendar' };
    const vals = {
        journalData: { dashPrefs: { visibleCols: ['symbol', 'pnl'], defaultView: 'weekview', rememberLastView: true } },
        getSetting: async k => settings[k], setSetting: async (k, v) => { settings[k] = v; },
        saveToIndexedDB() { vals.saved = (vals.saved || 0) + 1; },
        _DASH_COLUMNS: [{ key: 'actions', locked: true }],
        _dashVisibleCols: new Set(), _dashDefaultView: 'trades', _dashRememberLastView: false, _dashLastView: 'trades', _dashViewPrefsLoaded: false,
    };
    const box = sandbox([[APP, ['_loadDashColPrefs', '_dashSaveColPrefs', '_dashSaveSyncedPrefs']]], vals);
    await box.fns._loadDashColPrefs();
    assert.deepEqual([...box.g._dashVisibleCols].sort(), ['actions', 'pnl', 'symbol']);
    assert.equal(box.g._dashDefaultView, 'weekview');
    assert.equal(box.g._dashRememberLastView, true);
    assert.equal(box.g._dashLastView, 'calendar', 'last view stays per device');
    box.g._dashVisibleCols = new Set(['symbol']);
    box.fns._dashSaveColPrefs();
    assert.deepEqual(box.g.journalData.dashPrefs.visibleCols, ['symbol']);
    assert.equal(box.g.journalData.dashPrefs.defaultView, 'weekview', 'other prefs kept');
});

// ── Pelosi ─────────────────────────────────────────────────────────────────

test('deleted Pelosi stays deleted after sign-out / sign-in: the dismissed flag and the broker delete come back from the cloud', async () => {
    const local = { brokerAccounts: [{ id: DEMO }], trades: [{ id: 1, brokerAccountId: DEMO }], _demoImportDismissed: false };
    const client = fakeSupabase({ broker_accounts: [], trades: [], user_meta: [{ key: '_demoImportDismissed', value: 'true', rev: 2 }] }, { pk: true, rev: true });
    const h = authBox({ client, vals: { journalData: local } });
    await h.fns._cloudFirstReload({ id: 'acct', supabaseUid: UID, storageMode: 'cloud_primary' });
    await settle();
    assert.deepEqual(h.g.journalData.brokerAccounts, []);
    assert.deepEqual(h.g.journalData.trades, []);
    assert.equal(h.g.journalData._demoImportDismissed, true);
    assert.equal(h.calls.demoSaves.length, 0);
    assert.equal(client.writes.length, 0, 'nothing re-sent');
});

// ── DenariiCloudCheck ──────────────────────────────────────────────────────

const META_KEYS = new Function(extractVar(AUTH, /var _USER_META_KEYS = \[[\s\S]*?\];/, '_USER_META_KEYS') + '\nreturn _USER_META_KEYS;')();

function checkBox(tables, jd, over) {
    over = over || {};
    const client = fakeSupabase(clone(tables), { rev: true });
    const realFrom = client.from;
    const writeCalls = [];
    client.from = t => {
        const b = realFrom(t);
        for (const op of ['insert', 'update', 'delete', 'upsert']) b[op] = () => { writeCalls.push(op); throw new Error('write in check'); };
        return b;
    };
    const fnBox = authBox({ client, vals: { journalData: jd } });
    const logs = [];
    const win = Object.assign({}, fnBox.fns, {
        _denariiStorageMode: 'cloud_primary',
        getAppSetting: async k => (over.settings || {})[k],
    });
    const consoleStub = { log: (...a) => logs.push(a.join(' ')), warn: (...a) => logs.push(a.join(' ')), table() {} };
    const SupabaseAuth = { isReady: () => true, getClient: () => client, supabaseGetSession: async () => ({ data: { user: { id: UID } } }) };
    const names = Object.keys(fnBox.fns);
    new Function('window', 'SupabaseAuth', 'journalData', 'currentAccountId', 'console', '_cloudPending', '_cloudDeletes',
        '_cloudBaselineReady', '_cloudPaused', '_USER_META_KEYS', 'decrypt', 'sessionDek', ...names, CHECK)(
        win, SupabaseAuth, jd, 'acct', consoleStub, over.pending || {}, {}, true, false, META_KEYS,
        decrypt, 'dek', ...names.map(n => fnBox.fns[n]));
    return { check: win.DenariiCloudCheck, logs, writeCalls };
}

test('DenariiCloudCheck: PASS when this browser matches the cloud; read-only', async () => {
    const tables = { strategies: [{ id: 's1', name: 'S', rev: 1 }], reviews: [{ review_type: 'daily', review_key: 'd1', data: { t: 1 }, rev: 1 }],
        user_meta: [{ key: 'tagCategories', value: '["A"]', rev: 1 }] };
    const h = authBox({ client: fakeSupabase(clone(tables)) });
    const jd = await h.fns._loadJournalFromSupabaseRows(h.client, UID, { strict: true });
    const c = checkBox(tables, jd);
    const r = await c.check.run();
    assert.equal(r.ok, true, c.logs.join('\n'));
    assert.ok(c.logs.some(l => /^PASS {2}strategies/.test(l)));
    assert.ok(c.logs.some(l => /^PASS {2}user_meta\.tagCategories/.test(l)));
    assert.ok(c.logs.some(l => /SUMMARY/.test(l)));
    assert.deepEqual(c.writeCalls, []);
});

test('DenariiCloudCheck: FAIL lines for local-only, differing and pending rows', async () => {
    const tables = { strategies: [{ id: 's1', name: 'S', rev: 1 }], tags: [{ id: 't1', name: 'T', rev: 1 }] };
    const jd = { strategies: [{ id: 's1', name: 'changed' }], tags: [{ id: 't1', name: 'T', category: '', description: '' }, { id: 't2', name: 'only here' }] };
    const c = checkBox(tables, jd, { pending: { strategies: { s1: true } } });
    const r = await c.check.run();
    assert.equal(r.ok, false);
    assert.ok(c.logs.some(l => /^FAIL {2}strategies .*differ 1.*pending 1/.test(l)), c.logs.join('\n'));
    assert.ok(c.logs.some(l => /^FAIL {2}tags .*local-only 1/.test(l)), c.logs.join('\n'));
    assert.deepEqual(c.writeCalls, []);
});

// An open Webull trade: contractName "" and grossPnl null locally are written
// as NULL; the cloud's NULLs are left out by the trade mapper. Same data.
const OPEN_TRADE = {
    id: 1793136893815, symbol: 'CAI', direction: 'long', type: 'long', quantity: 590, entryPrice: 32.94,
    exitPrice: null, pnl: null, source: 'webull', feeSource: 'actual', notes: '', strategy: '',
    contractName: '', grossPnl: null, tags: [],
};
const openTradeCloudRow = over => Object.assign({
    user_id: UID, id: 1793136893815, symbol: 'CAI', direction: 'long', quantity: 590, entry_price: 32.94,
    exit_price: null, pnl: null, source: 'webull', fee_source: 'actual', notes: '', strategy: '', tags: [],
    contract_name: null, gross_pnl: null,
}, over);

test('DenariiCloudCheck: trade with contract_name / gross_pnl null locally and NULL in the cloud is not a difference', async () => {
    const c = checkBox({ trades: [openTradeCloudRow()] }, { trades: [clone(OPEN_TRADE)] });
    await c.check.run();
    const line = c.logs.find(l => /trades/.test(l) && /local 1/.test(l));
    assert.ok(line && /^PASS/.test(line) && !/differ/.test(line), c.logs.join('\n'));
    assert.deepEqual(c.writeCalls, []);
});

test('DenariiCloudCheck: a real cloud value that differs is still reported', async () => {
    for (const over of [{ gross_pnl: 125.5 }, { contract_name: 'CAI 260116C35' }, { quantity: 600 }]) {
        const c = checkBox({ trades: [openTradeCloudRow(over)] }, { trades: [clone(OPEN_TRADE)] });
        await c.check.run();
        assert.ok(c.logs.some(l => /^FAIL {2}trades .*differ 1/.test(l)), JSON.stringify(over) + '\n' + c.logs.join('\n'));
    }
});
