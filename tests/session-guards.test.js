// Session guards: a cloud journal must never act as connected without this
// account's Supabase session.
// 1. createNewJournal: a repeat sign-up (no session, no identities) stops
//    before any local account is made.
// 3. Broker save: a queued or failed cloud save is labelled browser-only.
// 4. unlockApp: no Pelosi seed for an account with its own broker accounts,
//    or for cloud_primary without a cloud load this session.
// 5. Account delete and the Pelosi cloud cleanup refuse another account's
//    session (or none) and send nothing.
// 6. A session that ends or switches while unlocked pauses cloud writes
//    (unsent changes kept pending) and shows the banner; subscribed once.
// 7. Skipped shadow writes (debounced, superseded, no session, wrong
//    session) keep their rows on the pending list.
//
// Same harness as batch-d3.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const AUTH = read('js/auth.js');
const APP = read('Denarii.js');
const DEMO_SEED = read('js/demoSeed.js');
const BA = read('js/pages/broker-accounts.js');
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
async function settle(n) { for (let i = 0; i < (n || 40); i++) await tick(); }
const UID = 'u1';
const DEMO = 'ba_demo_pelosi';
const SESSION_ENDED = 'cloud session ended';

const AUTH_FNS = [
    '_loadJournalFromSupabaseRows', '_fetchAllRows', '_mapSupabaseTradeRow', '_resolveStorageMode',
    '_mapArrayRow', '_mapReviewRows', '_mapPlannerRows', '_mapUserMetaRows', '_toISOOrNull', '_groupRowsByKeySet',
    '_shadowSkipTrades', '_shadowWriteRowsAwaited', '_shadowWriteRows', '_executeShadowWrite', '_keepSkippedShadowRows',
    '_detectDirtyDomains', '_updateDomainSnapshots',
    '_withTimeout', '_cloudWriteAllowed', '_sessionMatchesAccount', '_mapDomainRows', '_rowKey', '_rowSig',
    '_changedRows', '_markRows', '_savePendingRows', '_loadPendingRows', '_recordPendingRows', '_setCloudBaseline',
    '_enterCloudPaused', '_ensureCloudSessionState', '_watchCloudSession', '_onCloudSessionLost',
    '_showCloudLoadBanner', '_deleteSupabaseAccount', 'deleteAccount',
    ...D3.D3_FNS,
];
const AUTH_VARS = [
    extractVar(AUTH, /var _SHADOW_DOMAINS = \{[\s\S]*?\n\};/, '_SHADOW_DOMAINS'),
    extractVar(AUTH, /var _USER_META_KEYS = \[[\s\S]*?\];/, '_USER_META_KEYS'),
    extractVar(AUTH, /var _CLOUD_ARRAY_DOMAINS = \[[^\]]*\];/, '_CLOUD_ARRAY_DOMAINS'),
    extractVar(AUTH, /var _CLOUD_KEYED_DOMAINS = \[[^\]]*\];/, '_CLOUD_KEYED_DOMAINS'),
    extractVar(AUTH, /var _CLOUD_SESSION_ENDED = [^\n]*;/, '_CLOUD_SESSION_ENDED'),
    "var _DEMO_BROKER_ID = 'ba_demo_pelosi';",
    'var _SB_PAGE_SIZE = 1000;',
    D3.d3Vars(AUTH),
].join('\n');

// A document that records the banner.
function fakeDocument() {
    const els = {};
    const doc = {
        body: { appendChild: el => { if (el.id) els[el.id] = el; } },
        getElementById: id => els[id] || null,
        createElement: () => {
            const el = { style: {}, children: [], setAttribute() {}, addEventListener() {},
                appendChild(c) { el.children.push(c); }, remove() { if (el.id) delete els[el.id]; } };
            return el;
        },
    };
    return { doc, els };
}

