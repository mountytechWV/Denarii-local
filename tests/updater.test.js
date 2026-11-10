// Automatic updates (electron/updater.js, js/update-banner.js, preload):
// skipped when not packaged, errors only logged, the ready event reaches the
// page and shows the banner, Restart closes the window and then calls
// quitAndInstall(true, true), and only app:// may ask to install.
const test = require('node:test');
const assert = require('node:assert/strict');
const EventEmitter = require('node:events');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const { startUpdater, READY, INSTALL, FIRST_CHECK_MS, CHECK_EVERY_MS } = require('../electron/updater');

const isAppUrl = url => url === 'app://denarii' || url.startsWith('app://denarii/');
const APP_EVENT = { senderFrame: { url: 'app://denarii/index.html' } };

function fakeAutoUpdater(checkResult) {
  const u = new EventEmitter();
  u.checks = 0;
  u.installs = [];
  u.checkForUpdates = () => { u.checks++; return typeof checkResult === 'function' ? checkResult() : checkResult; };
  u.quitAndInstall = (...args) => { u.installs.push(args); };
  return u;
}

function fakeWindow() {
  const wc = new EventEmitter();
  wc.sent = [];
  wc.send = (ch, payload) => wc.sent.push([ch, payload]);
  wc.isDestroyed = () => false;
  return { webContents: wc, closed: 0, close() { this.closed++; }, isDestroyed: () => false };
}

// Runs fn with console.log captured into logs.
function quietly(logs, fn) {
  const orig = console.log;
  console.log = (...a) => logs.push(a.map(String).join(' '));
  try { return fn(); } finally { console.log = orig; }
}

function setup(opts) {
  const o = opts || {};
  const app = new EventEmitter();
  app.isPackaged = o.packaged !== false;
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const autoUpdater = fakeAutoUpdater(o.checkResult === undefined ? Promise.resolve(null) : o.checkResult);
  const win = fakeWindow();
  const timers = { timeouts: [], intervals: [] };
  const logs = [];
  const updater = quietly(logs, () => startUpdater({
    app, ipcMain, isAppUrl, autoUpdater,
    getWindow: () => win,
    setTimeout: (fn, ms) => timers.timeouts.push([fn, ms]),
    setInterval: (fn, ms) => timers.intervals.push([fn, ms]),
  }));
  const ready = version => quietly(logs, () => autoUpdater.emit('update-downloaded', { version }));
  return { app, handlers, autoUpdater, win, timers, logs, updater, ready };
}

const flush = () => new Promise(r => setImmediate(r));

test('skipped entirely when the app is not packaged (npm start)', () => {
  const env = setup({ packaged: false });
  assert.equal(env.updater, null);
  assert.deepEqual(Object.keys(env.handlers), []);
  assert.equal(env.timers.timeouts.length + env.timers.intervals.length, 0);
  assert.equal(env.autoUpdater.listenerCount('error'), 0);
  assert.equal(env.autoUpdater.autoDownload, undefined);
  assert.equal(env.app.listenerCount('will-quit'), 0);
});

test('configured per plan; first check after 30 s, then every 4 hours', () => {
  const env = setup();
  const u = env.autoUpdater;
  assert.equal(u.autoDownload, true);
  assert.equal(u.autoInstallOnAppQuit, true);
  assert.equal(u.allowPrerelease, false);
  assert.equal(u.allowDowngrade, false);
  assert.equal(env.timers.timeouts.length, 1);
  assert.equal(env.timers.timeouts[0][1], FIRST_CHECK_MS);
  assert.equal(FIRST_CHECK_MS, 30000);
  assert.equal(u.checks, 0);
  env.timers.timeouts[0][0]();
  assert.equal(u.checks, 1);
  assert.equal(env.timers.intervals[0][1], CHECK_EVERY_MS);
  assert.equal(CHECK_EVERY_MS, 4 * 60 * 60 * 1000);
  env.timers.intervals[0][0]();
  assert.equal(u.checks, 2);
});

test('errors, rejected checks and throwing checks are only logged', async () => {
  for (const checkResult of [
    () => Promise.reject(new Error('HttpError: 404')),
    () => { throw new Error('getaddrinfo ENOTFOUND github.com'); },
  ]) {
    const env = setup({ checkResult });
    const orig = console.log;
    console.log = (...a) => env.logs.push(a.map(String).join(' '));
    try {
      env.timers.timeouts[0][0]();
      env.autoUpdater.emit('error', new Error('net::ERR_INTERNET_DISCONNECTED'));
      await flush();
    } finally {
      console.log = orig;
    }
    assert.ok(env.logs.some(l => /check failed/.test(l)), env.logs.join('\n'));
    assert.ok(env.logs.some(l => /ERR_INTERNET_DISCONNECTED/.test(l)));
    assert.equal(env.win.webContents.sent.length, 0);
    assert.equal(env.win.closed, 0);
    assert.equal(env.autoUpdater.installs.length, 0);
  }
});

test('update-downloaded sends denarii-update:ready { version }, again after a reload', () => {
  const env = setup();
  assert.equal(env.win.webContents.sent.length, 0);
  env.ready('1.0.1');
  assert.deepEqual(env.win.webContents.sent, [[READY, { version: '1.0.1' }]]);
  env.win.webContents.emit('did-finish-load');
  assert.equal(env.win.webContents.sent.length, 2);
});

