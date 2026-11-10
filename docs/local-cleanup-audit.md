# Denarii Local: cleanup audit before release testing

Read-only audit, 2026-11-09. No files were changed during the audit.

Checks: folder `C:\Denarii_Local`; only remote `origin` → `github.com/mountytechWV/Denarii-local.git`.

`js/config/config.js` has an empty Supabase URL and key, so `SupabaseAuth.isConfigured()` is false. Every cloud login, restore, migration and save path in auth.js is unreachable. The tables below separate text users can actually see from text in that unused code.

Most urgent item: closing the window may do nothing in some cases (C4). The weekly "export a backup" close warning probably blocks the window from closing with no dialog. Not confirmed (the app was not run).

## A. Cloud leftovers users can see

| file:line | Current | Proposed |
|---|---|---|
| index.html:99 | "Your journal is saved to your Denarii cloud account, with a backup copy kept in this browser." | "Your journal is saved on this computer, encrypted with your password." |
| index.html:101-104 (registration email), :59-61 (login email), :81-82 ("New Device") | Email field, "Required for cloud account features." | **No change needed.** Only shown when Supabase is configured (auth.js:153-163), so never in Local. |
| index.html:213 | "View and remove accounts stored in this browser." | "…stored on this computer." |
| auth.js:1715, :1764 | "No accounts found in this browser." | "…on this computer." |
| auth.js:1743 | confirm: "…all its journal data from this browser…" | "…from this computer…" and point to Settings → Data for backup |
| auth.js:1982, :2260 | "No journal found for that username in this browser." | "…on this computer." |
| index.html:723, :940 | tooltips: "save automatically to your browser" | "…save automatically on this computer" |
| index.html:1704 + panel :1988-1999 + modal :2412-2421 | Settings → **Conflict Copies** | **Hide** the nav button (and panel). Copies are only created by cloud paths (`_recordCloudConflict`). Keep the code. |
| index.html:2163 | Help bullet "Conflict Copies: if an item was changed on another device…" | Remove |
| settings.js:659 (shown via :687/:694 every time Integrations opens), :769-771 | Webull heading, OpenAPI instructions, red "Sign in to your cloud account to connect Webull." | Skip the status request and render "Webull sync isn't available in this version yet." in muted text, with no OpenAPI paragraph |
| broker-accounts.js:992 (shown at :1275 as `alert-danger`) | "Sign in to your cloud account to link Webull." | "Webull sync isn't available in this version yet.", shown as muted text, not a red alert. (:997/:998 only run in cloud mode.) |
| index.html:2037-2038 + sections ~2262-2307 | Help topics "Connect Webull" and "Webull Sync & Auto-Import" | Hide both topics, or replace with one line saying it isn't available yet |
| index.html:2089 | "Webull trades can also sync automatically (see…)" | Remove that sentence |
| index.html:2049 | Overview: "saved to your Denarii cloud account… copy kept in your browser" | "Your journal is stored only on this computer, encrypted with your password." |
| index.html:2057 | "Register with your email, a username and a password." | "Choose a username and a password." |
| index.html:2058-2059 | "Sign In on a New Device…" | Replace with "Moving to another computer: Settings → Data → Back up, then Restore on the new one." |
| index.html:2063 | "Your journal is saved to your account; sign back in…" | "Your journal stays on this computer; sign back in…" |
| index.html:2155 | Theme "saved to your account, so it follows you to other devices" | "Your choice is saved on this computer." |
| index.html:1956, 2199, 2215, 2219, 2225, 2258, 2334 | "Built-in/default Gemini key", "reverts to the built-in default key", "stored encrypted in your account and works on any device", "shared default key" | There's no built-in key in Local (`AI_DEFAULT_PROXY=false`; gemini.js:545 says "No Gemini API key configured"). Say "AI features need your own Gemini API key", "Removing the key turns AI features off", "stored encrypted on this computer", and drop the shared-key clause. |
| settings.js:465-468 | "recovery key synced / re-synced", "…only restore data from the last sync point" | "Password updated and recovery key updated." Reword the "last sync point" note after confirming what it means (it's on the legacy-account branch). |
| js/legal-bundle.js:21 (EULA/Privacy) | "cloud-based trading journal", Supabase, Vercel, "sync between devices", IndexedDB/local storage | Needs a separate legal rewrite. Changing it should bump `LEGAL_BUNDLE_VERSION` (legal-bundle.js:5), which makes users accept again. Required before release but shouldn't go into a wording pass. |

## B. Outdated wording

| file:line | Current | Proposed |
|---|---|---|
| index.html:284-298 (shown on Lock if >24h, auth.js:2547) | "Export Your Denarii Backup?", "auto-saved in the browser", **Export Backup Now** (JSON) | "Back up your data?" / "Your data is saved on this computer. A backup protects it if this computer fails." Button "Back up now" calls `backupAllData()`. **Behavior catch:** only the JSON export sets `lastBackup` (Denarii.js:361), so the .sqlite backup must also set it or the reminder never stops. |
| index.html:2064-2065 | "Export a Backup… click Export Backup" | "Back Up Your Data: Settings → Data → Back up all data (.sqlite). Export journal (JSON) in the profile menu is an extra copy of one account." |
| index.html:2310-2324 | "saved to your cloud account automatically", "Export Backup", "Before clearing browser data" | Rewrite around the Settings → Data buttons (Back up, Restore, Open backups folder). Use "Before reinstalling or moving to a new computer". Restore is Settings → Data for the whole app, or "Recover from Backup" on the login screen for JSON. |
| js/nav.js:358 | Command palette "Export Backup" | "Export journal (JSON)" to match the profile menu (index.html:613). Optionally add "Back up all data". |
| Denarii.js:585 | alert "…(Profile → Export Backup)…" | "…(Settings → Data → Back up all data)…" |
| Denarii.js:366 | "File saved to your Downloads folder." | Check where Electron actually saves it, then match the text |
| Denarii.js:2446 | "You haven't exported a backup in over a week…" | See C4 |
| index.html:2128, editor-toolbar.js:116 | "your browser's built-in speech-to-text… Chrome and Edge work best" / "not supported in this browser" | "Dictation uses the system's speech-to-text…" / "isn't available on this computer". Also check in testing whether dictation works in Electron at all. |

## C. Behavior items

| Item | Where | Proposal |
|---|---|---|
| C1. Import asks for a password on unencrypted files | Denarii.js:191 | **Detect:** `fileData.encrypted === true`. `exportBackup` always sets it (Denarii.js:337); anything else is plain JSON. **Can't simply skip the prompt:** the password is used later. It becomes `sessionPassword` (:255) for every later save, and on the no-auth branch it becomes the new account's password hash (~:294). **Proposal:** for unencrypted files, ignore `fileData.auth` (it's untrusted, and if it describes a DEK account the session would be inconsistent). Then prompt "Create a password for this journal" with confirm and the 8-character minimum from registration, and use the file's username as the suggested name. Note this branch creates a legacy (non-DEK) account, so auto sign-in will say "older encryption format". |
| C2. "Signing in…" flashes on every launch | auth.js:197 | Before showing the text, call `status()` and return early if there's no `accountId`. **But** `status()` (electron/auto-signin.js:109-112) doesn't know the once-per-launch `used` flag, so after Lock (a reload) it would still flash. **Recommended:** add `used` to `status()`'s return value and show the text only when `accountId && !used`. A 300 ms delayed-show timer is a simpler fallback. |
| C3. TradingView credit | Chart created at stock-chart.js:420 into `#tradingview-chart` (index.html:2644). Footer note at :2646-2648. | v4.1.1 has no built-in `attributionLogo` option. Smallest compliant credit: add `Charts by <a href="https://www.tradingview.com/" target="_blank" rel="noopener noreferrer">TradingView</a>` to the :2647 footer. main.js:337-341 already sends `_blank` links to the default browser. Also add a `NOTICE` next to `vendor/lightweight-charts/4.1.1/LICENSE` (only LICENSE is there now), and ideally a line in Help → Legal. |
| C4. Close warning may block closing (extra, likely) | Denarii.js:2440-2447, electron/main.js | The `beforeunload` handler calls `preventDefault()` for unsaved changes and for "no JSON export in 7 days". main.js has no `will-prevent-unload` handler, and Electron cancels the close silently in that case. Confirm in testing, then either remove the weekly guard or handle `will-prevent-unload` with a native dialog. |

## D. tests/ai-trim.test.js

What it tests: the Reflection Patterns page and AI Insight widget were removed, and the other AI features (Trade AI Analysis, Run AI, Prompt Library, Saved Reports, the `.ai-insight-*` CSS) are still present.

Why it fails: line 15 reads `dev.html` when the file loads (ENOENT), so all 12 tests fail together as one error. `dev.html` is only used in one assertion (`!DEV.includes('ai-insight.js')`).

A scratch copy (outside the repo) with `dev.html` swapped for `index.html` **passes 12/12**.

**Recommendation:** keep the test but delete the `DEV` constant and that one assertion, rather than pointing it at index.html. The previous assertion already checks index.html, so a second copy would add nothing.

## E. Housekeeping

| file:line | Current | Proposed |
|---|---|---|
| js/config/config.js:3-9 | Gemini comment about the Vercel env var and `/api/ai-query` | One line: "Local: no AI server proxy; AI uses only the user's own key." |
| js/config/config.js:12 | "set these to your project values to enable cloud auth" | "Left empty in Denarii Local; cloud code stays dormant." |
| config.example.js (repo root) | Vercel proxy notes, "Denarii.html", `AI_DEFAULT_PROXY: true` | Rewrite to match config.js (`false`, empty Supabase values) or delete. As written, copying it turns the proxy back on. |
| editor-toolbar.js:54 | "before prompt() steals focus (Safari)" | "before the prompt modal takes focus" |
| dek-crypto.js | sha256/file:// comment | **Not found.** No `file://` text anywhere in js/. The SHA-256 comments (:7, 13, 40, 92-94, 152) are accurate. Nothing to change. |
| IndexedDB comments | 43 comment lines in js/ and Denarii.js, e.g. Denarii.js:95 "IndexedDB setup", auth.js:2157 | Fix comments in code that actually runs. Leave cloud-code comments and the `saveToIndexedDB`/`loadFromIndexedDB` names alone. |
| Denarii.js:96-97 | `DB_NAME`, `DB_VERSION` | Remove; they're defined and never referenced |
| Denarii.js:8457, :8576 | `tmEdInsertLink`, `jnlInsertLink` | Delete; nothing references them. Keep `_jnlContrastColor` between them, which is used. |
| auth.js ~1645 `window.prompt` fallback | — | **Doesn't exist.** :1645 is registration record code, and there are no `window.prompt` calls in index.html, Denarii.js or js/. Nothing can run. |

## F. Content-Security-Policy

| Measure | Count |
|---|---|
| Inline `<script>` | 1 (index.html:7-13, the theme pre-paint) |
| Inline handlers (`onclick=` etc.) | 280 in index.html, plus about 228 in HTML built by JS |
| `style="…"` | 581 in index.html, plus about 603 in JS strings (and 390 `.style` assignments, which CSP allows) |
| eval / `new Function` | None in app code. Plotly only uses `new Function("return this")` inside a try/catch fallback, so `'unsafe-eval'` isn't needed. |
| External hosts in code | `generativelanguage.googleapis.com`, `api.twelvedata.com` |

A strict CSP isn't practical now: with about 500 inline handlers, `script-src` needs `'unsafe-inline'`. A policy that still locks down origins is practical today:

```
default-src 'self'; script-src 'self' 'unsafe-inline'; style-src 'self' 'unsafe-inline';
img-src 'self' data: blob:; font-src 'self';
connect-src 'self' https://generativelanguage.googleapis.com https://api.twelvedata.com;
object-src 'none'; base-uri 'none'; form-action 'none'; frame-src 'none'; worker-src 'self' blob:
```

**Where to set it:** as a `Content-Security-Policy` response header where electron/main.js builds its `app://denarii` protocol responses. `app://` is a privileged standard scheme (main.js:50), so `'self'` resolves. A `<meta>` tag as the first element in `<head>` also works but is easier to lose.

**Later:** move the inline script to a file and convert handlers to delegated listeners, then drop `'unsafe-inline'` from `script-src`. Styles can keep it.

## Leave alone

- **Code that never runs in Local:** cloud strings in auth.js (restore, migration, rename/delete "needs a connection to your cloud data", "Signing in to cloud…"), Denarii.js:623/629/1497-1655/7423/7680, demoSeed.js:176, journal.js:453, the planner/review "Updated on another device" messages, cloud-check.js and webull-sync.js. They can't run while Supabase isn't configured, and cloud logic stays by decision.
- **Migration overlay** (index.html:27-38): only shown for `storageMode === 'migration_pending'`.
- **Registration/login email fields and "New Device":** hidden unless Supabase is configured.
- **index.html:2003** "USB drive or cloud folder": refers to the user's own Dropbox or OneDrive, which is fine.
- **index.html:346** "No auto-sync is used.": true as written.
- **index.html:6** `<title>`: main.js keeps the window title as "Denarii".
- **Pelosi sample data and the Webull section itself:** per decisions already made.

## Suggested implementation prompts

1. **Wording pass (text and markup only):** all of A except the legal bundle, and all of B except the reminder modal's backup behavior. Covers hiding Conflict Copies and the Webull help topics, the Webull "isn't available yet" messages in both places, the Gemini wording, and nav.js plus the Denarii.js:585 alert.
2. **Behavior fixes, then tests:** C1 import password, C2 `status()` with `used`, C3 TradingView credit and NOTICE, the reminder modal using the .sqlite backup and setting `lastBackup`, C4 close blocking, and D (drop the dev.html line). Run `node --test` afterwards.
3. **Housekeeping and CSP:** the E items (comments, config files, unused constants and link functions), then the `'unsafe-inline'` CSP header in the protocol handler, followed by a click-through of AI, charts, Plotly and import/export.

Separately: the legal-bundle rewrite needs the owner's legal wording and the `LEGAL_BUNDLE_VERSION` bump, so keep it out of these three prompts.
