// SQLite storage for Denarii Local (node:sqlite, built into Electron).
//
// One key-value table replaces the three IndexedDB object stores the app
// used ('journal', 'auth', 'settings'). Values are stored as JSON text; the
// app still encrypts journal data and API keys before they get here, so the
// file holds the same encrypted data IndexedDB held.
//
// Schema version 2 adds webull_connection and webull_link (Webull auto-sync,
// docs/webull-local-plan.md section 5). Their secrets are safeStorage blobs
// written by electron/webull/connection.js; electron/webull/store.js reads
// and writes the rows.
//
// Plain Node module (no electron import) so tests/electron-db.test.js can run
// it under node --test. electron/main.js owns dialogs and IPC.

const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const APP_ID = 0x44454E41;        // "DENA" in the file header; identifies a Denarii database
const SCHEMA_VERSION = 2;          // PRAGMA user_version
const STORES = new Set(['journal', 'auth', 'settings']);
const MAX_KEY_LENGTH = 512;
const MAX_VALUE_BYTES = 64 * 1024 * 1024;
const AUTO_BACKUP_KEEP = 5;
const PRE_RESTORE_KEEP = 3;
const DB_FILE = 'denarii.sqlite';
const BACKUP_DIR = 'backups';
const AUTO_BACKUP_RE = /^auto-\d{8}-\d{6}\.sqlite$/;
const PRE_RESTORE_RE = /^pre-restore-\d{8}-\d{6}(-\d+)?\.sqlite$/;

// SQLite result codes (err.errcode from node:sqlite)
const SQLITE_BUSY = 5;
const SQLITE_LOCKED = 6;
const SQLITE_CORRUPT = 11;
const SQLITE_NOTADB = 26;

class DbError extends Error {
  // kind: 'corrupt' | 'locked' | 'newer' | 'open-failed'
  constructor(kind, message) {
    super(message);
    this.name = 'DbError';
    this.kind = kind;
  }
}

function dbPath(dir) { return path.join(dir, DB_FILE); }
function backupsDir(dir) { return path.join(dir, BACKUP_DIR); }

// Local time as YYYYMMDD-HHMMSS (sorts chronologically as text).
function formatStamp(date) {
  const d = date || new Date();
  const p = n => String(n).padStart(2, '0');
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
    p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

function toDbError(err) {
  if (err instanceof DbError) return err;
  const code = err && err.errcode;
  const msg = (err && err.message) || String(err);
  if (code === SQLITE_BUSY || code === SQLITE_LOCKED) return new DbError('locked', msg);
  if (code === SQLITE_CORRUPT || code === SQLITE_NOTADB) return new DbError('corrupt', msg);
  return new DbError('open-failed', msg);
}

// Checks an open connection. Returns { empty: true } for a brand-new file,
// { ok: true } for a valid Denarii database, else { ok: false, kind, reason }.
// Throws (SQLite error) when the file is not a database at all.
function checkConnection(db) {
  const appId = db.prepare('PRAGMA application_id').get().application_id;
  const version = db.prepare('PRAGMA user_version').get().user_version;
  const objects = db.prepare('SELECT count(*) AS n FROM sqlite_master').get().n;
  if (appId === 0 && version === 0 && objects === 0) return { empty: true };
  if (appId !== APP_ID) return { ok: false, kind: 'corrupt', reason: 'Not a Denarii database (wrong application id).' };
  if (version > SCHEMA_VERSION) return { ok: false, kind: 'newer', reason: 'This data was saved by a newer Denarii' };
  if (version < 1) return { ok: false, kind: 'corrupt', reason: 'Missing schema version.' };
  const cols = db.prepare('PRAGMA table_info(kv)').all().map(r => r.name);
  if (!['store', 'key', 'value', 'updated_at'].every(c => cols.includes(c))) {
    return { ok: false, kind: 'corrupt', reason: 'Missing kv table.' };
  }
  if (version >= 2) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all().map(r => r.name);
    if (!tables.includes('webull_connection') || !tables.includes('webull_link')) {
      return { ok: false, kind: 'corrupt', reason: 'Missing Webull tables.' };
    }
  }
  const qc = db.prepare('PRAGMA quick_check').all();
  if (qc.length !== 1 || qc[0].quick_check !== 'ok') {
    return { ok: false, kind: 'corrupt', reason: 'Integrity check failed: ' + qc.map(r => r.quick_check).slice(0, 3).join('; ') };
  }
  return { ok: true };
}

