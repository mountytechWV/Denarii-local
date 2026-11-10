# Webull Sync — Phase 3 Implementation Plan (credential endpoints + approval state)

Status: **Phase 3 complete (2026-10-19).** 3A complete (2026-10-18); 3B complete (2026-10-19); 3C complete (2026-10-19). Parent plan: `docs/webull-sync-plan.md` (§2, §3, §4, §6, §7.8, §11 Phase 3).

## Decisions

- **Key rotation re-encrypt-on-read is deferred to Phase 10.** Phase 3 builds the versioned key lookup (`WEBULL_CREDS_ENC_KEY`, `WEBULL_CREDS_ENC_KEY_V<n>`) and stores `key_version = 1`; the re-encrypt step and its test land in Phase 10.
- **No backup copy of `WEBULL_CREDS_ENC_KEY` will be kept.** It exists only as a Sensitive, Production-only Vercel env var. If it is lost, stored credentials can't be decrypted and users reconnect (enter keys again and approve a new text code). No trade data is affected.

## Confirmed inputs (Phase 2b, live)

- Every new Webull token needs the user to enter a texted code in the Webull app, so the token is stored encrypted and reused.
- A token stays valid if used at least once every 15 days.
- Token statuses: `PENDING`, `NORMAL`, `EXPIRED`, `INVALID`.
- A successful Create Token proves the key and secret sign correctly. Account access is proven only by the first `check_approval` that returns `NORMAL` followed by a successful Account List call.

---

## 1. Files to create or change

| File | Change |
|---|---|
| `supabase/webull-phase3.sql` | New. Additive token columns on `broker_credentials`. Idempotent and runs in one transaction. |
| `supabase/webull-phase3-verify.sql` | New. Read-only checks in the same style as Phase 1. |
| `supabase/webull-phase3-rollback.sql` | New. Drops only the Phase 3 columns and constraint. |
| `supabase/schema.sql` | Add a "Webull Sync — Phase 3" block that documents the new columns and records the verify result. |
| `api/_lib/secret-box.js` | New. AES-256-GCM with AAD, versioned key lookup, strict 32-byte key check (§3). |
| `api/_lib/auth.js` | New. Verifies the Bearer token through `/auth/v1/user`, returns `userId`, and provides the service-role REST helpers (§4). |
| `api/webull.js` | New. Actions `connect`, `check_approval`, `resend_code`, `status`, `disconnect`. No `sync`. |
| `vercel.json` | Add `"api/webull.js": { "maxDuration": 30 }`. |
| `api/delete-account.js` | Add `broker_credentials` first in the list and `webull_journal_imports` before `broker_accounts`. |
| `tests/secret-box.test.js` | New. Round trip, tamper checks on ct/iv/tag/AAD, unique IVs, bad-key refusal. |
| `tests/webull-endpoint.test.js` | New. Handler tests with a mocked `fetch`: status mapping, cooldowns, no secrets in any response, body `user_id` ignored. |
| `package.json` | Add the two new test files to `test:webull`. |

`api/_lib/*` is under an underscore folder, so Vercel doesn't deploy those files as routes. The only new route is `/api/webull`. `webull-readonly.js` and `webull-sign.js` don't change: `callRoute` already accepts `fetchImpl`, which is how timeouts get injected.

---

## 2. SQL sketch

**Columns.** Six new columns:

- `access_token_ct`, `access_token_iv`, `access_token_tag`: the encrypted token (§3 rules).
- `access_token_expires_at`: non-secret, from Webull's `expires_at`.
- `access_token_checked_at`: the last time the server asked Webull about the token. This is the claim column for the `check_approval` cooldown.
- `access_token_created_at`: when the current token was created. This is the claim column for the `resend_code` and `connect` cooldowns.

The AAD for the token is `user_id:access_token:key_version`, so it uses the row's `key_version`.

### `supabase/webull-phase3.sql`

