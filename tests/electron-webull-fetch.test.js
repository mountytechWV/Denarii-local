// electron/webull/fetch.js and scheduler.js with a fake clock and fake
// fetch: windows, paging, the 1.1 s gap, 429 back-off, 401/403 mapping,
// cursor-on-acknowledgment, and detach/quit aborting with a clean resume.

const test = require('node:test');
const assert = require('node:assert/strict');
const fetchMod = require('../electron/webull/fetch');
const { createConnection } = require('../electron/webull/connection');
const { createScheduler, SYNC_INTERVAL_MS, BATCH_CHANNEL } = require('../electron/webull/scheduler');
const { fakeSafeStorage, fakeClock, fakeFetch, jsonResponse, hang, tempStore, flush } = require('./helpers/webull-fakes');

const { computeWindow, linkToJournal, runJournal, createPacer, MESSAGES, SyncStop, WINDOW_MS } = fetchMod;
const DAY = 24 * 3600 * 1000;
const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);
const CREDS = { appKey: 'us.TESTKEY1234567890ab', appSecret: 'TESTSECRET_abcdefghijklmnop', token: 'tok', accounts: [{ id: 'W1', label: '' }] };

function order(id, extra) {
  return Object.assign({
    order_id: id, symbol: 'AAPL', side: 'BUY', status: 'FILLED', filled_quantity: '10', filled_price: '150.5',
    filled_time_at: '2026-11-01T15:00:00Z', instrument_type: 'EQUITY', account_number: '5MV-SECRET',
  }, extra || {});
}
const group = (...orders) => ({ combo_order_id: null, orders });

// Order History stub: pages[i] answers call i for a window (keyed by start_time).
function historyFetch(clock, respond) {
  return fakeFetch(clock, call => {
    if (call.path !== '/trading/orders/historical-orders/list') return jsonResponse(404, {});
    return respond(call);
  });
}

function ctxFor(t, clock, fetch, overrides) {
  const { store } = tempStore(t);
  store.upsertLink('a1', 'j1', { webullAccountId: 'W1', startDate: (overrides && overrides.startDate) || null });
  const batches = [];
  const ctx = Object.assign({
    accountId: 'a1',
    link: store.getLink('a1', 'j1'),
    creds: CREDS,
    store,
    clock,
    signal: new AbortController().signal,
    pace: createPacer(clock, fetchMod.PAGE_GAP_MS),
    deliver: async (b) => { batches.push(b); return { ok: true }; },
    onProgress: () => {},
  }, overrides || {});
  ctx.env = { fetchImpl: fetch, clock, signal: ctx.signal };
  return { ctx, store, batches };
}

test('moved helpers: windows from a start date or the 2018-05-21 default, 90 days long', () => {
  const all = computeWindow(linkToJournal({ startDate: null }), null, NOW);
  assert.equal(new Date(all.start).toISOString(), '2018-05-21T00:00:00.000Z');
  assert.equal(all.end - all.start, WINDOW_MS);
  const from = computeWindow(linkToJournal({ startDate: '2026-10-01' }), null, NOW);
  assert.equal(new Date(from.start).toISOString(), '2026-10-01T00:00:00.000Z');
  assert.equal(from.end, NOW, 'the last window ends now');
  // Backfill resumes at the cursor; later syncs re-read 24 hours.
  const backfill = computeWindow(linkToJournal({ startDate: null, backfillCursor: Date.UTC(2020, 0, 1), lastSyncedAt: Date.UTC(2020, 0, 1) }), null, NOW);
  assert.equal(backfill.start, Date.UTC(2020, 0, 1));
  const later = computeWindow(linkToJournal({ startDate: null, lastSyncedAt: NOW - DAY * 3 }), null, NOW);
  assert.equal(later.start, NOW - DAY * 4);
  // About 35 windows for all history.
  assert.equal(Math.ceil((NOW - all.start) / WINDOW_MS), 35);
});

test('moved helpers: normalizeOrder and parseAccounts drop account_number', () => {
  const result = { fills: [], stats: fetchMod.newStats() };
  fetchMod.collectPage([group(order('o1'), order('o2', { status: 'CANCELLED', filled_quantity: '0' }))], new Set(), result);
  assert.equal(result.fills.length, 1);
  assert.ok(!JSON.stringify(result.fills).includes('5MV'));
  assert.deepEqual(fetchMod.parseAccounts([{ account_id: 'W1', account_number: '5MV', account_label: 'Cash' }]), [{ id: 'W1', label: 'Cash' }]);
  assert.equal(fetchMod.parseExpiresAt(1800000000), '2027-01-15T08:00:00.000Z');
});

