// Webull sync scheduler for Denarii Local (docs/webull-local-plan.md
// sections 6-8). One page is attached at a time, for one signed-in local
// account:
//   - attach runs a sync right away, then every 15 minutes.
//   - Linked journals run one at a time, 2 s apart; nothing runs while no
//     page is attached.
//   - Each window goes to the page as a batch; the cursor moves only when the
//     page acknowledges it (ackBatch with the batch's runId).
//   - detach (page navigation, crash, sign-out) and shutdown (before-quit)
//     abort the run and drop the unacknowledged batch, so nothing is written
//     and the next run resumes from the last acknowledged window.
//
// No electron import: main.js passes send(webContents, channel, payload)
// and the account check; tests pass fakes.

const crypto = require('crypto');
const { LinkConflictError } = require('./store');
const { isValidStartDate } = require('./connection');
const { MESSAGES, ACK_TIMEOUT_MS, PAGE_GAP_MS, SyncStop, abortError, createPacer, dateToMs, runJournal, systemClock } = require('./fetch');

const SYNC_INTERVAL_MS = 15 * 60 * 1000;
const JOURNAL_GAP_MS = 2000;
const BATCH_CHANNEL = 'denarii-webull:batch';
const STATUS_CHANNEL = 'denarii-webull:status';
const NOT_ATTACHED = 'Sign in to use Webull sync.';
const NOT_LINKED = "This journal isn't linked to Webull.";
const UNKNOWN_BATCH = 'Unknown batch.';

const isoOrNull = ms => (typeof ms === 'number' && Number.isFinite(ms) ? new Date(ms).toISOString() : null);