```sql
BEGIN;
ALTER TABLE public.broker_credentials
  ADD COLUMN IF NOT EXISTS access_token_ct         TEXT,         -- base64 ciphertext
  ADD COLUMN IF NOT EXISTS access_token_iv         TEXT,         -- 12-byte random IV, new per token
  ADD COLUMN IF NOT EXISTS access_token_tag        TEXT,         -- 16-byte GCM tag
  ADD COLUMN IF NOT EXISTS access_token_expires_at TIMESTAMPTZ,  -- non-secret, from Webull expires_at
  ADD COLUMN IF NOT EXISTS access_token_checked_at TIMESTAMPTZ,  -- last Webull check/create (cooldown)
  ADD COLUMN IF NOT EXISTS access_token_created_at TIMESTAMPTZ;  -- current token minted (resend cooldown)

DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint
                 WHERE conrelid = 'public.broker_credentials'::regclass
                   AND conname  = 'broker_credentials_access_token_parts_chk') THEN
    ALTER TABLE public.broker_credentials ADD CONSTRAINT broker_credentials_access_token_parts_chk
      CHECK ((access_token_ct IS NULL) = (access_token_iv IS NULL)
         AND (access_token_ct IS NULL) = (access_token_tag IS NULL));
  END IF;
END $$;

-- Re-assert: new columns inherit table-level privileges, which are none for these roles.
REVOKE ALL ON public.broker_credentials FROM anon, authenticated;
COMMIT;
```

All new columns are nullable with no default, so existing rows stay valid. The table should be empty anyway.

### `supabase/webull-phase3-verify.sql` (each check is read-only)

1. **Columns.** Expect 6 new rows, all `is_nullable = YES`, `column_default` NULL, and 21 columns in the table.
   ```sql
   SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
   WHERE table_schema='public' AND table_name='broker_credentials' AND column_name LIKE 'access_token_%' ORDER BY 1;
   ```
2. **Constraint.** Expect one row containing the parts check.
   ```sql
   SELECT conname, pg_get_constraintdef(oid) FROM pg_constraint
   WHERE conrelid='public.broker_credentials'::regclass AND conname='broker_credentials_access_token_parts_chk';
   ```
3. **RLS still on.** Expect `t`, `t`.
   ```sql
   SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.broker_credentials'::regclass;
   ```
4. **Privileges.** Expect every anon/authenticated column check to be `false`, and service_role to be `true` for SELECT, INSERT, UPDATE and DELETE. Phase 1 only checked SELECT/INSERT for service_role, but upsert needs UPDATE and disconnect needs DELETE.
   ```sql
   SELECT r, c, p, has_column_privilege(r, 'public.broker_credentials', c, p)
   FROM unnest(ARRAY['anon','authenticated']) r,
        unnest(ARRAY['access_token_ct','access_token_iv','access_token_tag','access_token_expires_at']) c,
        unnest(ARRAY['SELECT','INSERT','UPDATE']) p;
   SELECT p, has_table_privilege('service_role','public.broker_credentials',p)
   FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) p;
   ```
   If service_role lacks UPDATE or DELETE, add `GRANT SELECT, INSERT, UPDATE, DELETE ON public.broker_credentials TO service_role;` to `webull-phase3.sql` and re-run it.
5. **Data.** Expect the row count unchanged and 0 rows with a token.
   ```sql
   SELECT count(*) total, count(access_token_ct) with_token FROM public.broker_credentials;
   ```

### `supabase/webull-phase3-rollback.sql`

```sql
-- Removes ONLY Phase 3 objects. Revert the api/webull.js deploy FIRST so nothing writes these columns.
-- Dropping discards stored tokens: users must approve a new text code after re-deploy. No trades touched.
BEGIN;
ALTER TABLE public.broker_credentials DROP CONSTRAINT IF EXISTS broker_credentials_access_token_parts_chk;
ALTER TABLE public.broker_credentials
  DROP COLUMN IF EXISTS access_token_created_at,
  DROP COLUMN IF EXISTS access_token_checked_at,
  DROP COLUMN IF EXISTS access_token_expires_at,
  DROP COLUMN IF EXISTS access_token_tag,
  DROP COLUMN IF EXISTS access_token_iv,
  DROP COLUMN IF EXISTS access_token_ct;
COMMIT;
```

---

## 3. Helpers and actions