test('paging: every page is read 1.1 s apart, duplicates across pages are skipped', async (t) => {
  const clock = fakeClock(NOW);
  const fetch = historyFetch(clock, call => {
    if (!call.query.pagination_key) return jsonResponse(200, { data: [group(order('o1'), order('o2'))], pagination_key: 'k2' });
    if (call.query.pagination_key === 'k2') return jsonResponse(200, { data: [group(order('o2'), order('o3'))], pagination_key: 'k3' });
    return jsonResponse(200, { data: [group(order('o4'))] });
  });
  const { ctx, store, batches } = ctxFor(t, clock, fetch, { startDate: '2026-10-01' });
  const r = await runJournal(ctx);
  assert.deepEqual(r, { status: 'ok', windows: 1, orders: 4 });
  assert.equal(fetch.calls.length, 3);
  for (let i = 1; i < fetch.calls.length; i++) assert.ok(fetch.calls[i].at - fetch.calls[i - 1].at >= 1100);
  assert.equal(fetch.calls[0].method, 'GET');
  assert.equal(fetch.calls[0].query.account_id, 'W1');
  assert.equal(fetch.calls[0].query.start_time, '2026-10-01T00:00:00.000Z');
  assert.equal(fetch.calls[2].query.pagination_key, 'k3');
  assert.deepEqual(batches[0].fills.map(f => f.orderId), ['o1', 'o2', 'o3', 'o4']);
  assert.equal(store.getLink('a1', 'j1').lastSyncedAt, NOW);
  assert.equal(store.getLink('a1', 'j1').backfillCursor, null);
});

test('paging that does not advance stops with "Webull is unavailable"', async (t) => {
  const clock = fakeClock(NOW);
  const fetch = historyFetch(clock, () => jsonResponse(200, { data: [group(order('o1'))], pagination_key: 'same' }));
  const { ctx, store } = ctxFor(t, clock, fetch, { startDate: '2026-10-01' });
  await assert.rejects(runJournal(ctx), e => e instanceof SyncStop && e.message === 'Webull is unavailable.');
  assert.equal(store.getLink('a1', 'j1').lastSyncedAt, null);
});

test('429: back off 5 s, then 30 s, then "Webull is busy"', async (t) => {
  const clock = fakeClock(NOW);
  let n = 0;
  const fetch = historyFetch(clock, () => (++n <= 2 ? jsonResponse(429, {}) : jsonResponse(200, { data: [] })));
  const { ctx } = ctxFor(t, clock, fetch, { startDate: '2026-10-01' });
  assert.equal((await runJournal(ctx)).status, 'ok');
  assert.ok(clock.sleeps.includes(5000) && clock.sleeps.includes(30000));
  assert.equal(fetch.calls.length, 3);

  const clock2 = fakeClock(NOW);
  const always = historyFetch(clock2, () => jsonResponse(429, {}));
  const { ctx: ctx2, store } = ctxFor(t, clock2, always, { startDate: '2026-10-01' });
  await assert.rejects(runJournal(ctx2), e => e.status === 'busy' && e.message === MESSAGES.busy && e.stopAll);
  assert.equal(always.calls.length, 3);
  assert.deepEqual(clock2.sleeps.filter(ms => ms >= 5000), [5000, 30000]);
  assert.equal(store.getLink('a1', 'j1').lastSyncedAt, null);
});

test('401, 403, 5xx, network errors and the 8 s timeout map to fixed messages', async (t) => {
  const cases = [
    [401, 'needs_approval', 'Your Webull approval expired. Tap Send new code.', 'needs_approval'],
    [403, 'error', "Your Webull key can't read accounts. Check that Trading is enabled.", 'unknown'],
    [502, 'error', 'Webull is unavailable.', null],
  ];
  for (const [code, status, message, approvalState] of cases) {
    const clock = fakeClock(NOW);
    const { ctx } = ctxFor(t, clock, historyFetch(clock, () => jsonResponse(code, { msg: 'upstream text' })), { startDate: '2026-10-01' });
    await assert.rejects(runJournal(ctx), e => e.status === status && e.message === message && e.approvalState === approvalState && e.stopAll);
  }
  const clock = fakeClock(NOW);
  const { ctx } = ctxFor(t, clock, historyFetch(clock, () => { throw new TypeError('fetch failed'); }), { startDate: '2026-10-01' });
  await assert.rejects(runJournal(ctx), e => e.status === 'offline' && e.message === 'Webull is unavailable.');

  const clock3 = fakeClock(NOW);
  const { ctx: ctx3 } = ctxFor(t, clock3, historyFetch(clock3, hang), { startDate: '2026-10-01' });
  const p = runJournal(ctx3);
  await flush();
  clock3.fireTimeouts(8000);
  await assert.rejects(p, e => e.status === 'offline');
});

