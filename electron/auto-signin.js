// "Stay signed in on this computer" for Denarii Local.
//
// Keeps one account's DEK (data encryption key) in userData/auto-signin.dat,
// protected with Electron safeStorage (Windows DPAPI: readable only by the
// same Windows user). The file sits beside denarii.sqlite, never in backups/,
// and backupTo / autoBackup / restoreFrom only copy the SQLite database, so
// it is never part of a backup. Only one account can hold it at a time.
//
// File content: safeStorage.encryptStringAsync(JSON.stringify({ v: 1, accountId, dek, savedAt }))
//
// Uses only the async safeStorage APIs (the sync ones are deprecated). Files
// written by earlier versions with encryptString are read by
// decryptStringAsync; when it reports shouldReEncrypt the file is rewritten.
//
// Plain Node module (no electron import): safeStorage and the account lookup
// are passed in, so tests/auto-signin.test.js can run it under node --test.
// electron/main.js owns the IPC.

const fs = require('fs');
const path = require('path');

const FILE = 'auto-signin.dat';
const FORMAT_VERSION = 1;
const MAX_ACCOUNT_ID_LENGTH = 128;
const DEK_RE = /^[0-9a-f]{64}$/;

function filePath(dir) { return path.join(dir, FILE); }

function isValidAccountId(id) {
  return typeof id === 'string' && id.length > 0 && id.length <= MAX_ACCOUNT_ID_LENGTH;
}

function isValidDek(dek) {
  return typeof dek === 'string' && DEK_RE.test(dek);
}

// Only DEK accounts that are not cloud-linked may use auto sign-in.
function isEligible(record) {
  return !!record && typeof record === 'object' && record.dekVersion === 1 && !record.supabaseUid;
}

// -> Promise<boolean>
async function isAvailable(safeStorage, platform) {
  try {
    if (!safeStorage || !(await safeStorage.isAsyncEncryptionAvailable())) return false;
    if ((platform || process.platform) === 'linux' && typeof safeStorage.getSelectedStorageBackend === 'function' &&
        safeStorage.getSelectedStorageBackend() === 'basic_text') return false;
    return true;
  } catch (e) {
    return false;
  }
}

function removeQuietly(file) {
  try { fs.unlinkSync(file); } catch (e) { /* not there */ }
}

function clear(dir) {
  removeQuietly(filePath(dir));
  removeQuietly(filePath(dir) + '.tmp');
}

// Writes the blob atomically: .tmp first, then renamed over the real file,
// so it is either the complete new entry or left as it was.
function writeBlob(dir, blob) {
  const file = filePath(dir);
  const tmp = file + '.tmp';
  try {
    fs.writeFileSync(tmp, blob);
    fs.renameSync(tmp, file);
  } catch (e) {
    removeQuietly(tmp);
    throw e;
  }
}

async function encryptEntry(safeStorage, accountId, dek, savedAt) {
  const json = JSON.stringify({ v: FORMAT_VERSION, accountId, dek, savedAt });
  return safeStorage.encryptStringAsync(json);
}

async function write(dir, safeStorage, accountId, dek, date) {
  if (!isValidAccountId(accountId)) throw new TypeError('Invalid account id.');
  if (!isValidDek(dek)) throw new TypeError('Invalid key.');
  const blob = await encryptEntry(safeStorage, accountId, dek, (date || new Date()).toISOString());
  writeBlob(dir, blob);
}

// -> { status: 'none' } | { status: 'unreadable' } | { status: 'ok', entry: { accountId, dek, savedAt } }
// 'unreadable' covers a failed decrypt (other Windows user, lost DPAPI key,
// copied file) and content that is not a valid entry. When safeStorage
// reports shouldReEncrypt, the same entry is re-encrypted and written back
// atomically; if that fails the old file is left as it was (still readable).
async function read(dir, safeStorage) {
  let blob;
  try {
    blob = fs.readFileSync(filePath(dir));
  } catch (e) {
    return { status: 'none' };
  }
  let entry, shouldReEncrypt;
  try {
    const r = await safeStorage.decryptStringAsync(blob);
    shouldReEncrypt = !!(r && r.shouldReEncrypt);
    entry = JSON.parse(r && r.result);
    if (!entry || entry.v !== FORMAT_VERSION || !isValidAccountId(entry.accountId) || !isValidDek(entry.dek)) {
      return { status: 'unreadable' };
    }
  } catch (e) {
    return { status: 'unreadable' };
  }
  const out = { accountId: entry.accountId, dek: entry.dek, savedAt: entry.savedAt || null };
  if (shouldReEncrypt) {
    try {
      writeBlob(dir, await encryptEntry(safeStorage, out.accountId, out.dek, entry.savedAt || new Date().toISOString()));
    } catch (e) { /* keep the old file */ }
  }
  return { status: 'ok', entry: out };
}

