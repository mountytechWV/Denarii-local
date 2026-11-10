// Automatic updates from GitHub Releases (electron-updater), packaged app
// only; npm start never checks. Downloads in the background, then tells the
// page (denarii-update:ready { version }) so it can offer a restart. Every
// failure (offline, private repo 404, bad download) is only logged and the
// next check retries. See docs/packaging-plan.md section 6.
//
// Restart closes the window first, so the page's unsaved-changes prompt
// runs before anything is installed: "Stay" cancels the restart and nothing
// is lost; the update then installs on the next normal quit
// (autoInstallOnAppQuit).

const FIRST_CHECK_MS = 30 * 1000;
const CHECK_EVERY_MS = 4 * 60 * 60 * 1000;
const READY = 'denarii-update:ready';
const INSTALL = 'denarii-update:install';

const log = (...args) => console.log('[Denarii] Updater:', ...args);

// deps: { app, ipcMain, isAppUrl, getWindow, autoUpdater?, setTimeout?, setInterval? }
// Returns null when skipped, else { cancelInstall }.
function startUpdater(deps) {
  const { app, ipcMain, isAppUrl, getWindow } = deps;
  if (!app.isPackaged) return null;
  const setTimeoutFn = deps.setTimeout || setTimeout;
  const setIntervalFn = deps.setInterval || setInterval;

  let autoUpdater;
  try {
    autoUpdater = deps.autoUpdater || require('electron-updater').autoUpdater;
  } catch (e) {
    log('not available:', e && e.message);
    return null;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowPrerelease = false;
  autoUpdater.allowDowngrade = false;
  autoUpdater.logger = { info: log, warn: log, error: log, debug: () => {} };

  let readyVersion = null;   // set once an update is downloaded
  let installPending = false; // Restart clicked; waiting for the window to close
  const watched = new WeakSet();

  autoUpdater.on('error', (e) => log('error:', e && e.message ? e.message : e));

  const send = () => {
    const win = getWindow();
    if (!readyVersion || !win || win.isDestroyed() || win.webContents.isDestroyed()) return;
    win.webContents.send(READY, { version: readyVersion });
  };

  autoUpdater.on('update-downloaded', (info) => {
    readyVersion = String((info && info.version) || '');
    log('update downloaded:', readyVersion);
    send();
    // Lock and reload start a new page; tell it again.
    const win = getWindow();
    if (win && !win.isDestroyed() && !watched.has(win.webContents)) {
      watched.add(win.webContents);
      win.webContents.on('did-finish-load', send);
    }
  });

  const check = () => {
    try {
      Promise.resolve(autoUpdater.checkForUpdates()).catch((e) => log('check failed:', e && e.message ? e.message : e));
    } catch (e) {
      log('check failed:', e && e.message ? e.message : e);
    }
  };
  setTimeoutFn(() => {
    check();
    setIntervalFn(check, CHECK_EVERY_MS);
  }, FIRST_CHECK_MS);

  // Silent install, then the app starts again.
  const quitAndInstall = () => {
    try {
      autoUpdater.quitAndInstall(true, true);
    } catch (e) {
      log('install failed:', e && e.message ? e.message : e);
    }
  };

  // All windows closed and the app is quitting: install now if Restart was
  // clicked. Without it, autoInstallOnAppQuit installs without relaunching.
  app.on('will-quit', () => {
    if (!installPending) return;
    installPending = false;
    quitAndInstall();
  });

  ipcMain.handle(INSTALL, (event) => {
    const url = event.senderFrame && event.senderFrame.url;
    if (!url || !isAppUrl(url)) throw new Error('Not allowed.');
    if (!readyVersion) return { ok: false };
    const win = getWindow();
    if (!win || win.isDestroyed()) {
      quitAndInstall();
      return { ok: true };
    }
    installPending = true;
    win.close();
    return { ok: true };
  });

  return {
    // The unsaved-changes dialog kept the window open.
    cancelInstall: () => { installPending = false; },
  };
}

module.exports = { startUpdater, READY, INSTALL, FIRST_CHECK_MS, CHECK_EVERY_MS };