test('a full import walks 90-day windows; the cursor moves only on acknowledgment', async (t) => {
  const clock = fakeClock(NOW);
  const fetch = historyFetch(clock, call => jsonResponse(200, { data: [group(order('o-' + call.query.start_time))] }));
  const progress = [];
  let refuse = 2; // the page refuses window 2
  let windowNo = 0;
  const { ctx, store, batches } = ctxFor(t, clock, fetch, {
    startDate: '2026-02-01',
    onProgress: p => progress.push(p),
    deliver: async (b) => { batches.push(b); windowNo++; return windowNo === refuse ? { ok: false, error: 'save failed' } : { ok: true }; },
  });
  await assert.rejects(runJournal(ctx), e => e.status === 'error' && e.message === MESSAGES.notSaved);
  const afterFirst = store.getLink('a1', 'j1');
  assert.equal(afterFirst.lastSyncedAt, Date.parse(batches[0].windowEnd));
  assert.equal(afterFirst.backfillCursor, Date.parse(batches[0].windowEnd));

  // Next run re-reads window 2 (not window 1) and finishes.
  refuse = 0;
  const seenStarts = batches.map(b => b.windowStart);
  batches.length = 0;
  ctx.link = store.getLink('a1', 'j1');
  const r = await runJournal(ctx);
  assert.equal(r.status, 'ok');
  assert.equal(batches[0].windowStart, seenStarts[1]);
  assert.ok(!batches.some(b => b.windowStart === seenStarts[0]), 'window 1 is never re-delivered');
  const done = store.getLink('a1', 'j1');
  assert.equal(done.backfillCursor, null);
  assert.ok(done.lastSyncedAt >= clock.now() - 60000);
  assert.equal(batches[0].accountId, 'a1');
  assert.equal(batches[0].journalId, 'j1');
  const last = progress[progress.length - 1];
  assert.equal(last.windowIndex, last.windowCount);
  assert.ok(Object.keys(last).sort().join() === 'journalId,ordersSoFar,windowCount,windowEnd,windowIndex,windowStart');
});

// ── Scheduler ─────────────────────────────────────────────────────────────

async function schedulerEnv(t, opts) {
  const o = opts || {};
  const clock = fakeClock(NOW);
  const { store, kv } = tempStore(t);
  kv.put('auth', 'account:a1', { id: 'a1' });
  const safeStorage = fakeSafeStorage();
  const handler = o.history || (() => jsonResponse(200, { data: [] }));
  const fetch = fakeFetch(clock, call => {
    if (call.path === '/auth/tokens/create') return jsonResponse(200, { token: 'tok1', expires_at: NOW / 1000 + 15 * 86400 });
    if (call.path === '/auth/tokens/check') return jsonResponse(200, { status: 'NORMAL', expires_at: NOW / 1000 + 15 * 86400 });
    if (call.path === '/trading/accounts/list') return jsonResponse(200, [{ account_id: 'W1' }, { account_id: 'W2' }]);
    return handler(call);
  });
  const connection = createConnection({ store, safeStorage, fetchImpl: fetch, clock, platform: 'win32' });
  const sent = [];
  const waiters = [];
  const sched = createScheduler({
    store, connection, clock, fetchImpl: fetch,
    accountExists: id => !!kv.get('auth', 'account:' + id),
    send: (wc, channel, payload) => {
      sent.push({ wc, channel, payload });
      if (channel === BATCH_CHANNEL) { const w = waiters.shift(); if (w) w(payload); }
    },
  });
  const wc = { id: 1 };
  const nextBatch = () => {
    const pendingBatch = sent.filter(s => s.channel === BATCH_CHANNEL).slice(-1)[0];
    return new Promise(r => waiters.push(r)).then(b => b || pendingBatch);
  };
  // Connect and approve through the scheduler (attach first, with no links).
  assert.deepEqual(sched.attach(wc, 'a1'), { ok: true });
  await sched.idle();
  assert.equal((await sched.connect({ appKey: CREDS.appKey, appSecret: CREDS.appSecret, startDate: null })).ok, true);
  clock.advance(11000);
  assert.equal((await sched.checkApproval()).approvalState, 'ok');
  return { clock, store, kv, fetch, sched, sent, wc, nextBatch };
}

