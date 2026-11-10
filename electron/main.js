// Electron main process for Denarii Local.
// Serves the app from app://denarii/ (a privileged standard + secure scheme,
// so crypto.subtle and localStorage work and persist under one fixed origin),
// keeps app data in a SQLite file (electron/db.js) reached through the
// preload's window.denariiStore, blocks the cloud hosts, and sends external
// links to the default browser. The packaged app also updates itself
// (electron/updater.js). Run with: npm start

const { app, BrowserWindow, Menu, dialog, ipcMain, net, protocol, safeStorage, session, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const store = require('./db');
const autoSignInFile = require('./auto-signin');
const { createWebullStore } = require('./webull/store');
const { createConnection } = require('./webull/connection');
const { createScheduler } = require('./webull/scheduler');
const { registerWebullIpc } = require('./webull/ipc');
const { startUpdater } = require('./updater');

const SCHEME = 'app';
const HOST = 'denarii';
const ORIGIN = SCHEME + '://' + HOST;
const ROOT = path.join(__dirname, '..');

// Top-level folders the page never loads; not served.
const HIDDEN_DIRS = new Set(['node_modules', 'electron']);

// Live cloud Denarii hosts; Denarii Local must never reach them.
const BLOCKED_URLS = [
  '*://*.supabase.co/*',
  '*://*.supabase.in/*',
  '*://*.vercel.app/*',
];

// Fixed data folder (%APPDATA%\Denarii on Windows) so saved data persists
// across launches and is not shared with other Electron apps.
app.setName('Denarii');
app.setPath('userData', path.join(app.getPath('appData'), 'Denarii'));

// One running copy: a second launch focuses the existing window and exits,
// so two windows never write the same database at once.
const gotInstanceLock = app.requestSingleInstanceLock();
if (!gotInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) return;
    if (win.isMinimized()) win.restore();
    win.show();
    win.focus();
  });
}

protocol.registerSchemesAsPrivileged([
  { scheme: SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } },
]);

// Sent on every app:// response. 'unsafe-inline' is needed for the inline
// onclick= handlers and style= attributes; origins stay locked to the app,
// Gemini and Twelve Data.
const CSP = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self' https://generativelanguage.googleapis.com https://api.twelvedata.com",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "worker-src 'self' blob:",
].join('; ');

function notFound() {
  return new Response('Not found', { status: 404, headers: { 'content-type': 'text/plain' } });
}

// Copies the response with the CSP header added (fetch response headers
// can be immutable, so they are not edited in place).
function withCsp(res) {
  const headers = new Headers(res.headers);
  headers.set('Content-Security-Policy', CSP);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers });
}

async function serveFile(request) {
  return withCsp(await resolveFile(request));
}

// Maps app://denarii/<path> to a file under ROOT. Query strings (?v=79) are
// ignored; anything outside ROOT, in a hidden folder or a dot-path is 404.
async function resolveFile(request) {
  const url = new URL(request.url);
  if (url.host !== HOST) return notFound();
  let rel;
  try { rel = decodeURIComponent(url.pathname); } catch (e) { return notFound(); }
  if (rel === '/' || rel === '') rel = '/index.html';
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length || HIDDEN_DIRS.has(parts[0]) || parts.some(p => p.startsWith('.'))) return notFound();
  const file = path.resolve(ROOT, ...parts);
  if (file !== ROOT && !file.startsWith(ROOT + path.sep)) return notFound();
  try {
    const res = await net.fetch(pathToFileURL(file).toString());
    return res.ok ? res : notFound();
  } catch (e) {
    return notFound();
  }
}

function isAppUrl(url) {
  return url === ORIGIN || url.startsWith(ORIGIN + '/');
}

function openExternal(url) {
  if (/^(https?:|mailto:)/i.test(url)) shell.openExternal(url);
}

