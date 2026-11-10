// electron/auto-signin.js under plain Node with a fake safeStorage:
// file round trip and atomic write, async-only safeStorage calls, old files
// re-encrypted, decrypt failure, ownership checks on disable, the
// once-per-process tryUnlock flag, input validation, and that the file is
// never part of a .sqlite backup.
// Run: node --test tests/auto-signin.test.js

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const auto = require('../electron/auto-signin');
const store = require('../electron/db');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-auto-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// Stands in for Electron safeStorage with only the async API, so any sync
// call (encryptString / decryptString / isEncryptionAvailable) throws.
// New blobs are 'FAKE2:'; 'FAKE1:' stands for a file written by an earlier
// Denarii with the sync encryptString, which decryptStringAsync still reads
// and flags shouldReEncrypt. Anything else rejects (as DPAPI does for
// another user's blob).
const xor = buf => Buffer.from(buf.map(b => b ^ 0x5a));
function legacyBlob(s) { return Buffer.concat([Buffer.from('FAKE1:'), xor(Buffer.from(s, 'utf8'))]); }
function fakeSafeStorage(opts) {
  const o = Object.assign({ available: true, backend: 'dpapi' }, opts);
  const calls = { encrypt: 0, decrypt: 0 };
  return {
    calls,
    isAsyncEncryptionAvailable: async () => o.available,
    getSelectedStorageBackend: () => o.backend,
    encryptStringAsync: async s => { calls.encrypt++; return Buffer.concat([Buffer.from('FAKE2:'), xor(Buffer.from(s, 'utf8'))]); },
    decryptStringAsync: async buf => {
      calls.decrypt++;
      const tag = Buffer.isBuffer(buf) ? buf.subarray(0, 6).toString() : '';
      if (tag !== 'FAKE1:' && tag !== 'FAKE2:') throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptStringAsync.');
      return { shouldReEncrypt: tag === 'FAKE1:', result: xor(buf.subarray(6)).toString('utf8') };
    },
  };
}
const plain = buf => xor(buf.subarray(6)).toString('utf8');

const dekHex = () => crypto.randomBytes(32).toString('hex');
const dekAccount = (id, extra) => Object.assign({ id, username: 'u_' + id, dekVersion: 1, wrappedDekByPassword: { v: 2 } }, extra);

function setup(t, opts) {
  const o = Object.assign({ accounts: {}, safeStorage: fakeSafeStorage(), platform: 'win32' }, opts);
  const dir = tempDir(t);
  const make = () => auto.createAutoSignIn({ dir, safeStorage: o.safeStorage, platform: o.platform, getAccount: id => o.accounts[id] || null });
  return { dir, accounts: o.accounts, safeStorage: o.safeStorage, make, a: make(), file: auto.filePath(dir) };
}

// ── File format ────────────────────────────────────────────────────────────

test('file lives directly in userData as auto-signin.dat, not in backups/', () => {
  const dir = path.join(os.tmpdir(), 'x');
  assert.equal(auto.filePath(dir), path.join(dir, 'auto-signin.dat'));
  assert.notEqual(path.dirname(auto.filePath(dir)), store.backupsDir(dir));
});

test('write / read round trip; content is the safeStorage blob of { v, accountId, dek, savedAt }', async (t) => {
  const s = setup(t);
  const dek = dekHex();
  await auto.write(s.dir, s.safeStorage, 'acct_1', dek, new Date('2026-11-09T12:00:00Z'));
  const raw = fs.readFileSync(s.file);
  assert.ok(!raw.includes(Buffer.from(dek)), 'DEK is not stored in the clear');
  assert.equal(raw.subarray(0, 6).toString(), 'FAKE2:', 'written with encryptStringAsync');
  assert.deepEqual(JSON.parse(plain(raw)), { v: 1, accountId: 'acct_1', dek, savedAt: '2026-11-09T12:00:00.000Z' });
  assert.deepEqual(await auto.read(s.dir, s.safeStorage), { status: 'ok', entry: { accountId: 'acct_1', dek, savedAt: '2026-11-09T12:00:00.000Z' } });
  assert.deepEqual(fs.readdirSync(s.dir), ['auto-signin.dat'], 'no .tmp left behind');
});

