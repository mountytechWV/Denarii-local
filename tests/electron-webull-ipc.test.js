// IPC for window.denariiWebull (electron/webull/ipc.js) and the preload
// bridge: senders other than app:// are refused, bad keys, dates, journal
// ids and runIds are rejected before reaching the scheduler, and only the
// attached page can act.

const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');
const path = require('path');
const { registerWebullIpc, PREFIX } = require('../electron/webull/ipc');
const { MESSAGES } = require('../electron/webull/fetch');

const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);
const KEY = 'us.TESTKEY1234567890ab';
const SECRET = 'TESTSECRET_abcdefghijklmnop';
const RUN_ID = 'a'.repeat(32);
const isAppUrl = url => url === 'app://denarii' || url.startsWith('app://denarii/');

// Records which scheduler methods were reached, with their arguments.
function fakeScheduler() {
  const calls = [];
  let attachedWc = null;
  const rec = (name, ret) => (...args) => { calls.push([name, ...args]); return ret; };
  return {
    calls,
    attach: (wc, id) => { calls.push(['attach', id]); attachedWc = wc; return { ok: true }; },
    detach: () => { calls.push(['detach']); attachedWc = null; return { ok: true }; },
    isAttached: wc => !!attachedWc && attachedWc === wc,
    status: rec('status', { connected: false, links: [] }),
    connect: rec('connect', Promise.resolve({ ok: true })),
    checkApproval: rec('checkApproval', Promise.resolve({ ok: true })),
    resendCode: rec('resendCode', Promise.resolve({ ok: true })),
    disconnect: rec('disconnect', Promise.resolve({ ok: true })),
    setLink: rec('setLink', { ok: true }),
    removeLink: rec('removeLink', { ok: true }),
    syncNow: rec('syncNow', { ok: true, started: true }),
    ackBatch: (wc, runId, result) => { calls.push(['ackBatch', runId, result]); return { ok: true }; },
  };
}

function setup(opts) {
  const handlers = {};
  const ipcMain = { handle: (name, fn) => { handlers[name] = fn; } };
  const scheduler = fakeScheduler();
  const state = { open: true };
  const names = registerWebullIpc({
    ipcMain, isAppUrl, isOpen: () => state.open, getScheduler: () => scheduler, now: () => NOW,
  });
  const page = { id: 1 };
  const event = (url, sender) => ({ senderFrame: { url: url === undefined ? 'app://denarii/index.html' : url }, sender: sender || page });
  const call = (name, ...args) => handlers[PREFIX + name](event(), ...args);
  return { handlers, names, scheduler, state, page, event, call, opts };
}

function attached() {
  const env = setup();
  assert.deepEqual(env.call('attach', 'acct_1'), { ok: true });
  env.scheduler.calls.length = 0;
  return env;
}

test('registers exactly the plan section 7 calls', () => {
  const { names } = setup();
  assert.deepEqual(names.map(n => n.slice(PREFIX.length)).sort(), [
    'ackBatch', 'attach', 'checkApproval', 'connect', 'detach', 'disconnect', 'removeLink', 'resendCode', 'setLink', 'status', 'syncNow',
  ]);
});

test('every handler refuses a sender that is not app://, and a closed database', () => {
  const env = setup();
  for (const name of env.names) {
    for (const url of ['https://evil.example/', 'file:///C:/x.html', 'app://other/', 'app://denarii.evil/', '', undefined, null]) {
      const ev = url === undefined ? { sender: env.page } : env.event(url === null ? undefined : url);
      if (url === null) ev.senderFrame = null;
      assert.throws(() => env.handlers[name](ev, 'acct_1'), /Not allowed/, name + ' ' + url);
    }
  }
  env.state.open = false;
  for (const name of env.names) assert.throws(() => env.handlers[name](env.event(), 'acct_1'), /Database is closed/, name);
  assert.equal(env.scheduler.calls.length, 0);
});

test('attach validates the account id', () => {
  const env = setup();
  for (const bad of [undefined, null, '', 5, {}, 'x'.repeat(129)]) {
    assert.deepEqual(env.call('attach', bad), { ok: false, error: 'Invalid request.' });
  }
  assert.equal(env.scheduler.calls.length, 0);
});

test('calls other than attach need the attached page', () => {
  const env = setup();
  for (const name of ['status', 'connect', 'checkApproval', 'resendCode', 'disconnect', 'setLink', 'removeLink', 'syncNow', 'ackBatch']) {
    assert.equal(env.call(name).ok, false, name);
  }
  env.call('attach', 'acct_1');
  const other = { id: 2 };
  assert.equal(env.handlers[PREFIX + 'status'](env.event(undefined, other)).ok, false);
  // detach from another page is a no-op
  assert.deepEqual(env.handlers[PREFIX + 'detach'](env.event(undefined, other)), { ok: true });
  assert.ok(!env.scheduler.calls.some(c => c[0] === 'detach'));
  assert.deepEqual(env.call('detach'), { ok: true });
  assert.ok(env.scheduler.calls.some(c => c[0] === 'detach'));
});