function buildMenu() {
  const template = [];
  if (process.platform === 'darwin') template.push({ role: 'appMenu' });
  template.push({ role: 'editMenu' });
  template.push({
    label: 'View',
    submenu: [
      { role: 'reload' },
      { role: 'forceReload' },
      { role: 'toggleDevTools' },
      { type: 'separator' },
      { role: 'resetZoom' },
      { role: 'zoomIn' },
      { role: 'zoomOut' },
      { type: 'separator' },
      { role: 'togglefullscreen' },
    ],
  });
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ── Database ─────────────────────────────────────────────────────────────

let database = null;   // node:sqlite DatabaseSync
let kv = null;         // store.createKv(database)
let openStatus = null; // 'created' | 'ok', reported once to the page

function dataDialog(options) {
  return dialog.showMessageBoxSync(Object.assign({ title: 'Denarii', noLink: true }, options));
}

// Opens userData/denarii.sqlite before the window loads. Returns false when
// the user chooses Quit. A file that cannot be validated is never
// overwritten: it is only moved aside (renamed) once the user picks
// Restore or Start fresh, so Quit leaves everything exactly as it was.
function openDatabaseWithDialogs() {
  const dir = app.getPath('userData');
  const file = store.dbPath(dir);
  const tried = new Set();
  let upgraded = false;
  for (;;) {
    try {
      const r = store.openDatabase(dir);
      database = r.db;
      kv = store.createKv(database);
      openStatus = r.status;
      if (r.migratedFrom) {
        // openDatabase already took the automatic backup before upgrading.
        upgraded = true;
        console.log('[Denarii] Database upgraded from version', r.migratedFrom, '- backup', r.preMigrationBackup);
      }
      break;
    } catch (e) {
      const kind = e.kind || 'open-failed';
      if (kind === 'newer') {
        dataDialog({
          type: 'error',
          message: 'This data was saved by a newer Denarii',
          detail: 'Install the newer version of Denarii to open it. Nothing was changed.\n\n' + file,
          buttons: ['Quit'],
        });
        return false;
      }
      if (kind === 'locked' || kind === 'open-failed') {
        const i = dataDialog({
          type: 'warning',
          message: kind === 'locked' ? 'The Denarii database is in use by another program.' : 'Denarii could not open its database.',
          detail: e.message + '\n\n' + file,
          buttons: ['Retry', 'Quit'],
          defaultId: 0,
          cancelId: 1,
        });
        if (i === 0) continue;
        return false;
      }
      // corrupt
      const backup = store.listAutoBackups(dir).find(b => !tried.has(b.path));
      const buttons = backup ? ['Restore latest automatic backup', 'Start fresh', 'Quit'] : ['Start fresh', 'Quit'];
      const i = dataDialog({
        type: 'error',
        message: 'The Denarii database could not be read.',
        detail: 'Reason: ' + e.message + '\n\n' + file +
          '\n\nRestore and Start fresh first move this file aside as denarii.corrupt-<time>.sqlite; it is not deleted.' +
          (backup ? '\n\nLatest automatic backup: ' + backup.name : ''),
        buttons,
        defaultId: 0,
        cancelId: buttons.length - 1,
      });
      const choice = buttons[i];
      if (choice === 'Quit') return false;
      try {
        const moved = store.quarantine(dir);
        console.warn('[Denarii] Unreadable database moved to', moved);
        // The database is being replaced: automatic sign-in starts over.
        autoSignInFile.clear(dir);
        if (choice === 'Restore latest automatic backup') {
          tried.add(backup.path);
          store.restoreAutoBackup(dir, backup.path);
          console.log('[Denarii] Restored automatic backup', backup.name);
        }
      } catch (re) {
        dataDialog({ type: 'error', message: 'Denarii could not recover its database.', detail: re.message, buttons: ['Quit'] });
        return false;
      }
    }
  }
  if (upgraded) return true;
  try {
    const b = store.autoBackup(database, dir);
    if (b) console.log('[Denarii] Automatic backup saved:', b);
  } catch (e) {
    console.warn('[Denarii] Automatic backup failed:', e.message);
  }
  return true;
}

function closeDatabase() {
  if (!database) return;
  store.closeDatabase(database);
  database = null;
  kv = null;
}

// IPC for window.denariiStore. Only the app page may call it; store, key and
// value size are validated in store.createKv. Handlers are synchronous, so
// calls run to completion in the order they arrive.
function registerStoreIpc() {
  const guard = (event) => {
    const url = event.senderFrame && event.senderFrame.url;
    if (!url || !isAppUrl(url)) throw new Error('Not allowed.');
    if (!kv) throw new Error('Database is closed.');
  };
  ipcMain.handle('denarii-store:open', (event) => {
    guard(event);
    const status = openStatus;
    openStatus = 'ok';
    return { status };
  });
  ipcMain.handle('denarii-store:get', (event, storeName, key) => { guard(event); return kv.get(storeName, key); });
  ipcMain.handle('denarii-store:put', (event, storeName, key, value) => { guard(event); kv.put(storeName, key, value); });
  ipcMain.handle('denarii-store:delete', (event, storeName, key) => { guard(event); kv.delete(storeName, key); });
  ipcMain.handle('denarii-store:getAllKeys', (event, storeName) => { guard(event); return kv.getAllKeys(storeName); });
  // Backup and restore paths come only from these dialogs, never from the page.
  ipcMain.handle('denarii-store:backupTo', async (event) => {
    guard(event);
    const d = new Date();
    const p = n => String(n).padStart(2, '0');
    const name = 'Denarii-backup-' + d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + '.sqlite';
    const res = await dialog.showSaveDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Back up all Denarii data',
      defaultPath: path.join(app.getPath('documents'), name),
      filters: [{ name: 'Denarii backup', extensions: ['sqlite'] }],
    });
    if (res.canceled || !res.filePath) return { ok: false, cancelled: true };
    if (!kv) return { ok: false, error: 'Database is closed.' };
    try {
      return { ok: true, path: store.backupTo(database, app.getPath('userData'), res.filePath) };
    } catch (e) {
      return { ok: false, error: e.message };
    }
  });
  ipcMain.handle('denarii-store:restoreFrom', async (event) => {
    guard(event);
    const res = await dialog.showOpenDialog(BrowserWindow.fromWebContents(event.sender), {
      title: 'Restore Denarii data from a backup',
      properties: ['openFile'],
      filters: [{ name: 'Denarii backup', extensions: ['sqlite'] }],
    });
    if (res.canceled || !res.filePaths || !res.filePaths[0]) return { ok: false, cancelled: true };
    if (!kv) return { ok: false, error: 'Database is closed.' };
    const dir = app.getPath('userData');
    // Stop any Webull sync before the database is closed; the page attaches
    // again after the restart (or after its next sign-in if restore fails).
    if (webullSync) webullSync.detach();
    try {
      const r = store.restoreFrom(database, dir, res.filePaths[0]);
      console.log('[Denarii] Restored', res.filePaths[0], '- safety copy', r.safetyCopy);
    } catch (e) {
      if (e.dbClosed) {
        // The live file was not replaced; reopen it and carry on.
        database = null;
        kv = null;
        try {
          const r = store.openDatabase(dir);
          database = r.db;
          kv = store.createKv(database);
        } catch (re) {
          return { ok: false, error: e.message + ' Denarii could not reopen its database (' + re.message + '); restart the app.' };
        }
      }
      return { ok: false, error: e.message };
    }
    // The restored database may hold other accounts or keys: the next launch
    // asks for the password.
    autoSignInFile.clear(dir);
    database = null;
    kv = null;
    app.relaunch();
    app.exit(0);
    return { ok: true };
  });
  ipcMain.handle('denarii-store:openBackupsFolder', async (event) => {
    guard(event);
    const folder = store.backupsDir(app.getPath('userData'));
    fs.mkdirSync(folder, { recursive: true });
    const err = await shell.openPath(folder);
    return err ? { ok: false, error: err } : { ok: true };
  });
  ipcMain.handle('denarii-store:info', (event) => {
    guard(event);
    const dir = app.getPath('userData');
    const file = store.dbPath(dir);
    let sizeBytes = 0;
    try { sizeBytes = fs.statSync(file).size; } catch (e) { /* missing */ }
    return {
      path: file,
      sizeBytes,
      autoBackups: store.listAutoBackups(dir).map(b => ({ name: b.name, at: b.at })),
    };
  });
}

