// Step 4e-1: DEK wrap v2 (PBKDF2-SHA256 600k + AES-256-GCM).
// 1. DekCrypto.wrapDekV2 / unwrapDekAny: v2 round trip, wrong secret fails,
//    v1 still unwraps and reports upgraded, malformed wraps never unwrap.
// 2. The real sign-in, password reset and change-password functions (same
//    sandbox harness as password-hash.test.js): a v1 wrap is replaced with
//    v2 only after it unwrapped and the journal loaded, a wrong secret never
//    changes the record, and mixed v1/v2 records keep working.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const nodeCrypto = require('node:crypto');
const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const CryptoJS = require('../vendor/crypto-js/4.1.1/crypto-js.js');
const DekCrypto = new Function('CryptoJS', read('js/dek-crypto.js') + '\nreturn DekCrypto;')(CryptoJS);
const AUTH = read('js/auth.js');
const SETTINGS = read('js/pages/settings.js');
const APP = read('Denarii.js');

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
        getElementById: id => els[id] || (els[id] = Object.assign({ value: '', checked: false, style: {}, textContent: '' }, values[id] || {})),
        querySelector: () => null,
        querySelectorAll: () => [],
    };
}

const quiet = { log: () => {}, warn: () => {}, error: () => {} };

// A DEK account as saved before Step 4e-1: v2 hashes (Step 4d), v1 wraps.
async function v1Account(password, recoveryKey) {
    const dek = DekCrypto.generateDek();
    const pwSalt = DekCrypto.generateSalt();
    const rkSalt = DekCrypto.generateSalt();
    const record = {
        id: 'acct_1',
        username: 'jason',
        passwordHash: await DekCrypto.hashSecret(password),
        recoveryHash: await DekCrypto.hashSecret(recoveryKey),
        storageMode: 'local_legacy',
        legalAcceptedVersion: 'L1',
        dekVersion: 1,
        wrappedDekByPassword: DekCrypto.wrapDek(dek, DekCrypto.deriveWrappingKey(password, pwSalt)),
        dekPasswordSalt: pwSalt,
        wrappedDekByRecovery: DekCrypto.wrapDek(dek, DekCrypto.deriveWrappingKey(recoveryKey, rkSalt)),
        dekRecoverySalt: rkSalt,
        createdAt: '2026-01-01T00:00:00.000Z',
    };
    return { dek, record };
}

async function unwrapPw(record, secret) {
    return (await DekCrypto.unwrapDekAny(record.wrappedDekByPassword, record.dekPasswordSalt, secret)).dek;
}

async function unwrapRk(record, secret) {
    return (await DekCrypto.unwrapDekAny(record.wrappedDekByRecovery, record.dekRecoverySalt, secret)).dek;
}

// ── 1. Helpers ─────────────────────────────────────────────────────────────

test('wrapDekV2 writes the v2 format with a fresh salt and IV each time; round trip', async () => {
    const dek = DekCrypto.generateDek();
    const a = await DekCrypto.wrapDekV2(dek, 'password123');
    const b = await DekCrypto.wrapDekV2(dek, 'password123');
    assert.deepEqual(Object.keys(a).sort(), ['alg', 'ct', 'iter', 'iv', 'salt', 'v']);
    assert.equal(a.v, 2);
    assert.equal(a.alg, 'pbkdf2-sha256/aes-256-gcm');
    assert.equal(a.iter, 600000);
    assert.equal(Buffer.from(a.salt, 'base64').length, 16);
    assert.equal(Buffer.from(a.iv, 'base64').length, 12);
    assert.equal(Buffer.from(a.ct, 'base64').length, 32 + 16, '32 DEK bytes + GCM tag');
    assert.notEqual(a.salt, b.salt);
    assert.notEqual(a.iv, b.iv);
    assert.ok(DekCrypto.isV2Wrap(a));
    assert.deepEqual(await DekCrypto.unwrapDekAny(a, null, 'password123'), { dek, upgraded: false });
    assert.deepEqual(await DekCrypto.unwrapDekAny(b, 'ignored-salt', 'password123'), { dek, upgraded: false });
});

