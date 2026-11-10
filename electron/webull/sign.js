// Webull OpenAPI request signing, written from Webull's published spec:
// https://developer.webull.com/apis/docs/authentication/signature
// and checked against the official Python SDK (webull-openapi-python-sdk,
// core/auth/composer/default_signature_composer.py), which always signs with
// HMAC-SHA256 and hashes the body with SHA-256. The docs describe HMAC-SHA1 with
// an MD5 body hash; both are supported, and the SDK's choice is the default.
//
// Pure functions. Key and secret are always passed in by the caller; this module
// never reads environment variables and never logs anything.

const crypto = require('crypto');

// name -> HMAC digest and body-hash digest
const ALGORITHMS = Object.freeze({
  'HMAC-SHA256': Object.freeze({ hmac: 'sha256', bodyHash: 'sha256' }), // official SDK
  'HMAC-SHA1': Object.freeze({ hmac: 'sha1', bodyHash: 'md5' }), // docs page
});
const DEFAULT_ALGORITHM = 'HMAC-SHA256';
const SIGNATURE_VERSION = '1.0';
const API_VERSION = 'v3';

// UTC, YYYY-MM-DDThh:mm:ssZ (no milliseconds).
function formatTimestamp(date) {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

// 32 lowercase hex chars, same shape as the nonce in Webull's example.
function newNonce() {
  return crypto.randomBytes(16).toString('hex');
}

// Uppercase hex hash of the exact body string that will be sent.
function bodyHash(body, digest) {
  return crypto.createHash(digest).update(body, 'utf8').digest('hex').toUpperCase();
}
const bodyMd5 = body => bodyHash(body, 'md5');
const bodySha256 = body => bodyHash(body, 'sha256');

// Percent-encode everything except A-Z a-z 0-9 - _ . ~ (RFC 3986 unreserved).
function urlEncode(str) {
  return encodeURIComponent(str).replace(/[!'()*]/g, c =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase()
  );
}

// str3 before URL-encoding: path & sorted name=value pairs [& body hash].
// query: { name: value | value[] }; signedHeaders: { name: value }.
// Nothing is encoded here; duplicate names have their values sorted and joined with '&'.
function buildStringToSign({ path, query, signedHeaders, body, bodyDigest = 'md5' }) {
  const merged = new Map();
  const add = (name, value) => {
    const values = Array.isArray(value) ? value : [value];
    if (!merged.has(name)) merged.set(name, []);
    for (const v of values) merged.get(name).push(String(v));
  };
  for (const [name, value] of Object.entries(query || {})) add(name, value);
  for (const [name, value] of Object.entries(signedHeaders)) add(name, value);

  const str1 = [...merged.keys()]
    .sort()
    .map(name => name + '=' + merged.get(name).sort().join('&'))
    .join('&');

  let str3 = path + '&' + str1;
  if (body !== undefined && body !== null && body !== '') {
    str3 += '&' + bodyHash(body, bodyDigest);
  }
  return str3;
}

function computeSignature(appSecret, stringToSign, hmacDigest = 'sha1') {
  return crypto
    .createHmac(hmacDigest, appSecret + '&')
    .update(urlEncode(stringToSign), 'utf8')
    .digest('base64');
}

// Returns the headers to send. body, if present, must already be the exact
// compact-JSON string that goes on the wire (objects are rejected so the caller
// can't accidentally sign one serialization and send another).
function signRequest({ appKey, appSecret, host, path, query, body, timestamp, nonce, algorithm = DEFAULT_ALGORITHM }) {
  if (!appKey || !appSecret) throw new Error('Webull signing requires an app key and secret.');
  if (!host || !path) throw new Error('Webull signing requires a host and path.');
  if (body !== undefined && body !== null && typeof body !== 'string') {
    throw new Error('Webull request body must be a pre-serialized string.');
  }
  const algo = ALGORITHMS[algorithm];
  if (!algo) throw new Error('Unsupported Webull signature algorithm.');

  const signedHeaders = {
    'x-app-key': appKey,
    'x-signature-algorithm': algorithm,
    'x-signature-version': SIGNATURE_VERSION,
    'x-signature-nonce': nonce || newNonce(),
    'x-timestamp': timestamp || formatTimestamp(new Date()),
    host,
  };

  const signature = computeSignature(
    appSecret,
    buildStringToSign({ path, query, signedHeaders, body, bodyDigest: algo.bodyHash }),
    algo.hmac
  );

  const headers = {
    'x-app-key': signedHeaders['x-app-key'],
    'x-timestamp': signedHeaders['x-timestamp'],
    'x-signature': signature,
    'x-signature-algorithm': algorithm,
    'x-signature-version': SIGNATURE_VERSION,
    'x-signature-nonce': signedHeaders['x-signature-nonce'],
    'x-version': API_VERSION,
  };
  if (typeof body === 'string' && body !== '') headers['Content-Type'] = 'application/json';
  return headers;
}

module.exports = {
  formatTimestamp,
  newNonce,
  bodyMd5,
  bodySha256,
  urlEncode,
  buildStringToSign,
  computeSignature,
  signRequest,
};