### `api/_lib/secret-box.js`

- **`FIELDS`** is frozen to `app_key`, `app_secret`, `access_token`. Any other field throws.
- **`loadKey(version)`** reads `WEBULL_CREDS_ENC_KEY` for v1, or `WEBULL_CREDS_ENC_KEY_V<n>` for later versions. It trims the value, decodes base64, and throws `config` unless the result is exactly 32 bytes. `CURRENT_KEY_VERSION` is the highest version configured; v1 for now.
- **`encrypt(plain, { userId, field, keyVersion })`** uses a fresh `randomBytes(12)` IV and AAD `${userId}:${field}:${keyVersion}`. It returns `{ ct, iv, tag }`, all base64.
- **`decrypt(parts, { userId, field, keyVersion })`** returns the plaintext. On any failure it throws `Error('decrypt')` with `category = 'crypto'`. The underlying error is never attached.
- **Re-encrypt on read (§3):** deferred to Phase 10 (see Decisions). Only the lookup by version is built now.

### `api/_lib/auth.js`

- **`getVerifiedUserId(req)`** reads `Authorization: Bearer`, calls `/auth/v1/user` with the anon key, and returns the `id`. It throws typed errors with status 401 or 502.
- **`supabaseEnv()`** returns `{ url, anon, service }`. It throws `config` if any value is missing.
- **`restSelect`, `restUpsert`, `restPatch`, `restDelete`** are service-role PostgREST helpers. They always add `user_id=eq.<verified id>`, and `restSelect` requires an explicit column list.
- It never logs. `delete-account.js` keeps its own code for now; switching it to `auth.js` can come later.

### `api/webull.js`: what every request does

1. Accepts POST only (405 otherwise) and requires `Content-Type: application/json` (415).
2. Rejects bodies over 2 KB with 413, checking both `content-length` and `JSON.stringify(req.body).length`.
3. Gets `userId = getVerifiedUserId(req)`. It never reads `body.user_id`.
4. Reads `action` from the body. Anything other than the five actions gets 400 `"Unknown action."`.
5. Creates `requestId = crypto.randomUUID()`. Logs are only `console.warn('[webull]', requestId, action, category)`.
6. Every Webull call goes through a `fetchImpl` wrapper with an 8-second `AbortController` timeout. The host is a fixed constant, `api.webull.com`.
7. The whole handler is wrapped in try/catch. Anything unexpected returns 500 `{ error: "Something went wrong.", requestId }`.

### `connect`

**Request:** `{ action: "connect", appKey, appSecret }`

**Steps:**

1. Trim both values. Each must match `^[A-Za-z0-9_-]{16,128}$`, or return 400 `"Enter a valid App Key and App Secret."`. Check the pattern against the length and character set of the owner's real key at the start of the session, without printing the key.
2. **Cooldown.** If a row exists and `access_token_created_at` is less than 60 seconds ago, return 429.
3. Call `createToken({ host, appKey, appSecret })` once with the plaintext values.
   - A 401 means the signature was rejected, so the keys are wrong. Return `"Webull rejected the credentials."` and **save nothing**. No text message is sent in this case.
   - Any other failure is mapped using the table in §4, and nothing is saved.
4. Check the response has a `token` string. If it doesn't, return `"Webull is unavailable."`.
5. Encrypt the App Key, App Secret and token, each with its own IV, using `key_version = 1`.
6. Upsert with `on_conflict=user_id` and `Prefer: resolution=merge-duplicates,return=minimal`. The row gets: all ct/iv/tag columns, `app_key_last4`, `webull_account_ids = null`, `approval_state = 'needs_approval'`, `approval_checked_at`, `access_token_created_at` and `access_token_checked_at` set to now, `access_token_expires_at` parsed from the response, and `updated_at = now()`.
7. If the save fails, return 500 `"Could not save your Webull connection. Try again."`. The token Webull just created is lost; that costs the user one extra text code.

**Response 200:** `{ connected: true, last4, approvalState: "needs_approval", accounts: [] }`

**Parsing `expires_at`.** The format is unknown. A number or numeric string is read as epoch time: below 1e12 it's seconds, otherwise milliseconds. Otherwise use `Date.parse`. If that fails, store null.

