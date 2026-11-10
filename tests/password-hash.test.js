// Step 4d: salted PBKDF2 password and recovery-key hashes.
// 1. DekCrypto.hashSecret / verifySecret: v2 format, verify ok and fail,
//    legacy unsalted SHA-256 accepted and upgraded only when it matches.
// 2. The real sign-in, password reset and change-password functions (run in
//    the same sandbox harness as session-guards.test.js) upgrade an old hash
//    only after it verified, and leave the record unchanged on a wrong secret.
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

const legacy = s => CryptoJS.SHA256(s).toString(CryptoJS.enc.Hex);
const clone = v => JSON.parse(JSON.stringify(v));

// ── Sandbox harness (as in session-guards.test.js) ─────────────────────────

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
        getElementById: id => els[id] || (els[id] = Object.assign({ value: '', checked: false, style: {}, textContent: '' }, values[id] || {})),
        querySelector: () => null,
        querySelectorAll: () => [],
    };
}

// Account record shapes as saved by createNewJournal (no DEK unless a test adds one).
function oldAccount(password, recoveryKey) {
    return {
        id: 'acct_1',
        username: 'jason',
        passwordHash: legacy(password),
        recoveryHash: legacy(recoveryKey),
        storageMode: 'local_legacy',
        createdAt: '2026-01-01T00:00:00.000Z',
    };
}

// ── 1. Helpers ─────────────────────────────────────────────────────────────

test('hashSecret writes the v2 PBKDF2 format with a fresh salt each time', async () => {
    const a = await DekCrypto.hashSecret('password123');
    const b = await DekCrypto.hashSecret('password123');
    assert.deepEqual(Object.keys(a).sort(), ['alg', 'hash', 'iter', 'salt', 'v']);
    assert.equal(a.v, 2);
    assert.equal(a.alg, 'pbkdf2-sha256');
    assert.equal(a.iter, 600000);
    assert.equal(Buffer.from(a.salt, 'base64').length, 16);
    assert.equal(Buffer.from(a.hash, 'base64').length, 32);
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.hash, b.hash);
    assert.ok(DekCrypto.isV2Hash(a));
    assert.ok(!DekCrypto.isLegacyHash(a));
});

test('v2 hash: right secret verifies, wrong secret fails, no upgrade either way', async () => {
    const stored = await DekCrypto.hashSecret('password123');
    assert.deepEqual(await DekCrypto.verifySecret('password123', stored), { ok: true, upgrade: null });
    assert.deepEqual(await DekCrypto.verifySecret('password124', stored), { ok: false, upgrade: null });
    assert.deepEqual(await DekCrypto.verifySecret('', stored), { ok: false, upgrade: null });
});

test('matches Node PBKDF2 for the same salt and iterations', async () => {
    const stored = await DekCrypto.hashSecret('päss wörd 🎯');
    const expected = require('node:crypto').pbkdf2Sync(Buffer.from('päss wörd 🎯', 'utf8'), Buffer.from(stored.salt, 'base64'), stored.iter, 32, 'sha256');
    assert.equal(stored.hash, expected.toString('base64'));
});

test('legacy SHA-256: right secret verifies and returns a v2 upgrade; wrong secret does not', async () => {
    const stored = legacy('ABCD-EFGH-JKLM');
    const ok = await DekCrypto.verifySecret('ABCD-EFGH-JKLM', stored);
    assert.equal(ok.ok, true);
    assert.ok(DekCrypto.isV2Hash(ok.upgrade));
    assert.deepEqual(await DekCrypto.verifySecret('ABCD-EFGH-JKLM', ok.upgrade), { ok: true, upgrade: null });
    assert.deepEqual(await DekCrypto.verifySecret('ABCD-EFGH-JKLX', stored), { ok: false, upgrade: null });
    assert.equal((await DekCrypto.verifySecret('ABCD-EFGH-JKLM', stored.toUpperCase())).ok, true, 'hex case ignored');
});

test('unrecognised or malformed stored values never verify', async () => {
    for (const stored of [undefined, null, '', 'hash', 42, {}, { v: 2 },
        { v: 2, alg: 'pbkdf2-sha256', iter: 1e9, salt: 'AAAA', hash: 'AAAA' },
        { v: 2, alg: 'pbkdf2-sha256', iter: 1000, salt: '***', hash: '***' },
        { v: 3, alg: 'pbkdf2-sha256', iter: 1000, salt: 'AAAA', hash: 'AAAA' }]) {
        assert.deepEqual(await DekCrypto.verifySecret('x', stored), { ok: false, upgrade: null }, JSON.stringify(stored));
    }
});

