// Webull Order History reader for Denarii Local (docs/webull-local-plan.md
// sections 3 and 8). Runs in the Electron main process.
//
// computeWindow, normalizeOrder, collectPage, parseAccounts and
// parseExpiresAt (and their helpers) were adapted unchanged from the earlier
// cloud version's Webull API route. Everything below "Local runner" replaces
// that version's sync/commit actions:
//   - 90-day windows from the link's start date (default 2018-05-21), each
//     followed to its last page.
//   - Calls at least 1.1 s apart, each with an 8 s timeout.
//   - 429: back off 5 s, then 30 s, then stop with "Webull is busy".
//   - Each window is handed to the page (deliver) and the cursor moves only
//     when the page acknowledges that it saved the window.
//   - An aborted run (detach, quit) writes nothing.
//
// No electron import: fetch, the clock and the store are passed in, so
// tests/electron-webull-fetch.test.js runs it under node --test.

const webull = require('./readonly');

const MESSAGES = Object.freeze({
  rejected: 'Webull rejected the credentials.',
  rejectedReconnect: 'Webull rejected the credentials. Reconnect with a new key.',
  pending: 'Approve Denarii in the Webull app, then tap Check again.',
  expired: 'Your Webull approval expired. Tap Send new code.',
  cantReadAccounts: "Your Webull key can't read accounts. Check that Trading is enabled.",
  codeSent: 'Enter the code Webull texted you in the Webull app, then tap Check again.',
  notConnected: 'Webull is not connected.',
  alreadyApproved: 'Webull is already approved.',
  decryptFailed: 'Stored credentials could not be read; please reconnect.',
  busy: 'Webull is busy. Try again in a minute.',
  unavailable: 'Webull is unavailable.',
  cooldown: 'Please wait a moment before trying again.',
  saveFailed: 'Could not save your Webull connection. Try again.',
  removeFailed: 'Could not remove your stored Webull keys.',
  generic: 'Something went wrong.',
  accountUnavailable: "This Webull account isn't available on your connection.",
  checkConnection: 'Check your Webull connection in Settings → Integrations.',
  storageUnavailable: 'Webull sync is not available on this computer.',
  badInput: 'Enter a valid App Key and App Secret.',
  badDate: 'Enter a start date between 2018-05-21 and today, or leave it empty.',
  alreadyLinked: 'This Webull account is already linked to another journal.',
  notSaved: 'The page could not save this window.',
});

const WEBULL_HOST = 'api.webull.com';
const WEBULL_TIMEOUT_MS = 8000;
const PAGE_GAP_MS = 1100;
const BACKOFF_MS = Object.freeze([5000, 30000]);
const HISTORY_START = '2018-05-21';
const MAX_WINDOWS_PER_RUN = 200;
const MAX_PAGES_PER_WINDOW = 1000;
const ACK_TIMEOUT_MS = 5 * 60 * 1000;

// ── Adapted unchanged from the cloud version's Webull route ───────────────

// Webull's pagination_key is opaque: any printable ASCII, capped so a cursor fits the 2 KB body.
const PAGE_KEY_RE = /^[\x21-\x7e]{1,512}$/;
const WINDOW_MS = 90 * 24 * 60 * 60 * 1000; // 90-day ranges confirmed live (plan §5a.1)
const OVERLAP_MS = 24 * 60 * 60 * 1000; // re-read the last 24 hours (plan §7.2)
// Kept orders: these statuses with filled_quantity > 0. CANCELLED counts
// because a partly filled order can be cancelled after its fills.
const KEEP_STATUSES = Object.freeze(['FILLED', 'PARTIAL_FILLED', 'CANCELLED']);