### `check_approval`

**Request:** `{ action: "check_approval" }`

**Steps:**

1. **Claim and load in one call.** PATCH `access_token_checked_at = now()` with the filter `or=(access_token_checked_at.is.null,access_token_checked_at.lt.<now-10s>)`, using `Prefer: return=representation` and an explicit `select` of the ct/iv/tag columns plus `key_version`.
   - 0 rows back: run one `select=user_id`. If there's no row, return 409 `"Webull is not connected."`. If there is, return 429.
   - Doing the claim before any Webull call makes the cooldown safe when two requests race.
2. If there's no token, return 200 with `needs_approval` and the "send a new code" message.
3. Decrypt all three values. If that fails, return the "could not be read" message, make no Webull call, and leave the state unchanged.
4. Call `checkToken({ host, appKey, appSecret, token })` once.
5. **If the status is NORMAL:** call `getAccountList({ ..., accessToken: token })` once. Map each account to `{ id: account_id, label }`, where the label is the account type's display name, for example "Individual Margin". `account_number` is not stored.
   - Then PATCH: `webull_account_ids`, `approval_state = 'ok'`, `approval_checked_at = now()`, `access_token_expires_at` from the check response.
   - Each read counts as a use of the token toward the 15-day inactivity limit.
6. Any other result is mapped using the table in §4.

**Response 200:** `{ approvalState, accounts, message? }`. On NORMAL, `accounts` is the list from step 5.

This action makes at most two Webull calls: one Check Token, plus one Account List if the status is NORMAL.

### `resend_code`

**Request:** `{ action: "resend_code" }`

**Steps:**

1. **Claim.** PATCH `access_token_created_at = now()` where it is null or older than 60 seconds, **and** the token isn't currently valid. "Currently valid" means `approval_state = 'ok'` and `access_token_expires_at > now()`; the filter is `or=(approval_state.neq.ok,access_token_expires_at.lt.now,access_token_expires_at.is.null)`.
   - 0 rows back: 409 if there's no row, 409 `"Webull is already approved."` if the token is valid, otherwise 429.
2. Decrypt the App Key and App Secret, then call `createToken` once.
3. **On success:** store the new encrypted token with a new IV. Set `approval_state = 'needs_approval'`, `approval_checked_at`, `access_token_expires_at`, and `access_token_checked_at = null` so the user can check right away.

**Response 200:** `{ approvalState: "needs_approval", message: "Enter the code Webull texted you in the Webull app, then tap Check again." }`

### `status` (database only, no Webull call)

**Steps:** `select=app_key_last4,webull_account_ids,approval_state,approval_checked_at,access_token_expires_at,access_token_checked_at,access_token_created_at`.

- **Derived state:** if `approval_state = 'ok'` but `access_token_expires_at` has passed, report `needs_approval`. This is computed for the response only; nothing is written.

**Response:**

- Not connected: `{ connected: false }`
- Connected: `{ connected: true, last4, accounts, approvalState, approvalCheckedAt, approvalExpiresAt, canCheckAt, canResendAt }`

None of the response field names contain "token", "secret", "ct", "iv" or "tag". That keeps the §9 grep test clean.

### `disconnect`

**Steps:**

1. DELETE `broker_credentials?user_id=eq.<id>`.
2. Read back with `select=user_id&user_id=eq.<id>` and expect `[]`.
3. If the row is still there, return 500 `"Could not remove your stored Webull keys."`.
4. `webull_journal_imports` is not touched, as parent plan §2a requires.

**Response:** `{ disconnected: true }`

---

## 4. Error and state mapping