test('only async safeStorage calls are used (the fake has no sync methods)', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  for (const m of ['encryptString', 'decryptString', 'isEncryptionAvailable']) assert.equal(s.safeStorage[m], undefined);
  assert.equal(await auto.isAvailable(s.safeStorage, 'win32'), true);
  assert.deepEqual(await s.a.enable('acct_1', dekHex()), { ok: true });
  assert.equal((await s.a.status()).accountId, 'acct_1');
  assert.equal((await s.a.tryUnlock()).ok, true);
  assert.deepEqual(await s.a.disable('acct_1'), { ok: true, cleared: true });
});

test('source: no sync safeStorage calls remain in electron/', () => {
  const dir = path.join(__dirname, '..', 'electron');
  for (const f of fs.readdirSync(dir).filter(n => n.endsWith('.js'))) {
    const src = fs.readFileSync(path.join(dir, f), 'utf8');
    assert.doesNotMatch(src, /\.(encryptString|decryptString|isEncryptionAvailable)\s*\(/, f);
  }
});

test('atomic write: a failed write leaves the previous file intact and no .tmp', async (t) => {
  const s = setup(t);
  const dek = dekHex();
  await auto.write(s.dir, s.safeStorage, 'acct_1', dek);
  const broken = Object.assign({}, s.safeStorage, { encryptStringAsync: async () => { throw new Error('encrypt failed'); } });
  await assert.rejects(auto.write(s.dir, broken, 'acct_2', dekHex()), /encrypt failed/);
  // Rename fails when the target path is a directory: the tmp file is removed.
  const dir2 = tempDir(t);
  fs.mkdirSync(auto.filePath(dir2));
  await assert.rejects(auto.write(dir2, s.safeStorage, 'acct_1', dek));
  assert.ok(!fs.existsSync(auto.filePath(dir2) + '.tmp'));
  assert.equal((await auto.read(s.dir, s.safeStorage)).entry.accountId, 'acct_1');
});

test('read: missing file is none; undecryptable or invalid content is unreadable', async (t) => {
  const s = setup(t);
  assert.deepEqual(await auto.read(s.dir, s.safeStorage), { status: 'none' });
  fs.writeFileSync(s.file, 'garbage');
  assert.deepEqual(await auto.read(s.dir, s.safeStorage), { status: 'unreadable' });
  for (const entry of [{}, { v: 2, accountId: 'a', dek: dekHex() }, { v: 1, accountId: '', dek: dekHex() }, { v: 1, accountId: 'a', dek: 'XYZ' }]) {
    fs.writeFileSync(s.file, await s.safeStorage.encryptStringAsync(JSON.stringify(entry)));
    assert.deepEqual(await auto.read(s.dir, s.safeStorage), { status: 'unreadable' }, JSON.stringify(entry));
  }
  fs.writeFileSync(s.file, await s.safeStorage.encryptStringAsync('not json'));
  assert.deepEqual(await auto.read(s.dir, s.safeStorage), { status: 'unreadable' });
  // A decrypt result with no string is unreadable too.
  const odd = Object.assign({}, s.safeStorage, { decryptStringAsync: async () => ({ shouldReEncrypt: false }) });
  assert.deepEqual(await auto.read(s.dir, odd), { status: 'unreadable' });
});

// ── Files from earlier versions and re-encryption ─────────────────────────

test('an old file (sync encryptString) is read through decryptStringAsync and rewritten', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  const dek = dekHex();
  const savedAt = '2026-10-01T08:00:00.000Z';
  fs.writeFileSync(s.file, legacyBlob(JSON.stringify({ v: 1, accountId: 'acct_1', dek, savedAt })));
  assert.deepEqual(await s.a.tryUnlock(), { ok: true, accountId: 'acct_1', dek });
  const raw = fs.readFileSync(s.file);
  assert.equal(raw.subarray(0, 6).toString(), 'FAKE2:', 'shouldReEncrypt: file rewritten');
  assert.deepEqual(JSON.parse(plain(raw)), { v: 1, accountId: 'acct_1', dek, savedAt }, 'same entry, savedAt kept');
  assert.deepEqual(fs.readdirSync(s.dir), ['auto-signin.dat'], 'no .tmp left behind');
  // Next launch reads the new file without another rewrite.
  const before = s.safeStorage.calls.encrypt;
  assert.deepEqual(await s.make().tryUnlock(), { ok: true, accountId: 'acct_1', dek });
  assert.equal(s.safeStorage.calls.encrypt, before);
});