function authBox(over) {
    over = over || {};
    const settings = {};
    const calls = { fetch: 0, storeDeletes: [] };
    const client = over.client || fakeSupabase({}, { pk: true, rev: true });
    const win = Object.assign({ _denariiStorageMode: 'cloud_primary', _denariiSupabaseUid: UID }, over.window);
    const sessionUid = 'sessionUid' in over ? over.sessionUid : UID;
    const vals = Object.assign({
        window: win,
        SupabaseAuth: {
            isReady: () => true, getClient: () => client,
            supabaseGetSession: async () => ({ data: sessionUid ? { access_token: 't', user: { id: sessionUid } } : null }),
        },
        journalData: {},
        sessionDek: 'dek', sessionPassword: 'pw',
        currentAccountId: 'acct',
        _cloudSignInFailed: false, _cloudBaselineReady: false, _cloudPaused: false,
        _rowBaseline: {}, _cloudPending: {}, _cloudLoadStatus: null, _domainSnapshots: {},
        _cloudSessionWatchOn: false,
        _CLOUD_LOAD_TIMEOUT_MS: 20000,
        _lastShadowWriteMs: 0, _shadowWriteRunning: false, _shadowWritePending: false,
        ...D3.d3State(),
        getSetting: async k => settings[k],
        setSetting: async (k, v) => { settings[k] = v; },
        fetch: async () => { calls.fetch++; return { ok: true, json: async () => ({}) }; },
        storeGet: async () => ({ id: 'acct', supabaseUid: UID }),
        storeDelete: async (store, key) => { calls.storeDeletes.push(key); },
        navigator: { onLine: true },
        document: { getElementById: () => null, body: null },
    }, over.vals);
    const box = sandbox([[AUTH, AUTH_FNS]], vals, AUTH_VARS);
    return Object.assign(box, { client, settings, calls });
}

// Unlocked with a cloud baseline holding one broker account.
function loadedBox(over) {
    const h = authBox(over);
    h.g.journalData = { version: 3, brokerAccounts: [{ id: 'ba_1', broker: 'Webull', displayName: 'Mine' }] };
    h.fns._setCloudBaseline(h.g.journalData, true);
    return h;
}

// ── 5. Account delete and demo cleanup ─────────────────────────────────────

const WRONG_ACCOUNT = { message: 'Can\'t delete: this browser is signed in to a different cloud account.' };

test('delete: another account\'s session is refused and the API is never called', async () => {
    const h = authBox({ sessionUid: 'owner' });
    await assert.rejects(h.fns._deleteSupabaseAccount(UID), WRONG_ACCOUNT);
    assert.equal(h.calls.fetch, 0);
});

test('delete: no session, or no expected account, is refused and the API is never called', async () => {
    const none = authBox({ sessionUid: null });
    await assert.rejects(none.fns._deleteSupabaseAccount(UID), WRONG_ACCOUNT);
    const noUid = authBox();
    await assert.rejects(noUid.fns._deleteSupabaseAccount(), WRONG_ACCOUNT);
    assert.equal(none.calls.fetch + noUid.calls.fetch, 0);
});

test('delete: the matching session reaches the API', async () => {
    const h = authBox();
    await h.fns._deleteSupabaseAccount(UID);
    assert.equal(h.calls.fetch, 1);
});

test('deleteAccount: a mismatched session keeps the local account and sends nothing', async () => {
    const h = authBox({ sessionUid: 'owner' });
    await assert.rejects(h.fns.deleteAccount('acct', 'jason'), WRONG_ACCOUNT);
    assert.deepEqual(h.calls.storeDeletes, []);
    assert.equal(h.calls.fetch, 0);
});

function cleanupBox(sessionUid, matches) {
    const froms = [];
    const chain = { delete: () => chain, eq: () => chain, like: () => chain, in: () => chain,
        then: (res) => Promise.resolve({ error: null }).then(res) };
    const box = sandbox([[DEMO_SEED, ['_cleanupDemoRowsFromSupabase']]], {
        DEMO_BROKER_ID: DEMO,
        SupabaseAuth: {
            isReady: () => true,
            getClient: () => ({ from: t => { froms.push(t); return chain; } }),
            supabaseGetSession: () => Promise.resolve({ data: { user: { id: sessionUid } } }),
        },
        _sessionMatchesAccount: uid => matches && uid === UID,
    });
    return { box, froms };
}

test('demo cleanup: another account\'s session deletes nothing', async () => {
    const { box, froms } = cleanupBox('owner', false);
    box.fns._cleanupDemoRowsFromSupabase();
    await settle();
    assert.deepEqual(froms, []);
});