| Source | Condition | `approval_state` write | HTTP | Fixed message |
|---|---|---|---|---|
| any | bad method, type, size or action | none | 405/415/413/400 | "Method not allowed." / "Unsupported request." / "Request too large." / "Unknown action." |
| auth | missing or invalid session | none | 401 | "Invalid or expired session." |
| config | env var missing, or key isn't 32 bytes | none | 500 | "Webull sync isn't configured." |
| connect | input fails the pattern | none | 400 | "Enter a valid App Key and App Secret." |
| createToken (connect) | 401 | none (nothing saved) | 400 | "Webull rejected the credentials." |
| createToken (resend) | 401 | `unknown` | 400 | "Webull rejected the credentials. Reconnect with a new key." |
| checkToken | `NORMAL`, then account list 200 | `ok` | 200 | (none) |
| checkToken | `PENDING` | `needs_approval` | 200 | "Approve Denarii in the Webull app, then tap Check again." |
| checkToken | `EXPIRED` or `INVALID` | `needs_approval`, and clear the token ct/iv/tag/expires_at (the token is dead) | 200 | "Your Webull approval expired. Tap Send new code." |
| checkToken | missing or unrecognized status | `unknown` | 502 | "Webull is unavailable." |
| checkToken | 401 | `unknown` | 400 | "Webull rejected the credentials. Reconnect with a new key." |
| account list after NORMAL | 401 | `needs_approval` | 200 | "Your Webull approval expired. Tap Send new code." |
| account list after NORMAL | 403 | `unknown` | 400 | "Your Webull key can't read accounts. Check that Trading is enabled." |
| any Webull call | 429 | none | 429 | "Webull is busy. Try again in a minute." |
| any Webull call | 5xx, timeout, network, bad JSON | none | 502 | "Webull is unavailable." |
| Denarii cooldown | claim matched 0 rows | none | 429 | "Please wait a moment before trying again." plus `retryAfterSec` |
| decrypt | failed | none | 409 | "Stored credentials could not be read; please reconnect." |
| database | any PostgREST failure | none | 500 | "Something went wrong." plus `requestId` |

Every message comes from a frozen `MESSAGES` object. Upstream text is never forwarded, and `err` is never passed to `console`.

---

## 5. Vercel and Supabase steps, in order, before deployed testing

1. **Confirm 2FA** is on for every account with access to Vercel, GitHub and Supabase. Parent plan §10 makes this required, not optional.
2. **Run the SQL in Supabase.** In the SQL Editor, run `supabase/webull-phase3.sql`, then each check in `webull-phase3-verify.sql`. Record the results in `schema.sql`. Run `webull-phase3.sql` a second time to confirm it's idempotent.
3. **Generate the key in your own PowerShell window.** Don't run this through `!` or Claude, because that would put the key in the transcript:
   ```powershell
   node -e "process.stdout.write(require('crypto').randomBytes(32).toString('base64'))" | clip
   ```
   This copies a 44-character base64 key to the clipboard. A trailing CRLF is fine, because `loadKey` trims it.
4. **Add the key in Vercel.** Go to Project → Settings → Environment Variables → Add.
   - Key: `WEBULL_CREDS_ENC_KEY`. Value: paste.
   - Environments: **Production only** (uncheck Preview and Development).
   - Turn on **Sensitive**, then Save. Clear the clipboard afterwards.
   - No backup copy is kept (see Decisions). The value can't be read back from Vercel.
5. **Check the existing variables.** On the same page, confirm `SUPABASE_SERVICE_ROLE_KEY`, `SUPABASE_URL` and `SUPABASE_ANON_KEY` exist with Production scope. If the service role key isn't marked Sensitive, re-add it as Sensitive.
6. **Deploy.** Push the commit. Env vars only take effect on a new deployment.
7. **Use the production domain for testing.** Preview deployments don't have the key, so `/api/webull` returns "Webull sync isn't configured." there. That's intended.
8. **Run the checks.** Locally, run `npm run test:webull` and `npm run check:webull`. Both must pass before pushing.

---

## 6. Deployed tests from the browser console

Sign in on the production domain, then run:

```js
const T = (await SupabaseAuth.getClient().auth.getSession()).data.session.access_token;
const W = async (body) => { const r = await fetch('/api/webull', { method:'POST',
  headers:{ 'Content-Type':'application/json', Authorization:'Bearer '+T }, body: JSON.stringify(body) });
  const j = await r.json(); console.log(r.status, j); return j; };
```

Enter keys through `prompt()` so they don't stay in console history.

