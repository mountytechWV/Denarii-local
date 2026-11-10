// Hidden local-only records: the "saved only in this browser" notice is shown
// only for hidden keys not shown before (cloudHiddenShown:<accountId>), and
// old cloudload snapshots are pruned to the newest 3, never deleting one that
// fails to decrypt or still holds records missing from the cloud.
//
// Same harness as batch-2-editor-guard.test.js: real functions are cut out of
// js/auth.js and run in a `with` scope (unknown globals are inert).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const AUTH = fs.readFileSync(path.join(__dirname, '..', 'js', 'auth.js'), 'utf8');

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

const FNS = ['_overlayRecord', '_mergeCloudIntoLocal', '_keysMissingFromCloud', '_pruneCloudLoadSnapshots',
    '_showCloudLoadBanner', '_claimHiddenNotice'];
const VARS = [
    extractVar(AUTH, /var _CLOUD_ARRAY_DOMAINS = \[[^\]]*\];/, '_CLOUD_ARRAY_DOMAINS'),
    extractVar(AUTH, /var _CLOUD_KEYED_DOMAINS = \[[^\]]*\];/, '_CLOUD_KEYED_DOMAINS'),
    extractVar(AUTH, /var _CLOUDLOAD_SNAPSHOTS_KEEP = [^\n]*;/, '_CLOUDLOAD_SNAPSHOTS_KEEP'),
    extractVar(AUTH, /var _CLOUD_HIDDEN_SHOWN_MAX = [^\n]*;/, '_CLOUD_HIDDEN_SHOWN_MAX'),
    "var _DEMO_BROKER_ID = 'ba_demo_pelosi';",
].join('\n');

function fakeDoc() {
    const byId = {};
    const mk = tag => ({
        tagName: tag, id: '', style: {}, children: [], attrs: {}, textContent: '', className: '', parentNode: null,
        setAttribute(k, v) { this.attrs[k] = String(v); },
        appendChild(c) { c.parentNode = this; this.children.push(c); if (c.id) byId[c.id] = c; return c; },
        addEventListener() {},
        remove() {
            if (this.parentNode) this.parentNode.children = this.parentNode.children.filter(x => x !== this);
            if (byId[this.id] === this) delete byId[this.id];
        },
    });
    return { body: mk('body'), createElement: mk, getElementById: id => byId[id] || null };
}

const encrypt = (d, k) => 'E:' + k + ':' + JSON.stringify(d);
const decrypt = (s, k) => (typeof s === 'string' && s.indexOf('E:' + k + ':') === 0 ? JSON.parse(s.slice(('E:' + k + ':').length)) : null);

function makeBox(over) {
    over = over || {};
    const settings = Object.assign({}, over.settings);
    const store = Object.assign({}, over.store);
    const deleted = [];
    const doc = fakeDoc();
    const target = Object.assign({
        window: { _denariiStorageMode: 'cloud_primary' },
        document: doc,
        currentAccountId: 'acct', sessionDek: 'dek', sessionPassword: 'pw',
        _cloudLoadStatus: null, _cloudBaselineReady: true, _cloudPaused: false,
        STORE_NAME: 'journal',
        getSetting: async k => settings[k], setSetting: async (k, v) => { settings[k] = v; },
        storeGetAllKeys: async () => Object.keys(store),
        storeGet: async (s, k) => store[k],
        storeDelete: async (s, k) => { deleted.push(k); delete store[k]; },
        decrypt,
        console: { log() {}, warn() {} },
    }, over.vals);
    const scope = new Proxy(target, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => {
            if (typeof k !== 'string') return undefined;
            if (k in t) return t[k];
            if (k in globalThis) return globalThis[k];
            return inert;
        },
    });
    const code = FNS.map(n => extractFunction(AUTH, n)).join('\n');
    const fns = new Function('scope', 'with (scope) { return (function () {\n' + VARS + '\n' + code +
        '\nreturn {' + FNS.join(',') + '};\n})(); }')(scope);
    return { fns, g: target, settings, store, deleted, doc };
}

const banner = h => h.doc.getElementById('cloud-load-banner');
const bannerText = h => (banner(h) ? banner(h).children[0].textContent : null);

// ── hiddenKeys ─────────────────────────────────────────────────────────────

