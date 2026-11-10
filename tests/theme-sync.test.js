// Account theme sync: js/theme.js with the user_meta helpers from js/auth.js,
// run against the in-memory Supabase stand-in.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { fakeSupabase } = require('./helpers/fake-supabase');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const AUTH = read('js/auth.js');
const THEME = read('js/theme.js');
const APP = read('Denarii.js');
const HTML = read('index.html');

const A = 'user-a';
const B = 'user-b';

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

const metaRow = (uid, value) => ({ user_id: uid, key: 'themePref', value: JSON.stringify(value) });

function box(o) {
    o = o || {};
    const store = new Map(Object.entries(o.local || {}));
    const client = o.client || fakeSupabase({ user_meta: o.rows || [] }, o.db);
    const applied = [];
    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        setTimeout, clearTimeout, Promise, JSON,
        localStorage: {
            getItem: k => (store.has(k) ? store.get(k) : null),
            setItem: (k, v) => store.set(k, String(v)),
            removeItem: k => store.delete(k),
        },
        document: {
            documentElement: { setAttribute: (_, v) => applied.push(v) },
            getElementById: () => null,
            querySelectorAll: () => [],
        },
        SupabaseAuth: {
            isReady: () => o.ready !== false,
            getClient: () => client,
            supabaseGetSession: async () => ({ data: o.sessionUid === null ? null : { user: { id: o.sessionUid || A } } }),
        },
        _denariiSupabaseUid: o.uid === undefined ? A : o.uid,
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    const helpers = ['_getSupabaseForBackup', '_themeClientFor', '_fetchAccountTheme', '_saveAccountTheme', '_cloudRowToLocal']
        .map(n => extractFunction(AUTH, n)).join('\n');
    vm.runInContext(helpers + '\n' + THEME, ctx);
    return { ctx, store, client, applied, get: k => (store.has(k) ? store.get(k) : null) };
}

const flush = () => new Promise(r => setTimeout(r, 5));
const themeWrites = c => c.writes.filter(w => w.table === 'user_meta');
const signIn = async (b, uid) => { await b.ctx.syncThemeOnSignIn({ supabaseUid: uid || A }); await flush(); };

// ── Picking a theme ──────────────────────────────────────────────

test('picking a theme saves it to localStorage and the account', async () => {
    const b = box();
    b.ctx.selectThemeFromPopup('harbor-light');
    await flush();
    assert.equal(b.get('denarii-theme'), 'harbor-light');
    assert.equal(b.get('denarii-theme-owner'), A);
    assert.equal(b.get('denarii-theme-pending'), null);
    const row = b.client.tables.user_meta[0];
    assert.equal(row.user_id, A);
    assert.equal(row.key, 'themePref');
    assert.equal(row.value, '"harbor-light"');
});

test('a failed save keeps the pick locally and leaves it pending', async () => {
    const b = box({ db: { writeError: true } });
    b.ctx.selectThemeFromPopup('sage-journal');
    await flush();
    assert.equal(b.get('denarii-theme'), 'sage-journal');
    assert.equal(b.get('denarii-theme-pending'), A);
});

test('a pick with no matching session writes nothing and stays pending', async () => {
    const b = box({ sessionUid: B });
    b.ctx.selectThemeFromPopup('sage-journal');
    await flush();
    assert.equal(themeWrites(b.client).length, 0);
    assert.equal(b.get('denarii-theme-pending'), A);
});

test('an account with no cloud identity only saves locally', async () => {
    const b = box({ uid: null });
    b.ctx.selectThemeFromPopup('dawn-ember');
    await flush();
    assert.equal(b.get('denarii-theme'), 'dawn-ember');
    assert.equal(b.get('denarii-theme-pending'), null);
    assert.equal(themeWrites(b.client).length, 0);
});

test('a slower save of an older pick does not clear the newer pending pick', async () => {
    const b = box({ local: { 'denarii-theme': 'blush-power', 'denarii-theme-pending': A } });
    await b.ctx._saveAccountTheme(A, 'harbor-light');
    assert.equal(b.get('denarii-theme-pending'), A);
});

// ── Sign-in ──────────────────────────────────────────────────────