test('v2 wrap matches Node PBKDF2 + AES-256-GCM for the same salt and IV', async () => {
    const dek = DekCrypto.generateDek();
    const w = await DekCrypto.wrapDekV2(dek, 'päss wörd 🎯');
    const key = nodeCrypto.pbkdf2Sync(Buffer.from('päss wörd 🎯', 'utf8'), Buffer.from(w.salt, 'base64'), w.iter, 32, 'sha256');
    const ct = Buffer.from(w.ct, 'base64');
    const d = nodeCrypto.createDecipheriv('aes-256-gcm', key, Buffer.from(w.iv, 'base64'));
    d.setAuthTag(ct.subarray(32));
    const raw = Buffer.concat([d.update(ct.subarray(0, 32)), d.final()]);
    assert.equal(raw.toString('hex'), dek);
});

test('v2: a wrong secret or a tampered wrap fails (GCM), never a wrong DEK', async () => {
    const dek = DekCrypto.generateDek();
    const w = await DekCrypto.wrapDekV2(dek, 'password123');
    const fail = { dek: null, upgraded: false };
    assert.deepEqual(await DekCrypto.unwrapDekAny(w, null, 'password124'), fail);
    assert.deepEqual(await DekCrypto.unwrapDekAny(w, null, ''), fail);
    const ct = Buffer.from(w.ct, 'base64');
    ct[0] ^= 1;
    assert.deepEqual(await DekCrypto.unwrapDekAny({ ...w, ct: ct.toString('base64') }, null, 'password123'), fail);
    assert.deepEqual(await DekCrypto.unwrapDekAny({ ...w, iter: w.iter - 1 }, null, 'password123'), fail);
});

test('v2: malformed or out-of-range wraps are not read', async () => {
    const w = await DekCrypto.wrapDekV2(DekCrypto.generateDek(), 'x');
    for (const bad of [undefined, null, '', 42, {}, { v: 2 }, { ...w, v: 3 }, { ...w, alg: 'other' },
        { ...w, iter: 1e9 }, { ...w, iter: 0 }, { ...w, iter: 1.5 }, { ...w, iv: 'AAAA' }, { ...w, salt: 5 }]) {
        assert.deepEqual(await DekCrypto.unwrapDekAny(bad, null, 'x'), { dek: null, upgraded: false }, JSON.stringify(bad));
    }
    await assert.rejects(DekCrypto.wrapDekV2('not-a-dek', 'x'));
    await assert.rejects(DekCrypto.wrapDekV2('A'.repeat(64), 'x'));
});