test('status on an old file also rewrites it; a failed rewrite keeps the old file', async (t) => {
  const s = setup(t);
  const dek = dekHex();
  const old = legacyBlob(JSON.stringify({ v: 1, accountId: 'acct_1', dek, savedAt: '2026-10-01T08:00:00.000Z' }));
  fs.writeFileSync(s.file, old);
  const noEncrypt = Object.assign({}, s.safeStorage, { encryptStringAsync: async () => { throw new Error('encrypt failed'); } });
  assert.deepEqual(await auto.read(s.dir, noEncrypt), { status: 'ok', entry: { accountId: 'acct_1', dek, savedAt: '2026-10-01T08:00:00.000Z' } });
  assert.deepEqual(fs.readFileSync(s.file), old, 'rewrite failed: old file untouched');
  assert.ok(!fs.existsSync(s.file + '.tmp'));
  assert.equal((await s.a.status()).accountId, 'acct_1');
  assert.equal(fs.readFileSync(s.file).subarray(0, 6).toString(), 'FAKE2:');
});

test('an old file with no savedAt is rewritten with one', async (t) => {
  const s = setup(t);
  const dek = dekHex();
  fs.writeFileSync(s.file, legacyBlob(JSON.stringify({ v: 1, accountId: 'acct_1', dek })));
  assert.equal((await auto.read(s.dir, s.safeStorage)).entry.savedAt, null);
  const rewritten = JSON.parse(plain(fs.readFileSync(s.file)));
  assert.equal(rewritten.dek, dek);
  assert.ok(Number.isFinite(Date.parse(rewritten.savedAt)));
});

// ── Availability ───────────────────────────────────────────────────────────

test('available only when async safeStorage can encrypt, and not with Linux basic_text', async () => {
  assert.equal(await auto.isAvailable(fakeSafeStorage(), 'win32'), true);
  assert.equal(await auto.isAvailable(fakeSafeStorage({ available: false }), 'win32'), false);
  assert.equal(await auto.isAvailable(fakeSafeStorage({ backend: 'basic_text' }), 'linux'), false);
  assert.equal(await auto.isAvailable(fakeSafeStorage({ backend: 'gnome_libsecret' }), 'linux'), true);
  assert.equal(await auto.isAvailable(fakeSafeStorage({ backend: 'basic_text' }), 'win32'), true, 'backend only matters on Linux');
  assert.equal(await auto.isAvailable({ isAsyncEncryptionAvailable: () => { throw new Error('x'); } }, 'win32'), false);
  assert.equal(await auto.isAvailable({ isAsyncEncryptionAvailable: async () => { throw new Error('x'); } }, 'win32'), false);
  assert.equal(await auto.isAvailable(null, 'win32'), false);
});

test('unavailable: status says so, enable refuses, tryUnlock returns unavailable', async (t) => {
  const s = setup(t, { safeStorage: fakeSafeStorage({ available: false }), accounts: { acct_1: dekAccount('acct_1') } });
  assert.deepEqual(await s.a.status(), { available: false, accountId: null, used: false });
  assert.equal((await s.a.enable('acct_1', dekHex())).ok, false);
  assert.ok(!fs.existsSync(s.file));
  assert.deepEqual(await s.a.tryUnlock(), { ok: false, reason: 'unavailable' });
});