// Validates any file as a Denarii database without changing it.
function inspectFile(file) {
  let db = null;
  try {
    if (!fs.existsSync(file) || fs.statSync(file).size === 0) return { ok: false, kind: 'corrupt', reason: 'File is missing or empty.' };
    db = new DatabaseSync(file, { readOnly: true });
    const c = checkConnection(db);
    if (c.empty) return { ok: false, kind: 'corrupt', reason: 'Not a Denarii database (empty).' };
    return c;
  } catch (e) {
    const err = toDbError(e);
    return { ok: false, kind: err.kind, reason: err.message };
  } finally {
    if (db) { try { db.close(); } catch (e) { /* already closed */ } }
  }
}

function applySettings(db) {
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA synchronous = FULL');
}

// Version 2: Webull connection (one per local account) and journal links.
// Deleting an account's auth record ('auth', 'account:<id>') deletes its
// Webull rows in the same statement, through the trigger.
const WEBULL_SCHEMA_SQL = `
CREATE TABLE webull_connection (
  account_id TEXT PRIMARY KEY,
  creds BLOB NOT NULL,
  token BLOB,
  app_key_last4 TEXT NOT NULL,
  approval_state TEXT NOT NULL CHECK (approval_state IN ('ok','needs_approval','unknown')),
  token_expires_at INTEGER, token_created_at INTEGER, token_checked_at INTEGER,
  webull_accounts TEXT,
  default_start_date TEXT,
  updated_at INTEGER NOT NULL);
CREATE TABLE webull_link (
  account_id TEXT NOT NULL, journal_id TEXT NOT NULL,
  webull_account_id TEXT NOT NULL,
  start_date TEXT,
  last_synced_at INTEGER,
  backfill_cursor INTEGER,
  last_status TEXT, last_error TEXT, last_attempt_at INTEGER,
  PRIMARY KEY (account_id, journal_id),
  UNIQUE (account_id, webull_account_id));
CREATE TRIGGER webull_account_deleted AFTER DELETE ON kv
WHEN OLD.store = 'auth' AND OLD.key LIKE 'account:%'
BEGIN
  DELETE FROM webull_link WHERE account_id = substr(OLD.key, 9);
  DELETE FROM webull_connection WHERE account_id = substr(OLD.key, 9);
END;
`;

function createSchema(db) {
  db.exec(
    "CREATE TABLE kv (" +
    "store TEXT NOT NULL CHECK (store IN ('journal','auth','settings')), " +
    "key TEXT NOT NULL, " +
    "value TEXT NOT NULL, " +
    "updated_at INTEGER NOT NULL, " +
    "PRIMARY KEY (store, key)) WITHOUT ROWID"
  );
  db.exec(WEBULL_SCHEMA_SQL);
  db.exec('PRAGMA application_id = ' + APP_ID);
  db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
}

// Upgrades an older Denarii database to SCHEMA_VERSION in one transaction:
// either every step and the new user_version are written, or nothing is.
function migrate(db, fromVersion) {
  db.exec('BEGIN IMMEDIATE');
  try {
    if (fromVersion < 2) db.exec(WEBULL_SCHEMA_SQL);
    db.exec('PRAGMA user_version = ' + SCHEMA_VERSION);
    db.exec('COMMIT');
  } catch (e) {
    try { db.exec('ROLLBACK'); } catch (re) { /* already rolled back */ }
    throw e;
  }
}