test('v1 still unwraps and reports upgraded; a wrong secret or missing salt does not', async () => {
    const { dek, record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    assert.deepEqual(await DekCrypto.unwrapDekAny(record.wrappedDekByPassword, record.dekPasswordSalt, 'password123'), { dek, upgraded: true });
    assert.deepEqual(await DekCrypto.unwrapDekAny(record.wrappedDekByRecovery, record.dekRecoverySalt, 'ABCD-EFGH-JKLM'), { dek, upgraded: true });
    assert.deepEqual(await DekCrypto.unwrapDekAny(record.wrappedDekByPassword, record.dekPasswordSalt, 'password124'), { dek: null, upgraded: false });
    assert.deepEqual(await DekCrypto.unwrapDekAny(record.wrappedDekByPassword, null, 'password123'), { dek: null, upgraded: false });
});

test('hasPasswordWrap / hasRecoveryWrap accept v1 with salt and v2, nothing else', async () => {
    const { record } = await v1Account('p', 'r');
    const v2 = await DekCrypto.wrapDekV2(DekCrypto.generateDek(), 'p');
    assert.ok(DekCrypto.hasPasswordWrap(record));
    assert.ok(DekCrypto.hasRecoveryWrap(record));
    assert.ok(DekCrypto.hasPasswordWrap({ dekVersion: 1, wrappedDekByPassword: v2 }));
    assert.ok(DekCrypto.hasRecoveryWrap({ dekVersion: 1, wrappedDekByRecovery: v2 }));
    assert.ok(!DekCrypto.hasPasswordWrap({ ...record, dekPasswordSalt: null }));
    assert.ok(!DekCrypto.hasRecoveryWrap({ ...record, wrappedDekByRecovery: null, dekRecoverySalt: null }));
    assert.ok(!DekCrypto.hasPasswordWrap({ ...record, dekVersion: undefined }));
    assert.ok(!DekCrypto.hasPasswordWrap(null));
});

// ── 2. Sign-in (openExistingJournal + _rewrapPasswordDekV2) ────────────────

function signInBox(record, password, opts) {
    const o = Object.assign({ loadOk: true, storedRecord: record, saveFails: false }, opts);
    const calls = { errors: [], saved: [], events: [], unlocked: 0 };
    const box = sandbox([[AUTH, ['openExistingJournal', '_rewrapPasswordDekV2']]], {
        document: fakeDocument({ 'login-username': { value: record.username }, 'login-password': { value: password } }),
        window: {},
        localStorage: { setItem: () => {} },
        DekCrypto,
        SupabaseAuth: { isConfigured: () => false, isReady: () => false },
        LEGAL_BUNDLE_VERSION: 'L1',
        initDB: async () => {},
        getAuthRecordByUsername: async () => clone(record),
        getAuthRecordById: async () => clone(o.storedRecord),
        showAuthError: (id, msg) => calls.errors.push([id, msg]),
        saveAuthRecord: async r => {
            calls.events.push('save');
            if (o.saveFails) throw new Error('disk full');
            calls.saved.push(clone(r));
            return r;
        },
        setActiveAccount: async () => {},
        _resolveStorageMode: () => 'local_legacy',
        loadFromIndexedDB: async () => { calls.events.push('load'); return o.loadOk; },
        _cloudFirstReload: async () => {},
        unlockApp: () => { calls.unlocked++; },
        sessionDek: null,
        sessionPassword: null,
        console: quiet,
    });
    return { run: () => box.fns.openExistingJournal(), calls, g: box.g };
}

test('sign-in: a v1 account is re-wrapped to v2 only after the journal loads', async () => {
    const { dek, record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const h = signInBox(record, 'password123');
    await h.run();
    assert.deepEqual(h.calls.errors, []);
    assert.deepEqual(h.calls.events, ['load', 'save']);
    assert.equal(h.calls.unlocked, 1);
    assert.equal(h.g.sessionDek, dek);
    assert.equal(h.calls.saved.length, 1);
    const saved = h.calls.saved[0];
    assert.ok(DekCrypto.isV2Wrap(saved.wrappedDekByPassword));
    assert.ok(!('dekPasswordSalt' in saved), 'v2 wrap needs no separate salt');
    assert.equal(await unwrapPw(saved, 'password123'), dek);
    assert.equal(await unwrapPw(saved, 'password124'), null);
    // Everything else, including the v1 recovery wrap and its salt, is untouched.
    const { wrappedDekByPassword: _a, dekPasswordSalt: _b, ...restOld } = record;
    const { wrappedDekByPassword: _c, ...restSaved } = saved;
    assert.deepEqual(restSaved, restOld);
});

test('sign-in: a failed journal load writes nothing', async () => {
    const { record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const h = signInBox(record, 'password123', { loadOk: false });
    await h.run();
    assert.deepEqual(h.calls.events, ['load']);
    assert.deepEqual(h.calls.saved, []);
    assert.equal(h.calls.unlocked, 0);
});

test('sign-in: a wrong password writes nothing and never loads', async () => {
    const { record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const h = signInBox(record, 'password124');
    await h.run();
    assert.deepEqual(h.calls.errors, [['login-error', 'Incorrect username or password.']]);
    assert.deepEqual(h.calls.events, []);
});

test('sign-in: a v1 wrap that does not unwrap writes nothing and never loads', async () => {
    const { record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const broken = { ...record, wrappedDekByPassword: (await v1Account('other-password', 'X')).record.wrappedDekByPassword };
    const h = signInBox(broken, 'password123');
    await h.run();
    assert.equal(h.calls.errors.length, 1);
    assert.match(h.calls.errors[0][1], /Could not unlock encryption key/);
    assert.deepEqual(h.calls.events, []);
});

test('sign-in: no re-wrap when the stored record no longer holds that v1 wrap', async () => {
    const { record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const changed = { ...record, wrappedDekByPassword: await DekCrypto.wrapDekV2(DekCrypto.generateDek(), 'password123') };
    const h = signInBox(record, 'password123', { storedRecord: changed });
    await h.run();
    assert.deepEqual(h.calls.events, ['load']);
    assert.equal(h.calls.unlocked, 1);
});

test('sign-in: a failed re-wrap save is logged and sign-in still completes', async () => {
    const { dek, record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const h = signInBox(record, 'password123', { saveFails: true });
    await h.run();
    assert.deepEqual(h.calls.errors, []);
    assert.deepEqual(h.calls.events, ['load', 'save']);
    assert.equal(h.calls.unlocked, 1);
    assert.equal(h.g.sessionDek, dek);
});

test('sign-in: a v2 account (and a mixed v2 password / v1 recovery account) is not rewritten', async () => {
    const { dek, record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const mixed = { ...record, wrappedDekByPassword: await DekCrypto.wrapDekV2(dek, 'password123') };
    delete mixed.dekPasswordSalt;
    const h = signInBox(mixed, 'password123');
    await h.run();
    assert.deepEqual(h.calls.errors, []);
    assert.deepEqual(h.calls.events, ['load']);
    assert.equal(h.g.sessionDek, dek);
    const bad = signInBox(mixed, 'password124');
    await bad.run();
    assert.deepEqual(bad.calls.events, []);
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
        console: quiet,
    });
    return { run: () => box.fns.resetPassword(), calls };
}

test('reset: a v1 account ends with v2 password and recovery wraps of the same DEK', async () => {
    const { dek, record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const h = resetBox(record, 'abcd-efgh-jklm', 'newpassword1');
    await h.run();
    assert.deepEqual(h.calls.errors, []);
    assert.equal(h.calls.saved.length, 1);
    const saved = h.calls.saved[0];
    assert.ok(DekCrypto.isV2Wrap(saved.wrappedDekByPassword));
    assert.ok(DekCrypto.isV2Wrap(saved.wrappedDekByRecovery));
    assert.ok(!('dekPasswordSalt' in saved) && !('dekRecoverySalt' in saved));
    assert.equal(await unwrapPw(saved, 'newpassword1'), dek);
    assert.equal(await unwrapRk(saved, 'ABCD-EFGH-JKLM'), dek);
    assert.equal(await unwrapPw(saved, 'password123'), null);
});

test('reset: a recovery wrap that does not unwrap changes nothing', async () => {
    const { record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const broken = { ...record, wrappedDekByRecovery: (await v1Account('p', 'WXYZ-WXYZ-WXYZ')).record.wrappedDekByRecovery };
    const h = resetBox(broken, 'ABCD-EFGH-JKLM', 'newpassword1');
    await h.run();
    assert.deepEqual(h.calls.errors, [['forgot-error', 'Could not unlock encryption key with that recovery key.']]);
    assert.deepEqual(h.calls.saved, []);
});

test('reset: a mixed v2 password / v1 recovery account resets and ends all v2', async () => {
    const { dek, record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const mixed = { ...record, wrappedDekByPassword: await DekCrypto.wrapDekV2(dek, 'password123') };
    delete mixed.dekPasswordSalt;
    const h = resetBox(mixed, 'ABCD-EFGH-JKLM', 'newpassword1');
    await h.run();
    assert.deepEqual(h.calls.errors, []);
    const saved = h.calls.saved[0];
    assert.equal(await unwrapPw(saved, 'newpassword1'), dek);
    assert.equal(await unwrapRk(saved, 'ABCD-EFGH-JKLM'), dek);
    assert.ok(DekCrypto.isV2Wrap(saved.wrappedDekByRecovery));
});

// ── 4. Change password in Settings (changePassword) ────────────────────────

function changePwBox(record, dek, currentPw, newPw, recoveryKey) {
    const calls = { msgs: [], saved: [] };
    const box = sandbox([[SETTINGS, ['changePassword']]], {
        document: fakeDocument({
            'settings-current-pw': { value: currentPw }, 'settings-new-pw': { value: newPw }, 'settings-confirm-pw': { value: newPw },
        }),
        window: { showPromptModal: async () => recoveryKey },
        DekCrypto,
        sessionDek: dek,
        getAuthRecord: async () => clone(record),
        showSettingsMsg: (el, msg, isError) => calls.msgs.push([msg, !!isError]),
        saveAuthRecord: async r => { calls.saved.push(clone(r)); return r; },
        console: quiet,
    });
    return { run: () => box.fns.changePassword().catch(() => {}), calls };
}

test('change password: v2 password wrap, and v2 recovery wrap when the key is given', async () => {
    const { dek, record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const h = changePwBox(record, dek, 'password123', 'newpassword1', ' abcd-efgh-jklm ');
    await h.run();
    const saved = h.calls.saved[0];
    assert.ok(saved, 'record saved');
    assert.ok(DekCrypto.isV2Wrap(saved.wrappedDekByPassword));
    assert.ok(DekCrypto.isV2Wrap(saved.wrappedDekByRecovery));
    assert.ok(!('dekPasswordSalt' in saved) && !('dekRecoverySalt' in saved));
    assert.equal(await unwrapPw(saved, 'newpassword1'), dek);
    assert.equal(await unwrapRk(saved, 'ABCD-EFGH-JKLM'), dek);
});

test('change password without the recovery key: v2 password wrap, v1 recovery wrap kept and still works', async () => {
    const { dek, record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const h = changePwBox(record, dek, 'password123', 'newpassword1', null);
    await h.run();
    const saved = h.calls.saved[0];
    assert.ok(DekCrypto.isV2Wrap(saved.wrappedDekByPassword));
    assert.equal(saved.wrappedDekByRecovery, record.wrappedDekByRecovery);
    assert.equal(saved.dekRecoverySalt, record.dekRecoverySalt);
    assert.equal(await unwrapPw(saved, 'newpassword1'), dek);
    assert.deepEqual(await DekCrypto.unwrapDekAny(saved.wrappedDekByRecovery, saved.dekRecoverySalt, 'ABCD-EFGH-JKLM'), { dek, upgraded: true });
});

test('change password: a wrong current password or recovery key changes nothing', async () => {
    const { dek, record } = await v1Account('password123', 'ABCD-EFGH-JKLM');
    const badPw = changePwBox(record, dek, 'password124', 'newpassword1', null);
    await badPw.run();
    assert.deepEqual(badPw.calls.saved, []);
    const badKey = changePwBox(record, dek, 'password123', 'newpassword1', 'WXYZ-WXYZ-WXYZ');
    await badKey.run();
    assert.deepEqual(badKey.calls.saved, []);
});

// ── 5. No v1 wrap is written anywhere ──────────────────────────────────────

test('source: app code never writes a v1 wrap or reads one without unwrapDekAny', () => {
    for (const [name, src] of [['auth.js', AUTH], ['settings.js', SETTINGS], ['Denarii.js', APP]]) {
        assert.doesNotMatch(src, /DekCrypto\.(wrapDek|unwrapDek|deriveWrappingKey|generateSalt)\(/, name);
        // Only null, or a copy of an existing salt (JSON export), may be assigned.
        assert.doesNotMatch(src, /(dekPasswordSalt|dekRecoverySalt)\s*(=(?!=)|:)(?!\s*(null;|authData\.dekPasswordSalt;))/, name + ': no new salt is written');
    }
    assert.match(AUTH, /DekCrypto\.wrapDekV2\(dek, password\),\s*DekCrypto\.wrapDekV2\(dek, recoveryKey\)/);
});