// IPC for window.denariiAutoSignIn ("Stay signed in on this computer").
// Same caller check as the store. The protected file never leaves the main
// process; the page only receives the DEK from a successful tryUnlock.
function registerAutoSignInIpc() {
  const autoSignIn = autoSignInFile.createAutoSignIn({
    dir: app.getPath('userData'),
    safeStorage,
    getAccount: (accountId) => (kv ? kv.get('auth', 'account:' + accountId) : null),
  });
  const guard = (event) => {
    const url = event.senderFrame && event.senderFrame.url;
    if (!url || !isAppUrl(url)) throw new Error('Not allowed.');
    if (!kv) throw new Error('Database is closed.');
  };
  ipcMain.handle('denarii-autosignin:status', (event) => { guard(event); return autoSignIn.status(); });
  ipcMain.handle('denarii-autosignin:enable', (event, accountId, dek) => { guard(event); return autoSignIn.enable(accountId, dek); });
  ipcMain.handle('denarii-autosignin:disable', (event, accountId) => { guard(event); return autoSignIn.disable(accountId); });
  ipcMain.handle('denarii-autosignin:tryUnlock', (event) => { guard(event); return autoSignIn.tryUnlock(); });
}

// IPC for window.denariiApp. Same caller check as the store; works with the
// database closed. app.getVersion() is package.json "version".
function registerAppIpc() {
  ipcMain.handle('denarii-app:info', (event) => {
    const url = event.senderFrame && event.senderFrame.url;
    if (!url || !isAppUrl(url)) throw new Error('Not allowed.');
    return { version: app.getVersion() };
  });
}

// ── Webull sync (electron/webull/) ───────────────────────────────────────

