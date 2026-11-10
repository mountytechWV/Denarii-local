// Reproduces Webull's published signature test vector:
// https://developer.webull.com/apis/docs/authentication/signature
// The vector's path is a trading path. It is used only to test the signer and
// lives outside api/ so the read-only check never sees it.

const test = require('node:test');
const assert = require('node:assert/strict');
const sign = require('../electron/webull/sign');

const VECTOR = {
  path: '/trade/place_order',
  query: { a1: 'webull', a2: '123', a3: 'xxx', q1: 'yyy' },
  appKey: '776da210ab4a452795d74e726ebd74b6',
  appSecret: '0f50a2e853334a9aae1a783bee120c1f',
  timestamp: '2022-01-04T03:55:31Z',
  nonce: '48ef5afed43d4d91ae514aaeafbc29ba',
  host: 'api.webull.com',
  body: '{"k1":123,"k2":"this is the api request body","k3":true,"k4":{"foo":[1,2]}}',
  bodyMd5: 'E296C96787E1A309691CEF3692F5EEDD',
  str1: 'a1=webull&a2=123&a3=xxx&host=api.webull.com&q1=yyy&x-app-key=776da210ab4a452795d74e726ebd74b6&x-signature-algorithm=HMAC-SHA1&x-signature-nonce=48ef5afed43d4d91ae514aaeafbc29ba&x-signature-version=1.0&x-timestamp=2022-01-04T03:55:31Z',
  encoded: '%2Ftrade%2Fplace_order%26a1%3Dwebull%26a2%3D123%26a3%3Dxxx%26host%3Dapi.webull.com%26q1%3Dyyy%26x-app-key%3D776da210ab4a452795d74e726ebd74b6%26x-signature-algorithm%3DHMAC-SHA1%26x-signature-nonce%3D48ef5afed43d4d91ae514aaeafbc29ba%26x-signature-version%3D1.0%26x-timestamp%3D2022-01-04T03%3A55%3A31Z%26E296C96787E1A309691CEF3692F5EEDD',
  signature: 'kvlS6opdZDhEBo5jq40nHYXaLvM=',
};

const signedHeaders = {
  'x-app-key': VECTOR.appKey,
  'x-timestamp': VECTOR.timestamp,
  'x-signature-version': '1.0',
  'x-signature-algorithm': 'HMAC-SHA1',
  'x-signature-nonce': VECTOR.nonce,
  host: VECTOR.host,
};

test('body MD5 matches the vector', () => {
  assert.equal(sign.bodyMd5(VECTOR.body), VECTOR.bodyMd5);
});

test('string to sign and its encoding match the vector', () => {
  const str3 = sign.buildStringToSign({
    path: VECTOR.path, query: VECTOR.query, signedHeaders, body: VECTOR.body,
  });
  assert.equal(str3, VECTOR.path + '&' + VECTOR.str1 + '&' + VECTOR.bodyMd5);
  assert.equal(sign.urlEncode(str3), VECTOR.encoded);
});

test('signRequest with HMAC-SHA1 reproduces the published signature exactly', () => {
  const headers = sign.signRequest({
    appKey: VECTOR.appKey,
    appSecret: VECTOR.appSecret,
    host: VECTOR.host,
    path: VECTOR.path,
    query: VECTOR.query,
    body: VECTOR.body,
    timestamp: VECTOR.timestamp,
    nonce: VECTOR.nonce,
    algorithm: 'HMAC-SHA1',
  });
  assert.equal(headers['x-signature'], VECTOR.signature);
  assert.equal(headers['x-app-key'], VECTOR.appKey);
  assert.equal(headers['x-timestamp'], VECTOR.timestamp);
  assert.equal(headers['x-signature-nonce'], VECTOR.nonce);
  assert.equal(headers['x-signature-algorithm'], 'HMAC-SHA1');
  assert.equal(headers['x-signature-version'], '1.0');
  assert.equal(headers['x-version'], 'v3');
  assert.equal(headers['Content-Type'], 'application/json');
  assert.ok(!Object.values(headers).includes(VECTOR.appSecret), 'secret must never be a header');
  assert.ok(!('host' in headers), 'host is signed but set by the HTTP layer');
});

// Expected values computed by the official Python SDK's signing logic
// (default_signature_composer.py + sha_hmac256_new.py, copied verbatim with the
// random timestamp/nonce fixed), using the published example key and secret.
const SDK = {
  appKey: VECTOR.appKey, appSecret: VECTOR.appSecret, host: VECTOR.host,
  timestamp: VECTOR.timestamp, nonce: VECTOR.nonce,
};

test('HMAC-SHA256 is the default and matches the official SDK', () => {
  const cases = [
    [{ path: '/auth/tokens/create', body: '{}' }, 'F7OSf9sDetTpkYx8KsAPGo6IiJkiAG5wS45eFuY7nbo='],
    [{ path: '/auth/tokens/check', body: '{"token":"ccb071f764864b65a1fb48484e940a56"}' }, 'kaa3/IEdXGo4JooA7UXeGEValVwS3ju9Dx8KlP0HKEI='],
    [{ path: '/trading/orders/historical-orders/list', query: { account_id: 'ABC', start_time: '2026-09-18T00:00:00.000Z' } }, 'sXegslHDRJ+vtwOTM262XV/Tk+kDybY5QIqG2nFz5L4='],
  ];
  for (const [req, expected] of cases) {
    const headers = sign.signRequest({ ...SDK, ...req });
    assert.equal(headers['x-signature-algorithm'], 'HMAC-SHA256');
    assert.equal(headers['x-signature'], expected, req.path);
  }
});

test('unknown algorithms are rejected', () => {
  assert.throws(() => sign.signRequest({ ...SDK, path: '/p', algorithm: 'HMAC-MD5' }), /Unsupported/);
});

test('duplicate names sort their values and join with &', () => {
  const str3 = sign.buildStringToSign({
    path: '/p', query: { b: ['2', '1'], a: 'x' }, signedHeaders: { host: 'h' },
  });
  assert.equal(str3, '/p&a=x&b=1&2&host=h');
});

test('no body means no MD5 segment and no Content-Type', () => {
  const str3 = sign.buildStringToSign({ path: '/p', query: {}, signedHeaders: { host: 'h' } });
  assert.equal(str3, '/p&host=h');
  const headers = sign.signRequest({ appKey: 'k', appSecret: 's', host: 'h.example', path: '/p' });
  assert.ok(!('Content-Type' in headers));
});

test('timestamp format and nonce shape', () => {
  assert.equal(sign.formatTimestamp(new Date(Date.UTC(2022, 0, 4, 3, 55, 31, 789))), '2022-01-04T03:55:31Z');
  assert.match(sign.newNonce(), /^[0-9a-f]{32}$/);
  assert.notEqual(sign.newNonce(), sign.newNonce());
});

test('object bodies are rejected (must sign the exact bytes sent)', () => {
  assert.throws(() => sign.signRequest({
    appKey: 'k', appSecret: 's', host: 'h.example', path: '/p', body: { a: 1 },
  }));
});
