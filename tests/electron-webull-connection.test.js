// electron/webull/connection.js with fake async safeStorage and fake fetch:
// secrets never leave status(), blobs are bound to their account, token
// statuses map like the cloud endpoint, and cooldowns hold.

const test = require('node:test');
const assert = require('node:assert/strict');
const { createConnection } = require('../electron/webull/connection');
const { MESSAGES, SyncStop } = require('../electron/webull/fetch');
const { fakeSafeStorage, fakeClock, fakeFetch, jsonResponse, tempStore } = require('./helpers/webull-fakes');

const APP_KEY = 'us.TESTKEY1234567890ab';
const APP_SECRET = 'TESTSECRET_abcdefghijklmnop';
const TOKEN = 'tok_0123456789abcdef';

// Webull stub: tokenStatus drives Check Token; overrides map a path to a status code.
function webullStub(clock, state) {
  const s = Object.assign({ tokenStatus: 'PENDING', fail: {} }, state || {});
  const fetch = fakeFetch(clock, (call) => {
    if (s.fail[call.path]) return jsonResponse(s.fail[call.path], { msg: 'upstream detail' });
    if (call.path === '/auth/tokens/create') return jsonResponse(200, { token: TOKEN + (fetch.calls.length), status: 'PENDING', expires_at: 1800000000 });
    if (call.path === '/auth/tokens/check') return jsonResponse(200, { status: s.tokenStatus, expires_at: '2026-11-25T00:00:00Z' });
    if (call.path === '/trading/accounts/list') {
      return jsonResponse(200, [{ account_id: 'W1', account_number: '5MV-SECRET', account_label: 'Cash' }]);
    }
    return jsonResponse(404, {});
  });
  fetch.state = s;
  return fetch;
}

function setup(t, opts) {
  const o = opts || {};
  const clock = fakeClock();
  const { store } = tempStore(t);
  const safeStorage = o.safeStorage || fakeSafeStorage();
  const fetch = webullStub(clock, o.state);
  const conn = createConnection({ store, safeStorage, fetchImpl: fetch, clock, platform: 'win32' });
  return { clock, store, safeStorage, fetch, conn };
}

async function connectAndApprove(env, accountId) {
  const id = accountId || 'a1';
  const r = await env.conn.connect(id, { appKey: APP_KEY, appSecret: APP_SECRET, startDate: '2024-01-02' });
  assert.equal(r.ok, true);
  env.fetch.state.tokenStatus = 'NORMAL';
  env.clock.advance(11000);
  const c = await env.conn.checkApproval(id);
  assert.equal(c.approvalState, 'ok');
  return c;
}

test('connect stores encrypted blobs; status never returns the secret, key or token', async (t) => {
  const env = setup(t);
  const r = await env.conn.connect('a1', { appKey: '  ' + APP_KEY + ' ', appSecret: APP_SECRET, startDate: null });
  assert.deepEqual(r, { ok: true, approvalState: 'needs_approval', last4: '90ab' });

  const create = env.fetch.calls[0];
  assert.equal(create.host, 'api.webull.com');
  assert.equal(create.method, 'POST');
  assert.equal(create.path, '/auth/tokens/create');

  const row = env.store.getConnection('a1');
  for (const blob of [row.creds, row.token]) {
    const text = blob.toString('utf8');
    assert.ok(!text.includes(APP_SECRET) && !text.includes(TOKEN), 'stored as ciphertext');
  }
  assert.equal(row.approvalState, 'needs_approval');
  assert.equal(row.tokenExpiresAt, 1800000000 * 1000);

  await connectAndApproveAfter(env);
  const status = env.conn.status('a1');
  const json = JSON.stringify(status);
  for (const secret of [APP_KEY, APP_SECRET, TOKEN, '5MV-SECRET', 'fake:']) assert.ok(!json.includes(secret), secret);
  assert.deepEqual(Object.keys(status).sort(), ['accounts', 'approvalExpiresAt', 'approvalState', 'connected', 'defaultStartDate', 'last4']);
  assert.deepEqual(status.accounts, [{ id: 'W1', label: 'Cash' }]);
  assert.equal(status.approvalState, 'ok');
  assert.equal(status.approvalExpiresAt, '2026-11-25T00:00:00.000Z');
});