// ── enable / status / disable ──────────────────────────────────────────────

test('enable writes the file; status reports the owner; a second account replaces the first', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1'), acct_2: dekAccount('acct_2') } });
  assert.deepEqual(await s.a.status(), { available: true, accountId: null, used: false });
  assert.deepEqual(await s.a.enable('acct_1', dekHex()), { ok: true });
  assert.deepEqual(await s.a.status(), { available: true, accountId: 'acct_1', used: false });
  assert.deepEqual(await s.a.enable('acct_2', dekHex()), { ok: true });
  assert.deepEqual(await s.a.status(), { available: true, accountId: 'acct_2', used: false });
});

test('enable validates input and refuses missing, legacy and cloud-linked accounts', async (t) => {
  const s = setup(t, { accounts: {
    acct_ok: dekAccount('acct_ok'),
    acct_legacy: { id: 'acct_legacy', username: 'old' },
    acct_cloud: dekAccount('acct_cloud', { supabaseUid: 'uid-1' }),
  } });
  for (const id of [undefined, null, '', 42, {}, 'a'.repeat(129)]) {
    assert.deepEqual(await s.a.enable(id, dekHex()), { ok: false, error: 'Invalid account id.' }, String(id));
  }
  for (const dek of [undefined, '', 'abc', 'A'.repeat(64), 'g'.repeat(64), dekHex() + '0', 42]) {
    assert.deepEqual(await s.a.enable('acct_ok', dek), { ok: false, error: 'Invalid key.' }, String(dek));
  }
  for (const id of ['acct_missing', 'acct_legacy', 'acct_cloud']) {
    assert.deepEqual(await s.a.enable(id, dekHex()), { ok: false, error: 'This account cannot use automatic sign-in.' }, id);
  }
  assert.ok(!fs.existsSync(s.file));
  assert.ok((await s.a.enable('a'.repeat(128), dekHex())).ok === false, '128 chars is valid but the account must exist');
});

test('enable reports an encrypt failure and writes nothing', async (t) => {
  const ss = Object.assign(fakeSafeStorage(), { encryptStringAsync: async () => { throw new Error('encrypt failed'); } });
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') }, safeStorage: ss });
  assert.deepEqual(await s.a.enable('acct_1', dekHex()), { ok: false, error: 'encrypt failed' });
  assert.ok(!fs.existsSync(s.file));
});

test('disable(accountId) clears only when that account owns the file; disable() always clears', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  await s.a.enable('acct_1', dekHex());
  assert.deepEqual(await s.a.disable('acct_2'), { ok: true, cleared: false });
  assert.ok(fs.existsSync(s.file), 'wrong owner: file kept');
  assert.deepEqual(await s.a.disable(''), { ok: false, error: 'Invalid account id.' });
  assert.ok(fs.existsSync(s.file));
  assert.deepEqual(await s.a.disable('acct_1'), { ok: true, cleared: true });
  assert.ok(!fs.existsSync(s.file));

  await s.a.enable('acct_1', dekHex());
  assert.deepEqual(await s.a.disable(), { ok: true, cleared: true });
  assert.ok(!fs.existsSync(s.file));
  assert.deepEqual(await s.a.disable(null), { ok: true, cleared: true }, 'no file: still ok');
});

test('disable(accountId) keeps an unreadable file (owner unknown); tryUnlock removes it', async (t) => {
  const s = setup(t);
  fs.writeFileSync(s.file, 'from another Windows user');
  assert.deepEqual(await s.a.disable('acct_1'), { ok: true, cleared: false });
  assert.ok(fs.existsSync(s.file));
  assert.deepEqual(await s.a.tryUnlock(), { ok: false, reason: 'decrypt-failed' });
  assert.ok(!fs.existsSync(s.file));
});