// ── 2. Sign-in (openExistingJournal) ───────────────────────────────────────

function signInBox(record, password) {
    const calls = { errors: [], saved: [] };
    const box = sandbox([[AUTH, ['openExistingJournal']]], {
        document: fakeDocument({ 'login-username': { value: record.username }, 'login-password': { value: password } }),
        window: {},
        DekCrypto,
        SupabaseAuth: { isConfigured: () => false, isReady: () => false },
        initDB: async () => {},
        getAuthRecordByUsername: async () => clone(record),
        showAuthError: (id, msg) => calls.errors.push([id, msg]),
        saveAuthRecord: async r => { calls.saved.push(clone(r)); return r; },
        console: { log: () => {}, warn: () => {}, error: () => {} },
    });
    // Everything after the password check is stubbed; only what happened up
    // to it (errors, saved records) is checked.
    const run = () => box.fns.openExistingJournal().catch(() => {});
    return { run, calls };
}

test('sign-in: an old-format account signs in and its password hash is upgraded', async () => {
    const record = oldAccount('password123', 'ABCD-EFGH-JKLM');
    const h = signInBox(record, 'password123');
    await h.run();
    assert.deepEqual(h.calls.errors, []);
    assert.equal(h.calls.saved.length, 1);
    const saved = h.calls.saved[0];
    assert.ok(DekCrypto.isV2Hash(saved.passwordHash));
    assert.equal((await DekCrypto.verifySecret('password123', saved.passwordHash)).ok, true);
    assert.equal(saved.recoveryHash, record.recoveryHash, 'recovery hash cannot be upgraded without the key');
    const { passwordHash: _a, ...restSaved } = saved;
    const { passwordHash: _b, ...restOld } = record;
    assert.deepEqual(restSaved, restOld, 'nothing else changed');
});

test('sign-in: a wrong password leaves an old-format record unchanged', async () => {
    const h = signInBox(oldAccount('password123', 'ABCD-EFGH-JKLM'), 'password124');
    await h.run();
    assert.deepEqual(h.calls.errors, [['login-error', 'Incorrect username or password.']]);
    assert.deepEqual(h.calls.saved, []);
});

test('sign-in: a v2 account signs in without rewriting its record; a wrong password is refused', async () => {
    const record = Object.assign(oldAccount('x', 'y'), {
        passwordHash: await DekCrypto.hashSecret('password123'),
        recoveryHash: await DekCrypto.hashSecret('ABCD-EFGH-JKLM'),
    });
    const ok = signInBox(record, 'password123');
    await ok.run();
    assert.deepEqual(ok.calls.errors, []);
    assert.deepEqual(ok.calls.saved, []);
    const bad = signInBox(record, 'wrong-password');
    await bad.run();
    assert.deepEqual(bad.calls.errors, [['login-error', 'Incorrect username or password.']]);
    assert.deepEqual(bad.calls.saved, []);
});

// ── 3. Password reset with the recovery key (resetPassword) ────────────────

function resetBox(record, recoveryKey, newPw) {
    const calls = { errors: [], saved: [] };
    const box = sandbox([[AUTH, ['resetPassword']]], {
        document: fakeDocument({
            'forgot-username': { value: record.username }, 'forgot-recovery-key': { value: recoveryKey },
            'forgot-new-pw': { value: newPw }, 'forgot-confirm-pw': { value: newPw },
        }),
        DekCrypto,
        initDB: async () => {},
        getAuthRecordByUsername: async () => clone(record),
        showAuthError: (id, msg) => calls.errors.push([id, msg]),
        saveAuthRecord: async r => { calls.saved.push(clone(r)); return r; },
        alert: () => {},
        console: { log: () => {}, warn: () => {}, error: () => {} },
    });
    return { run: () => box.fns.resetPassword(), calls };
}

function dekAccount(password, recoveryKey) {
    const dek = DekCrypto.generateDek();
    const pwSalt = DekCrypto.generateSalt();
    const rkSalt = DekCrypto.generateSalt();
    return Object.assign(oldAccount(password, recoveryKey), {
        dekVersion: 1,
        wrappedDekByPassword: DekCrypto.wrapDek(dek, DekCrypto.deriveWrappingKey(password, pwSalt)),
        dekPasswordSalt: pwSalt,
        wrappedDekByRecovery: DekCrypto.wrapDek(dek, DekCrypto.deriveWrappingKey(recoveryKey, rkSalt)),
        dekRecoverySalt: rkSalt,
    });
}