test('sign-in with no local theme applies and stores the account theme', async () => {
    const b = box({ rows: [metaRow(A, 'warm-midnight')] });
    await signIn(b);
    assert.deepEqual(b.applied, ['warm-midnight']);
    assert.equal(b.get('denarii-theme'), 'warm-midnight');
    assert.equal(b.get('denarii-theme-owner'), A);
    assert.equal(themeWrites(b.client).length, 0);
});

test('the account theme replaces a different local theme', async () => {
    const b = box({ rows: [metaRow(A, 'warm-midnight')], local: { 'denarii-theme': 'harbor-light', 'denarii-theme-owner': A } });
    await signIn(b);
    assert.equal(b.get('denarii-theme'), 'warm-midnight');
});

test('another user\'s row is never read', async () => {
    const b = box({ rows: [metaRow(B, 'warm-midnight')] });
    await signIn(b);
    assert.deepEqual(b.applied, ['denarii-forged']);
    assert.equal(b.get('denarii-theme'), null);
});

test('a pending pick is retried and beats the account value', async () => {
    const b = box({
        rows: [metaRow(A, 'warm-midnight')],
        local: { 'denarii-theme': 'harbor-light', 'denarii-theme-pending': A, 'denarii-theme-owner': A },
    });
    await signIn(b);
    assert.deepEqual(b.applied, []);
    assert.equal(b.get('denarii-theme'), 'harbor-light');
    assert.equal(b.get('denarii-theme-pending'), null);
    assert.equal(b.client.tables.user_meta[0].value, '"harbor-light"');
});

test('a retry that fails again stays pending', async () => {
    const b = box({ db: { writeError: true }, local: { 'denarii-theme': 'harbor-light', 'denarii-theme-pending': A } });
    await signIn(b);
    assert.equal(b.get('denarii-theme'), 'harbor-light');
    assert.equal(b.get('denarii-theme-pending'), A);
});

test('another user\'s pending marker is not acted on', async () => {
    const b = box({
        rows: [metaRow(A, 'warm-midnight')],
        local: { 'denarii-theme': 'harbor-light', 'denarii-theme-pending': B, 'denarii-theme-owner': B },
    });
    await signIn(b);
    assert.equal(b.get('denarii-theme'), 'warm-midnight');
    assert.equal(b.client.tables.user_meta[0].value, JSON.stringify('warm-midnight'));
});

test('an unknown account value gets Forged and changes nothing saved', async () => {
    const b = box({ rows: [metaRow(A, 'neon-future')], local: { 'denarii-theme': 'harbor-light', 'denarii-theme-owner': A } });
    await signIn(b);
    assert.deepEqual(b.applied, ['denarii-forged']);
    assert.equal(b.get('denarii-theme'), 'harbor-light');
    assert.equal(themeWrites(b.client).length, 0);
    assert.equal(b.client.tables.user_meta[0].value, '"neon-future"');
});

test('no account theme: this user\'s local pick is saved to the account', async () => {
    const b = box({ local: { 'denarii-theme': 'harbor-light', 'denarii-theme-owner': A } });
    await signIn(b);
    assert.deepEqual(b.applied, []);
    assert.equal(b.client.tables.user_meta[0].value, '"harbor-light"');
});

test('no account theme: an unclaimed local pick is claimed and saved', async () => {
    const b = box({ local: { 'denarii-theme': 'harbor-light' } });
    await signIn(b);
    assert.equal(b.get('denarii-theme-owner'), A);
    assert.equal(b.client.tables.user_meta[0].value, '"harbor-light"');
});

test('no account theme: another user\'s local pick gets Forged and is left alone', async () => {
    const b = box({ local: { 'denarii-theme': 'harbor-light', 'denarii-theme-owner': B } });
    await signIn(b);
    assert.deepEqual(b.applied, ['denarii-forged']);
    assert.equal(b.get('denarii-theme'), 'harbor-light');
    assert.equal(b.get('denarii-theme-owner'), B);
    assert.equal(themeWrites(b.client).length, 0);
});

test('nothing anywhere: Forged and nothing is written', async () => {
    const b = box();
    await signIn(b);
    assert.deepEqual(b.applied, ['denarii-forged']);
    assert.equal(b.store.size, 0);
    assert.equal(themeWrites(b.client).length, 0);
});

test('an unknown local value is not saved to the account', async () => {
    const b = box({ local: { 'denarii-theme': 'neon-future' } });
    await signIn(b);
    assert.deepEqual(b.applied, ['denarii-forged']);
    assert.equal(themeWrites(b.client).length, 0);
});

