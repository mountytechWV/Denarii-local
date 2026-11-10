// electron/db.js under plain Node (node:sqlite): schema, key-value
// round-trips, validation, automatic backups and rejection of bad files.
// Run: npm run test:db

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { DatabaseSync } = require('node:sqlite');
const store = require('../electron/db');

// Each test gets its own userData-like folder; open handles are closed
// before removal (Windows keeps open SQLite files locked).
function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-db-'));
  const open = [];
  t.after(() => {
    for (const db of open) store.closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, track: db => { open.push(db); return db; } };
}

function openKv(t) {
  const { dir, track } = tempDir(t);
  const r = store.openDatabase(dir);
  track(r.db);
  return { dir, db: r.db, status: r.status, kv: store.createKv(r.db), track };
}

const randomB64 = n => crypto.randomBytes(n).toString('base64');
const hex = n => crypto.randomBytes(n).toString('hex');

// Shapes taken from js/auth.js (saveAuthRecord / createNewJournal) and
// saveJournalRecord: encrypted strings, hashes, nulls, nested objects.
function accountRecord() {
  return {
    id: 'acct_' + hex(8),
    username: 'trader-ü-数据',
    passwordHash: hex(32),
    recoveryHash: hex(32),
    wrappedDekByPassword: randomB64(96),
    dekPasswordSalt: randomB64(16),
    wrappedDekByRecovery: randomB64(96),
    dekRecoverySalt: randomB64(16),
    dekVersion: 1,
    storageMode: 'local_legacy',
    supabaseUid: null,
    legalAcceptedVersion: '2026.05',
    legalAcceptedAt: '2026-11-09T10:15:00.000Z',
    createdAt: '2026-11-09T10:14:59.123Z',
  };
}

function journalRecord() {
  return {
    data: 'v2:' + randomB64(300000),           // ~400 KB encrypted journal blob
    recoveryData: 'v2:' + randomB64(50000),
    recoveryDataSavedAt: '2026-11-09T10:20:00.000Z',
    lastBackup: null,
    savedAt: 1762683600123,
    meta: { trades: 1234, tags: ['a', 'b', ''], nested: { deep: [1, -2.5, 0, null, { x: true }] } },
  };
}

test('new folder: creates the schema, file header and WAL mode', (t) => {
  const { dir, db, status } = openKv(t);
  assert.equal(status, 'created');
  assert.equal(db.prepare('PRAGMA application_id').get().application_id, 0x44454E41);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.equal(db.prepare('PRAGMA journal_mode').get().journal_mode, 'wal');
  assert.equal(db.prepare('PRAGMA synchronous').get().synchronous, 2); // FULL
  assert.equal(db.prepare('PRAGMA busy_timeout').get().timeout, 3000);
  assert.ok(fs.existsSync(path.join(dir, 'denarii.sqlite')));
});

test('existing database reopens with status ok and keeps its data', (t) => {
  const { dir, track } = tempDir(t);
  const first = store.openDatabase(dir);
  store.createKv(first.db).put('settings', 'activeAccountId', 'acct_1');
  store.closeDatabase(first.db);
  const again = store.openDatabase(dir);
  track(again.db);
  assert.equal(again.status, 'ok');
  assert.equal(store.createKv(again.db).get('settings', 'activeAccountId'), 'acct_1');
});

test('an empty (0-byte) file is treated as new', (t) => {
  const { dir, track } = tempDir(t);
  fs.writeFileSync(path.join(dir, 'denarii.sqlite'), '');
  const r = store.openDatabase(dir);
  track(r.db);
  assert.equal(r.status, 'created');
});

test('round-trips a realistic account record and journal record', (t) => {
  const { kv } = openKv(t);
  const acct = accountRecord();
  const jr = journalRecord();
  kv.put('auth', 'account:' + acct.id, acct);
  kv.put('auth', 'username:' + acct.username, acct.id);
  kv.put('journal', 'journal:' + acct.id, jr);
  assert.deepEqual(kv.get('auth', 'account:' + acct.id), acct);
  assert.equal(kv.get('auth', 'username:' + acct.username), acct.id);
  assert.deepEqual(kv.get('journal', 'journal:' + acct.id), jr);
});