| # | Step | Expected result |
|---|---|---|
| 1 | `await W({action:'status'})` | `200 {connected:false}` |
| 2 | `fetch` without the Authorization header | 401 |
| 3 | `W({action:'sync'})` | 400 "Unknown action." |
| 4 | `W({action:'connect', appKey:'x', appSecret:'y'})` | 400 invalid input, no Webull call |
| 5 | `W({action:'connect', appKey:prompt('key'), appSecret:'0'.repeat(32)})` | 400 "Webull rejected the credentials."; no row in the table viewer; no text message |
| 6 | `W({action:'connect', appKey:prompt('key'), appSecret:prompt('secret'), user_id:'00000000-0000-0000-0000-000000000000'})` | 200 `{connected:true, last4, approvalState:'needs_approval', accounts:[]}`; a text code arrives; the table viewer shows your `user_id` (the fake one is ignored), base64 in the ct/iv/tag columns, and no plaintext |
| 7 | `W({action:'connect', ...})` again within 60 seconds | 429 |
| 8 | Without entering the code: `W({action:'check_approval'})` | 200 `needs_approval`, PENDING message; Vercel logs show one call |
| 9 | Immediately again | 429 with `retryAfterSec` |
| 10 | `W({action:'status'})` | `needs_approval`; no Webull call (no log entry beyond the request) |
| 11 | Wait more than 5 minutes, then `check_approval` | EXPIRED message; token columns now null. Not seen live yet, so record whatever actually happens |
| 12 | `W({action:'resend_code'})` | 200, new text; immediately again gives 429 |
| 13 | Enter the code in the Webull app, then `check_approval` | 200 `{approvalState:'ok', accounts:[{id,label}×2]}`; `access_token_expires_at` updated (record the value: this is the post-approval expiry, still unknown) |
| 14 | `W({action:'resend_code'})` while ok | 409 "Webull is already approved." with no text |
| 15 | `JSON.stringify` of every response above, checked for your key, secret, `ct`, `iv`, `tag`, `secret` | No matches |
| 16 | Vercel → Logs for `/api/webull` | Only `[webull] <uuid> <action> <category>` lines; no headers, bodies, tokens or keys |
| 17 | `W({action:'disconnect'})`, then `status` | `{disconnected:true}`, then `{connected:false}`; table row gone; `webull_journal_imports` rows unchanged |
| 18 | Optional: on a **throwaway** account, connect, then delete the account | Rows in `broker_credentials` and `webull_journal_imports` removed |

Afterwards, revoke the test key in Webull's portal if it won't be kept in use.

---

## 7. Risks, rollback and data paths

**Risks**

- **Secrets in logs.** Mitigated by the frozen messages, never passing `err` to `console`, and the endpoint test that checks responses.
- **Text-message spam.** Mitigated by the 60-second create cooldown and the resend block while approved. Only the signed-in user can trigger it, against their own phone.
- **Unknown Webull behavior:** the `expires_at` format, the post-approval expiry, the shape of EXPIRED and INVALID responses, and whether errors come back as HTTP 200 with an `error_code`. The parsing is defensive, and anything unrecognized maps to `unknown` or "unavailable". Record what is seen in tests 11 and 13.
- **Losing the encryption key** makes every row undecryptable. The result is "please reconnect", not data loss (see Decisions).
- **service_role might lack UPDATE or DELETE.** Verify check 4 catches this.
- **Vercel or GitHub compromise** is the parent plan §10 worst case, and the stored token makes it worse: an attacker with an approved token doesn't need a text code.
- **Medium overall:** this is the first code that handles secrets.

**Rollback, in order**

1. Revert the commit and redeploy.
2. `DELETE FROM broker_credentials;` (this is test data only).
3. Run `webull-phase3-rollback.sql`.
4. Remove `WEBULL_CREDS_ENC_KEY` from Vercel.
5. Revoke the key at Webull.

The `delete-account.js` change is safe to keep either way.

**Data paths touched**

- `broker_credentials`: server writes only.
- `webull_journal_imports`: only `delete-account` deletes from it.
- Supabase `/auth/v1/user`.
- Webull: `POST /auth/tokens/create`, `POST /auth/tokens/check`, `GET /trading/accounts/list`. These are already on the allowlist; no new routes.
- Vercel env vars.

