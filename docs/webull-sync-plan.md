# Webull Trade Sync Plan (read-only)

> **Historical (cloud version).** This plan was written for the earlier cloud version of Denarii (Vercel API routes and Supabase tables). That setup is gone: in the desktop app Webull is called only from the Electron main process and data is stored in local SQLite; see `webull-local-plan.md` and CLAUDE.md. The fill-to-trade mapping, identity and dedupe rules (section 7) and the engine test cases (section 9) still describe `js/services/webull-sync.js` and its tests. Where this file and the code disagree, the code is right.

Status: plan only, with no implementation yet. Revision 2 (2026-10-18). Revision 2.1 (2026-10-18): Open Questions #4–#7 resolved; Webull 2FA approval handling added. Changes are marked **[Rev 2.1]**.

Revision 2 adds per-journal import settings, dedupe scoped to each journal, trade identity that stays stable across syncs, handling for positions opened before the start date, auto-sync on app load, the confirmed Webull signing spec, and a phased rollout. Sections 2–6, the security items in 8, and section 10 keep their original wording. Where revision 2 had to change one of those sections, the change is marked **[Rev 2]**.

---

## 0. Current model this plan builds on (verified in code)

| Fact | Where verified |
|---|---|
| Each user has a single `journalData` object (IndexedDB plus `journal_backups` blob, with cloud-primary row tables). Nothing like a separate "journals" table exists. | `supabase/schema.sql`, `js/pages/journal.js` |
| **A "journal" in this plan is a `broker_accounts` row** (`journal_id` = `broker_accounts.id`, for example `ba_<ts>_<rand>`). Trades are scoped by `trade.brokerAccountId`, a broker account has its own name, style, color and balance, and deleting a broker account deletes its trades. | `js/pages/broker-accounts.js` |
| "Archiving" a journal means `broker_accounts.visible = false`. | `supabase/schema.sql`, commit `dbed87a` |
| Trade `id` values are **numeric** (`Date.now()`-based). Many code paths compare with `Number(t.id)`. **Webull identity therefore must NOT be stored in `id`.** | `Denarii.js` (e.g. dashboard selection, merge) |
| Open trades are already supported: `_isOpenTrade(t)` is true when `exitTime` or `exitPrice` is missing. | `Denarii.js` `_isOpenTrade` |
| A Webull **CSV** import already exists. It uses `source: 'csv'` and groups fills with `groupMatchedSlicesIntoLogicalTrades` and `finalizeTradeSummary`. Unmatched closing rows default to **Skip**. | `Denarii.js` broker import |
| Cloud `trades` table has `source TEXT` and PK `(user_id, id)`. It has no external-ID column and no fills column. | `supabase/schema.sql` |

