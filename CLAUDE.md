# Denarii: guide for AI coding tools

Denarii is a desktop trading journal for Windows (Electron). All data stays on the user's computer. There is no server and no support; this file and `docs/` are the orientation for anyone, human or AI, changing the code. See README.md for the user-facing overview.

## Architecture

### Electron main vs page
- `electron/main.js` is the main process: creates the window, serves the app, owns dialogs, SQLite, auto sign-in, Webull sync and updates, and registers all IPC.
- `electron/preload.js` (sandboxed, contextIsolation on) exposes `window.denariiStore`, `window.denariiAutoSignIn`, `window.denariiApp`, `window.denariiWebull` and `window.denariiUpdate`. Every call returns a Promise. This is the only way the page reaches Node.
- The page is `index.html` + `Denarii.js` + `Denarii.css` + `js/**` + `vendor/**`, plain browser scripts (no bundler).
- Every IPC handler checks that the sender is the app origin before doing anything.

### app:// protocol
- The page is served from `app://denarii/`, a privileged standard + secure scheme, so `crypto.subtle` and `localStorage` work under one fixed origin.
- `electron/main.js` resolves files from the app root; some top-level folders (`electron`, `node_modules`, ...) are never served. External links open in the default browser.

### CSP
- Set as a `Content-Security-Policy` header on every `app://` response (`CSP` in `electron/main.js`).
- `'unsafe-inline'` is required for scripts and styles because of the many inline `onclick=` handlers and `style=` attributes.
- `connect-src` allows only `'self'`, `generativelanguage.googleapis.com` (Gemini) and `api.twelvedata.com`. A new outbound host from the page must be added here. Webull is never called from the page (see below).
- `BLOCKED_URLS` in main.js blocks the hosts of the earlier cloud version; leave it in place.

### SQLite storage
- `electron/db.js` (`node:sqlite`): one key-value table replacing three former IndexedDB stores, `journal`, `auth` and `settings`, plus Webull tables (schema version 2, `PRAGMA user_version`). Values are JSON text.
- File: `%APPDATA%\Denarii\denarii.sqlite`. Automatic backups and pre-restore copies go in `backups/`. Settings > Data calls `backupTo`, `restoreFrom` and `openBackupsFolder`.
- The page uses exactly six store functions in `Denarii.js`: `storeGet`, `storePut`, `storeDelete`, `storeGetAllKeys`, `getSetting`, `setSetting`. Go through them; don't call `window.denariiStore` from new code.
- Some names still say IndexedDB (e.g. `saveToIndexedDB`); they now write to SQLite.

### Encryption model and DEK
- Each account has a random 256-bit DEK (data encryption key). It encrypts the journal and the user's API keys in the page, before anything reaches SQLite.
- The DEK is wrapped by a key derived from the password and, separately, from the recovery key (`js/dek-crypto.js`; v2 = PBKDF2-SHA256 600,000 iterations + AES-256-GCM via `crypto.subtle`; v1 is read-only).
- `sessionDek` (or `sessionPassword` on legacy non-DEK accounts) lives only in page memory while signed in.
- Losing both the password and the recovery key means the data cannot be decrypted. There is no back door.

### Auto sign-in
- "Stay signed in on this computer" (`electron/auto-signin.js`) keeps one account's DEK in `auto-signin.dat`, protected by Electron `safeStorage` (Windows DPAPI).
- The file is never part of a backup. `tryUnlock` works once per app launch, so Lock (a page reload) requires the password.

### Webull sync (main process)
- Webull is called only from the main process (`electron/webull/`). `readonly.js` is the only client: a frozen allowlist of read routes plus the two token POSTs. It never places, changes or cancels orders. `npm run check:webull` enforces this.
- Credentials and token are `safeStorage` blobs in SQLite (`connection.js`, `store.js`). They never return to the page.
- `scheduler.js` syncs when a page attaches, then every 15 minutes, in 90-day windows. Each window goes to the page as a batch.
- Page side: `js/services/webull-sync.js` `applyBatch` turns fills into trades for one journal, saves locally, and only then acknowledges the batch. The main-process cursor moves only after the ack. It never deletes trades and only changes `source: 'webull'` trades in the target journal.
- Webull API approval lasts about 15 days; the user re-approves through the app.

### AI service and fallback
- `js/services/ai/index.js` exposes `window.DenAriiAI`. `formatter.js` shapes trades, `prompts.js` holds prompts, and `gemini.js` is the provider.
- Only the user's own Gemini key is used (stored encrypted, per account, in the settings store). There is no built-in key or proxy: `AI_DEFAULT_PROXY` is `false` in `js/config/config.js`, so `_callProxy` is dormant.
- `callWithFallback` retries once on the fallback model when the chosen model is busy (HTTP 429/503) or times out. It never loops.

### Dormant cloud code
`js/supabase-auth.js`, `js/services/cloud-check.js` and cloud branches in `js/auth.js` / `Denarii.js` come from an earlier cloud version. `js/config/config.js` leaves the cloud URL and key empty, so these paths never run. Do not enable them, and do not add network calls to any hosted backend.

## Data-safety rules
- Never lose or silently overwrite user data. Storage format changes need a migration (`SCHEMA_MIGRATIONS` in Denarii.js for journal data, `migrate` in `electron/db.js` for SQLite) and tests.
- Don't change the encryption, DEK wrapping, or auto sign-in format without a read path for existing data.
- Never log or display API keys, secrets, tokens, passwords or the DEK.
- Webull stays read-only. Any change to `ROUTES`/`ALLOWLIST` in `electron/webull/readonly.js` needs explicit review.
- Restore always keeps a pre-restore copy; keep it that way.
- Legal text lives in `js/legal-bundle.js`. Changing it means bumping `LEGAL_BUNDLE_VERSION`, which makes every user accept again.
- The app must not phone home. Anything sent off the computer goes only to a service the user configured with their own key.

## Running and testing
- `npm install`, then `npm start` to run.
- `npm test` runs every `tests/**/*.test.js` with `node --test`. Most tests cut real functions out of the browser scripts (see the harness in `tests/batch-d3.test.js`) or load main-process modules with fakes. Keep the suite passing.
- Focused runs: `npm run test:webull`, `npm run test:db`, `npm run test:filters`; `npm run check:webull` checks the Webull read-only rules.
- `npm run dist` builds the NSIS installer into `dist/` (electron-builder, config in package.json `build`). Releases are published to GitHub Releases, which `electron/updater.js` checks.

## Docs
`docs/` holds design notes and plans:
- `MAKING-CHANGES.md`: guide for users who want to change Denarii for themselves
- `webull-local-plan.md`: Webull in the desktop app
- `webull-sync-plan.md`, `webull-phase3-plan.md`: Webull mapping background (written for the cloud version)
- `packaging-plan.md`: installer, updates, release steps
- `local-cleanup-audit.md`: known wording, behavior and CSP items
- `theme-token-spec.md`, `help-section-plan.md`
- `legal-draft-local.md`: draft legal text

Some older plans describe the earlier cloud version; the code is the source of truth.
