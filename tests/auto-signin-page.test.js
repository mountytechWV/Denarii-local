// Step 4e-3: "Stay signed in on this computer" in the page.
// The real startup, registration, reset, delete and Settings functions run
// in the sandbox harness from password-hash.test.js with a fake
// window.denariiAutoSignIn: every failure lands on the sign-in screen
// without changing account data, the toggle needs the password only to turn
// on, and reset / delete clear auto sign-in for that account.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const CryptoJS = require('../vendor/crypto-js/4.1.1/crypto-js.js');
const DekCrypto = new Function('CryptoJS', read('js/dek-crypto.js') + '\nreturn DekCrypto;')(CryptoJS);
const AUTH = read('js/auth.js');
const SETTINGS = read('js/pages/settings.js');
const APP = read('Denarii.js');
const HTML = read('index.html');

const clone = v => JSON.parse(JSON.stringify(v));

// ── Sandbox harness (as in password-hash.test.js) ──────────────────────────

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

function sandbox(parts, vals) {
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
    const fns = new Function('scope', 'with (scope) { return (function () {\n' + code +
        '\nreturn {' + names.join(',') + '};\n})(); }')(scope);
    return { fns, g: target };
}

function fakeDocument(values) {
    const els = {};
    return {
        els,
        getElementById: id => els[id] || (els[id] = Object.assign({ value: '', checked: false, disabled: false, style: {}, textContent: '' }, values[id] || {})),
        querySelector: () => null,
        querySelectorAll: () => [],
    };
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

// Fake preload API recording every call.
function fakeAuto(opts) {
    const o = Object.assign({ available: true, owner: null, used: false, unlock: { ok: false, reason: 'none' } }, opts);
    const calls = [];
    return {
        calls,
        api: {
            status: async () => { calls.push(['status']); return { available: o.available, accountId: o.available ? o.owner : null, used: o.used }; },
            enable: async (id, dek) => { calls.push(['enable', id, dek]); o.owner = id; return { ok: true }; },
            disable: async (...args) => {
                calls.push(['disable', ...args]);
                const cleared = args.length === 0 || args[0] === o.owner;
                if (cleared) o.owner = null;
                return { ok: true, cleared };
            },
            tryUnlock: async () => { calls.push(['tryUnlock']); o.used = true; return o.unlock; },
        },
    };
}

const DEK = 'ab'.repeat(32);
const account = extra => Object.assign({ id: 'acct_1', username: 'jason', dekVersion: 1, legalAcceptedVersion: 'L1', storageMode: 'local_legacy' }, extra);

// ── 1. Startup (_startupAutoSignIn) ────────────────────────────────────────

function startupBox(opts) {
    const o = Object.assign({ record: account(), loadOk: true }, opts);
    const auto = fakeAuto({ unlock: o.unlock, owner: o.owner, used: o.used });
    const calls = { errors: [], views: [], unlocked: 0, legal: 0, saved: [], loads: [], active: [] };
    const doc = fakeDocument({});
    const box = sandbox([[AUTH, ['_startupAutoSignIn', '_disableAutoSignIn']]], {
        document: doc,
        window: { denariiAutoSignIn: auto.api },
        localStorage: { setItem: () => {} },
        LEGAL_BUNDLE_VERSION: 'L1',
        initDB: async () => {},
        getAuthRecordById: async id => (o.record && id === o.record.id ? clone(o.record) : null),
        setActiveAccount: async id => { calls.active.push(id); },
        loadFromIndexedDB: async opts => { calls.loads.push(opts); return o.loadOk; },
        saveAuthRecord: async r => { calls.saved.push(r); return r; },
        showAuthView: v => { calls.views.push(v); },
        showAuthError: (id, msg) => calls.errors.push([id, msg]),
        unlockApp: () => { calls.unlocked++; },
        showLegalAcceptanceModal: (rec, cb) => { calls.legal++; calls.legalCb = cb; },
        sessionDek: null, sessionPassword: 'stale', currentAccountId: null, currentUsername: null,
        console: quiet,
    });
    return { run: () => box.fns._startupAutoSignIn(), calls, auto, g: box.g, doc };
}

test('startup: a working auto sign-in loads the journal with the DEK and unlocks', async () => {
    const h = startupBox({ unlock: { ok: true, accountId: 'acct_1', dek: DEK } });
    await h.run();
    assert.equal(h.g.sessionDek, DEK);
    assert.equal(h.g.sessionPassword, null);
    assert.equal(h.g.currentAccountId, 'acct_1');
    assert.equal(h.g.currentUsername, 'jason');
    assert.deepEqual(h.calls.active, ['acct_1']);
    assert.deepEqual(h.calls.loads, [{ skipCloudBlob: true }]);
    assert.equal(h.calls.unlocked, 1);
    assert.equal(h.calls.legal, 0);
    assert.deepEqual(h.calls.errors, []);
    assert.deepEqual(h.calls.saved, [], 'no account data written');
    assert.deepEqual(h.auto.calls, [['status'], ['tryUnlock']]);
    assert.equal(h.doc.els['login-status'].style.display, 'none', '"Signing in…" hidden again');
});

test('startup: a newer legal version shows the legal modal first, as a normal sign-in does', async () => {
    const h = startupBox({ unlock: { ok: true, accountId: 'acct_1', dek: DEK }, record: account({ legalAcceptedVersion: 'L0' }) });
    await h.run();
    assert.equal(h.calls.unlocked, 0);
    assert.equal(h.calls.legal, 1);
    h.calls.legalCb();
    assert.equal(h.calls.unlocked, 1);
});

test('startup: a journal that will not load clears the session, disables auto sign-in and asks for the password', async () => {
    const h = startupBox({ unlock: { ok: true, accountId: 'acct_1', dek: DEK }, loadOk: false });
    await h.run();
    assert.equal(h.g.sessionDek, null);
    assert.equal(h.g.sessionPassword, null);
    assert.equal(h.g.currentAccountId, null);
    assert.equal(h.calls.unlocked, 0);
    assert.deepEqual(h.auto.calls, [['status'], ['tryUnlock'], ['disable', 'acct_1']]);
    assert.deepEqual(h.calls.views, ['login']);
    assert.equal(h.doc.els['login-username'].value, 'jason');
    assert.deepEqual(h.calls.errors, [['login-error', 'Automatic sign-in didn\'t work. Sign in with your password.']]);
    assert.deepEqual(h.calls.saved, []);
});

test('startup: every other result leaves the normal sign-in screen untouched', async () => {
    for (const reason of ['unavailable', 'used', 'none', 'decrypt-failed', 'account-missing', 'not-eligible']) {
        const h = startupBox({ unlock: { ok: false, reason } });
        await h.run();
        assert.equal(h.g.sessionDek, null, reason);
        assert.equal(h.calls.unlocked + h.calls.legal, 0, reason);
        assert.deepEqual(h.calls.loads, [], reason);
        assert.deepEqual(h.calls.errors, [], reason);
        assert.deepEqual(h.calls.views, [], reason);
        assert.deepEqual(h.auto.calls, [['status'], ['tryUnlock']], reason);
        assert.equal(h.doc.els['login-status'].style.display, 'none', reason);
    }
    // ok but the record vanished in between: nothing loaded
    const gone = startupBox({ unlock: { ok: true, accountId: 'acct_9', dek: DEK } });
    await gone.run();
    assert.equal(gone.g.sessionDek, null);
    assert.deepEqual(gone.calls.loads, []);
});

test('startup: "Signing in…" shows only when an account holds auto sign-in and this launch has not used it', async () => {
    for (const [owner, used, expected] of [['acct_1', false, true], [null, false, false], ['acct_1', true, false]]) {
        const h = startupBox({ unlock: { ok: false, reason: 'none' }, owner, used });
        let shown = null;
        h.auto.api.tryUnlock = async () => { shown = h.doc.els['login-status'].textContent === 'Signing in…'; return { ok: false, reason: 'none' }; };
        await h.run();
        assert.equal(shown, expected, JSON.stringify({ owner, used }));
        assert.equal(h.doc.els['login-status'].style.display, 'none');
    }
});

test('startup: no preload API (or a throwing one) does nothing', async () => {
    const h = startupBox({});
    h.g.window = {};
    await h.run();
    assert.deepEqual(h.auto.calls, []);
    const t = startupBox({});
    t.auto.api.tryUnlock = async () => { throw new Error('Database is closed.'); };
    await t.run();
    assert.equal(t.g.sessionDek, null);
    assert.equal(t.calls.unlocked, 0);
});

// ── 2. Registration ────────────────────────────────────────────────────────

function regBox(opts) {
    const o = Object.assign({ available: true, owner: null, checked: true, shown: true, owners: {} }, opts);
    const auto = fakeAuto({ available: o.available, owner: o.owner });
    const doc = fakeDocument({
        'reg-username': { value: 'newuser' }, 'reg-password': { value: 'password123' }, 'reg-confirm': { value: 'password123' },
        'reg-legal-accept': { checked: true }, 'reg-autosignin': { checked: o.checked },
        'reg-autosignin-group': { style: { display: o.shown ? '' : 'none' } },
    });
    const calls = { errors: [], saved: [] };
    const box = sandbox([[AUTH, ['createNewJournal', '_refreshRegAutoSignIn']]], {
        document: doc,
        window: { denariiAutoSignIn: auto.api },
        SupabaseAuth: { isConfigured: () => false },
        DekCrypto,
        LEGAL_BUNDLE_VERSION: 'L1', APP_VERSION: 'x',
        db: {},
        initDB: async () => {},
        getAuthRecordByUsername: async () => null,
        getAuthRecordById: async id => o.owners[id] || null,
        saveAuthRecord: async r => { calls.saved.push(r); return Object.assign({ id: 'acct_new' }, r); },
        setActiveAccount: async () => {},
        saveToIndexedDB: async () => {},
        generateRecoveryKey: () => 'ABCD-EFGH-JKLM',
        showAuthError: (id, msg) => calls.errors.push([id, msg]),
        showAuthView: () => {},
        console: quiet,
    });
    return { box, calls, auto, doc, g: box.g };
}

test('registration: checked box enables auto sign-in with the new DEK', async () => {
    const h = regBox({});
    await h.box.fns.createNewJournal();
    assert.deepEqual(h.calls.errors, []);
    const enable = h.auto.calls.find(c => c[0] === 'enable');
    assert.ok(enable, 'enable called');
    assert.equal(enable[1], 'acct_new');
    assert.equal(enable[2], h.g.sessionDek);
    assert.match(enable[2], /^[0-9a-f]{64}$/);
});

test('registration: unchecked or hidden box leaves auto sign-in alone', async () => {
    for (const opts of [{ checked: false }, { shown: false }]) {
        const h = regBox(opts);
        await h.box.fns.createNewJournal();
        assert.deepEqual(h.calls.errors, []);
        assert.equal(h.calls.saved.length, 1, 'account still created');
        assert.deepEqual(h.auto.calls.filter(c => c[0] !== 'status'), [], JSON.stringify(opts));
    }
});

test('registration checkbox: hidden when unavailable; shows who it replaces', async () => {
    const off = regBox({ available: false });
    await off.box.fns._refreshRegAutoSignIn();
    assert.equal(off.doc.els['reg-autosignin-group'].style.display, 'none');

    const free = regBox({});
    await free.box.fns._refreshRegAutoSignIn();
    assert.equal(free.doc.els['reg-autosignin-group'].style.display, '');
    assert.equal(free.doc.els['reg-autosignin-replace'].style.display, 'none');

    const taken = regBox({ owner: 'acct_1', owners: { acct_1: account() } });
    await taken.box.fns._refreshRegAutoSignIn();
    assert.equal(taken.doc.els['reg-autosignin-replace'].textContent, 'This will replace automatic sign-in for jason.');
    assert.equal(taken.doc.els['reg-autosignin-replace'].style.display, 'block');
});

test('markup: registration checkbox is checked by default and hidden until available; Settings section hidden too', () => {
    assert.match(HTML, /<div class="form-group" id="reg-autosignin-group" style="display:none;/);
    assert.match(HTML, /<input type="checkbox" id="reg-autosignin" checked /);
    assert.match(HTML, /Automatically sign me in on this computer/);
    assert.match(HTML, /<div id="autosignin-section" style="display:none;/);
    assert.match(HTML, /id="settings-autosignin" onchange="toggleAutoSignIn\(this\)"/);
    const hint = 'Anyone who can sign in to this Windows account will be able to open your journal. Backups still need your password.';
    assert.equal(HTML.split(hint).length - 1, 2, 'hint on both the checkbox and the toggle');
    assert.ok(HTML.indexOf('id="reg-autosignin-group"') > HTML.indexOf('id="reg-legal-accept"'), 'below the legal checkbox');
});

// ── 3. Reset and delete clear auto sign-in for that account ────────────────

async function dekAccountV2(password, recoveryKey) {
    const dek = DekCrypto.generateDek();
    return Object.assign(account(), {
        passwordHash: await DekCrypto.hashSecret(password),
        recoveryHash: await DekCrypto.hashSecret(recoveryKey),
        wrappedDekByPassword: await DekCrypto.wrapDekV2(dek, password),
        wrappedDekByRecovery: await DekCrypto.wrapDekV2(dek, recoveryKey),
    });
}

function resetBox(record, recoveryKey) {
    const auto = fakeAuto({});
    const calls = { errors: [], saved: [] };
    const box = sandbox([[AUTH, ['resetPassword', '_disableAutoSignIn']]], {
        document: fakeDocument({
            'forgot-username': { value: record.username }, 'forgot-recovery-key': { value: recoveryKey },
            'forgot-new-pw': { value: 'newpassword1' }, 'forgot-confirm-pw': { value: 'newpassword1' },
        }),
        window: { denariiAutoSignIn: auto.api },
        DekCrypto,
        initDB: async () => {},
        getAuthRecordByUsername: async () => clone(record),
        showAuthError: (id, msg) => calls.errors.push([id, msg]),
        saveAuthRecord: async r => { calls.saved.push(clone(r)); return r; },
        alert: () => {},
        console: quiet,
    });
    return { run: () => box.fns.resetPassword(), calls, auto };
}

test('reset: a successful reset disables auto sign-in for that account; a wrong key does not', async () => {
    const record = await dekAccountV2('password123', 'ABCD-EFGH-JKLM');
    const ok = resetBox(record, 'ABCD-EFGH-JKLM');
    await ok.run();
    assert.deepEqual(ok.calls.errors, []);
    assert.equal(ok.calls.saved.length, 1);
    assert.deepEqual(ok.auto.calls, [['disable', 'acct_1']]);

    const bad = resetBox(record, 'WXYZ-WXYZ-WXYZ');
    await bad.run();
    assert.deepEqual(bad.auto.calls, []);
});

test('deleteAccount clears auto sign-in for that account (only after local cleanup)', async () => {
    const auto = fakeAuto({});
    const order = [];
    const box = sandbox([[AUTH, ['deleteAccount', '_disableAutoSignIn']]], {
        window: { denariiAutoSignIn: auto.api },
        AUTH_STORE: 'auth', STORE_NAME: 'journal',
        makeAccountKey: id => 'account:' + id,
        makeUsernameKey: u => 'username:' + u,
        makeJournalKey: id => 'journal:' + id,
        storeGet: async () => account(),
        storeDelete: async (s, k) => { order.push('delete ' + k); },
        getSetting: async () => null,
        console: quiet,
    });
    auto.api.disable = async id => { order.push('disable ' + id); return { ok: true }; };
    await box.fns.deleteAccount('acct_1', 'jason');
    assert.equal(order[order.length - 1], 'disable acct_1');
    assert.ok(order.includes('delete journal:acct_1'));
});

// ── 4. Settings > Security toggle ──────────────────────────────────────────

function settingsBox(opts) {
    const o = Object.assign({ record: null, owner: null, available: true, sessionDek: DEK, password: null, confirm: true, owners: {} }, opts);
    const auto = fakeAuto({ available: o.available, owner: o.owner });
    const calls = { prompts: 0, msgs: [], confirms: [] };
    const doc = fakeDocument({});
    const box = sandbox([[SETTINGS, ['initAutoSignInSection', 'toggleAutoSignIn']]], {
        document: doc,
        window: { denariiAutoSignIn: auto.api, showPromptModal: async () => { calls.prompts++; return o.password; } },
        DekCrypto,
        AUTO_SIGNIN_LEGACY_MSG: 'Not available for this account because it uses an older encryption format.',
        AUTO_SIGNIN_CLOUD_MSG: 'Not available for cloud-linked accounts.',
        currentAccountId: o.record ? o.record.id : null,
        sessionDek: o.sessionDek,
        getAuthRecord: async () => clone(o.record),
        getAuthRecordById: async id => o.owners[id] || null,
        confirm: m => { calls.confirms.push(m); return o.confirm; },
        showSettingsMsg: (el, msg, isError) => calls.msgs.push([msg, !!isError]),
        console: quiet,
    });
    return { box, calls, auto, doc, cb: () => doc.getElementById('settings-autosignin') };
}

test('toggle: reflects whether this account holds auto sign-in', async () => {
    const record = await dekAccountV2('password123', 'R');
    const on = settingsBox({ record, owner: 'acct_1' });
    await on.box.fns.initAutoSignInSection();
    assert.equal(on.doc.els['autosignin-section'].style.display, '');
    assert.equal(on.cb().checked, true);
    assert.equal(on.cb().disabled, false);
    const other = settingsBox({ record, owner: 'acct_2' });
    await other.box.fns.initAutoSignInSection();
    assert.equal(other.cb().checked, false);
});

test('toggle: hidden when unavailable; disabled with a note for legacy and cloud-linked accounts', async () => {
    const off = settingsBox({ record: account(), available: false });
    await off.box.fns.initAutoSignInSection();
    assert.equal(off.doc.els['autosignin-section'].style.display, 'none');

    const legacy = settingsBox({ record: account({ dekVersion: undefined }), sessionDek: null });
    await legacy.box.fns.initAutoSignInSection();
    assert.equal(legacy.cb().disabled, true);
    assert.equal(legacy.cb().checked, false);
    assert.equal(legacy.doc.els['settings-autosignin-note'].textContent, 'Not available for this account because it uses an older encryption format.');

    const cloud = settingsBox({ record: account({ supabaseUid: 'uid' }) });
    await cloud.box.fns.initAutoSignInSection();
    assert.equal(cloud.cb().disabled, true);
    assert.equal(cloud.doc.els['settings-autosignin-note'].textContent, 'Not available for cloud-linked accounts.');
});

test('toggle off: disable() with no password prompt', async () => {
    const record = await dekAccountV2('password123', 'R');
    const h = settingsBox({ record, owner: 'acct_1' });
    await h.box.fns.initAutoSignInSection();
    const cb = h.cb();
    cb.checked = false; // user unticks
    await h.box.fns.toggleAutoSignIn(cb);
    assert.equal(h.calls.prompts, 0);
    assert.ok(h.auto.calls.some(c => c[0] === 'disable' && c.length === 1), 'disable() with no account id');
    assert.equal(cb.checked, false);
});

test('toggle on: asks for the password; cancel or wrong password enables nothing', async () => {
    const record = await dekAccountV2('password123', 'R');
    for (const [password, msgs] of [[null, []], ['wrong-password', [['Incorrect password.', true]]]]) {
        const h = settingsBox({ record, password });
        const cb = h.cb();
        cb.checked = true;
        await h.box.fns.toggleAutoSignIn(cb);
        assert.equal(h.calls.prompts, 1);
        assert.deepEqual(h.calls.msgs, msgs);
        assert.deepEqual(h.auto.calls.filter(c => c[0] === 'enable'), []);
        assert.equal(cb.checked, false);
    }
});

test('toggle on: right password enables with the session DEK', async () => {
    const record = await dekAccountV2('password123', 'R');
    const h = settingsBox({ record, password: 'password123' });
    const cb = h.cb();
    cb.checked = true;
    await h.box.fns.toggleAutoSignIn(cb);
    assert.deepEqual(h.auto.calls.filter(c => c[0] === 'enable'), [['enable', 'acct_1', DEK]]);
    assert.equal(cb.checked, true);
    assert.deepEqual(h.calls.confirms, []);
});

test('toggle on: confirms before replacing another account; declining enables nothing', async () => {
    const record = await dekAccountV2('password123', 'R');
    const no = settingsBox({ record, password: 'password123', owner: 'acct_2', owners: { acct_2: account({ id: 'acct_2', username: 'maria' }) }, confirm: false });
    const cb = no.cb();
    cb.checked = true;
    await no.box.fns.toggleAutoSignIn(cb);
    assert.deepEqual(no.calls.confirms, ['This will replace automatic sign-in for maria.']);
    assert.deepEqual(no.auto.calls.filter(c => c[0] === 'enable'), []);

    const yes = settingsBox({ record, password: 'password123', owner: 'acct_2', owners: { acct_2: account({ id: 'acct_2', username: 'maria' }) } });
    const cb2 = yes.cb();
    cb2.checked = true;
    await yes.box.fns.toggleAutoSignIn(cb2);
    assert.deepEqual(yes.auto.calls.filter(c => c[0] === 'enable'), [['enable', 'acct_1', DEK]]);
});

// ── 5. Change password message, backup reminder ────────────────────────────

test('change password: says automatic sign-in is still on when this account holds it', async () => {
    const record = await dekAccountV2('password123', 'ABCD-EFGH-JKLM');
    for (const [owner, expectNote] of [['acct_1', true], [null, false]]) {
        const auto = fakeAuto({ owner });
        const msgs = [];
        const box = sandbox([[SETTINGS, ['changePassword']]], {
            document: fakeDocument({ 'settings-current-pw': { value: 'password123' }, 'settings-new-pw': { value: 'newpassword1' }, 'settings-confirm-pw': { value: 'newpassword1' } }),
            window: { denariiAutoSignIn: auto.api, showPromptModal: async () => null },
            DekCrypto,
            sessionDek: DekCrypto.generateDek(),
            getAuthRecord: async () => clone(record),
            showSettingsMsg: (el, msg, isError) => msgs.push([msg, !!isError]),
            saveAuthRecord: async r => r,
            console: quiet,
        });
        await box.fns.changePassword();
        assert.equal(msgs.length, 1);
        assert.equal(/Automatic sign-in is still on for this computer\.$/.test(msgs[0][0]), expectNote, msgs[0][0]);
        assert.deepEqual(auto.calls.filter(c => c[0] !== 'status'), [], 'password change never touches auto sign-in');
    }
});

test('source: backup reminder works with a DEK-only session; Lock is unchanged', () => {
    assert.match(extractFunction(AUTH, 'lockJournal'), /if \(!lastBackupTime \|\|/, 'Lock reminder depends only on lastBackupTime');
    assert.doesNotMatch(APP, /exported a backup in over a week/, 'no weekly close guard');
    assert.doesNotMatch(extractFunction(AUTH, '_completeLock'), /denariiAutoSignIn/);
    assert.match(AUTH, /_startupAutoSignIn\(\);\n\}\);/, 'started from DOMContentLoaded');
});