**[Rev 2.1] Confirmed by the owner (Open Question #7):** one broker account in Denarii = one journal. Two Denarii broker accounts can link to the same Webull account, and each keeps its own independent import. Starting a new journal for the same Webull account means creating a new `broker_accounts` row.

---

## 1. What gets built

| Piece | Where |
|---|---|
| Secrets table `broker_credentials` | Supabase dashboard; documented in `supabase/schema.sql` |
| **[Rev 2]** Per-journal import settings table `webull_journal_imports` | Supabase dashboard; documented in `supabase/schema.sql` |
| **[Rev 2]** Additive trade columns `external_id`, `external_order_ids` | Supabase `trades` table; documented in `supabase/schema.sql` |
| Shared server helpers (not deployed as functions) | `api/_lib/auth.js`, `api/_lib/secret-box.js`, `api/_lib/webull-readonly.js`, **[Rev 2]** `api/_lib/webull-sign.js` |
| One endpoint with actions `connect`, **[Phase 3 plan]** `check_approval`, `resend_code`, `status`, `sync`, **[Rev 2]** `commit`, `disconnect` | `api/webull.js` (+ `vercel.json` entry) |
| **[Rev 2]** Client sync engine (turns fills into trades, finds matches, records skips, runs auto-sync) | `js/services/webull-sync.js` (new; loaded from `index.html`) |
| UI: connect form, status, Disconnect (connection level) | `js/pages/settings.js` (Integrations) |
| **[Rev 2]** UI: per-journal link, start date, auto-import, last synced, status, Sync now | `js/pages/broker-accounts.js` (existing account edit modal and list) |
| Account deletion cleanup | add `webull_journal_imports` and `broker_credentials` to the table list in `api/delete-account.js` |

---

## 2. Database

```sql
CREATE TABLE broker_credentials (
  user_id            UUID PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  broker             TEXT NOT NULL DEFAULT 'webull',
  app_key_ct         TEXT NOT NULL,  -- base64 ciphertext
  app_key_iv         TEXT NOT NULL,  -- 12-byte random IV, unique per value
  app_key_tag        TEXT NOT NULL,  -- 16-byte GCM auth tag
  app_secret_ct      TEXT NOT NULL,
  app_secret_iv      TEXT NOT NULL,
  app_secret_tag     TEXT NOT NULL,
  app_key_last4      TEXT NOT NULL,
  key_version        SMALLINT NOT NULL DEFAULT 1,  -- for rotating the encryption key
  webull_account_ids JSONB,          -- non-secret; Webull accounts these keys can read
  approval_state     TEXT CHECK (approval_state IN ('ok','needs_approval','unknown')) DEFAULT 'unknown', -- [Rev 2.1] non-secret, connection level (§7.8)
  approval_checked_at TIMESTAMPTZ,   -- [Rev 2.1]
  created_at         TIMESTAMPTZ DEFAULT now(),
  updated_at         TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE broker_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE broker_credentials FORCE ROW LEVEL SECURITY;
-- Intentionally NO policies. With RLS on and no policies, anon/authenticated get nothing.
REVOKE ALL ON broker_credentials FROM anon, authenticated;
```

**[Rev 2]** `last_sync_at` and `last_sync_status` were **moved off** `broker_credentials` and into `webull_journal_imports` (§2a), because sync state belongs to each journal. `broker_credentials` now holds only credentials and connection-level facts.

- Each user's keys are tied to their auth `user_id` (one row per user, which is enough for one Webull login; the account-ID list covers several Webull accounts).
- **[Rev 2.1]** One row per user is confirmed to be correct: Webull allows one API key per user/account (Open Question #6). All of a user's Denarii broker accounts (journals) share that one connection.
- **[Rev 2.1]** If Phase 2 shows that Webull's 2FA flow issues an access token that has to be reused across requests, that token is a secret. It gets stored encrypted under the same §3 rules (new additive columns `access_token_ct` / `_iv` / `_tag` plus a non-secret `access_token_expires_at`, AAD field `access_token`), is never logged, and is never returned. **[Phase 3 plan]** Confirmed needed (§7.8). Added in Phase 3 (`supabase/webull-phase3.sql`): `access_token_ct` / `_iv` / `_tag`, `access_token_expires_at`, `access_token_checked_at`, `access_token_created_at` (see `docs/webull-phase3-plan.md` §2).
- **No client select, insert or update policies.** Only the service role key, which bypasses RLS, can touch the table.
- **Required check** (the schema file marks other tables' RLS as "ASSUMED"; this table can't be): with the anon key and a real user session, `select * from broker_credentials` must return a permission error or zero rows, and an insert must fail. Record the result in `schema.sql`.

### 2a. [Rev 2] Per-journal import settings: `webull_journal_imports`

This is a new table, and it only adds. No existing table changes shape except for the trade columns in §2b.

```sql
CREATE TABLE webull_journal_imports (
  user_id             UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE, -- connection owner
  journal_id          TEXT NOT NULL,           -- = broker_accounts.id
  webull_account_id   TEXT NOT NULL,           -- non-secret Webull account id
  import_start_at     TIMESTAMPTZ NOT NULL,    -- user picks a DATE; stored as 00:00 America/New_York of that date, converted to UTC (DST-aware)
  auto_import_enabled BOOLEAN NOT NULL DEFAULT false,
  last_synced_at      TIMESTAMPTZ,             -- end of the last fully committed window
  backfill_cursor     TIMESTAMPTZ,             -- progress through a long first sync; null when caught up
  last_sync_status    TEXT CHECK (last_sync_status IN ('never','ok','partial','error','running','needs_approval')) DEFAULT 'never', -- [Rev 2.1] needs_approval added
  last_sync_error     TEXT CHECK (char_length(last_sync_error) <= 200), -- fixed safe message from server only
  last_sync_skipped   JSONB,                   -- capped list of skipped fills (see §7.4), non-secret
  created_at          TIMESTAMPTZ DEFAULT now(),
  updated_at          TIMESTAMPTZ DEFAULT now(),
  PRIMARY KEY (user_id, journal_id),
  FOREIGN KEY (user_id, journal_id) REFERENCES broker_accounts(user_id, id) ON DELETE CASCADE
);
ALTER TABLE webull_journal_imports ENABLE ROW LEVEL SECURITY;

CREATE POLICY wji_select ON webull_journal_imports FOR SELECT TO authenticated USING (auth.uid() = user_id);
CREATE POLICY wji_insert ON webull_journal_imports FOR INSERT TO authenticated WITH CHECK (auth.uid() = user_id);
CREATE POLICY wji_update ON webull_journal_imports FOR UPDATE TO authenticated USING (auth.uid() = user_id) WITH CHECK (auth.uid() = user_id);
CREATE POLICY wji_delete ON webull_journal_imports FOR DELETE TO authenticated USING (auth.uid() = user_id);

-- Column-level limits: clients may edit only the user-facing settings.
REVOKE ALL ON webull_journal_imports FROM anon, authenticated;
GRANT SELECT, DELETE ON webull_journal_imports TO authenticated;
GRANT INSERT (user_id, journal_id, webull_account_id, import_start_at, auto_import_enabled) ON webull_journal_imports TO authenticated;
GRANT UPDATE (webull_account_id, import_start_at, auto_import_enabled, updated_at) ON webull_journal_imports TO authenticated;
-- last_synced_at, backfill_cursor, last_sync_status, last_sync_error, last_sync_skipped
-- are written ONLY by api/webull.js using the service role.
```

Rules:
- The owner can read and update their own rows. Other users' rows are invisible, enforced by RLS on `auth.uid() = user_id`.
- **Several journals can link to the same `webull_account_id` independently.** The PK is per journal and nothing is unique on `webull_account_id`.
- The composite FK to `broker_accounts(user_id, id)` means a user can link only their **own** journal. If the broker account exists only locally and hasn't reached the cloud yet, the insert fails and the UI shows "Save this account to the cloud first."
- **Turning off auto-import** changes only this row's `auto_import_enabled`. **Archiving** (`visible = false`) doesn't touch this table at all. Auto-sync skips hidden journals (§7.5). Neither action touches trades or any other journal's row.
- Removing the Webull link from a journal deletes only that journal's row. Trades it already imported stay as they are.
- Deleting the broker account cascades to its row, which matches the existing behavior where deleting a broker account deletes its trades.
- **Disconnect** (credentials) doesn't delete these rows. Each journal's link stays (status shows "Not connected") so reconnecting picks up where it left off. The user can remove a journal's link separately.
- `last_sync_skipped` holds no secrets: symbol, side, quantity, ET date, Webull order ID and reason only.

### 2b. [Rev 2] Additive columns on `trades`

```sql
ALTER TABLE trades ADD COLUMN IF NOT EXISTS external_id        TEXT;   -- webull:<journalId>:<webullAccountId>:<openingOrderId>
ALTER TABLE trades ADD COLUMN IF NOT EXISTS external_order_ids JSONB;  -- { "<webullOrderId>": <filledQtyApplied>, ... }
CREATE UNIQUE INDEX IF NOT EXISTS trades_user_journal_external_id_uq
  ON trades (user_id, broker_account_id, external_id) WHERE external_id IS NOT NULL;
```

- Both columns are nullable, so every existing row (manual, CSV, demo) stays valid with `NULL`.
- The local trade object gets matching optional fields `externalId` and `externalOrderIds`. These fields are additive, and code that doesn't know about them ignores them.
- The unique index is scoped per journal (`broker_account_id`) and covers only rows that have a value. It stops two tabs or two auto-syncs from inserting the same imported position twice.
- **[Phase 8]** `trades.webull_partials JSONB` (nullable, `supabase/webull-phase8.sql`) holds the closed slices of an open Webull trade that was partly exited (`webullPartials`), so they survive a cloud reload. The cloud row has no `fills`, `contractName`, `feeSource`, `grossPnl` or `type` column (it stores `direction`); those are lost on a row reload for every trade, as for CSV trades. The engine reads `type || direction`, and option keys rebuild from `symbol`, `option_type`, `strike`, `expiry`.

---

## 3. Encryption (`api/_lib/secret-box.js`)

- AES-256-GCM using Node `crypto.createCipheriv('aes-256-gcm', key, iv)`.
- **A new random 12-byte IV for each value**, so the App Key and App Secret each get their own, and so does every re-connect.
- **AAD = `user_id + ':' + field + ':' + key_version`** (for example `…:app_secret:1`). This binds each ciphertext to its owner and field. Copying one user's encrypted row onto another user's row, or swapping the key and secret columns, makes decryption fail.
- Encryption key: `WEBULL_CREDS_ENC_KEY`, 32 random bytes in base64, stored **only as a Vercel env var** marked Sensitive, for Production only. It is never in Supabase, the repo, `js/config/config.js`, or client code. The function refuses to run if the key is missing or isn't exactly 32 bytes once decoded.
- Rotation: add `WEBULL_CREDS_ENC_KEY_V2` and bump `key_version`. The server decrypts with the key matching the row's version and re-encrypts with the newest key the next time it reads that row.
- Decrypted values exist only inside one request's memory, are passed straight to the signing code, and never go into a variable that is logged or returned.

---

## 4. Server endpoint (`api/webull.js`)

Every request does this:

1. **Gets `user_id` only from the verified Supabase token** (`Authorization: Bearer` → `/auth/v1/user`, the same as `delete-account.js`). Any `user_id` in the request body is ignored and never read.
2. Uses `SUPABASE_SERVICE_ROLE_KEY`, which lives **only in Vercel env vars**, for every database access, always filtered by `user_id=eq.<verified id>`.
3. Accepts POST only, requires `Content-Type: application/json`, and rejects bodies over about 2 KB.

Actions:

| Action | Input | Does | Returns |
|---|---|---|---|
| `connect` **[Phase 3 plan: redesigned]** | `appKey`, `appSecret` | Checks length and allowed characters, then makes one Create Token call (a 401 means bad keys, and nothing is saved). Encrypts the key, secret and token and upserts the row with `approval_state = needs_approval`. Account access is verified by the first `check_approval` that returns NORMAL, followed by Account List. | `{ connected: true, last4, approvalState: "needs_approval", accounts: [] }` |
| `check_approval` **[Phase 3 plan]** | nothing | One Check Token call (10-second cooldown). If `NORMAL`, one Account List call, then stores `webull_account_ids` and sets `approval_state = ok`. Other statuses map to `needs_approval` or `unknown` with a fixed §6 message. | `{ approvalState, accounts, message? }` |
| `resend_code` **[Phase 3 plan]** | nothing | User-initiated only. One Create Token call (60-second cooldown; refused while approved and unexpired). Stores the new token encrypted, sets `needs_approval`. | `{ approvalState: "needs_approval", message }` |
| `status` | nothing | Reads the non-secret columns only. The select names its columns explicitly, never `*`. | `{ connected, last4, accounts, approvalState }` **[Rev 2: sync timestamps now come from `webull_journal_imports`]** **[Phase 3 plan: `approvalState` added]** |
| `sync` **[Rev 2]** | `journalId`, optional `cursor` | Loads the journal's row from `webull_journal_imports` (`user_id` from token + `journalId`). Checks `webull_account_id` against `broker_credentials.webull_account_ids`. **Works out the window on the server** (§7.2), so it never trusts a window sent by the client. Decrypts, calls only the allowed read endpoints, and sets status to `running`/`partial`/`error` with a fixed safe message. | `{ fills: [...], windowStart, windowEnd, nextCursor \| null }` |
| `commit` **[Rev 2]** | `journalId`, `windowEnd`, `skipped[]` (capped) | Called **after** the client has saved the trades. Sets `last_synced_at = min(windowEnd, now())`, `backfill_cursor` and `last_sync_status = 'ok'`, and stores the capped, sanitized `last_sync_skipped`. Doesn't touch credentials. | `{ ok: true, lastSyncedAt }` |
| `disconnect` | nothing | `DELETE … where user_id = <verified id>`, then reads back to confirm the row is gone. | `{ disconnected: true }` |

**What the browser can get back:** connection status, the last 4 characters of the App Key, sync timestamps, and trade data. It never gets plaintext or encrypted secrets, IVs or tags.

**[Rev 2] Why `commit` is separate from `sync`:** the trades are saved through the existing client cloud-primary save path. If `sync` advanced `last_synced_at` itself, a failed client save would skip fills permanently. Because the watermark moves only after a successful save, a failed save just gets retried. The 24-hour overlap plus ID dedupe make retries safe.

**[Rev 2] Vercel time limit:** each `sync` call fetches **at most one window of ≤ 90 days** (**[Phase 3 plan]** confirmed live, §5a.1; 7 days is only Webull's default when no range is sent), following `pagination_key` for a bounded number of pages (~100 order groups each), and stays under `maxDuration`. It returns `nextCursor` while there is more history to fetch, and the client keeps calling until `nextCursor` is null. Order History is listed at **2 requests / 2 s**, so the server spaces its calls to stay under that.

---

## 5. Read-only enforcement (`api/_lib/webull-readonly.js`)

- The module exports only named functions: `getAccountList`, `getAccountBalance`, `getPositions`, `getOrderHistory`, `getOrderDetail`, and **[Phase 2b]** `createToken` / `checkToken`. Those two are the only non-GET entries on the allowlist (`POST /auth/tokens/create`, `POST /auth/tokens/check`); they're marked in code and tested as the only POSTs. **There is no general `request(method, path)` function.**
- Inside the module, a frozen allowlist of `{method, path}` pairs is checked before every signed request. Any other path throws an error before signing.
- **[Rev 2.1] This module is the only protection against order placement in Denarii code.** Webull keys can't be limited to read-only: the Trading permission covers both reading order/account history and placing orders (Open Question #4). Any change to the allowlist needs explicit review.
- Nothing that places, modifies, replaces or cancels orders exists anywhere in the codebase. Add `scripts/check-webull-readonly.js` (Node, so it runs on Windows), which fails if `api/` contains `place_order`, `replace_order`, `cancel_order`, `/order/place`, `/order/cancel` or `/order/replace`. Run it before every push (`npm run check:webull`).
- **[Rev 2, corrected; Phase 3 plan]** The signing code (**HMAC-SHA256** with an uppercase hex SHA-256 body hash, confirmed live in §5a.1; the docs page's HMAC-SHA1 + MD5 is kept only for the §5a test vector) is written by hand from Webull's published spec in `api/_lib/webull-sign.js`, so no SDK that contains trading methods is pulled in.
- **Before starting work:** get the exact REST paths, host and signing algorithm from Webull's Authentication and Accounts reference. **[Rev 2]** Signing is now confirmed (§5a). Order History's path is confirmed. The account list, balance, positions and order detail paths are still open (Open Questions).

### 5a. [Rev 2] Webull signing spec (docs page — see §5a.1 for what runs in production)

Source: <https://developer.webull.com/apis/docs/authentication/signature> (read 2026-10-18).

| Item | Spec |
|---|---|
| Algorithm | Production: **HMAC-SHA256**, output **base64** (§5a.1). Docs page: HMAC-SHA1. |
| Signing key | `app_secret + "&"` |
| Required headers | `x-app-key`, `x-timestamp` (UTC `YYYY-MM-DDThh:mm:ssZ`), `x-signature`, `x-signature-algorithm: HMAC-SHA256`, `x-signature-version: 1.0`, `x-signature-nonce` (new random string per request), `x-version: v3`; `Content-Type: application/json` on POST |
| Signed headers | `x-app-key`, `x-signature-algorithm`, `x-signature-version`, `x-signature-nonce`, `x-timestamp`, `host` |
| Not signed | `x-signature`, `x-version` |
| Secret on the wire | **Never.** Only `x-app-key` is sent. |
| String to sign | 1) Put the query params and signed headers in one list and sort by name ascending. Duplicate names: sort their values and join with `&`. 2) `str1` = `name=value` pairs joined with `&`. 3) If there's a body, `str2` = uppercase hex SHA-256 (MD5 in the docs-page SHA1 variant) of the exact compact-JSON body bytes. 4) `str3` = `path + "&" + str1` (+ `"&" + str2`). 5) URL-encode the whole of `str3` once. Nothing is encoded before this step. |
| Signature | `base64(HMAC_SHA256(app_secret + "&", urlencode(str3)))` (SHA1 variant for the test vector only) |
| Body rule | Send exactly the bytes that were hashed, so don't let the HTTP layer re-serialize them. All our read calls are GETs, so normally there's no body. |
| Test vector (from Webull's docs) | path `/trade/place_order`, query `a1=webull&a2=123&a3=xxx&q1=yyy`, app key `776da210ab4a452795d74e726ebd74b6`, secret `0f50a2e853334a9aae1a783bee120c1f`, timestamp `2022-01-04T03:55:31Z`, nonce `48ef5afed43d4d91ae514aaeafbc29ba`, body MD5 `E296C96787E1A309691CEF3692F5EEDD` → **`kvlS6opdZDhEBo5jq40nHYXaLvM=`**. This vector is used **only as a unit test of the signer**. That path is a trading path and never appears in the allowlist. Keep the vector in a test file the read-only check script excludes. (SHA1/MD5 variant, algorithm set explicitly in the test) |
| Unknown | Allowed clock skew; nonce format limits. (US REST host: `api.webull.com`, confirmed live; see §5a.1.) |

Confirmed read path: **`GET /trading/orders/historical-orders/list`** (Order History). Its default range is the last 7 days. **[Phase 3 plan]** 90-day ranges confirmed live (§5a.1); Phase 6 uses 90-day windows. It is listed at 2 req/2 s, and the docs warn the data may lag real time. A 2026 changelog moved it to `pagination_key` plus `start_time`/`end_time`. Confirm the exact parameter names in the interactive reference before Phase 6.

#### 5a.1 Phase 2b: confirmed live 2026-10-18

Run with `scripts/webull-probe.js` against US production with the owner's key. Every call returned HTTP 200.

| Item | Result |
|---|---|
| US production host | **`api.webull.com`**, confirmed live. It's also the `us` → `api` entry in the official SDK's `endpoints.json`. The reference pages only list `api.sandbox.webull.com`. |
| Signature algorithm | **HMAC-SHA256** with an uppercase hex **SHA-256** body hash, confirmed live on POSTs with a body and on GETs. The official Python SDK always signs this way (`default_signature_composer.py` forces `sha_hmac256_new`). The docs page's HMAC-SHA1 + MD5 scheme wasn't tried live. `webull-sign.js` supports both and defaults to SHA256; the §5a vector is still a unit test, with SHA1 set explicitly. |
| String to sign, signing key, timestamp, signed headers | As in the table above (`secret + "&"`, UTC `YYYY-MM-DDThh:mm:ssZ`, same six signed headers). Same as the SDK. |
| `x-app-secret` | **Not sent.** The API reference pages list it as a required header, but the SDK never sends it and the token/signature guides say the secret never goes on the wire. Calls succeeded without it. |
| `x-access-token` | **Unsigned**, confirmed live: it's added after signing, as the SDK does, and Account List and Order History returned 200. |
| Create Token | `POST /auth/tokens/create`, body `{}` with `Content-Type: application/json`, body hash signed (as in the SDK). The first attempt, with no body and a mis-pasted secret, got 401 `UNAUTHORIZED`; the second, with correct keys and `{}`, got 200. Response `{ token, expires_at, status }` with status `PENDING`. |
| Check Token | `POST /auth/tokens/check`, body `{"token":"…"}`. Response has the same shape. |
| Account List | `GET /trading/accounts/list`, with `x-access-token`. Returns an array (2 accounts for the owner). |
| Order History | `GET /trading/orders/historical-orders/list?account_id=…&start_time=…&end_time=…`, with times in `yyyy-MM-ddTHH:mm:ss.SSSZ` (`Date.toISOString()`). **30-day and 90-day ranges were both accepted** (second run). The response is `{ data: [...], pagination_key }`; `pagination_key` is present only when there are more pages. The margin account returned **100 order groups** on the first page plus a `pagination_key` (not followed), so the **page size is about 100 groups**. Field details are in §12 #2 and #3. |
| Permissions used | Both runs used a key with **Trading and Market Data both checked**. **Trading-only is untested** (§12 #4). |
| Accounts | 2 returned: `CASH` / `INDIVIDUAL_CASH` / "Individual Cash" (unused, 0 orders in 90 days) and `MARGIN` / `INDIVIDUAL_MARGIN` / "Individual Margin" (active). Both have `account_id` and `account_number`. |
| Rate limits (docs) | Create/Check Token 10/10 s; Account List 10/30 s; Order History 2/2 s (production). |

---

## 6. Logging and errors

- Never log request bodies, decrypted values, ciphertext, Webull request headers (they carry the signature and App Key), or raw Webull responses.
- All Webull and crypto errors are mapped to fixed messages such as `"Webull rejected the credentials."`, `"Webull is unavailable."` or `"Stored credentials could not be read; please reconnect."`. Upstream error text is never forwarded.
- Wrap the handler in a try/catch that returns a generic 500. Logs record only the error category plus an opaque request id.
- Never use `console.log(err)` on errors from the crypto or Webull code paths, because Node can include arguments in the stack trace.
- **[Rev 2]** `last_sync_error` is written only from that same fixed message list. The client renders it with `escapeHtml`.
- **[Rev 2.1]** The fixed list adds: `"Approve Denarii in the Webull app, then tap Sync now."` This message is used with status `needs_approval` (§7.8).
- **[Phase 3 plan]** The fixed list also adds: `"Approve Denarii in the Webull app, then tap Check again."`, `"Your Webull approval expired. Tap Send new code."`, `"Webull is busy. Try again in a minute."`, `"Your Webull key can't read accounts. Check that Trading is enabled."`, `"Please wait a moment before trying again."` (full mapping in `docs/webull-phase3-plan.md` §4).

---

## 7. [Rev 2] Turning fills into trades, per journal

The server returns normalized fills only. The client engine (`js/services/webull-sync.js`) turns them into trades and saves them through the **existing cloud-primary trade save path**. That keeps IndexedDB, the `journal_backups` blob and the `trades` rows consistent, the same way manual and CSV trades are. Where the existing CSV helpers (`finalizeTradeSummary`, option contract parsing) fit, they are reused rather than duplicated.

### 7.1 Identity and dedupe, per journal

- **`trade.id`** is still numeric. It is assigned **once** when the trade is created, using the existing generator, and **never changes**.
- **`trade.externalId`** = `webull:<journalId>:<webullAccountId>:<openingOrderId>`. `openingOrderId` is the Webull order ID of the fill that opened the position. Because `journalId` is part of the ID, **two journals importing the same Webull order produce two separate trades that never collide or overwrite each other.**
- **`trade.externalOrderIds`** maps `{ webullOrderId: filledQtyApplied }` and covers every order (open, add, partial exit, close) the trade has absorbed.
- **Fill-level dedupe:** before applying a fill, the engine builds the set of order IDs already used by **this journal's** trades (`brokerAccountId === journalId`). A fill whose order ID is in that set **and** whose filled quantity is ≤ the quantity already applied gets skipped. If an order's filled quantity grew (a partial fill that continued across a sync boundary), only the difference is applied.
- `source = 'webull'` on all imported trades. `brokerAccountId = journalId`.

### 7.2 Fetch window

```
windowStart = max(import_start_at, last_synced_at - 24h)     -- last_synced_at null → import_start_at
              (or backfill_cursor if a multi-call backfill is in progress)
windowEnd   = min(windowStart + 90d, now())     -- [Phase 3 plan] 90-day ranges confirmed live (§5a.1)
```

- Fills inside the 24-hour overlap that were already imported get skipped by ID (§7.1).
- The server works out the window from the stored row. The client can't send its own.

### 7.3 Trades that span several syncs

- The engine rebuilds position state for each journal and each instrument (stock symbol, or option contract = underlying + type + strike + expiry) from **this journal's open Webull trades** (`source === 'webull' && _isOpenTrade(t)`), then applies the new fills in time order.
- An opening fill with no open position creates a new **open** trade (no `exitTime`/`exitPrice`) with a new `externalId`.
- Adds and partial exits are attached to the **existing** trade: its order IDs are appended and its quantities and averages updated, with the same `id` and `externalId`.
- When the position returns to zero, the **existing open trade is updated to closed** (exit price, exit time, P&L via `finalizeTradeSummary`) instead of creating a new trade.
- If a fill goes past zero (a reversal), the current trade closes and a new trade opens for the remaining quantity with its own `externalId`.
- The saves are **updates to existing trade IDs** through the existing save path. The cloud unique index on `(user_id, broker_account_id, external_id)` is the safety net against duplicates.

### 7.4 Positions opened before `import_start_at`

- A **closing** fill that has no open position to match in this journal gets **skipped**. It's never imported as a partial trade.
- When a close is larger than the open quantity, the matched part is applied and **only the excess** is skipped.
- Each skip goes into `last_sync_skipped` (capped at the 50 most recent) as `{symbol, side, qty, dateET, orderId, reason: "skipped: opened before start date"}`. The journal's sync status shows the count with an expandable list.
- Distinguishing a "sell to close" from a "short sell to open" depends on Webull's side and position-effect fields (Open Question). Until that's confirmed, an ambiguous sell with no open long is treated as a skip, not as a short.
- **Confirmed live 2026-10-18 (§12 #3):**
  - Equities: `side: "SHORT"` is a short open, so a `SELL` with no open long is a close of a pre-start position and gets skipped. A `BUY` with no open short opens a long, because equities have no `position_intent` and a cover is only known from position state.
  - Options: when `position_intent` says `*_TO_CLOSE` and there's no open position in this journal, it's skipped.

### 7.5 Auto-sync on app load

- Starts **after** the cloud-primary load completes, via `requestIdleCallback` (or `setTimeout` as a fallback). It's never awaited by app startup.
- Runs only for journals where `auto_import_enabled = true`, the broker account is `visible`, and credentials are connected.
- **[Rev 2.1]** It starts with one `status` call, which reads the database only and makes no Webull call. If `approval_state = 'needs_approval'`, **auto-sync skips every journal on that connection for this app load and doesn't retry** (§7.8).
- **Skips any journal whose `last_synced_at` is within the last 5 minutes.**
- Processes journals **one at a time** to respect Webull's rate limit, with an in-tab "in progress" flag per journal. If two tabs run at once, the cloud unique index plus ID dedupe stop duplicates.
- All errors are caught. The failure shows in that journal's sync status (written by the server), and nothing is thrown into app load or shown as a blocking modal.

### 7.6 Manual Sync now

- Every linked journal has a **Sync now** button that runs the same flow for that journal only. It ignores the 5-minute skip but not an in-progress run.

### 7.7 Changing the start date

- If the journal already has trades with `source === 'webull'`, the UI shows a warning before saving: *"Existing imported trades will not be deleted. Moving the date earlier imports older history; moving it later only affects future syncs."*
- Changing the date **never deletes trades**.
- Moving it **earlier** resets `backfill_cursor` to the new start (done by the server on the next `sync`). Already-imported fills are skipped by ID.
- Moving it **later** only narrows future windows.

### 7.8 [Rev 2.1] Webull 2FA approval

Webull's "Enable 2FA Verification" is on for API keys. Webull may require the user to approve the connection (its token) in the Webull app, and to approve it again from time to time.

- **Phase 2 must confirm** the approval flow (how a token is requested and how pending vs. approved shows up in the API response), **how often re-approval is required**, and whether a token has to be stored (§2).
- **Confirmed live 2026-10-18:**
  - `POST /auth/tokens/create` returns `{ token, expires_at, status: "PENDING" }` and Webull **texts a code**.
  - **The Webull app popped up a code-entry box automatically**; the owner typed the code in and needed no menu navigation. The docs' fallback, if no popup appears, is **Menu → Messages → OpenAPI Notifications → Check Now**.
  - `POST /auth/tokens/check` showed `PENDING` → `NORMAL`. Approval took **16–31 s** on the first run and **≤15 s** on the second; polling was every 15 s.
  - **Each new token needed a new text code**, even though the previous token was still valid.
  - A `PENDING` token's `expires_at` was **~5 minutes** after creation, which matches the docs' 5-minute approval window (then `EXPIRED`).
  - Not seen live: `EXPIRED`, `INVALID`, and what `expires_at` becomes after approval. The docs say a token goes `INVALID` after **15 days with no API calls**, and the reference describes tokens as valid for a default of 15 days.
  - **[Phase 3C, confirmed live 2026-10-19]** An approved (`NORMAL`) token's `expires_at` is **15 days after creation** (created 2026-10-19 22:09:14 UTC, expires 2026-11-03 22:09:58 UTC). An expired pending token (checked after 6+ minutes) was handled live as `needs_approval` with the expired message. *Still open:* whether regular use extends the expiry; check on or after 2026-11-03.
- **Consequences for the design:**
  - **A token must be stored** (encrypted) and reused. Creating one needs a fresh text-code approval each time, so a token can't be minted per sync.
  - Treat `PENDING`, `EXPIRED`, `INVALID`, or a 401 on a read call as `needs_approval`.
  - "I've approved it, check again" = one `checkToken` call.
  - "Reconnect / send a new code" = one `createToken` call; it's user-initiated only.
  - Re-approval is needed at the latest when the token goes 15 days unused, and possibly every ~15 days regardless. Confirm during Phase 6 use.
- When the server sees "approval required/pending/expired", it sets `broker_credentials.approval_state = 'needs_approval'`, plus `last_sync_status = 'needs_approval'` and the fixed §6 message on the journal being synced. It never fails silently or reports a generic error for this state.
- **Auto-sync skips** while `approval_state = 'needs_approval'` (§7.5). It makes no automatic retries, no polling loops, and no further Webull calls on app load.
- **Retry happens only when the user asks:** the journal's **Sync now** or a connection-level **"I've approved it, check again"** button. **[Phase 3 plan]** These map to the `check_approval` action (10-second cooldown) and, for a new code, `resend_code` (60-second cooldown, refused while approved). Each makes one approval check. If it succeeds, the state returns to `ok` and sync continues; if not, the state stays `needs_approval`.
- The approval and token endpoints Webull requires are added to the §5 allowlist as named functions. None of them can place orders.

---

## 8. UI

Security details (unchanged):

- Connect form: two password-type fields with `autocomplete="off"`. They are cleared from the DOM and from JS variables as soon as the POST finishes.
- Connected state: "Webull connected · key ••••AB12 · last synced …", with **Sync now** and **Disconnect** buttons.
- **Disconnect** asks for confirmation ("This permanently deletes your stored Webull keys from Denarii") and then calls `disconnect`. Afterwards the UI tells the user to **also revoke the App Key in Webull's developer portal**, because deleting it from Denarii doesn't invalidate it at Webull.
- Settings text explains that Denarii only reads history and never trades.

**[Rev 2.1] Setup instructions and approval state** (text and status only, no redesign):

- Setup text tells the user to apply for Webull OpenAPI access themselves, generate **their own** key, and when generating it **enable Trading and leave Market Data unchecked**. The text explains that Webull requires the Trading permission to read order history, and that Denarii's code never places orders.
- It notes that Webull allows one API key per user. That one connection serves all of the user's Denarii broker accounts.
- When `approval_state = 'needs_approval'`, Integrations and each linked journal show: "Approve Denarii in the Webull app, then tap Sync now," with an **"I've approved it, check again"** button.

**[Rev 2] Placement and per-journal additions.** These reuse the existing settings and broker account modal patterns; nothing is redesigned.

- **Settings → Integrations** (connection level): connect form, "Webull connected · key ••••AB12", **Disconnect**. "Last synced" moves to each journal, because sync is per journal now.
- **Broker account edit modal / list row** (per journal):
  - Linked Webull account (dropdown from `status.accounts`, or "Not linked")
  - Import start date (date picker, labeled "Market date, New York time")
  - Auto-import toggle (default off)
  - Last synced (local time), status (OK / Partial / Error with the safe message / Never), and the skipped-fills count with an expandable list
  - **Sync now** button
  - Start-date change warning (§7.7)
- No new pages, themes or layout changes. Colors use existing theme tokens.

---

## 9. Testing

- Crypto: encrypting and then decrypting returns the original value. Changing any ciphertext, IV, tag or AAD byte makes decryption fail. Two encryptions of the same value produce different IVs.
- **[Rev 2]** Signer: Webull's documented test vector (§5a) produces `kvlS6opdZDhEBo5jq40nHYXaLvM=`.
- RLS: run the anon/authenticated select/insert/update/delete checks from §2.
- **[Rev 2]** RLS for `webull_journal_imports`: user A can't select, insert, update or delete user B's rows. A client can't update the status columns (column grant). Inserting a `journal_id` the user doesn't own fails (FK).
- Responses: a test calls every action and checks the JSON contains none of the strings `ct`, `iv`, `tag` or `secret`, and never the full App Key.
- Identity: sending another user's `user_id` in the body has no effect.
- Disconnect: the row is gone afterwards and `status` reports `connected: false`. Deleting the account also removes the row.
- Read-only: the check script passes, and the allowlist rejects a made-up `/order/place` path.
- **[Phase 3 plan]** `secret-box` tests (`tests/secret-box.test.js`); a cooldown race test for `check_approval` / `resend_code`; response field names never contain "token" (so a grep for the token stays clean).
- **[Rev 2]** Engine (pure functions, fixture fills):
  - two journals plus the same order → two trades, different `externalId`
  - re-running the same window → nothing changes
  - open in sync 1 and close in sync 2 → one trade, same `id`, now closed
  - partial fill that grows across syncs → only the difference is applied
  - a close with no open → skipped and recorded
  - a close larger than the open → excess skipped
  - reversal → one closed trade plus one new open trade
- **[Rev 2]** Sandbox: Webull sandbox keys are **optional** and **separate from production** keys. They aren't the default. Use them only if available; otherwise validate with read-only production calls on a low-activity account.

---

## 10. Risks

| Scenario | Attacker **can** access | Attacker **cannot** access |
|---|---|---|
| **Database leak** (Supabase backup or dump, SQL injection elsewhere, or a leaked service role key alone) | Ciphertext, IVs and tags; App Key last 4; user ids; sync timestamps; Webull account IDs; all non-secret journal tables (trades and so on, which is true today too) | Plaintext App Keys or Secrets. Decryption needs `WEBULL_CREDS_ENC_KEY`, which never touches Supabase. Copying rows between users fails because of the AAD. |
| **Browser compromise** (XSS in Denarii, a malicious extension, malware on the user's device) | That one user's Supabase session, so they can call `status`, `sync` (trade history) and `disconnect` as that user, and read their journal. **Keys typed into the connect form while compromised can be captured.** | Stored keys of any kind: no endpoint returns them, and RLS blocks direct table reads. Other users' data. Placing trades: no such endpoint exists. |
| **Vercel account compromise** (or **GitHub `main`**, since pushes auto-deploy) | **Worst case.** The encryption key and service role key, so every user's Webull App Key and Secret can be decrypted. Webull keys work outside Denarii, so the attacker could call **any** Webull endpoint directly, including order placement. The read-only rule only limits Denarii's own code. They could also deploy code that captures new keys as users enter them. **[Rev 2.1] This is confirmed: Webull has no read-only key scope (Trading covers both reading history and placing orders), so this scenario includes possible order placement in every connected user's account.** | Nothing that would limit them. They can't get users' Webull login passwords. **[Rev 2.1]** There's no IP allowlist to lean on (none is offered). Webull 2FA approval *might* limit an attacker who has keys but no approved token; Phase 2 confirms whether that holds. Until it's confirmed, don't count on it. |

Mitigations for the Vercel/GitHub scenario:
- **[Rev 2.1] Required, not optional:** 2FA on Vercel, GitHub and Supabase for every account with access. Confirm this before Phase 3 deploys any credential handling.
- As few collaborators as possible.
- Branch protection on `main`.
- Env vars marked Sensitive and limited to Production.
- An incident runbook: rotate the encryption key, delete all `broker_credentials` rows, and tell users to revoke their keys at Webull.
- **[Rev 2.1]** Webull offers neither a read-only key scope nor an IP allowlist (Open Questions #4, #5), so neither is planned. Denarii-side controls (the §5 allowlist, the check script, branch protection, required 2FA) are the only defenses against order placement through Denarii.

Other risks:
- A Supabase account takeover with no Vercel access is the same as a database leak: ciphertext only.
- Webull rate limits and history-window limits could make sync incomplete. Show partial-sync status instead of failing silently.

**[Rev 2] Additional risks** (these add to the table above and don't change it):
- Database leak now also exposes `webull_journal_imports` (account links, start dates, skipped-fill summaries). None of it is secret.
- Browser compromise can also change that one user's import settings and trigger syncs for their own journals. It still can't write sync status or reach credentials.
- **Data correctness:** a wrong match could close the wrong open trade. Mitigations: dedupe scoped to each journal; the engine only touches `source === 'webull'` trades in that journal; manual and CSV trades are never changed; imported trades can be found by `source`/`external_id` for a targeted cleanup.
- **Start date moved earlier after fills were skipped:** a replay can rebuild positions differently from the original order. Mitigation: the warning in §7.7 plus the skip list. Covered by engine tests.
- **Webull data lag:** Order History may trail real time. The 24-hour overlap re-reads recent fills.

---

## 11. [Rev 2] Phased rollout

Each phase fits in a single Claude Code session, ends in its own commit, and is validated on the deployed Vercel app (as `docs/cloud-first-workflow.md` requires). Phases 1–6 don't change anything for users.

| # | Phase | Files touched | Data paths touched | Risk | Rollback | Supabase steps before deployed testing | Validate on deployed Vercel app |
|---|---|---|---|---|---|---|---|
| 1 | **Schema (additive)** — **COMPLETE 2026-10-18.** Run in production via `supabase/webull-phase1.sql` (verify: `webull-phase1-verify.sql`, rollback: `webull-phase1-rollback.sql`); all verify checks passed. Unique index as built: `trades_user_journal_external_id_uq` on `(user_id, broker_account_id, external_id)`. Browser-console checks not yet recorded. | `supabase/schema.sql` | New: `broker_credentials`, `webull_journal_imports`; `trades` + 2 nullable columns + partial unique index | Low (additive; existing rows unaffected) | `DROP TABLE` the two new tables; `DROP INDEX`; `ALTER TABLE trades DROP COLUMN` ×2 (all empty) | Run the §2 / §2a / §2b SQL in the SQL Editor (**[Rev 2.1]** includes `approval_state`, `approval_checked_at` and the `needs_approval` status value); confirm RLS on and policies/grants as written | Signed in, in the browser console using the app's Supabase client: `broker_credentials` select/insert are denied; `webull_journal_imports` own-row CRUD works; status-column update is denied; app loads and existing trades save normally |
| 2 | **Signer + read-only client (no endpoint) + [Rev 2.1] live confirmation** | `api/_lib/webull-sign.js`, `api/_lib/webull-readonly.js`, `scripts/check-webull-readonly.js`, signer test file; **[Rev 2.1]** findings recorded in this plan (§5a, §7.8, §12) | None in Supabase. **[Rev 2.1]** Read-only Webull calls made locally with the owner's own key from local env vars (never committed, never logged) | Low (not reachable from the web) | Revert commit | None | Run the signer test locally (Node) to reproduce the §5a vector; run the check script; deploy and confirm there's no new public route and the app still works. **[Rev 2.1]** Using a key with **Trading only (Market Data unchecked)**: confirm the account list and order history work. If order history needs Market Data, record that in §8 and §12. Confirm the 2FA approval flow, how often re-approval is required, and whether a token has to be stored (§7.8). |
| 3 | **Credential endpoints** (`connect` / `status` / `disconnect`) **+ [Rev 2.1] approval state** **[Phase 3 plan]** (+ `check_approval` / `resend_code`). **Implementation plan: `docs/webull-phase3-plan.md`** (sessions 3A / 3B / 3C). **3A COMPLETE 2026-10-18:** token columns added via `supabase/webull-phase3.sql` (ran twice; all verify checks passed), plus `secret-box.js`, `auth.js` and the `delete-account.js` cleanup. Deploy check passed 2026-10-19 (throwaway account deleted through Denarii; 0 rows left for that user in `trades`, `broker_accounts`, `broker_credentials`, `webull_journal_imports`, and 0 orphans across all 17 public tables with `user_id`). **3B COMPLETE 2026-10-19:** `api/webull.js` with `connect` / `status` / `disconnect`, the `vercel.json` entry, and `tests/webull-endpoint.test.js`. App Key validation fixed to allow `.` (real keys are `us.` plus letters and digits, 35 characters). Deployed tests 1–7, 10 and 15–17 passed in production: bad keys rejected with nothing saved and no text; real keys connected as `needs_approval` with a text code; body `user_id` ignored; 60-second connect cooldown returned 429; `status` made no Webull call; table shows base64 ciphertext only with `key_version` 1; no secrets in responses or Vercel logs; `disconnect` removed the row. **3C COMPLETE 2026-10-19 (Phase 3 complete):** `check_approval` and `resend_code` with atomic cooldown claims, the §4 state mapping and Account List verification. Deployed tests 8, 11–14 passed in production: pending check → `needs_approval` with the approve message; check after 6+ minutes → expired message (first live expired handling); `resend_code` sent a new text (nested claim filter worked against real Supabase); after entering the code, `check_approval` → `ok` with 2 accounts as `{id, label}` only, no `account_number`; `resend_code` while approved → 409 with no text; row holds ciphertext only with separate IVs/tags; no secrets or `account_number` in responses. Approved token `expires_at` was 15 days after creation (§7.8). | `api/_lib/auth.js`, `api/_lib/secret-box.js`, `api/webull.js`, `vercel.json`, `api/delete-account.js` (add the two tables); **[Phase 3 plan]** `supabase/webull-phase3.sql`, `webull-phase3-verify.sql`, `webull-phase3-rollback.sql`, `supabase/schema.sql`, `tests/secret-box.test.js`, `tests/webull-endpoint.test.js`, `package.json` | `broker_credentials` (server writes, including `approval_state`; encrypted token columns only if Phase 2 requires them) | Medium (handles secrets) | Revert commit; delete any `broker_credentials` rows; remove the env var; drop the token columns if added (empty) | **[Rev 2.1]** First confirm 2FA is on for every Vercel, GitHub and Supabase account (required). Vercel: add `WEBULL_CREDS_ENC_KEY` (Sensitive, Production). Confirm `SUPABASE_SERVICE_ROLE_KEY` exists. **[Phase 3 plan]** Run `supabase/webull-phase3.sql` and its verify script (the account-list path is already confirmed, §5a.1). | From the console, `fetch('/api/webull', …)` with the session token: `connect` → response has only `connected`/`last4`/`accounts` (**[Rev 2.1]** plus `approvalState`); **[Phase 3 plan]** `connect` returns `needs_approval` with `accounts: []`, and `check_approval` after the texted code is entered returns `ok` plus the accounts (tests 1–18 in `docs/webull-phase3-plan.md` §6); Supabase table viewer shows ciphertext only; `status` works; `disconnect` removes the row; Vercel logs show no secrets. **[Rev 2.1]** Leave a Webull approval pending: `status` reports `needs_approval`, and "check again" makes exactly one Webull call. |
| 4 | **Settings → Integrations UI** — **COMPLETE 2026-10-19.** Commit "Webull sync phase 4: Settings Integrations UI" (`settings.js?v=3`). Deployed tests passed in production (Settings → Integrations): connected state showed "Webull connected · key ••••12e4", account labels Individual Cash and Individual Margin, and Disconnect; Disconnect → Cancel changed nothing; Disconnect → OK showed the revoke-at-Webull note and the empty connect form; connect with real keys cleared both fields and showed the needs-approval state with the approve message, "I've approved it, check again", "Send new code" and Disconnect; Webull texted a code and the Webull app popped up the code box; after entering the code, "I've approved it, check again" switched to the connected state with both account labels. Note: the first Phase 4 deploy sat in Vercel's queue for about 7 minutes before building on its own; not a code issue. | `js/pages/settings.js`, `index.html` (cache-bust version) | Calls `api/webull.js` only | Low | Revert commit (server and keys unaffected) | None | Connect, see `••••last4`, fields cleared, Disconnect shows the confirm and revoke-at-Webull note; nothing secret in DevTools Network responses. **[Rev 2.1]** Setup text says apply for your own OpenAPI access, generate your own key, enable Trading and leave Market Data unchecked, and that one key serves all broker accounts; the `needs_approval` message and "I've approved it, check again" button show and work. |
| 5 | **Per-journal link settings UI** — **COMPLETE 2026-10-19.** Commit "Webull sync phase 5: per-journal link settings" (`broker-accounts.js?v=2`). Deployed tests passed in production: Add mode showed only the "save first" note; Edit showed the dropdown (Not linked, Individual Cash, Individual Margin), an empty date, and auto-import off; a future date (11/02/2026) was blocked with "Choose a past or current start date."; J1 linked to Individual Cash with 10/02/2026 and auto-import off, and J2 linked to the same Webull account with 10/01/2026 and auto-import on; SQL showed two rows with the same `webull_account_id` (J1 `2026-10-02 04:00:00+00` false, J2 `2026-10-01 04:00:00+00` true); renaming J1 and pressing Save Account saved normally; setting J2 to Not linked + Save removed only J2's row ("Webull link removed.") and J1's row remained; deleting J1 and J2 removed their link rows (cascade) and the query returned no rows. | `js/pages/broker-accounts.js`, `index.html` (cache-bust) | `webull_journal_imports` (client CRUD via RLS) | Low–Medium (new rows only) | Revert commit; delete `webull_journal_imports` rows (trades untouched) | None beyond Phase 1 | Link two journals to the same Webull account with different start dates; ET date shows correctly after reload; toggle off on one doesn't affect the other; hiding a journal leaves its row unchanged; local-only account shows the "save to cloud first" message. **[Rev 2.1]** A journal with status `needs_approval` shows the approval message. |
| 6 | **Server `sync` + `commit` (no trade writes)** — **COMPLETE 2026-10-20.** Commit 6261356, tested on production 2026-10-20 (WB-Margin from 2026-07-01, WB-Cash from 2026-10-01); `webull-readonly.js` needed no change. Deployed tests passed: two 90-day windows chained with no duplicates at the boundary (173 unique fills in 2 calls); `pagination_key` paging worked (169 groups in 2 pages, partial false); injected cursor, `windowStart`, `user_id` and a future cursor were ignored; `commit` rejected a future `windowEnd` with 400, moved the watermark forward only, and the next sync started exactly 24 h before `last_synced_at`; no `account_number`, token, secret or ciphertext in responses; Vercel logs only `[webull] <id> <action> <category>`; `trades` unchanged (1570 rows, 0 with `external_id`). Findings in §12 #2, #3 and "Phase 7 inputs". | `api/webull.js`, `api/_lib/webull-readonly.js` | Reads `webull_journal_imports`, `broker_credentials`; writes status/watermark columns | Medium (first real Webull data) | Revert commit; reset status columns to `never` / null | Confirm the Order History parameter names and the max range (Open Q2) | Console: `sync` for a linked journal returns normalized fills, `windowStart`/`windowEnd` match §7.2, `nextCursor` loops to null; an injected bad window in the body is ignored; error shows the safe message in the status columns; rate limit respected (check timing in logs). **[Rev 2.1]** With approval pending or expired, `sync` sets `needs_approval` on the connection and the journal, uses the fixed approval message, and doesn't loop. |
| 7 | **Client engine, dry run** — **COMPLETE 2026-10-21.** Commits 217056c (engine), a62a12b (session lookup fix), 30bd6b5 (wait between sync calls, retry once on 429). Tested on production 2026-10-21; results in §12 "Phase 7 results". | `js/services/webull-sync.js` (new), `index.html` (script tag + cache-bust), engine test fixtures | Read-only on `journalData.trades` | Low (writes nothing) | Revert commit | None | Sync now in **preview mode** shows what would be created, updated or skipped for a journal; two journals on the same account preview independently; every §9 engine fixture passes |
| 8 | **Commit writes (console only)** — **COMPLETE 2026-10-21.** Commit e82da6c, tested on production 2026-10-21; results in §12 "Phase 8 results". Sync now button moved to Phase 9. `WebullSync.importTrades(journalId)`: guard (test journals only via `PHASE8_TEST_JOURNAL_IDS`, cloud-primary, one run per tab) → sync → validate (sync complete, no partial window, `qtyBalanced`, every create/update is a `source='webull'` trade of this journal, no existing id or `externalId`) → one `_saveTradesToSupabase` batch (the CSV import's save; capped at 500 rows so it is a single all-or-nothing upsert) → update `journalData` + the CSV import's refresh → `commit` with the last `windowEnd`. Never commits after a failed save; never deletes. Updates copy only engine-owned fields onto the current trade. Money rounded to cents, prices to 4 decimals (`MONEY_DP` / `PRICE_DP`). **Sync now button moved to Phase 9.** "Two journals on one Webull account" and "same trade ID across syncs" are fixture-only (`tests/webull-engine.test.js`). | `js/services/webull-sync.js`, `js/auth.js` (`_mapArrayRow` / `_mapSupabaseTradeRow`: `external_id`, `external_order_ids`, `webull_partials`, written only for `source='webull'`), `supabase/webull-phase8*.sql`, `supabase/schema.sql`, `tests/webull-engine.test.js`, `tests/webull-mapper.test.js`, `tests/helpers/auth-mappers.js`, `package.json`, `index.html` (cache-bust) | `trades` (insert/update `source='webull'` only), `journal_backups` + IndexedDB via the existing `saveToIndexedDB`, `commit` | **High** (writes user trades) | Revert commit. Data rollback: §12 "Phase 8 rollback" (browser step first, then `supabase/webull-phase8-rollback.sql` PART A). Manual, CSV and demo trades are never touched. | Run `supabase/webull-phase8.sql` (adds `trades.webull_partials`, snapshots `trades` to `trades_backup_phase8`) **before** pushing; verify with `webull-phase8-verify.sql` | Console on WB-Margin: forced save failure leaves the watermark NULL; import creates 78 (1570 → 1648, 78 with `external_id`); a second import creates 0; the watermark moves only after the save; Pelosi stays 1570; a Pelosi edit after import sticks; a fresh browser loads the same 78 with `externalId` / `externalOrderIds` and previews 0 to create |
| 9a | **Sync now button and status display** — **COMPLETE, tested on production 2026-10-21;** results in §12 "Phase 9a results". Sync now in the broker account edit modal calls `WebullSync.importTrades` (test journals only, `PHASE8_TEST_JOURNAL_IDS` kept); fixed inline messages per stage, never the raw error; `last_sync_error` shown only for error / partial / needs_approval; Merge blocked for `source='webull'` trades. | `js/pages/broker-accounts.js`, `Denarii.js` (`_dashCheckMergeCompat`, `_dashPruneSelection`, SIDE column), `index.html` (cache-bust, modal height), `tests/webull-ui.test.js`, `package.json` | Same as Phase 8 (through `importTrades`); reads `webull_journal_imports` | Low–Medium (UI on the tested Phase 8 path) | Revert commit. Data rollback: §12 "Phase 8 rollback" | None | Sync now on WB-Margin and WB-Cash; double-click; forced failure (blocked `/api/webull`); a stale SQL-set error cleared by a successful sync; Merge blocked for Webull trades; trades total and Pelosi count unchanged |
| 9b | **Auto-sync on app load** — **COMPLETE.** Commit 0482579, tested on production 2026-10-23; results in §12 "Phase 9b results". | `js/services/webull-sync.js`, the app-load hook (call site after cloud-primary load; locate at the start of the phase) | Same as Phase 8 | Medium | Revert commit (manual sync still works) | None | With auto-import on for one journal and off for another: load the app, only the enabled one syncs; reload within 5 minutes and it skips; force a failure (disconnect keys) and the app still loads normally while that journal shows the error status; Sync now still works. **[Rev 2.1]** With `approval_state = 'needs_approval'`, reloading makes one `status` call and **no** Webull calls (check the Network tab and Vercel logs), and the journals keep showing the approval message. |
| 10 | **Hardening and docs** — **Webull rollout (Batch F) COMPLETE.** Commit 4c8f3b7, tested on production 2026-10-26; results in §12 "Batch F results". Sync now and auto-sync work for any linked journal (`PHASE8_TEST_JOURNAL_IDS` removed); one journal per Webull account (browser check + unique index `webull_journal_imports_user_account_uq`). The hardening checks in this row (`/security-review`, RLS re-check, Vercel log and response-content checks) are not yet recorded. | `docs/deploy-checklist.md`, `supabase/schema.sql` (verified RLS notes), this plan | None | Low | Revert commit | Re-run the §9 RLS checks against production | Run `/security-review`; check Vercel logs for secrets; run the response-content test for every action; record the results |

---

## 12. Open questions

1. **Exact paths** for account list, balance, positions and order detail. **Confirmed live 2026-10-18:** host `api.webull.com`; `GET /trading/accounts/list`; `GET /trading/orders/historical-orders/list`; `POST /auth/tokens/create`; `POST /auth/tokens/check` (§5a.1). *Still open:* balance, positions and order detail (not needed until those functions are used).
2. **Order History parameters.** **Confirmed live 2026-10-18:** `account_id` (required), `start_time`, `end_time` (`yyyy-MM-ddTHH:mm:ss.SSSZ`); a 30-day range was accepted; the response is `{ data: [...], pagination_key? }`, and the next page is requested with `pagination_key`. **From the reference (not yet seen with real orders):**
   - **Range and paging, confirmed live 2026-10-18 (second run, margin account):**
     - A **90-day range was accepted in one call**. No maximum range is documented, and the true maximum is still untested beyond 90 days. History starts 2018-05-21.
     - The first page held **100 order groups** plus a `pagination_key`, so the page size is about 100 groups. There's no `page_size` parameter. Group orders may push a page past 100.
     - Phase 6 must loop on `pagination_key` (2 req / 2 s). With paging confirmed, it uses 90-day windows (§7.2).
   - **Phase 6, confirmed live 2026-10-20 (WB-Margin, window 2026-07-01 to 09-29):** `pagination_key` works as the **request** parameter; the window returned 169 order groups across 2 pages, partial false. Chained 90-day windows returned 122 + 51 kept fills, 173 unique, no duplicates at the boundary.
   - **Phase 6 status data:** all 173 kept fills were `FILLED`; no `PARTIAL_FILLED` orders appeared, and no cancelled orders had fills (`cancelledWithFills` 0 in both windows).
   - *Still open:* whether `start_time` filters on place time or fill time (GTC orders placed before a window); how long a `pagination_key` stays valid between calls; whether `PARTIAL_FILLED` occurs in practice (none in 173 fills; not proven impossible).
   - **Results are whole orders, not fills (confirmed live).**
     - `data[]` holds order groups: `client_order_id`, `combo_order_id`, `combo_type` (`NORMAL` seen), `orders[]`.
     - Each order has `total_quantity`; `filled_quantity` (cumulative); `filled_price` (**average**); `place_time` / `filled_time` (epoch ms, as strings); `place_time_at` / `filled_time_at` (ISO UTC; filled = **last** execution). One price per order, no per-execution list.
     - Per-execution detail would need the separate executions endpoint (the SDK has `get_order_executions`), not reviewed.
     - **Cancelled orders are included** (`status` values seen: `FILLED`, `CANCELLED`). The engine must keep only `FILLED` / `PARTIAL_FILLED` and use `filled_quantity`, not `total_quantity`.
   - **All order fields seen live:** `client_order_id, commission, entrust_type, fees, filled_price, filled_quantity, filled_time, filled_time_at, instrument_type, legs, limit_price, option_strategy, order_id, order_type, place_time, place_time_at, position_intent, side, status, stop_price, support_trading_session, symbol, time_in_force, total_quantity`.
   - **Leg fields seen live:** `expiration_type, id, option_category, option_contract_deliverable, option_contract_multiplier, option_expire_date, option_type, quantity, side, strike_price, symbol`.
   - **Not in the reference schema but returned live:**
     - `fees` is an array of `{ type, actual_value, receivable_value }`, with types such as `SEC_FEE`, `REGULATORY_FEE` and `CLEARING_FEE`.
     - `commission` is an object (empty in the samples).
     - `legs[].expiration_type` (`PM` seen).
   - **IDs, as seen live:**
     - For `NORMAL` orders, `orders[].order_id` equals `combo_order_id`, and an option's `legs[].id` equals its `order_id`.
     - `client_order_id` repeats at group and order level.
     - Use `orders[].order_id` as the Webull order ID in §7.1.
3. **Side and position-effect fields (confirmed live 2026-10-18 on 100 margin-account orders, with stock, short and option samples):**
   - Values seen: `side` = `BUY` / `SELL` / `SHORT`; `instrument_type` = `EQUITY` / `OPTION`.
   - **Short sale to open:** `side: "SHORT"` (sample: `MUU`, `EQUITY`, 786 shares, filled, with a `SEC_FEE` fee).
   - **Sell to close a long:** `side: "SELL"`, so an equity `SELL` is never a short open.
   - **Equities have no `position_intent`** (absent on stock records), so **buy-to-open vs. buy-to-cover is not marked**. A `BUY` covers when this journal holds an open short in that symbol, and otherwise opens a long (§7.3/§7.4).
   - **Options carry `position_intent`.** Seen live: `BUY_TO_OPEN`, `SELL_TO_CLOSE` (sample: `MSFT` 537.50 `CALL` exp 2026-10-16, `BUY_TO_OPEN`, 8 contracts). `SELL_TO_OPEN` / `BUY_TO_CLOSE` weren't in this page.
     - *Still open:* whether every option record has `position_intent`. The live tally mixed equities (no field) with options, so a missing value on an option couldn't be told apart. Until it's checked, an option record without `position_intent` falls back to position state.
     - **Phase 6, live 2026-10-20 (173 fills):** all 72 option fills had `position_intent`, only `BUY_TO_OPEN` and `SELL_TO_CLOSE`. `SELL_TO_OPEN` / `BUY_TO_CLOSE` weren't present; that doesn't prove they can't occur, so the fallback stays.
   - **Phase 6, live 2026-10-20:** all 101 equity fills had `position_intent` null; sides were `BUY` 47, `SELL` 52, `SHORT` 2.
   - Option contract identity comes from `legs[]`: `symbol` (underlying), `option_type`, `strike_price`, `option_expire_date`, `option_contract_multiplier`. `option_strategy` was `SINGLE`. Multi-leg combos weren't seen.
4. **RESOLVED [Rev 2.1]: no read-only scope.** The key page offers two permissions, Market Data and Trading. Trading covers both reading order/account history and placing orders. Denarii's read-only allowlist module (§5) is the only protection against order placement in Denarii code. Users enable **Trading** and leave **Market Data unchecked**; if Phase 2 testing shows order history needs Market Data, record it here and in §8. See §10 for the effect on risk. **Live 2026-10-18:** token, account list and order history all worked with **Trading and Market Data both checked** on the key. **Trading-only (Market Data unchecked) is NOT confirmed and remains untested.** Test it before the §8 onboarding text tells users to leave Market Data unchecked.
5. **RESOLVED [Rev 2.1]: no IP allowlist.** The key page shows no IP allowlist option, so none is planned. *Still open:* allowed signature clock skew and nonce format. Live 2026-10-18: a 32-character lowercase hex nonce was accepted. The SDK uses a 36-character UUID string.
6. **RESOLVED [Rev 2.1]: one key per user.** Each user applies for their own Webull OpenAPI access and generates their own key. Webull allows one API key per user/account, and all of a user's Denarii broker accounts share that one connection (one `broker_credentials` row; §2). The onboarding text in §8 reflects this.
7. **RESOLVED [Rev 2.1]: journal = `broker_accounts` row.** Starting a new journal for the same Webull account means creating a new `broker_accounts` row. The §2a design is unchanged.
8. Grouped CSV trades keep a `fills[]` array locally, but cloud `trades` has no fills column. Should imported Webull trades also store per-fill detail in the cloud, or are `external_order_ids` plus the summary enough?
9. **New [Rev 2.1], Phase 2:** How does Webull 2FA approval behave for API keys ("Enable 2FA Verification" is on)? Need: the token request and approval flow, how often re-approval is required, the pending/expired response shape, and whether a token must be stored (§2, §7.8). **Mostly confirmed live 2026-10-18 (§7.8):**
   - The flow is create → text code → the Webull app pops up a code box automatically → enter the code → check returns `NORMAL`. Approval took 16–31 s on the first run and ≤15 s on the second. Every new token needs a new code.
   - The statuses seen were `PENDING` and `NORMAL`. The response shape is `{ token, expires_at, status }`.
   - **A token must be stored.**
   - **[Phase 3B, confirmed 2026-10-19 via `/api/webull` `connect`]** A `PENDING` token's `expires_at` is about 5–6 minutes after creation, and the endpoint's parser reads it (stored value not null).
   - **[Phase 3C, confirmed live 2026-10-19 via `/api/webull` `check_approval`]** An approved (`NORMAL`) token's `expires_at` is **15 days after creation** (created 2026-10-19 22:09:14 UTC, expires 2026-11-03 22:09:58 UTC), and the endpoint's parser reads it. A pending token checked after 6+ minutes was handled as expired (`needs_approval`, "Tap Send new code"); the endpoint maps `EXPIRED` and `INVALID` the same way, so which one Webull returned wasn't recorded.
   - *Still open:* whether regular use extends an approved token's expiry or re-approval is needed every 15 days regardless (check on or after 2026-11-03), and what a read call returns with an expired or invalid token (status code and `error_code`).

**Phase 7 inputs from live data (Phase 6, 2026-10-20):**
- Real `SHORT` orders exist (2). Their covers arrive as plain `BUY` orders with no intent, so some `BUY`s are covers. Position state must decide.
- Equity `SELL` orders (52) outnumber `BUY` orders (47). Order counts aren't share counts, so scale-outs may explain part of this, but some `SELL`s may close longs opened before the start date. Phase 7 must handle a `SELL` with no matching open position, not only a `BUY` covering a pre-start short.

**Phase 7 results (2026-10-21)** (WB-Margin, start 2026-07-01, watermark reset first):
- Preview: 181 unique fills, 2 windows, 2 calls, 0 duplicates; 78 trades to create, 0 updates, 0 skipped, 0 open at end; `qtyBalanced` true; no warnings. A second run gave identical results.
- User confirmed the Margin account holds no positions, matching 0 open at end.
- 0 skipped: the 52 `SELL` vs 47 `BUY` imbalance was scale-outs, not pre-start longs.
- Shorts: MU (21 sh, 917.30 → 911.66 blended cover, +118.13) and MUU (786 sh, flat price, −0.42 fees) closed correctly by `BUY` covers; P&L matched the short formula.
- Option: `MSTR260702C00102000`, 8 contracts, 1.82 → 1.11, fees 0.77, P&L −568.77, matching (exit − entry) × qty × 100 − fees.
- Slice pricing is FIFO, matching the CSV import (`matchTradePairs` / `_emitSlice` in `Denarii.js`).
- WB-Cash preview returned 0 fills with no error.
- `trades` unchanged: 1570 total, 0 with `external_id`. No `commit` calls.
- Bugs fixed during testing: the engine looked up `window.SupabaseAuth` (a top-level const, not on `window`); `fetchAllFills` sent follow-up `sync` calls with no wait and Webull returned 429. Fixed with a 2000 ms gap between calls and one retry after 5000 ms on 429.

**Phase 8 carry-forward:**
- Round money fields (`pnl`, `grossPnl`, prices, fees) to cents before saving, as the CSV import does. Live P&L showed float noise (118.12999999999792).
- Confirm the cloud `trades` row preserves `webullPartials`, `fills`, `externalId` and `externalOrderIds` before any save.
- An open position spanning two syncs is seeded as one lot at its average price, so per-slice FIFO prices across a sync boundary are approximate. Total P&L stays exact.
- Auto-import should tolerate a 429 (the engine already retries once); decide what the user sees if both attempts fail.
- Phase 6 failures leave `last_sync_status` as error/partial until the next `commit`; the UI shouldn't show that as a current failure after a later successful sync.
- Broker accounts live in `journalData.brokerAccounts`; the name field is `displayName`.
- Don't link a real journal until Phase 8 save and commit ordering is tested.

**Phase 8 implementation notes (2026-10-21):**
- Carry-forward handled: cents rounding (prices at 4 decimals, see §11 row 8); field survival (mapper + `webull_partials` + `type || direction`); a successful import's `commit` sets `last_sync_status = 'ok'`; real journals blocked by `PHASE8_TEST_JOURNAL_IDS`.
- Still open: per-slice FIFO prices across a sync boundary (one average lot; totals exact); what auto-import shows when the 429 retry also fails (Phase 9); the UI showing a stale error/partial status (Phase 9); Sync now button (Phase 9).
- The CSV import does **not** round money; it stores raw floats. Rounding is Webull-only.
- **Load paths (checked in `js/auth.js`):** a same-browser sign-in loads the local IndexedDB cache (`loadFromIndexedDB`), not the rows. If there is no local journal record, `loadFromIndexedDB` reads the `journal_backups` blob automatically and caches it; only if the blob is also missing does a cloud-primary account load from rows. A fresh browser (no local auth record) loads from rows. "Restore from Cloud" (stranded account) reads the blob when clicked. Every save then shadow-writes **all** cached trades (upsert only, never delete).
- **Phase 8 rollback** (cache and blob first, so a later save can't re-insert deleted rows):
  1. Close every Denarii tab and window except one, signed in. On any other browser or device that opened the journal after the import, sign out and clear Denarii's site data before step 3.
  2. In that tab's console, remove the imported trades locally and rewrite the IndexedDB cache and the `journal_backups` blob:
     ```js
     const RB = ['ba_1792516090168_r2mg8', 'ba_1792516127580_nww4g'];
     const n0 = journalData.trades.length;
     journalData.trades = journalData.trades.filter(t => !(t.source === 'webull' && RB.includes(t.brokerAccountId) && String(t.externalId || '').startsWith('webull:')));
     console.log('removed locally:', n0 - journalData.trades.length);
     _lastCloudSaveMs = 0;   // lift the 60 s blob debounce so this save writes journal_backups
     await saveToIndexedDB();
     ```
     Then confirm `journal_backups.last_saved` for your user is from the last minute.
  3. Run `supabase/webull-phase8-rollback.sql` PART A and its verify queries (1570 / 0 / 1570; watermarks NULL / `never`).
  4. Reload, sign in, and confirm `journalData.trades.filter(t => t.source === 'webull').length === 0` before saving anything.

**Phase 8 results (2026-10-21)** (WB-Margin and WB-Cash test journals):
- Pre-deploy SQL ran first: `webull_partials` JSONB added; `trades_backup_phase8` snapshot = 1570 rows.
- Guard: `importTrades` on the Pelosi journal returned stage `guard` with no `/api/webull` call.
- Forced save failure: stage `save`, committed false; trades stayed 1570, watermark stayed NULL.
- Real import: ok true, created 78, updated 0, skipped 0, committed true, `lastSyncedAt` 2026-10-21T18:24:11.742Z. Supabase: 1648 total, 78 with `external_id`, 1570 without; 0 rows with `external_id` outside `source='webull'` + WB-Margin; `last_sync_status` `ok`.
- Second import: created 0, updated 0, committed true, watermark moved forward. WB-Cash import: created 0, committed true.
- Pelosi edit (reflection text) saved and survived a reload; trade count unchanged.
- Fresh cloud load (Incognito, from Supabase rows): 1648 trades, 78 Webull, all with `externalId` and a non-empty `externalOrderIds` map.
- Imported P&L for the 78 trades: total −7055.48 (stocks −332.16, options −6723.32), fees 42.87. Comparison with Webull's realized P&L pending (user).
- Hiding broker accounts in the UI excludes the Webull trades from dashboard metrics, as expected.
- Test-script note: `externalOrderIds` is an object map `{orderId: filledQty}`, not an array. Check it with `Object.keys(...).length`, not `.length`.

**Phase 9 carry-forward:**
- **Done (9a):** Sync now button in `broker-accounts.js` (moved from Phase 8).
- **Done (9a):** UI for `last_sync_status`: don't show an old error/partial as current after a later successful sync.
- **Done (9a):** What the user sees when a 429 retry also fails ("Webull didn't respond…").
- **Done (Batch F, 4c8f3b7, tested on production 2026-10-26):** `PHASE8_TEST_JOURNAL_IDS` guard removed; Sync now and auto-sync work for any linked journal.
- **Done (9a):** Merge Trades deletes absorbed trades; merging imported Webull trades breaks sync matching. Merge is now blocked for `source='webull'`.
- Still open: per-slice FIFO prices across a sync boundary use one average lot (totals exact).
- `trades_backup_phase8` can be dropped once Phase 9 is stable.
- **Done (6c3227e, tested on production 2026-10-23):** Allow merging Webull trades by keeping all absorbed trades' `externalOrderIds` on the merged trade, instead of blocking.
- Other code may read `t.type` on cloud page rows and have the same blind spot as the SIDE column. Check before Phase 10.
- Pelosi demo seed: some trades have a side and P&L that don't match (example: AAPL 4/16/2024 shown Short, 210.84 → 222.34, +1932). Demo data only.
- Broker account card trade counts may lag after a sync until the user navigates away and back.
- **Done (8e1c71f, tested on production 2026-10-23):** Non-Webull merges still ignore cloud save and delete failures (absorbed trades can be deleted even if the primary save failed). Apply the same checks to all merges.
- The dashboard trades table has no account column, so Pelosi and Webull trades on the same symbol can't be told apart at a glance.
- `trades_backup_phase9_merge` can be dropped once this is stable, alongside `trades_backup_phase8`.
- Non-Webull merges do not round money fields to cents (merged P&L stored as -241.04000000000002). Webull merges already use `roundTrade`.
- **Done (d21cf79, tested on production 2026-10-24):** Stop the trades shadow write in cloud_primary mode (`js/auth.js`), so a stale browser cannot overwrite or resurrect cloud trades.
- A hard reload logs the user out in some tabs but not others. Investigate whether this is intended lock-screen behavior.
- `trades_merge_backup_20261023` can be dropped once the shadow-write fix is done.

**Phase 9a results (2026-10-21)** (WB-Margin and WB-Cash test journals):
- Sync now on WB-Margin imported 1 new trade (78 → 79). A second sync and WB-Cash showed "Synced: no new trades." Supabase: 1649 total, 1570 Pelosi, 79 with `external_id`.
- Forced failure (fetch to `/api/webull` blocked): red "Webull didn't respond. Nothing was saved…" message, no raw error, status unchanged.
- A stale error set by SQL showed Status Error with the error text; the next successful Sync now cleared it (`last_sync_status` ok, `last_sync_error` NULL).
- Merge is blocked for selections that include `source='webull'` trades; Pelosi merges of matching trades still open the picker.
- Fixes found during testing:
  - Hidden-account trades stayed in the selection after hiding accounts. They are now pruned, which also stops Delete Selected from deleting hidden trades.
  - The Edit Broker Account modal is capped at 90vh with a scrolling form and a sticky Save/Cancel bar.
  - The SIDE column read `t.type`, which cloud rows don't set, so every row showed Short. It now reads `type` or `direction`. This predates the Webull work.

**Webull merge results (2026-10-23)** (WB-Margin):
- Backup `trades_backup_phase9_merge` taken first (79 WB-Margin rows).
- Merged two closed CWVX long stock trades (1792607051911 primary, 1792607051914 absorbed): one row remains with qty 765 (378+387), P&L -373.53 (-264.88 + -108.65), fees 0.57, primary `external_id` kept, 4 order IDs (2+2).
- Watermark reset to NULL and full dry-run preview from 2026-07-01: 183 fills already imported, 0 updated, 0 skipped, `qtyBalanced` true. The 4 creates were genuine new trades from 2026-10-22 (SPOT x2, AMZN options x2); none was CWVX.
- Sync now then imported those 4. Merged trade unchanged. Supabase: 1652 total, 1570 Pelosi, 82 with `external_id`.
- Mixed selection (Webull AAPL option + Pelosi AAPL option, both long) blocked with "Imported Webull trades can only be merged with other imported Webull trades." Pelosi-only merges still open the picker.
- `fills[]` is not stored in the cloud row; a Webull merge after a fresh cloud load keeps totals and order IDs but builds one fill per merged trade.

**All-merges save check results (2026-10-23)** (Pelosi XOM long stock pair: 1711148005854 primary qty 40, 1710126869438 absorbed qty 16):
- Backup `trades_merge_backup_20261023` taken first (2 rows).
- Forced save failure (console wrapper on `_saveTradeToSupabase`, primary only): alert "Failed to save merge: ... Your data was not changed."; Supabase rows unchanged, nothing deleted.
- Forced delete failure (console wrapper on `_deleteTradesFromSupabase`, absorbed id only): alert "... Nothing was merged. Reload the page and try again."; merged primary saved, then original primary re-saved; Supabase rows unchanged.
- Normal merge: one row remains, qty 56, P&L -241.04. Restored from the backup by SQL; Supabase back to 1652 total, 1570 Pelosi.
- Cloud-primary merges with no cloud context are now blocked with "Failed to save merge" instead of merging locally (approved behavior change).

**Phase 9b results (2026-10-23)** (WB-Margin and WB-Cash):
- Test 1 (WB-Cash only): first attempt correctly skipped with "Webull auto-sync skipped: cached trades differ from cloud." The browser cache was stale (1651 trades with a merged XOM row) after a merge was rolled back by SQL. After clearing site data and loading from the cloud, auto-sync ran on sign-in: status, sync, commit; modal showed "Auto-sync: Synced: no new trades."
- Test 2 (throttle): reload within 15 minutes made 0 `/api/webull` calls.
- Test 3 (hidden journal, D2): WB-Cash hidden still synced (status, sync, commit). Approved deviation from §7.5: visibility is display-only; the auto-import toggle decides.
- Test 4 (two tabs): both tabs unlocked within seconds; only one made status, sync, commit; the other made none.
- Test 5 (both journals): one status call, then sync and commit for WB-Margin, then sync and commit for WB-Cash, about 4 s apart. Both `last_sync_status` ok. Trades unchanged at 1652 total, 1570 Pelosi.
- WB-Margin auto-import turned back off after testing.

**Incident during Phase 9b testing (2026-10-23):**
- Before the cache was cleared, a save in the stale browser re-uploaded its cached trades and overwrote trade 1711148005854 in the cloud with the merged version (qty 56, P&L -241.04), while the absorbed trade 1710126869438 still existed. Restored from `trades_merge_backup_20261023` by SQL.
- Confirms the risk: `saveToIndexedDB` shadow-writes every cached trade in cloud_primary mode. Fix is the next priority in "Phase 9 carry-forward".

**Shadow-write fix results (2026-10-24)** (commit d21cf79):
- Backup `trades_backup_shadowfix_20261024` (1652 / 1570 / 82) taken first.
- Stale note: tab B saved SHADOWFIX-B on trade 1711148005854; stale tab A made two unrelated saves; no `/rest/v1/trades` requests from tab A; the note stayed in the cloud.
- Stale delete: ZZTEST1 created, loaded in tab A, deleted in tab B; stale tab A saved; no trades requests; ZZTEST1 stayed deleted.
- Clean-cache write paths: New Trade, Edit Trade and Journal edits persisted to the cloud.
- Forced save failure (console wrapper): Journal and New Trade showed "Save failed"; Journal draft and New Trade form kept; nothing written. After restoring saves, both saved; exactly one ZZTEST3.
- Merge of two ZZTEST4 trades: one row, qty 2. Delete Selected removed the remaining test trades.
- Broker delete with reassign: ZZTEST7 moved to ZZ Test 2; old broker removed. Pelosi is not offered as a reassign target.
- Webull Sync now on WB-Margin: no new trades.
- Final: 1652 total, 1570 Pelosi, 82 Webull; XOM pair qty 40 and 16. Restore Demo, split and CSV import not tested live (unit tests only).

**Trade form fixes results (2026-10-24)** (commit 3281c36):
- Open trade ZZTESTA (no exit) deleted from the row menu; dialog showed "(Open)"; no error; removed from Supabase.
- Closed trade ZZTESTB delete dialog unchanged: "Delete ZZTESTB trade (+$2.00)?".
- ZZTESTC with row #2 times blank: Save blocked with "Row #2: entry time is missing.", form kept. After filling times: exactly one row, qty 2, P&L 3.
- A completely empty extra row is ignored.
- Test trades deleted; counts back to 1652 / 1570 / 82.

**Reflection open-trade fix results (2026-10-25)** (commit f4a42ff):
- Read-only audits: no trades with `exit_price` null and `pnl` set; none with `exit_time` set and `exit_price` 0/null. No repair needed.
- New Trade ZZTESTH with blank exit price saved `exit_time`, `exit_price` and `pnl` all null; `entry_time` 14:10Z (10:10 local) correct.
- Opening ZZTESTH, clicking locked fields, switching tabs and Back to Trades made 0 `/rest/v1/trades` requests; values unchanged.
- Save Reflection with notes kept the trade open. Close Trade with exit price only showed the hint and stayed open. Exit price 3 plus exit time saved `exit_price` 3, `pnl` 2, `exit_time` 14:25Z.
- Webull AMZN closed trade (entry 14:48:20.294Z, exit 14:54:08.073Z, pnl -24.76, fees 0.76) opened, fields unlocked, clicked without typing, Back to Trades: all values identical including milliseconds.
- Note: `trades.updated_at` is not set by the app (NULL), so it cannot be used to detect saves.
- ZZTESTH deleted; counts 1652 / 1570 / 82.

**Open bugs found 2026-10-24:**
- [x] New Trade: a fill row with blank entry/exit times is dropped silently (two rows saved as qty 1). Fixed in 3281c36; tested on production 2026-10-24.
- [x] Quick Notes cannot be edited after the trade is entered. Fixed in c1753ee; tested on production 2026-10-25.
- [x] Dashboard: clicking a trade row should open Edit Trade. Fixed in c1753ee (opens the trade on the Trade Reflection page); tested on production 2026-10-25.
- [x] Dashboard: Edit / Reflect opens the Reflection list filtered to the symbol instead of the trade. Fixed in c1753ee; tested on production 2026-10-25.
- [x] Reflection list: Side column shows "—" for cloud rows (reads `type`, not `direction`); losing P&L shows no minus sign. Fixed in c1753ee; tested on production 2026-10-25.
- [x] Dashboard trades table has no account column. Fixed in c1753ee; tested on production 2026-10-25.
- [x] Trade Reflection editor: Side shows Long for cloud short trades (reads `type`, not `direction`). Fixed in c1753ee; tested on production 2026-10-25.
- [ ] A hard reload logs the user out in some tabs but not others.
- [ ] Pelosi demo seed: some trades have a side and P&L that don't match.
- [x] Non-Webull saves do not round P&L to cents (merge result -241.04000000000002; re-saved XOM trade -161.99999999999818). Fixed in c611d67; tested on production 2026-10-27.
- [x] Deleting an open trade (no exit) from the row menu throws "Cannot read properties of null (reading 'toFixed')" in `deleteTrade`; nothing is deleted. Fixed in 3281c36; tested on production 2026-10-24.
- [x] Edit Trade page Delete button (`etpDeleteTrade`) has the same `pnl.toFixed` crash for open trades. Fixed in 15b1ca4; tested 2026-10-24. The old Edit Trade page is not used by the app; verified by unit tests only.
- [x] Edit Trade fill rows (`_etpReadFillRowsFromDom`, also used by split) silently skip partly filled rows. Fixed in 15b1ca4; tested 2026-10-24. The old Edit Trade page is not used by the app; verified by unit tests only.
- [x] `deleteTrade` removes the trade locally even when the cloud delete fails. Fixed in c611d67; tested on production 2026-10-27.
- [x] **HIGH PRIORITY:** Opening an open trade on the Trade Reflection page fills Exit Time automatically (shown as the current time) with a blank Exit Price, and autosave then saves the trade as closed with exit price 0, creating a fake loss. Seen live: ZZTESTG (Pelosi, long, qty 1, entry 1, open) became P&L -1.00 / 1 loss after only viewing the page. The page also showed entry date 10/23 for a trade entered 10/24 (possible date shift). Fixed in f4a42ff; tested on production 2026-10-25.
- [x] The old Edit Trade page (`openEditTradePage`) is no longer used. Jeff's decision: the Trade Reflection page is the single page for reflections and edits. Cleanup task: remove the old page after confirming the Reflection page covers split and fill-row editing (move them over if not). Removed in Batch C2: `openEditTradePage` is now an alias that opens Trade Reflection, and the Net / Gross / Fees summary with the fee-source badge moved to Reflection's Calculated Metrics.
- [x] Trade Reflection header line ("Long · Open" / "+$x P&L") should be bold so it stands out. Fixed in c1753ee; tested on production 2026-10-25.
- [x] The "Enter both exit price and exit time to close this trade." hint should appear as a clear popup or message near Save, not a small box between fields. Fixed in c1753ee (red message under Save Reflection); tested on production 2026-10-25.
- [ ] Older open trades created before the Reflection open-trade fix still have a stored default `exit_time`; consider a cleanup.

**Batch A results (2026-10-25)** (commit c1753ee):
- ZZTESTJ (cloud short) showed Account Pelosi and -$1.00 on the dashboard; opened directly from row click and from the row menu.
- Header "Short · -$1.00 P&L" shown bold; Side Short.
- Clicking Quick Notes and leaving made no save; typing qn2 saved (`quick_notes` | `direction` | `exit_price` | `pnl` = qn2 | short | 6 | -1).
- Reflection list showed ZZTESTJ Short / -$1.00 and Webull AMZN Long / -$24.76.
- ZZTESTK (open) showed Exit "Open" and P&L "—" in the Reflection list.
- Close Trade with exit price only showed the red hint under Save; the trade stayed open in the cloud.

**Incident (2026-10-25):** Delete Selected removed a hidden Webull trade (AMZN 10/22, -24.76) that stayed selected after the Symbol filter changed from amzn to zztest. Restored from `trades_backup_shadowfix_20261024` by SQL; counts back to 1652 / 1570 / 82.

**Open bugs for Batch A2 (found 2026-10-25):**
- [x] **HIGH:** Dashboard selection persists across filter changes and page navigation; Delete Selected can delete trades the user cannot see. Fixed in 8a5af79; tested on production 2026-10-25.
- [x] New Trade: tabbing into Entry Time auto-fills Entry and Exit Time. Fixed in 8a5af79; tested on production 2026-10-25.
- [x] Exit Time popup: when only exit price is entered, show a popup pointing at Exit Time, since autosave means Save may never be clicked. Fixed in 8a5af79; tested on production 2026-10-25.
- [x] Stat cards show "$-1.00" instead of "-$1.00". Fixed in 8a5af79; tested on production 2026-10-25.
- [x] Reflection metrics panel shows Realized P&L and Runup for an open trade (previewed from an unsaved exit price). Fixed in 8a5af79; tested on production 2026-10-25.
- [x] Reflection list Side sort uses `type` only. Fixed in 8a5af79; tested on production 2026-10-25.
- [ ] Polish: the exit-field popup overlaps the TRADE GRADE label below it.

**Batch A2 results (2026-10-25)** (commit 8a5af79):
- Backup `trades_backup_a2_20261025` (1652 / 1570 / 82) taken first.
- New Trade: tabbing through Entry/Exit Time left both blank. ZZTESTA1/A2 saved long, exit 1, pnl -1; ZZTESTA3 (open short) saved `exit_price`, `exit_time`, `pnl` null.
- Selection cleared on Symbol filter change, column sort, Calendar tab and back, sidebar navigation and back, and Period change.
- Delete confirm read "Delete 1 trade? This cannot be undone. ZZTESTA2 10/25/2026"; Cancel left 3 test trades.
- ZZTESTA3 with exit price only: popup "Exit Time is required to close this trade" under Exit Time; metrics showed "--"; cloud stayed null.
- Select-all ticked exactly the 3 visible ZZTEST rows; delete removed only those. Final counts 1652 / 1570 / 82.

Note: on the dashboard row menu, open trades show Close Trade / Edit / Chart / Delete; closed trades show Edit / Reflect / Chart / Delete.

**Batch F results (2026-10-26)** (commit 4c8f3b7):
- Backups `trades_backup_f_20261026` (1652 / 82) and `wji_backup_f_20261026` (2) taken first. Unique index `webull_journal_imports_user_account_uq` created after a 0-row pre-check.
- First Sync now attempts were correctly blocked by the count check: the browser cache had 81 WB-Margin trades vs 82 in the cloud (AMZN 10/22 restored by SQL on 10/25). After clearing site data: WB-Margin Sync now "1 new, 0 updated"; WB-Cash "no new trades".
- Second link of Individual Margin to a new journal blocked with the duplicate-link message; link rows stayed at 2.
- Auto-sync on sign-in with both journals on: status, then sync + commit for each journal; both ok.
- Settings and the modal show "Webull approval expires Nov 3, 2026". No re-approval line on cards.
- Final: 1653 total, 83 webull, 1570 non-webull. WB-Margin and WB-Cash auto-import left on.
- Dropped `trades_backup_phase8`, `trades_backup_phase9_merge`, `trades_merge_backup_20261023`, `trades_backup_shadowfix_20261024`.

**Broker modal batch (polish, done):**
- [x] One Save Account button that also saves the Webull link; on a link error, show it and keep the modal open. Done (64461d6, tested on production 2026-10-27).
- [x] Duplicate-link message: "This Webull account is linked to "<name>". Unlink it there first (its trades stay)." Done (64461d6, tested on production 2026-10-27).
- [x] Warn when a new link's start date overlaps trades another journal already imported from that account. Done (64461d6, tested on production 2026-10-27).
- [x] Amber expiry text may be hard to read on a light theme; stale shadow-write comment on `_wbAutoCountsMatch`. Done (64461d6, tested on production 2026-10-27).

**Broker modal polish results (2026-10-27)** (commit 64461d6):
- Pre-checks: 1656 / 86 / 1570; 2 link rows, both auto-import on; all 86 WB-Margin trades carry account QRJO4O9KAHJA29F2FIPKHNKI in external_id, 0 bad.
- ZZ WB Test: Other → Webull saved with one Save Account; Webull section showed Not linked and no "Save Webull link" button.
- Linking Individual Margin from 01/01/2026 and 10/27/2026 showed "WB-Margin already has trades from this account through Oct 27, 2026..." (same-day case shown); readable on the dark theme.
- Save Account showed "This Webull account is linked to "WB-Margin". Unlink it there first (its trades stay)." and stayed open; Cancel left the card name unchanged.
- WB-Cash auto-import off/on through Save Account saved false, then true.
- ZZ WB Test deleted; link rows 2; trades 1656 / 86 / 1570.
- Not tested live (unit tests only): link write failing after the account saved, unlink confirm, unique-index error path, Harbor Light contrast.

**Batch B results (2026-10-27)** (commit c611d67):
- Backup `trades_backup_b_20261027` (1656 / 86 / 1570, RLS on).
- Before cleanup: 3 rows had unrounded `pnl`, 0 fees. One-time UPDATE run after testing; recount 0 / 0 / 0.
- New Trade ZZTESTB1 saved pnl 0.3; open ZZTESTB2 saved `pnl` and `exit_price` null; closing it on Reflection saved 0.3; merging two ZZTESTB3 saved one row, qty 2, pnl 0.2.
- Offline: row-menu delete, Delete Selected (selection kept), broker "Delete Broker & All Its Trades", and deleting an empty broker each showed "Failed to delete: TypeError: Failed to fetch / Your data was not changed. Please try again." and changed nothing. Online retries deleted correctly; ZZTESTB5 removed with its broker.
- Final: 1656 / 86 / 1570.
- Unit tests only: split, CSV import, import smart-merge replace, `etpDeleteTrade`.

**Open bugs found 2026-10-27:**
- [x] Broker Accounts cards (trade count, account value, "Updated") do not refresh after trades are deleted or synced; they only update after a hard refresh. They should recount whenever the Broker Accounts page is shown. **Fixed** in commit 26c6cc0, tested 2026-10-27.
- [ ] NEXT: store fills in the cloud (fills JSONB column + _mapArrayRow/_mapSupabaseTradeRow), before C2.

**Batch C1 results (2026-10-27)** (commit 26c6cc0):
- Backup `trades_backup_c1` (1656 / 86 / 1570).
- ZZTEST1 (3 fills) saved qty 30, entry 10.1, exit 11, fees 0.99, pnl 26.01. Reflection showed 3 locked fill rows; totals stayed locked after Unlock. Editing row 2 exit saved exit 11.185, pnl 31.56.
- Partly filled row 4 blocked save with "Row #4: entry price is missing."; cloud unchanged.
- Split of row 3: two rows, qty 20 (10.05 / 11.275 / 23.84 / 0.66) and qty 10 (10.2 / 11 / 7.67 / 0.33). Ticking every row showed "Leave at least one row on this trade."
- Offline split: "The split didn't save. Nothing was changed. Try again."; cloud unchanged.
- Webull SPOT: note shown, no fill editor, no Split, execution fields locked.
- Open ZZTEST2 with a quick-note save stayed exit/pnl null.
- Broker cards updated 1573 → 1570 after deletes without a hard refresh. Final 1656 / 86 / 1570.

**Open items for a "Reflection polish" batch:**
- [ ] Fill-row and New Trade missing-field errors should show a popup anchored to the field, not only a small red line.
- [ ] Fill price fields accept only 2 decimals (11.555 rejected); allow 4 like the totals.
- [ ] "Leave at least one row on this trade." stays visible after the selection becomes valid.
- [ ] Webull trades: lock Side and Asset Type too; the Unlock confirm ("Changing core fields will recalculate P&L") is misleading for Webull trades — skip or reword it.
- [ ] Leaving the page with a partly filled fill row loses fill edits; block Back to Trades like Save.
- [ ] Broker card "Updated Never" for a synced journal with no trades; show last sync instead.
- [ ] 4 stale tests (batch-a2 #24, reflection-open-trade #104-106).

**Token expiry checklist (on or after 2026-11-03)** (approved token expires 2026-11-03 22:37:24Z, 5:37 PM ET; DST ends 2026-11-01):
1. From 2026-10-31 22:37Z the expiry line in Settings and the broker modal turns amber.
2. Before expiry: note `access_token_expires_at` (`SELECT approval_state, approval_checked_at, access_token_created_at, access_token_expires_at FROM broker_credentials WHERE user_id = '0800472d-b8a7-4032-b01e-1a4036f7a504';`).
3. After expiry, sign in with DevTools Network open: one `status` call, no `sync`, no repeated console warnings or Vercel log lines.
4. Broker Accounts: WB-Margin and WB-Cash cards show "Webull needs re-approval" (allow up to 30 s).
5. Each broker modal: one amber "needs re-approval" message, no red error line, Sync now disabled.
6. Settings → Integrations shows the re-approval steps. Tap "I've approved it, check again" first.
   - Connected and step 2's query shows a later expiry: regular use (or Webull leeway) extends the token. Record it.
   - "Your Webull approval expired. Tap Send new code.": the query shows the token cleared. Tap Send new code, enter the code in the Webull app, tap "I've approved it, check again". Expect connected with a new expiry about 15 days out (grey).
7. The card line clears after leaving and returning to Broker Accounts.
8. Sync now on both journals; sign out and in to confirm auto-sync runs.
9. Record in §12 #9: expiry before and after, and the "check again" result.