// Opens (or creates) userData/denarii.sqlite. Returns { db, status } with
// status 'created' for a new file or 'ok'. Throws DbError; never modifies
// or replaces a file it cannot validate.
//
// An older schema is upgraded only after an automatic backup of the
// unchanged file (autoBackup); if that backup fails nothing is upgraded and
// the error is thrown. An upgrade adds { migratedFrom, preMigrationBackup }
// (the backup path, or null when kv was empty or one already existed this
// second).
function openDatabase(dir, date) {
  fs.mkdirSync(dir, { recursive: true });
  let db;
  try {
    db = new DatabaseSync(dbPath(dir));
  } catch (e) {
    throw toDbError(e);
  }
  try {
    db.exec('PRAGMA busy_timeout = 3000');
    const c = checkConnection(db);
    if (c.empty) {
      applySettings(db);
      createSchema(db);
      return { db, status: 'created' };
    }
    if (!c.ok) throw new DbError(c.kind, c.reason);
    applySettings(db);
    const version = db.prepare('PRAGMA user_version').get().user_version;
    if (version < SCHEMA_VERSION) {
      let backup;
      try {
        backup = autoBackup(db, dir, date);
      } catch (be) {
        throw new DbError('open-failed', 'Could not back up the database before upgrading it: ' + ((be && be.message) || be));
      }
      migrate(db, version);
      return { db, status: 'ok', migratedFrom: version, preMigrationBackup: backup };
    }
    return { db, status: 'ok' };
  } catch (e) {
    try { db.close(); } catch (ce) { /* ignore */ }
    throw toDbError(e);
  }
}

function closeDatabase(db) {
  if (!db) return;
  try { db.exec('PRAGMA wal_checkpoint(TRUNCATE)'); } catch (e) { /* best effort */ }
  try { db.close(); } catch (e) { /* already closed */ }
}

// Moves denarii.sqlite (and its -wal/-shm) aside as
// denarii.corrupt-<stamp>.sqlite. Never overwrites; returns the new path.
function quarantine(dir, date) {
  const src = dbPath(dir);
  let base = 'denarii.corrupt-' + formatStamp(date);
  let target = path.join(dir, base + '.sqlite');
  for (let n = 2; fs.existsSync(target); n++) target = path.join(dir, base + '-' + n + '.sqlite');
  if (fs.existsSync(src)) fs.renameSync(src, target);
  for (const ext of ['-wal', '-shm']) {
    if (fs.existsSync(src + ext)) fs.renameSync(src + ext, target + ext);
  }
  return target;
}

// Automatic backups, newest first: [{ name, path, at }]
function listAutoBackups(dir) {
  const bdir = backupsDir(dir);
  if (!fs.existsSync(bdir)) return [];
  return fs.readdirSync(bdir)
    .filter(f => AUTO_BACKUP_RE.test(f))
    .sort()
    .reverse()
    .map(f => {
      const p = path.join(bdir, f);
      return { name: f, path: p, at: fs.statSync(p).mtime.toISOString() };
    });
}

function pruneAutoBackups(dir, keep) {
  const limit = keep || AUTO_BACKUP_KEEP;
  const removed = [];
  for (const b of listAutoBackups(dir).slice(limit)) {
    fs.unlinkSync(b.path);
    removed.push(b.name);
  }
  return removed;
}

// Consistent copy via VACUUM INTO, only when kv has rows. Returns the backup
// path, or null when skipped (empty database or one already this second).
function autoBackup(db, dir, date, keep) {
  const rows = db.prepare('SELECT count(*) AS n FROM kv').get().n;
  if (!rows) return null;
  const bdir = backupsDir(dir);
  fs.mkdirSync(bdir, { recursive: true });
  const target = path.join(bdir, 'auto-' + formatStamp(date) + '.sqlite');
  if (fs.existsSync(target)) return null;
  db.prepare('VACUUM INTO ?').run(target);
  pruneAutoBackups(dir, keep);
  return target;
}