test('reset: a wrong recovery key changes nothing', async () => {
    const h = resetBox(oldAccount('password123', 'ABCD-EFGH-JKLM'), 'ABCD-EFGH-XXXX', 'newpassword1');
    await h.run();
    assert.deepEqual(h.calls.errors, [['forgot-error', 'Invalid recovery key.']]);
    assert.deepEqual(h.calls.saved, []);
});

test('reset: an old-format DEK account gets v2 password and recovery hashes', async () => {
    const h = resetBox(dekAccount('password123', 'ABCD-EFGH-JKLM'), 'abcd-efgh-jklm', 'newpassword1');
    await h.run();
    assert.deepEqual(h.calls.errors, []);
    assert.equal(h.calls.saved.length, 1);
    const saved = h.calls.saved[0];
    assert.equal((await DekCrypto.verifySecret('newpassword1', saved.passwordHash)).ok, true);
    assert.equal((await DekCrypto.verifySecret('password123', saved.passwordHash)).ok, false);
    assert.ok(DekCrypto.isV2Hash(saved.recoveryHash));
    assert.equal((await DekCrypto.verifySecret('ABCD-EFGH-JKLM', saved.recoveryHash)).ok, true);
});

// ── 4. Change password in Settings (changePassword) ────────────────────────

function changePwBox(record, currentPw, newPw, recoveryKey) {
    const calls = { msgs: [], saved: [] };
    const box = sandbox([[SETTINGS, ['changePassword']]], {
        document: fakeDocument({
            'settings-current-pw': { value: currentPw }, 'settings-new-pw': { value: newPw }, 'settings-confirm-pw': { value: newPw },
        }),
        window: { showPromptModal: async () => recoveryKey },
        DekCrypto,
        getAuthRecord: async () => clone(record),
        showSettingsMsg: (el, msg, isError) => calls.msgs.push([msg, !!isError]),
        saveAuthRecord: async r => { calls.saved.push(clone(r)); return r; },
        console: { log: () => {}, warn: () => {}, error: () => {} },
    });
    return { run: () => box.fns.changePassword().catch(() => {}), calls };
}

test('change password: a wrong current password changes nothing', async () => {
    const h = changePwBox(oldAccount('password123', 'ABCD-EFGH-JKLM'), 'password124', 'newpassword1', null);
    await h.run();
    assert.deepEqual(h.calls.msgs, [['Current password is incorrect.', true]]);
    assert.deepEqual(h.calls.saved, []);
});

test('change password: a wrong recovery key changes nothing', async () => {
    const h = changePwBox(oldAccount('password123', 'ABCD-EFGH-JKLM'), 'password123', 'newpassword1', 'ABCD-EFGH-XXXX');
    await h.run();
    assert.deepEqual(h.calls.msgs, [['Recovery key is incorrect. Password was NOT changed.', true]]);
    assert.deepEqual(h.calls.saved, []);
});

test('change password: stores a v2 password hash, and upgrades the recovery hash when given', async () => {
    const record = oldAccount('password123', 'ABCD-EFGH-JKLM');
    const withKey = changePwBox(record, 'password123', 'newpassword1', ' abcd-efgh-jklm ');
    await withKey.run();
    const saved = withKey.calls.saved[0];
    assert.ok(saved, 'record saved');
    assert.equal((await DekCrypto.verifySecret('newpassword1', saved.passwordHash)).ok, true);
    assert.ok(DekCrypto.isV2Hash(saved.recoveryHash));
    assert.equal((await DekCrypto.verifySecret('ABCD-EFGH-JKLM', saved.recoveryHash)).ok, true);

    const noKey = changePwBox(record, 'password123', 'newpassword1', null);
    await noKey.run();
    assert.ok(DekCrypto.isV2Hash(noKey.calls.saved[0].passwordHash));
    assert.equal(noKey.calls.saved[0].recoveryHash, record.recoveryHash, 'recovery hash untouched when skipped');
});

// ── 5. No unsalted hash is written anywhere ────────────────────────────────

test('source: no SHA-256 password or recovery hash is created in app code', () => {
    for (const [name, src] of [['auth.js', AUTH], ['settings.js', SETTINGS], ['Denarii.js', APP]]) {
        assert.doesNotMatch(src, /\bsha256\(/, name);
        assert.doesNotMatch(src, /(passwordHash|recoveryHash)\s*=\s*await\s+(?!DekCrypto\.hashSecret)/, name);
    }
    assert.match(AUTH, /DekCrypto\.hashSecret\(password\),\s*DekCrypto\.hashSecret\(recoveryKey\)/);
    assert.match(APP, /DekCrypto\.hashSecret\(password\),\s*DekCrypto\.hashSecret\(recoveryKey\)/);
});
