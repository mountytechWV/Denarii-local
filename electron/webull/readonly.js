// Read-only Webull OpenAPI client (plan §5).
//
// This module is the only protection against order placement in Denarii code:
// Webull's Trading permission covers both reading history and trading, so the key
// itself can't be limited. Rules:
//   - Only the named read functions below are exported. There is no generic
//     request(method, path) function, and none may be added.
//   - Every call is checked against the frozen ALLOWLIST before anything is signed.
//   - Any change to ROUTES / ALLOWLIST needs explicit review.
//
// Key, secret, token and host are always passed in by the caller. This module
// never reads environment variables and never logs.

const sign = require('./sign');

// path: null = not yet confirmed from Webull's reference (plan §12 #1). A route
// with a null path is not on the allowlist and its function throws before signing.
//
// NON-GET ENTRIES: createToken and checkToken are the only POSTs, and are the
// first non-GET routes on the allowlist. They create/check the 2FA access token
// (plan §7.8) and cannot place, modify, replace or cancel orders. No other POST
// may be added without explicit review.
const ROUTES = Object.freeze({
  createToken: Object.freeze({ method: 'POST', path: '/auth/tokens/create' }), // NON-GET (token only)
  checkToken: Object.freeze({ method: 'POST', path: '/auth/tokens/check' }), // NON-GET (token only)
  accountList: Object.freeze({ method: 'GET', path: '/trading/accounts/list' }),
  accountBalance: Object.freeze({ method: 'GET', path: null }),
  positions: Object.freeze({ method: 'GET', path: null }),
  orderHistory: Object.freeze({ method: 'GET', path: '/trading/orders/historical-orders/list' }),
  orderDetail: Object.freeze({ method: 'GET', path: null }),
});

const ALLOWLIST = Object.freeze(
  Object.values(ROUTES)
    .filter(r => r.path)
    .map(r => Object.freeze({ method: r.method, path: r.path }))
);

const HOST_RE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;

function assertAllowed(method, path) {
  const ok = ALLOWLIST.some(r => r.method === method && r.path === path);
  if (!ok) throw new Error('Webull route is not on the read-only allowlist.');
}

function encodeQuery(query) {
  return Object.keys(query)
    .sort()
    .map(k => encodeURIComponent(k) + '=' + encodeURIComponent(query[k]))
    .join('&');
}

// Not exported. Allowlist check happens first, before signing or any I/O.
// body is never caller-supplied: only checkToken builds one, from the token alone.
async function callRoute(routeName, { host, appKey, appSecret, accessToken, query, fetchImpl } = {}, body) {
  const route = ROUTES[routeName];
  if (!route || !route.path) throw new Error('Webull route path is not confirmed yet.');
  assertAllowed(route.method, route.path);

  if (typeof host !== 'string' || !HOST_RE.test(host)) {
    throw new Error('Webull host must be a bare hostname.');
  }
  const q = {};
  for (const [k, v] of Object.entries(query || {})) {
    if (v === undefined || v === null) continue;
    if (typeof v !== 'string' && typeof v !== 'number') {
      throw new Error('Webull query values must be strings or numbers.');
    }
    q[k] = String(v);
  }

  const headers = sign.signRequest({ appKey, appSecret, host, path: route.path, query: q, body });
  // Not part of the signature: Webull's signed-header list (plan §5a) doesn't include it.
  if (accessToken) headers['x-access-token'] = accessToken;

  const qs = encodeQuery(q);
  const url = 'https://' + host + route.path + (qs ? '?' + qs : '');
  const doFetch = fetchImpl || fetch;
  const init = { method: route.method, headers };
  if (body !== undefined) init.body = body; // exactly the bytes that were hashed
  const res = await doFetch(url, init);

  // Upstream error text is never forwarded (plan §6); callers map status to a fixed message.
  if (!res.ok) {
    const err = new Error('Webull request failed.');
    err.status = res.status;
    throw err;
  }
  return res.json();
}

// Token calls never send an x-access-token. Bodies are serialized here so the
// signed and sent bytes match. createToken sends "{}" (the official SDK's
// CreateTokenRequest uses body_params={}, which it hashes and sends as JSON);
// checkToken's body is only {"token": ...}.
const createToken = opts => callRoute('createToken', { ...opts, accessToken: undefined, query: undefined }, '{}');
const checkToken = async (opts = {}) => {
  const { token } = opts;
  if (typeof token !== 'string' || !token) throw new Error('Webull checkToken requires a token.');
  return callRoute('checkToken', { ...opts, accessToken: undefined, query: undefined }, JSON.stringify({ token }));
};
const getAccountList = opts => callRoute('accountList', opts);
const getAccountBalance = opts => callRoute('accountBalance', opts);
const getPositions = opts => callRoute('positions', opts);
const getOrderHistory = opts => callRoute('orderHistory', opts);
const getOrderDetail = opts => callRoute('orderDetail', opts);

module.exports = Object.freeze({
  createToken,
  checkToken,
  getAccountList,
  getAccountBalance,
  getPositions,
  getOrderHistory,
  getOrderDetail,
  // Exposed read-only for tests and review; neither sends anything.
  ALLOWLIST,
  assertAllowed,
});