// opts: { dir, safeStorage, platform?, getAccount(accountId) -> auth record | null }
// The returned object holds the once-per-process flag: only the first
// tryUnlock can succeed, so Lock (a page reload) and View > Reload need the
// password until the app is started again. Every method returns a Promise;
// calls run one at a time in arrival order, so a re-encrypt from one call
// can't overwrite a file another call just wrote.
function createAutoSignIn(opts) {
  const { dir, safeStorage, platform, getAccount } = opts;
  let used = false;
  let queue = Promise.resolve();

  const serial = (fn) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };
  const available = () => isAvailable(safeStorage, platform);

  return {
    // -> { available, accountId | null, used }
    // used: tryUnlock already ran in this process, so it cannot succeed again.
    status() {
      return serial(async () => {
        if (!(await available())) return { available: false, accountId: null, used };
        const r = await read(dir, safeStorage);
        return { available: true, accountId: r.status === 'ok' ? r.entry.accountId : null, used };
      });
    },

    // -> { ok: true } | { ok: false, error }
    enable(accountId, dek) {
      return serial(async () => {
        if (!isValidAccountId(accountId)) return { ok: false, error: 'Invalid account id.' };
        if (!isValidDek(dek)) return { ok: false, error: 'Invalid key.' };
        if (!(await available())) return { ok: false, error: 'Automatic sign-in is not available on this computer.' };
        if (!isEligible(getAccount(accountId))) return { ok: false, error: 'This account cannot use automatic sign-in.' };
        try {
          await write(dir, safeStorage, accountId, dek);
          return { ok: true };
        } catch (e) {
          return { ok: false, error: e.message };
        }
      });
    },

    // No accountId: always clears. With one: clears only when that account
    // holds auto sign-in. -> { ok: true, cleared } | { ok: false, error }
    disable(accountId) {
      return serial(async () => {
        if (accountId === undefined || accountId === null) {
          clear(dir);
          return { ok: true, cleared: true };
        }
        if (!isValidAccountId(accountId)) return { ok: false, error: 'Invalid account id.' };
        const r = await read(dir, safeStorage);
        if (r.status === 'ok' && r.entry.accountId === accountId) {
          clear(dir);
          return { ok: true, cleared: true };
        }
        return { ok: true, cleared: false };
      });
    },

    // -> { ok: true, accountId, dek }
    //  | { ok: false, reason: 'unavailable' | 'used' | 'none' | 'decrypt-failed' | 'account-missing' | 'not-eligible' }
    // The flag is set synchronously, before anything is awaited, so two
    // overlapping calls can never both succeed.
    tryUnlock() {
      if (used) return Promise.resolve({ ok: false, reason: 'used' });
      used = true;
      return serial(async () => {
        if (!(await available())) return { ok: false, reason: 'unavailable' };
        const r = await read(dir, safeStorage);
        if (r.status === 'none') return { ok: false, reason: 'none' };
        if (r.status !== 'ok') {
          clear(dir);
          return { ok: false, reason: 'decrypt-failed' };
        }
        let record = null;
        try { record = getAccount(r.entry.accountId); } catch (e) { record = null; }
        if (!record) {
          clear(dir);
          return { ok: false, reason: 'account-missing' };
        }
        if (!isEligible(record)) {
          clear(dir);
          return { ok: false, reason: 'not-eligible' };
        }
        return { ok: true, accountId: r.entry.accountId, dek: r.entry.dek };
      });
    },
  };
}

module.exports = {
  FILE,
  MAX_ACCOUNT_ID_LENGTH,
  filePath,
  isValidAccountId,
  isValidDek,
  isEligible,
  isAvailable,
  write,
  read,
  clear,
  createAutoSignIn,
};