test('demo cleanup: this account\'s session still removes the demo rows', async () => {
    const { box, froms } = cleanupBox(UID, true);
    box.fns._cleanupDemoRowsFromSupabase();
    await settle();
    assert.deepEqual(froms.sort(), ['broker_accounts', 'strategies', 'tags', 'trades']);
});

// ── 7. Skipped shadow writes stay pending ──────────────────────────────────

test('debounced shadow write: the changed rows go on the pending list (and are saved)', async () => {
    const h = loadedBox();
    h.g._lastShadowWriteMs = Date.now();
    h.g.journalData.brokerAccounts[0].displayName = 'Renamed';
    h.fns._shadowWriteRows(h.g.journalData);
    await settle();
    assert.deepEqual(h.g._cloudPending.brokerAccounts, { ba_1: true });
    assert.deepEqual(h.settings['cloudPending:acct'], { brokerAccounts: { ba_1: true } });
    assert.equal(h.client.writes.length, 0);
});

test('superseded shadow write (one already running): the changed rows stay pending', () => {
    const h = loadedBox();
    h.g._shadowWriteRunning = true;
    h.g.journalData.brokerAccounts[0].displayName = 'Renamed';
    h.fns._shadowWriteRows(h.g.journalData);
    assert.equal(h.g._shadowWritePending, true);
    assert.deepEqual(h.g._cloudPending.brokerAccounts, { ba_1: true });
});

test('shadow write with no session, or another account\'s session: rows pending, nothing written', async () => {
    for (const sessionUid of [null, 'owner']) {
        const h = loadedBox({ sessionUid });
        h.g.journalData.brokerAccounts.push({ id: 'ba_2', broker: 'Webull', displayName: 'New' });
        h.fns._shadowWriteRows(h.g.journalData);
        await settle();
        assert.deepEqual(h.g._cloudPending.brokerAccounts, { ba_2: true }, String(sessionUid));
        assert.equal(h.client.writes.length, 0);
    }
});

test('a sent row clears its pending mark', async () => {
    const h = loadedBox();
    h.g._lastShadowWriteMs = Date.now();
    h.g.journalData.brokerAccounts.push({ id: 'ba_2', broker: 'Webull', displayName: 'New' });
    h.fns._shadowWriteRows(h.g.journalData);
    assert.deepEqual(h.g._cloudPending.brokerAccounts, { ba_2: true });
    h.g._lastShadowWriteMs = 0;
    h.fns._shadowWriteRows(h.g.journalData);
    await settle();
    assert.equal(h.g._cloudPending.brokerAccounts, undefined);
    assert.ok(h.client.writes.length > 0);
});

test('other storage modes keep no pending list when a write is skipped', () => {
    const h = loadedBox({ window: { _denariiStorageMode: 'local_legacy' } });
    h.g._lastShadowWriteMs = Date.now();
    h.g.journalData.brokerAccounts[0].displayName = 'Renamed';
    h.fns._shadowWriteRows(h.g.journalData);
    assert.deepEqual(h.g._cloudPending, {});
});

// ── 6. Session loss while unlocked ─────────────────────────────────────────

function watchBox(over) {
    const subs = [];
    const { doc, els } = fakeDocument();
    const client = Object.assign(fakeSupabase({}, { pk: true, rev: true }),
        { auth: { onAuthStateChange: cb => { subs.push(cb); return { data: { subscription: {} } }; } } });
    const h = loadedBox(Object.assign({ client, vals: { document: doc } }, over));
    return Object.assign(h, { subs, els });
}

test('watch: subscribes once, however many times the journal is unlocked', () => {
    const h = watchBox();
    h.fns._watchCloudSession();
    h.fns._watchCloudSession();
    assert.equal(h.subs.length, 1);
});

