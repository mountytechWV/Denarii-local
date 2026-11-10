// Schema version 2 (Webull tables) in electron/db.js and the row accessors
// in electron/webull/store.js: the version 1 -> 2 upgrade, a restored
// version 1 backup, the "newer" check, per-account isolation, the one-journal
// per Webull account rule and account deletion.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const store = require('../electron/db');
const { createWebullStore, LinkConflictError } = require('../electron/webull/store');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-wb-'));
  const open = [];
  t.after(() => {
    for (const db of open) store.closeDatabase(db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, track: db => { open.push(db); return db; } };
}

// A database exactly as schema version 1 created it.
function writeVersion1(file, rows) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec(
    "CREATE TABLE kv (store TEXT NOT NULL CHECK (store IN ('journal','auth','settings')), " +
    'key TEXT NOT NULL, value TEXT NOT NULL, updated_at INTEGER NOT NULL, PRIMARY KEY (store, key)) WITHOUT ROWID'
  );
  db.exec('PRAGMA application_id = ' + store.APP_ID);
  db.exec('PRAGMA user_version = 1');
  const put = db.prepare('INSERT INTO kv (store, key, value, updated_at) VALUES (?, ?, ?, ?)');
  for (const [s, k, v] of rows || []) put.run(s, k, JSON.stringify(v), 1);
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
  db.close();
}

const tableNames = db => db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table','trigger') ORDER BY name").all().map(r => r.name);

function openStore(t) {
  const { dir, track } = tempDir(t);
  const r = store.openDatabase(dir);
  track(r.db);
  return { dir, db: r.db, kv: store.createKv(r.db), wb: createWebullStore(() => r.db) };
}

function connectionFields(extra) {
  return Object.assign({
    creds: Buffer.from('creds-blob'), token: Buffer.from('token-blob'), appKeyLast4: 'ab12',
    approvalState: 'ok', webullAccounts: [{ id: 'W1', label: 'Cash' }], defaultStartDate: null,
  }, extra || {});
}

test('a new database is created at version 2 with both Webull tables and the trigger', (t) => {
  const { db } = openStore(t);
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 2);
  const names = tableNames(db);
  for (const n of ['kv', 'webull_connection', 'webull_link', 'webull_account_deleted']) assert.ok(names.includes(n), n);
});

test('version 1 upgrades to 2 after an automatic backup of the unchanged file, keeping kv data', (t) => {
  const { dir, track } = tempDir(t);
  writeVersion1(path.join(dir, 'denarii.sqlite'), [['auth', 'account:a1', { id: 'a1' }], ['settings', 'x', 5]]);
  const r = store.openDatabase(dir, new Date(2026, 10, 10, 9, 0, 0));
  track(r.db);
  assert.equal(r.status, 'ok');
  assert.equal(r.migratedFrom, 1);
  assert.ok(r.preMigrationBackup && fs.existsSync(r.preMigrationBackup));
  assert.equal(path.basename(r.preMigrationBackup), 'auto-20261110-090000.sqlite');
  assert.equal(r.db.prepare('PRAGMA user_version').get().user_version, 2);
  assert.ok(tableNames(r.db).includes('webull_link'));
  const kv = store.createKv(r.db);
  assert.deepEqual(kv.get('auth', 'account:a1'), { id: 'a1' });
  assert.equal(kv.get('settings', 'x'), 5);

  // The backup is still version 1 and still valid.
  const b = new DatabaseSync(r.preMigrationBackup, { readOnly: true });
  assert.equal(b.prepare('PRAGMA user_version').get().user_version, 1);
  assert.ok(!tableNames(b).includes('webull_link'));
  b.close();
  assert.equal(store.validateBackup(r.preMigrationBackup).ok, true);

  // Reopening does not migrate (or back up) again.
  store.closeDatabase(r.db);
  const again = store.openDatabase(dir);
  track(again.db);
  assert.equal(again.migratedFrom, undefined);
});

