# Webull auto-sync for Denarii Local: plan

Status: plan only, with no implementation yet (2026-11-10).

Brings Webull sync into Denarii Local, replacing the cloud version's Vercel/Supabase server code with the Electron main process.

## 1. What's in api/ today and what replaces it

| File | Size | What it does | Replacement |
|---|---|---|---|
| `api/webull.js` | 37.7 KB, 912 lines | One Vercel endpoint with 7 actions: `connect`, `check_approval`, `resend_code`, `status`, `disconnect`, `sync`, `commit` | Split up, below |
| ↳ connect / check_approval / resend_code | | Create Token, then the user approves by text code in the Webull app; Check Token; Account List | `electron/webull/connection.js`. The logic and fixed messages are lifted almost as-is; the Supabase calls become SQLite |
| ↳ status / disconnect | | Read or delete `broker_credentials` | Same module, using the SQLite `webull_connection` table |
| ↳ sync helpers (`computeWindow`, `normalizeOrder`, `collectPage`, `parseAccounts`, `parseExpiresAt`) | | Windows of up to 90 days, paging, and an allowlist of order fields (drops `account_number`) | `electron/webull/fetch.js`, moved unchanged |
| ↳ commit | | Moves the watermark forward only after the client has saved | `ackBatch` IPC that updates the SQLite `webull_link` row |
| ↳ request handling, Supabase JWT check, cooldown PATCH claims, `SYNC_LIMITS` time budget, `maxPages` | | Vercel 30 s limit, multiple tabs, multiple users | **Dropped** (cloud-only). Cooldowns become simple in-memory timestamps in main |
| `api/_lib/webull-sign.js` | 4.9 KB | HMAC-SHA256 signing (pure) | Copied unchanged to `electron/webull/sign.js` |
| `api/_lib/webull-readonly.js` | 5.4 KB | Frozen route allowlist; only token routes may POST | Copied unchanged to `electron/webull/readonly.js`; `scripts/check-webull-readonly.js` is pointed at the new path |
| `api/_lib/secret-box.js` | 3.8 KB | AES-GCM using a key from Vercel environment variables | **Dropped**, replaced by async safeStorage |
| `api/_lib/auth.js` | 6.7 KB | Supabase JWT check and REST helpers | **Dropped** for Webull. Main uses the signed-in local account instead |
| `api/delete-account.js` | 7.9 KB | Includes `webull_journal_imports` in cloud account deletion | Dropped (cloud-only). Deleting a local account also deletes its Webull rows |

Recommendation: leave `api/` itself untouched in this work. It isn't served, and removing it can be a separate cleanup.

## 2. Signing and authentication: no server needed

- **Signing:** each request is signed with HMAC-SHA256 over the path, the sorted query and signed headers, and a SHA-256 hash of the body, keyed with `secret + "&"`. It's pure Node `crypto` and runs as-is in main.
- **Auth is not OAuth.** There's no redirect, so nothing needs a callback URL:
  - Create Token returns a token marked `PENDING`, and Webull texts a code.
  - The user approves in the Webull app.
  - Check Token returns `NORMAL`.
  - The approved token lasts about 15 days, and Webull also invalidates it after 15 days with no API calls.
  - There's no refresh token. "Refresh" means a new code and a new approval, which is user-initiated.
- **Nothing here needs a server.** The approval step ("Check again" / "Send new code") is required and must stay in the UI.

## 3. History depth, paging and timing

- **Limits:**
  - Order History is `GET /trading/orders/historical-orders/list` with `start_time` and `end_time`.
  - 90-day ranges are confirmed live; anything longer is untested.
  - A page holds about 100 order groups, followed with `pagination_key`.
  - The rate limit is 2 requests per 2 seconds, so main keeps a 1.1 s gap between calls and an 8 s timeout per call.
  - Webull's reference says history starts 2018-05-21. "All available history" uses that as the earliest date. It isn't confirmed for every account, but an empty window costs only one call.
- **Full-history import:** about 35 windows of 90 days, each followed to its last page.
  - No orders: about 1 minute.
  - About 5,000 order groups: about 85 calls, 2–3 minutes.
  - About 20,000: about 6–8 minutes.