test('attach syncs now and every 15 minutes; nothing runs without an attached page', async (t) => {
  const env = await schedulerEnv(t);
  assert.deepEqual(env.sched.setLink({ journalId: 'j1', webullAccountId: 'W1', startDate: '2026-11-01' }), { ok: true });
  env.sched.detach();
  assert.equal(env.clock.intervals().length, 0);
  assert.deepEqual(env.sched.syncNow(), { ok: false, error: 'Sign in to use Webull sync.' });

  const historyCalls = () => env.fetch.calls.filter(c => c.path.startsWith('/trading/orders')).length;
  const p = env.nextBatch();
  env.sched.attach(env.wc, 'a1');
  assert.deepEqual(env.clock.intervals().map(i => i.ms), [SYNC_INTERVAL_MS]);
  const batch = await p;
  assert.equal(historyCalls(), 1);
  assert.deepEqual(env.sched.syncNow(), { ok: true, busy: true });
  assert.deepEqual(env.sched.ackBatch(env.wc, 'wrong', { ok: true }), { ok: false, error: 'Unknown batch.' });
  assert.deepEqual(env.sched.ackBatch({ id: 2 }, batch.runId, { ok: true }), { ok: false, error: 'Unknown batch.' });
  assert.deepEqual(env.sched.ackBatch(env.wc, batch.runId, { ok: true }), { ok: true });
  await env.sched.idle();
  assert.equal(env.sched.status().links[0].status, 'ok');

  const p2 = env.nextBatch();
  env.clock.fireIntervals();
  const b2 = await p2;
  env.sched.ackBatch(env.wc, b2.runId, { ok: true });
  await env.sched.idle();
  assert.equal(historyCalls(), 2);
});

test('linked journals run one at a time, 2 s apart; a 401 stops the rest', async (t) => {
  let fail401 = false;
  const env = await schedulerEnv(t, { history: () => (fail401 ? jsonResponse(401, {}) : jsonResponse(200, { data: [] })) });
  env.sched.setLink({ journalId: 'j1', webullAccountId: 'W1', startDate: '2026-11-01' });
  env.sched.setLink({ journalId: 'j2', webullAccountId: 'W2', startDate: '2026-11-01' });
  assert.equal(env.sched.setLink({ journalId: 'j3', webullAccountId: 'W2' }).error, 'This Webull account is already linked to another journal.');
  assert.equal(env.sched.setLink({ journalId: 'j3', webullAccountId: 'W9' }).error, MESSAGES.accountUnavailable);

  const p = env.nextBatch();
  env.sched.syncNow();
  const b1 = await p;
  assert.equal(b1.journalId, 'j1');
  const p2 = env.nextBatch();
  env.sched.ackBatch(env.wc, b1.runId, { ok: true });
  const b2 = await p2;
  assert.equal(b2.journalId, 'j2');
  assert.ok(env.clock.sleeps.includes(2000));
  env.sched.ackBatch(env.wc, b2.runId, { ok: true });
  await env.sched.idle();

  fail401 = true;
  env.sched.syncNow();
  await env.sched.idle();
  const st = env.sched.status();
  assert.equal(st.approvalState, 'needs_approval');
  assert.deepEqual(st.links.map(l => [l.journalId, l.status, l.error]), [
    ['j1', 'needs_approval', MESSAGES.expired],
    ['j2', 'needs_approval', MESSAGES.expired],
  ]);
  // Until approved again, no further Webull calls.
  const calls = env.fetch.calls.length;
  env.sched.syncNow();
  await env.sched.idle();
  assert.equal(env.fetch.calls.length, calls);
  assert.ok(!JSON.stringify(st).includes('tok1') && !JSON.stringify(st).includes(CREDS.appSecret));
});