Not touched: `trades`, `journal_backups`, any client code.

---

## 8. Session split

Three sessions, each ending in its own commit:

- **3A, foundation (no new route).** **COMPLETE 2026-10-18.** `webull-phase3.sql` ran twice in production; all five verify checks passed (recorded in `supabase/schema.sql`). Deploy check passed 2026-10-19: a throwaway account was created and deleted through Denarii's delete-account option; afterward its login and all its rows in `trades`, `broker_accounts`, `broker_credentials` and `webull_journal_imports` were 0, and an orphan check across all 17 public tables with `user_id` found 0 leftover rows.
  - Files: the SQL files and the Supabase run, `secret-box.js` with tests, `auth.js`, `delete-account.js`, `schema.sql`.
  - Deploy check: no new route, the app works, and account deletion still works on a throwaway account.
- **3B, `connect`, `status`, `disconnect`.** **COMPLETE 2026-10-19.** Deployed tests passed in production after the App Key fix (commit "Webull 3B: allow period in App Key": real App Keys are 35 characters, `us.` plus letters and digits, so the key pattern now allows `.`; the secret rule is unchanged).
  - Also: `vercel.json`, the env var setup, and the endpoint test harness.
  - Deployed tests: 1–7, 10, and 15–17. Results:
    - #1 `status` → `connected:false`. #2 no Authorization → 401. #3 `check_approval` → 400 "Unknown action." (3C not built). #4 bad input → 400.
    - #5 real key + fake secret → 400 "Webull rejected the credentials."; nothing saved; no text.
    - #6 real keys → 200 `connected:true`, `last4`, `needs_approval`, `accounts: []`; body `user_id` ignored; text code received.
    - #7 repeat within 60 s → 429 with `retryAfterSec`.
    - #10 `status` → `needs_approval`, no Webull call.
    - Supabase row: all ct/iv/tag columns base64 only, `key_version` 1, `approval_state` `needs_approval`.
    - `access_token_expires_at` parsed (not null) as about 6 minutes after creation for a `PENDING` token.
    - #15 leak check → `[]`. #16 Vercel logs show only `[webull] <id> <action> <category>` lines.
    - #17 `disconnect` removed the row; `status` → `connected:false`.
- **3C, `check_approval` and `resend_code`.** **COMPLETE 2026-10-19.** Commit "Webull sync phase 3C: check_approval and resend_code"; deployed tests passed in production.
  - Also: the cooldown claims, the state mapping, and the account-list verification.
  - Deployed tests: 8–9 and 11–14, with a real text code. Results:
    - `connect` → 200 `needs_approval`; text received (code not entered).
    - #8 `check_approval` while pending → 200 `needs_approval`, "Approve Denarii in the Webull app, then tap Check again."
    - #11 `check_approval` after 6+ minutes → 200 `needs_approval`, "Your Webull approval expired. Tap Send new code." First live expired-token handling. (The endpoint gives EXPIRED and INVALID the same response, so which of the two Webull returned wasn't recorded.)
    - #12 `resend_code` → 200; new text received. The nested resend claim filter (`and=(or(...),or(...))`) worked against real Supabase.
    - #13 code entered in the Webull app, then `check_approval` → 200 `ok` with 2 accounts, `{id, label}` only ("Individual Cash", "Individual Margin"); no `account_number`.
    - #14 `resend_code` while approved → 409 "Webull is already approved."; no text.
    - Supabase row: `approval_state` `ok`; `webull_account_ids` holds `{id, label}` only; key, secret and token columns are base64 ciphertext with separate IVs and tags.
    - **Post-approval expiry:** `access_token_expires_at` = 2026-11-03 22:09:58 UTC, 15 days after token creation (2026-10-19 22:09:14 UTC). Whether regular use extends it is still open; check on or after 2026-11-03.
    - #15 leak check: no response contained the key, secret, token, ct, iv, tag or `account_number`.

3B and 3C can be merged into one session if preferred. 3A stays separate, because its SQL and env work carries no endpoint risk.