// Copies an automatic backup into place as denarii.sqlite. Fails if a
// database file is already there (call quarantine first).
function restoreAutoBackup(dir, backupPath) {
  const check = inspectFile(backupPath);
  if (!check.ok) throw new DbError('corrupt', 'Backup is not usable: ' + check.reason);
  fs.copyFileSync(backupPath, dbPath(dir), fs.constants.COPYFILE_EXCL);
}

// ── Manual backup and restore ────────────────────────────────────────────

function samePath(a, b) {
  const norm = p => path.resolve(p).toLowerCase();
  return norm(a) === norm(b);
}

function isLiveDatabaseFile(dir, file) {
  const live = dbPath(dir);
  return [live, live + '-wal', live + '-shm', live + '.tmp'].some(p => samePath(p, file));
}

function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch (e) { /* not there */ }
}

// A file is restorable only when it is a Denarii database this version can
// read: application_id, user_version <= SCHEMA_VERSION, quick_check and the
// kv table, plus the Webull tables from version 2 (see checkConnection).
// Opens read-only; never changes the file. A version 1 backup is upgraded
// by openDatabase on the relaunch after restore.
function validateBackup(filePath) {
  return inspectFile(filePath);
}

// Writes a consistent copy of the open database to targetPath. VACUUM INTO
// goes to a temp file in the target folder, which is checked and then
// renamed over targetPath, so the target is either the complete backup or
// left as it was. Refuses the live database's own files.
function backupTo(db, dir, targetPath) {
  if (isLiveDatabaseFile(dir, targetPath)) throw new Error('Choose a different file: that is the live Denarii database.');
  const folder = path.dirname(targetPath);
  if (!fs.existsSync(folder)) throw new Error('Folder not found: ' + folder);
  const tmp = path.join(folder, '.' + path.basename(targetPath) + '.' + process.pid + '-' + Date.now() + '.tmp');
  try {
    db.prepare('VACUUM INTO ?').run(tmp);
    const check = inspectFile(tmp);
    if (!check.ok) throw new Error('Backup check failed: ' + check.reason);
    fs.renameSync(tmp, targetPath);
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
  return targetPath;
}

function listPreRestore(dir) {
  const bdir = backupsDir(dir);
  if (!fs.existsSync(bdir)) return [];
  return fs.readdirSync(bdir)
    .filter(f => PRE_RESTORE_RE.test(f))
    .map(f => ({ name: f, path: path.join(bdir, f), mtime: fs.statSync(path.join(bdir, f)).mtimeMs }))
    .sort((a, b) => (b.mtime - a.mtime) || (a.name < b.name ? 1 : -1));
}

function prunePreRestore(dir, keep) {
  for (const f of listPreRestore(dir).slice(keep || PRE_RESTORE_KEEP)) fs.unlinkSync(f.path);
}

// Replaces the live database with filePath.
//   1. validate filePath (nothing else happens if it is not usable)
//   2. safety copy: VACUUM INTO backups/pre-restore-<stamp>.sqlite (keep 3)
//   3. copy filePath to denarii.sqlite.tmp and check the copy
//   4. checkpoint and close db; stop if the WAL was not fully written back
//   5. delete -wal/-shm, rename denarii.sqlite.tmp over denarii.sqlite
// Any failure before step 5's rename leaves denarii.sqlite as it was. Errors
// thrown after step 4 carry dbClosed = true so the caller reopens it.
// On success db is closed; the caller restarts the app.
function restoreFrom(db, dir, filePath, date) {
  if (isLiveDatabaseFile(dir, filePath)) throw new Error('That file is the live Denarii database.');
  const check = validateBackup(filePath);
  if (!check.ok) throw new DbError(check.kind, 'Not a usable Denarii backup: ' + check.reason);

  const live = dbPath(dir);
  const tmp = live + '.tmp';
  const bdir = backupsDir(dir);
  fs.mkdirSync(bdir, { recursive: true });
  const stamp = formatStamp(date);
  let safety = path.join(bdir, 'pre-restore-' + stamp + '.sqlite');
  for (let n = 2; fs.existsSync(safety); n++) safety = path.join(bdir, 'pre-restore-' + stamp + '-' + n + '.sqlite');

  try {
    db.prepare('VACUUM INTO ?').run(safety);
  } catch (e) {
    removeQuietly(safety);
    throw e;
  }
  try {
    prunePreRestore(dir);
    removeQuietly(tmp);
    fs.copyFileSync(filePath, tmp);
    const copyCheck = inspectFile(tmp);
    if (!copyCheck.ok) throw new Error('Copy check failed: ' + copyCheck.reason);
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }

  closeDatabase(db);
  try {
    const wal = live + '-wal';
    if (fs.existsSync(wal) && fs.statSync(wal).size > 0) {
      throw new Error('The current database could not be fully saved before restore.');
    }
    removeQuietly(wal);
    removeQuietly(live + '-shm');
    fs.renameSync(tmp, live);
  } catch (e) {
    removeQuietly(tmp);
    e.dbClosed = true;
    throw e;
  }
  return { safetyCopy: safety };
}

// ── Key-value access with input validation ───────────────────────────────

function validateStore(store) {
  if (!STORES.has(store)) throw new TypeError('Invalid store: ' + String(store));
}

function validateKey(key) {
  if (typeof key !== 'string' || key.length === 0 || key.length > MAX_KEY_LENGTH) {
    throw new TypeError('Invalid key: must be a non-empty string of at most ' + MAX_KEY_LENGTH + ' characters.');
  }
}

// undefined (and anything JSON cannot represent at top level) is stored as null.
function serializeValue(value) {
  const json = JSON.stringify(value === undefined ? null : value);
  const text = json === undefined ? 'null' : json;
  if (Buffer.byteLength(text, 'utf8') > MAX_VALUE_BYTES) {
    throw new RangeError('Value too large: over ' + MAX_VALUE_BYTES + ' bytes.');
  }
  return text;
}

function createKv(db) {
  const getStmt = db.prepare('SELECT value FROM kv WHERE store = ? AND key = ?');
  const putStmt = db.prepare(
    'INSERT INTO kv (store, key, value, updated_at) VALUES (?, ?, ?, ?) ' +
    'ON CONFLICT (store, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at'
  );
  const delStmt = db.prepare('DELETE FROM kv WHERE store = ? AND key = ?');
  const keysStmt = db.prepare('SELECT key FROM kv WHERE store = ? ORDER BY key');
  const countStmt = db.prepare('SELECT count(*) AS n FROM kv');

  return {
    get(store, key) {
      validateStore(store); validateKey(key);
      const row = getStmt.get(store, key);
      return row ? JSON.parse(row.value) : null;
    },
    put(store, key, value) {
      validateStore(store); validateKey(key);
      putStmt.run(store, key, serializeValue(value), Date.now());
    },
    delete(store, key) {
      validateStore(store); validateKey(key);
      delStmt.run(store, key);
    },
    getAllKeys(store) {
      validateStore(store);
      return keysStmt.all(store).map(r => r.key);
    },
    count() {
      return countStmt.get().n;
    },
  };
}

module.exports = {
  APP_ID,
  SCHEMA_VERSION,
  STORES,
  MAX_KEY_LENGTH,
  MAX_VALUE_BYTES,
  AUTO_BACKUP_KEEP,
  PRE_RESTORE_KEEP,
  DbError,
  WEBULL_SCHEMA_SQL,
  dbPath,
  backupsDir,
  formatStamp,
  inspectFile,
  openDatabase,
  migrate,
  closeDatabase,
  quarantine,
  listAutoBackups,
  pruneAutoBackups,
  autoBackup,
  restoreAutoBackup,
  validateBackup,
  backupTo,
  restoreFrom,
  listPreRestore,
  validateStore,
  validateKey,
  serializeValue,
  createKv,
};