test('merge: hiddenKeys names each hidden record, sorted, and the rest of the result is unchanged', () => {
    const h = makeBox();
    const local = {
        trades: [{ id: 't1' }, { id: 't-local' }],
        strategies: [{ id: 'a-local' }],
        reviews: { 'daily|2026-10-01': { content: 'x' }, 'daily|2026-10-02': { content: 'y' } },
        dashLayout: 'L',
    };
    const cloud = { trades: [{ id: 't1' }], strategies: [], reviews: { 'daily|2026-10-01': { content: 'x' } } };
    const m = h.fns._mergeCloudIntoLocal(local, cloud, {}, {});
    assert.equal(m.hidden, 3);
    assert.deepEqual(m.hiddenKeys, ['reviews:daily|2026-10-02', 'strategies:a-local', 'trades:t-local']);
    assert.deepEqual(m.jd.trades.map(t => t.id), ['t1']);
    assert.deepEqual(Object.keys(m.jd.reviews), ['daily|2026-10-01']);
    assert.equal(m.jd.dashLayout, 'L');
});

test('merge: pending rows and kept Pelosi demo trades are not in hiddenKeys', () => {
    const h = makeBox();
    const local = {
        brokerAccounts: [{ id: 'ba_demo_pelosi' }],
        trades: [{ id: 'd1', brokerAccountId: 'ba_demo_pelosi' }, { id: 'p1' }, { id: 'gone' }],
        dailyPlanners: { '2026-10-03': { a: 1 } },
    };
    const cloud = { brokerAccounts: [{ id: 'ba_demo_pelosi' }], trades: [], dailyPlanners: {} };
    const m = h.fns._mergeCloudIntoLocal(local, cloud, { trades: { p1: true }, dailyPlanners: { '2026-10-03': true } }, {});
    assert.deepEqual(m.hiddenKeys, ['trades:gone']);
    assert.equal(m.hidden, 1);
    assert.deepEqual(m.demoTrades.map(t => t.id), ['d1']);
});

test('merge: nothing hidden → empty hiddenKeys', () => {
    const h = makeBox();
    const m = h.fns._mergeCloudIntoLocal({ tags: [{ id: 'x' }] }, { tags: [{ id: 'x' }] }, {}, {});
    assert.deepEqual(m.hiddenKeys, []);
    assert.equal(m.hidden, 0);
});

// ── Notice show / skip ─────────────────────────────────────────────────────

test('notice: new hidden keys show it and are recorded', async () => {
    const h = makeBox({ vals: { _cloudLoadStatus: { ok: true, hidden: 2, hiddenKeys: ['trades:a', 'trades:b'], reason: null } } });
    await h.fns._showCloudLoadBanner();
    assert.match(bannerText(h), /^2 items saved only in this browser/);
    assert.deepEqual(h.settings['cloudHiddenShown:acct'], ['trades:a', 'trades:b']);
});

test('notice: the same hidden set again is skipped', async () => {
    const h = makeBox({
        settings: { 'cloudHiddenShown:acct': ['trades:a', 'trades:b'] },
        vals: { _cloudLoadStatus: { ok: true, hidden: 2, hiddenKeys: ['trades:a', 'trades:b'], reason: null } },
    });
    await h.fns._showCloudLoadBanner();
    assert.equal(banner(h), null);
    assert.deepEqual(h.settings['cloudHiddenShown:acct'], ['trades:a', 'trades:b']);
});

test('notice: a subset of shown keys is skipped; one new key shows it again', async () => {
    const shown = { 'cloudHiddenShown:acct': ['trades:a', 'trades:b'] };
    const sub = makeBox({ settings: shown, vals: { _cloudLoadStatus: { ok: true, hidden: 1, hiddenKeys: ['trades:a'], reason: null } } });
    await sub.fns._showCloudLoadBanner();
    assert.equal(banner(sub), null);

    const add = makeBox({ settings: shown, vals: { _cloudLoadStatus: { ok: true, hidden: 2, hiddenKeys: ['trades:a', 'trades:c'], reason: null } } });
    await add.fns._showCloudLoadBanner();
    assert.match(bannerText(add), /^2 items saved only in this browser/);
    assert.deepEqual(add.settings['cloudHiddenShown:acct'], ['trades:a', 'trades:b', 'trades:c']);
});

test('notice: the shown list is per account', async () => {
    const h = makeBox({
        settings: { 'cloudHiddenShown:other': ['trades:a'] },
        vals: { _cloudLoadStatus: { ok: true, hidden: 1, hiddenKeys: ['trades:a'], reason: null } },
    });
    await h.fns._showCloudLoadBanner();
    assert.notEqual(banner(h), null);
});