// ── Failed reads never overwrite ─────────────────────────────────

for (const [name, opts] of [
    ['read error', { db: { fail: 'user_meta' } }],
    ['no session', { sessionUid: null }],
    ['session from another account', { sessionUid: B }],
    ['Supabase not ready', { ready: false }],
]) {
    test('failed read (' + name + ') leaves the local theme and account alone', async () => {
        const b = box(Object.assign({ local: { 'denarii-theme': 'harbor-light' } }, opts));
        await signIn(b);
        assert.deepEqual(b.applied, []);
        assert.equal(b.get('denarii-theme'), 'harbor-light');
        assert.equal(b.get('denarii-theme-owner'), null);
        assert.equal(themeWrites(b.client).length, 0);
    });
}

test('a client that throws is handled like a failed read', async () => {
    const client = { from() { throw new Error('boom'); }, writes: [] };
    const b = box({ client, local: { 'denarii-theme': 'harbor-light' } });
    await signIn(b);
    assert.deepEqual(b.applied, []);
    assert.equal(b.get('denarii-theme'), 'harbor-light');
});

test('a read that hangs stops at the cap and changes nothing', async () => {
    const b = box({ db: { hang: 'user_meta' }, local: { 'denarii-theme': 'harbor-light' } });
    vm.runInContext('_THEME_SYNC_TIMEOUT_MS = 20;', b.ctx);
    const start = Date.now();
    await signIn(b);
    assert.ok(Date.now() - start < 1000);
    assert.deepEqual(b.applied, []);
    assert.equal(themeWrites(b.client).length, 0);
});

test('the cap is 1.5 seconds', () => {
    assert.match(THEME, /_THEME_SYNC_TIMEOUT_MS = 1500;/);
});

test('an account with no cloud identity makes no cloud call', async () => {
    const b = box({ local: { 'denarii-theme': 'harbor-light' } });
    await b.ctx.syncThemeOnSignIn({ supabaseUid: null });
    await b.ctx.syncThemeOnSignIn(null);
    assert.deepEqual(b.applied, []);
    assert.equal(themeWrites(b.client).length, 0);
});

// ── Stays out of the journal ─────────────────────────────────────

test('the cloud loader never puts themePref in journalData', async () => {
    const ctx = {
        console: { log() {}, warn() {}, error() {} },
        JSON,
        _fetchAllRows: async (_c, table) => (table === 'user_meta'
            ? [metaRow(A, 'harbor-light'), { user_id: A, key: 'dashPrefs', value: JSON.stringify({ x: 1 }) }]
            : []),
    };
    vm.createContext(ctx);
    vm.runInContext(extractFunction(AUTH, '_cloudRowToLocal') + '\n' + extractFunction(AUTH, '_loadJournalFromSupabaseRows'), ctx);
    const revs = {};
    const jd = await ctx._loadJournalFromSupabaseRows({}, A, { revs });
    assert.equal('themePref' in jd, false);
    assert.equal(jd.dashPrefs.x, 1);
    assert.equal((revs._meta || {}).themePref, undefined);
});

test('themePref is not a synced journal meta key', () => {
    const keys = /var _USER_META_KEYS = \[[\s\S]*?\];/.exec(AUTH)[0];
    assert.equal(keys.includes('themePref'), false);
});

// ── Wiring ───────────────────────────────────────────────────────

test('unlockApp syncs the theme before the app is revealed', () => {
    const fn = extractFunction(APP, 'unlockApp');
    const sync = fn.indexOf('syncThemeOnSignIn');
    assert.ok(sync > 0);
    assert.ok(sync < fn.indexOf("getElementById('login-screen')"));
});

test('initTheme still uses localStorage or Forged only', () => {
    const fn = extractFunction(THEME, 'initTheme');
    assert.equal(/_fetchAccountTheme|syncThemeOnSignIn|denarii-theme-/.test(fn), false);
});

test('index.html has the bumped script versions', () => {
    assert.ok(Number(HTML.split('js/theme.js?v=')[1].split('"')[0]) >= 3);
    assert.ok(Number((HTML.split('src="js/auth.js?v=')[1] || '0"').split('"')[0]) >= 42);
    assert.ok(Number((HTML.split('src="Denarii.js?v=')[1] || '0"').split('"')[0]) >= 57);
});