test('a failed pre-upgrade backup leaves the file at version 1', (t) => {
  const { dir } = tempDir(t);
  writeVersion1(path.join(dir, 'denarii.sqlite'), [['auth', 'account:a1', { id: 'a1' }]]);
  fs.writeFileSync(path.join(dir, 'backups'), 'not a folder'); // mkdir of backups/ fails
  assert.throws(() => store.openDatabase(dir), e => e.kind === 'open-failed' && /back up/.test(e.message));
  const db = new DatabaseSync(path.join(dir, 'denarii.sqlite'), { readOnly: true });
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  db.close();
});

test('the migration is one transaction: a failing step leaves version 1 and no tables', (t) => {
  const { dir } = tempDir(t);
  const file = path.join(dir, 'denarii.sqlite');
  writeVersion1(file);
  const db = new DatabaseSync(file);
  db.exec('CREATE TABLE webull_link (x)'); // makes the CREATE TABLE in the migration fail
  assert.throws(() => store.migrate(db, 1));
  assert.equal(db.prepare('PRAGMA user_version').get().user_version, 1);
  assert.ok(!tableNames(db).includes('webull_connection'));
  db.close();
});

test('a restored version 1 backup passes validation and is upgraded on the next open', (t) => {
  const { dir, track } = tempDir(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-wb-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const v1 = path.join(out, 'old.sqlite');
  writeVersion1(v1, [['auth', 'account:old', { id: 'old' }]]);
  assert.equal(store.validateBackup(v1).ok, true);

  const first = store.openDatabase(dir);
  store.createKv(first.db).put('auth', 'account:new', { id: 'new' });
  store.restoreFrom(first.db, dir, v1); // closes first.db
  const r = store.openDatabase(dir);
  track(r.db);
  assert.equal(r.migratedFrom, 1);
  assert.equal(r.db.prepare('PRAGMA user_version').get().user_version, 2);
  const kv = store.createKv(r.db);
  assert.deepEqual(kv.get('auth', 'account:old'), { id: 'old' });
  assert.equal(kv.get('auth', 'account:new'), null);
});

test('version 3 is "newer"; a version 2 file missing the Webull tables is corrupt', (t) => {
  const { dir } = tempDir(t);
  const file = path.join(dir, 'denarii.sqlite');
  writeVersion1(file);
  const db = new DatabaseSync(file);
  db.exec('PRAGMA user_version = 2');
  db.close();
  assert.throws(() => store.openDatabase(dir), e => e.kind === 'corrupt' && /Webull tables/.test(e.message));
  assert.equal(store.validateBackup(file).ok, false);
  const db3 = new DatabaseSync(file);
  db3.exec('PRAGMA user_version = 3');
  db3.close();
  assert.throws(() => store.openDatabase(dir), e => e.kind === 'newer');
  assert.equal(store.validateBackup(file).kind, 'newer');
});

test('connections and links are isolated per local account', (t) => {
  const { wb } = openStore(t);
  wb.putConnection('a1', connectionFields());
  wb.putConnection('a2', connectionFields({ appKeyLast4: 'zz99', webullAccounts: [{ id: 'W1', label: 'Other' }] }));
  wb.upsertLink('a1', 'j1', { webullAccountId: 'W1' });
  wb.upsertLink('a2', 'j1', { webullAccountId: 'W1' }); // same ids, different local account: allowed

  assert.equal(wb.getConnection('a1').appKeyLast4, 'ab12');
  assert.equal(wb.getConnection('a2').appKeyLast4, 'zz99');
  assert.ok(Buffer.isBuffer(wb.getConnection('a1').creds));
  assert.deepEqual(wb.getConnection('a1').webullAccounts, [{ id: 'W1', label: 'Cash' }]);

  wb.updateLink('a1', 'j1', { lastStatus: 'ok' });
  assert.equal(wb.getLink('a1', 'j1').lastStatus, 'ok');
  assert.equal(wb.getLink('a2', 'j1').lastStatus, null);

  assert.equal(wb.deleteConnection('a1'), true);
  assert.equal(wb.getConnection('a1'), null);
  assert.ok(wb.getConnection('a2'));
  // Disconnect keeps the links.
  assert.equal(wb.listLinks('a1').length, 1);
  assert.equal(wb.listLinks('a3').length, 0);
});

test('one journal per Webull account within a local account', (t) => {
  const { wb } = openStore(t);
  wb.upsertLink('a1', 'j1', { webullAccountId: 'W1' });
  assert.throws(() => wb.upsertLink('a1', 'j2', { webullAccountId: 'W1' }), LinkConflictError);
  assert.equal(wb.getLink('a1', 'j2'), null);
  // Re-saving the same journal's link is fine; moving it to another Webull account too.
  wb.upsertLink('a1', 'j1', { webullAccountId: 'W1', startDate: '2024-01-02' });
  wb.upsertLink('a1', 'j1', { webullAccountId: 'W2' });
  wb.upsertLink('a1', 'j2', { webullAccountId: 'W1' });
  assert.deepEqual(wb.listLinks('a1').map(l => [l.journalId, l.webullAccountId]), [['j1', 'W2'], ['j2', 'W1']]);
  wb.removeLink('a1', 'j1');
  assert.deepEqual(wb.listLinks('a1').map(l => l.journalId), ['j2']);
});

test('ackWindow moves the cursor forward and clears backfill once caught up', (t) => {
  const { wb } = openStore(t);
  wb.upsertLink('a1', 'j1', { webullAccountId: 'W1' });
  assert.equal(wb.ackWindow('a1', 'j1', 1000, false), true);
  assert.deepEqual([wb.getLink('a1', 'j1').lastSyncedAt, wb.getLink('a1', 'j1').backfillCursor], [1000, 1000]);
  assert.equal(wb.ackWindow('a1', 'j1', 2000, true), true);
  assert.deepEqual([wb.getLink('a1', 'j1').lastSyncedAt, wb.getLink('a1', 'j1').backfillCursor], [2000, null]);
  // An older end never moves it back.
  assert.equal(wb.ackWindow('a1', 'j1', 1500, true), false);
  assert.equal(wb.getLink('a1', 'j1').lastSyncedAt, 2000);
});

test('deleting a local account (its auth record) deletes its Webull rows only', (t) => {
  const { kv, wb } = openStore(t);
  kv.put('auth', 'account:a1', { id: 'a1' });
  kv.put('auth', 'account:a2', { id: 'a2' });
  kv.put('auth', 'username:x', { accountId: 'a1' });
  for (const a of ['a1', 'a2']) {
    wb.putConnection(a, connectionFields());
    wb.upsertLink(a, 'j1', { webullAccountId: 'W1' });
  }
  kv.delete('auth', 'username:x'); // other auth keys do not touch Webull rows
  assert.ok(wb.getConnection('a1'));
  kv.delete('auth', 'account:a1');
  assert.equal(wb.getConnection('a1'), null);
  assert.equal(wb.listLinks('a1').length, 0);
  assert.ok(wb.getConnection('a2'));
  assert.equal(wb.listLinks('a2').length, 1);

  wb.deleteAccount('a2');
  assert.equal(wb.getConnection('a2'), null);
  assert.equal(wb.listLinks('a2').length, 0);
});

test('Webull rows survive backupTo and restore with the journal they belong to', (t) => {
  const { dir, track } = tempDir(t);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-wb-out-'));
  t.after(() => fs.rmSync(out, { recursive: true, force: true }));
  const first = store.openDatabase(dir);
  const kv = store.createKv(first.db);
  kv.put('auth', 'account:a1', { id: 'a1' });
  const wb = createWebullStore(() => first.db);
  wb.putConnection('a1', connectionFields());
  wb.upsertLink('a1', 'j1', { webullAccountId: 'W1' });
  wb.ackWindow('a1', 'j1', 1234, true);
  const backup = store.backupTo(first.db, dir, path.join(out, 'b.sqlite'));
  wb.removeLink('a1', 'j1');
  store.restoreFrom(first.db, dir, backup);
  const r = store.openDatabase(dir);
  track(r.db);
  const wb2 = createWebullStore(() => r.db);
  assert.equal(wb2.getLink('a1', 'j1').lastSyncedAt, 1234);
  assert.deepEqual(wb2.getConnection('a1').creds, Buffer.from('creds-blob'));
});

test('a closed database throws instead of using a stale handle', () => {
  const wb = createWebullStore(() => null);
  assert.throws(() => wb.getConnection('a1'), /closed/);
});