async function connectAndApproveAfter(env) {
  env.fetch.state.tokenStatus = 'NORMAL';
  env.clock.advance(11000);
  const c = await env.conn.checkApproval('a1');
  assert.equal(c.approvalState, 'ok');
}

test('connect validates input and maps a 401 to "rejected" without saving anything', async (t) => {
  const env = setup(t, { state: { fail: { '/auth/tokens/create': 401 } } });
  assert.equal((await env.conn.connect('a1', { appKey: 'short', appSecret: APP_SECRET })).error, MESSAGES.badInput);
  assert.equal((await env.conn.connect('a1', { appKey: APP_KEY, appSecret: 'bad secret with spaces!!' })).error, MESSAGES.badInput);
  for (const startDate of ['2018-05-20', '2026-11-11', '2024-02-30', '01/02/2024', 20240102]) {
    assert.equal((await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET, startDate })).error, MESSAGES.badDate, String(startDate));
  }
  assert.equal(env.fetch.calls.length, 0);
  const r = await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET, startDate: '2018-05-21' });
  assert.deepEqual(r, { ok: false, error: 'Webull rejected the credentials.' });
  assert.equal(env.store.getConnection('a1'), null);
  // A rejected key does not start the 60 s cooldown.
  env.fetch.state.fail = {};
  assert.equal((await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET, startDate: '2026-11-10' })).ok, true);
});

test('connect refuses when secure storage is unavailable, before calling Webull', async (t) => {
  const env = setup(t, { safeStorage: fakeSafeStorage({ available: false }) });
  const r = await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET });
  assert.equal(r.ok, false);
  assert.equal(r.error, MESSAGES.storageUnavailable);
  assert.equal(env.fetch.calls.length, 0);
});

test('token statuses map: PENDING, NORMAL, EXPIRED, INVALID and anything else', async (t) => {
  const env = setup(t);
  await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET });

  let r = await env.conn.checkApproval('a1');
  assert.deepEqual(r, { ok: true, approvalState: 'needs_approval', accounts: [], message: MESSAGES.pending });

  env.clock.advance(10000);
  env.fetch.state.tokenStatus = 'NORMAL';
  r = await env.conn.checkApproval('a1');
  assert.deepEqual(r, { ok: true, approvalState: 'ok', accounts: [{ id: 'W1', label: 'Cash' }] });
  assert.equal(env.store.getConnection('a1').approvalState, 'ok');
  assert.ok(!JSON.stringify(env.store.getConnection('a1').webullAccounts).includes('5MV'));

  for (const dead of ['EXPIRED', 'INVALID']) {
    env.clock.advance(10000);
    env.store.updateConnection('a1', { token: await env.safeStorage.encryptStringAsync(JSON.stringify({ v: 1, accountId: 'a1', token: 'x' })) });
    env.fetch.state.tokenStatus = dead;
    r = await env.conn.checkApproval('a1');
    assert.deepEqual(r, { ok: true, approvalState: 'needs_approval', accounts: [], message: 'Your Webull approval expired. Tap Send new code.' });
    assert.equal(env.store.getConnection('a1').token, null, dead + ' drops the token');
  }

  // No token left: no Webull call, straight to "expired".
  env.clock.advance(10000);
  const before = env.fetch.calls.length;
  r = await env.conn.checkApproval('a1');
  assert.equal(r.message, MESSAGES.expired);
  assert.equal(env.fetch.calls.length, before);

  env.store.updateConnection('a1', { token: await env.safeStorage.encryptStringAsync(JSON.stringify({ v: 1, accountId: 'a1', token: 'x' })) });
  env.clock.advance(10000);
  env.fetch.state.tokenStatus = 'SOMETHING_NEW';
  r = await env.conn.checkApproval('a1');
  assert.deepEqual(r, { ok: false, error: 'Webull is unavailable.' });
  assert.equal(env.store.getConnection('a1').approvalState, 'unknown');
});