test('round-trips the setting value types the app uses', (t) => {
  const { kv } = openKv(t);
  const values = {
    dashVisibleCols: ['date', 'symbol', 'pnl'],
    dashRememberLastView: false,
    multiAccountMigrated: true,
    dashLastView: 'calendar',
    activeAccountId: null,
    backfillProgress_v1: { done: 12, total: 40, at: 1762683600123 },
    'strategyRename:acct_1': { strategyId: '7', oldName: 'Gap & Go', newName: 'Gap "Go"', phase: 'forward' },
    'cloudConflicts:acct_1': [],
    'gemini-api-key:acct_1': 'v2:' + randomB64(64),
    emptyString: '',
    emptyObject: {},
    numbers: [0, -1, 1.5, 1e21, Number.MAX_SAFE_INTEGER],
    unicode: 'emoji 🎯 and   line separator and "quotes" \\ backslash',
  };
  for (const [k, v] of Object.entries(values)) kv.put('settings', k, v);
  for (const [k, v] of Object.entries(values)) assert.deepEqual(kv.get('settings', k), v, k);
});

test('documents values that JSON does not keep exactly', (t) => {
  const { kv } = openKv(t);
  kv.put('settings', 'u', undefined);
  assert.equal(kv.get('settings', 'u'), null, 'top-level undefined is stored as null');
  kv.put('settings', 'o', { a: 1, gone: undefined });
  assert.deepEqual(kv.get('settings', 'o'), { a: 1 }, 'undefined properties are dropped');
  kv.put('settings', 'n', [NaN, Infinity, -0]);
  assert.deepEqual(kv.get('settings', 'n'), [null, null, 0], 'NaN/Infinity become null, -0 becomes 0');
  const d = new Date('2026-11-09T10:00:00.000Z');
  kv.put('settings', 'd', d);
  assert.equal(kv.get('settings', 'd'), '2026-11-09T10:00:00.000Z', 'Date becomes its ISO string');
});

test('missing key returns null; delete removes; getAllKeys is sorted and per store', (t) => {
  const { kv } = openKv(t);
  assert.equal(kv.get('journal', 'journal:none'), null);
  kv.put('journal', 'snapshot:a:2026-11-09T10:00:00.000Z', { x: 1 });
  kv.put('journal', 'journal:a', { x: 2 });
  kv.put('journal', 'cloudload:a:2026-11-08T10:00:00.000Z', { x: 3 });
  kv.put('settings', 'journal:a', 'other store');
  assert.deepEqual(kv.getAllKeys('journal'), [
    'cloudload:a:2026-11-08T10:00:00.000Z',
    'journal:a',
    'snapshot:a:2026-11-09T10:00:00.000Z',
  ]);
  kv.put('journal', 'journal:a', { x: 4 });
  assert.deepEqual(kv.get('journal', 'journal:a'), { x: 4 }, 'put overwrites');
  kv.delete('journal', 'journal:a');
  assert.equal(kv.get('journal', 'journal:a'), null);
  kv.delete('journal', 'journal:a'); // deleting a missing key is fine
  assert.equal(kv.get('settings', 'journal:a'), 'other store');
});

test('rejects invalid store, key and oversized values', (t) => {
  const { kv } = openKv(t);
  assert.throws(() => kv.get('other', 'k'), /Invalid store/);
  assert.throws(() => kv.put('Journal', 'k', 1), /Invalid store/);
  assert.throws(() => kv.getAllKeys(undefined), /Invalid store/);
  assert.throws(() => kv.get('settings', ''), /Invalid key/);
  assert.throws(() => kv.get('settings', 42), /Invalid key/);
  assert.throws(() => kv.put('settings', 'k'.repeat(513), 1), /Invalid key/);
  kv.put('settings', 'k'.repeat(512), 1);
  assert.throws(() => kv.put('settings', 'big', 'x'.repeat(store.MAX_VALUE_BYTES)), /too large/);
  assert.equal(kv.get('settings', 'big'), null);
});