- **Progress:** main emits `{ journalId, windowIndex, windowCount, windowStart, windowEnd, ordersSoFar }`. The UI shows "Importing Webull history: Mar 2021 – Jun 2021 (window 12 of 35, 1,240 orders)".
- **Resume:** each window is saved and acknowledged before the next one starts.
  - `backfill_cursor` and `last_synced_at` move only on a successful acknowledgment.
  - Closing the app mid-import re-reads at most one window.
  - Duplicates are prevented by `externalOrderIds` (section 6). Paging keys are never stored across restarts.
- **Later syncs** read from 24 hours before `last_synced_at` (the existing overlap) up to now.

## 4. Content-Security-Policy

**No change.** Every Webull request goes out from main via Node `fetch`, and the page's CSP doesn't apply there. Keeping `api.webull.com` out of `connect-src` also means the page itself can never reach Webull.

## 5. SQLite design (schema version 1 → 2)

```sql
CREATE TABLE webull_connection (
  account_id TEXT PRIMARY KEY,          -- Denarii local account
  creds BLOB NOT NULL,                  -- encryptStringAsync(JSON {v, accountId, appKey, appSecret})
  token BLOB,                           -- encryptStringAsync(JSON {v, accountId, token}) | NULL
  app_key_last4 TEXT NOT NULL,
  approval_state TEXT NOT NULL CHECK (approval_state IN ('ok','needs_approval','unknown')),
  token_expires_at INTEGER, token_created_at INTEGER, token_checked_at INTEGER,
  webull_accounts TEXT,                 -- JSON [{id,label}], no account_number
  default_start_date TEXT,              -- 'YYYY-MM-DD' | NULL = all history
  updated_at INTEGER NOT NULL);
CREATE TABLE webull_link (
  account_id TEXT NOT NULL, journal_id TEXT NOT NULL,
  webull_account_id TEXT NOT NULL,
  start_date TEXT,                      -- NULL = all history
  last_synced_at INTEGER,               -- end of last acknowledged window
  backfill_cursor INTEGER,              -- first-import progress; NULL when caught up
  last_status TEXT, last_error TEXT, last_attempt_at INTEGER,
  PRIMARY KEY (account_id, journal_id),
  UNIQUE (account_id, webull_account_id));
```

- **Migration:** `openDatabase` upgrades version 1 to 2 in one transaction, after the automatic backup. A restored version 1 backup is upgraded on relaunch. An older Denarii build opening a version 2 file shows the existing "newer" dialog.
- **Account binding:** `accountId` is stored inside each encrypted blob and checked on decrypt, so a blob can't be moved to another account's row.
- **Imported-order ids are deliberately not a SQLite table.** They stay where the engine already keeps them: `externalOrderIds` on each trade, inside the journal encrypted with the DEK. A plaintext table would expose trading activity at rest and could drift from the journal after a restore, edit or delete. One addition: `journalData.webullIgnoredOrders[journalId]` records the order ids of trades the user deleted, so they're never imported again.

## 6. How orders become journal trades

- **Mapping stays in the page.** `js/services/webull-sync.js` keeps its pure core unchanged: `dedupeFills`, `applyFills`, `planImport`, `roundTrade`. It needs `finalizeTradeSummary` and the decrypted journal, and the DEK never goes to main.
- **New `applyBatch` wrapper** replaces the cloud wrapper (`getAccessToken`, `fetchAllFills`, `commitWindow`, `_saveTradesToSupabase`, the cloud-primary guard). For each window:
  1. Main sends `{ runId, accountId, journalId, windowEnd, fills }`.
  2. The page checks that `accountId` is still the signed-in account and the journal still exists.
  3. It runs `buildPreview` and `planImport` and requires `qtyBalanced`.
  4. It mutates `journalData.trades` and runs `await saveToIndexedDB()`.
  5. It calls `ackBatch(runId, { ok: true })`.