test('watch: SIGNED_OUT pauses cloud writes, keeps unsent changes pending, and shows the sign-in banner', () => {
    const h = watchBox();
    h.fns._watchCloudSession();
    h.g.journalData.brokerAccounts[0].displayName = 'Not sent yet';
    h.subs[0]('SIGNED_OUT', null);
    assert.equal(h.g._cloudPaused, true);
    assert.equal(h.fns._cloudWriteAllowed(), false);
    assert.equal(h.g._cloudLoadStatus.reason, SESSION_ENDED);
    assert.deepEqual(h.g._cloudPending.brokerAccounts, { ba_1: true });
    const banner = h.els['cloud-load-banner'];
    assert.ok(banner, 'banner shown');
    assert.match(banner.children[0].textContent, /signed out of the cloud[\s\S]*sign in again/);
});

test('watch: a session for another account also pauses', () => {
    const h = watchBox();
    h.fns._watchCloudSession();
    h.subs[0]('SIGNED_IN', { user: { id: 'owner' } });
    assert.equal(h.g._cloudPaused, true);
});

test('watch: this account\'s own refresh or initial session changes nothing', () => {
    const h = watchBox();
    h.fns._watchCloudSession();
    h.subs[0]('INITIAL_SESSION', { user: { id: UID } });
    h.subs[0]('TOKEN_REFRESHED', { user: { id: UID } });
    assert.equal(h.g._cloudPaused, false);
    assert.equal(h.els['cloud-load-banner'], undefined);
});

test('watch: the lock\'s own sign-out (session keys already cleared) is ignored', () => {
    const h = watchBox();
    h.fns._watchCloudSession();
    h.g.sessionDek = null;
    h.g.sessionPassword = null;
    h.subs[0]('SIGNED_OUT', null);
    assert.equal(h.g._cloudPaused, false);
});

test('watch: other storage modes are never paused', () => {
    const h = watchBox({ window: { _denariiStorageMode: 'local_legacy' } });
    h.fns._watchCloudSession();
    h.subs[0]('SIGNED_OUT', null);
    assert.equal(h.g._cloudPaused, false);
});

test('watch: unlockApp starts the session watch', () => {
    assert.match(extractFunction(APP, 'unlockApp'), /_watchCloudSession\(\)/);
});

// ── 4. Demo seed guard ─────────────────────────────────────────────────────

function unlockBox(jd, mode, cloudReady) {
    const calls = { demoSaves: [], saves: 0, imports: 0 };
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
        _cloudWriteAllowed: () => cloudReady,
        _importFromDemoBundle: d => {
            calls.imports++;
            d.brokerAccounts.push({ id: DEMO });
            d.trades.push({ id: 'd1', brokerAccountId: DEMO });
            d._demoImportVersion = 7;
            return true;
        },
        _saveTradesToSupabase: async t => { calls.demoSaves.push(t.map(x => x.id)); return { success: true, error: null }; },
        saveToIndexedDB: async () => { calls.saves++; },
        alert: () => {},
        _runCloudMigration: undefined,
        _startBackfillIfNeeded: undefined,
        setTimeout: () => 0,
    });
    return Object.assign(box, { calls });
}

test('seed guard: an account with its own broker account is marked dismissed and never seeded', async () => {
    const h = unlockBox({ version: 3, trades: [], strategies: [], brokerAccounts: [{ id: 'ba_1', broker: 'Webull' }] }, 'cloud_primary', true);
    await h.fns.unlockApp();
    await settle();
    assert.equal(h.calls.imports, 0);
    assert.equal(h.g.journalData._demoImportDismissed, true);
    assert.deepEqual(h.g.journalData.brokerAccounts.map(a => a.id), ['ba_1']);
    assert.deepEqual(h.calls.demoSaves, []);
    assert.equal(h.calls.saves, 1, 'the dismissed flag is saved');
});

test('seed guard: cloud_primary without a cloud load this session does not seed or set flags', async () => {
    const h = unlockBox({ version: 3, trades: [], strategies: [], brokerAccounts: [] }, 'cloud_primary', false);
    await h.fns.unlockApp();
    await settle();
    assert.equal(h.calls.imports, 0);
    assert.equal(h.g.journalData._demoImportDismissed, undefined);
    assert.deepEqual(h.g.journalData.brokerAccounts, []);
    assert.deepEqual(h.calls.demoSaves, []);
});