test('automatic backup: VACUUM INTO gives a file that passes quick_check', (t) => {
  const { dir, db, kv } = openKv(t);
  assert.equal(store.autoBackup(db, dir, new Date(2026, 10, 9, 8, 0, 0)), null, 'skipped when kv is empty');
  const acct = accountRecord();
  kv.put('auth', 'account:' + acct.id, acct);
  const file = store.autoBackup(db, dir, new Date(2026, 10, 9, 8, 0, 1));
  assert.equal(path.basename(file), 'auto-20261109-080001.sqlite');
  assert.deepEqual(store.inspectFile(file), { ok: true });
  const copy = new DatabaseSync(file, { readOnly: true });
  try {
    assert.equal(copy.prepare('PRAGMA quick_check').get().quick_check, 'ok');
    assert.deepEqual(JSON.parse(copy.prepare("SELECT value FROM kv WHERE store='auth'").get().value), acct);
  } finally {
    copy.close();
  }
  assert.equal(store.autoBackup(db, dir, new Date(2026, 10, 9, 8, 0, 1)), null, 'one backup per second');
});

test('only the newest 5 automatic backups are kept', (t) => {
  const { dir, db, kv } = openKv(t);
  kv.put('settings', 'x', 1);
  for (let i = 0; i < 7; i++) store.autoBackup(db, dir, new Date(2026, 10, 1 + i, 9, 0, 0));
  fs.writeFileSync(path.join(store.backupsDir(dir), 'pre-restore-keep.sqlite'), 'not an auto backup');
  assert.deepEqual(store.listAutoBackups(dir).map(b => b.name), [
    'auto-20261107-090000.sqlite',
    'auto-20261106-090000.sqlite',
    'auto-20261105-090000.sqlite',
    'auto-20261104-090000.sqlite',
    'auto-20261103-090000.sqlite',
  ]);
  assert.ok(fs.existsSync(path.join(store.backupsDir(dir), 'pre-restore-keep.sqlite')), 'other files untouched');
});

test('a random file is rejected and left unchanged', (t) => {
  const { dir } = tempDir(t);
  const file = path.join(dir, 'denarii.sqlite');
  const junk = crypto.randomBytes(8192);
  fs.writeFileSync(file, junk);
  const check = store.inspectFile(file);
  assert.equal(check.ok, false);
  assert.equal(check.kind, 'corrupt');
  assert.throws(() => store.openDatabase(dir), e => e.kind === 'corrupt');
  assert.deepEqual(fs.readFileSync(file), junk, 'never overwritten');
});

test('a SQLite file with the wrong application_id is rejected', (t) => {
  const { dir } = tempDir(t);
  const file = path.join(dir, 'denarii.sqlite');
  const other = new DatabaseSync(file);
  other.exec("CREATE TABLE kv (store TEXT, key TEXT, value TEXT, updated_at INTEGER); PRAGMA application_id = 1234; PRAGMA user_version = 1");
  other.close();
  assert.match(store.inspectFile(file).reason, /wrong application id/);
  assert.throws(() => store.openDatabase(dir), e => e.kind === 'corrupt');
});

test('a Denarii file without the kv table, or from a newer version, is rejected', (t) => {
  const { dir } = tempDir(t);
  const file = path.join(dir, 'denarii.sqlite');
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE other (a); PRAGMA application_id = ' + store.APP_ID + '; PRAGMA user_version = 1');
  assert.throws(() => store.openDatabase(dir), e => e.kind === 'corrupt' && /kv table/.test(e.message));
  db.exec('PRAGMA user_version = 3');
  db.close();
  assert.throws(() => store.openDatabase(dir), e => e.kind === 'newer' && e.message === 'This data was saved by a newer Denarii');
});

test('quarantine moves the file aside; restoreAutoBackup puts a backup in place', (t) => {
  const { dir, track } = tempDir(t);
  const first = store.openDatabase(dir);
  store.createKv(first.db).put('settings', 'activeAccountId', 'acct_9');
  const backup = store.autoBackup(first.db, dir, new Date(2026, 10, 9, 7, 0, 0));
  store.closeDatabase(first.db);
  fs.writeFileSync(store.dbPath(dir), crypto.randomBytes(4096)); // damage it
  const moved = store.quarantine(dir, new Date(2026, 10, 9, 7, 30, 0));
  assert.equal(path.basename(moved), 'denarii.corrupt-20261109-073000.sqlite');
  assert.ok(!fs.existsSync(store.dbPath(dir)));
  assert.throws(() => store.restoreAutoBackup(dir, moved), e => e.kind === 'corrupt', 'a bad backup is refused');
  store.restoreAutoBackup(dir, backup);
  const r = store.openDatabase(dir);
  track(r.db);
  assert.equal(r.status, 'ok');
  assert.equal(store.createKv(r.db).get('settings', 'activeAccountId'), 'acct_9');
  assert.throws(() => store.restoreAutoBackup(dir, backup), /EEXIST/, 'never overwrites an existing database');
});

