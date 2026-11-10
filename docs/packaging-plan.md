# Packaging plan: Windows installer with automatic updates

Plan only. Denarii Local is built into a Windows NSIS installer with electron-builder and updated automatically from GitHub Releases on mountytechWV/Denarii-local.

Decisions already made:
- Windows only for 1.0, with electron-builder's NSIS installer (per-user install, no admin needed, the user can choose the folder)
- Unsigned; the Windows SmartScreen "More info > Run anyway" step is documented
- productName stays exactly "Denarii", so userData stays %APPDATA%\Denarii and existing data is found
- Version 1.0.0 for the first release
- License field GPL-3.0-or-later
- Automatic updates via electron-updater from GitHub Releases on mountytechWV/Denarii-local. They only work once the repo is public and must fail silently until then.
- Uninstall never deletes %APPDATA%\Denarii (user data and backups)

Note: the footer string is `'Denarii vB.004.000'` with a **B**, not `v8.004.000` (`Denarii.js:106`). The build is `'2026.05.17.1'` (`Denarii.js:107`).

---

## 1. package.json changes

```jsonc
{
  "private": true,                      // keep: stops an accidental npm publish
  "name": "denarii-local",              // npm names must be lowercase; package-lock currently says "Denarii_Local"
  "productName": "Denarii",             // exactly this, so data stays in %APPDATA%\Denarii
  "version": "1.0.0",                   // missing today, so app.getVersion() falls back to Electron's version
  "description": "Denarii trading journal - desktop (local) edition",
  "author": "mountytechWV",             // electron-builder uses this as the publisher / CompanyName
  "license": "GPL-3.0-or-later",
  "main": "electron/main.js",           // unchanged
  "scripts": { /* existing scripts */, "dist": "electron-builder --win nsis --x64 --publish never" },
  "dependencies": { "electron-updater": "<pinned exact version>" },  // the first runtime dependency
  "devDependencies": { /* unchanged; electron 45.2.3 and electron-builder 26.18.0 are already here */ },
  "build": {
    "appId": "com.mountytechwv.denarii",   // never change after 1.0 (it sets the install identity and AppUserModelId)
    "productName": "Denarii",
    "copyright": "Copyright © 2026 mountytechWV",
    "asar": true,
    "npmRebuild": false,                   // no native modules
    "directories": { "output": "dist", "buildResources": "build" },
    "files": [ /* see section 2 */ ],
    "win": { "target": [{ "target": "nsis", "arch": ["x64"] }], "icon": "build/icon.ico" },
    "nsis": { /* see section 5 */ },
    "publish": [{ "provider": "github", "owner": "mountytechWV", "repo": "Denarii-local", "releaseType": "release" }]
  }
}
```

Other changes that come with this:
- `package-lock.json` gets regenerated (new name, version and electron-updater).
- `.gitignore` gets `dist/`.
- A GPL-3.0 `LICENSE` file is added. The repo has none today.

## 2. Included and excluded files

Use an allowlist rather than a blocklist, so new dev files stay out by default:

```json
"files": [
  "package.json", "index.html", "Denarii.js", "Denarii.css", "manifest.json", "favicon.ico",
  "Logos/**", "js/**", "vendor/**", "electron/**"
]
```

- **Included:** `js/config/config.js` (tracked and loaded at `index.html:2768`), `js/demo-bundle.js`, the `electron/webull/*` files, and the vendor LICENSE and NOTICE files.
- **Excluded by not being listed:**
  - `tests/`, `docs/`, `api/`, `supabase/`, `scripts/` (`vendor.js`, `webull-probe.js`, `check-webull-readonly.js`)
  - `.claude/`, `CLAUDE.md`, `config.example.js`, `_generate-demo-bundle.js`, `vercel.json`, `.vercelignore`
  - `build/` and `dist/`
- **node_modules:** electron-builder packs only production `dependencies`, which will be electron-updater and its dependencies. Every current devDependency is already copied into `vendor/` by `scripts/vendor.js`, so none of them are needed at runtime.

## 3. Packaged-app compatibility findings

