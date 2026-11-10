// Webull connection for one local Denarii account (docs/webull-local-plan.md
// sections 1, 2 and 8): connect, checkApproval, resendCode, status,
// disconnect, plus the credentials a sync run needs.
//
// The logic and messages were adapted from the earlier cloud version's Webull
// API route. Its database rows became the SQLite webull_connection row
// (store.js) and its AES-GCM secret box became async safeStorage (Windows DPAPI):
//   creds = encryptStringAsync(JSON {v, accountId, appKey, appSecret})
//   token = encryptStringAsync(JSON {v, accountId, token})
// accountId inside each blob is checked on decrypt, so a blob copied into
// another account's row is rejected. status() never decrypts anything and
// never returns the key, secret or token.
//
// Cooldowns are in-memory timestamps: Check again every 10 s, a new code
// (connect or Send new code) every 60 s.
//
// No electron import: safeStorage, the store, fetch and the clock are passed
// in, so tests/electron-webull-connection.test.js runs it under node --test.

const webull = require('./readonly');
const { isAvailable } = require('../auto-signin');
const { MESSAGES, HISTORY_START, SyncStop, callWebull, dateToMs, parseAccounts, parseExpiresAt, systemClock } = require('./fetch');

const BLOB_VERSION = 1;
const CONNECT_COOLDOWN_MS = 60 * 1000;
const CHECK_COOLDOWN_MS = 10 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
// Real App Keys look like "us." plus alphanumerics, so the key allows periods.
const APP_KEY_RE = /^[A-Za-z0-9._-]{16,128}$/;
const APP_SECRET_RE = /^[A-Za-z0-9_-]{16,128}$/;
const APPROVAL_STATES = Object.freeze(['ok', 'needs_approval', 'unknown']);

class DecryptError extends Error {
  constructor() {
    super(MESSAGES.decryptFailed);
    this.name = 'DecryptError';
  }
}

// null (all history) or a real 'YYYY-MM-DD' between 2018-05-21 and today (UTC).
function isValidStartDate(date, nowMs) {
  if (date === null || date === undefined) return true;
  const ms = dateToMs(date);
  if (!Number.isFinite(ms)) return false;
  const today = dateToMs(new Date(nowMs === undefined ? Date.now() : nowMs).toISOString().slice(0, 10));
  return ms >= dateToMs(HISTORY_START) && ms <= today;
}

function ok(body) { return Object.assign({ ok: true }, body); }
function fail(error, extra) { return Object.assign({ ok: false, error }, extra || {}); }

function cleanAccounts(value) {
  if (!Array.isArray(value)) return [];
  return value
    .filter(a => a && typeof a === 'object' && (typeof a.id === 'string' || typeof a.id === 'number'))
    .map(a => ({ id: String(a.id), label: typeof a.label === 'string' ? a.label : '' }));
}

// Webull errors carry only err.status (or nothing for network, timeout and
// bad JSON). on401 / on403 are the call-specific results; a 403 without
// on403 is treated as unavailable.
function mapWebullError(err, on401, on403) {
  const status = err && typeof err.status === 'number' ? err.status : 0;
  if (status === 401) return on401;
  if (status === 403 && on403) return on403;
  if (status === 429) return fail(MESSAGES.busy);
  return fail(MESSAGES.unavailable);
}

const isoOrNull = ms => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
const parseExpiresMs = v => { const iso = parseExpiresAt(v); return iso ? Date.parse(iso) : null; };

