// Webull rows in the SQLite database (schema version 2, electron/db.js):
// webull_connection (one per local account) and webull_link (one per
// linked journal). Every function is scoped to one local account id, so one
// account can never read or change another's rows.
//
// creds and token are safeStorage blobs written by connection.js; this
// module stores and returns them as Buffers and never decrypts them.
//
// getDb() returns the open node:sqlite database, or null when it is closed
// (restore and quit close it). Statements are prepared per call so a
// reopened database is picked up.

const CONNECTION_COLUMNS = Object.freeze([
  'creds', 'token', 'app_key_last4', 'approval_state', 'token_expires_at',
  'token_created_at', 'token_checked_at', 'webull_accounts', 'default_start_date',
]);
const LINK_PATCH_COLUMNS = Object.freeze([
  'webull_account_id', 'start_date', 'last_synced_at', 'backfill_cursor',
  'last_status', 'last_error', 'last_attempt_at',
]);

class LinkConflictError extends Error {
  constructor() {
    super('This Webull account is already linked to another journal.');
    this.name = 'LinkConflictError';
  }
}

function toBuffer(v) {
  if (v === null || v === undefined) return null;
  return Buffer.isBuffer(v) ? v : Buffer.from(v);
}

function parseAccountsColumn(text) {
  if (typeof text !== 'string' || !text) return null;
  try {
    const list = JSON.parse(text);
    return Array.isArray(list) ? list : null;
  } catch (e) {
    return null;
  }
}

function connectionFromRow(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    creds: toBuffer(row.creds),
    token: toBuffer(row.token),
    appKeyLast4: row.app_key_last4,
    approvalState: row.approval_state,
    tokenExpiresAt: row.token_expires_at,
    tokenCreatedAt: row.token_created_at,
    tokenCheckedAt: row.token_checked_at,
    webullAccounts: parseAccountsColumn(row.webull_accounts),
    defaultStartDate: row.default_start_date,
    updatedAt: row.updated_at,
  };
}

function linkFromRow(row) {
  if (!row) return null;
  return {
    accountId: row.account_id,
    journalId: row.journal_id,
    webullAccountId: row.webull_account_id,
    startDate: row.start_date,
    lastSyncedAt: row.last_synced_at,
    backfillCursor: row.backfill_cursor,
    lastStatus: row.last_status,
    lastError: row.last_error,
    lastAttemptAt: row.last_attempt_at,
  };
}

// camelCase patch -> column values; webull_accounts is stored as JSON text.
function connectionValues(patch) {
  const out = {};
  const map = {
    creds: 'creds', token: 'token', appKeyLast4: 'app_key_last4', approvalState: 'approval_state',
    tokenExpiresAt: 'token_expires_at', tokenCreatedAt: 'token_created_at', tokenCheckedAt: 'token_checked_at',
    webullAccounts: 'webull_accounts', defaultStartDate: 'default_start_date',
  };
  for (const [k, col] of Object.entries(map)) {
    if (!Object.hasOwn(patch, k)) continue;
    let v = patch[k];
    if (col === 'webull_accounts') v = v === null || v === undefined ? null : JSON.stringify(v);
    if (v === undefined) v = null;
    out[col] = v;
  }
  return out;
}

function linkValues(patch) {
  const map = {
    webullAccountId: 'webull_account_id', startDate: 'start_date', lastSyncedAt: 'last_synced_at',
    backfillCursor: 'backfill_cursor', lastStatus: 'last_status', lastError: 'last_error', lastAttemptAt: 'last_attempt_at',
  };
  const out = {};
  for (const [k, col] of Object.entries(map)) {
    if (Object.hasOwn(patch, k)) out[col] = patch[k] === undefined ? null : patch[k];
  }
  return out;
}

function isUniqueViolation(e) {
  return !!e && /UNIQUE constraint failed: webull_link\.account_id, webull_link\.webull_account_id/.test(e.message || '');
}