- **node:sqlite:** `electron/db.js:18` uses `require('node:sqlite')`, which is built into Electron 45's Node. There's no native addon, so asar and rebuild issues don't apply. The database lives in userData, outside the package.
- **vendor/:** all files are plain JS, CSS, woff2 or license files served through `app://`. They need no changes.
- **Paths:**
  - `ROOT = path.join(__dirname, '..')` (`main.js:22`) points to `resources\app.asar` once packaged.
  - `resolveFile` serves files with `net.fetch(pathToFileURL(file))`. Electron's `file:` loader can read inside asar, so this should work unchanged, but it's the one path to verify first in the packaged build.
  - The containment check (`startsWith(ROOT + sep)`) still holds.
  - `HIDDEN_DIRS` stays correct; those folders are simply missing from the package.
- **Window icon:** `path.join(ROOT, 'Logos', 'icon-512.png')` loads from inside the asar, which is fine. The taskbar and shortcuts use the exe icon anyway.
- **No other repo-layout assumptions:** `electron/` uses only `__dirname`-relative `require`s. There's no `process.cwd()` and nothing reads from the repo at runtime.
- **Single instance:** the lock is per app name, so a dev copy (`npm start`) and the installed copy block each other. That's good, because both use the same database.
- **before-quit:** `closeDatabase()` runs when electron-updater's `quitAndInstall()` quits the app, so the WAL file is checkpointed before the installer replaces files.

## 4. Icon

- **What exists:** `favicon.ico` (sizes not checked; probably 16–48 px only), `Logos/icon-512.png`, `icon-192.png`, `favicon-16.png`, `favicon-32.png`, `apple-touch-icon.png` and `denarii-logo-new.png`.
- **What electron-builder needs:** a Windows `.ico` that includes a 256×256 layer.
- **How to make it:** run once, by hand, and commit the result as `build/icon.ico`:
  `magick Logos/icon-512.png -define icon:auto-resize=256,128,64,48,32,24,16 build/icon.ico`
  Any online ICO converter works too if ImageMagick isn't installed.
- **Fallback:** point `win.icon` at `Logos/icon-512.png` and let electron-builder convert it. An explicit `.ico` is easier to predict.

## 5. NSIS settings

```json
"nsis": {
  "oneClick": false,
  "perMachine": false,
  "allowElevation": false,
  "allowToChangeInstallationDirectory": true,
  "createDesktopShortcut": true,
  "createStartMenuShortcut": true,
  "shortcutName": "Denarii",
  "uninstallDisplayName": "Denarii",
  "runAfterFinish": true,
  "deleteAppDataOnUninstall": false,
  "artifactName": "Denarii-Setup-${version}.${ext}",
  "include": "build/installer.nsh"
}
```

- **Per-user only:** with `oneClick:false` and `perMachine:false`, NSIS normally shows a "Just me / All users" page. To always install per-user with no admin prompt, `build/installer.nsh` contains:
  `!macro customInstallMode` / `StrCpy $isForceCurrentInstall "1"` / `!macroend`
- **Default folder:** `%LOCALAPPDATA%\Programs\Denarii`.
- **`deleteAppDataOnUninstall`:** false is already the default, but set it explicitly. `true` would delete `%APPDATA%\Denarii`, which is exactly the user's data folder.
- **`artifactName`:** must have no spaces. GitHub turns spaces in asset names into dots, which would break the file name `latest.yml` points to.

## 6. Auto-update design

This is a new module, `electron/updater.js`, called from `app.whenReady()` after `createWindow()`.

- **Guard:** skip the updater entirely when `!app.isPackaged`, so `npm start` never checks.
- **Setup:**
  - `autoUpdater.autoDownload = true`
  - `autoInstallOnAppQuit = true`
  - `allowPrerelease = false`
  - `allowDowngrade = false`
  - `logger`: a small wrapper that only calls `console.log`