// opts: { store, safeStorage, platform?, fetchImpl?, clock? }
function createConnection(opts) {
  const { store, safeStorage, platform, fetchImpl } = opts;
  const clock = opts.clock || systemClock;
  const env = { fetchImpl, clock };
  const lastTokenAt = new Map();  // accountId -> ms of the last new code
  const lastCheckAt = new Map();  // accountId -> ms of the last Check Token
  let queue = Promise.resolve();

  // Calls that change the row run one at a time in arrival order.
  const serial = (fn) => {
    const p = queue.then(fn);
    queue = p.catch(() => {});
    return p;
  };

  const encryptJson = async (obj) => Buffer.from(await safeStorage.encryptStringAsync(JSON.stringify(obj)));

  // Decrypts one blob and checks its version, account and fields. When
  // safeStorage asks for re-encryption, the column is rewritten (best effort).
  async function decryptBlob(accountId, blob, column, fields) {
    let entry, shouldReEncrypt;
    try {
      if (!blob) throw new Error('missing');
      const r = await safeStorage.decryptStringAsync(Buffer.from(blob));
      shouldReEncrypt = !!(r && r.shouldReEncrypt);
      entry = JSON.parse(r && r.result);
    } catch (e) {
      throw new DecryptError();
    }
    if (!entry || typeof entry !== 'object' || entry.v !== BLOB_VERSION || entry.accountId !== accountId ||
        !fields.every(f => typeof entry[f] === 'string' && entry[f])) {
      throw new DecryptError();
    }
    if (shouldReEncrypt) {
      try { store.updateConnection(accountId, { [column]: await encryptJson(entry) }); } catch (e) { /* keep the old blob */ }
    }
    return entry;
  }

  const readCreds = (accountId, row) => decryptBlob(accountId, row.creds, 'creds', ['appKey', 'appSecret']);
  const readToken = (accountId, row) => decryptBlob(accountId, row.token, 'token', ['token']);

  const retryAfter = (last, windowMs) => ({ retryAfterSec: Math.max(1, Math.ceil((last + windowMs - clock.now()) / 1000)) });

  return {
    // -> { ok: true, approvalState: 'needs_approval', last4 } | { ok: false, error, retryAfterSec? }
    connect(accountId, input) {
      return serial(async () => {
        const appKey = input && typeof input.appKey === 'string' ? input.appKey.trim() : '';
        const appSecret = input && typeof input.appSecret === 'string' ? input.appSecret.trim() : '';
        const startDate = input && input.startDate !== undefined && input.startDate !== '' ? input.startDate : null;
        if (!APP_KEY_RE.test(appKey) || !APP_SECRET_RE.test(appSecret)) return fail(MESSAGES.badInput);
        if (!isValidStartDate(startDate, clock.now())) return fail(MESSAGES.badDate);

        // Fail on unavailable secure storage before Webull sends a text code.
        if (!(await isAvailable(safeStorage, platform))) return fail(MESSAGES.storageUnavailable);
        const last = lastTokenAt.get(accountId);
        if (last && clock.now() - last < CONNECT_COOLDOWN_MS) return fail(MESSAGES.cooldown, retryAfter(last, CONNECT_COOLDOWN_MS));

        let data;
        try {
          data = await callWebull(webull.createToken, { appKey, appSecret }, env);
        } catch (err) {
          // 401: the signature was rejected, so the keys are wrong. Nothing is saved.
          return mapWebullError(err, fail(MESSAGES.rejected));
        }
        const token = data && typeof data.token === 'string' ? data.token : '';
        if (!token) return fail(MESSAGES.unavailable);
        const now = clock.now();
        lastTokenAt.set(accountId, now);
        lastCheckAt.delete(accountId);

        const last4 = appKey.slice(-4);
        try {
          store.putConnection(accountId, {
            creds: await encryptJson({ v: BLOB_VERSION, accountId, appKey, appSecret }),
            token: await encryptJson({ v: BLOB_VERSION, accountId, token }),
            appKeyLast4: last4,
            approvalState: 'needs_approval',
            tokenExpiresAt: parseExpiresMs(data.expires_at),
            tokenCreatedAt: now,
            tokenCheckedAt: null,
            webullAccounts: null,
            defaultStartDate: startDate,
          });
        } catch (e) {
          // The token Webull just created is lost; the user needs one more text code.
          return fail(MESSAGES.saveFailed);
        }
        return ok({ approvalState: 'needs_approval', last4 });
      });
    },

    // At most two Webull calls: Check Token, plus Account List on NORMAL.
    // -> { ok: true, approvalState, accounts?, message? } | { ok: false, error, retryAfterSec? }
    checkApproval(accountId) {
      return serial(async () => {
        const row = store.getConnection(accountId);
        if (!row) return fail(MESSAGES.notConnected);
        const last = lastCheckAt.get(accountId);
        if (last && clock.now() - last < CHECK_COOLDOWN_MS) return fail(MESSAGES.cooldown, retryAfter(last, CHECK_COOLDOWN_MS));
        const now = clock.now();
        lastCheckAt.set(accountId, now);
        store.updateConnection(accountId, { tokenCheckedAt: now });

        if (!row.token) return ok({ approvalState: 'needs_approval', accounts: [], message: MESSAGES.expired });

        let creds, tok;
        try {
          creds = await readCreds(accountId, row);
          tok = await readToken(accountId, row);
        } catch (e) {
          return fail(MESSAGES.decryptFailed);
        }
        const keys = { appKey: creds.appKey, appSecret: creds.appSecret };

        let check;
        try {
          check = await callWebull(webull.checkToken, { ...keys, token: tok.token }, env);
        } catch (err) {
          if (err && err.status === 401) store.updateConnection(accountId, { approvalState: 'unknown' });
          return mapWebullError(err, fail(MESSAGES.rejectedReconnect));
        }
        const tokenStatus = check && typeof check.status === 'string' ? check.status : '';

        if (tokenStatus === 'PENDING') {
          store.updateConnection(accountId, { approvalState: 'needs_approval' });
          return ok({ approvalState: 'needs_approval', accounts: [], message: MESSAGES.pending });
        }
        if (tokenStatus === 'EXPIRED' || tokenStatus === 'INVALID') {
          // The token is dead: drop it so the next step is a new code.
          store.updateConnection(accountId, { approvalState: 'needs_approval', token: null, tokenExpiresAt: null });
          return ok({ approvalState: 'needs_approval', accounts: [], message: MESSAGES.expired });
        }
        if (tokenStatus !== 'NORMAL') {
          store.updateConnection(accountId, { approvalState: 'unknown' });
          return fail(MESSAGES.unavailable);
        }

        let list;
        try {
          list = await callWebull(webull.getAccountList, { ...keys, accessToken: tok.token }, env);
        } catch (err) {
          const status = err && err.status;
          if (status === 401) {
            store.updateConnection(accountId, { approvalState: 'needs_approval' });
            return ok({ approvalState: 'needs_approval', accounts: [], message: MESSAGES.expired });
          }
          if (status === 403) store.updateConnection(accountId, { approvalState: 'unknown' });
          return mapWebullError(err, null, fail(MESSAGES.cantReadAccounts));
        }
        const accounts = parseAccounts(list);
        if (!accounts) return fail(MESSAGES.unavailable);

        store.updateConnection(accountId, {
          webullAccounts: accounts,
          approvalState: 'ok',
          tokenExpiresAt: parseExpiresMs(check.expires_at),
        });
        return ok({ approvalState: 'ok', accounts });
      });
    },

    // Mints a new token, so Webull texts a new code. Refused while the stored
    // token is approved and unexpired, and at most once per 60 seconds.
    // -> { ok: true, approvalState: 'needs_approval', message } | { ok: false, error, retryAfterSec? }
    resendCode(accountId) {
      return serial(async () => {
        const row = store.getConnection(accountId);
        if (!row) return fail(MESSAGES.notConnected);
        const now = clock.now();
        if (row.approvalState === 'ok' && row.token && typeof row.tokenExpiresAt === 'number' && row.tokenExpiresAt > now) {
          return fail(MESSAGES.alreadyApproved);
        }
        const last = lastTokenAt.get(accountId);
        if (last && now - last < RESEND_COOLDOWN_MS) return fail(MESSAGES.cooldown, retryAfter(last, RESEND_COOLDOWN_MS));
        lastTokenAt.set(accountId, now);

        let creds;
        try {
          creds = await readCreds(accountId, row);
        } catch (e) {
          return fail(MESSAGES.decryptFailed);
        }

        let data;
        try {
          data = await callWebull(webull.createToken, { appKey: creds.appKey, appSecret: creds.appSecret }, env);
        } catch (err) {
          if (err && err.status === 401) store.updateConnection(accountId, { approvalState: 'unknown' });
          return mapWebullError(err, fail(MESSAGES.rejectedReconnect));
        }
        const token = data && typeof data.token === 'string' ? data.token : '';
        if (!token) return fail(MESSAGES.unavailable);

        store.updateConnection(accountId, {
          token: await encryptJson({ v: BLOB_VERSION, accountId, token }),
          approvalState: 'needs_approval',
          tokenExpiresAt: parseExpiresMs(data.expires_at),
          tokenCreatedAt: clock.now(),
          tokenCheckedAt: null,
        });
        lastCheckAt.delete(accountId);
        return ok({ approvalState: 'needs_approval', message: MESSAGES.codeSent });
      });
    },

    // Database only; no Webull call and no decrypt. Never includes the key,
    // secret or token.
    status(accountId) {
      const row = store.getConnection(accountId);
      if (!row) return { connected: false };
      let approvalState = APPROVAL_STATES.includes(row.approvalState) ? row.approvalState : 'unknown';
      // Derived for the response only; nothing is written.
      if (approvalState === 'ok' && typeof row.tokenExpiresAt === 'number' && row.tokenExpiresAt <= clock.now()) {
        approvalState = 'needs_approval';
      }
      return {
        connected: true,
        last4: typeof row.appKeyLast4 === 'string' ? row.appKeyLast4 : '',
        approvalState,
        approvalExpiresAt: isoOrNull(row.tokenExpiresAt),
        accounts: cleanAccounts(row.webullAccounts),
        defaultStartDate: typeof row.defaultStartDate === 'string' ? row.defaultStartDate : null,
      };
    },

    // Deletes the connection; links and trades stay. -> { ok: true } | { ok: false, error }
    disconnect(accountId) {
      return serial(async () => {
        try {
          return store.deleteConnection(accountId) ? ok({}) : fail(MESSAGES.removeFailed);
        } catch (e) {
          return fail(MESSAGES.removeFailed);
        }
      });
    },

    // The Webull accounts on this connection, [] when not connected.
    accounts(accountId) {
      const row = store.getConnection(accountId);
      return row ? cleanAccounts(row.webullAccounts) : [];
    },

    // Keys and token for a sync run, or a SyncStop with stopAll set. No
    // Webull call is made unless the connection is approved with a live token.
    async syncCredentials(accountId) {
      const row = store.getConnection(accountId);
      if (!row) throw new SyncStop('error', MESSAGES.notConnected, { stopAll: true });
      const now = clock.now();
      const tokenLive = !!row.token && !(typeof row.tokenExpiresAt === 'number' && row.tokenExpiresAt <= now);
      if (row.approvalState === 'needs_approval') {
        throw new SyncStop('needs_approval', tokenLive ? MESSAGES.pending : MESSAGES.expired, { stopAll: true });
      }
      if (row.approvalState !== 'ok') throw new SyncStop('error', MESSAGES.checkConnection, { stopAll: true });
      if (!tokenLive) {
        store.updateConnection(accountId, { approvalState: 'needs_approval' });
        throw new SyncStop('needs_approval', MESSAGES.expired, { stopAll: true });
      }
      try {
        const creds = await readCreds(accountId, row);
        const tok = await readToken(accountId, row);
        return { appKey: creds.appKey, appSecret: creds.appSecret, token: tok.token, accounts: cleanAccounts(row.webullAccounts) };
      } catch (e) {
        throw new SyncStop('error', MESSAGES.decryptFailed, { stopAll: true });
      }
    },

    // Records the approval state a sync run found (401 -> needs_approval, 403 -> unknown).
    setApprovalState(accountId, state) {
      if (APPROVAL_STATES.includes(state)) store.updateConnection(accountId, { approvalState: state });
    },
  };
}

module.exports = {
  BLOB_VERSION,
  CONNECT_COOLDOWN_MS,
  CHECK_COOLDOWN_MS,
  RESEND_COOLDOWN_MS,
  APP_KEY_RE,
  APP_SECRET_RE,
  DecryptError,
  isValidStartDate,
  mapWebullError,
  createConnection,
};