function createWebullStore(getDb, opts) {
  const now = (opts && opts.now) || Date.now;
  const db = () => {
    const d = getDb();
    if (!d) throw new Error('Database is closed.');
    return d;
  };

  return {
    getConnection(accountId) {
      return connectionFromRow(db().prepare('SELECT * FROM webull_connection WHERE account_id = ?').get(accountId));
    },

    // Inserts or replaces the whole connection row (connect).
    putConnection(accountId, fields) {
      const v = connectionValues(fields);
      const cols = CONNECTION_COLUMNS;
      const values = cols.map(c => (Object.hasOwn(v, c) ? v[c] : null));
      db().prepare(
        'INSERT INTO webull_connection (account_id, ' + cols.join(', ') + ', updated_at) VALUES (?, ' +
        cols.map(() => '?').join(', ') + ', ?) ON CONFLICT (account_id) DO UPDATE SET ' +
        cols.map(c => c + ' = excluded.' + c).join(', ') + ', updated_at = excluded.updated_at'
      ).run(accountId, ...values, now());
    },

    // Changes only the given fields. Returns true when a row was updated.
    updateConnection(accountId, patch) {
      const v = connectionValues(patch);
      const cols = Object.keys(v);
      if (!cols.length) return false;
      const r = db().prepare(
        'UPDATE webull_connection SET ' + cols.map(c => c + ' = ?').join(', ') + ', updated_at = ? WHERE account_id = ?'
      ).run(...cols.map(c => v[c]), now(), accountId);
      return r.changes > 0;
    },

    // Links and their cursors are kept (plan section 7: disconnect keeps links and trades).
    deleteConnection(accountId) {
      db().prepare('DELETE FROM webull_connection WHERE account_id = ?').run(accountId);
      return !db().prepare('SELECT 1 AS x FROM webull_connection WHERE account_id = ?').get(accountId);
    },

    listLinks(accountId) {
      return db().prepare('SELECT * FROM webull_link WHERE account_id = ? ORDER BY journal_id').all(accountId).map(linkFromRow);
    },

    getLink(accountId, journalId) {
      return linkFromRow(db().prepare('SELECT * FROM webull_link WHERE account_id = ? AND journal_id = ?').get(accountId, journalId));
    },

    // Creates or updates a journal's link. Throws LinkConflictError when the
    // Webull account is already linked to another journal of this account.
    upsertLink(accountId, journalId, patch) {
      const v = linkValues(patch);
      try {
        const existing = db().prepare('SELECT 1 AS x FROM webull_link WHERE account_id = ? AND journal_id = ?').get(accountId, journalId);
        if (existing) {
          const cols = Object.keys(v);
          if (cols.length) {
            db().prepare('UPDATE webull_link SET ' + cols.map(c => c + ' = ?').join(', ') + ' WHERE account_id = ? AND journal_id = ?')
              .run(...cols.map(c => v[c]), accountId, journalId);
          }
        } else {
          const cols = LINK_PATCH_COLUMNS.filter(c => Object.hasOwn(v, c));
          db().prepare(
            'INSERT INTO webull_link (account_id, journal_id' + cols.map(c => ', ' + c).join('') + ') VALUES (?, ?' +
            cols.map(() => ', ?').join('') + ')'
          ).run(accountId, journalId, ...cols.map(c => v[c]));
        }
      } catch (e) {
        if (isUniqueViolation(e)) throw new LinkConflictError();
        throw e;
      }
    },

    updateLink(accountId, journalId, patch) {
      const v = linkValues(patch);
      const cols = Object.keys(v);
      if (!cols.length) return false;
      const r = db().prepare('UPDATE webull_link SET ' + cols.map(c => c + ' = ?').join(', ') + ' WHERE account_id = ? AND journal_id = ?')
        .run(...cols.map(c => v[c]), accountId, journalId);
      return r.changes > 0;
    },

    // Moves the watermark after an acknowledged window. last_synced_at only
    // ever moves forward; backfill_cursor is the same end while more windows
    // remain, NULL once caught up.
    ackWindow(accountId, journalId, windowEnd, caughtUp) {
      const r = db().prepare(
        'UPDATE webull_link SET last_synced_at = ?, backfill_cursor = ? ' +
        'WHERE account_id = ? AND journal_id = ? AND (last_synced_at IS NULL OR last_synced_at <= ? OR backfill_cursor IS NOT NULL)'
      ).run(windowEnd, caughtUp ? null : windowEnd, accountId, journalId, windowEnd);
      return r.changes > 0;
    },

    removeLink(accountId, journalId) {
      db().prepare('DELETE FROM webull_link WHERE account_id = ? AND journal_id = ?').run(accountId, journalId);
    },

    // Explicit cleanup; deleting the auth record does the same through the
    // webull_account_deleted trigger.
    deleteAccount(accountId) {
      db().prepare('DELETE FROM webull_link WHERE account_id = ?').run(accountId);
      db().prepare('DELETE FROM webull_connection WHERE account_id = ?').run(accountId);
    },
  };
}

module.exports = {
  LinkConflictError,
  createWebullStore,
};