test('overlapping calls run in order: a re-encrypt from status never overwrites a newer enable', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1'), acct_2: dekAccount('acct_2') } });
  fs.writeFileSync(s.file, legacyBlob(JSON.stringify({ v: 1, accountId: 'acct_1', dek: dekHex(), savedAt: '2026-10-01T08:00:00.000Z' })));
  const dek2 = dekHex();
  const [st, en] = await Promise.all([s.a.status(), s.a.enable('acct_2', dek2)]);
  assert.equal(st.accountId, 'acct_1');
  assert.deepEqual(en, { ok: true });
  assert.equal((await auto.read(s.dir, s.safeStorage)).entry.accountId, 'acct_2');
  assert.equal(JSON.parse(plain(fs.readFileSync(s.file))).dek, dek2);
});

// ── tryUnlock ──────────────────────────────────────────────────────────────

test('tryUnlock returns the DEK once per process; later calls are "used"', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  const dek = dekHex();
  await s.a.enable('acct_1', dek);
  assert.deepEqual(await s.a.tryUnlock(), { ok: true, accountId: 'acct_1', dek });
  assert.deepEqual(await s.a.tryUnlock(), { ok: false, reason: 'used' }, 'Lock / reload');
  assert.deepEqual(await s.a.tryUnlock(), { ok: false, reason: 'used' });
  assert.ok(fs.existsSync(s.file), 'file kept for the next launch');
  // Next launch (new process) signs in again.
  assert.deepEqual(await s.make().tryUnlock(), { ok: true, accountId: 'acct_1', dek });
});

test('overlapping tryUnlock calls: only the first can succeed (flag set before any await)', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  const dek = dekHex();
  await s.a.enable('acct_1', dek);
  const decrypts = s.safeStorage.calls.decrypt;
  const p1 = s.a.tryUnlock();
  const p2 = s.a.tryUnlock();
  assert.deepEqual(await Promise.all([p1, p2]), [{ ok: true, accountId: 'acct_1', dek }, { ok: false, reason: 'used' }]);
  assert.equal(s.safeStorage.calls.decrypt, decrypts + 1, 'the second call never decrypts');
});

test('status reports used once tryUnlock has run in this process', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  await s.a.enable('acct_1', dekHex());
  assert.equal((await s.a.status()).used, false);
  await s.a.tryUnlock();
  assert.deepEqual(await s.a.status(), { available: true, accountId: 'acct_1', used: true }, 'after Lock / reload');
  assert.equal((await s.make().status()).used, false, 'next launch');
});

test('the first call sets the flag even when it fails', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  assert.deepEqual(await s.a.tryUnlock(), { ok: false, reason: 'none' });
  await s.a.enable('acct_1', dekHex());
  assert.deepEqual(await s.a.tryUnlock(), { ok: false, reason: 'used' });
});

test('tryUnlock: missing file is none and nothing is deleted', async (t) => {
  const s = setup(t);
  assert.deepEqual(await s.a.tryUnlock(), { ok: false, reason: 'none' });
});

test('tryUnlock: a rejected decryptStringAsync deletes the file (password screen next)', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  await auto.write(s.dir, s.safeStorage, 'acct_1', dekHex());
  const otherUser = Object.assign({}, s.safeStorage, { decryptStringAsync: async () => { throw new Error('DPAPI'); } });
  const a = auto.createAutoSignIn({ dir: s.dir, safeStorage: otherUser, platform: 'win32', getAccount: id => s.accounts[id] || null });
  assert.deepEqual(await a.tryUnlock(), { ok: false, reason: 'decrypt-failed' });
  assert.ok(!fs.existsSync(s.file));
  assert.ok(!fs.existsSync(s.file + '.tmp'));
});

test('tryUnlock: an old file that no longer decrypts is deleted too', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  fs.writeFileSync(s.file, legacyBlob(JSON.stringify({ v: 1, accountId: 'acct_1', dek: dekHex() })));
  const noLegacy = Object.assign({}, s.safeStorage, { decryptStringAsync: async () => { throw new Error('unknown format'); } });
  const a = auto.createAutoSignIn({ dir: s.dir, safeStorage: noLegacy, platform: 'win32', getAccount: id => s.accounts[id] || null });
  assert.deepEqual(await a.tryUnlock(), { ok: false, reason: 'decrypt-failed' });
  assert.ok(!fs.existsSync(s.file));
});