test('connect rejects bad keys, secrets, dates and extra fields', () => {
  const env = attached();
  const bad = [
    [undefined, 'Invalid request.'],
    ['x', 'Invalid request.'],
    [[KEY, SECRET], 'Invalid request.'],
    [{ appKey: KEY, appSecret: SECRET, extra: 1 }, 'Invalid request.'],
    [{ appKey: 'short', appSecret: SECRET }, MESSAGES.badInput],
    [{ appKey: KEY, appSecret: 'has spaces in it !!!' }, MESSAGES.badInput],
    [{ appKey: KEY, appSecret: SECRET + '.' }, MESSAGES.badInput],
    [{ appKey: KEY + 'x'.repeat(300), appSecret: SECRET }, MESSAGES.badInput],
    [{ appKey: 123, appSecret: SECRET }, MESSAGES.badInput],
    [{ appKey: KEY, appSecret: SECRET, startDate: '2018-05-20' }, MESSAGES.badDate],
    [{ appKey: KEY, appSecret: SECRET, startDate: '2026-11-11' }, MESSAGES.badDate],
    [{ appKey: KEY, appSecret: SECRET, startDate: '2025-02-29' }, MESSAGES.badDate],
    [{ appKey: KEY, appSecret: SECRET, startDate: '2025-1-02' }, MESSAGES.badDate],
    [{ appKey: KEY, appSecret: SECRET, startDate: 1700000000000 }, MESSAGES.badDate],
  ];
  for (const [input, error] of bad) assert.deepEqual(env.call('connect', input), { ok: false, error }, JSON.stringify(input));
  assert.equal(env.scheduler.calls.length, 0);

  env.call('connect', { appKey: KEY, appSecret: SECRET, startDate: '' });
  env.call('connect', { appKey: KEY, appSecret: SECRET, startDate: '2018-05-21' });
  env.call('connect', { appKey: KEY, appSecret: SECRET, startDate: '2026-11-10' });
  assert.deepEqual(env.scheduler.calls.map(c => c[1].startDate), [null, '2018-05-21', '2026-11-10']);
});

test('setLink, removeLink and syncNow reject bad journal ids, account ids and dates', () => {
  const env = attached();
  for (const journalId of [undefined, '', 'has space', 'a/b', 'x'.repeat(65), 5, '<script>']) {
    assert.equal(env.call('setLink', { journalId, webullAccountId: 'W1' }).ok, false, String(journalId));
    assert.equal(env.call('removeLink', journalId).ok, false);
    if (journalId !== undefined) assert.equal(env.call('syncNow', journalId).ok, false);
  }
  for (const webullAccountId of [undefined, '', 'has space', 'x'.repeat(65), 7]) {
    assert.equal(env.call('setLink', { journalId: 'j1', webullAccountId }).ok, false);
  }
  assert.equal(env.call('setLink', { journalId: 'j1', webullAccountId: 'W1', startDate: '2030-01-01' }).error, MESSAGES.badDate);
  assert.equal(env.call('setLink', { journalId: 'j1', webullAccountId: 'W1', other: 1 }).ok, false);
  assert.equal(env.scheduler.calls.length, 0);

  env.call('setLink', { journalId: 'journal_1-a', webullAccountId: 'ABC123', startDate: null });
  env.call('removeLink', 'journal_1-a');
  env.call('syncNow');
  env.call('syncNow', null);
  env.call('syncNow', 'journal_1-a');
  assert.deepEqual(env.scheduler.calls, [
    ['setLink', { journalId: 'journal_1-a', webullAccountId: 'ABC123', startDate: null }],
    ['removeLink', 'journal_1-a'],
    ['syncNow', undefined],
    ['syncNow', null],
    ['syncNow', 'journal_1-a'],
  ]);
});

test('ackBatch validates the runId and result', () => {
  const env = attached();
  for (const runId of [undefined, '', 'A'.repeat(32), 'a'.repeat(31), 'a'.repeat(33), 5, 'g'.repeat(32)]) {
    assert.equal(env.call('ackBatch', runId, { ok: true }).ok, false, String(runId));
  }
  for (const result of [undefined, true, { ok: 'yes' }, { ok: true, extra: 1 }, { ok: false, error: 5 }, { ok: false, error: 'x'.repeat(501) }, [true]]) {
    assert.equal(env.call('ackBatch', RUN_ID, result).ok, false, JSON.stringify(result));
  }
  assert.equal(env.scheduler.calls.length, 0);
  env.call('ackBatch', RUN_ID, { ok: true });
  env.call('ackBatch', RUN_ID, { ok: false, error: 'Disk full' });
  assert.deepEqual(env.scheduler.calls, [
    ['ackBatch', RUN_ID, { ok: true, error: null }],
    ['ackBatch', RUN_ID, { ok: false, error: 'Disk full' }],
  ]);
});

test('preload exposes window.denariiWebull with the plan calls; events pass only the payload', () => {
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
    delete require.cache[require.resolve(file)];
    require(file);
  } finally {
    Module._load = original;
    delete require.cache[require.resolve(file)];
  }
  const api = exposed.denariiWebull;
  assert.deepEqual(Object.keys(api).sort(), [
    'ackBatch', 'attach', 'checkApproval', 'connect', 'detach', 'disconnect', 'onBatch', 'onStatus', 'removeLink', 'resendCode', 'setLink', 'status', 'syncNow',
  ]);
  assert.ok(exposed.denariiStore && exposed.denariiAutoSignIn, 'existing bridges unchanged');

  api.attach('acct_1');
  api.connect({ appKey: KEY, appSecret: SECRET, startDate: null });
  api.ackBatch(RUN_ID, { ok: true });
  assert.deepEqual(invoked.map(a => a[0]), ['denarii-webull:attach', 'denarii-webull:connect', 'denarii-webull:ackBatch']);
  assert.deepEqual(invoked[2], ['denarii-webull:ackBatch', RUN_ID, { ok: true }]);

  const got = [];
  const off = api.onBatch(b => got.push(b));
  listeners['denarii-webull:batch'][0]({ sender: 'secret-event' }, { runId: RUN_ID });
  assert.deepEqual(got, [{ runId: RUN_ID }]);
  off();
  assert.equal(listeners['denarii-webull:batch'].length, 0);
  api.onStatus(() => {});
  assert.equal(listeners['denarii-webull:status'].length, 1);
  assert.throws(() => api.onBatch('not a function'), TypeError);
});