- **When it checks:** about 30 s after launch, then every 4 hours with `setInterval`. Each check is `autoUpdater.checkForUpdates().catch(log)`.
- **Silent failure:**
  - The `'error'` event and the rejected promise are only logged.
  - While the repo is private, GitHub returns 404; offline you get DNS or timeout errors. In both cases nothing is shown and the next check just retries.
  - `checkForUpdatesAndNotify` is not used.
- **Telling the user:**
  - On `'update-downloaded'`, main sends `denarii-update:ready {version}` to the window.
  - The preload exposes `denariiUpdate.onReady(cb)` and `denariiUpdate.install()`.
  - The page shows a small non-blocking banner: "Update ready – restart to install" with **Restart** and **Later** buttons.
  - Restart calls `autoUpdater.quitAndInstall(true, true)`: a silent install, then the app relaunches.
  - Later means it installs on the next normal quit.
  - The IPC uses the same `isAppUrl` sender guard as the other handlers.
- **Unsaved changes:** if the existing "unsaved changes" dialog cancels the quit, the update simply installs on the next quit.
- **Data is untouched:** the installer only replaces files in the install folder. `%APPDATA%\Denarii` (the database, backups, auto-sign-in file and Webull secrets) is never written by the installer. safeStorage (DPAPI) is tied to the Windows user, not the exe, so auto sign-in and Webull keys still decrypt after an update.
- **Signature check:** the build is unsigned and has no `publisherName`, so electron-updater skips Windows signature verification (it logs a warning). The download is still checked against the sha512 in `latest.yml`.
- **Blocked hosts:** the update requests come from the main process, and the blocked hosts only cover Supabase and Vercel, so GitHub is not affected.

## 7. Database upgrade and backup on first launch after an update

This is the existing logic in `openDatabaseWithDialogs()`; nothing new is needed:
- **Schema newer than the file:** `store.openDatabase` takes a pre-migration backup and then upgrades (`r.migratedFrom`), and the regular automatic backup is skipped for that launch.
- **Same schema:** the normal `store.autoBackup` runs.
- **Downgrade** (reinstalling an older version over newer data): the "saved by a newer Denarii" dialog appears, offering only Quit, and nothing is changed. That's the correct behaviour, and it's why `allowDowngrade` stays false.

## 8. Version display

- Main adds `ipcMain.handle('denarii-app:info', guard → { version: app.getVersion() })`, which reads `package.json` version in both dev and packaged builds.
- The preload exposes `denariiApp.getInfo()`.
- `Denarii.js:736` becomes `'Denarii v' + info.version`. It falls back to the `APP_VERSION` constant when `window.denariiApp` is missing (tests or a browser).
- Remove the `Build …` line, or show `Build <version>`. Nothing else produces a build number worth showing.
- **Watch out:** `APP_VERSION` is also written as `legalAcceptedAppVersion` (`js/auth.js:1642`, `2530`). A search showed it's only stored, never compared, but keep that constant or decide on purpose whether the stored value should change.

## 9. Build and release steps

1. Bump `version` in package.json and commit.
2. `npm ci`, then `npm run dist`.
3. The build writes these files to `dist/`:
   - `Denarii-Setup-1.0.0.exe`
   - `Denarii-Setup-1.0.0.exe.blockmap`
   - `latest.yml`
   - `win-unpacked/` (for quick testing)
4. On GitHub (mountytechWV/Denarii-local), go to Releases → **Draft new release**:
   - Tag `v1.0.0` (it must match the version) on main.
   - Upload the **exe, the .blockmap and latest.yml**. All three are required.
   - Publish as a normal release, not a draft or pre-release. electron-updater ignores drafts, and with `allowPrerelease=false` it ignores pre-releases too.
5. Updates only start working once the repo is public. Until then, installs fall back silently (section 6).
6. Release notes should include the SmartScreen step: **"Windows protected your PC" → More info → Run anyway**.

## 10. Test 2 additions

1. **Clean install:** on a second Windows account or PC, run the installer, confirm SmartScreen shows the More info → Run anyway path, and confirm there's no admin (UAC) prompt.
2. **Folder choice:** choose a custom folder and confirm both shortcuts (desktop and Start menu) are created with the Denarii icon.
3. **Data location:**
   - Confirm data is created in `%APPDATA%\Denarii`.
   - Confirm Settings shows the database path there, and the footer reads `Denarii v1.0.0`.
   - Confirm there's nothing under the install folder except the program.