test('tryUnlock: a deleted account is account-missing and the file is deleted', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  await s.a.enable('acct_1', dekHex());
  delete s.accounts.acct_1;
  assert.deepEqual(await s.make().tryUnlock(), { ok: false, reason: 'account-missing' });
  assert.ok(!fs.existsSync(s.file));
});

test('tryUnlock: an account lookup that throws counts as missing', async (t) => {
  const s = setup(t);
  await auto.write(s.dir, s.safeStorage, 'acct_1', dekHex());
  const a = auto.createAutoSignIn({ dir: s.dir, safeStorage: s.safeStorage, platform: 'win32', getAccount: () => { throw new Error('closed'); } });
  assert.deepEqual(await a.tryUnlock(), { ok: false, reason: 'account-missing' });
  assert.ok(!fs.existsSync(s.file));
});

test('tryUnlock: legacy or cloud-linked account is not-eligible and the file is deleted', async (t) => {
  for (const record of [{ id: 'acct_1', username: 'old' }, dekAccount('acct_1', { supabaseUid: 'uid' })]) {
    const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
    await s.a.enable('acct_1', dekHex());
    s.accounts.acct_1 = record;
    assert.deepEqual(await s.make().tryUnlock(), { ok: false, reason: 'not-eligible' });
    assert.ok(!fs.existsSync(s.file));
  }
});

// ── Backups never include it ───────────────────────────────────────────────

test('.sqlite backups (manual and automatic) never contain the auto sign-in file', async (t) => {
  const s = setup(t, { accounts: { acct_1: dekAccount('acct_1') } });
  const { db } = store.openDatabase(s.dir);
  const manual = path.join(s.dir, 'manual.sqlite');
  const dek = dekHex();
  let autoB;
  try {
    store.createKv(db).put('auth', 'account:acct_1', dekAccount('acct_1'));
    await s.a.enable('acct_1', dek);
    store.backupTo(db, s.dir, manual);
    autoB = store.autoBackup(db, s.dir);
  } finally {
    store.closeDatabase(db); // before the temp folder is removed (Windows locks open files)
  }
  const blob = fs.readFileSync(s.file);
  for (const file of [manual, autoB]) {
    const bytes = fs.readFileSync(file);
    assert.ok(!bytes.includes(blob), file + ' contains the protected blob');
    assert.ok(!bytes.includes(Buffer.from(dek)), file + ' contains the DEK');
  }
  assert.ok(!fs.readdirSync(store.backupsDir(s.dir)).includes(auto.FILE));
});

// ── main.js wiring (source checks; the app is not launched in tests) ───────

test('main.js: guarded IPC, clears on restore and corrupt-database recovery; preload exposes four calls', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', 'electron', 'main.js'), 'utf8');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.js'), 'utf8');
  for (const name of ['status', 'enable', 'disable', 'tryUnlock']) {
    assert.match(main, new RegExp("ipcMain\\.handle\\('denarii-autosignin:" + name + "', \\(event[^)]*\\) => \\{ guard\\(event\\);"));
    assert.match(preload, new RegExp(name + ': .*ipcRenderer\\.invoke\\(\'denarii-autosignin:' + name + "'"));
  }
  const restore = main.slice(main.indexOf("'denarii-store:restoreFrom'"), main.indexOf("'denarii-store:openBackupsFolder'"));
  assert.ok(restore.indexOf('autoSignInFile.clear(dir)') > 0 && restore.indexOf('autoSignInFile.clear(dir)') < restore.indexOf('app.relaunch()'));
  const recover = main.slice(main.indexOf('store.quarantine(dir)'), main.indexOf('store.restoreAutoBackup'));
  assert.match(recover, /autoSignInFile\.clear\(dir\)/);
  assert.match(main, /registerStoreIpc\(\);\s*registerAutoSignInIpc\(\);/);
});