test('seed guard: a truly new cloud_primary account with a cloud baseline still gets Pelosi', async () => {
    const h = unlockBox({ version: 3, trades: [], strategies: [], brokerAccounts: [] }, 'cloud_primary', true);
    await h.fns.unlockApp();
    await settle();
    assert.equal(h.calls.imports, 1);
    assert.deepEqual(h.calls.demoSaves, [['d1']]);
});

test('seed guard: local accounts are not affected by the cloud check', async () => {
    const h = unlockBox({ version: 3, trades: [], strategies: [], brokerAccounts: [] }, 'local_legacy', false);
    await h.fns.unlockApp();
    await settle();
    assert.equal(h.calls.imports, 1);
});

// ── 1. Repeat sign-up ──────────────────────────────────────────────────────

function signUpBox(signUpData) {
    const calls = { errors: [], saved: [], indexed: 0 };
    const fields = {
        'reg-username': { value: 'jason' }, 'reg-password': { value: 'password123' }, 'reg-confirm': { value: 'password123' },
        'reg-legal-accept': { checked: true }, 'reg-email': { value: 'jason@example.com' },
    };
    const el = id => fields[id] || (fields[id] = { value: '', style: {}, textContent: '' });
    const box = sandbox([[AUTH, ['createNewJournal']]], {
        document: { getElementById: el, querySelector: () => null },
        window: {},
        SupabaseAuth: {
            isConfigured: () => true, isReady: () => true,
            supabaseSignUp: async () => ({ data: signUpData, error: null }),
        },
        initDB: async () => {},
        getAuthRecordByUsername: async () => null,
        showAuthError: (id, msg) => calls.errors.push([id, msg]),
        saveAuthRecord: async r => { calls.saved.push(r); return Object.assign({ id: 'acct' }, r); },
        setActiveAccount: async () => {},
        saveToIndexedDB: async () => { calls.indexed++; },
        generateRecoveryKey: () => 'rk',
        sha256: async () => 'hash',
        DekCrypto: { generateDek: () => 'dek', wrapDekV2: async () => ({ v: 2 }), hashSecret: async () => ({ v: 2 }) },
        showAuthView: () => {},
    });
    return Object.assign(box, { calls });
}

test('sign-up: an email that already has an account (no session, no identities) creates nothing', async () => {
    const h = signUpBox({ user: { id: 'placeholder', identities: [] }, session: null });
    await h.fns.createNewJournal();
    assert.deepEqual(h.calls.errors, [['reg-error', 'An account with this email already exists. Sign in instead.']]);
    assert.deepEqual(h.calls.saved, []);
    assert.equal(h.calls.indexed, 0);
});

test('sign-up: a new email still creates the account (with or without an immediate session)', async () => {
    for (const session of [{ access_token: 't' }, null]) {
        const h = signUpBox({ user: { id: 'new-uid', identities: [{ id: 'i1' }] }, session });
        await h.fns.createNewJournal();
        assert.deepEqual(h.calls.errors, []);
        assert.equal(h.calls.saved.length, 1);
        assert.equal(h.calls.saved[0].supabaseUid, 'new-uid');
    }
});

// ── 3. Broker save labelled browser-only ───────────────────────────────────

test('broker save: the cloud result is checked and a queued or failed save says browser-only', () => {
    assert.match(BA, /const BA_LOCAL_ONLY_MSG = 'Saved in this browser only\. Not synced to the cloud\.';/);
    const start = BA.indexOf("getElementById('broker-account-form')?.addEventListener('submit'");
    const handler = BA.slice(start, BA.indexOf('// Clear the import-context flag', start));
    assert.match(handler, /_denariiStorageMode === 'cloud_primary' && !\(r && r\.success === true\)\) cloudSaveFailed = true/);
    assert.match(handler, /trackCloudSave\(await _saveBrokerAccountToSupabase\(savedAcct\)\)/);
    assert.match(handler, /trackCloudSave\(await _saveBrokerAccountToSupabase\(ba\)\)/);
    assert.match(handler, /if \(cloudSaveFailed\) alert\(BA_LOCAL_ONLY_MSG\)/);
    assert.match(handler, /text\.replace\(WB_LINK_FAILED_MSG, BA_LOCAL_ONLY_MSG/);
});