test('notice: the shown list is capped at 500, newest kept', async () => {
    const old = Array.from({ length: 500 }, (_, i) => 'trades:o' + i);
    const h = makeBox({
        settings: { 'cloudHiddenShown:acct': old },
        vals: { _cloudLoadStatus: { ok: true, hidden: 2, hiddenKeys: ['trades:n1', 'trades:n2'], reason: null } },
    });
    await h.fns._showCloudLoadBanner();
    const list = h.settings['cloudHiddenShown:acct'];
    assert.equal(list.length, 500);
    assert.deepEqual(list.slice(-2), ['trades:n1', 'trades:n2']);
    assert.equal(list[0], 'trades:o2');
});

test('notice: the failure notice is always shown and records nothing', async () => {
    const h = makeBox({ vals: { _cloudLoadStatus: { ok: false, hidden: 0, reason: 'timeout' } } });
    await h.fns._showCloudLoadBanner();
    assert.match(bannerText(h), /^Couldn’t load your cloud data/);
    assert.equal(h.settings['cloudHiddenShown:acct'], undefined);
});

test('notice: nothing hidden shows nothing', async () => {
    const h = makeBox({ vals: { _cloudLoadStatus: { ok: true, hidden: 0, hiddenKeys: [], reason: null } } });
    await h.fns._showCloudLoadBanner();
    assert.equal(banner(h), null);
});

test('notice: a status without hiddenKeys, or a settings error, still shows it', async () => {
    const noKeys = makeBox({ vals: { _cloudLoadStatus: { ok: true, hidden: 1, reason: null } } });
    await noKeys.fns._showCloudLoadBanner();
    assert.notEqual(banner(noKeys), null);

    const broken = makeBox({ vals: {
        _cloudLoadStatus: { ok: true, hidden: 1, hiddenKeys: ['trades:a'], reason: null },
        getSetting: async () => { throw new Error('idb closed'); },
    } });
    await broken.fns._showCloudLoadBanner();
    assert.notEqual(banner(broken), null);
});

// ── Snapshot pruning ───────────────────────────────────────────────────────

const CLOUD = { trades: [{ id: 't1' }, { id: 't2' }], strategies: [{ id: 's1' }], reviews: { 'daily|2026-10-01': {} } };
const covered = () => ({ encrypted: true, data: encrypt({ trades: [{ id: 't1' }], strategies: [{ id: 's1' }], reviews: { 'daily|2026-10-01': {} } }, 'dek') });
const snapKey = n => 'cloudload:acct:2026-10-0' + n + 'T00:00:00.000Z';

test('prune: keeps the newest 3 and deletes older ones fully in the cloud', async () => {
    const store = { 'journal:acct': { encrypted: true, data: 'LIVE' } };
    for (let n = 1; n <= 5; n++) store[snapKey(n)] = covered();
    const h = makeBox({ store });
    const removed = await h.fns._pruneCloudLoadSnapshots('acct', CLOUD);
    assert.equal(removed, 2);
    assert.deepEqual(h.deleted.sort(), [snapKey(1), snapKey(2)]);
    assert.deepEqual(Object.keys(h.store).filter(k => k.startsWith('cloudload:')).sort(), [snapKey(3), snapKey(4), snapKey(5)]);
    assert.ok(h.store['journal:acct'], 'the live journal record is never touched');
});

test('prune: 3 or fewer snapshots → nothing deleted', async () => {
    const store = {};
    for (let n = 1; n <= 3; n++) store[snapKey(n)] = covered();
    const h = makeBox({ store });
    assert.equal(await h.fns._pruneCloudLoadSnapshots('acct', CLOUD), 0);
    assert.deepEqual(h.deleted, []);
});

test('prune: an older snapshot with any record missing from the cloud is kept', async () => {
    const store = {};
    for (let n = 1; n <= 5; n++) store[snapKey(n)] = covered();
    store[snapKey(1)] = { encrypted: true, data: encrypt({ trades: [{ id: 't1' }, { id: 'lost' }] }, 'dek') };
    store[snapKey(2)] = { encrypted: true, data: encrypt({ weeklyPlanners: { '2026-W40': {} } }, 'dek') };
    const h = makeBox({ store });
    assert.equal(await h.fns._pruneCloudLoadSnapshots('acct', CLOUD), 0);
    assert.deepEqual(h.deleted, []);
});

