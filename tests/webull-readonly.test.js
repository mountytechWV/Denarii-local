'use strict';
// Read-only client: allowlist is enforced before any signing or network call.
// No live Webull calls: fetch is always a stub here.

const test = require('node:test');
const assert = require('node:assert/strict');
const sign = require('../electron/webull/sign');
const client = require('../electron/webull/readonly');

const FAKE = { host: 'api.example.test', appKey: 'test-key', appSecret: 'test-secret' };

function spySigner(t) {
  const calls = [];
  const original = sign.signRequest;
  sign.signRequest = args => { calls.push(args); return original(args); };
  t.after(() => { sign.signRequest = original; });
  return calls;
}

test('exports only the named read/token functions plus the allowlist check', () => {
  assert.deepEqual(Object.keys(client).sort(), [
    'ALLOWLIST', 'assertAllowed', 'checkToken', 'createToken', 'getAccountBalance',
    'getAccountList', 'getOrderDetail', 'getOrderHistory', 'getPositions',
  ]);
  assert.ok(Object.isFrozen(client));
  assert.ok(Object.isFrozen(client.ALLOWLIST));
  assert.ok(client.ALLOWLIST.every(r => Object.isFrozen(r)));
});

test('the only non-GET routes are the two token POSTs', () => {
  const nonGet = client.ALLOWLIST.filter(r => r.method !== 'GET').map(r => `${r.method} ${r.path}`).sort();
  assert.deepEqual(nonGet, ['POST /auth/tokens/check', 'POST /auth/tokens/create']);
  assert.ok(client.ALLOWLIST.every(r => !/order/.test(r.path) || r.method === 'GET'));
});

test('paths not on the allowlist throw', () => {
  for (const [method, path] of [
    ['POST', '/trade/order/place'],
    ['GET', '/trading/orders/anything-else'],
    ['POST', '/trading/orders/historical-orders/list'],
    ['GET', '/trading/orders/historical-orders/list/'],
    ['GET', '/auth/tokens/create'],
    ['POST', '/trading/accounts/list'],
    ['POST', '/auth/tokens/refresh'],
  ]) {
    assert.throws(() => client.assertAllowed(method, path), /not on the read-only allowlist/);
  }
  assert.doesNotThrow(() => client.assertAllowed('GET', '/trading/orders/historical-orders/list'));
  assert.doesNotThrow(() => client.assertAllowed('GET', '/trading/accounts/list'));
  assert.doesNotThrow(() => client.assertAllowed('POST', '/auth/tokens/create'));
  assert.doesNotThrow(() => client.assertAllowed('POST', '/auth/tokens/check'));
});

test('allowlist cannot be mutated at runtime', () => {
  assert.throws(() => client.ALLOWLIST.push({ method: 'POST', path: '/x' }));
  assert.throws(() => { client.ALLOWLIST[0].path = '/x'; });
  assert.throws(() => { client.getOrderHistory = () => {}; });
});

test('unconfirmed routes throw before signing or fetching', async t => {
  const signCalls = spySigner(t);
  let fetched = 0;
  const fetchImpl = async () => { fetched++; return { ok: true, json: async () => ({}) }; };
  for (const fn of [client.getAccountBalance, client.getPositions, client.getOrderDetail]) {
    await assert.rejects(fn({ ...FAKE, fetchImpl }), /not confirmed/);
  }
  assert.equal(signCalls.length, 0);
  assert.equal(fetched, 0);
});

test('bad host throws before signing', async t => {
  const signCalls = spySigner(t);
  for (const host of ['https://api.example.test', 'api.example.test/x', 'evil.test?', undefined]) {
    await assert.rejects(client.getOrderHistory({ ...FAKE, host, fetchImpl: async () => {} }), /bare hostname/);
  }
  assert.equal(signCalls.length, 0);
});

test('order history signs a GET to the allowlisted path on the given host', async t => {
  const signCalls = spySigner(t);
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ ok: 1 }) }; };
  const out = await client.getOrderHistory({
    ...FAKE, accessToken: 'tok', query: { page_size: 10, start_time: 'a b' }, fetchImpl,
  });
  assert.deepEqual(out, { ok: 1 });
  assert.equal(signCalls.length, 1);
  assert.equal(signCalls[0].path, '/trading/orders/historical-orders/list');
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.url, 'https://api.example.test/trading/orders/historical-orders/list?page_size=10&start_time=a%20b');
  assert.equal(seen.init.headers['x-access-token'], 'tok');
  assert.ok(seen.init.headers['x-signature']);
});

test('account list signs a GET to the allowlisted path', async t => {
  const signCalls = spySigner(t);
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => [] }; };
  await client.getAccountList({ ...FAKE, accessToken: 'tok', fetchImpl });
  assert.equal(signCalls[0].path, '/trading/accounts/list');
  assert.equal(seen.init.method, 'GET');
  assert.equal(seen.url, 'https://api.example.test/trading/accounts/list');
  assert.equal(seen.init.body, undefined);
});

test('createToken signs and sends "{}" like the SDK, never an access token or query', async t => {
  const signCalls = spySigner(t);
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ status: 'PENDING' }) }; };
  const out = await client.createToken({ ...FAKE, accessToken: 'tok', query: { a: 1 }, fetchImpl });
  assert.deepEqual(out, { status: 'PENDING' });
  assert.equal(signCalls[0].path, '/auth/tokens/create');
  assert.equal(signCalls[0].body, '{}');
  assert.equal(seen.url, 'https://api.example.test/auth/tokens/create');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.body, '{}');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.equal(seen.init.headers['x-access-token'], undefined);
  assert.equal(seen.init.headers['x-app-secret'], undefined);
});

test('checkToken sends exactly the signed {"token"} body', async t => {
  const signCalls = spySigner(t);
  let seen;
  const fetchImpl = async (url, init) => { seen = { url, init }; return { ok: true, json: async () => ({ status: 'NORMAL' }) }; };
  await client.checkToken({ ...FAKE, token: 'abc123', accessToken: 'tok', fetchImpl });
  assert.equal(signCalls[0].path, '/auth/tokens/check');
  assert.equal(signCalls[0].body, '{"token":"abc123"}');
  assert.equal(seen.init.body, '{"token":"abc123"}');
  assert.equal(seen.init.method, 'POST');
  assert.equal(seen.init.headers['Content-Type'], 'application/json');
  assert.equal(seen.init.headers['x-access-token'], undefined);
});

test('checkToken without a token throws before signing', async t => {
  const signCalls = spySigner(t);
  for (const token of [undefined, '', 123]) {
    await assert.rejects(client.checkToken({ ...FAKE, token, fetchImpl: async () => {} }), /requires a token/);
  }
  assert.equal(signCalls.length, 0);
});

test('non-2xx responses throw a fixed message without upstream text', async () => {
  const fetchImpl = async () => ({ ok: false, status: 401, json: async () => ({ msg: 'upstream detail' }) });
  await assert.rejects(client.getOrderHistory({ ...FAKE, fetchImpl }), err => {
    assert.equal(err.message, 'Webull request failed.');
    assert.equal(err.status, 401);
    return true;
  });
});