// opts: { store, connection, accountExists(accountId) -> boolean,
//         send(webContents, channel, payload), fetchImpl?, clock?, newRunId? }
function createScheduler(opts) {
  const { store, connection, accountExists, send, fetchImpl } = opts;
  const clock = opts.clock || systemClock;
  const newRunId = opts.newRunId || (() => crypto.randomBytes(16).toString('hex'));

  let attached = null;      // { accountId, wc }
  let interval = null;
  let run = null;           // { controller, promise, journalId }
  let pending = null;       // { runId, resolve, reject, timer }
  let closed = false;
  const progress = new Map(); // journalId -> latest progress of the attached account

  const emit = (payload) => {
    if (!attached) return;
    try { send(attached.wc, STATUS_CHANNEL, payload); } catch (e) { /* page gone */ }
  };

  // Writes are skipped after an abort: the database may already be closed.
  const safeWrite = (signal, fn) => {
    if (signal && signal.aborted) return;
    try { fn(); } catch (e) { /* database closed or row gone */ }
  };

  function dropPending() {
    if (!pending) return;
    const p = pending;
    pending = null;
    clock.clearTimeout(p.timer);
    p.reject(abortError());
  }

  function abortRun() {
    if (!run) return;
    run.controller.abort();
    dropPending();
  }

  // Hands one window to the page and waits for its acknowledgment.
  function deliver(wc, signal, batch) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) return reject(abortError());
      const runId = newRunId();
      const timer = clock.setTimeout(() => {
        if (pending && pending.runId === runId) { pending = null; reject(new Error('timeout')); }
      }, ACK_TIMEOUT_MS);
      pending = { runId, resolve, reject, timer };
      try {
        send(wc, BATCH_CHANNEL, Object.assign({ runId }, batch));
      } catch (e) {
        pending = null;
        clock.clearTimeout(timer);
        reject(e);
      }
    });
  }

  function recordStop(accountId, journalId, stop, signal) {
    safeWrite(signal, () => store.updateLink(accountId, journalId, {
      lastStatus: stop.status, lastError: stop.message || null, lastAttemptAt: clock.now(),
    }));
    emit({ kind: 'journal', journalId, status: stop.status, error: stop.message || null });
  }

  async function runAll(current, accountId, wc, onlyJournalId, signal) {
    const links = store.listLinks(accountId).filter(l => !onlyJournalId || l.journalId === onlyJournalId);
    if (!links.length) return;
    const pace = createPacer(clock, PAGE_GAP_MS);
    let creds = null;
    for (let i = 0; i < links.length; i++) {
      if (signal.aborted) return;
      const link = links[i];
      if (i > 0) {
        try { await clock.sleep(JOURNAL_GAP_MS, signal); } catch (e) { return; }
      }
      current.journalId = link.journalId;
      emit({ kind: 'journal', journalId: link.journalId, status: 'running', error: null });
      try {
        if (!creds) creds = await connection.syncCredentials(accountId);
        if (!creds.accounts.some(a => a.id === link.webullAccountId)) {
          throw new SyncStop('error', MESSAGES.accountUnavailable);
        }
        const result = await runJournal({
          accountId,
          link,
          creds,
          store,
          clock,
          signal,
          pace,
          env: { fetchImpl, clock, signal },
          deliver: batch => deliver(wc, signal, batch),
          onProgress: p => { progress.set(link.journalId, p); emit(Object.assign({ kind: 'progress' }, p)); },
        });
        safeWrite(signal, () => store.updateLink(accountId, link.journalId, {
          lastStatus: 'ok', lastError: null, lastAttemptAt: clock.now(),
        }));
        progress.delete(link.journalId);
        emit({ kind: 'journal', journalId: link.journalId, status: 'ok', error: null, orders: result.orders });
      } catch (err) {
        const stop = err instanceof SyncStop ? err : new SyncStop('error', MESSAGES.generic);
        if (stop.status === 'aborted' || signal.aborted) return;
        progress.delete(link.journalId);
        if (stop.approvalState) safeWrite(signal, () => connection.setApprovalState(accountId, stop.approvalState));
        recordStop(accountId, link.journalId, stop, signal);
        if (stop.stopAll) {
          // Main stops calling Webull until the next tick (or a new approval).
          for (const rest of links.slice(i + 1)) recordStop(accountId, rest.journalId, stop, signal);
          return;
        }
      }
    }
  }

  function startRun(journalId) {
    if (!attached || closed) return { ok: false, error: NOT_ATTACHED };
    if (run) return { ok: true, busy: true };
    if (!accountExists(attached.accountId)) {
      detach();
      return { ok: false, error: NOT_ATTACHED };
    }
    const { accountId, wc } = attached;
    const controller = new AbortController();
    const current = { controller, journalId: null, promise: null };
    run = current;
    emit({ kind: 'run', running: true });
    current.promise = runAll(current, accountId, wc, journalId, controller.signal)
      .catch(() => {})
      .finally(() => {
        if (run === current) {
          run = null;
          emit({ kind: 'run', running: false });
        }
      });
    return { ok: true, started: true };
  }

  function tick() {
    if (run) return;
    startRun();
  }

  function detach() {
    abortRun();
    run = null;
    if (interval) clock.clearInterval(interval);
    interval = null;
    attached = null;
    progress.clear();
    return { ok: true };
  }

  // Calls that would change what a run is reading stop it first; the
  // unacknowledged window is re-read next time.
  const requireAttached = () => (attached ? null : { ok: false, error: NOT_ATTACHED });

  return {
    attach(wc, accountId) {
      if (closed) return { ok: false, error: NOT_ATTACHED };
      if (!accountExists(accountId)) return { ok: false, error: NOT_ATTACHED };
      detach();
      attached = { accountId, wc };
      interval = clock.setInterval(tick, SYNC_INTERVAL_MS);
      startRun();
      return { ok: true };
    },

    detach,

    // True when wc is the attached page.
    isAttached(wc) {
      return !!attached && attached.wc === wc;
    },

    status() {
      const err = requireAttached();
      if (err) return err;
      const { accountId } = attached;
      const conn = connection.status(accountId);
      const links = store.listLinks(accountId).map(l => ({
        journalId: l.journalId,
        webullAccountId: l.webullAccountId,
        startDate: l.startDate || null,
        lastSyncedAt: isoOrNull(l.lastSyncedAt),
        status: run && run.journalId === l.journalId ? 'running' : (l.lastStatus || null),
        error: l.lastError || null,
        progress: progress.get(l.journalId) || null,
      }));
      return Object.assign({}, conn, { links });
    },

    connect(input) {
      const err = requireAttached();
      if (err) return Promise.resolve(err);
      abortRun();
      return connection.connect(attached.accountId, input);
    },

    checkApproval() {
      const err = requireAttached();
      return err ? Promise.resolve(err) : connection.checkApproval(attached.accountId);
    },

    resendCode() {
      const err = requireAttached();
      return err ? Promise.resolve(err) : connection.resendCode(attached.accountId);
    },

    disconnect() {
      const err = requireAttached();
      if (err) return Promise.resolve(err);
      abortRun();
      return connection.disconnect(attached.accountId);
    },

    // Links a journal to one of the connection's Webull accounts. Changing
    // the Webull account or moving the start date earlier starts the import
    // over from the start date (already-imported orders are skipped by the
    // page through externalOrderIds); moving it later keeps the cursor.
    setLink(input) {
      const err = requireAttached();
      if (err) return err;
      const { accountId } = attached;
      const { journalId, webullAccountId } = input;
      const startDate = input.startDate === undefined || input.startDate === '' ? null : input.startDate;
      if (!isValidStartDate(startDate, clock.now())) return { ok: false, error: MESSAGES.badDate };
      if (!connection.accounts(accountId).some(a => a.id === webullAccountId)) {
        return { ok: false, error: MESSAGES.accountUnavailable };
      }
      const existing = store.getLink(accountId, journalId);
      const patch = { webullAccountId, startDate };
      if (existing) {
        const oldStart = dateToMs(existing.startDate || '2018-05-21');
        const newStart = dateToMs(startDate || '2018-05-21');
        if (existing.webullAccountId !== webullAccountId || newStart < oldStart) {
          Object.assign(patch, { lastSyncedAt: null, backfillCursor: null, lastStatus: null, lastError: null });
        } else if (typeof existing.backfillCursor === 'number' && existing.backfillCursor < newStart) {
          patch.backfillCursor = null;
        }
      }
      abortRun();
      try {
        store.upsertLink(accountId, journalId, patch);
      } catch (e) {
        if (e instanceof LinkConflictError) return { ok: false, error: MESSAGES.alreadyLinked };
        throw e;
      }
      return { ok: true };
    },

    // Trades already imported stay in the journal.
    removeLink(journalId) {
      const err = requireAttached();
      if (err) return err;
      if (run && run.journalId === journalId) abortRun();
      store.removeLink(attached.accountId, journalId);
      progress.delete(journalId);
      return { ok: true };
    },

    // -> { ok, started } | { ok, busy } | { ok: false, error }
    syncNow(journalId) {
      const err = requireAttached();
      if (err) return err;
      if (journalId !== undefined && journalId !== null && !store.getLink(attached.accountId, journalId)) {
        return { ok: false, error: NOT_LINKED };
      }
      return startRun(journalId === null ? undefined : journalId);
    },

    // result: { ok, error? } from the page after it saved (or failed to save) the batch.
    ackBatch(wc, runId, result) {
      if (!attached || attached.wc !== wc || !pending || pending.runId !== runId) {
        return { ok: false, error: UNKNOWN_BATCH };
      }
      const p = pending;
      pending = null;
      clock.clearTimeout(p.timer);
      p.resolve({ ok: !!result && result.ok === true, error: result && typeof result.error === 'string' ? result.error : null });
      return { ok: true };
    },

    // before-quit: abort and never start again in this process.
    shutdown() {
      closed = true;
      detach();
    },

    // For tests: resolves when the current run (if any) has finished.
    idle() {
      return run ? run.promise : Promise.resolve();
    },
  };
}

module.exports = {
  SYNC_INTERVAL_MS,
  JOURNAL_GAP_MS,
  BATCH_CHANNEL,
  STATUS_CHANNEL,
  NOT_ATTACHED,
  createScheduler,
};