test('closeDatabase checkpoints the WAL into the main file', (t) => {
  const { dir } = tempDir(t);
  const r = store.openDatabase(dir);
  store.createKv(r.db).put('journal', 'journal:a', journalRecord());
  store.closeDatabase(r.db);
  const wal = store.dbPath(dir) + '-wal';
  assert.ok(!fs.existsSync(wal) || fs.statSync(wal).size === 0, 'WAL empty after close');
  assert.deepEqual(store.inspectFile(store.dbPath(dir)), { ok: true });
});

// ── Manual backup and restore (Step 4c) ──────────────────────────────────

function folderFiles(dir) {
  return fs.readdirSync(dir).sort();
}

test('backupTo writes a valid, complete copy and leaves no temp file', (t) => {
  const { dir, db, kv } = openKv(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const acct = accountRecord();
  kv.put('auth', 'account:' + acct.id, acct);
  const target = path.join(out, 'Denarii-backup-2026-11-09.sqlite');
  assert.equal(store.backupTo(db, dir, target), target);
  assert.deepEqual(folderFiles(out), ['Denarii-backup-2026-11-09.sqlite']);
  assert.deepEqual(store.validateBackup(target), { ok: true });
  const copy = new DatabaseSync(target, { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(copy.prepare("SELECT value FROM kv WHERE store='auth'").get().value), acct);
  } finally {
    copy.close();
  }
  kv.put('settings', 'later', 2);
  store.backupTo(db, dir, target); // overwrite an earlier backup
  assert.deepEqual(folderFiles(out), ['Denarii-backup-2026-11-09.sqlite']);
});

test('backupTo failure never leaves a partial file at the chosen path', (t) => {
  const { dir, db, kv } = openKv(t);
  kv.put('settings', 'x', 1);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  assert.throws(() => store.backupTo(db, dir, path.join(out, 'missing-folder', 'b.sqlite')), /Folder not found/);
  // A folder already sits at the target name: the final rename fails.
  const blocked = path.join(out, 'blocked.sqlite');
  fs.mkdirSync(blocked);
  fs.writeFileSync(path.join(blocked, 'keep.txt'), 'x');
  assert.throws(() => store.backupTo(db, dir, blocked));
  assert.deepEqual(folderFiles(out), ['blocked.sqlite'], 'temp file removed');
  assert.deepEqual(fs.readdirSync(blocked), ['keep.txt'], 'target left as it was');
  assert.throws(() => store.backupTo(db, dir, store.dbPath(dir)), /live Denarii database/);
});

test('validateBackup rejects a random file, a wrong application_id and a newer version', (t) => {
  const { dir } = tempDir(t);
  const junk = path.join(dir, 'junk.sqlite');
  fs.writeFileSync(junk, crypto.randomBytes(8192));
  assert.equal(store.validateBackup(junk).ok, false);
  assert.equal(store.validateBackup(path.join(dir, 'none.sqlite')).ok, false);

  const wrongId = path.join(dir, 'wrong-id.sqlite');
  const a = new DatabaseSync(wrongId);
  a.exec("CREATE TABLE kv (store TEXT, key TEXT, value TEXT, updated_at INTEGER); PRAGMA application_id = 7; PRAGMA user_version = 1");
  a.close();
  assert.match(store.validateBackup(wrongId).reason, /wrong application id/);

  const newer = path.join(dir, 'newer.sqlite');
  const b = new DatabaseSync(newer);
  b.exec("CREATE TABLE kv (store TEXT, key TEXT, value TEXT, updated_at INTEGER); PRAGMA application_id = " + store.APP_ID + "; PRAGMA user_version = 3");
  b.close();
  const v = store.validateBackup(newer);
  assert.equal(v.ok, false);
  assert.equal(v.kind, 'newer');
});

test('restoreFrom replaces the data and keeps a pre-restore copy', (t) => {
  const { dir, track } = tempDir(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const first = store.openDatabase(dir);
  const kv = store.createKv(first.db);
  kv.put('journal', 'journal:a', { trades: 1 });
  const backup = store.backupTo(first.db, dir, path.join(out, 'b.sqlite'));
  kv.put('journal', 'journal:a', { trades: 2 });

  const r = store.restoreFrom(first.db, dir, backup, new Date(2026, 10, 9, 12, 0, 0));
  assert.equal(path.basename(r.safetyCopy), 'pre-restore-20261109-120000.sqlite');
  assert.ok(!fs.existsSync(store.dbPath(dir) + '.tmp'));
  assert.ok(!fs.existsSync(store.dbPath(dir) + '-wal'));

  const again = store.openDatabase(dir);
  track(again.db);
  assert.equal(again.status, 'ok');
  assert.deepEqual(store.createKv(again.db).get('journal', 'journal:a'), { trades: 1 }, 'backup data is live');

  const safe = new DatabaseSync(r.safetyCopy, { readOnly: true });
  try {
    assert.deepEqual(JSON.parse(safe.prepare("SELECT value FROM kv WHERE key='journal:a'").get().value), { trades: 2 }, 'pre-restore copy has the replaced data');
  } finally {
    safe.close();
  }
  assert.deepEqual(fs.readFileSync(backup).length > 0, true, 'chosen backup file untouched');
});

test('restoreFrom keeps only the newest 3 pre-restore copies', (t) => {
  const { dir, track } = tempDir(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  let cur = store.openDatabase(dir).db;
  store.createKv(cur).put('settings', 'x', 1);
  const backup = store.backupTo(cur, dir, path.join(out, 'b.sqlite'));
  const made = [];
  for (let i = 0; i < 5; i++) {
    const r = store.restoreFrom(cur, dir, backup, new Date(2026, 10, 1 + i, 9, 0, 0));
    made.push(path.basename(r.safetyCopy));
    // distinct mtimes so "newest" is unambiguous
    const tsec = new Date(2026, 10, 1 + i, 9, 0, 0).getTime() / 1000;
    fs.utimesSync(r.safetyCopy, tsec, tsec);
    cur = store.openDatabase(dir).db;
  }
  track(cur);
  assert.deepEqual(store.listPreRestore(dir).map(f => f.name), made.slice(2).reverse());
});

test('a failed restore leaves the current database unchanged and open', (t) => {
  const { dir, db, kv } = openKv(t);
  kv.put('journal', 'journal:a', { trades: 7 });
  const junk = path.join(os.tmpdir(), 'denarii-junk-' + process.pid + '.sqlite');
  fs.writeFileSync(junk, crypto.randomBytes(8192));
  t.after(() => fs.rmSync(junk, { force: true }));
  const before = kv.getAllKeys('journal');

  assert.throws(() => store.restoreFrom(db, dir, junk), e => !e.dbClosed && /Not a usable Denarii backup/.test(e.message));
  assert.throws(() => store.restoreFrom(db, dir, store.dbPath(dir)), /live Denarii database/);

  assert.deepEqual(kv.get('journal', 'journal:a'), { trades: 7 }, 'data unchanged; connection still open');
  assert.deepEqual(kv.getAllKeys('journal'), before);
  assert.equal(store.listPreRestore(dir).length, 0, 'no safety copy for a rejected file');
  assert.ok(!fs.existsSync(store.dbPath(dir) + '.tmp'));
});

test('a restore that fails after closing (rename blocked) leaves the live file intact', { skip: process.platform !== 'win32' && 'needs Windows file locking' }, (t) => {
  const { dir, track } = tempDir(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const first = store.openDatabase(dir);
  const kv = store.createKv(first.db);
  kv.put('journal', 'journal:a', { trades: 1 });
  const backup = store.backupTo(first.db, dir, path.join(out, 'b.sqlite'));
  kv.put('journal', 'journal:a', { trades: 2 });

  // Another handle on the live file makes the final rename fail on Windows.
  const holder = new DatabaseSync(store.dbPath(dir), { readOnly: true });
  holder.prepare('SELECT count(*) FROM kv').get();
  let err;
  try {
    store.restoreFrom(first.db, dir, backup);
  } catch (e) {
    err = e;
  } finally {
    holder.close();
  }
  assert.ok(err && err.dbClosed === true, 'error reports the database was closed');
  assert.ok(!fs.existsSync(store.dbPath(dir) + '.tmp'), 'temp copy removed');
  const again = store.openDatabase(dir); // what main.js does on dbClosed
  track(again.db);
  assert.deepEqual(store.createKv(again.db).get('journal', 'journal:a'), { trades: 2 }, 'live data unchanged');
});