// Webull's expires_at format is unconfirmed: numbers (or numeric strings) are
// epoch seconds below 1e12 and milliseconds otherwise; anything else goes
// through Date.parse. Unparseable values become null.
function parseExpiresAt(value) {
  let ms = NaN;
  if (typeof value === 'number' || (typeof value === 'string' && /^\d+(\.\d+)?$/.test(value.trim()))) {
    const n = Number(value);
    ms = n < 1e12 ? n * 1000 : n;
  } else if (typeof value === 'string' && value.trim()) {
    ms = Date.parse(value);
  }
  if (!Number.isFinite(ms)) return null;
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

function timeMs(value) {
  if (!value) return NaN;
  return Date.parse(value);
}

// Account List returns an array (or { data: [...] }). Only account_id and the
// display label are kept; account_number and every other field is dropped.
// null means the shape wasn't recognized.
function parseAccounts(data) {
  const list = Array.isArray(data) ? data : data && Array.isArray(data.data) ? data.data : null;
  if (!list) return null;
  const out = [];
  for (const a of list) {
    if (!a || typeof a !== 'object') return null;
    const id = a.account_id;
    const okId = (typeof id === 'string' && id) || (typeof id === 'number' && Number.isFinite(id));
    if (!okId) return null;
    out.push({ id: String(id), label: typeof a.account_label === 'string' ? a.account_label.slice(0, 64) : '' });
  }
  return out;
}

// §7.2 start of the next window: backfill_cursor if set, otherwise
// max(import_start_at, last_synced_at - 24h). NaN if the row is unusable.
function syncBase(journal) {
  const start = timeMs(journal.import_start_at);
  if (!Number.isFinite(start)) return NaN;
  const backfill = timeMs(journal.backfill_cursor);
  if (Number.isFinite(backfill)) return backfill;
  const last = timeMs(journal.last_synced_at);
  return Number.isFinite(last) ? Math.max(start, last - OVERLAP_MS) : start;
}

// The window is always computed here. A cursor only moves the start forward
// within [base, now); otherwise it's ignored. The end is never client-supplied.
function computeWindow(journal, cursor, now) {
  const base = syncBase(journal);
  if (!Number.isFinite(base)) return null;
  const useCursor = cursor && cursor.s >= base && cursor.s < now;
  const start = useCursor ? cursor.s : base;
  return { start, end: Math.min(start + WINDOW_MS, now), key: useCursor ? cursor.k : null };
}

function toStr(v) {
  if (typeof v === 'string' && v) return v.slice(0, 64);
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return null;
}

function toNum(v) {
  if (typeof v === 'number') return v;
  if (typeof v === 'string' && /^\s*-?\d+(\.\d+)?\s*$/.test(v)) return Number(v);
  return NaN;
}

function numOrNull(v) {
  const n = toNum(v);
  return Number.isFinite(n) ? n : null;
}

// Webull label values (status, position_intent) used as stats keys.
function statKey(v) {
  return typeof v === 'string' && /^[A-Z_]{1,32}$/.test(v) ? v : 'OTHER';
}

function isKept(order) {
  return KEEP_STATUSES.includes(order.status) && toNum(order.filled_quantity) > 0;
}

// Builds one fill from an allowlist of fields, so account_number and anything
// unknown is dropped. Raw side / position_intent / order ids are kept for the
// client engine (phase 7). null means a required field is missing or bad.
// Times go through parseExpiresAt, which reads ISO strings and epoch values.
function normalizeOrder(group, o) {
  const orderId = toStr(o.order_id);
  const symbol = toStr(o.symbol);
  const side = toStr(o.side);
  const filledQty = toNum(o.filled_quantity);
  const filledPrice = toNum(o.filled_price);
  const filledAt = parseExpiresAt(o.filled_time_at) || parseExpiresAt(o.filled_time);
  if (!orderId || !symbol || !side || !(filledQty > 0) || !Number.isFinite(filledPrice) || !filledAt) return null;

  let fees = 0;
  for (const f of Array.isArray(o.fees) ? o.fees : []) {
    const v = toNum(f && f.actual_value);
    if (Number.isFinite(v)) fees += v;
  }
  const legs = (Array.isArray(o.legs) ? o.legs : [])
    .filter(l => l && typeof l === 'object')
    .slice(0, 8)
    .map(l => ({
      symbol: toStr(l.symbol),
      side: toStr(l.side),
      optionType: toStr(l.option_type),
      strike: numOrNull(l.strike_price),
      expiry: toStr(l.option_expire_date),
      multiplier: numOrNull(l.option_contract_multiplier),
      quantity: numOrNull(l.quantity),
    }));

  return {
    orderId,
    comboOrderId: toStr(group.combo_order_id),
    comboType: toStr(group.combo_type),
    instrumentType: toStr(o.instrument_type),
    symbol,
    side,
    positionIntent: toStr(o.position_intent),
    status: toStr(o.status),
    filledQty,
    filledPrice,
    totalQty: numOrNull(o.total_quantity),
    filledAt,
    placedAt: parseExpiresAt(o.place_time_at) || parseExpiresAt(o.place_time),
    fees: Math.round(fees * 1e6) / 1e6,
    optionStrategy: toStr(o.option_strategy),
    legs,
  };
}

function newStats() {
  return {
    groups: 0, orders: 0, kept: 0, statusCounts: {}, cancelledWithFills: 0,
    intentCounts: {}, optionsMissingIntent: 0, multiLeg: 0, malformed: 0,
  };
}

// Adds one page's kept orders to result.fills. Orders already seen in this
// call are skipped. Returns how many new order ids the page had.
function collectPage(groups, seen, result) {
  const stats = result.stats;
  let fresh = 0;
  for (const g of groups) {
    if (!g || typeof g !== 'object') { stats.malformed++; continue; }
    stats.groups++;
    for (const o of Array.isArray(g.orders) ? g.orders : []) {
      stats.orders++;
      const id = o && typeof o === 'object' ? toStr(o.order_id) : null;
      if (!id) { stats.malformed++; continue; }
      if (seen.has(id)) continue;
      seen.add(id);
      fresh++;
      const status = statKey(o.status);
      stats.statusCounts[status] = (stats.statusCounts[status] || 0) + 1;
      if (!isKept(o)) continue;
      const fill = normalizeOrder(g, o);
      if (!fill) { stats.malformed++; continue; }
      stats.kept++;
      if (fill.status === 'CANCELLED') stats.cancelledWithFills++;
      if (fill.positionIntent) {
        const intent = statKey(fill.positionIntent);
        stats.intentCounts[intent] = (stats.intentCounts[intent] || 0) + 1;
      } else if (fill.instrumentType === 'OPTION') {
        stats.optionsMissingIntent++;
      }
      if (fill.legs.length > 1) stats.multiLeg++;
      result.fills.push(fill);
    }
  }
  return fresh;
}

// ── Local runner ──────────────────────────────────────────────────────────

// Real clock. Tests pass a fake with the same shape.
const systemClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h),
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h),
  // Resolves after ms, or rejects with an AbortError when signal aborts.
  sleep(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal && signal.aborted) return reject(abortError());
      const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
      const onAbort = () => { clearTimeout(timer); reject(abortError()); };
      if (signal) signal.addEventListener('abort', onAbort, { once: true });
    });
  },
});

