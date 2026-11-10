// IPC for window.denariiWebull (docs/webull-local-plan.md section 7).
//
// Every handler first checks that the sender frame is the app (app://denarii)
// and that the database is open, like the store and auto sign-in handlers.
// Arguments are checked by type, pattern and length here, before they reach
// the scheduler. Every call except attach acts on the signed-in account the
// sending page attached, and only that page may make it.
//
// No electron import: main.js passes ipcMain, so
// tests/electron-webull-ipc.test.js can drive the handlers with fakes.

const { isValidAccountId } = require('../auto-signin');
const { APP_KEY_RE, APP_SECRET_RE, isValidStartDate } = require('./connection');
const { MESSAGES } = require('./fetch');
const { NOT_ATTACHED } = require('./scheduler');

const PREFIX = 'denarii-webull:';
const JOURNAL_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const WEBULL_ACCOUNT_ID_RE = /^[\x21-\x7e]{1,64}$/;
const RUN_ID_RE = /^[0-9a-f]{32}$/;
const MAX_FIELD_LENGTH = 256;
const MAX_ACK_ERROR_LENGTH = 500;
const INVALID = 'Invalid request.';

const invalid = (error) => ({ ok: false, error: error || INVALID });

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v) && Object.getPrototypeOf(v) === Object.prototype;
}

function hasOnlyKeys(obj, allowed) {
  return Object.keys(obj).every(k => allowed.includes(k));
}

// null / undefined / '' mean "all history".
function normalizeStartDate(v) {
  return v === undefined || v === null || v === '' ? null : v;
}

function checkStartDate(v, now) {
  const d = normalizeStartDate(v);
  if (d !== null && typeof d !== 'string') return false;
  return isValidStartDate(d, now);
}

// -> null when valid, else the { ok: false, error } to return.
const validate = {
  attach(accountId) {
    return isValidAccountId(accountId) ? null : invalid();
  },
  connect(input, now) {
    if (!isPlainObject(input) || !hasOnlyKeys(input, ['appKey', 'appSecret', 'startDate'])) return invalid();
    const { appKey, appSecret } = input;
    if (typeof appKey !== 'string' || typeof appSecret !== 'string' ||
        appKey.length > MAX_FIELD_LENGTH || appSecret.length > MAX_FIELD_LENGTH ||
        !APP_KEY_RE.test(appKey.trim()) || !APP_SECRET_RE.test(appSecret.trim())) {
      return invalid(MESSAGES.badInput);
    }
    return checkStartDate(input.startDate, now) ? null : invalid(MESSAGES.badDate);
  },
  setLink(input, now) {
    if (!isPlainObject(input) || !hasOnlyKeys(input, ['journalId', 'webullAccountId', 'startDate'])) return invalid();
    if (typeof input.journalId !== 'string' || !JOURNAL_ID_RE.test(input.journalId)) return invalid();
    if (typeof input.webullAccountId !== 'string' || !WEBULL_ACCOUNT_ID_RE.test(input.webullAccountId)) return invalid();
    return checkStartDate(input.startDate, now) ? null : invalid(MESSAGES.badDate);
  },
  journalId(journalId) {
    return typeof journalId === 'string' && JOURNAL_ID_RE.test(journalId) ? null : invalid();
  },
  optionalJournalId(journalId) {
    return journalId === undefined || journalId === null ? null : validate.journalId(journalId);
  },
  ack(runId, result) {
    if (typeof runId !== 'string' || !RUN_ID_RE.test(runId)) return invalid();
    if (!isPlainObject(result) || !hasOnlyKeys(result, ['ok', 'error']) || typeof result.ok !== 'boolean') return invalid();
    if (result.error !== undefined && result.error !== null &&
        (typeof result.error !== 'string' || result.error.length > MAX_ACK_ERROR_LENGTH)) return invalid();
    return null;
  },
};

// opts: { ipcMain, isAppUrl(url), isOpen() -> boolean, getScheduler() -> scheduler, now? }
function registerWebullIpc(opts) {
  const { ipcMain, isAppUrl, isOpen, getScheduler } = opts;
  const now = opts.now || Date.now;

  const guard = (event) => {
    const url = event && event.senderFrame && event.senderFrame.url;
    if (!url || !isAppUrl(url)) throw new Error('Not allowed.');
    if (!isOpen()) throw new Error('Database is closed.');
    const scheduler = getScheduler();
    if (!scheduler) throw new Error('Webull sync is not ready.');
    return scheduler;
  };

  // Calls made for the attached account must come from the attached page.
  const attachedOnly = (fn) => (event, ...args) => {
    const scheduler = guard(event);
    if (!scheduler.isAttached(event.sender)) return { ok: false, error: NOT_ATTACHED };
    return fn(scheduler, event, ...args);
  };

  const handlers = {
    attach: (event, accountId) => {
      const scheduler = guard(event);
      return validate.attach(accountId) || scheduler.attach(event.sender, accountId);
    },
    // Only the attached page can detach; anything else is a no-op.
    detach: (event) => {
      const scheduler = guard(event);
      if (scheduler.isAttached(event.sender)) scheduler.detach();
      return { ok: true };
    },
    status: attachedOnly(s => s.status()),
    connect: attachedOnly((s, event, input) => {
      const bad = validate.connect(input, now());
      if (bad) return bad;
      return s.connect({ appKey: input.appKey, appSecret: input.appSecret, startDate: normalizeStartDate(input.startDate) });
    }),
    checkApproval: attachedOnly(s => s.checkApproval()),
    resendCode: attachedOnly(s => s.resendCode()),
    disconnect: attachedOnly(s => s.disconnect()),
    setLink: attachedOnly((s, event, input) => {
      const bad = validate.setLink(input, now());
      if (bad) return bad;
      return s.setLink({ journalId: input.journalId, webullAccountId: input.webullAccountId, startDate: normalizeStartDate(input.startDate) });
    }),
    removeLink: attachedOnly((s, event, journalId) => validate.journalId(journalId) || s.removeLink(journalId)),
    syncNow: attachedOnly((s, event, journalId) => validate.optionalJournalId(journalId) || s.syncNow(journalId)),
    ackBatch: attachedOnly((s, event, runId, result) => {
      const bad = validate.ack(runId, result);
      if (bad) return bad;
      return s.ackBatch(event.sender, runId, { ok: result.ok, error: result.error || null });
    }),
  };

  for (const [name, fn] of Object.entries(handlers)) ipcMain.handle(PREFIX + name, fn);
  return Object.keys(handlers).map(n => PREFIX + n);
}

module.exports = {
  PREFIX,
  JOURNAL_ID_RE,
  WEBULL_ACCOUNT_ID_RE,
  RUN_ID_RE,
  validate,
  registerWebullIpc,
};