- **Change needed:** `saveToIndexedDB` currently only logs or marks the journal dirty on failure. It must report success so the page acknowledges only after a real save.
- **Crash between the journal save and the acknowledgment:** the window is re-read, and `externalOrderIds` skips what's already applied. The 500-row limit is dropped because a local save is one atomic write.
- **Partial fills:** handled already. Fills are deduped by `orderId`, the larger `filledQty` wins, and only the quantity not yet applied is used.
- **Splits:** Webull's order history doesn't show them. A sale larger than the seeded position is reported as skipped ("opened before start date / possible split") and never invented.
- **Edits the user made after import:**
  - Closed Webull trades are never touched again.
  - Updates to open trades copy only `ENGINE_FIELDS`, so notes, tags and strategy survive.
  - New protection: an open trade stores a hash of its engine fields from the last sync. If the hash no longer matches (the user edited quantity or price), the trade isn't updated and is listed as "Edited after import; not updated".
  - Deleted trades go to `webullIgnoredOrders`.
- **Start date changes:**
  - Moving it later never deletes anything.
  - Moving it earlier queues a read of the new range only. Because `applyFills` seeds positions from today's open trades, that backfill would mis-pair older opens. Recommendation: show those fills for review instead of saving them automatically, for any instrument that already has Webull trades.

## 7. Preload API (`window.denariiWebull`) and main handlers

Every handler keeps the existing check that the sender is app://. Arguments are validated by type, regex and length.

| Call | Arguments, validation | Returns |
|---|---|---|
| `attach(accountId)` | The `auth` record `account:<id>` must exist | `{ ok }`; starts the scheduler |
| `detach()` | – | `{ ok }`; aborts any in-flight run |
| `status()` | – | `{ connected, last4, approvalState, approvalExpiresAt, accounts:[{id,label}], defaultStartDate, links:[{journalId, webullAccountId, startDate, lastSyncedAt, status, error, progress}] }`. Never returns the secret or token |
| `connect({ appKey, appSecret, startDate })` | `APP_KEY_RE`, `APP_SECRET_RE`; date `YYYY-MM-DD` between 2018-05-21 and today, or null | `{ ok, approvalState:'needs_approval', last4 }` or `{ ok:false, error }` |
| `checkApproval()` / `resendCode()` | 10 s / 60 s cooldowns | `{ approvalState, accounts?, message }` |
| `disconnect()` | – | `{ ok }`; deletes the connection, keeps links and trades |
| `setLink({ journalId, webullAccountId, startDate })` | `JOURNAL_ID_RE`; the account must be in `webull_accounts` | `{ ok }` or `{ ok:false, error }` (for example, already linked elsewhere) |
| `removeLink(journalId)` | – | `{ ok }`; trades stay |
| `syncNow(journalId?)` | – | `{ started }` or `{ busy }` |
| `onBatch(cb)` / `ackBatch(runId, { ok, error? })` | `runId` must match the pending batch | Delivers a batch / `{ ok }` |
| `onStatus(cb)` | – | Progress and status events |

## 8. Scheduling and edge cases

- **Timing:**
  - `attach` runs a sync right away, then every 15 minutes.
  - Linked journals run one at a time, with a 2 s gap between them.
  - Nothing runs without an attached, signed-in page.
- **Lock or reload:** Lock is a page reload. Main detaches on `did-start-navigation` or `render-process-gone` for that `webContents`, cancels the request with `AbortController`, and drops the unacknowledged batch.
- **Account switch or sign-out:** `detach`, then a new `attach`. Batches carry `accountId`, and the page rejects a mismatch.
- **Closing the app mid-sync:** `before-quit` aborts. The cursor is unchanged, so the next launch resumes.
- **Offline:** the attempt is recorded as `offline` and retried on the next 15-minute tick, with no retry spam.
- **Webull errors:**
  - 401 on Create Token: "Webull rejected the credentials".
  - 401 on a read: `needs_approval` ("Your Webull approval expired. Tap Send new code."). Main stops calling until the user approves again.
  - 403: "Your Webull key can't read accounts. Check that Trading is enabled."
  - 429: back off 5 s, then 30 s, then "Webull is busy" until the next tick.
  - 5xx: "Webull is unavailable".
  - Failure to decrypt the stored keys: "Stored credentials could not be read; please reconnect."
- **Restore from backup:**
  - The relaunch brings back the backup's own journal, links and cursors together, so they stay consistent.
  - Keys from another Windows user or machine won't decrypt, so the user is asked to reconnect.
  - Backups contain the protected keys; this is acceptable because DPAPI ties them to the Windows user.
  - The disconnect copy keeps the existing "Also revoke the App Key in Webull's developer portal" note, since old backups still hold the key.

## 9. UI changes