function abortError() {
  const e = new Error('Aborted.');
  e.name = 'AbortError';
  e.aborted = true;
  return e;
}

// Why a journal's run stopped. status is the webull_link.last_status value.
class SyncStop extends Error {
  constructor(status, message, opts) {
    super(message);
    this.name = 'SyncStop';
    this.status = status;           // 'needs_approval' | 'error' | 'busy' | 'offline' | 'aborted'
    this.approvalState = (opts && opts.approvalState) || null; // connection state to record
    this.stopAll = !!(opts && opts.stopAll); // stop the other journals in this run too
  }
}

// 'YYYY-MM-DD' -> UTC midnight in ms, or NaN.
function dateToMs(date) {
  if (typeof date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return NaN;
  const ms = Date.parse(date + 'T00:00:00.000Z');
  return Number.isFinite(ms) && new Date(ms).toISOString().slice(0, 10) === date ? ms : NaN;
}

// A webull_link row in the shape computeWindow reads (ISO strings).
function linkToJournal(link) {
  const iso = ms => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);
  const start = dateToMs(link.startDate || HISTORY_START);
  return {
    import_start_at: iso(Number.isFinite(start) ? start : dateToMs(HISTORY_START)),
    last_synced_at: iso(link.lastSyncedAt),
    backfill_cursor: iso(link.backfillCursor),
  };
}

