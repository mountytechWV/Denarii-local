// Fakes for the electron/webull tests: async safeStorage, Webull fetch, a
// manual clock and a temp SQLite database. Nothing here reaches Webull.

const fs = require('fs');
const os = require('os');
const path = require('path');
const db = require('../../electron/db');
const { createWebullStore } = require('../../electron/webull/store');

// Blobs look like "fake:<owner>:<base64 json>". A different owner (another
// Windows user or machine) fails to decrypt, as DPAPI would.
function fakeSafeStorage(opts) {
  const o = Object.assign({ owner: 'me', available: true, reEncrypt: false }, opts || {});
  const s = {
    encrypted: 0,
    async isAsyncEncryptionAvailable() { return o.available; },
    async encryptStringAsync(text) {
      s.encrypted++;
      return Buffer.from('fake:' + o.owner + ':' + Buffer.from(text, 'utf8').toString('base64'));
    },
    async decryptStringAsync(buf) {
      const str = Buffer.from(buf).toString('utf8');
      const m = /^fake:([^:]+):(.*)$/.exec(str);
      if (!m || m[1] !== o.owner) throw new Error('Error while decrypting the ciphertext provided to safeStorage.decryptString.');
      return { result: Buffer.from(m[2], 'base64').toString('utf8'), shouldReEncrypt: o.reEncrypt };
    },
    set(k, v) { o[k] = v; },
  };
  return s;
}

function abortError() {
  const e = new Error('The operation was aborted.');
  e.name = 'AbortError';
  return e;
}

// Manual clock: sleep advances time at once (and records the wait);
// timers and intervals fire only when the test fires them.
function fakeClock(start) {
  let t = start === undefined ? Date.UTC(2026, 10, 10, 15, 0, 0) : start;
  let id = 0;
  const timers = new Map();
  const intervals = new Map();
  const c = {
    sleeps: [],
    now: () => t,
    advance(ms) { t += ms; },
    async sleep(ms, signal) {
      if (signal && signal.aborted) throw abortError();
      c.sleeps.push(ms);
      t += ms;
      await Promise.resolve();
      if (signal && signal.aborted) throw abortError();
    },
    setTimeout(fn, ms) { const h = ++id; timers.set(h, { fn, ms }); return h; },
    clearTimeout(h) { timers.delete(h); },
    setInterval(fn, ms) { const h = ++id; intervals.set(h, { fn, ms }); return h; },
    clearInterval(h) { intervals.delete(h); },
    // Fires pending timeouts with the given delay (all when ms is omitted).
    fireTimeouts(ms) {
      for (const [h, tm] of [...timers]) {
        if (ms === undefined || tm.ms === ms) { timers.delete(h); tm.fn(); }
      }
    },
    intervals: () => [...intervals.values()],
    fireIntervals() { for (const iv of [...intervals.values()]) iv.fn(); },
  };
  return c;
}

function jsonResponse(status, body) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

// handler(call) -> response | Promise<response>; call: { path, query, method,
// headers, body, signal, at }. Every call is recorded.
function fakeFetch(clock, handler) {
  const calls = [];
  const f = async (url, init) => {
    const u = new URL(url);
    const call = {
      host: u.host,
      path: u.pathname,
      query: Object.fromEntries(u.searchParams),
      method: init.method,
      headers: init.headers,
      body: init.body,
      signal: init.signal,
      at: clock ? clock.now() : Date.now(),
    };
    calls.push(call);
    return handler(call);
  };
  f.calls = calls;
  return f;
}

// A fetch call that never answers until its signal aborts (timeouts, detach).
function hang(call) {
  return new Promise((resolve, reject) => {
    call.signal.addEventListener('abort', () => reject(abortError()), { once: true });
  });
}

function tempStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'denarii-wbt-'));
  const r = db.openDatabase(dir);
  t.after(() => {
    db.closeDatabase(r.db);
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db: r.db, kv: db.createKv(r.db), store: createWebullStore(() => r.db) };
}

const flush = () => new Promise(r => setImmediate(r));

module.exports = { fakeSafeStorage, fakeClock, fakeFetch, jsonResponse, hang, tempStore, flush, abortError };