- **Settings > Integrations** (`js/pages/settings.js`):
  - `webullUnavailable()` checks for `window.denariiWebull`.
  - `webullRequest` maps to the preload calls.
  - The connect form gets an "Import trades starting from" date field (empty means all history).
  - The existing approval block, last4, account labels, approval expiry and Disconnect stay.
  - New: last sync time, import progress, Sync now and errors.
- **Broker Accounts** (`js/pages/broker-accounts.js`):
  - Supabase `webull_journal_imports` reads and writes become `status`, `setLink` and `removeLink`.
  - The "Webull link" section gets a start date (prefilled from the connection), status, progress and Sync now.
  - Removed: the per-journal auto-import toggle, the in-page auto-sync (`_wbAutoRun`, localStorage throttle, Web Lock), the cloud count checks, and the session messages.
- **Copy:** "Webull sync isn't available in this version yet." is removed from both files.

## 10. Auto sign-in moves to async safeStorage (Electron 45.2.3)

- **What changes in `electron/auto-signin.js`:**
  - `isAvailable` uses `await safeStorage.isAsyncEncryptionAvailable()`. The Linux `basic_text` check stays.
  - `write` uses `encryptStringAsync`; `read` uses `decryptStringAsync`.
  - If `shouldReEncrypt` comes back true, the file is rewritten atomically.
  - All `createAutoSignIn` methods become async. The IPC is unchanged for the page.
  - `tryUnlock` must still set `used = true` before its first `await`, so two calls can't race.
- **Risk to existing files:** low. Electron's typings say data from `encryptString` can be decrypted with `decryptStringAsync`.
  - If decryption fails anyway, the current behaviour is the fallback: the file is cleared, the user types their password once, and they turn "Stay signed in" back on.
  - A file rewritten by the async API may not be readable by an older Denarii build. Going back to an older build gives the same fallback.
  - This should be verified once on a real machine with an existing `auto-signin.dat`.

## 11. Tests to add

- **Moved signer and client tests:** `webull-sign.test.js` and `webull-readonly.test.js` run against `electron/webull/`, and the check script asserts the allowlist still has POSTs only for the token routes.
- **`electron-webull-store.test.js`:** version 1 → 2 migration; a restored version 1 backup; the "newer" check; per-account isolation; the unique Webull account rule; deleting an account removes its rows.
- **`electron-webull-connection.test.js`** (fake async safeStorage and fake fetch):
  - `status` never returns the secret or token.
  - A blob with the wrong account is rejected.
  - Undecryptable keys lead to "reconnect".
  - Token statuses map correctly: PENDING, NORMAL, EXPIRED, INVALID.
  - Cooldowns hold.
- **`electron-webull-fetch.test.js`** (fake clock):
  - Windows computed from a start date or the 2018-05-21 default.
  - Paging, the 1.1 s gap, and 429 back-off.
  - 401 and 403 mapping.
  - The cursor moves only on acknowledgment.
  - Detach and quit abort the run, and the next run resumes with no duplicates.
- **Engine tests:**
  - Applying per window gives the same totals as applying once.
  - Deleted trades aren't re-imported.
  - An open trade the user edited isn't overwritten.
  - Partial fill growth is applied correctly.
  - Re-acknowledging a window is a no-op.
  - Moving the start date earlier is routed to review.
- **IPC validation:** bad keys, dates, journal ids and `runId`, plus a sender that isn't app://.
- **UI:** the "not available" text is gone; the date field is present; the secret field is cleared after connect; progress and error rendering.
- **Auto sign-in:**
  - Async fakes.
  - An old file read through the async API.
  - `shouldReEncrypt` rewrites the file.
  - A rejected decrypt clears the file.
  - "Unavailable" is reported correctly.
  - The once-per-launch rule still holds.
- `syntax-check` covers the new files.

## Suggested order

1. Async auto sign-in.
2. SQLite version 2 and the main-side `electron/webull/*` with tests.
3. Preload and IPC.
4. Page `applyBatch` and the `saveToIndexedDB` success return.
5. The Settings and Broker Accounts UI.

## Still unknown, to confirm during use

- Whether `start_time` filters on place time or fill time (this matters for GTC orders placed before a window).
- Whether windows longer than 90 days work.
- Whether a token's 15-day expiry extends with use.