// One Webull call with an 8-second abort covering the request and the body
// read. The run's signal (detach, quit) aborts it too.
async function callWebull(fn, opts, env) {
  const { fetchImpl, clock = systemClock, signal } = env || {};
  if (signal && signal.aborted) throw abortError();
  const controller = new AbortController();
  let timedOut = false;
  const timer = clock.setTimeout(() => { timedOut = true; controller.abort(); }, WEBULL_TIMEOUT_MS);
  const onAbort = () => controller.abort();
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  const doFetch = fetchImpl || fetch;
  try {
    return await fn({
      ...opts,
      host: WEBULL_HOST,
      fetchImpl: (url, init) => doFetch(url, { ...init, signal: controller.signal }),
    });
  } catch (err) {
    if (signal && signal.aborted && !timedOut) throw abortError();
    if (timedOut && err) err.timedOut = true;
    throw err;
  } finally {
    clock.clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

// Maps a failed read (Order History) to a SyncStop. 429 is handled by the caller.
function readFailure(err) {
  if (err && err.aborted) return new SyncStop('aborted', '');
  const status = err && typeof err.status === 'number' ? err.status : 0;
  if (status === 401) return new SyncStop('needs_approval', MESSAGES.expired, { approvalState: 'needs_approval', stopAll: true });
  if (status === 403) return new SyncStop('error', MESSAGES.cantReadAccounts, { approvalState: 'unknown', stopAll: true });
  if (status === 429) return new SyncStop('busy', MESSAGES.busy, { stopAll: true });
  if (!status) return new SyncStop('offline', MESSAGES.unavailable, { stopAll: true });
  return new SyncStop('error', MESSAGES.unavailable, { stopAll: true });
}

// Calls at least PAGE_GAP_MS apart across a whole run (all journals).
function createPacer(clock, gapMs) {
  let lastCallAt = 0;
  return async (signal) => {
    if (lastCallAt) {
      const wait = lastCallAt + gapMs - clock.now();
      if (wait > 0) await clock.sleep(wait, signal);
    }
    lastCallAt = clock.now();
  };
}

// One Order History page, with the 429 back-off (5 s, then 30 s).
async function readPage(query, ctx) {
  const { creds, env, pace, clock, signal } = ctx;
  for (let attempt = 0; ; attempt++) {
    await pace(signal);
    try {
      return await callWebull(webull.getOrderHistory, {
        appKey: creds.appKey, appSecret: creds.appSecret, accessToken: creds.token, query,
      }, env);
    } catch (err) {
      if (err && err.status === 429 && attempt < BACKOFF_MS.length) {
        await clock.sleep(BACKOFF_MS[attempt], signal);
        continue;
      }
      throw readFailure(err);
    }
  }
}

// Every page of one window. Paging that doesn't advance stops the window
// with "Webull is unavailable" rather than looping.
async function readWindow(webullAccountId, win, ctx) {
  const result = { fills: [], stats: newStats(), pages: 0 };
  const seen = new Set();
  let key = null;
  for (;;) {
    if (result.pages >= MAX_PAGES_PER_WINDOW) throw new SyncStop('error', MESSAGES.unavailable);
    const page = await readPage({
      account_id: webullAccountId,
      start_time: new Date(win.start).toISOString(),
      end_time: new Date(win.end).toISOString(),
      pagination_key: key || undefined,
    }, ctx);
    const groups = Array.isArray(page) ? page : page && Array.isArray(page.data) ? page.data : null;
    if (!groups) throw new SyncStop('error', MESSAGES.unavailable);
    result.pages++;
    const fresh = collectPage(groups, seen, result);
    const next = page && !Array.isArray(page) ? page.pagination_key : undefined;
    if (next === undefined || next === null || next === '') return result;
    if (typeof next !== 'string' || !PAGE_KEY_RE.test(next) || next === key || fresh === 0) {
      throw new SyncStop('error', MESSAGES.unavailable);
    }
    key = next;
  }
}

// Imports one linked journal window by window until caught up.
//   ctx: { accountId, link, creds, store, deliver(batch) -> Promise<{ ok, error? }>,
//          onProgress(progress), env: { fetchImpl, clock, signal }, pace, clock, signal }
// Returns { status: 'ok', windows, orders }; throws SyncStop otherwise.
// Writes only webull_link cursors, and only after an acknowledged window.
async function runJournal(ctx) {
  const { accountId, link, store, deliver, onProgress, clock, signal } = ctx;
  let current = link;
  let orders = 0;
  for (let index = 1; index <= MAX_WINDOWS_PER_RUN; index++) {
    if (signal && signal.aborted) throw new SyncStop('aborted', '');
    const now = clock.now();
    const win = computeWindow(linkToJournal(current), null, now);
    if (!win) throw new SyncStop('error', MESSAGES.generic);
    if (win.start >= win.end) return { status: 'ok', windows: index - 1, orders };

    const windowCount = index - 1 + Math.max(1, Math.ceil((now - win.start) / WINDOW_MS));
    const progress = {
      journalId: link.journalId,
      windowIndex: index,
      windowCount,
      windowStart: new Date(win.start).toISOString(),
      windowEnd: new Date(win.end).toISOString(),
      ordersSoFar: orders,
    };
    if (onProgress) onProgress(progress);

    const data = await readWindow(current.webullAccountId, win, ctx);
    if (signal && signal.aborted) throw new SyncStop('aborted', '');

    let ack;
    try {
      ack = await deliver({
        accountId,
        journalId: link.journalId,
        webullAccountId: current.webullAccountId,
        windowStart: progress.windowStart,
        windowEnd: progress.windowEnd,
        fills: data.fills,
        stats: data.stats,
      });
    } catch (e) {
      if (signal && signal.aborted) throw new SyncStop('aborted', '');
      throw new SyncStop('error', MESSAGES.notSaved);
    }
    if (signal && signal.aborted) throw new SyncStop('aborted', '');
    if (!ack || ack.ok !== true) throw new SyncStop('error', MESSAGES.notSaved);

    const caughtUp = win.end >= now;
    store.ackWindow(accountId, link.journalId, win.end, caughtUp);
    orders += data.fills.length;
    if (onProgress) onProgress({ ...progress, ordersSoFar: orders });
    current = store.getLink(accountId, link.journalId);
    if (!current) throw new SyncStop('aborted', ''); // link removed mid-run
    if (caughtUp) return { status: 'ok', windows: index, orders };
  }
  // More than MAX_WINDOWS_PER_RUN windows: carry on at the next tick.
  return { status: 'ok', windows: MAX_WINDOWS_PER_RUN, orders, more: true };
}

module.exports = {
  MESSAGES,
  WEBULL_HOST,
  WEBULL_TIMEOUT_MS,
  PAGE_GAP_MS,
  BACKOFF_MS,
  HISTORY_START,
  WINDOW_MS,
  OVERLAP_MS,
  ACK_TIMEOUT_MS,
  PAGE_KEY_RE,
  parseExpiresAt,
  parseAccounts,
  syncBase,
  computeWindow,
  normalizeOrder,
  collectPage,
  newStats,
  systemClock,
  abortError,
  SyncStop,
  dateToMs,
  linkToJournal,
  callWebull,
  readFailure,
  createPacer,
  readPage,
  readWindow,
  runJournal,
};