4. **Existing data:** on the dev PC, the installed app opens the data already there.
5. **Packaged app loading:** all pages, charts (Plotly and lightweight-charts), fonts, Markdown and AI rendering load. No `app://` 404s in DevTools.
6. **Second instance:** launching again while the app is open focuses the existing window. With the dev copy running, the installed copy doesn't open a second window.
7. **Uninstall and reinstall:**
   - Uninstall: `%APPDATA%\Denarii` and its backups are still there.
   - Reinstall: the same data opens, and auto sign-in and Webull still work.
8. **Update test:**
   - Publish 1.0.1 (only a version bump) to a test repo, or to the real one once it's public.
   - With 1.0.0 running, the banner appears within about 30 s.
   - Restart installs silently and relaunches.
   - The footer shows 1.0.1, the data is unchanged, and a new automatic backup appears.
9. **Silent failure:** run while offline, and with the repo still private. No dialogs or errors appear; there's only a log line.
10. **Later:** dismiss the banner, quit normally and relaunch. The app is now 1.0.1.
11. **Downgrade:** a 1.0.1 build with a schema bump, then reinstall 1.0.0. The "newer Denarii" dialog appears and the data is untouched. This is optional.
12. **Second PC:** restore a backup made on another PC. The app asks for the password, and anything protected by safeStorage on the other machine has to be set up again.

## 11. Risks

- **asar + `net.fetch(file:)`:** very likely fine, but it's the one runtime path that changes. Test it first with `win-unpacked`. The fallback is `asarUnpack` for the web files, or `asar: false`.
- **SmartScreen:** an unsigned exe gets warned about until it builds reputation, and some antivirus tools flag unsigned NSIS installers. Silent in-app updates usually aren't prompted, since there's no Mark-of-the-Web, but this isn't guaranteed.
- **appId and productName are permanent:** changing either later breaks updates, shortcuts or where data is found.
- **latest.yml and asset names:**
  - A missing `latest.yml`, a renamed asset, or a tag that doesn't match the version means users silently get no updates.
  - Publishing a release by mistake pushes it to everyone.
- **Private repo:** updates don't work at all until it's public, and nobody gets an error, so it's easy to forget.
- **Unverified publisher:** anyone who can publish a release on that repo can push code to every install. Use 2FA on the account and keep repo write access small.
- **GPL-3.0:** distributing binaries means providing the source (the public repo covers that once it's public) and including the license text.
- **Package and memory size:** Plotly makes it a large download (expect roughly 100 MB+ installed). Differential updates via the blockmap help.
- **Version-label coupling:** check before touching `APP_VERSION`, because `legalAcceptedAppVersion` uses it.
- **The DevTools menu still ships.** That's acceptable for 1.0, but it's a choice to make on purpose.

## 12. Suggested split into implementation prompts

1. **P1 – Package metadata and build config:**
   - The package.json fields and `build` block (with publish config), `files` allowlist, `dist` script and `.gitignore` `dist/`.
   - `npm i -E electron-updater` and the lockfile.
   - A `LICENSE` file.
   - No code changes.
2. **P2 – Icon and NSIS:** `build/icon.ico` made from `icon-512.png`, `build/installer.nsh` that forces per-user, and the NSIS options. Then a first `npm run dist` and a smoke test of `win-unpacked` and the installer, including the asar check.
3. **P3 – Version display:** the `denarii-app:info` IPC, the preload `denariiApp`, and the footer reading the version at runtime with a fallback, plus a unit test.
4. **P4 – Auto-update:** `electron/updater.js`, the `denarii-update:*` IPC and preload, the in-page banner, and the packaged-only guard. Tests that use a mocked autoUpdater to cover silent errors and the banner.
5. **P5 – Release docs and Test 2:** the manual release checklist (an addition to `docs/`), the SmartScreen note, and running the Test 2 items above, including the 1.0.0 → 1.0.1 update.