test('Account List 401 and 403 map to "expired" and "can\'t read accounts"', async (t) => {
  const env = setup(t, { state: { tokenStatus: 'NORMAL' } });
  await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET });
  env.fetch.state.fail['/trading/accounts/list'] = 401;
  let r = await env.conn.checkApproval('a1');
  assert.equal(r.approvalState, 'needs_approval');
  assert.equal(r.message, MESSAGES.expired);
  env.clock.advance(10000);
  env.fetch.state.fail['/trading/accounts/list'] = 403;
  r = await env.conn.checkApproval('a1');
  assert.deepEqual(r, { ok: false, error: "Your Webull key can't read accounts. Check that Trading is enabled." });
  assert.equal(env.store.getConnection('a1').approvalState, 'unknown');
  env.clock.advance(10000);
  env.fetch.state.fail['/trading/accounts/list'] = 429;
  assert.equal((await env.conn.checkApproval('a1')).error, MESSAGES.busy);
  env.clock.advance(10000);
  env.fetch.state.fail['/trading/accounts/list'] = 503;
  assert.equal((await env.conn.checkApproval('a1')).error, 'Webull is unavailable.');
});

test('a blob moved to another account\'s row is rejected', async (t) => {
  const env = setup(t);
  await connectAndApprove(env, 'a1');
  const row = env.store.getConnection('a1');
  env.store.putConnection('a2', {
    creds: row.creds, token: row.token, appKeyLast4: row.appKeyLast4, approvalState: 'ok',
    tokenExpiresAt: row.tokenExpiresAt, webullAccounts: row.webullAccounts,
  });
  const calls = env.fetch.calls.length;
  const r = await env.conn.checkApproval('a2');
  assert.deepEqual(r, { ok: false, error: 'Stored credentials could not be read; please reconnect.' });
  await assert.rejects(env.conn.syncCredentials('a2'), e => e instanceof SyncStop && e.message === MESSAGES.decryptFailed);
  assert.equal(env.fetch.calls.length, calls, 'no Webull call with a foreign blob');
  // a1 still works.
  const creds = await env.conn.syncCredentials('a1');
  assert.equal(creds.appSecret, APP_SECRET);
});

test('keys that cannot be decrypted (another Windows user, restored elsewhere) ask to reconnect', async (t) => {
  const env = setup(t);
  await connectAndApprove(env, 'a1');
  env.safeStorage.set('owner', 'someone-else');
  env.clock.advance(10000);
  assert.equal((await env.conn.checkApproval('a1')).error, 'Stored credentials could not be read; please reconnect.');
  await assert.rejects(env.conn.syncCredentials('a1'), e => e.status === 'error' && e.stopAll && e.message === MESSAGES.decryptFailed);
  env.clock.advance(60000);
  env.store.updateConnection('a1', { approvalState: 'needs_approval' });
  assert.equal((await env.conn.resendCode('a1')).error, MESSAGES.decryptFailed);
  // status still works (no decrypt) and shows no secrets.
  assert.equal(env.conn.status('a1').connected, true);
});

test('cooldowns: Check again every 10 s, a new code every 60 s, none while approved', async (t) => {
  const env = setup(t);
  await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET });
  // connect -> connect within 60 s
  let r = await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET });
  assert.equal(r.error, MESSAGES.cooldown);
  assert.equal(r.retryAfterSec, 60);

  assert.equal((await env.conn.checkApproval('a1')).ok, true);
  env.clock.advance(9000);
  r = await env.conn.checkApproval('a1');
  assert.equal(r.error, MESSAGES.cooldown);
  assert.equal(r.retryAfterSec, 1);
  env.clock.advance(1000);
  assert.equal((await env.conn.checkApproval('a1')).ok, true);

  // resend within 60 s of connect
  r = await env.conn.resendCode('a1');
  assert.equal(r.error, MESSAGES.cooldown);
  env.clock.advance(50000);
  const calls = env.fetch.calls.length;
  r = await env.conn.resendCode('a1');
  assert.deepEqual(r, { ok: true, approvalState: 'needs_approval', message: MESSAGES.codeSent });
  assert.equal(env.fetch.calls.length, calls + 1);
  assert.equal(env.fetch.calls[calls].path, '/auth/tokens/create');
  // A new code resets the Check cooldown.
  assert.equal((await env.conn.checkApproval('a1')).ok, true);
  assert.equal((await env.conn.resendCode('a1')).error, MESSAGES.cooldown);

  // Approved and unexpired: no new code.
  env.clock.advance(61000);
  env.fetch.state.tokenStatus = 'NORMAL';
  assert.equal((await env.conn.checkApproval('a1')).approvalState, 'ok');
  assert.equal((await env.conn.resendCode('a1')).error, MESSAGES.alreadyApproved);
});