let webullSync = null; // scheduler: one attached page, one signed-in account
let updater = null;    // electron/updater.js; null when not packaged

// Webull calls go out from here with Node fetch; the page's CSP keeps it
// from ever reaching Webull itself.
function createWebullSync() {
  const webullStore = createWebullStore(() => database);
  const connection = createConnection({ store: webullStore, safeStorage });
  webullSync = createScheduler({
    store: webullStore,
    connection,
    accountExists: (accountId) => {
      try { return !!(kv && kv.get('auth', 'account:' + accountId)); } catch (e) { return false; }
    },
    send: (wc, channel, payload) => {
      if (!wc.isDestroyed()) wc.send(channel, payload);
    },
  });
}

// Lock and reload are page loads: drop the attachment (aborting any run and
// its unacknowledged batch) when the page navigates, crashes or closes.
function watchWebullPage(wc) {
  const detachIfAttached = () => {
    if (webullSync && webullSync.isAttached(wc)) webullSync.detach();
  };
  wc.on('did-start-navigation', (details, url, isInPlace, isMainFrame) => {
    const d = details && typeof details === 'object' ? details : {};
    const mainFrame = d.isMainFrame !== undefined ? d.isMainFrame : isMainFrame;
    const sameDocument = d.isSameDocument !== undefined ? d.isSameDocument : isInPlace;
    if (mainFrame && !sameDocument) detachIfAttached();
  });
  wc.on('render-process-gone', detachIfAttached);
  wc.on('destroyed', detachIfAttached);
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1400,
    height: 900,
    title: 'Denarii',
    icon: path.join(ROOT, 'Logos', 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Keep the window title "Denarii" instead of the page <title>.
  win.on('page-title-updated', e => e.preventDefault());

  // New windows (target=_blank, window.open): external URLs go to the
  // default browser; the app never opens a second window.
  win.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });

  // The window never leaves app://denarii/.
  win.webContents.on('will-navigate', (e, url) => {
    if (isAppUrl(url)) return;
    e.preventDefault();
    openExternal(url);
  });
  win.webContents.on('will-redirect', (e, url) => {
    if (!isAppUrl(url)) e.preventDefault();
  });

  // The page's beforeunload cancels close/reload when there are unsaved
  // changes, and Electron would then silently do nothing. Ask instead;
  // preventDefault here lets the unload go ahead.
  win.webContents.on('will-prevent-unload', (e) => {
    const i = dialog.showMessageBoxSync(win, {
      type: 'question',
      title: 'Denarii',
      message: 'You have unsaved changes. Leave anyway?',
      buttons: ['Leave', 'Stay'],
      defaultId: 1,
      cancelId: 1,
      noLink: true,
    });
    if (i === 0) e.preventDefault();
    else if (updater) updater.cancelInstall(); // Restart for an update waits for the next quit
  });

  watchWebullPage(win.webContents);
  win.loadURL(ORIGIN + '/index.html');
}

app.whenReady().then(() => {
  if (!gotInstanceLock) return; // quitting; the first copy keeps its window
  if (!openDatabaseWithDialogs()) {
    app.quit();
    return;
  }
  registerStoreIpc();
  registerAutoSignInIpc();
  registerAppIpc();
  createWebullSync();
  registerWebullIpc({
    ipcMain,
    isAppUrl,
    isOpen: () => !!kv,
    getScheduler: () => webullSync,
  });
  protocol.handle(SCHEME, serveFile);

  session.defaultSession.webRequest.onBeforeRequest({ urls: BLOCKED_URLS }, (details, callback) => {
    console.warn('[Denarii] Blocked request to', details.url);
    callback({ cancel: true });
  });

  // Deny every permission request and check (camera, microphone,
  // notifications, geolocation, etc.). The one exception is writing to the
  // clipboard, which the app's Copy buttons use (navigator.clipboard.writeText);
  // reading the clipboard stays denied.
  const ALLOWED_PERMISSIONS = new Set(['clipboard-sanitized-write']);
  session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
    callback(ALLOWED_PERMISSIONS.has(permission));
  });
  session.defaultSession.setPermissionCheckHandler((webContents, permission) => ALLOWED_PERMISSIONS.has(permission));

  buildMenu();
  createWindow();
  updater = startUpdater({
    app,
    ipcMain,
    isAppUrl,
    getWindow: () => BrowserWindow.getAllWindows()[0] || null,
  });

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Abort any Webull sync (its cursor is unchanged, so the next launch
// resumes), then checkpoint the WAL into the main file and close cleanly.
app.on('before-quit', () => {
  if (webullSync) webullSync.shutdown();
  closeDatabase();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