test('detach mid-run aborts and drops the batch; the next attach resumes with no duplicates', async (t) => {
  const env = await schedulerEnv(t, { history: call => jsonResponse(200, { data: [group(order('o-' + call.query.start_time))] }) });
  env.sched.setLink({ journalId: 'j1', webullAccountId: 'W1', startDate: '2026-04-01' }); // 3 windows
  const p = env.nextBatch();
  env.sched.syncNow();
  const b1 = await p;
  const p2 = env.nextBatch();
  env.sched.ackBatch(env.wc, b1.runId, { ok: true });
  const b2 = await p2;
  const cursor = env.store.getLink('a1', 'j1').backfillCursor;
  assert.equal(cursor, Date.parse(b1.windowEnd));

  env.sched.detach(); // page reload / lock
  await env.sched.idle();
  assert.deepEqual(env.sched.ackBatch(env.wc, b2.runId, { ok: true }), { ok: false, error: 'Unknown batch.' });
  assert.equal(env.store.getLink('a1', 'j1').backfillCursor, cursor, 'cursor unchanged');

  const delivered = [];
  const p3 = env.nextBatch();
  env.sched.attach(env.wc, 'a1');
  let b = await p3;
  for (;;) {
    delivered.push(b.windowStart);
    const next = env.nextBatch();
    env.sched.ackBatch(env.wc, b.runId, { ok: true });
    const r = await Promise.race([next, env.sched.idle().then(() => null)]);
    if (!r) break;
    b = r;
  }
  assert.equal(delivered[0], b2.windowStart, 'resumes at the unacknowledged window');
  assert.ok(!delivered.includes(b1.windowStart), 'acknowledged window is not re-delivered');
  assert.equal(env.store.getLink('a1', 'j1').backfillCursor, null);
});

test('quit (shutdown) aborts an in-flight Webull call and writes nothing', async (t) => {
  let hangNow = false;
  const env = await schedulerEnv(t, { history: call => (hangNow ? hang(call) : jsonResponse(200, { data: [] })) });
  env.sched.setLink({ journalId: 'j1', webullAccountId: 'W1', startDate: '2026-11-01' });
  hangNow = true;
  env.sched.syncNow();
  await flush();
  const inflight = env.fetch.calls[env.fetch.calls.length - 1];
  assert.equal(inflight.signal.aborted, false);
  env.sched.shutdown();
  assert.equal(inflight.signal.aborted, true);
  await env.sched.idle();
  const link = env.store.getLink('a1', 'j1');
  assert.equal(link.lastSyncedAt, null);
  assert.equal(link.lastStatus, null);
  assert.equal(env.sched.attach(env.wc, 'a1').ok, false, 'no new runs after quit');
});

test('a deleted account detaches and an unknown account cannot attach', async (t) => {
  const env = await schedulerEnv(t);
  assert.equal(env.sched.attach(env.wc, 'nobody').ok, false);
  env.sched.attach(env.wc, 'a1');
  await env.sched.idle();
  env.kv.delete('auth', 'account:a1');
  env.clock.fireIntervals();
  assert.equal(env.sched.status().ok, false);
  assert.equal(env.store.getConnection('a1'), null);
});

test('setLink: moving the start earlier or changing account restarts the import; later keeps the cursor', async (t) => {
  const env = await schedulerEnv(t);
  env.sched.setLink({ journalId: 'j1', webullAccountId: 'W1', startDate: '2025-01-01' });
  env.store.updateLink('a1', 'j1', { lastSyncedAt: NOW - DAY, backfillCursor: null });
  env.sched.setLink({ journalId: 'j1', webullAccountId: 'W1', startDate: '2025-06-01' });
  assert.equal(env.store.getLink('a1', 'j1').lastSyncedAt, NOW - DAY);
  env.sched.setLink({ journalId: 'j1', webullAccountId: 'W1', startDate: '2024-06-01' });
  assert.equal(env.store.getLink('a1', 'j1').lastSyncedAt, null);
  env.store.updateLink('a1', 'j1', { lastSyncedAt: NOW - DAY });
  env.sched.setLink({ journalId: 'j1', webullAccountId: 'W2', startDate: '2024-06-01' });
  assert.equal(env.store.getLink('a1', 'j1').lastSyncedAt, null);
  assert.deepEqual(env.sched.removeLink('j1'), { ok: true });
  assert.deepEqual(env.sched.status().links, []);
  assert.equal(env.sched.syncNow('j1').error, "This journal isn't linked to Webull.");
});