test('cooldowns are per account', async (t) => {
  const env = setup(t);
  await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET });
  assert.equal((await env.conn.connect('a2', { appKey: APP_KEY, appSecret: APP_SECRET })).ok, true);
});

test('status derives "needs_approval" once the approval has expired, without writing', async (t) => {
  const env = setup(t);
  await connectAndApprove(env, 'a1');
  env.clock.advance(20 * 24 * 3600 * 1000);
  assert.equal(env.conn.status('a1').approvalState, 'needs_approval');
  assert.equal(env.store.getConnection('a1').approvalState, 'ok');
  // A sync run records it and makes no Webull call.
  const calls = env.fetch.calls.length;
  await assert.rejects(env.conn.syncCredentials('a1'), e => e.status === 'needs_approval' && e.message === MESSAGES.expired);
  assert.equal(env.store.getConnection('a1').approvalState, 'needs_approval');
  assert.equal(env.fetch.calls.length, calls);
});

test('syncCredentials: pending approval, unknown state and not connected', async (t) => {
  const env = setup(t);
  await assert.rejects(env.conn.syncCredentials('a1'), e => e.message === MESSAGES.notConnected);
  await env.conn.connect('a1', { appKey: APP_KEY, appSecret: APP_SECRET });
  await assert.rejects(env.conn.syncCredentials('a1'), e => e.status === 'needs_approval' && e.message === MESSAGES.pending);
  env.store.updateConnection('a1', { approvalState: 'unknown' });
  await assert.rejects(env.conn.syncCredentials('a1'), e => e.status === 'error' && e.message === MESSAGES.checkConnection);
});

test('shouldReEncrypt rewrites the blob with the same content', async (t) => {
  const env = setup(t);
  await connectAndApprove(env, 'a1');
  const before = env.safeStorage.encrypted;
  env.safeStorage.set('reEncrypt', true);
  const creds = await env.conn.syncCredentials('a1');
  assert.equal(creds.token.startsWith(TOKEN), true);
  assert.equal(env.safeStorage.encrypted, before + 2);
  env.safeStorage.set('reEncrypt', false);
  assert.equal((await env.conn.syncCredentials('a1')).appKey, APP_KEY);
});

test('disconnect deletes the connection and keeps links', async (t) => {
  const env = setup(t);
  await connectAndApprove(env, 'a1');
  env.store.upsertLink('a1', 'j1', { webullAccountId: 'W1' });
  assert.deepEqual(await env.conn.disconnect('a1'), { ok: true });
  assert.deepEqual(env.conn.status('a1'), { connected: false });
  assert.equal(env.store.listLinks('a1').length, 1);
  assert.deepEqual(env.conn.accounts('a1'), []);
});

test('only token routes are POSTed; every call goes to api.webull.com', async (t) => {
  const env = setup(t);
  await connectAndApprove(env, 'a1');
  env.clock.advance(61000);
  env.store.updateConnection('a1', { approvalState: 'needs_approval' });
  await env.conn.resendCode('a1');
  for (const c of env.fetch.calls) {
    assert.equal(c.host, 'api.webull.com');
    if (c.method !== 'GET') assert.ok(['/auth/tokens/create', '/auth/tokens/check'].includes(c.path), c.path);
  }
});