test('prune: Pelosi demo trades and pending rows missing from the cloud count as missing', async () => {
    const store = {};
    for (let n = 1; n <= 4; n++) store[snapKey(n)] = covered();
    store[snapKey(1)] = { encrypted: true, data: encrypt({ trades: [{ id: 'd1', brokerAccountId: 'ba_demo_pelosi' }] }, 'dek') };
    const h = makeBox({ store, vals: { _cloudPending: { trades: { d1: true } } } });
    assert.equal(await h.fns._pruneCloudLoadSnapshots('acct', CLOUD), 0);
});

test('prune: a snapshot that fails to decrypt, is unencrypted, empty, or errors is kept', async () => {
    const store = {};
    for (let n = 1; n <= 7; n++) store[snapKey(n)] = covered();
    store[snapKey(1)] = { encrypted: true, data: encrypt({ trades: [] }, 'OLD-KEY') };   // wrong key → null
    store[snapKey(2)] = { encrypted: false, data: { trades: [] } };
    store[snapKey(3)] = { encrypted: true, data: null };
    store[snapKey(4)] = { encrypted: true, data: 'THROW' };
    const h = makeBox({ store, vals: { decrypt: (s, k) => { if (s === 'THROW') throw new Error('bad'); return decrypt(s, k); } } });
    assert.equal(await h.fns._pruneCloudLoadSnapshots('acct', CLOUD), 0);
    assert.deepEqual(h.deleted, []);
});

test('prune: a domain the cloud did not return counts as empty (keep)', async () => {
    const store = {};
    for (let n = 1; n <= 4; n++) store[snapKey(n)] = covered();
    store[snapKey(1)] = { encrypted: true, data: encrypt({ tags: [{ id: 'g1' }] }, 'dek') };
    const h = makeBox({ store });
    assert.equal(await h.fns._pruneCloudLoadSnapshots('acct', CLOUD), 0);
});

test('prune: only this account\'s cloudload snapshots are considered', async () => {
    const store = { 'snapshot:acct:2026-01-01T00:00:00.000Z': covered() };
    for (let n = 1; n <= 4; n++) store[snapKey(n)] = covered();
    for (let n = 1; n <= 4; n++) store['cloudload:other:2026-10-0' + n + 'T00:00:00.000Z'] = covered();
    const h = makeBox({ store });
    assert.equal(await h.fns._pruneCloudLoadSnapshots('acct', CLOUD), 1);
    assert.deepEqual(h.deleted, [snapKey(1)]);
});

test('prune: never runs while paused, without a baseline, a key, an account or cloud data', async () => {
    const cases = [
        { vals: { _cloudPaused: true } },
        { vals: { _cloudBaselineReady: false } },
        { vals: { sessionDek: null, sessionPassword: null } },
        { account: null },
        { cloud: null },
    ];
    for (const c of cases) {
        const store = {};
        for (let n = 1; n <= 5; n++) store[snapKey(n)] = covered();
        const h = makeBox({ store, vals: c.vals });
        const r = await h.fns._pruneCloudLoadSnapshots('account' in c ? c.account : 'acct', 'cloud' in c ? c.cloud : CLOUD);
        assert.equal(r, 0);
        assert.deepEqual(h.deleted, []);
    }
});

test('prune: a key listing error deletes nothing', async () => {
    const h = makeBox({ vals: { storeGetAllKeys: async () => { throw new Error('idb closed'); } } });
    assert.equal(await h.fns._pruneCloudLoadSnapshots('acct', CLOUD), 0);
});

// ── Wiring ─────────────────────────────────────────────────────────────────

test('wiring: both load paths store hiddenKeys and prune with the loaded cloud data', () => {
    const reload = extractFunction(AUTH, '_cloudFirstReload');
    const resync = extractFunction(AUTH, '_cloudResync');
    assert.match(reload, /hiddenKeys: merged\.hiddenKeys/);
    assert.match(reload, /_pruneCloudLoadSnapshots\(auth\.id, cloud\)/);
    assert.match(resync, /hiddenKeys: merged\.hiddenKeys/);
    assert.match(resync, /_pruneCloudLoadSnapshots\(currentAccountId, cloud\)/);
    // Pruning comes after the cloud data is in place, not on the paused path.
    assert.ok(reload.indexOf('_pruneCloudLoadSnapshots') > reload.indexOf('_setCloudBaseline(journalData, true, cloud)'));
    assert.ok(resync.indexOf('_pruneCloudLoadSnapshots') > resync.indexOf('_setCloudBaseline(journalData, true, cloud)'));
    assert.doesNotMatch(extractFunction(AUTH, '_enterCloudPaused'), /_pruneCloudLoadSnapshots/);
});