test('install: nothing before a download; then closes the window and installs on will-quit', () => {
  const env = setup();
  assert.deepEqual(env.handlers[INSTALL](APP_EVENT), { ok: false });
  assert.equal(env.win.closed, 0);
  env.ready('1.0.1');
  assert.deepEqual(env.handlers[INSTALL](APP_EVENT), { ok: true });
  assert.equal(env.win.closed, 1);
  assert.equal(env.autoUpdater.installs.length, 0);
  env.app.emit('will-quit');
  assert.deepEqual(env.autoUpdater.installs, [[true, true]]);
});

test('unsaved-changes "Stay" cancels: a later normal quit does not force a relaunch', () => {
  const env = setup();
  env.ready('1.0.1');
  env.handlers[INSTALL](APP_EVENT);
  env.updater.cancelInstall();
  env.app.emit('will-quit');
  assert.equal(env.autoUpdater.installs.length, 0); // autoInstallOnAppQuit installs it instead
});

test('install refuses senders that are not app://', () => {
  const env = setup();
  env.ready('1.0.1');
  for (const url of ['https://evil.example/', 'file:///C:/x.html', 'app://other/', 'app://denarii.evil/', '']) {
    assert.throws(() => env.handlers[INSTALL]({ senderFrame: { url } }), /Not allowed/, url);
  }
  assert.throws(() => env.handlers[INSTALL]({ senderFrame: null }), /Not allowed/);
  assert.throws(() => env.handlers[INSTALL]({}), /Not allowed/);
  assert.equal(env.win.closed, 0);
  assert.equal(env.autoUpdater.installs.length, 0);
});

test('preload exposes denariiUpdate.onReady (payload only) and install', () => {
  const exposed = {};
  const invoked = [];
  const listeners = {};
  const fakeElectron = {
    contextBridge: { exposeInMainWorld: (name, api) => { exposed[name] = api; } },
    ipcRenderer: {
      invoke: (...args) => { invoked.push(args); return Promise.resolve(); },
      on: (ch, fn) => { (listeners[ch] = listeners[ch] || []).push(fn); },
      removeListener: (ch, fn) => { listeners[ch] = (listeners[ch] || []).filter(f => f !== fn); },
    },
  };
  const original = Module._load;
  Module._load = function (request, ...rest) {
    if (request === 'electron') return fakeElectron;
    return original.call(this, request, ...rest);
  };
  const file = path.join(__dirname, '..', 'electron', 'preload.js');
  try {
    delete require.cache[file];
    require(file);
  } finally {
    Module._load = original;
    delete require.cache[file];
  }
  const api = exposed.denariiUpdate;
  assert.deepEqual(Object.keys(api).sort(), ['install', 'onReady']);
  const got = [];
  const off = api.onReady(p => got.push(p));
  listeners[READY][0]({ sender: 'x' }, { version: '1.0.1' });
  assert.deepEqual(got, [{ version: '1.0.1' }]);
  off();
  assert.equal(listeners[READY].length, 0);
  api.install();
  assert.deepEqual(invoked, [[INSTALL]]);
});

// Minimal DOM for js/update-banner.js.
function fakeDocument() {
  const byId = {};
  const make = tag => ({
    tagName: tag, children: [], style: {}, attrs: {}, handlers: {}, textContent: '', className: '', id: '',
    setAttribute(k, v) { this.attrs[k] = v; },
    addEventListener(t, fn) { this.handlers[t] = fn; },
    appendChild(c) { this.children.push(c); c.parent = this; if (c.id) byId[c.id] = c; return c; },
    remove() {
      if (this.parent) this.parent.children = this.parent.children.filter(c => c !== this);
      if (byId[this.id] === this) delete byId[this.id];
    },
  });
  const body = make('body');
  return { body, createElement: make, getElementById: id => byId[id] || null };
}

const bannerSrc = fs.readFileSync(path.join(__dirname, '..', 'js', 'update-banner.js'), 'utf8');

function loadBanner() {
  const document = fakeDocument();
  let readyCb = null;
  const installs = [];
  const window = {
    denariiUpdate: {
      onReady: cb => { readyCb = cb; return () => {}; },
      install: () => { installs.push(1); return Promise.resolve({ ok: true }); },
    },
  };
  new Function('window', 'document', bannerSrc)(window, document);
  return { document, installs, fire: info => readyCb(info), hasCb: () => !!readyCb };
}

test('banner appears only after the ready event; Restart installs, Later hides', () => {
  const env = loadBanner();
  assert.ok(env.hasCb());
  assert.equal(env.document.getElementById('update-ready-banner'), null);
  env.fire({ version: '1.0.1' });
  const bar = env.document.getElementById('update-ready-banner');
  assert.ok(bar);
  const [text, restart, later] = bar.children;
  assert.equal(text.textContent, 'Denarii 1.0.1 is ready. Restart to install.');
  assert.equal(restart.textContent, 'Restart');
  assert.equal(restart.className, 'btn btn-primary');
  assert.equal(later.textContent, 'Later');
  assert.equal(later.className, 'btn btn-secondary');
  restart.handlers.click();
  assert.equal(env.installs.length, 1);
  later.handlers.click();
  assert.equal(env.document.getElementById('update-ready-banner'), null);
  assert.equal(env.document.body.children.length, 0);
  // Another ready event replaces the bar rather than stacking.
  env.fire({ version: '1.0.2' });
  env.fire({ version: '1.0.2' });
  assert.equal(env.document.body.children.length, 1);
});

test('banner script does nothing outside the desktop app', () => {
  assert.doesNotThrow(() => new Function('window', 'document', bannerSrc)({}, fakeDocument()));
});
