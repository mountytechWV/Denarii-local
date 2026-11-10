// Preload for the Denarii window (sandboxed, contextIsolation on).
// Exposes window.denariiStore (async access to the SQLite key-value store in
// the main process, electron/db.js), window.denariiAutoSignIn,
// window.denariiApp, window.denariiWebull and window.denariiUpdate. Every call returns a Promise.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('denariiStore', {
  // -> { status: 'created' | 'ok' }
  open: () => ipcRenderer.invoke('denarii-store:open'),
  // -> stored value, or null when the key is missing
  get: (store, key) => ipcRenderer.invoke('denarii-store:get', store, key),
  // -> undefined
  put: (store, key, value) => ipcRenderer.invoke('denarii-store:put', store, key, value),
  // -> undefined
  delete: (store, key) => ipcRenderer.invoke('denarii-store:delete', store, key),
  // -> string[] sorted by key
  getAllKeys: (store) => ipcRenderer.invoke('denarii-store:getAllKeys', store),
  // -> { path, sizeBytes, autoBackups: [{ name, at }] }
  info: () => ipcRenderer.invoke('denarii-store:info'),
  // Save dialog, then a consistent copy of the whole database.
  // -> { ok: true, path } | { ok: false, cancelled: true } | { ok: false, error }
  backupTo: () => ipcRenderer.invoke('denarii-store:backupTo'),
  // Open dialog, validate, keep a pre-restore copy, replace, restart the app.
  // -> { ok: false, cancelled: true } | { ok: false, error }; on success the app restarts
  restoreFrom: () => ipcRenderer.invoke('denarii-store:restoreFrom'),
  // -> { ok: true } | { ok: false, error }
  openBackupsFolder: () => ipcRenderer.invoke('denarii-store:openBackupsFolder'),
});

// "Stay signed in on this computer" (electron/auto-signin.js). The protected
// file stays in the main process; tryUnlock hands over only the DEK.
contextBridge.exposeInMainWorld('denariiAutoSignIn', {
  // -> { available, accountId | null }
  status: () => ipcRenderer.invoke('denarii-autosignin:status'),
  // -> { ok: true } | { ok: false, error }
  enable: (accountId, dek) => ipcRenderer.invoke('denarii-autosignin:enable', accountId, dek),
  // No accountId: always clears; with one, only when that account holds it.
  // -> { ok: true, cleared } | { ok: false, error }
  disable: (accountId) => ipcRenderer.invoke('denarii-autosignin:disable', accountId),
  // First call per app launch only. -> { ok: true, accountId, dek } | { ok: false, reason }
  tryUnlock: () => ipcRenderer.invoke('denarii-autosignin:tryUnlock'),
});

contextBridge.exposeInMainWorld('denariiApp', {
  // -> { version } (package.json "version")
  getInfo: () => ipcRenderer.invoke('denarii-app:info'),
});

// Webull sync (electron/webull/). Webull is only ever called from the main
// process; the page gets fills one window at a time and acknowledges each
// after saving it. Keys, secret and token never come back to the page.
// Every call except attach acts on the account attached by this page.
// Errors: { ok: false, error }.
const WEBULL_EVENTS = { batch: 'denarii-webull:batch', status: 'denarii-webull:status' };

// Subscribes cb to one main-process event; cb gets only the payload.
// Returns a function that unsubscribes.
function onWebull(channel, cb) {
  if (typeof cb !== 'function') throw new TypeError('Callback must be a function.');
  const listener = (event, payload) => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

contextBridge.exposeInMainWorld('denariiWebull', {
  // Signed-in account; starts a sync now and every 15 minutes. -> { ok }
  attach: (accountId) => ipcRenderer.invoke('denarii-webull:attach', accountId),
  // Stops syncing and drops any unacknowledged batch. -> { ok }
  detach: () => ipcRenderer.invoke('denarii-webull:detach'),
  // -> { connected, last4, approvalState, approvalExpiresAt, accounts: [{ id, label }], defaultStartDate,
  //      links: [{ journalId, webullAccountId, startDate, lastSyncedAt, status, error, progress }] }
  status: () => ipcRenderer.invoke('denarii-webull:status'),
  // { appKey, appSecret, startDate: 'YYYY-MM-DD' | null }
  // -> { ok: true, approvalState: 'needs_approval', last4 } | { ok: false, error }
  connect: (input) => ipcRenderer.invoke('denarii-webull:connect', input),
  // -> { ok, approvalState, accounts?, message? } | { ok: false, error, retryAfterSec? }
  checkApproval: () => ipcRenderer.invoke('denarii-webull:checkApproval'),
  // -> { ok, approvalState, message } | { ok: false, error, retryAfterSec? }
  resendCode: () => ipcRenderer.invoke('denarii-webull:resendCode'),
  // Deletes the stored keys; links and imported trades stay. -> { ok }
  disconnect: () => ipcRenderer.invoke('denarii-webull:disconnect'),
  // { journalId, webullAccountId, startDate: 'YYYY-MM-DD' | null } -> { ok } | { ok: false, error }
  setLink: (input) => ipcRenderer.invoke('denarii-webull:setLink', input),
  // Imported trades stay. -> { ok }
  removeLink: (journalId) => ipcRenderer.invoke('denarii-webull:removeLink', journalId),
  // All linked journals, or one. -> { ok, started } | { ok, busy }
  syncNow: (journalId) => ipcRenderer.invoke('denarii-webull:syncNow', journalId),
  // cb({ runId, accountId, journalId, webullAccountId, windowStart, windowEnd, fills, stats }) -> unsubscribe
  onBatch: (cb) => onWebull(WEBULL_EVENTS.batch, cb),
  // After saving (or failing to save) a batch: result { ok, error? }. -> { ok }
  ackBatch: (runId, result) => ipcRenderer.invoke('denarii-webull:ackBatch', runId, result),
  // cb({ kind: 'progress' | 'journal' | 'run', ... }) -> unsubscribe
  onStatus: (cb) => onWebull(WEBULL_EVENTS.status, cb),
});

// Automatic updates (electron/updater.js, packaged app only).
contextBridge.exposeInMainWorld('denariiUpdate', {
  // cb({ version }) once an update is downloaded -> unsubscribe
  onReady: (cb) => onWebull('denarii-update:ready', cb),
  // Closes the window (unsaved-changes prompt first), installs, relaunches. -> { ok }
  install: () => ipcRenderer.invoke('denarii-update:install'),
});
