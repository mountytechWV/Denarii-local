let sessionPassword = null;
let sessionDek = null; // DEK hex string when account uses DEK model; null = legacy
let pendingRecoveryKey = null; // held temporarily during registration/reset
let currentAccountId = null;
let currentUsername = null;
let _lastCloudSaveMs = 0; // debounce cloud backup writes
let _firstCloudSaveDone = false; // bypass debounce for first cloud write per session
window._denariiMigrationRunning = false; // true while Phase 2A cloud migration is in progress
var _migrationSavePending = false; // queued save flag for saves attempted during migration

// ── Phase 2: Row-level shadow-write state ────────────────────────
let _lastShadowWriteMs = 0;          // debounce shadow-write (10s)
let _shadowWriteRunning = false;     // single-flight guard
let _shadowWritePending = false;     // coalesce follow-up request
let _domainSnapshots = {};           // domain -> JSON string after last shadow-write

// ── Phase 3: Backfill state ─────────────────────────────────────
var _BACKFILL_VERSION = 2;
var _BACKFILL_SETTINGS_KEY = 'backfillProgress_v1';
var _BACKFILL_TRADE_BATCH = 200;
var _backfillRunning = false;

// ── Batch D2: cloud-first load and stale-write guard ────────────
var _CLOUD_LOAD_TIMEOUT_MS = 20000;
var _cloudBaselineReady = false;     // cloud_primary: baseline matches the cloud (loaded this session)
var _cloudPaused = false;            // cloud_primary: cloud could not be loaded; bulk writes paused
var _cloudSignInFailed = false;      // Supabase sign-in failed during this login
var _rowBaseline = {};               // domain -> { rowKey: row signature } last known to be in the cloud
var _cloudPending = {};              // domain -> { rowKey: true } local changes not yet in the cloud
var _cloudLoadStatus = null;         // { ok, hidden, reason } for the banner after unlock

// ── Batch D3 state (cloud_primary checked saves) ──
var _rowRev = {};                    // domain -> { rowKey: rev } last seen in the cloud
var _cloudDeletes = {};              // domain -> { rowKey: true } explicit deletes not yet in the cloud
var _cloudConflictCount = 0;         // conflicts resolved this session (banner count)
var _lastCloudResyncMs = 0;          // last full cloud load (sign-in or re-sync)
var _cloudResyncRunning = false;

async function initDB() {
    if (!window.denariiStore) {
        throw new Error('Denarii Local must run in the desktop app');
    }

    if (db) {
        try { db.close(); } catch (e) {}
        db = null;
    }

    // The Electron main process opens and checks the SQLite file before the
    // window loads (electron/db.js); open() reports { status: 'created' | 'ok' }.
    // db is only a non-null marker now: storage calls go through window.denariiStore.
    const opened = await window.denariiStore.open();
    db = { backend: 'sqlite', status: opened && opened.status, close: function () {} };

    await ensureLegacyMigration();
    await cleanupLegacyDemoAccount();
    // Demo broker seeding moved to unlockApp() migration block.
    // seedDemoAccount/syncDemoData are now no-ops (legacy stubs).
    return db;
}

// ── Helpers ──────────────────────────────────────

function generateRecoveryKey() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no O/0/I/1
    let key = '';
    let arr;
    try {
        arr = new Uint8Array(16);
        crypto.getRandomValues(arr);
    } catch(e) {
        // Fallback for contexts where crypto.getRandomValues isn't available
        arr = new Uint8Array(16);
        for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
    }
    for (let i = 0; i < 16; i++) {
        if (i > 0 && i % 4 === 0) key += '-';
        key += chars[arr[i] % chars.length];
    }
    return key;
}

function showAuthView(name) {
    document.querySelectorAll('.auth-view').forEach(v => v.style.display = 'none');
    const el = document.getElementById('auth-' + name);
    if (el) el.style.display = 'block';
    // clear errors
    document.querySelectorAll('.auth-error').forEach(e => { e.style.display = 'none'; e.textContent = ''; });
    // Reset New Device mode when returning to login
    if (name === 'login' && typeof toggleNewDeviceMode === 'function') toggleNewDeviceMode(false);
    if (name === 'register') _refreshRegAutoSignIn();
}

function showAuthError(id, msg) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = msg;
    el.style.display = 'block';
}

function toggleNewDeviceMode(on) {
    var emailGroup = document.getElementById('login-email-group');
    var normalLinks = document.getElementById('login-links-normal');
    var newdeviceLinks = document.getElementById('login-links-newdevice');
    var statusEl = document.getElementById('login-status');
    var errorEl = document.getElementById('login-error');
    if (emailGroup) emailGroup.style.display = on ? '' : 'none';
    if (normalLinks) normalLinks.style.display = on ? 'none' : '';
    if (newdeviceLinks) newdeviceLinks.style.display = on ? '' : 'none';
    if (statusEl) { statusEl.textContent = ''; statusEl.style.display = 'none'; }
    if (errorEl) { errorEl.textContent = ''; errorEl.style.display = 'none'; }
    if (!on) {
        var emailInput = document.getElementById('login-email');
        if (emailInput) emailInput.value = '';
    }
}

function togglePasswordVis(inputId, btn) {
    const inp = document.getElementById(inputId);
    if (!inp) return;
    if (inp.type === 'password') { inp.type = 'text'; btn.textContent = 'Hide'; }
    else { inp.type = 'password'; btn.textContent = 'Show'; }
}


// Password strength (visual only)
function updatePwStrength() {
    const pw = document.getElementById('reg-password').value;
    const fill = document.getElementById('pw-strength-fill');
    let score = 0;
    if (pw.length >= 8)  score++;
    if (pw.length >= 12) score++;
    if (/[A-Z]/.test(pw) && /[a-z]/.test(pw)) score++;
    if (/\d/.test(pw)) score++;
    if (/[^A-Za-z0-9]/.test(pw)) score++;
    const pct = Math.min(score / 5 * 100, 100);
    const colors = ['var(--danger)','var(--danger)','var(--warning)','var(--warning)','var(--success)','var(--success)'];
    fill.style.width = pct + '%';
    fill.style.background = colors[score] || 'var(--danger)';
}

// Attach listeners after DOM ready
document.addEventListener('DOMContentLoaded', () => {
    const regPw = document.getElementById('reg-password');
    if (regPw) regPw.addEventListener('input', updatePwStrength);

    // Prefill last successful username
    try {
        const last = localStorage.getItem('denarii_lastUsername');
        if (last) document.getElementById('login-username').value = last;
    } catch(e) {}

    // Show email fields when Supabase is configured
    if (typeof SupabaseAuth !== 'undefined' && SupabaseAuth.isConfigured()) {
        const emailGroup = document.getElementById('reg-email-group');
        if (emailGroup) emailGroup.style.display = '';
        // Show "New Device" link on login form (email field stays hidden until clicked)
        var ndLink = document.getElementById('login-newdevice-link');
        var ndDiv = document.getElementById('login-newdevice-divider');
        if (ndLink) ndLink.style.display = '';
        if (ndDiv) ndDiv.style.display = '';
    }

    // Enter key support
    document.getElementById('reg-confirm').addEventListener('keydown', e => { if (e.key === 'Enter') createNewJournal(); });
    document.getElementById('login-password').addEventListener('keydown', e => { if (e.key === 'Enter') openExistingJournal().catch(_reportLoginError); });
    document.getElementById('forgot-confirm-pw').addEventListener('keydown', e => { if (e.key === 'Enter') resetPassword(); });

    // Legal preview link — bound via addEventListener for reliable pre-login access
    const legalPreviewBtn = document.getElementById('reg-legal-preview-link');
    if (legalPreviewBtn) legalPreviewBtn.addEventListener('click', previewLegalDocuments);

    // Inline legal fallback close button
    const legalInlineClose = document.getElementById('reg-legal-inline-close');
    if (legalInlineClose) legalInlineClose.addEventListener('click', function () {
        var wrapper = document.getElementById('reg-legal-inline');
        if (wrapper) wrapper.style.display = 'none';
    });

    _startupAutoSignIn();
});

// ── Stay signed in on this computer ──────────────────
// The protected key file lives in the main process (electron/auto-signin.js);
// the page only receives the DEK from a successful tryUnlock, which works
// once per app launch, so Lock and reloads land on the sign-in screen.

// Runs at page load. Any result other than a working sign-in leaves the
// normal sign-in screen and changes no account data.
async function _startupAutoSignIn() {
    if (!window.denariiAutoSignIn) return;
    var statusEl = document.getElementById('login-status');
    var hideStatus = function () { if (statusEl) { statusEl.textContent = ''; statusEl.style.display = 'none'; } };
    var r = null;
    try {
        await initDB();
        // Show "Signing in…" only when an attempt can actually happen: an
        // account holds auto sign-in and this launch has not used it yet.
        var st = await window.denariiAutoSignIn.status();
        if (statusEl && st && st.accountId && !st.used) { statusEl.textContent = 'Signing in…'; statusEl.style.display = ''; }
        r = await window.denariiAutoSignIn.tryUnlock();
    } catch (e) {
        console.warn('[Denarii] Automatic sign-in skipped:', e.message || e);
    }
    if (!r || !r.ok) {
        if (r && r.reason !== 'none' && r.reason !== 'used') console.log('[Denarii] Automatic sign-in not used:', r.reason);
        hideStatus();
        return;
    }

    var auth = null;
    try { auth = await getAuthRecordById(r.accountId); } catch (e) { auth = null; }
    if (!auth) { hideStatus(); return; }

    sessionDek = r.dek;
    sessionPassword = null;
    currentAccountId = auth.id;
    currentUsername = auth.username;
    var loaded = false;
    try {
        await setActiveAccount(auth.id);
        loaded = await loadFromIndexedDB({ skipCloudBlob: true });
    } catch (e) {
        loaded = false;
    }
    if (!loaded) {
        sessionDek = null;
        sessionPassword = null;
        currentAccountId = null;
        currentUsername = null;
        await _disableAutoSignIn(auth.id);
        showAuthView('login');
        document.getElementById('login-username').value = auth.username || '';
        showAuthError('login-error', 'Automatic sign-in didn\'t work. Sign in with your password.');
        return;
    }

    try { localStorage.setItem('denarii_lastUsername', auth.username); } catch (e) {}
    hideStatus();
    // Legal acceptance gate, as in a normal sign-in
    if (auth.legalAcceptedVersion === LEGAL_BUNDLE_VERSION) {
        unlockApp();
    } else {
        showLegalAcceptanceModal(auth, function () { unlockApp(); });
    }
}

// Clears automatic sign-in when this account holds it. Never throws.
async function _disableAutoSignIn(accountId) {
    try {
        if (window.denariiAutoSignIn && accountId) await window.denariiAutoSignIn.disable(accountId);
    } catch (e) {
        console.warn('[Denarii] Could not clear automatic sign-in:', e.message || e);
    }
}

// Shows the registration checkbox only when available, with a note when
// another account would lose automatic sign-in.
async function _refreshRegAutoSignIn() {
    var group = document.getElementById('reg-autosignin-group');
    var replaceEl = document.getElementById('reg-autosignin-replace');
    if (!group) return;
    var status = null;
    try { if (window.denariiAutoSignIn) status = await window.denariiAutoSignIn.status(); } catch (e) { status = null; }
    if (!status || !status.available) { group.style.display = 'none'; return; }
    group.style.display = '';
    var owner = null;
    if (status.accountId) {
        try {
            if (!db) await initDB();
            owner = await getAuthRecordById(status.accountId);
        } catch (e) { owner = null; }
    }
    if (replaceEl) {
        replaceEl.textContent = owner ? 'This will replace automatic sign-in for ' + owner.username + '.' : '';
        replaceEl.style.display = owner ? 'block' : 'none';
    }
}

// ── Auth/account store helpers ─────────────────────

function normalizeUsername(username) {
    return String(username || '').trim().toLowerCase();
}

function makeAccountKey(accountId) {
    return 'account:' + accountId;
}

function makeUsernameKey(username) {
    return 'username:' + normalizeUsername(username);
}

function makeJournalKey(accountId) {
    return 'journal:' + accountId;
}
// List all accounts stored in the auth store
async function listAllAccounts() {
    const keys = await storeGetAllKeys(AUTH_STORE);
    const accounts = [];
    for (const key of keys) {
        if (typeof key === 'string' && key.startsWith('account:')) {
            const record = await storeGet(AUTH_STORE, key);
            if (record && record.username) {
                accounts.push(record);
            }
        }
    }
    return accounts;
}

// Delete an account and its journal data.
// For cloud-linked accounts, requires confirmed server-side deletion
// before local cleanup proceeds. Throws on cloud failure so the caller
// can show a user-facing error and leave local data intact.
async function deleteAccount(accountId, username) {
    if (!accountId) return;

    // Read auth record before deleting it — need supabaseUid for cloud check
    var authRecord = await storeGet(AUTH_STORE, makeAccountKey(accountId));

    // Cloud-linked accounts: server must confirm deletion before local wipe.
    // Only this account's own cloud session may be used (throws otherwise).
    if (authRecord && authRecord.supabaseUid) {
        await _deleteSupabaseAccount(authRecord.supabaseUid); // throws on failure
    }

    // ── Local cleanup (runs only after cloud success or for local-only accounts) ──
    // No Webull batch may land in a journal that is being deleted.
    if (typeof WebullSync !== 'undefined' && WebullSync.stopBatchHandler) WebullSync.stopBatchHandler();
    await storeDelete(AUTH_STORE, makeAccountKey(accountId));
    if (username) {
        await storeDelete(AUTH_STORE, makeUsernameKey(username));
    }
    await storeDelete(STORE_NAME, makeJournalKey(accountId));
    await _disableAutoSignIn(accountId);

    if (typeof window._clearAllDrafts === 'function') window._clearAllDrafts();

    const activeId = await getSetting('activeAccountId');
    if (activeId === accountId) {
        await setSetting('activeAccountId', null);
        currentAccountId = null;
    }
}

// ── Supabase full account deletion ──────────────────────────────────
// Calls the server-side /api/delete-account function which uses the
// service_role key to delete all user data rows and the auth.users
// record. The caller's identity is resolved server-side from the JWT, so
// the browser's session must belong to expectedUid (the account being
// deleted); with no session or another account's session nothing is sent.
// Throws on failure so the caller can abort local cleanup.
async function _deleteSupabaseAccount(expectedUid) {
    if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) {
        throw new Error('Cloud service is not available. Try again later or check your connection.');
    }
    var session = await SupabaseAuth.supabaseGetSession();
    var sessionUid = session && session.data && session.data.user ? session.data.user.id : null;
    if (!expectedUid || !sessionUid || sessionUid !== expectedUid || !session.data.access_token) {
        throw new Error('Can\'t delete: this browser is signed in to a different cloud account.');
    }

    var resp;
    try {
        resp = await fetch('/api/delete-account', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': 'Bearer ' + session.data.access_token
            }
        });
    } catch (e) {
        throw new Error('Could not reach the server. Check your connection and try again.');
    }

    if (!resp.ok) {
        var body = {};
        try { body = await resp.json(); } catch (_) {}
        var msg = (body && body.error) ? body.error : 'Server returned status ' + resp.status;
        throw new Error('Cloud account deletion failed: ' + msg);
    }

    console.log('[Denarii] Cloud account fully deleted via server.');
    // Batch D3: scope 'local' — end only this browser's session.
    try {
        var _client = SupabaseAuth.getClient();
        var _so = (_client && _client.auth) ? _client.auth.signOut({ scope: 'local' }) : null;
        if (_so && typeof _so.catch === 'function') _so.catch(function () {});
    } catch (e) { /* the server already deleted the user */ }
}
async function setActiveAccount(accountId) {
    currentAccountId = accountId || null;
    await setSetting('activeAccountId', currentAccountId);
}

async function getAuthRecordById(accountId) {
    if (!accountId) return null;
    return storeGet(AUTH_STORE, makeAccountKey(accountId));
}

async function getAuthRecordByUsername(username) {
    const accountId = await storeGet(AUTH_STORE, makeUsernameKey(username));
    if (!accountId) return null;
    return getAuthRecordById(accountId);
}

async function getAuthRecord() {
    if (currentAccountId) {
        return getAuthRecordById(currentAccountId);
    }
    const activeId = await getSetting('activeAccountId');
    if (!activeId) return null;
    currentAccountId = activeId;
    return getAuthRecordById(activeId);
}

async function saveAuthRecord(record) {
    const username = String(record.username || '').trim();
    const normalized = normalizeUsername(username);
    if (!username || !normalized) throw new Error('Username is required.');

    const existingForUsername = await storeGet(AUTH_STORE, makeUsernameKey(username));
    if (existingForUsername && existingForUsername !== record.id) {
        throw new Error('That username already exists on this device.');
    }

    const accountRecord = {
        ...record,
        id: record.id || (crypto.randomUUID ? crypto.randomUUID() : ('acct_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8))),
        username,
        usernameNormalized: normalized,
        updatedAt: new Date().toISOString()
    };

    await storePut(AUTH_STORE, accountRecord, makeAccountKey(accountRecord.id));
    await storePut(AUTH_STORE, accountRecord.id, makeUsernameKey(username));

    // Mirror auth record to Supabase user_profiles.
    // Awaited for cloud-linked accounts so the profile is confirmed before proceeding.
    if (accountRecord.supabaseUid) {
        await _upsertAuthProfile(accountRecord);
    } else {
        _upsertAuthProfile(accountRecord); // fire-and-forget for local-only
    }

    return accountRecord;
}

// ── Storage mode helpers ───────────────────────────────────────
// Resolves the storageMode for an auth record, backfilling if absent.
// Returns the mode string. Does NOT save — caller must persist if needed.
function _resolveStorageMode(auth) {
    if (auth.storageMode) return auth.storageMode;
    if (auth.supabaseUid) return 'migration_pending';
    return 'local_legacy';
}

// ── Cloud user_profiles helpers ─────────────────────────────────

async function _upsertAuthProfile(accountRecord) {
    try {
        var client = _getSupabaseForBackup();
        if (!client) { console.log('[Denarii] _upsertAuthProfile: no Supabase client, skipped.'); return; }
        var session = await SupabaseAuth.supabaseGetSession();
        if (!session.data || !session.data.user) { console.log('[Denarii] _upsertAuthProfile: no session, skipped.'); return; }
        var userId = session.data.user.id;
        // Batch D2: a session left over from another account must never
        // receive this account's record.
        if (accountRecord.supabaseUid !== userId) { console.log('[Denarii] _upsertAuthProfile: cloud session is not this account, skipped.'); return; }
        var payload = {
            user_id: userId,
            auth_record: accountRecord,
            updated_at: new Date().toISOString()
        };
        var r = await client.from('user_profiles').upsert(payload, { onConflict: 'user_id' });
        if (r.error) {
            // One retry
            console.warn('[Denarii] Cloud auth profile upsert failed, retrying:', r.error.message);
            var retry = await client.from('user_profiles').upsert(payload, { onConflict: 'user_id' });
            if (retry.error) {
                console.error('[Denarii] Cloud auth profile upsert failed after retry:', retry.error.message);
                return;
            }
        }
        console.log('[Denarii] Auth profile synced to cloud (storageMode: ' + (accountRecord.storageMode || 'unset') + ', cloudPrimaryAt: ' + (accountRecord.cloudPrimaryAt || 'none') + ', keys: ' + Object.keys(accountRecord).length + ').');
    } catch (e) {
        console.error('[Denarii] Auth profile upsert error:', e.message || e);
    }
}

// ── Account theme (user_meta row 'themePref') ───────────────────
// Used by js/theme.js. Kept out of _USER_META_KEYS and journalData: last
// write wins, and a theme change is never a journal change. Neither helper
// throws, and a session from another account is never read or written.

async function _themeClientFor(uid) {
    var client = _getSupabaseForBackup();
    if (!client) return null;
    var session = await SupabaseAuth.supabaseGetSession();
    if (!session.data || !session.data.user || session.data.user.id !== uid) return null;
    return client;
}

// Returns { ok: true, theme } (theme null = none saved) or { ok: false }.
async function _fetchAccountTheme(uid) {
    try {
        var client = await _themeClientFor(uid);
        if (!client) return { ok: false };
        var r = await client.from('user_meta').select('value').eq('user_id', uid).eq('key', 'themePref').maybeSingle();
        if (r.error) {
            console.warn('[Denarii] Account theme read failed:', r.error.message || r.error);
            return { ok: false };
        }
        return { ok: true, theme: r.data ? _cloudRowToLocal('_meta', r.data) : null };
    } catch (e) {
        console.warn('[Denarii] Account theme read error:', e.message || e);
        return { ok: false };
    }
}

// The pending marker is cleared only if this is still the current pick.
async function _saveAccountTheme(uid, key) {
    try {
        var client = await _themeClientFor(uid);
        if (!client) return;
        var r = await client.from('user_meta').upsert(
            { user_id: uid, key: 'themePref', value: JSON.stringify(key) },
            { onConflict: 'user_id,key' }
        );
        if (r.error) {
            console.warn('[Denarii] Account theme save failed:', r.error.message || r.error);
            return;
        }
        if (localStorage.getItem('denarii-theme') === key && localStorage.getItem('denarii-theme-pending') === uid) {
            localStorage.removeItem('denarii-theme-pending');
        }
    } catch (e) {
        console.warn('[Denarii] Account theme save error:', e.message || e);
    }
}

// ── Paginated Supabase fetch helper ────────────────────────────
// PostgREST returns at most 1000 rows per request by default.
// This helper fetches all rows for a user using range-based pagination.
var _SB_PAGE_SIZE = 1000;

async function _fetchAllRows(client, table, userId) {
    var all = [];
    var from = 0;
    var done = false;
    while (!done) {
        var res = await client
            .from(table)
            .select('*')
            .eq('user_id', userId)
            .range(from, from + _SB_PAGE_SIZE - 1);
        if (res.error) throw new Error(table + ': ' + res.error.message);
        var batch = res.data || [];
        all = all.concat(batch);
        if (batch.length < _SB_PAGE_SIZE) {
            done = true;
        } else {
            from += _SB_PAGE_SIZE;
        }
    }
    if (all.length > _SB_PAGE_SIZE) {
        console.log('[CloudLoad] Paginated fetch: ' + table + ' — ' + all.length + ' rows in ' + Math.ceil(all.length / _SB_PAGE_SIZE) + ' pages.');
    }
    return all;
}

// ── Supabase trade row mapper (shared) ──���───────────────────
// Maps a single Supabase trades-table row (snake_case) to the
// Denarii camelCase trade object shape. Used by both the full
// cloud-primary journal load and the paginated dashboard fetch.
function _mapSupabaseTradeRow(r) {
    var t = {
        id: r.id, symbol: r.symbol || '', direction: r.direction || '',
        entryDate: r.entry_date || null, exitDate: r.exit_date || null,
        entryPrice: r.entry_price ?? null, exitPrice: r.exit_price ?? null,
        quantity: r.quantity ?? null, pnl: r.pnl ?? null, fees: r.fees ?? null,
        strategy: r.strategy || '', notes: r.notes || '', tags: r.tags || [],
        brokerAccountId: r.broker_account_id || null,
        createdAt: r.created_at || null, updatedAt: r.updated_at || null,
        entryTime: r.entry_time || null, exitTime: r.exit_time || null,
        holdSeconds: r.hold_seconds ?? null, assetType: r.asset_type || null,
        optionType: r.option_type || null, optionAction: r.option_action || null,
        strike: r.strike ?? null, expiry: r.expiry || null,
        setupType: r.setup_type || null, strategyScore: r.strategy_score || null,
        emotion: r.emotion || null, tradeGrade: r.trade_grade || null,
        entryReason: r.entry_reason || null, exitReason: r.exit_reason || null,
        lessons: r.lessons || null, quickNotes: r.quick_notes || null,
        profitTargets: r.profit_targets || null, stopLosses: r.stop_losses || null,
        commissionFees: r.commission_fees ?? null, tradeRisk: r.trade_risk ?? null,
        initialTarget: r.initial_target ?? null, plannedRMultiple: r.planned_r_multiple ?? null,
        realizedRMultiple: r.realized_r_multiple ?? null, drawdown: r.drawdown ?? null,
        runup: r.runup ?? null, source: r.source || null
    };
    // Webull import (Phase 8): added only when the row has a value, so manual /
    // CSV / demo trades load with exactly the same shape as before.
    if (r.external_id != null) t.externalId = r.external_id;
    if (r.external_order_ids != null) t.externalOrderIds = r.external_order_ids;
    if (r.webull_partials != null) t.webullPartials = r.webull_partials;
    // Batch D1: same rule, so rows saved before these columns existed load
    // exactly as before.
    if (r.fills != null) t.fills = r.fills;
    if (r.gross_pnl != null) t.grossPnl = r.gross_pnl;
    if (r.fee_source != null) t.feeSource = r.fee_source;
    if (r.contract_name != null) t.contractName = r.contract_name;
    if (r.source_file != null) t.sourceFile = r.source_file;
    if (r.tos_ref_num != null) t.tosRefNum = r.tos_ref_num;
    if (r.notes_updated_at != null) t.notesUpdatedAt = Number(r.notes_updated_at);
    if (r.session_header_date != null) t.sessionHeaderDate = r.session_header_date;
    if (r.entry_commission_fees != null) t.entryCommissionFees = r.entry_commission_fees;
    if (r.exit_commission_fees != null) t.exitCommissionFees = r.exit_commission_fees;
    // The cloud stores side only as direction; readers of t.type need it too.
    if (t.type == null && t.direction) t.type = t.direction;
    return t;
}

// ── Cloud-primary journal load from row-level Supabase tables ──
// Reconstructs journalData by fetching each domain table individually.
// Used when storageMode === 'cloud_primary' and no local IndexedDB exists.
// opts.strict (Batch D2): any table error throws instead of loading as
// empty, and no version/created defaults are added (only cloud values).
async function _loadJournalFromSupabaseRows(client, userId, opts) {
    console.log('[CloudLoad] Loading journal from Supabase row-level tables for uid:', userId);
    var _strict = !!(opts && opts.strict);
    // Batch D3: opts.revs (an object) receives { domain: { rowKey: rev } },
    // kept outside journalData so it is never saved or exported.
    var _revs = (opts && opts.revs) || null;
    var jd = _strict ? {} : { version: 2, created: new Date().toISOString() };
    function keepRev(dk, key, r) {
        if (!_revs || r.rev == null) return;
        (_revs[dk] || (_revs[dk] = {}))[key] = Number(r.rev);
    }

    // ── Array domains ────────────────────────────────────────────
    // Trades
    try {
        var tradeRows = await _fetchAllRows(client, 'trades', userId);
        jd.trades = tradeRows.map(_mapSupabaseTradeRow);
        console.log('[CloudLoad] Loaded', jd.trades.length, 'trades.');
    } catch (e) { if (_strict) throw e; console.warn('[CloudLoad] Trades error:', e.message); jd.trades = []; }

    var _arrayTables = [
        ['strategies', 'strategies'], ['brokerAccounts', 'broker_accounts'], ['tags', 'tags'],
        ['noteTemplates', 'note_templates'], ['aiOutputHistory', 'ai_reports'], ['aiPrompts', 'ai_prompts']
    ];
    for (var ai = 0; ai < _arrayTables.length; ai++) {
        var dk = _arrayTables[ai][0], table = _arrayTables[ai][1];
        try {
            var rows = await _fetchAllRows(client, table, userId);
            jd[dk] = rows.map(function (r) { keepRev(dk, String(r.id), r); return _cloudRowToLocal(dk, r); });
            console.log('[CloudLoad] Loaded', jd[dk].length, table + '.');
        } catch (e) { if (_strict) throw e; console.warn('[CloudLoad] ' + table + ' error:', e.message); jd[dk] = []; }
    }

    // ── Keyed-object domains ─────────────────────────────────────
    var _keyedTables = [['reviews', 'reviews'], ['dailyPlanners', 'daily_planners'], ['weeklyPlanners', 'weekly_planners']];
    for (var ki = 0; ki < _keyedTables.length; ki++) {
        var kdk = _keyedTables[ki][0], ktable = _keyedTables[ki][1];
        try {
            var krows = await _fetchAllRows(client, ktable, userId);
            jd[kdk] = {};
            krows.forEach(function (r) {
                var key = kdk === 'reviews' ? r.review_type + '|' + r.review_key : r.planner_key;
                jd[kdk][key] = _cloudRowToLocal(kdk, r);
                keepRev(kdk, key, r);
            });
            console.log('[CloudLoad] Loaded', Object.keys(jd[kdk]).length, ktable + '.');
        } catch (e) { if (_strict) throw e; console.warn('[CloudLoad] ' + ktable + ' error:', e.message); jd[kdk] = {}; }
    }

    // ── User meta flags ──────────────────────────────────────────
    try {
        var metaRows = await _fetchAllRows(client, 'user_meta', userId);
        metaRows.forEach(function (r) {
            if (r.key === 'themePref') return; // js/theme.js owns this row
            jd[r.key] = _cloudRowToLocal('_meta', r);
            keepRev('_meta', r.key, r);
        });
        console.log('[CloudLoad] Loaded', metaRows.length, 'user_meta entries.');
    } catch (e) { if (_strict) throw e; console.warn('[CloudLoad] User meta error:', e.message); }

    console.log('[CloudLoad] Journal reconstruction complete. Trades:', (jd.trades || []).length);
    return jd;
}

// One cloud row (any non-trade table) → the local record or value.
// Batch D2: a column missing from the row leaves the field unset, so a cloud
// load never replaces a local value with a default. Batch D3: the same for a
// NULL in the late columns (is_starter, is_favorite, timeframes), and fields
// stored in `extra` are added under the mapped ones (columns win).
function _cloudRowToLocal(dk, r) {
    var t;
    switch (dk) {
        case 'strategies':
            t = {
                id: r.id, name: r.name || '', description: r.description || '',
                color: r.color || '', groups: r.groups || [],
                isFavorite: r.is_favorite !== false,
                created: r.created_at || null, updated: r.updated_at || null,
                createdBy: r.created_by || null
            };
            break;
        case 'brokerAccounts':
            t = {
                id: r.id, broker: r.broker || '', accountNumber: r.account_number || '',
                displayName: r.display_name || '', tradingStyle: r.trading_style || '',
                color: r.color || '', isDefault: !!r.is_default,
                visible: r.visible !== false,
                openingBalance: r.opening_balance ?? null,
                openingBalanceDate: r.opening_balance_date || null,
                cashAdjustments: r.cash_adjustments || [],
                recurringFees: r.recurring_fees || [],
                isDemo: !!r.is_demo,
                createdAt: r.created_at || null
            };
            break;
        case 'tags':
            t = {
                id: r.id, name: r.name || '', category: r.category || '',
                description: r.description || '', isFavorite: r.is_favorite !== false,
                isStarter: !!r.is_starter,
                createdAt: r.created_at || null
            };
            if (r.is_starter == null) delete t.isStarter;
            break;
        case 'noteTemplates':
            t = {
                id: r.id, name: r.name || '',
                content: r.body || '', body: r.body || '',
                sourceType: r.source_type || 'user',
                isFavorite: !!r.is_favorite,
                timeframes: r.timeframes || [],
                createdAt: r.created_at || null, updatedAt: r.updated_at || null
            };
            if (r.is_favorite == null) delete t.isFavorite;
            if (r.timeframes == null) delete t.timeframes;
            break;
        case 'aiOutputHistory':
            t = {
                id: r.id, createdAt: r.created_at || null,
                promptTitle: r.prompt_title || null, promptText: r.prompt_text || null,
                rawText: r.raw_text || null, provider: r.provider || null,
                model: r.model || null, durationMs: r.duration_ms != null ? Number(r.duration_ms) : null,
                filters: r.filters || null, structuredData: r.structured_data || null,
                fingerprint: r.fingerprint || null
            };
            break;
        case 'aiPrompts':
            t = {
                id: r.id, title: r.title || '', description: r.description || '',
                promptText: r.prompt_text || '', category: r.category || 'All',
                strategyTags: r.strategy_tags || [], style: r.style || 'All',
                favorite: !!r.favorite, createdBy: r.created_by || '',
                createdAt: r.created_at || null, updatedAt: r.updated_at || null
            };
            break;
        case 'reviews':
        case 'dailyPlanners':
        case 'weeklyPlanners':
            return r.data || {};
        case '_meta':
            try { return JSON.parse(r.value); } catch (_) { return r.value; }
        default:
            return null;
    }
    if (r.extra && typeof r.extra === 'object' && !Array.isArray(r.extra)) {
        for (var k in r.extra) {
            if (Object.prototype.hasOwnProperty.call(r.extra, k) && t[k] === undefined) t[k] = r.extra[k];
        }
    }
    return t;
}

// ── Cloud Dashboard paginated fetch (Phase 1) ───────────────
// Fetches one page of trades from Supabase with server-side filtering,
// sorting, and pagination. Returns { rows, totalCount, error }.
// Called by the cloud_primary Dashboard Trades tab.
//
// filters shape: { brokerAccountId, dateFrom, dateTo, setup, assetType,
//                  strategy, symbol, styledBrokerAccountIds }
// sort shape:    { field: <client sort key>, dir: 'asc'|'desc' }

var _CLOUD_DASH_SORT_MAP = {
    exitTime:   'exit_time',
    symbol:     'symbol',
    assetType:  'asset_type',
    type:       'direction',
    setupType:  'setup_type',
    quantity:   'quantity',
    entryPrice: 'entry_price',
    exitPrice:  'exit_price',
    pnl:        'pnl',
    broker:     'broker_account_id'
};

// Limits a query to the local days dateFrom through dateTo, the same trades the
// local filter keeps. Uses COALESCE-equivalent logic: exit_time if present, else
// entry_time. PostgREST .or() groups are ANDed with other filters. The columns are
// TEXT holding toISOString() values, so bounds must be in that exact format to
// compare in time order, and the end is exclusive so no part of the last day is lost.
function _applyCloudDateRange(query, filters) {
    var start = filters.dateFrom && DenariiFilters.localDayStartUtc(filters.dateFrom);
    if (start) {
        query = query.or(
            'exit_time.gte."' + start + '"'
            + ',and(exit_time.is.null,entry_time.gte."' + start + '")'
        );
    }
    var end = filters.dateTo && DenariiFilters.nextLocalDayStartUtc(filters.dateTo);
    if (end) {
        query = query.or(
            'exit_time.lt."' + end + '"'
            + ',and(exit_time.is.null,entry_time.lt."' + end + '")'
        );
    }
    return query;
}

// Strategy filter (setup_type holds the strategy name). No Strategy is the
// same test as the local filter: null, empty or only spaces.
function _applyCloudStrategy(query, strategy) {
    if (!strategy || strategy === 'all') return query;
    if (strategy === DenariiFilters.NO_STRATEGY) {
        return query.or('setup_type.is.null,setup_type.match."^[[:space:]]*$"');
    }
    return query.eq('setup_type', strategy);
}

async function _fetchCloudDashPage(client, userId, filters, sort, page, pageSize) {
    try {
        var query = client
            .from('trades')
            .select('*', { count: 'exact' })
            .eq('user_id', userId);

        // ── Broker account / global account filter ──
        if (filters.brokerAccountId && filters.brokerAccountId !== 'all') {
            query = query.eq('broker_account_id', filters.brokerAccountId);
        } else if (Array.isArray(filters.visibleBrokerAccountIds)) {
            if (filters.visibleBrokerAccountIds.length > 0) {
                // Include only trades from visible brokers
                query = query.in('broker_account_id', filters.visibleBrokerAccountIds);
            } else {
                // All brokers hidden — return zero results
                query = query.eq('broker_account_id', '__none__');
            }
        }

        // ── Style filter (pre-resolved to broker account IDs) ──
        if (filters.styledBrokerAccountIds && filters.styledBrokerAccountIds.length > 0) {
            query = query.in('broker_account_id', filters.styledBrokerAccountIds);
        }

        // ── Date range filter ──
        query = _applyCloudDateRange(query, filters);

        // ── Asset type filter ──
        if (filters.assetType && filters.assetType !== 'all') {
            query = query.eq('asset_type', filters.assetType);
        }

        // ── Strategy filter ──
        query = _applyCloudStrategy(query, filters.strategy);

        // ── Symbol filter (case-insensitive partial match) ──
        if (filters.symbol) {
            query = query.ilike('symbol', '%' + filters.symbol + '%');
        }

        // ── Sort ──
        var sbCol = _CLOUD_DASH_SORT_MAP[sort.field] || 'exit_time';
        query = query.order(sbCol, { ascending: sort.dir === 'asc', nullsFirst: false });

        // ── Pagination ──
        var from = (page - 1) * pageSize;
        var to = from + pageSize - 1;
        query = query.range(from, to);

        var res = await query;
        if (res.error) {
            console.error('[CloudDash] Page fetch error:', res.error.message);
            return { rows: [], totalCount: 0, error: res.error.message };
        }

        var mapped = (res.data || []).map(_mapSupabaseTradeRow);
        var totalCount = typeof res.count === 'number' ? res.count : 0;

        console.log('[CloudDash] Page ' + page + ': ' + mapped.length + ' rows, ' + totalCount + ' total matching.');
        return { rows: mapped, totalCount: totalCount, error: null };
    } catch (err) {
        console.error('[CloudDash] Page fetch exception:', err.message);
        return { rows: [], totalCount: 0, error: err.message };
    }
}

// ── Cloud Dashboard aggregate metrics fetch (Phase 2) ───────
// Fetches only pnl + exit_time columns for ALL trades matching
// the active Dashboard filters (no pagination limit, no sort).
// Computes aggregate metrics client-side from the minimal payload.
// No Supabase RPC or schema changes required.
//
// Returns: { totalTrades, closedTrades, totalPnl, winCount,
//            lossCount, winRate, avgWin, avgLoss, profitFactor, error }

async function _fetchCloudDashMetrics(client, userId, filters) {
    try {
        var all = [];
        var from = 0;
        var batchSize = 1000;
        var done = false;

        while (!done) {
            var query = client
                .from('trades')
                .select('pnl, exit_time')
                .eq('user_id', userId);

            // ── Apply same filters as page query ──
            if (filters.brokerAccountId && filters.brokerAccountId !== 'all') {
                query = query.eq('broker_account_id', filters.brokerAccountId);
            } else if (Array.isArray(filters.visibleBrokerAccountIds)) {
                if (filters.visibleBrokerAccountIds.length > 0) {
                    query = query.in('broker_account_id', filters.visibleBrokerAccountIds);
                } else {
                    query = query.eq('broker_account_id', '__none__');
                }
            }
            if (filters.styledBrokerAccountIds && filters.styledBrokerAccountIds.length > 0) {
                query = query.in('broker_account_id', filters.styledBrokerAccountIds);
            }
            query = _applyCloudDateRange(query, filters);
            if (filters.assetType && filters.assetType !== 'all') {
                query = query.eq('asset_type', filters.assetType);
            }
            query = _applyCloudStrategy(query, filters.strategy);
            if (filters.symbol) {
                query = query.ilike('symbol', '%' + filters.symbol + '%');
            }

            query = query.range(from, from + batchSize - 1);

            var res = await query;
            if (res.error) throw new Error(res.error.message);

            var batch = res.data || [];
            all = all.concat(batch);
            if (batch.length < batchSize) done = true;
            else from += batchSize;
        }

        // ── Compute metrics from minimal column set ──
        var totalTrades = all.length;
        var closedCount = 0, totalPnl = 0;
        var winCount = 0, lossCount = 0, winSum = 0, lossSum = 0;

        for (var i = 0; i < all.length; i++) {
            if (all[i].exit_time == null) continue; // open trade
            closedCount++;
            var p = Number(all[i].pnl) || 0;
            totalPnl += p;
            if (p > 0) { winCount++; winSum += p; }
            else if (p < 0) { lossCount++; lossSum += p; }
        }

        var avgWin = winCount > 0 ? winSum / winCount : 0;
        var avgLoss = lossCount > 0 ? lossSum / lossCount : 0;
        var profitFactor = lossSum ? Math.abs(winSum / lossSum) : (winSum > 0 ? Infinity : 0);
        var winRate = closedCount > 0 ? (winCount / closedCount * 100) : 0;

        console.log('[CloudDash] Metrics: ' + totalTrades + ' total, '
            + closedCount + ' closed, P&L=$' + totalPnl.toFixed(2)
            + ', ' + winCount + 'W/' + lossCount + 'L');

        return {
            totalTrades: totalTrades,
            closedTrades: closedCount,
            totalPnl: totalPnl,
            winCount: winCount,
            lossCount: lossCount,
            winRate: winRate,
            avgWin: avgWin,
            avgLoss: avgLoss,
            profitFactor: profitFactor,
            error: null
        };
    } catch (err) {
        console.error('[CloudDash] Metrics fetch error:', err.message);
        return { error: err.message };
    }
}

// ── Cloud-primary trade save helpers (Phase 1 Supabase-primary) ──
// Direct Supabase writes for trade mutations on cloud_primary accounts.
// Supabase becomes the source of truth; IndexedDB is written after as cache.

function _isCloudPrimarySave() {
    return window._denariiStorageMode === 'cloud_primary'
        && typeof SupabaseAuth !== 'undefined'
        && SupabaseAuth.isReady();
}

function _getCloudSaveContext() {
    if (!_isCloudPrimarySave()) return null;
    var client = SupabaseAuth.getClient();
    var userId = window._denariiSupabaseUid;
    if (!client || !userId) return null;
    return { client: client, userId: userId };
}

// Upsert a single trade to Supabase. The upsert's column list is this row's
// own keys, so a column _mapArrayRow leaves out keeps its cloud value.
async function _saveTradeToSupabase(trade) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return { success: false, error: 'Cloud save not available' };
    try {
        var row = _mapArrayRow(ctx.userId, 'trades', trade);
        if (!row) return { success: false, error: 'Trade mapping failed' };
        var res = await ctx.client.from('trades').upsert([row], { onConflict: 'user_id,id' });
        if (res.error) {
            console.error('[CloudSave] Trade upsert failed:', res.error.message);
            return { success: false, error: res.error.message };
        }
        console.log('[CloudSave] Trade saved:', trade.id);
        return { success: true, error: null };
    } catch (err) {
        console.error('[CloudSave] Trade upsert exception:', err.message);
        return { success: false, error: err.message };
    }
}

// Batch D1: supabase-js sends the union of all rows' keys as the upsert's
// column list, and PostgREST's ON CONFLICT DO UPDATE sets every listed
// column, so a row that leaves a column out would have it set to NULL (or to
// its default with defaultToNull: false, which is NULL here too). Upserting
// each group of rows with the same key set keeps every request's column list
// equal to each row's own keys, so omitted columns keep their cloud value.
function _groupRowsByKeySet(rows) {
    var groups = {}, order = [];
    for (var i = 0; i < rows.length; i++) {
        var sig = Object.keys(rows[i]).sort().join(',');
        if (!groups[sig]) { groups[sig] = []; order.push(sig); }
        groups[sig].push(rows[i]);
    }
    return order.map(function (s) { return groups[s]; });
}

// Upsert multiple trades to Supabase (chunked, one request per key set).
async function _saveTradesToSupabase(trades) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return { success: false, error: 'Cloud save not available' };
    try {
        var rows = [];
        for (var i = 0; i < trades.length; i++) {
            var row = _mapArrayRow(ctx.userId, 'trades', trades[i]);
            if (row) rows.push(row);
        }
        if (rows.length === 0) return { success: true, error: null };
        var CHUNK = 500;
        var groups = _groupRowsByKeySet(rows);
        for (var gi = 0; gi < groups.length; gi++) {
            for (var c = 0; c < groups[gi].length; c += CHUNK) {
                var chunk = groups[gi].slice(c, c + CHUNK);
                var res = await ctx.client.from('trades').upsert(chunk, { onConflict: 'user_id,id' });
                if (res.error) {
                    console.error('[CloudSave] Bulk trade upsert failed at group ' + (gi + 1) + ' chunk ' + (c / CHUNK + 1) + ':', res.error.message);
                    return { success: false, error: res.error.message };
                }
            }
        }
        console.log('[CloudSave] ' + rows.length + ' trades saved.');
        return { success: true, error: null };
    } catch (err) {
        console.error('[CloudSave] Bulk trade upsert exception:', err.message);
        return { success: false, error: err.message };
    }
}

// Delete a single trade from Supabase by id.
async function _deleteTradeFromSupabase(tradeId) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return { success: false, error: 'Cloud save not available' };
    try {
        var res = await ctx.client.from('trades').delete()
            .eq('user_id', ctx.userId).eq('id', tradeId);
        if (res.error) {
            console.error('[CloudSave] Trade delete failed:', res.error.message);
            return { success: false, error: res.error.message };
        }
        console.log('[CloudSave] Trade deleted:', tradeId);
        return { success: true, error: null };
    } catch (err) {
        console.error('[CloudSave] Trade delete exception:', err.message);
        return { success: false, error: err.message };
    }
}

// Delete multiple trades from Supabase by ids.
async function _deleteTradesFromSupabase(tradeIds) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return { success: false, error: 'Cloud save not available' };
    try {
        var res = await ctx.client.from('trades').delete()
            .eq('user_id', ctx.userId).in('id', tradeIds);
        if (res.error) {
            console.error('[CloudSave] Bulk trade delete failed:', res.error.message);
            return { success: false, error: res.error.message };
        }
        console.log('[CloudSave] ' + tradeIds.length + ' trades deleted.');
        return { success: true, error: null };
    } catch (err) {
        console.error('[CloudSave] Bulk trade delete exception:', err.message);
        return { success: false, error: err.message };
    }
}

// ── Cloud-primary single-record helpers (non-trade) ──
// Batch D3: saves go through the checked save (_cloudSaveRow) and deletes
// through the tracked delete (_cloudDeleteRow): session check, paused →
// pending, update only where the rev still matches, conflict → the cloud
// wins and this browser's version is kept. Return shape is unchanged.

async function _saveStrategyToSupabase(strategy) { return _cloudSaveRow('strategies', strategy); }
async function _deleteStrategyFromSupabase(strategyId) { return _cloudDeleteRow('strategies', strategyId); }

async function _saveTagToSupabase(tag) { return _cloudSaveRow('tags', tag); }
async function _deleteTagFromSupabase(tagId) { return _cloudDeleteRow('tags', tagId); }

async function _saveNoteTemplateToSupabase(tmpl) { return _cloudSaveRow('noteTemplates', tmpl); }
async function _deleteNoteTemplateFromSupabase(tmplId) { return _cloudDeleteRow('noteTemplates', tmplId); }

async function _saveAiReportToSupabase(report) { return _cloudSaveRow('aiOutputHistory', report); }
async function _deleteAiReportFromSupabase(reportId) { return _cloudDeleteRow('aiOutputHistory', reportId); }

async function _saveAiPromptToSupabase(prompt) { return _cloudSaveRow('aiPrompts', prompt); }
async function _deleteAiPromptFromSupabase(promptId) { return _cloudDeleteRow('aiPrompts', promptId); }

async function _saveAiPromptFavoritesToSupabase() {
    var ctx = _getCloudSaveContext();
    if (!ctx) return;
    var favs = (typeof journalData !== 'undefined' && Array.isArray(journalData.aiPromptFavorites))
        ? journalData.aiPromptFavorites : [];
    return _cloudSaveRows(ctx, '_meta', [{ user_id: ctx.userId, key: 'aiPromptFavorites', value: JSON.stringify(favs) }]);
}

async function _saveDeletedStrategyKeysToSupabase() {
    var ctx = _getCloudSaveContext();
    if (!ctx) return;
    return _cloudSaveRows(ctx, '_meta', [{ user_id: ctx.userId, key: '_deletedStrategyKeys', value: JSON.stringify(journalData._deletedStrategyKeys || []) }]);
}

async function _saveBrokerAccountToSupabase(account) { return _cloudSaveRow('brokerAccounts', account); }

// Broker account delete stays online-only and blocking (callers delete the
// account's trades with it), so it is not queued like the deletes above.
async function _deleteBrokerAccountFromSupabase(accountId) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return { success: false, error: 'Cloud save not available' };
    try {
        var uid = await _cloudSessionUid();
        if (!uid) return { success: false, error: 'Cloud session is not this account' };
        var res = await ctx.client.from('broker_accounts').delete()
            .eq('user_id', uid).eq('id', accountId);
        if (res.error) {
            console.error('[CloudSave] Broker account delete failed:', res.error.message);
            return { success: false, error: res.error.message };
        }
        _forgetCloudRow('brokerAccounts', String(accountId));
        console.log('[CloudSave] Broker account deleted:', accountId);
        return { success: true, error: null };
    } catch (err) {
        console.error('[CloudSave] Broker account delete exception:', err.message);
        return { success: false, error: err.message };
    }
}

// Force the cloud Dashboard to refetch page + metrics on the next
// updateDashboard() call. Delegates to window._invalidateCloudDash
// which is set by Denarii.js where the dashboard state variables live.
function _triggerCloudDashRefresh() {
    if (typeof window._invalidateCloudDash === 'function') window._invalidateCloudDash();
}

async function _fetchAuthProfileFromCloud() {
    try {
        var client = _getSupabaseForBackup();
        if (!client) return null;
        var session = await SupabaseAuth.supabaseGetSession();
        if (!session.data || !session.data.user) return null;
        var userId = session.data.user.id;
        var res = await client.from('user_profiles').select('auth_record').eq('user_id', userId).single();
        if (res.error || !res.data || !res.data.auth_record) return null;
        console.log('[Denarii] Auth profile restored from cloud.');
        return res.data.auth_record;
    } catch (e) {
        console.warn('[Denarii] Cloud auth profile fetch error:', e.message || e);
        return null;
    }
}

async function saveJournalRecord(accountId, saveData) {
    if (!accountId) throw new Error('No active account selected.');
    const existing = await storeGet(STORE_NAME, makeJournalKey(accountId));
    if (existing) {
        if (existing.recoveryData && !saveData.recoveryData) {
            saveData.recoveryData = existing.recoveryData;
            // Carry forward freshness timestamp when inheriting old recoveryData
            if (existing.recoveryDataSavedAt && !saveData.recoveryDataSavedAt) {
                saveData.recoveryDataSavedAt = existing.recoveryDataSavedAt;
            }
        }
        if (existing.lastBackup && !saveData.lastBackup) {
            saveData.lastBackup = existing.lastBackup;
        }
    }
    await storePut(STORE_NAME, saveData, makeJournalKey(accountId));
}

async function getJournalRecord(accountId) {
    if (!accountId) return null;
    return storeGet(STORE_NAME, makeJournalKey(accountId));
}

// ── Pre-import safety snapshot ──────────────────────────────────
// Saves a copy of the current encrypted journal record before a destructive
// operation (import) overwrites it. Stored in the existing journal store
// under a "snapshot:<accountId>:<timestamp>" key to avoid a DB version bump.
// Returns the snapshot key, or null if there was nothing to snapshot.
async function snapshotJournalRecord(accountId, reason) {
    if (!accountId) return null;
    var existing = await storeGet(STORE_NAME, makeJournalKey(accountId));
    if (!existing || !existing.data) return null; // nothing to protect
    var ts = new Date().toISOString();
    var snapshotKey = 'snapshot:' + accountId + ':' + ts;
    var snapshot = {
        _isSnapshot: true,
        sourceAccountId: accountId,
        reason: reason || 'unknown',
        snapshotAt: ts,
        encrypted: existing.encrypted,
        data: existing.data,
        lastSaved: existing.lastSaved || null,
        recoveryData: existing.recoveryData || null
    };
    await storePut(STORE_NAME, snapshot, snapshotKey);
    console.log('[Denarii] Safety snapshot created:', snapshotKey, '(' + reason + ')');

    // Prune old snapshots — keep only the 3 most recent per account
    _pruneSnapshots(accountId, 3);

    return snapshotKey;
}

// ── Snapshot pruning ────────────────────────────────────────────
// Keeps only the `keep` most recent snapshots for the given account.
// Runs fire-and-forget after snapshot creation so it never blocks import.
var MAX_SNAPSHOTS_DEFAULT = 3;
async function _pruneSnapshots(accountId, keep) {
    try {
        var limit = keep || MAX_SNAPSHOTS_DEFAULT;
        var prefix = 'snapshot:' + accountId + ':';
        var allKeys = await storeGetAllKeys(STORE_NAME);
        var snapshotKeys = [];
        for (var i = 0; i < allKeys.length; i++) {
            if (typeof allKeys[i] === 'string' && allKeys[i].indexOf(prefix) === 0) {
                snapshotKeys.push(allKeys[i]);
            }
        }
        if (snapshotKeys.length <= limit) return;
        // Keys contain ISO timestamps — lexicographic sort = chronological sort
        snapshotKeys.sort();
        var toDelete = snapshotKeys.slice(0, snapshotKeys.length - limit);
        for (var d = 0; d < toDelete.length; d++) {
            await storeDelete(STORE_NAME, toDelete[d]);
        }
        console.log('[Denarii] Pruned ' + toDelete.length + ' old snapshot(s) for account ' + accountId);
    } catch (e) {
        console.warn('[Denarii] Snapshot pruning error:', e.message || e);
    }
}

async function ensureLegacyMigration() {
    const migrated = await getSetting('multiAccountMigrated');
    if (migrated) return;

    const legacyAccount = await storeGet(AUTH_STORE, 'account');
    const legacyJournal = await storeGet(STORE_NAME, 'journal_data');

    if (legacyAccount && !legacyAccount.id) {
        const migratedAccount = await saveAuthRecord({
            ...legacyAccount,
            createdAt: legacyAccount.createdAt || new Date().toISOString()
        });

        if (legacyJournal) {
            await storePut(STORE_NAME, legacyJournal, makeJournalKey(migratedAccount.id));
        }

        await setActiveAccount(migratedAccount.id);
    }

    await setSetting('multiAccountMigrated', true);
}

// One-time cleanup: remove stale Pelosi demo auth record from legacy seed model
async function cleanupLegacyDemoAccount() {
    var cleaned = await getSetting('legacyDemoAccountCleaned');
    if (cleaned) return;

    try {
        var demo = await getAuthRecordByUsername('Pelosi');
        if (demo && !demo.supabaseUid && !demo.email) {
            await deleteAccount(demo.id, 'Pelosi');
            console.log('[Denarii] Removed legacy Pelosi demo account from local storage.');
        }
    } catch (e) {
        console.warn('[Denarii] Demo account cleanup error:', e.message || e);
    }

    await setSetting('legacyDemoAccountCleaned', true);
}

// Encryption — supports legacy passphrase mode and direct DEK key mode.
// DEK mode is used when the key is a 64-char hex string; output is prefixed
// with "dek:" so decrypt can detect the format. Legacy mode is unchanged.
var _isDekHex = function(k) { return typeof k === 'string' && /^[0-9a-f]{64}$/.test(k); };

function encrypt(data, key) {
    var plaintext = JSON.stringify(data);
    if (_isDekHex(key)) {
        var aesKey = CryptoJS.enc.Hex.parse(key);
        var iv = CryptoJS.lib.WordArray.random(16);
        var ct = CryptoJS.AES.encrypt(plaintext, aesKey, {
            iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
        });
        return 'dek:' + iv.concat(ct.ciphertext).toString(CryptoJS.enc.Base64);
    }
    return CryptoJS.AES.encrypt(plaintext, key).toString();
}

function decrypt(encrypted, key) {
    try {
        if (typeof encrypted === 'string' && encrypted.startsWith('dek:')) {
            var aesKey = CryptoJS.enc.Hex.parse(key);
            var combined = CryptoJS.enc.Base64.parse(encrypted.slice(4));
            var iv = CryptoJS.lib.WordArray.create(combined.words.slice(0, 4), 16);
            var ct = CryptoJS.lib.WordArray.create(combined.words.slice(4), combined.sigBytes - 16);
            var bytes = CryptoJS.AES.decrypt({ ciphertext: ct }, aesKey, {
                iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7
            });
            return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
        }
        var bytes = CryptoJS.AES.decrypt(encrypted, key);
        return JSON.parse(bytes.toString(CryptoJS.enc.Utf8));
    } catch {
        return null;
    }
}

// ── Cloud journal backup helpers ─────────────────────────────
// Non-fatal: all failures are caught and logged as warnings.

function _getSupabaseForBackup() {
    if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) return null;
    return SupabaseAuth.getClient();
}

async function _cloudBackupJournal(encryptedData) {
    // Batch D3: retired for cloud_primary — every data type now lives in the
    // row tables. The last journal_backups row is left untouched.
    if (window._denariiStorageMode === 'cloud_primary') return;
    var now = Date.now();
    var isFirstCall = !_firstCloudSaveDone;

    // Debounce: skip if last cloud write was < 60s ago (but bypass for first call)
    if (!isFirstCall && now - _lastCloudSaveMs < 60000) return;
    // Batch D2: paused until this session has a cloud baseline.
    if (!_cloudWriteAllowed()) return;

    try {
        var client = _getSupabaseForBackup();
        if (!client) return;
        var session = await SupabaseAuth.supabaseGetSession();
        if (!session.data || !session.data.user) return;
        var userId = session.data.user.id;
        if (!_sessionMatchesAccount(userId)) return;
        var r = await client.from('journal_backups').upsert({
            user_id: userId,
            encrypted_data: encryptedData,
            last_saved: new Date().toISOString()
        }, { onConflict: 'user_id' });
        if (r.error) {
            console.warn('[Denarii] Cloud journal backup failed:', r.error.message);
        } else {
            _lastCloudSaveMs = Date.now();
            _firstCloudSaveDone = true;
            console.log('[Denarii] Journal backed up to cloud' + (isFirstCall ? ' (first write, awaited).' : '.'));
        }
    } catch (e) {
        console.warn('[Denarii] Cloud backup error:', e.message || e);
    }
}

async function _fetchJournalFromCloud() {
    try {
        var client = _getSupabaseForBackup();
        if (!client) return null;
        var session = await SupabaseAuth.supabaseGetSession();
        if (!session.data || !session.data.user) return null;
        var userId = session.data.user.id;
        var res = await client.from('journal_backups').select('encrypted_data, last_saved').eq('user_id', userId).single();
        if (res.error || !res.data || !res.data.encrypted_data) return null;
        console.log('[Denarii] Journal restored from cloud backup (saved ' + res.data.last_saved + ').');
        return { encrypted: true, data: res.data.encrypted_data, lastSaved: res.data.last_saved };
    } catch (e) {
        console.warn('[Denarii] Cloud fetch error:', e.message || e);
        return null;
    }
}

// Save to the local database — uses sessionDek when available, otherwise sessionPassword.
// -> { ok: true } once the encrypted journal is written locally (cloud backup
// errors after that don't change it), or { ok: false, error } when nothing was
// written. Callers that ignore the result keep working.
async function saveToIndexedDB() {
    // ── Migration gate: defer saves while cloud migration is running ──
    if (window._denariiMigrationRunning) {
        _migrationSavePending = true;
        console.log('[Denarii] Save deferred — cloud migration in progress.');
        return { ok: false, error: 'Save deferred during migration.' };
    }

    var encKey = sessionDek || sessionPassword;
    if (!db || !encKey || !currentAccountId) {
        console.warn('[Denarii] Save skipped — session not ready.');
        // Phase 1: mark dirty since data wasn't persisted
        if (typeof _journalDirty !== 'undefined') _journalDirty = true;
        var warnEl = document.getElementById('save-status');
        if (warnEl) { warnEl.textContent = '⚠ Not saved'; warnEl.classList.remove('saved'); warnEl.style.display = ''; }
        return { ok: false, error: 'Session not ready.' };
    }

    var result = { ok: false, error: 'Save failed.' };
    try {
        const encrypted = encrypt(journalData, encKey);

        const saveData = {
            encrypted: true,
            data: encrypted,
            lastSaved: new Date().toISOString()
        };

        // recoveryData still uses legacy passphrase mode (recovery key is not a DEK)
        if (pendingRecoveryKey) {
            saveData.recoveryData = encrypt(journalData, pendingRecoveryKey);
            saveData.recoveryDataSavedAt = saveData.lastSaved; // track freshness
        }

        await saveJournalRecord(currentAccountId, saveData);
        result = { ok: true };

        // Cloud writes: await the first call per session to ensure cloud data
        // is confirmed before the user relies on cloud restore/sync.
        // Subsequent calls use fire-and-forget with debounce.
        if (!_firstCloudSaveDone) {
            await _cloudBackupJournal(encrypted);
            await _shadowWriteRowsAwaited(journalData);
        } else {
            _cloudBackupJournal(encrypted);
            _shadowWriteRows(journalData);
        }

        // Phase 1: clear dirty flag on successful persist
        if (typeof _journalDirty !== 'undefined') _journalDirty = false;

        const statusEl = document.getElementById('save-status');
        if (statusEl) {
            statusEl.textContent = '✓ Saved';
            statusEl.classList.add('saved');
            statusEl.style.display = '';
            setTimeout(() => { statusEl.style.display = 'none'; }, 3000);
        }
    } catch (error) {
        console.error('IndexedDB save failed:', error);
        if (!result.ok) result = { ok: false, error: (error && error.message) || 'Save failed.' };
        // Phase 1: mark dirty on failed persist so beforeunload can warn
        if (typeof _journalDirty !== 'undefined') _journalDirty = true;
        var failEl = document.getElementById('save-status');
        if (failEl) { failEl.textContent = '⚠ Save failed'; failEl.classList.remove('saved'); failEl.style.display = ''; }
    }
    if (typeof _refreshStrategiesIfVisible === 'function') _refreshStrategiesIfVisible();
    return result;
}

// Load from the local database — uses sessionDek when available, otherwise sessionPassword
// opts.skipCloudBlob (Batch D3): cloud_primary never restores the retired
// journal_backups blob; the caller loads the row tables instead.
async function loadFromIndexedDB(opts) {
    var encKey = sessionDek || sessionPassword;
    if (!db || !encKey || !currentAccountId) return false;

    try {
        var result = await getJournalRecord(currentAccountId);

        // If no local journal, try restoring from Supabase cloud backup
        if (!result && !(opts && opts.skipCloudBlob)) {
            result = await _fetchJournalFromCloud();
            if (result) {
                await saveJournalRecord(currentAccountId, result);
            }
        }

        if (!result) {
            return false;
        }

        const decrypted = decrypt(result.data, encKey);
        if (!decrypted) {
            throw new Error('Wrong password');
        }

        journalData = decrypted;
        if (!journalData.brokerAccounts) journalData.brokerAccounts = [];
        lastBackupTime = result.lastBackup || null;
        return true;
    } catch (error) {
        console.error('IndexedDB load failed:', error);
        return false;
    }
}

// Create new journal (registration)
async function createNewJournal() {
    const username = document.getElementById('reg-username').value.trim();
    const password = document.getElementById('reg-password').value;
    const confirm  = document.getElementById('reg-confirm').value;
    const btn = document.querySelector('#auth-register .btn.btn-primary');

    document.getElementById('reg-error').style.display = 'none';
    document.getElementById('reg-error').textContent = '';

    if (!username || username.length < 2) { showAuthError('reg-error', 'Username must be at least 2 characters.'); return; }
    if (password.length < 8) { showAuthError('reg-error', 'Password must be at least 8 characters.'); return; }
    if (password !== confirm) { showAuthError('reg-error', 'Passwords do not match.'); return; }

    // Legal acceptance gate — must accept before account creation
    const legalCb = document.getElementById('reg-legal-accept');
    if (!legalCb || !legalCb.checked) { showAuthError('reg-error', 'You must accept the legal terms before creating an account.'); return; }

    // ── Supabase pre-validation (email required when configured) ─
    const supabaseEnabled = typeof SupabaseAuth !== 'undefined' && SupabaseAuth.isConfigured();
    let supabaseEmail = null;

    if (supabaseEnabled) {
        const emailInput = document.getElementById('reg-email');
        const email = emailInput ? emailInput.value.trim() : '';
        if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
            showAuthError('reg-error', 'A valid email address is required for account creation.');
            return;
        }
        supabaseEmail = email;
    }

    try {
        if (btn) { btn.disabled = true; btn.textContent = 'Creating...'; }

        // ── Local validation first (before any Supabase call) ────
        await initDB();

        const existing = await getAuthRecordByUsername(username);
        if (existing) {
            showAuthError('reg-error', 'That username already exists on this device. Sign in instead or choose another username.');
            return;
        }

        // ── Supabase cloud registration (only after local checks pass) ──
        let supabaseUid = null;

        if (supabaseEnabled) {
            if (!SupabaseAuth.isReady()) {
                const initResult = SupabaseAuth.initSupabaseAuth();
                if (initResult.error) {
                    showAuthError('reg-error', 'Cloud service unavailable: ' + initResult.error);
                    return;
                }
            }

            const { data, error } = await SupabaseAuth.supabaseSignUp(supabaseEmail, password, username);
            if (error) {
                showAuthError('reg-error', 'Cloud registration failed: ' + error);
                return;
            }
            // A repeat sign-up for a registered email returns a placeholder
            // user with no session and no identities. Its id is not the real
            // account, so no local account may be built on it.
            var _signUpIds = data.user ? data.user.identities : null;
            if (!data.session && Array.isArray(_signUpIds) && _signUpIds.length === 0) {
                showAuthError('reg-error', 'An account with this email already exists. Sign in instead.');
                return;
            }
            supabaseUid = data.user ? data.user.id : null;
            if (!supabaseUid) {
                showAuthError('reg-error', 'Cloud registration did not return a user ID. Please try again.');
                return;
            }
        }

        // ── Create local account ─────────────────────────────────
        // NOTE: If the local save below fails after Supabase sign-up succeeded,
        // an orphan Supabase user will exist with no matching local record.
        // This is a known edge case — future account-linking work should
        // detect and reconcile orphaned Supabase users on next sign-up attempt.

        const recoveryKey = generateRecoveryKey();
        // Salted PBKDF2 hashes (DekCrypto.hashSecret), never plain SHA-256
        const [passwordHash, recoveryHash] = await Promise.all([
            DekCrypto.hashSecret(password),
            DekCrypto.hashSecret(recoveryKey)
        ]);

        // ── Generate DEK and wrap with password + recovery key (v2) ──
        const dek = DekCrypto.generateDek();
        const [pwWrapped, rkWrapped] = await Promise.all([
            DekCrypto.wrapDekV2(dek, password),
            DekCrypto.wrapDekV2(dek, recoveryKey)
        ]);

        const recordFields = {
            username,
            passwordHash,
            recoveryHash,
            wrappedDekByPassword: pwWrapped,
            wrappedDekByRecovery: rkWrapped,
            dekVersion: 1,
            createdAt: new Date().toISOString(),
            legalAcceptedVersion: LEGAL_BUNDLE_VERSION,
            legalAcceptedAt: new Date().toISOString(),
            legalAcceptedAppVersion: APP_VERSION
        };

        if (supabaseUid) {
            recordFields.supabaseUid = supabaseUid;
            recordFields.email = supabaseEmail;
            recordFields.storageMode = 'cloud_primary';
        } else {
            recordFields.storageMode = 'local_legacy';
        }

        const authRecord = await saveAuthRecord(recordFields);

        currentAccountId = authRecord.id;
        currentUsername = authRecord.username;
        await setActiveAccount(authRecord.id);

        sessionPassword = password;
        sessionDek = dek;
        journalData = { version: 1, trades: [], strategies: [], created: new Date().toISOString() };
        pendingRecoveryKey = null; // DEK accounts don't need recoveryData on the journal blob
        // Batch D2: a brand-new cloud account is empty in the cloud, so the
        // empty journal is its baseline and the first saves may write.
        window._denariiStorageMode = recordFields.storageMode;
        window._denariiSupabaseUid = supabaseUid;
        if (supabaseUid) { _cloudPending = {}; _cloudDeletes = {}; _rowRev = {}; _setCloudBaseline({}, true); _lastCloudResyncMs = Date.now(); }
        await saveToIndexedDB();

        // Stay signed in on this computer (the checkbox is shown only when available).
        // A failure here never blocks registration.
        const autoCb = document.getElementById('reg-autosignin');
        const autoGroup = document.getElementById('reg-autosignin-group');
        if (window.denariiAutoSignIn && autoCb && autoCb.checked && autoGroup && autoGroup.style.display !== 'none') {
            try {
                const autoRes = await window.denariiAutoSignIn.enable(authRecord.id, dek);
                if (!autoRes || !autoRes.ok) console.warn('[Denarii] Automatic sign-in not enabled:', autoRes && autoRes.error);
            } catch (e) {
                console.warn('[Denarii] Automatic sign-in not enabled:', e.message || e);
            }
        }

        document.getElementById('recovery-key-display').textContent = recoveryKey;
        showAuthView('recovery-key');
    } catch (err) {
        console.error('Registration failed:', err);
        showAuthError('reg-error', 'Registration failed: ' + (err.message || err));
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = 'Create Journal'; }
    }
}

function confirmRecoveryKeySaved() {
    if (!window.confirm('Have you saved your recovery key in a safe place? You will NOT see it again.')) return;
    pendingRecoveryKey = null;
    unlockApp();
}

// ── Manage Accounts ──────────────────────────────

function copyRecoveryKey() {
    const el = document.getElementById('recovery-key-display');
    const key = el ? el.textContent.trim() : '';
    if (!key) return;
    navigator.clipboard.writeText(key).then(function () {
        const btn = document.querySelector('#auth-recovery-key .btn-secondary');
        if (btn) {
            const original = btn.textContent;
            btn.textContent = 'Copied!';
            setTimeout(function () { btn.textContent = original; }, 2000);
        }
    }).catch(function () {
        window.showPromptModal({ message: 'Copy your recovery key:', defaultValue: key });
    });
}

async function showManageAccounts() {
    showAuthView('manage');
    const listEl = document.getElementById('accounts-list');
    listEl.innerHTML = '<p style="color:var(--text-secondary);font-size:13px;">Loading...</p>';

    try {
        await initDB();
        const accounts = await listAllAccounts();

        if (accounts.length === 0) {
            listEl.innerHTML = '<div class="accounts-empty">No accounts found on this computer.</div>';
            return;
        }

        // Sort by creation date, newest first
        accounts.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));

        let html = '';
        for (const acct of accounts) {
            const created = acct.createdAt ? new Date(acct.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : 'Unknown';
            const escapedId = acct.id.replace(/'/g, "\\'");
            const escapedUser = (acct.username || '').replace(/'/g, "\\'");
            html += '<div class="account-item" id="acct-row-' + acct.id + '">'
                + '<div class="account-item-info">'
                + '<div class="account-item-name">' + escapeHtml(acct.username) + '</div>'
                + '<div class="account-item-date">Created ' + created + '</div>'
                + '</div>'
                + '<button class="account-item-delete" onclick="handleDeleteAccount(\'' + escapedId + '\', \'' + escapedUser + '\')">Delete</button>'
                + '</div>';
        }
        listEl.innerHTML = html;
    } catch(e) {
        listEl.innerHTML = '<p style="color:var(--danger);font-size:13px;">Error loading accounts: ' + escapeHtml(e.message) + '</p>';
    }
}


async function handleDeleteAccount(accountId, username) {
    const confirmed = window.confirm('Delete the account "' + username + '"?\n\nThis will permanently remove this account and all its journal data from this computer. This cannot be undone.\n\nIf you need the data, back it up first in Settings → Data.');
    if (!confirmed) return;

    // Double confirm for safety
    const reallyConfirmed = window.confirm('Are you absolutely sure? Type OK to confirm.\n\nAccount: ' + username);
    if (!reallyConfirmed) return;

    try {
        await deleteAccount(accountId, username);

        // Remove the row from the UI
        const row = document.getElementById('acct-row-' + accountId);
        if (row) {
            row.style.transition = 'opacity 0.3s, transform 0.3s';
            row.style.opacity = '0';
            row.style.transform = 'translateX(20px)';
            setTimeout(() => {
                row.remove();
                // Check if list is now empty
                const listEl = document.getElementById('accounts-list');
                if (!listEl.querySelector('.account-item')) {
                    listEl.innerHTML = '<div class="accounts-empty">No accounts found on this computer.</div>';
                }
            }, 300);
        }
    } catch(e) {
        showAuthError('manage-error', 'Failed to delete account: ' + e.message);
    }
}

// Open existing journal (login)
async function openExistingJournal() {
    const username = document.getElementById('login-username').value.trim();
    const password = document.getElementById('login-password').value;

    // Clear prior status/error
    var _statusEl = document.getElementById('login-status');
    if (_statusEl) { _statusEl.textContent = ''; _statusEl.style.display = 'none'; }
    document.getElementById('login-error').style.display = 'none';

    if (!username) { showAuthError('login-error', 'Please enter your username.'); return; }
    if (!password) { showAuthError('login-error', 'Please enter your password.'); return; }

    await initDB();

    let auth = await getAuthRecordByUsername(username);

    // ── S3 Cloud restore: fresh browser / no local auth record ──
    // If local auth is missing and Supabase is configured, attempt to sign in
    // to Supabase with email+password, then restore auth_record and journal
    // from the cloud tables.
    var _cloudRestored = false;
    if (!auth && typeof SupabaseAuth !== 'undefined' && SupabaseAuth.isConfigured()) {
        var loginEmail = (document.getElementById('login-email') || {}).value;
        loginEmail = loginEmail ? loginEmail.trim() : '';

        if (!loginEmail) {
            // Show the email field inline so the user can restore without
            // navigating to the separate "New Device" flow.
            var _emailGroup = document.getElementById('login-email-group');
            if (_emailGroup) _emailGroup.style.display = '';
            showAuthError('login-error', 'No local journal found for "' + escapeHtml(username) + '". Enter your account email above and try again to restore from cloud.');
            return;
        }

        var statusEl = document.getElementById('login-status');
        try {
            if (statusEl) { statusEl.textContent = 'Signing in to cloud...'; statusEl.style.display = ''; }

            if (!SupabaseAuth.isReady()) SupabaseAuth.initSupabaseAuth();
            if (!SupabaseAuth.isReady()) {
                showAuthError('login-error', 'Cloud service unavailable. Try again later.');
                if (statusEl) statusEl.style.display = 'none';
                return;
            }

            var sbLogin = await SupabaseAuth.supabaseSignIn(loginEmail, password);
            if (sbLogin.error) {
                showAuthError('login-error', 'Cloud sign-in failed: ' + sbLogin.error);
                if (statusEl) statusEl.style.display = 'none';
                return;
            }

            // ── Fetch auth record from user_profiles ──
            if (statusEl) statusEl.textContent = 'Restoring your account for this browser...';
            var cloudRecord = await _fetchAuthProfileFromCloud();
            if (!cloudRecord || !cloudRecord.username) {
                showAuthError('login-error', 'Your account is not yet restorable from cloud. Please use "Recover from Backup" with a JSON export instead.');
                if (statusEl) statusEl.style.display = 'none';
                return;
            }

            var cloudNorm = normalizeUsername(cloudRecord.username);
            var targetNorm = normalizeUsername(username);
            if (cloudNorm !== targetNorm) {
                showAuthError('login-error', 'The cloud account username does not match. Check your username and email.');
                if (statusEl) statusEl.style.display = 'none';
                return;
            }

            // Save auth record locally
            await saveAuthRecord(cloudRecord);
            auth = await getAuthRecordByUsername(username);
            if (!auth) {
                showAuthError('login-error', 'Failed to save restored account locally. Please try again.');
                if (statusEl) statusEl.style.display = 'none';
                return;
            }

            // ── Load journal data from Supabase ──
            if (statusEl) statusEl.textContent = 'Loading your journal data...';

            // cloud_primary accounts: load directly from row-level Supabase tables
            if (cloudRecord.storageMode === 'cloud_primary') {
                console.log('[Denarii] Cloud-primary account — loading from Supabase row tables.');
                var _cpClient = SupabaseAuth.getClient();
                var _cpSession = await SupabaseAuth.supabaseGetSession();
                var _cpUserId = _cpSession.data && _cpSession.data.user ? _cpSession.data.user.id : null;

                if (_cpClient && _cpUserId) {
                    // Batch D2: strict load — a table that fails stops the
                    // restore instead of unlocking with partial data.
                    var _cpJournal, _cpRevs = {};
                    try {
                        _cpJournal = await _withTimeout(_loadJournalFromSupabaseRows(_cpClient, _cpUserId, { strict: true, revs: _cpRevs }), _CLOUD_LOAD_TIMEOUT_MS, 'Cloud load');
                    } catch (_cpErr) {
                        console.warn('[Denarii] Cloud-primary load failed:', _cpErr.message || _cpErr);
                        showAuthError('login-error', 'Could not load your cloud data. Check your connection and try again.');
                        if (statusEl) statusEl.style.display = 'none';
                        return;
                    }
                    if (!_cpJournal.version) _cpJournal.version = 2;
                    if (!_cpJournal.created) _cpJournal.created = new Date().toISOString();

                    // Set in-memory state directly — no encrypted blob needed
                    journalData = _cpJournal;
                    if (!journalData.brokerAccounts) journalData.brokerAccounts = [];

                    // Unwrap DEK for any future saves
                    sessionDek = null;
                    if (DekCrypto.hasPasswordWrap(cloudRecord)) {
                        sessionDek = (await DekCrypto.unwrapDekAny(cloudRecord.wrappedDekByPassword, cloudRecord.dekPasswordSalt, password)).dek;
                    }
                    sessionPassword = password;
                    currentAccountId = auth.id;
                    currentUsername = auth.username;
                    await setActiveAccount(auth.id);
                    try { localStorage.setItem('denarii_lastUsername', auth.username); } catch(_) {}
                    window._denariiStorageMode = 'cloud_primary';
                    window._denariiSupabaseUid = _cpUserId;
                    _cloudPending = {};
                    _cloudDeletes = {};
                    _rowRev = _cpRevs;
                    _setCloudBaseline(journalData, true);
                    _lastCloudResyncMs = Date.now();
                    _saveRevs();

                    // Cache to IndexedDB for offline use (non-blocking)
                    try {
                        var _cacheKey = sessionDek || sessionPassword;
                        if (_cacheKey) {
                            var _cacheEnc = encrypt(journalData, _cacheKey);
                            await saveJournalRecord(auth.id, { encrypted: true, data: _cacheEnc, lastSaved: new Date().toISOString() });
                            console.log('[Denarii] Cached cloud_primary journal to IndexedDB.');
                        }
                    } catch (_cacheErr) {
                        console.warn('[Denarii] IndexedDB cache write failed (non-fatal):', _cacheErr.message);
                    }

                    if (statusEl) statusEl.textContent = 'Loaded from cloud.';
                    console.log('[Denarii] Cloud-primary login complete for user:', username);

                    // Go directly to unlockApp — skip the normal loadFromIndexedDB path
                    if (auth.legalAcceptedVersion === LEGAL_BUNDLE_VERSION) {
                        unlockApp();
                    } else {
                        showLegalAcceptanceModal(auth, function () { unlockApp(); });
                    }
                    return; // ← exit openExistingJournal entirely
                } else {
                    console.warn('[Denarii] Cloud-primary load failed — no client/session. Falling back to encrypted blob.');
                }
            }

            // Non-cloud-primary or fallback: use encrypted journal_backups blob
            var cloudJournal = await _fetchJournalFromCloud();
            var _restoreKeptLocal = false;
            if (cloudJournal && cloudJournal.data) {
                var _localForFreshness = await getJournalRecord(auth.id);
                var _cloudTs = cloudJournal.lastSaved ? new Date(cloudJournal.lastSaved).getTime() : 0;
                var _localTs = (_localForFreshness && _localForFreshness.lastSaved) ? new Date(_localForFreshness.lastSaved).getTime() : 0;

                if (_localForFreshness && _localForFreshness.data && _localTs && _cloudTs && _localTs > _cloudTs) {
                    console.warn('[Denarii] Cloud backup (' + cloudJournal.lastSaved + ') is older than local journal (' + _localForFreshness.lastSaved + ') — keeping local data.');
                    if (statusEl) statusEl.textContent = 'Cloud backup is older than local data. Keeping local journal.';
                    _restoreKeptLocal = true;
                } else {
                    await saveJournalRecord(auth.id, {
                        encrypted: true,
                        data: cloudJournal.data,
                        lastSaved: cloudJournal.lastSaved || new Date().toISOString()
                    });
                    console.log('[Denarii] Journal data restored from cloud backup.');
                }
            } else {
                var _localExisting = await getJournalRecord(auth.id);
                if (_localExisting && _localExisting.data) {
                    console.warn('[Denarii] No cloud journal backup found, but local journal exists — keeping local data.');
                    if (statusEl) statusEl.textContent = 'Cloud journal not found. Keeping existing local data.';
                    _restoreKeptLocal = true;
                } else {
                    console.warn('[Denarii] No cloud journal backup found — creating empty journal.');
                    var emptyJournal = { version: 1, trades: [], strategies: [], created: new Date().toISOString() };
                    var restoreEncKey = null;
                    if (DekCrypto.hasPasswordWrap(cloudRecord)) {
                        restoreEncKey = (await DekCrypto.unwrapDekAny(cloudRecord.wrappedDekByPassword, cloudRecord.dekPasswordSalt, password)).dek;
                    }
                    if (!restoreEncKey) restoreEncKey = password;
                    var emptyEncrypted = encrypt(emptyJournal, restoreEncKey);
                    await saveJournalRecord(auth.id, {
                        encrypted: true,
                        data: emptyEncrypted,
                        lastSaved: new Date().toISOString()
                    });
                }
            }

            _cloudRestored = true;
            if (statusEl && !_restoreKeptLocal) { statusEl.textContent = 'Restore complete.'; }
            console.log('[Denarii] New-device cloud restore completed for user: ' + username);
        } catch (e) {
            console.warn('[Denarii] Cloud restore failed:', e.message || e);
            showAuthError('login-error', 'Cloud restore failed: ' + (e.message || e));
            if (statusEl) statusEl.style.display = 'none';
            return;
        }
    }

    if (!auth) {
        showAuthError('login-error', 'No journal found for that username on this computer.');
        return;
    }

    const pwCheck = await DekCrypto.verifySecret(password, auth.passwordHash);
    if (!pwCheck.ok) {
        showAuthError('login-error', 'Incorrect username or password.');
        return;
    }

    // ── Upgrade an old unsalted password hash (only after it matched) ──
    if (pwCheck.upgrade) {
        try {
            auth.passwordHash = pwCheck.upgrade;
            auth = await saveAuthRecord(auth);
            console.log('[Denarii] Password hash upgraded to PBKDF2 for user:', auth.username);
        } catch (e) {
            console.warn('[Denarii] Password hash upgrade failed (non-fatal):', e.message || e);
        }
    }

    // ── Backfill storageMode on existing accounts ──
    if (!auth.storageMode) {
        auth.storageMode = _resolveStorageMode(auth);
        await saveAuthRecord(auth);
        console.log('[Denarii] Backfilled storageMode:', auth.storageMode, 'for user:', auth.username);
    } else {
        console.log('[Denarii] Login storageMode:', auth.storageMode);
    }

    // ── Supabase cloud sign-in (when configured and account is linked) ──
    // Skip if we already signed in during cloud restore above
    // Batch D2: a failed sign-in pauses bulk cloud writes for this session.
    if (!_cloudRestored && typeof SupabaseAuth !== 'undefined' && SupabaseAuth.isConfigured() && auth.supabaseUid && auth.email) {
        try {
            if (!SupabaseAuth.isReady()) SupabaseAuth.initSupabaseAuth();
            if (SupabaseAuth.isReady()) {
                var sbResult = await SupabaseAuth.supabaseSignIn(auth.email, password);
                if (sbResult.error) {
                    _cloudSignInFailed = true;
                    console.warn('[Denarii] Supabase sign-in failed (continuing with local login):', sbResult.error);
                }
            } else {
                _cloudSignInFailed = true;
            }
        } catch (e) {
            _cloudSignInFailed = true;
            console.warn('[Denarii] Supabase sign-in error (continuing with local login):', e.message || e);
        }
    }

    // ── DEK unwrap (for DEK-backed accounts) ──
    sessionDek = null;
    var _rewrapFromV1 = null; // the v1 wrap that unwrapped; replaced with v2 once the journal loads
    if (DekCrypto.hasPasswordWrap(auth)) {
        var unwrapped = await DekCrypto.unwrapDekAny(auth.wrappedDekByPassword, auth.dekPasswordSalt, password);
        if (!unwrapped.dek) {
            showAuthError('login-error', 'Could not unlock encryption key. Try resetting your password with your recovery key.');
            return;
        }
        sessionDek = unwrapped.dek;
        if (unwrapped.upgraded) _rewrapFromV1 = auth.wrappedDekByPassword;
    }

    currentAccountId = auth.id;
    currentUsername = auth.username;
    await setActiveAccount(auth.id);
    sessionPassword = password;
    try { localStorage.setItem('denarii_lastUsername', auth.username); } catch(e) {}

    try {
        const loaded = await loadFromIndexedDB({ skipCloudBlob: _resolveStorageMode(auth) === 'cloud_primary' });
        if (!loaded) {
            // ── cloud_primary fallback: load from Supabase row tables ──
            if (auth.storageMode === 'cloud_primary' && auth.supabaseUid && typeof SupabaseAuth !== 'undefined' && SupabaseAuth.isReady()) {
                console.log('[Denarii] Local journal missing for cloud_primary account — loading from Supabase rows.');
                var _fbClient = SupabaseAuth.getClient();
                var _fbSession = await SupabaseAuth.supabaseGetSession();
                var _fbUserId = _fbSession.data && _fbSession.data.user ? _fbSession.data.user.id : null;
                if (_fbClient && _fbUserId && _fbUserId === auth.supabaseUid) {
                    var _fbJournal, _fbRevs = {};
                    try {
                        _fbJournal = await _withTimeout(_loadJournalFromSupabaseRows(_fbClient, _fbUserId, { strict: true, revs: _fbRevs }), _CLOUD_LOAD_TIMEOUT_MS, 'Cloud load');
                    } catch (_fbErr) {
                        console.warn('[Denarii] Cloud-primary load failed:', _fbErr.message || _fbErr);
                        showAuthError('login-error', 'Could not load your cloud data. Check your connection and try again.');
                        sessionPassword = null;
                        sessionDek = null;
                        return;
                    }
                    if (!_fbJournal.version) _fbJournal.version = 2;
                    if (!_fbJournal.created) _fbJournal.created = new Date().toISOString();
                    journalData = _fbJournal;
                    if (!journalData.brokerAccounts) journalData.brokerAccounts = [];
                    window._denariiStorageMode = 'cloud_primary';
                    window._denariiSupabaseUid = _fbUserId;
                    _cloudPending = {};
                    _cloudDeletes = {};
                    _rowRev = _fbRevs;
                    _setCloudBaseline(journalData, true);
                    _lastCloudResyncMs = Date.now();
                    _saveRevs();
                    // Cache to IndexedDB
                    try {
                        var _fbEncKey = sessionDek || sessionPassword;
                        if (_fbEncKey) {
                            var _fbEnc = encrypt(journalData, _fbEncKey);
                            await saveJournalRecord(currentAccountId, { encrypted: true, data: _fbEnc, lastSaved: new Date().toISOString() });
                            console.log('[Denarii] Cached cloud_primary journal to IndexedDB.');
                        }
                    } catch (_fbCacheErr) { console.warn('[Denarii] Cache write failed:', _fbCacheErr.message); }

                    if (auth.legalAcceptedVersion === LEGAL_BUNDLE_VERSION) {
                        unlockApp();
                    } else {
                        showLegalAcceptanceModal(auth, function () { unlockApp(); });
                    }
                    return; // loaded from cloud — done
                }
            }

            // ── Stranded cloud account: auth record exists but journal is missing ──
            if (auth.supabaseUid && auth.email && typeof SupabaseAuth !== 'undefined' && SupabaseAuth.isConfigured()) {
                _showCloudRestorePrompt(auth, password);
            } else {
                showAuthError('login-error', 'Could not decrypt journal data. Try importing from a JSON backup.');
            }
            sessionPassword = null;
            sessionDek = null;
            return;
        }
        // The v1 wrap unwrapped and the journal decrypted with that DEK: now
        // it is safe to replace the wrap with v2 (failure is non-fatal).
        if (_rewrapFromV1) await _rewrapPasswordDekV2(auth.id, _rewrapFromV1, sessionDek, password);
        // Batch D2: cloud_primary — the cloud replaces this browser's copy.
        // On failure the local copy is kept and bulk writes are paused.
        var _lsEl = document.getElementById('login-status');
        if (_lsEl && auth.storageMode === 'cloud_primary') { _lsEl.textContent = 'Loading your cloud data...'; _lsEl.style.display = ''; }
        try { await _cloudFirstReload(auth); }
        catch (_cfErr) { _enterCloudPaused(_cfErr.message || String(_cfErr)); }
        // Legal acceptance gate — check before allowing app entry
        if (auth.legalAcceptedVersion === LEGAL_BUNDLE_VERSION) {
            unlockApp();
        } else {
            showLegalAcceptanceModal(auth, function () { unlockApp(); });
        }
    } catch (err) {
        console.error('[Denarii] Sign-in failed:', err);
        showAuthError('login-error', 'Decryption failed. ' + err.message);
        sessionPassword = null;
        sessionDek = null;
    }
}

// Catches anything openExistingJournal throws outside its own try (the
// Unlock button and Enter key call it without awaiting), so a failure is
// logged and shown instead of leaving the sign-in screen silent.
function _reportLoginError(err) {
    console.error('[Denarii] Sign-in failed:', err);
    sessionPassword = null;
    sessionDek = null;
    showAuthError('login-error', 'Sign-in failed: ' + ((err && err.message) || err));
}

// Replaces a v1 password wrap with v2 after a sign-in proved it (the v1
// unwrap and the journal load both succeeded). The record is re-read and
// left alone unless it still holds that same v1 wrap; the new wrap must
// unwrap to the same DEK before it is saved. Never throws.
async function _rewrapPasswordDekV2(accountId, oldWrap, dek, password) {
    try {
        var fresh = await getAuthRecordById(accountId);
        if (!fresh || fresh.wrappedDekByPassword !== oldWrap) return;
        var v2 = await DekCrypto.wrapDekV2(dek, password);
        var check = await DekCrypto.unwrapDekAny(v2, null, password);
        if (check.dek !== dek) throw new Error('new wrap did not verify');
        fresh.wrappedDekByPassword = v2;
        delete fresh.dekPasswordSalt;
        await saveAuthRecord(fresh);
        console.log('[Denarii] DEK password wrap upgraded to v2 for user:', fresh.username);
    } catch (e) {
        console.warn('[Denarii] DEK wrap upgrade failed (non-fatal):', e.message || e);
    }
}

// ── Stranded cloud-account restore prompt ──────────────────────
// Shown when the local auth record exists (with supabaseUid) and password
// is correct, but the journal blob is missing from IndexedDB.
function _showCloudRestorePrompt(auth, password) {
    var errorEl = document.getElementById('login-error');
    if (!errorEl) return;
    errorEl.style.display = 'block';
    errorEl.className = 'auth-error';
    errorEl.innerHTML =
        '<span>Your account was found but the local journal is missing.</span><br>' +
        '<a href="#" id="login-cloud-restore-link" style="color:var(--primary);font-weight:600;">Restore from Cloud</a>' +
        '<span style="color:var(--text-secondary);font-size:12px;"> — or use "Recover from Backup" with a JSON export.</span>';
    document.getElementById('login-cloud-restore-link').addEventListener('click', function (e) {
        e.preventDefault();
        _executeCloudRestore(auth, password);
    });
}

async function _executeCloudRestore(auth, password) {
    var errorEl = document.getElementById('login-error');
    var statusEl = document.getElementById('login-status');
    if (errorEl) errorEl.style.display = 'none';

    try {
        if (statusEl) { statusEl.textContent = 'Signing in to cloud...'; statusEl.style.display = ''; }

        if (!SupabaseAuth.isReady()) SupabaseAuth.initSupabaseAuth();
        if (!SupabaseAuth.isReady()) {
            showAuthError('login-error', 'Cloud service unavailable. Try again later.');
            if (statusEl) statusEl.style.display = 'none';
            return;
        }

        var sbLogin = await SupabaseAuth.supabaseSignIn(auth.email, password);
        if (sbLogin.error) {
            showAuthError('login-error', 'Cloud sign-in failed: ' + sbLogin.error);
            if (statusEl) statusEl.style.display = 'none';
            return;
        }

        if (statusEl) statusEl.textContent = 'Restoring your journal data...';
        var cloudJournal = await _fetchJournalFromCloud();
        if (!cloudJournal || !cloudJournal.data) {
            showAuthError('login-error', 'No cloud journal backup found. Use "Recover from Backup" with a JSON export instead.');
            if (statusEl) statusEl.style.display = 'none';
            return;
        }

        await saveJournalRecord(auth.id, {
            encrypted: true,
            data: cloudJournal.data,
            lastSaved: cloudJournal.lastSaved || new Date().toISOString()
        });
        console.log('[Denarii] Stranded-account cloud restore completed for user:', auth.username);

        if (statusEl) statusEl.textContent = 'Restore complete. Unlocking...';

        // Re-establish session state and unlock
        sessionPassword = password;
        sessionDek = null;
        if (DekCrypto.hasPasswordWrap(auth)) {
            sessionDek = (await DekCrypto.unwrapDekAny(auth.wrappedDekByPassword, auth.dekPasswordSalt, password)).dek;
        }
        currentAccountId = auth.id;
        currentUsername = auth.username;
        await setActiveAccount(auth.id);

        var loaded = await loadFromIndexedDB();
        if (!loaded) {
            showAuthError('login-error', 'Restored from cloud but could not decrypt. Try resetting your password with your recovery key.');
            sessionPassword = null;
            sessionDek = null;
            if (statusEl) statusEl.style.display = 'none';
            return;
        }
        try { await _cloudFirstReload(auth); }
        catch (_cfErr) { _enterCloudPaused(_cfErr.message || String(_cfErr)); }

        if (auth.legalAcceptedVersion === LEGAL_BUNDLE_VERSION) {
            unlockApp();
        } else {
            showLegalAcceptanceModal(auth, function () { unlockApp(); });
        }
    } catch (e) {
        console.warn('[Denarii] Stranded-account cloud restore failed:', e.message || e);
        showAuthError('login-error', 'Cloud restore failed: ' + (e.message || e));
        if (statusEl) statusEl.style.display = 'none';
    }
}

// Password reset via recovery key
async function resetPassword() {
    const username    = document.getElementById('forgot-username').value.trim();
    const recoveryKey = document.getElementById('forgot-recovery-key').value.trim().toUpperCase();
    const newPw       = document.getElementById('forgot-new-pw').value;
    const confirmPw   = document.getElementById('forgot-confirm-pw').value;

    if (!username) { showAuthError('forgot-error', 'Please enter your username.'); return; }
    if (!recoveryKey) { showAuthError('forgot-error', 'Please enter your recovery key.'); return; }
    if (newPw.length < 8) { showAuthError('forgot-error', 'New password must be at least 8 characters.'); return; }
    if (newPw !== confirmPw) { showAuthError('forgot-error', 'Passwords do not match.'); return; }

    await initDB();
    const auth = await getAuthRecordByUsername(username);
    if (!auth) {
        showAuthError('forgot-error', 'No journal found for that username on this computer.');
        return;
    }

    const rkCheck = await DekCrypto.verifySecret(recoveryKey, auth.recoveryHash);
    if (!rkCheck.ok) {
        showAuthError('forgot-error', 'Invalid recovery key.');
        return;
    }
    // An old unsalted recovery hash that matched is replaced; it is saved
    // together with the new password below (nothing is saved if the reset stops).
    if (rkCheck.upgrade) auth.recoveryHash = rkCheck.upgrade;

    try {
        if (auth.dekVersion === 1) {
            // ── DEK account: unwrap DEK with recovery key, re-wrap with new password ──
            if (!DekCrypto.hasRecoveryWrap(auth)) {
                // Recovery wrapping was never set — check for legacy recoveryData fallback
                const result = await getJournalRecord(auth.id);
                if (result && result.recoveryData) {
                    var legacyData = decrypt(result.recoveryData, recoveryKey);
                    if (legacyData) {
                        // ── Staleness guard (DEK fallback path) ──
                        var _fbRecoveryTs = result.recoveryDataSavedAt ? new Date(result.recoveryDataSavedAt).getTime() : 0;
                        var _fbJournalTs = result.lastSaved ? new Date(result.lastSaved).getTime() : 0;
                        var _fbTradeCount = Array.isArray(legacyData.trades) ? legacyData.trades.length : 0;
                        var _fbStale = false;
                        if (_fbJournalTs && _fbRecoveryTs && _fbJournalTs > _fbRecoveryTs) {
                            var _fbDays = Math.round((_fbJournalTs - _fbRecoveryTs) / 86400000);
                            _fbStale = !confirm('Warning: Your recovery snapshot is ' + (_fbDays > 0 ? _fbDays + ' day' + (_fbDays !== 1 ? 's' : '') + ' older' : 'older')
                                + ' than your current journal (' + _fbTradeCount + ' trade' + (_fbTradeCount !== 1 ? 's' : '') + ' in snapshot).'
                                + '\n\nContinue with password reset?');
                        } else if (!_fbRecoveryTs && _fbJournalTs) {
                            _fbStale = !confirm('Warning: Your recovery snapshot predates freshness tracking (' + _fbTradeCount + ' trade' + (_fbTradeCount !== 1 ? 's' : '') + ').'
                                + '\n\nIt may be older than your current journal. Continue?');
                        }
                        if (_fbStale) {
                            showAuthError('forgot-error', 'Password reset cancelled. Your current journal data is unchanged.');
                            return;
                        }

                        // Fallback: decrypt legacy recoveryData, re-encrypt with a fresh DEK
                        var fallbackDek = DekCrypto.generateDek();

                        auth.passwordHash = await DekCrypto.hashSecret(newPw);
                        auth.wrappedDekByPassword = await DekCrypto.wrapDekV2(fallbackDek, newPw);
                        auth.wrappedDekByRecovery = await DekCrypto.wrapDekV2(fallbackDek, recoveryKey);
                        delete auth.dekPasswordSalt;
                        delete auth.dekRecoverySalt;
                        await saveAuthRecord(auth);
                        await _disableAutoSignIn(auth.id); // new DEK; the user turns it back on after signing in

                        currentAccountId = auth.id;
                        currentUsername = auth.username;
                        await setActiveAccount(auth.id);
                        journalData = legacyData;
                        sessionPassword = newPw;
                        sessionDek = fallbackDek;
                        pendingRecoveryKey = null;
                        await saveToIndexedDB();

                        alert('Password reset successful. You can now sign in with your new password.');
                        showAuthView('login');
                        document.getElementById('login-username').value = auth.username || '';
                        sessionPassword = null;
                        sessionDek = null;
                        return;
                    }
                }
                showAuthError('forgot-error', 'Recovery key access was not configured for this account. Please contact support or try importing from a backup.');
                return;
            }

            var dek = (await DekCrypto.unwrapDekAny(auth.wrappedDekByRecovery, auth.dekRecoverySalt, recoveryKey)).dek;
            if (!dek) {
                showAuthError('forgot-error', 'Could not unlock encryption key with that recovery key.');
                return;
            }

            // Re-wrap DEK with new password, and refresh the recovery wrap
            // (recovery key is available); both as v2
            auth.passwordHash = await DekCrypto.hashSecret(newPw);
            auth.wrappedDekByPassword = await DekCrypto.wrapDekV2(dek, newPw);
            auth.wrappedDekByRecovery = await DekCrypto.wrapDekV2(dek, recoveryKey);
            delete auth.dekPasswordSalt;
            delete auth.dekRecoverySalt;
            await saveAuthRecord(auth);
            await _disableAutoSignIn(auth.id); // after a reset, the next launch asks for the password

            // No journal re-encryption needed — DEK hasn't changed
            alert('Password reset successful. You can now sign in with your new password.');
            showAuthView('login');
            document.getElementById('login-username').value = auth.username || '';
        } else {
            // ── Legacy account: decrypt recoveryData, re-encrypt with new password ──
            const result = await getJournalRecord(auth.id);
            if (!result) {
                showAuthError('forgot-error', 'No journal data found.');
                return;
            }

            let data = null;
            if (result.recoveryData) {
                data = decrypt(result.recoveryData, recoveryKey);
            }
            if (!data) {
                showAuthError('forgot-error', 'Could not unlock journal with that recovery key.');
                return;
            }

            // ── Staleness guard: warn if recoveryData is older than the current journal ──
            var _recoveryTs = result.recoveryDataSavedAt ? new Date(result.recoveryDataSavedAt).getTime() : 0;
            var _journalTs = result.lastSaved ? new Date(result.lastSaved).getTime() : 0;
            var _recoveryTradeCount = Array.isArray(data.trades) ? data.trades.length : 0;

            if (_journalTs && _recoveryTs && _journalTs > _recoveryTs) {
                // Recovery snapshot is demonstrably older than the current journal
                var _ageDays = Math.round((_journalTs - _recoveryTs) / 86400000);
                var _staleMsg = 'Warning: Your recovery snapshot is ' + (_ageDays > 0 ? _ageDays + ' day' + (_ageDays !== 1 ? 's' : '') + ' older' : 'older')
                    + ' than your current journal data'
                    + ' (' + _recoveryTradeCount + ' trade' + (_recoveryTradeCount !== 1 ? 's' : '') + ' in recovery snapshot).'
                    + '\n\nResetting with this snapshot will roll your journal back to that older state.'
                    + '\n\nContinue with password reset?';
                if (!confirm(_staleMsg)) {
                    showAuthError('forgot-error', 'Password reset cancelled. Your current journal data is unchanged. Consider importing from a recent backup instead.');
                    return;
                }
            } else if (!_recoveryTs && _journalTs) {
                // No freshness timestamp on recoveryData — it predates tracking.
                // Warn that this may be a very old snapshot.
                var _unknownMsg = 'Warning: Your recovery snapshot was created before freshness tracking was added. '
                    + 'It contains ' + _recoveryTradeCount + ' trade' + (_recoveryTradeCount !== 1 ? 's' : '') + '.'
                    + '\n\nThis may be significantly older than your current journal.'
                    + '\n\nContinue with password reset?';
                if (!confirm(_unknownMsg)) {
                    showAuthError('forgot-error', 'Password reset cancelled. Your current journal data is unchanged.');
                    return;
                }
            }

            currentAccountId = auth.id;
            currentUsername = auth.username;
            await setActiveAccount(auth.id);
            journalData = data;
            sessionPassword = newPw;
            pendingRecoveryKey = recoveryKey;
            await saveToIndexedDB();

            auth.passwordHash = await DekCrypto.hashSecret(newPw);
            await saveAuthRecord(auth);
            await _disableAutoSignIn(auth.id); // legacy accounts never hold it; cleared for safety

            alert('Password reset successful. You can now sign in with your new password.');
            showAuthView('login');
            document.getElementById('login-username').value = auth.username || '';
            sessionPassword = null;
            pendingRecoveryKey = null;
        }
    } catch (err) {
        console.error(err);
        showAuthError('forgot-error', 'Password reset failed.');
    }
}
// ── Legal preview (read-only popup window, works before login) ───
function _showInlineLegalFallback() {
    var wrapper = document.getElementById('reg-legal-inline');
    var container = document.getElementById('reg-legal-inline-content');
    if (!wrapper || !container) return;
    if (!container.innerHTML) {
        container.innerHTML = LEGAL_BUNDLE.documents.map(function (doc, i) {
            return (i > 0 ? '<hr style="border:none;border-top:1px solid var(--border);margin:20px 0;">' : '')
                + '<div>' + doc.html + '</div>';
        }).join('');
    }
    wrapper.style.display = '';
}

function previewLegalDocuments() {
    try {
        var body = LEGAL_BUNDLE.documents.map(function (doc, i) {
            return (i > 0 ? '<hr style="border:none;border-top:1px solid #30363d;margin:40px 0;">' : '')
                + '<div style="margin-bottom:24px;">' + doc.html + '</div>';
        }).join('');

        var html = '<!DOCTYPE html><html><head><meta charset="utf-8">'
            + '<title>Denarii — Legal Documents</title>'
            + '<style>'
            + 'body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;'
            + 'max-width:720px;margin:0 auto;padding:32px 24px 64px;line-height:1.7;color:#d1d5db;background:#0d1117;}'
            + 'h3{color:#fff;margin:32px 0 8px;font-size:18px;}'
            + 'h4{color:#e5e7eb;margin:20px 0 6px;font-size:14px;}'
            + 'p,li{font-size:13px;margin:6px 0;}'
            + 'ul{padding-left:24px;}'
            + 'strong{color:#f3f4f6;}'
            + '</style></head><body>' + body + '</body></html>';

        var win = window.open('', '_blank', 'width=800,height=720,scrollbars=yes,resizable=yes');
        if (win) {
            win.document.write(html);
            win.document.close();
            win.focus();
        } else {
            _showInlineLegalFallback();
        }
    } catch (err) {
        console.error('previewLegalDocuments error:', err);
        _showInlineLegalFallback();
    }
}

// ── Legal acceptance modal ────────────────────────────────────────
// Shows the legal acceptance modal for existing users who lack a matching
// legalAcceptedVersion. `onAccepted` callback is invoked only after the
// auth record is saved successfully.

function showLegalAcceptanceModal(authRecord, onAccepted) {
    try {
        const modal = document.getElementById('legal-acceptance-modal');
        if (!modal) throw new Error('Legal acceptance modal not found');

        // Populate document text from shared LEGAL_BUNDLE (skip any entry without text)
        const docs = (LEGAL_BUNDLE.documents || []).filter(function (doc) { return doc && doc.html; });
        if (!docs.length) throw new Error('No legal documents to show');
        const container = document.getElementById('legal-modal-documents');
        if (container) {
            container.innerHTML = docs.map(function (doc) {
                return '<div class="legal-doc-block" style="margin-bottom:24px;">' + doc.html + '</div>';
            }).join('<hr style="border:none;border-top:1px solid var(--border);margin:20px 0;">');
        }

        // Reset checkbox + error
        const cb = document.getElementById('legal-modal-accept');
        if (cb) cb.checked = false;
        const errEl = document.getElementById('legal-modal-error');
        if (errEl) { errEl.textContent = ''; errEl.style.display = 'none'; }
        const btn = document.getElementById('legal-modal-confirm-btn');
        if (btn) { btn.disabled = false; btn.textContent = 'Accept & Continue'; }

        // Wire confirm button
        modal._legalOnAccepted = onAccepted;
        modal._legalAuthRecord = authRecord;
        modal.classList.add('active');
    } catch (err) {
        // Sign-in cannot go on without acceptance: log it, show it on the
        // sign-in screen and drop the session keys.
        console.error('[Denarii] Legal acceptance could not be shown:', err);
        sessionPassword = null;
        sessionDek = null;
        showAuthError('login-error', 'Could not show the legal terms: ' + ((err && err.message) || err));
    }
}

// Decline: nothing is saved. Drop the session keys and reload to the
// sign-in screen, as Lock does.
function declineLegalAcceptance() {
    const modal = document.getElementById('legal-acceptance-modal');
    if (modal) {
        modal.classList.remove('active');
        modal._legalOnAccepted = null;
        modal._legalAuthRecord = null;
    }
    sessionPassword = null;
    sessionDek = null;
    location.reload();
}

async function handleLegalAcceptance() {
    const modal = document.getElementById('legal-acceptance-modal');
    const cb = document.getElementById('legal-modal-accept');
    const errEl = document.getElementById('legal-modal-error');
    const btn = document.getElementById('legal-modal-confirm-btn');

    if (!cb || !cb.checked) {
        if (errEl) { errEl.textContent = 'You must accept the legal terms to continue.'; errEl.style.display = 'block'; }
        return;
    }

    if (btn) { btn.disabled = true; btn.textContent = 'Saving...'; }

    try {
        const auth = modal._legalAuthRecord;
        auth.legalAcceptedVersion = LEGAL_BUNDLE_VERSION;
        auth.legalAcceptedAt = new Date().toISOString();
        auth.legalAcceptedAppVersion = APP_VERSION;
        await saveAuthRecord(auth);

        modal.classList.remove('active');
        if (typeof modal._legalOnAccepted === 'function') modal._legalOnAccepted();
    } catch (err) {
        console.error('Legal acceptance save failed:', err);
        if (errEl) { errEl.textContent = 'Failed to save acceptance. Please try again. (' + (err.message || err) + ')'; errEl.style.display = 'block'; }
        if (btn) { btn.disabled = false; btn.textContent = 'Accept & Continue'; }
    }
}

// ── Legal documents viewer (Help page) ──────────────────────────
function renderLegalHelpContent() {
    var el = document.getElementById('help-legal-content');
    if (!el || el.dataset.rendered) return;
    el.innerHTML = LEGAL_BUNDLE.documents.map(function (doc) {
        return '<div style="margin-bottom:24px;">' + doc.html + '</div>';
    }).join('<hr style="border:none;border-top:1px solid var(--border);margin:20px 0;">');
    el.dataset.rendered = '1';
}

// Lock journal
var _lockPending = false;
function lockJournal() {
    // Clear in-memory AI key cache before locking (does not touch persisted storage)
    if (typeof DenAriiAI !== 'undefined') DenAriiAI.unloadApiKey();
    if (typeof TwelveDataKey !== 'undefined') TwelveDataKey.unloadApiKey();
    // Check if backup is needed
    if (!lastBackupTime || (new Date() - new Date(lastBackupTime)) > 24 * 60 * 60 * 1000) {
        _lockPending = true;
        document.getElementById('export-modal').classList.add('active');
    } else {
        _completeLock();
    }
}

function _completeLock() {
    _lockPending = false;
    // Stop applying Webull batches before the keys go; main detaches on the reload.
    if (typeof WebullSync !== 'undefined' && WebullSync.stopBatchHandler) WebullSync.stopBatchHandler();
    sessionPassword = null;
    sessionDek = null;
    // Clear all localStorage drafts so stale New Trade / Edit Trade
    // state cannot survive into a different account context.
    if (typeof window._clearAllDrafts === 'function') window._clearAllDrafts();
    if (typeof window._clearBrokerCardCache === 'function') window._clearBrokerCardCache();
    // Batch D2: end this browser's Supabase session so the next account to
    // sign in here never writes with it. scope 'local' keeps the user's other
    // browsers signed in. Capped at 2 s so locking never hangs.
    var reload = function () { location.reload(); };
    try {
        var client = (typeof SupabaseAuth !== 'undefined' && SupabaseAuth.isReady()) ? SupabaseAuth.getClient() : null;
        if (client && client.auth) {
            Promise.race([
                client.auth.signOut({ scope: 'local' }),
                new Promise(function (r) { setTimeout(r, 2000); })
            ]).then(reload, reload);
            return;
        }
    } catch (e) {
        console.warn('[Denarii] Cloud sign-out on lock failed:', e.message || e);
    }
    reload();
}

// ── Phase 2: Row-level shadow-write to Supabase ──────────────────
// Fire-and-forget: writes changed domains to per-table Supabase rows
// after a successful IndexedDB save. Never blocks the UI or causes
// saveToIndexedDB() to fail.

// Domain config: maps journalData keys to Supabase table names and
// the onConflict key used for upsert.
var _SHADOW_DOMAINS = {
    strategies:     { table: 'strategies',      onConflict: 'user_id,id' },
    brokerAccounts: { table: 'broker_accounts', onConflict: 'user_id,id' },
    trades:         { table: 'trades',          onConflict: 'user_id,id' },
    tags:           { table: 'tags',            onConflict: 'user_id,id' },
    noteTemplates:  { table: 'note_templates',  onConflict: 'user_id,id' },
    reviews:        { table: 'reviews',         onConflict: 'user_id,review_type,review_key' },
    dailyPlanners:  { table: 'daily_planners',  onConflict: 'user_id,planner_key' },
    weeklyPlanners: { table: 'weekly_planners', onConflict: 'user_id,planner_key' },
    aiOutputHistory:{ table: 'ai_reports',      onConflict: 'user_id,id' },
    aiPrompts:      { table: 'ai_prompts',      onConflict: 'user_id,id' }
};

// Map local journalData item fields to Supabase row columns.
// Only approved Phase 1 fields are included.
function _mapArrayRow(userId, domainKey, item) {
    var row = { user_id: userId };
    switch (domainKey) {
        case 'strategies':
            row.id          = item.id;
            row.name        = item.name || '';
            row.description = item.description || '';
            row.color       = item.color || '';
            row.groups      = item.groups || [];
            row.is_favorite = item.isFavorite !== false;
            row.created_at  = item.created || null;
            row.updated_at  = item.updated || null;
            row.created_by  = item.createdBy || null;
            break;
        case 'brokerAccounts':
            row.id                   = item.id;
            row.broker               = item.broker || '';
            row.account_number       = item.accountNumber || '';
            row.display_name         = item.displayName || '';
            row.trading_style        = item.tradingStyle || '';
            row.color                = item.color || '';
            row.is_default           = !!item.isDefault;
            row.visible              = item.visible !== false;
            row.opening_balance      = item.openingBalance ?? null;
            row.opening_balance_date = item.openingBalanceDate || null;
            row.cash_adjustments     = item.cashAdjustments || [];
            row.recurring_fees       = item.recurringFees || [];
            row.is_demo              = !!item.isDemo;
            row.created_at           = item.createdAt || null;
            break;
        case 'trades':
            row.id                  = item.id;
            row.symbol              = item.symbol || '';
            row.direction           = item.direction || item.type || '';
            row.entry_date          = item.entryDate || null;
            row.exit_date           = item.exitDate || null;
            row.entry_price         = item.entryPrice ?? null;
            row.exit_price          = item.exitPrice ?? null;
            row.quantity            = item.quantity ?? null;
            row.pnl                 = item.pnl ?? null;
            row.fees                = item.fees ?? null;
            row.strategy            = item.strategy || '';
            row.notes               = item.notes || '';
            row.tags                = item.tags || [];
            row.broker_account_id   = item.brokerAccountId || null;
            row.created_at          = item.createdAt || null;
            row.updated_at          = item.updatedAt || null;
            // Extended fields
            row.entry_time          = item.entryTime || null;
            row.exit_time           = item.exitTime || null;
            row.hold_seconds        = item.holdSeconds ?? null;
            row.asset_type          = item.assetType || null;
            row.option_type         = item.optionType || null;
            row.option_action       = item.optionAction || null;
            row.strike              = item.strike ?? null;
            row.expiry              = item.expiry || null;
            row.setup_type          = item.setupType || null;
            row.strategy_score      = item.strategyScore || null;
            row.emotion             = item.emotion || null;
            row.trade_grade         = item.tradeGrade || null;
            row.entry_reason        = item.entryReason || null;
            row.exit_reason         = item.exitReason || null;
            row.lessons             = item.lessons || null;
            row.quick_notes         = item.quickNotes || null;
            row.profit_targets      = item.profitTargets || null;
            row.stop_losses         = item.stopLosses || null;
            row.commission_fees     = item.commissionFees ?? null;
            row.trade_risk          = item.tradeRisk ?? null;
            row.initial_target      = item.initialTarget ?? null;
            row.planned_r_multiple  = item.plannedRMultiple ?? null;
            row.realized_r_multiple = item.realizedRMultiple ?? null;
            row.drawdown            = item.drawdown ?? null;
            row.runup               = item.runup ?? null;
            row.source              = item.source || null;
            // Webull import (Phase 8). Always NULL for manual / CSV / demo trades.
            var _isWebull = item.source === 'webull';
            row.external_id         = _isWebull ? (item.externalId || null) : null;
            row.external_order_ids  = _isWebull ? (item.externalOrderIds || null) : null;
            row.webull_partials     = _isWebull ? (item.webullPartials || null) : null;
            // Batch D1: fields that used to live only in the browser. A field
            // that is undefined locally is left out of the row so an upsert
            // keeps the cloud value (see _groupRowsByKeySet); null is written
            // only when the local value is set to null / empty on purpose.
            if (item.fills !== undefined) {
                row.fills = (Array.isArray(item.fills) && item.fills.length)
                    ? item.fills.map(function (f) {
                        var o = {};
                        for (var k in f) if (Object.prototype.hasOwnProperty.call(f, k) && k.charAt(0) !== '_') o[k] = f[k];
                        return o;
                    })
                    : null;
            }
            if (item.grossPnl !== undefined)            row.gross_pnl             = item.grossPnl ?? null;
            if (item.feeSource !== undefined)           row.fee_source            = item.feeSource || null;
            if (item.contractName !== undefined)        row.contract_name         = item.contractName || null;
            if (item.sourceFile !== undefined)          row.source_file           = item.sourceFile || null;
            if (item.tosRefNum !== undefined)           row.tos_ref_num           = (item.tosRefNum == null || item.tosRefNum === '') ? null : String(item.tosRefNum);
            if (item.notesUpdatedAt !== undefined) {
                var _nu = typeof item.notesUpdatedAt === 'string' && !/^\d+$/.test(item.notesUpdatedAt)
                    ? Date.parse(item.notesUpdatedAt) : Number(item.notesUpdatedAt);
                row.notes_updated_at = (item.notesUpdatedAt == null || item.notesUpdatedAt === '' || !isFinite(_nu)) ? null : Math.round(_nu);
            }
            if (item.sessionHeaderDate !== undefined)   row.session_header_date   = typeof item.sessionHeaderDate === 'string' ? item.sessionHeaderDate : null;
            if (item.entryCommissionFees !== undefined) row.entry_commission_fees = item.entryCommissionFees ?? null;
            if (item.exitCommissionFees !== undefined)  row.exit_commission_fees  = item.exitCommissionFees ?? null;
            break;
        case 'tags':
            row.id          = item.id;
            row.name        = item.name || '';
            row.category    = item.category || '';
            row.description = item.description || '';
            row.is_favorite = item.isFavorite !== false;
            row.is_starter  = !!item.isStarter;
            row.created_at  = item.createdAt || null;
            break;
        case 'noteTemplates':
            row.id          = item.id;
            row.name        = item.name || '';
            row.body        = item.content || item.body || '';
            row.source_type = item.sourceType || 'user';
            row.is_favorite = !!item.isFavorite;
            row.timeframes  = item.timeframes || [];
            row.created_at  = item.createdAt || null;
            row.updated_at  = item.updatedAt || null;
            break;
        case 'aiOutputHistory':
            row.id              = item.id;
            row.created_at      = item.createdAt || null;
            row.prompt_title    = item.promptTitle || null;
            row.prompt_text     = item.promptText || null;
            row.raw_text        = item.rawText || null;
            row.provider        = item.provider || null;
            row.model           = item.model || null;
            row.duration_ms     = item.durationMs ?? null;
            row.filters         = item.filters || null;
            row.structured_data = item.structuredData || null;
            row.fingerprint     = item.fingerprint || null;
            break;
        case 'aiPrompts':
            // Skip global/system Denarii prompts — only store user-created prompts
            if (item.createdBy === 'Denarii') return null;
            row.id            = item.id;
            row.title         = item.title || '';
            row.description   = item.description || '';
            row.prompt_text   = item.promptText || '';
            row.category      = item.category || 'All';
            row.strategy_tags = item.strategyTags || [];
            row.style         = item.style || 'All';
            row.favorite      = !!item.favorite;
            row.created_by    = item.createdBy || '';
            row.created_at    = item.createdAt || null;
            row.updated_at    = item.updatedAt || null;
            break;
        default:
            return null;
    }
    // Batch D3: record fields with no column go to `extra`; left out when
    // there are none, so an upsert keeps the cloud value.
    if (domainKey !== 'trades') {
        var _extra = _extraFields(domainKey, item);
        if (_extra) row.extra = _extra;
    }
    return row;
}

// Local fields each non-trade domain maps to its own columns. Every other
// field (except '_' ones) is stored in `extra`, keys sorted so the cloud's
// JSONB key order never shows up as a change.
var _MAPPED_FIELDS = {
    strategies:      ['id', 'name', 'description', 'color', 'groups', 'isFavorite', 'created', 'updated', 'createdBy'],
    brokerAccounts:  ['id', 'broker', 'accountNumber', 'displayName', 'tradingStyle', 'color', 'isDefault', 'visible',
                      'openingBalance', 'openingBalanceDate', 'cashAdjustments', 'recurringFees', 'isDemo', 'createdAt'],
    tags:            ['id', 'name', 'category', 'description', 'isFavorite', 'isStarter', 'createdAt'],
    noteTemplates:   ['id', 'name', 'content', 'body', 'sourceType', 'isFavorite', 'timeframes', 'createdAt', 'updatedAt'],
    aiOutputHistory: ['id', 'createdAt', 'promptTitle', 'promptText', 'rawText', 'provider', 'model', 'durationMs',
                      'filters', 'structuredData', 'fingerprint'],
    aiPrompts:       ['id', 'title', 'description', 'promptText', 'category', 'strategyTags', 'style', 'favorite',
                      'createdBy', 'createdAt', 'updatedAt']
};

function _extraFields(domainKey, item) {
    var mapped = _MAPPED_FIELDS[domainKey];
    if (!mapped || !item || typeof item !== 'object') return null;
    var keys = Object.keys(item).filter(function (k) {
        return k.charAt(0) !== '_' && mapped.indexOf(k) === -1 && item[k] !== undefined && typeof item[k] !== 'function';
    }).sort();
    if (!keys.length) return null;
    var out = {};
    keys.forEach(function (k) { out[k] = item[k]; });
    return out;
}

// Map reviews object entries to Supabase rows.
// Reviews are keyed as "type|key" in journalData.reviews.
function _mapReviewRows(userId, reviewsObj) {
    var rows = [];
    if (!reviewsObj || typeof reviewsObj !== 'object') return rows;
    var keys = Object.keys(reviewsObj);
    for (var i = 0; i < keys.length; i++) {
        var parts = keys[i].split('|');
        var reviewType = parts[0] || '';
        var reviewKey  = parts.slice(1).join('|') || '';
        var data = reviewsObj[keys[i]];
        rows.push({
            user_id:     userId,
            review_type: reviewType,
            review_key:  reviewKey,
            data:        data,
            updated_at:  _toISOOrNull(data && data.updatedAt) || new Date().toISOString()
        });
    }
    return rows;
}

// Convert a value that may be a JS millisecond timestamp (number), an ISO
// date string, or missing/invalid into a valid ISO string for TIMESTAMPTZ
// columns. Returns null when the value is unusable.
function _toISOOrNull(val) {
    if (!val && val !== 0) return null;
    // Already an ISO string (contains '-' like "2025-03-01T…")
    if (typeof val === 'string' && val.indexOf('-') !== -1) return val;
    // Numeric millisecond timestamp (e.g. Date.now() → 1776962004516)
    if (typeof val === 'number' && isFinite(val)) {
        try { return new Date(val).toISOString(); } catch (e) { return null; }
    }
    // Numeric string
    if (typeof val === 'string' && /^\d+$/.test(val)) {
        try { return new Date(Number(val)).toISOString(); } catch (e) { return null; }
    }
    return null;
}

// Map planner keyed objects to Supabase rows.
// Planners are stored as journalData.dailyPlanners['dp|2024-03-01'] = {...}
function _mapPlannerRows(userId, plannersObj) {
    var rows = [];
    if (!plannersObj || typeof plannersObj !== 'object') return rows;
    var keys = Object.keys(plannersObj);
    for (var i = 0; i < keys.length; i++) {
        var data = plannersObj[keys[i]];
        rows.push({
            user_id:     userId,
            planner_key: keys[i],
            data:        data,
            updated_at:  _toISOOrNull(data && data.updatedAt) || new Date().toISOString()
        });
    }
    return rows;
}

// Map local journal metadata flags to user_meta rows.
// Only syncs flags that need cloud representation.
var _USER_META_KEYS = [
    'version', 'created', 'tagCategories',
    '_starterTagsSeeded', '_starterTagsVersion', '_deletedStarterTagKeys', '_categoryMeta',
    '_deletedSystemStrategyKeys', '_deletedStrategyKeys',
    '_demoBrokerVersion', '_demoImportVersion', '_demoImportedAt', '_demoImportDismissed',
    'aiPromptFavorites',
    // Batch D3: page layouts, the system-template seed version and the
    // Dashboard column / default-view preferences.
    'snapshotLayout', 'perfTrendsLayout', 'setupsLayout', 'timingLayout', 'symbolsLayout', 'riskLayout',
    'disciplineLayout', 'reviewLayouts', '_systemTemplatesVersion', 'dashPrefs'
];

function _mapUserMetaRows(userId, jd) {
    var rows = [];
    for (var i = 0; i < _USER_META_KEYS.length; i++) {
        var k = _USER_META_KEYS[i];
        if (jd[k] !== undefined) {
            rows.push({ user_id: userId, key: k, value: JSON.stringify(jd[k]) });
        }
    }
    return rows;
}

// Determine which domains changed since last shadow-write by comparing
// JSON snapshots. No call-site changes needed — just inspects journalData.
function _detectDirtyDomains(jd) {
    var dirty = [];
    var domainKeys = Object.keys(_SHADOW_DOMAINS);
    for (var i = 0; i < domainKeys.length; i++) {
        var dk = domainKeys[i];
        var current = jd[dk];
        if (current === undefined || current === null) continue;
        var snap = JSON.stringify(current);
        if (_domainSnapshots[dk] !== snap) {
            dirty.push(dk);
        }
    }
    return dirty;
}

// Update stored snapshots after a successful shadow-write.
function _updateDomainSnapshots(jd, domains) {
    for (var i = 0; i < domains.length; i++) {
        var dk = domains[i];
        var val = jd[dk];
        if (val !== undefined && val !== null) {
            _domainSnapshots[dk] = JSON.stringify(val);
        }
    }
}

// cloud_primary trades reach Supabase only through the per-trade save and
// delete calls made by the action that changed them. Bulk-upserting the
// cached trades array let a stale browser overwrite or resurrect cloud rows.
function _shadowSkipTrades() {
    return window._denariiStorageMode === 'cloud_primary';
}

// Awaited first-call variant — runs one full shadow-write synchronously so
// the first save per session confirms cloud data is present. Skips debounce
// and single-flight guards. Called only once from saveToIndexedDB().
async function _shadowWriteRowsAwaited(jd) {
    try {
        if (!_cloudWriteAllowed()) { _recordPendingRows(jd); return; }
        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) return;
        var client = SupabaseAuth.getClient();
        if (!client) return;
        var allDomains = Object.keys(_SHADOW_DOMAINS);
        if (allDomains.length === 0) return;
        var snapshot = {};
        for (var i = 0; i < allDomains.length; i++) {
            var dk = allDomains[i];
            if (dk === 'trades' && _shadowSkipTrades()) continue;
            if (jd[dk] !== undefined && jd[dk] !== null) {
                snapshot[dk] = JSON.parse(JSON.stringify(jd[dk]));
            }
        }
        var dirtyDomains = Object.keys(snapshot);
        if (dirtyDomains.length === 0) return;
        await _executeShadowWrite(client, snapshot, dirtyDomains);
        console.log('[Denarii] First shadow-write completed (awaited).');
    } catch (e) {
        console.warn('[Denarii] First shadow-write error:', e.message || e);
    }
}

// Entry point — called from saveToIndexedDB() after local persist.
function _shadowWriteRows(jd) {
    try {
        // Batch D2: cloud_primary without a cloud baseline — remember what
        // changed so it wins on the next good sign-in, write nothing now.
        if (!_cloudWriteAllowed()) { _recordPendingRows(jd); return; }
        // Preconditions: Supabase must be available with an active session
        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) { _keepSkippedShadowRows(jd); return; }
        var client = SupabaseAuth.getClient();
        if (!client) { _keepSkippedShadowRows(jd); return; }

        // Detect dirty domains (compare snapshots)
        var dirtyDomains = _detectDirtyDomains(jd);
        if (dirtyDomains.length === 0) return;

        // 10-second debounce
        var now = Date.now();
        if (now - _lastShadowWriteMs < 10000) { _keepSkippedShadowRows(jd); return; }

        // Single-flight: if a write is running, mark pending and return
        if (_shadowWriteRunning) {
            _shadowWritePending = true;
            _keepSkippedShadowRows(jd);
            return;
        }

        _shadowWriteRunning = true;
        _lastShadowWriteMs = now;

        // Capture a deep copy of dirty domain data so mutations during
        // the async write don't cause issues.
        var snapshot = {};
        for (var i = 0; i < dirtyDomains.length; i++) {
            // Left out of the snapshot: _executeShadowWrite finds no rows and skips it.
            if (dirtyDomains[i] === 'trades' && _shadowSkipTrades()) continue;
            snapshot[dirtyDomains[i]] = JSON.parse(JSON.stringify(jd[dirtyDomains[i]]));
        }

        _executeShadowWrite(client, snapshot, dirtyDomains);
    } catch (e) {
        console.warn('[Denarii] Shadow-write setup error:', e.message || e);
        _shadowWriteRunning = false;
    }
}

// A shadow write that is skipped (debounced, superseded, no client, no
// session or another account's session) must not lose its changes:
// cloud_primary puts the changed rows on the pending list, which the next
// write, re-sync or sign-in sends. Other storage modes have no pending list.
function _keepSkippedShadowRows(jd) {
    if (window._denariiStorageMode !== 'cloud_primary' || !jd) return;
    _recordPendingRows(jd);
}

async function _executeShadowWrite(client, snapshot, dirtyDomains) {
    try {
        var session = await SupabaseAuth.supabaseGetSession();
        if (!session.data || !session.data.user) {
            // No session — keep the changes pending, write nothing
            if (typeof journalData !== 'undefined') _keepSkippedShadowRows(journalData);
            return;
        }
        var userId = session.data.user.id;
        // Batch D2: never write with a session that belongs to another account.
        if (!_sessionMatchesAccount(userId)) {
            console.warn('[Denarii] Shadow-write skipped — cloud session is not this account.');
            if (typeof journalData !== 'undefined') _keepSkippedShadowRows(journalData);
            return;
        }
        // Batch D2: cloud_primary sends only rows that differ from the cloud
        // baseline, so rows this browser did not change are never sent.
        var onlyChanged = window._denariiStorageMode === 'cloud_primary';
        var pendingChanged = false;

        // Batch D3: explicit deletes made while offline or paused go first.
        if (onlyChanged && Object.keys(_cloudDeletes).length) await _pushCloudDeletes(client, userId);

        for (var i = 0; i < dirtyDomains.length; i++) {
            var dk = dirtyDomains[i];
            var cfg = _SHADOW_DOMAINS[dk];
            if (!cfg) continue;

            try {
                var rows = _mapDomainRows(userId, dk, snapshot[dk]);
                if (onlyChanged) rows = _changedRows(dk, rows);

                if (rows.length === 0) continue;

                // Batch D3: cloud_primary writes each changed row with the rev check.
                if (onlyChanged) {
                    if ((await _checkedWriteRows(client, userId, dk, rows)).pendingChanged) pendingChanged = true;
                    continue;
                }

                // One request per key set (see _groupRowsByKeySet), in chunks
                // of 500 to stay within Supabase limits
                var CHUNK = 500;
                var groups = _groupRowsByKeySet(rows);
                for (var gi = 0; gi < groups.length; gi++) {
                    for (var c = 0; c < groups[gi].length; c += CHUNK) {
                        var chunk = groups[gi].slice(c, c + CHUNK);
                        var res;
                        try { res = await client.from(cfg.table).upsert(chunk, { onConflict: cfg.onConflict }); }
                        catch (upErr) { res = { error: upErr }; }
                        if (res.error) {
                            console.warn('[Denarii] Shadow-write failed (' + cfg.table + '):', res.error.message || res.error);
                        }
                        if (onlyChanged && _markRows(dk, chunk, !res.error)) pendingChanged = true;
                    }
                }
            } catch (domainErr) {
                console.warn('[Denarii] Shadow-write error (' + cfg.table + '):', domainErr.message || domainErr);
            }
        }

        // Sync user_meta flags (not a domain — always synced when any domain is dirty)
        try {
            var metaRows = _mapUserMetaRows(userId, snapshot);
            // Merge meta from current journalData for keys not in snapshot
            if (typeof journalData !== 'undefined') {
                var snapshotMetaKeys = {};
                metaRows.forEach(function (r) { snapshotMetaKeys[r.key] = true; });
                var liveMetaRows = _mapUserMetaRows(userId, journalData);
                liveMetaRows.forEach(function (r) {
                    if (!snapshotMetaKeys[r.key]) metaRows.push(r);
                });
            }
            if (onlyChanged) metaRows = _changedRows('_meta', metaRows);
            if (onlyChanged && metaRows.length > 0) {
                if ((await _checkedWriteRows(client, userId, '_meta', metaRows)).pendingChanged) pendingChanged = true;
            } else if (metaRows.length > 0) {
                var metaRes;
                try { metaRes = await client.from('user_meta').upsert(metaRows, { onConflict: 'user_id,key' }); }
                catch (upErr) { metaRes = { error: upErr }; }
                if (metaRes.error) console.warn('[Denarii] Shadow-write failed (user_meta):', metaRes.error.message || metaRes.error);
                if (onlyChanged && _markRows('_meta', metaRows, !metaRes.error)) pendingChanged = true;
            }
        } catch (metaErr) {
            console.warn('[Denarii] Shadow-write error (user_meta):', metaErr.message || metaErr);
        }
        if (pendingChanged) _savePendingRows();

        // Update snapshots only for domains that were successfully processed
        _updateDomainSnapshots(snapshot, dirtyDomains);
    } catch (e) {
        console.warn('[Denarii] Shadow-write execution error:', e.message || e);
    } finally {
        _shadowWriteRunning = false;
        // If another save happened while we were running, do one follow-up
        if (_shadowWritePending) {
            _shadowWritePending = false;
            // Use current journalData for the follow-up (not the stale snapshot)
            if (typeof journalData !== 'undefined') {
                _shadowWriteRows(journalData);
            }
        }
    }
}

// ── Batch D2: cloud-first load and stale-write guard ─────────────
// cloud_primary only. At sign-in the cloud rows replace this browser's
// copy (_cloudFirstReload) and become the baseline. Bulk writes then send
// only rows that differ from the baseline, so a browser never re-sends
// rows it did not change. Without a baseline (offline, slow or failed
// load, failed sign-in) bulk writes are paused and changed rows go on a
// pending list that wins on the next good sign-in. Nothing here deletes
// a row, locally or in the cloud.

var _CLOUD_ARRAY_DOMAINS = ['strategies', 'brokerAccounts', 'trades', 'tags', 'noteTemplates', 'aiOutputHistory', 'aiPrompts'];
var _CLOUD_KEYED_DOMAINS = ['reviews', 'dailyPlanners', 'weeklyPlanners'];

function _withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
        var t = setTimeout(function () { reject(new Error((label || 'Request') + ' timed out')); }, ms);
        promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
}

// Bulk writes for cloud_primary need a baseline loaded from the cloud this
// session. Other storage modes are unchanged.
function _cloudWriteAllowed() {
    if (window._denariiStorageMode !== 'cloud_primary') return true;
    return _cloudBaselineReady && !_cloudPaused;
}

// The Supabase session must belong to the signed-in Denarii account.
function _sessionMatchesAccount(sessionUserId) {
    var expected = window._denariiSupabaseUid;
    return !!expected && expected === sessionUserId;
}

function _mapDomainRows(userId, dk, data) {
    if (dk === 'reviews') return _mapReviewRows(userId, data);
    if (dk === 'dailyPlanners' || dk === 'weeklyPlanners') return _mapPlannerRows(userId, data);
    var arr = Array.isArray(data) ? data : [];
    var rows = [];
    for (var j = 0; j < arr.length; j++) {
        var mapped = _mapArrayRow(userId, dk, arr[j]);
        if (mapped) rows.push(mapped);
    }
    return rows;
}

// Row key = the local key: id, "type|key" for reviews, planner key, meta key.
function _rowKey(dk, row) {
    if (dk === 'reviews') return row.review_type + '|' + row.review_key;
    if (dk === 'dailyPlanners' || dk === 'weeklyPlanners') return row.planner_key;
    if (dk === '_meta') return row.key;
    return String(row.id);
}

// Keyed rows fall back to "now" for updated_at, so it is left out of the
// signature; their data blob already carries any real change.
function _rowSig(dk, row) {
    if (dk === '_meta') return row.value;
    if (dk === 'reviews' || dk === 'dailyPlanners' || dk === 'weeklyPlanners') {
        var c = {};
        for (var k in row) if (k !== 'updated_at') c[k] = row[k];
        return _stableSig(c);
    }
    return _stableSig(row);
}

// Batch D3: object keys sorted at every level and ISO timestamps compared as
// milliseconds, so the cloud's JSONB key order and timestamp format
// ("+00:00" vs ".000Z") never count as a change.
var _ISO_TS_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
function _stableSig(v) {
    return JSON.stringify(v, function (k, val) {
        if (val && typeof val === 'object' && !Array.isArray(val)) {
            var o = {};
            Object.keys(val).sort().forEach(function (kk) { o[kk] = val[kk]; });
            return o;
        }
        if (typeof val === 'string' && _ISO_TS_RE.test(val)) {
            var ms = Date.parse(val);
            if (isFinite(ms)) return 't:' + ms;
        }
        return val;
    });
}

function _changedRows(dk, rows) {
    var base = _rowBaseline[dk] || {};
    return rows.filter(function (r) { return base[_rowKey(dk, r)] !== _rowSig(dk, r); });
}

// ok: the rows are now in the cloud (advance the baseline, clear pending).
// Not ok: keep them pending. Returns true when the pending list changed.
function _markRows(dk, rows, ok) {
    var base = _rowBaseline[dk] || (_rowBaseline[dk] = {});
    var pend = _cloudPending[dk] || {};
    var changed = false;
    for (var i = 0; i < rows.length; i++) {
        var key = _rowKey(dk, rows[i]);
        if (ok) {
            base[key] = _rowSig(dk, rows[i]);
            if (pend[key]) { delete pend[key]; changed = true; }
        } else if (!pend[key]) {
            pend[key] = true;
            changed = true;
        }
    }
    if (Object.keys(pend).length) _cloudPending[dk] = pend;
    else delete _cloudPending[dk];
    return changed;
}

function _savePendingRows() {
    if (!currentAccountId) return;
    var val = Object.keys(_cloudPending).length ? JSON.parse(JSON.stringify(_cloudPending)) : null;
    Promise.resolve(setSetting('cloudPending:' + currentAccountId, val)).catch(function (e) {
        console.warn('[Denarii] Could not save the pending cloud list:', e.message || e);
    });
}

async function _loadPendingRows(accountId) {
    try {
        var p = await getSetting('cloudPending:' + accountId);
        _cloudPending = (p && typeof p === 'object') ? p : {};
    } catch (e) {
        _cloudPending = {};
    }
    // Batch D3: revs last seen in the cloud and queued deletes, so a session
    // that signs in offline still detects conflicts when it reconnects.
    try {
        var rv = await getSetting('cloudRevs:' + accountId);
        _rowRev = (rv && typeof rv === 'object') ? rv : {};
        var dl = await getSetting('cloudDeletes:' + accountId);
        _cloudDeletes = (dl && typeof dl === 'object') ? dl : {};
    } catch (e) {
        _rowRev = {};
        _cloudDeletes = {};
    }
}

// Paused session: add rows that differ from the baseline to the pending list.
function _recordPendingRows(jd) {
    try {
        var uid = window._denariiSupabaseUid;
        var changed = false;
        Object.keys(_SHADOW_DOMAINS).forEach(function (dk) {
            if (dk === 'trades' || jd[dk] === undefined || jd[dk] === null) return;
            var rows = _changedRows(dk, _mapDomainRows(uid, dk, jd[dk]));
            if (rows.length && _markRows(dk, rows, false)) changed = true;
        });
        var meta = _changedRows('_meta', _mapUserMetaRows(uid, jd));
        if (meta.length && _markRows('_meta', meta, false)) changed = true;
        if (changed) _savePendingRows();
    } catch (e) {
        console.warn('[Denarii] Pending cloud list error:', e.message || e);
    }
}

// Baseline = the rows of jd, except pending rows (so those get sent).
// ready=false is a paused session: the baseline is this browser's copy.
// cloudJd (Batch D3): the data just loaded from the cloud. The baseline is
// then what the cloud really holds, so local fields the cloud does not have
// yet (new meta keys, `extra`, late columns) are sent once.
function _setCloudBaseline(jd, ready, cloudJd) {
    var uid = window._denariiSupabaseUid;
    var src = cloudJd || jd;
    _rowBaseline = {};
    Object.keys(_SHADOW_DOMAINS).forEach(function (dk) {
        if (dk === 'trades') return;
        var base = _rowBaseline[dk] = {};
        var pend = _cloudPending[dk] || {};
        _mapDomainRows(uid, dk, src[dk]).forEach(function (r) {
            var key = _rowKey(dk, r);
            if (!pend[key]) base[key] = _rowSig(dk, r);
        });
    });
    var mbase = _rowBaseline._meta = {};
    var mpend = _cloudPending._meta || {};
    _mapUserMetaRows(uid, src).forEach(function (r) { if (!mpend[r.key]) mbase[r.key] = r.value; });
    _domainSnapshots = {};
    _updateDomainSnapshots(jd, Object.keys(_SHADOW_DOMAINS));
    _cloudBaselineReady = !!ready;
    _cloudPaused = !ready;
}

function _enterCloudPaused(reason) {
    console.warn('[CloudLoad] Using this browser\'s copy; cloud writes paused:', reason);
    _setCloudBaseline(journalData, false);
    _cloudLoadStatus = { ok: false, hidden: 0, reason: reason };
    return { ok: false, reason: reason };
}

// unlockApp: a cloud_primary session that never loaded the cloud (for
// example a JSON backup import) stays paused.
function _ensureCloudSessionState() {
    if (window._denariiStorageMode === 'cloud_primary' && !_cloudBaselineReady && !_cloudPaused) {
        _enterCloudPaused('cloud data was not loaded at sign-in');
    }
}

// The Supabase session can end while the journal is open (lock in another
// tab, failed token refresh) or switch to another account. Unsent changes
// go on the pending list first, then cloud writes pause and the banner asks
// the user to sign in again. Subscribed once per page from unlockApp.
var _CLOUD_SESSION_ENDED = 'cloud session ended';
var _cloudSessionWatchOn = false;
function _watchCloudSession() {
    if (_cloudSessionWatchOn) return;
    if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) return;
    var client = SupabaseAuth.getClient();
    if (!client || !client.auth || typeof client.auth.onAuthStateChange !== 'function') return;
    _cloudSessionWatchOn = true;
    client.auth.onAuthStateChange(function (event, session) {
        // Only an unlocked cloud_primary journal; lock clears the session keys first.
        if (window._denariiStorageMode !== 'cloud_primary' || !currentAccountId || !(sessionDek || sessionPassword)) return;
        var uid = session && session.user ? session.user.id : null;
        if (event !== 'SIGNED_OUT' && _sessionMatchesAccount(uid)) return;
        _onCloudSessionLost();
    });
}

function _onCloudSessionLost() {
    if (_cloudPaused) return;
    if (_cloudBaselineReady) _recordPendingRows(journalData);
    _enterCloudPaused(_CLOUD_SESSION_ENDED);
    var oldBanner = typeof document !== 'undefined' && document.getElementById('cloud-load-banner');
    if (oldBanner) oldBanner.remove();
    _showCloudLoadBanner();
}

function _overlayRecord(local, cloud) {
    var o = {}, k;
    for (k in local) o[k] = local[k];
    for (k in cloud) if (cloud[k] !== undefined) o[k] = cloud[k];
    return o;
}

// Cloud records are the visible set; each is laid over the local record
// with the same key so local-only fields survive. Pending rows keep the
// local version. Local records missing from the cloud are hidden (counted),
// except Pelosi demo trades while the demo broker is in the cloud: those
// never reached the cloud on accounts created as cloud_primary, so they are
// kept and returned in demoTrades to be saved. Keys the cloud does not
// store (layouts, settings, drafts) stay local.
// deletes (Batch D3): records deleted here but not yet in the cloud stay out.
// hiddenKeys: "<domain>:<id or key>" of each hidden record, sorted.
function _mergeCloudIntoLocal(local, cloud, pending, deletes) {
    pending = pending || {};
    deletes = deletes || {};
    var jd = {}, hidden = 0, hiddenKeys = [], demoTrades = [], k;
    for (k in local) jd[k] = local[k];

    var mpend = pending._meta || {};
    Object.keys(cloud).forEach(function (key) {
        if (_CLOUD_ARRAY_DOMAINS.indexOf(key) !== -1 || _CLOUD_KEYED_DOMAINS.indexOf(key) !== -1) return;
        if (mpend[key] && local[key] !== undefined) return;
        jd[key] = cloud[key];
    });

    _CLOUD_ARRAY_DOMAINS.forEach(function (dk) {
        if (!Array.isArray(cloud[dk])) return;
        var pend = pending[dk] || {};
        var localArr = Array.isArray(local[dk]) ? local[dk] : [];
        var cloudById = {}, used = {}, out = [];
        cloud[dk].forEach(function (c) { cloudById[String(c.id)] = c; });
        var keepDemo = dk === 'trades' && jd._demoImportDismissed !== true &&
            (jd.brokerAccounts || []).some(function (a) { return a.id === _DEMO_BROKER_ID; });
        localArr.forEach(function (l) {
            var id = String(l.id), c = cloudById[id];
            if (pend[id]) { out.push(l); used[id] = true; }
            else if (c) { out.push(_overlayRecord(l, c)); used[id] = true; }
            else if (keepDemo && l.brokerAccountId === _DEMO_BROKER_ID) { out.push(l); demoTrades.push(l); }
            else { hidden++; hiddenKeys.push(dk + ':' + id); }
        });
        var dels = deletes[dk] || {};
        cloud[dk].forEach(function (c) { if (!used[String(c.id)] && !dels[String(c.id)]) out.push(c); });
        jd[dk] = out;
    });

    _CLOUD_KEYED_DOMAINS.forEach(function (dk) {
        if (!cloud[dk] || typeof cloud[dk] !== 'object') return;
        var pend = pending[dk] || {};
        var localObj = (local[dk] && typeof local[dk] === 'object') ? local[dk] : {};
        var out = {}, kdels = deletes[dk] || {};
        Object.keys(cloud[dk]).forEach(function (key) { if (!kdels[key]) out[key] = cloud[dk][key]; });
        Object.keys(localObj).forEach(function (key) {
            if (pend[key]) out[key] = localObj[key];
            else if (!Object.prototype.hasOwnProperty.call(cloud[dk], key)) { hidden++; hiddenKeys.push(dk + ':' + key); }
        });
        jd[dk] = out;
    });

    return { jd: jd, hidden: hidden, hiddenKeys: hiddenKeys.sort(), demoTrades: demoTrades,
        changed: JSON.stringify(jd) !== JSON.stringify(local) };
}

// Keys ("<domain>:<id or key>") of the records in jd that the cloud does not
// have. Stricter than the merge so snapshot pruning errs toward keeping:
// unsent rows and Pelosi demo trades count, and a domain the cloud did not
// return counts as empty.
function _keysMissingFromCloud(jd, cloud) {
    var out = [];
    cloud = cloud || {};
    _CLOUD_ARRAY_DOMAINS.forEach(function (dk) {
        if (!Array.isArray(jd[dk])) return;
        var ids = {};
        (Array.isArray(cloud[dk]) ? cloud[dk] : []).forEach(function (c) { if (c) ids[String(c.id)] = true; });
        jd[dk].forEach(function (l) { if (l && !ids[String(l.id)]) out.push(dk + ':' + l.id); });
    });
    _CLOUD_KEYED_DOMAINS.forEach(function (dk) {
        if (!jd[dk] || typeof jd[dk] !== 'object') return;
        var c = (cloud[dk] && typeof cloud[dk] === 'object') ? cloud[dk] : {};
        Object.keys(jd[dk]).forEach(function (key) {
            if (!Object.prototype.hasOwnProperty.call(c, key)) out.push(dk + ':' + key);
        });
    });
    return out;
}

// Keeps the newest _CLOUDLOAD_SNAPSHOTS_KEEP "cloudload:" snapshots. An older
// one is deleted only when it decrypts and every record in it is in the
// cloud just loaded; any failure keeps it. Runs only with a cloud baseline
// (after a successful load or re-sync), never while paused.
var _CLOUDLOAD_SNAPSHOTS_KEEP = 3;
async function _pruneCloudLoadSnapshots(accountId, cloud) {
    var removed = 0;
    try {
        if (!accountId || !cloud || !_cloudBaselineReady || _cloudPaused) return 0;
        var encKey = sessionDek || sessionPassword;
        if (!encKey) return 0;
        var prefix = 'cloudload:' + accountId + ':';
        var keys = (await storeGetAllKeys(STORE_NAME)).filter(function (k) {
            return typeof k === 'string' && k.indexOf(prefix) === 0;
        });
        // Keys contain ISO timestamps — lexicographic sort = chronological sort
        keys.sort();
        var older = keys.slice(0, Math.max(0, keys.length - _CLOUDLOAD_SNAPSHOTS_KEEP));
        for (var i = 0; i < older.length; i++) {
            try {
                var rec = await storeGet(STORE_NAME, older[i]);
                if (!rec || !rec.encrypted || !rec.data) continue;
                var snap = decrypt(rec.data, encKey);
                if (!snap || typeof snap !== 'object') continue;
                if (_keysMissingFromCloud(snap, cloud).length) continue;
                await storeDelete(STORE_NAME, older[i]);
                removed++;
            } catch (e) {
                console.warn('[Denarii] Cloud-load snapshot kept (' + older[i] + '):', e.message || e);
            }
        }
        if (removed) console.log('[Denarii] Pruned ' + removed + ' cloud-load snapshot(s) for account ' + accountId);
    } catch (e) {
        console.warn('[Denarii] Cloud-load snapshot pruning error:', e.message || e);
    }
    return removed;
}

// Copy of this browser's journal record before records are hidden. Unlike
// snapshotJournalRecord it is pruned only by _pruneCloudLoadSnapshots, which
// never deletes one holding records missing from the cloud, so hidden
// records stay recoverable (key "cloudload:<accountId>:<ISO time>").
async function _keepCloudLoadSnapshot(accountId) {
    var existing = await storeGet(STORE_NAME, makeJournalKey(accountId));
    if (!existing || !existing.data) return null;
    var ts = new Date().toISOString();
    var key = 'cloudload:' + accountId + ':' + ts;
    await storePut(STORE_NAME, {
        _isSnapshot: true, sourceAccountId: accountId, reason: 'pre-cloud-load-hidden', snapshotAt: ts,
        encrypted: existing.encrypted, data: existing.data, lastSaved: existing.lastSaved || null
    }, key);
    console.log('[Denarii] Safety snapshot created:', key);
    return key;
}

// Sign-in on a browser that already has this account's local copy.
// Success: journalData and the IndexedDB copy become cloud + pending rows.
// Any failure or timeout: journalData and IndexedDB are left untouched and
// the session is paused.
async function _cloudFirstReload(auth) {
    _cloudLoadStatus = null;
    if (!auth || _resolveStorageMode(auth) !== 'cloud_primary') return { ok: false, reason: 'not cloud_primary' };
    window._denariiStorageMode = 'cloud_primary';
    window._denariiSupabaseUid = auth.supabaseUid || null;
    await _loadPendingRows(auth.id);

    var cloud = null, reason = null, revs = {};
    try {
        if (_cloudSignInFailed) throw new Error('cloud sign-in failed');
        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) throw new Error('cloud unavailable');
        var client = SupabaseAuth.getClient();
        var session = await _withTimeout(SupabaseAuth.supabaseGetSession(), _CLOUD_LOAD_TIMEOUT_MS, 'Session check');
        var uid = session && session.data && session.data.user ? session.data.user.id : null;
        if (!client || !uid || uid !== auth.supabaseUid) throw new Error('no cloud session for this account');
        cloud = await _withTimeout(_loadJournalFromSupabaseRows(client, uid, { strict: true, revs: revs }), _CLOUD_LOAD_TIMEOUT_MS, 'Cloud load');
    } catch (e) {
        reason = e.message || String(e);
    }
    if (!cloud) return _enterCloudPaused(reason);

    var merged = _mergeCloudIntoLocal(journalData, cloud, _cloudPending, _cloudDeletes);
    if (!merged.jd.brokerAccounts) merged.jd.brokerAccounts = [];
    if (merged.changed) {
        try {
            if (merged.hidden > 0) await _keepCloudLoadSnapshot(auth.id);
            else await snapshotJournalRecord(auth.id, 'pre-cloud-load');
            var encKey = sessionDek || sessionPassword;
            await saveJournalRecord(auth.id, { encrypted: true, data: encrypt(merged.jd, encKey), lastSaved: new Date().toISOString() });
        } catch (e) {
            return _enterCloudPaused('local copy could not be updated: ' + (e.message || e));
        }
    }

    journalData = merged.jd;
    _adoptRevs(revs);
    _setCloudBaseline(journalData, true, cloud);
    _lastCloudResyncMs = Date.now();
    _cloudLoadStatus = { ok: true, hidden: merged.hidden, hiddenKeys: merged.hiddenKeys, reason: null };
    _pruneCloudLoadSnapshots(auth.id, cloud);
    // Runs before unlockApp's backfill, so an interrupted rename cannot bring the old name back.
    try { await _resumeStrategyRename(); }
    catch (e) { console.warn('[Denarii] Strategy rename recovery error:', e.message || e); }
    try { await _resumeStrategyDelete(); }
    catch (e) { console.warn('[Denarii] Strategy delete recovery error:', e.message || e); }
    console.log('[CloudLoad] Cloud-first load complete. Hidden local-only records:', merged.hidden,
        '| pending pushed:', Object.keys(_cloudPending).length > 0, '| demo trades to save:', merged.demoTrades.length);

    // Sends what the cloud does not have yet: pending rows, queued deletes,
    // and local fields the cloud lacks (Batch D3). Rows equal to the cloud
    // are in the baseline and are never sent.
    _shadowWriteRowsAwaited(journalData);
    if (merged.demoTrades.length) _saveDemoTradesAndRefresh(merged.demoTrades);
    return { ok: true, hidden: merged.hidden };
}

// Kept Pelosi demo trades: saved to the cloud, then the cloud Dashboard is
// refetched so it shows them (Batch D3). Failures are logged only.
function _saveDemoTradesAndRefresh(trades) {
    _saveTradesToSupabase(trades).then(function (r) {
        if (!r || !r.success) { console.warn('[Denarii] Demo trades cloud save failed:', r && r.error); return; }
        _triggerCloudDashRefresh();
        if (typeof updateDashboard === 'function') updateDashboard();
    }, function (e) { console.warn('[Denarii] Demo trades cloud save error:', e.message || e); });
}

// Shown after unlock when the cloud load hid records or failed. The hidden
// notice is shown only when at least one hidden key is not already in
// cloudHiddenShown:<accountId>; the failure notice is always shown.
var _CLOUD_HIDDEN_SHOWN_MAX = 500;
async function _showCloudLoadBanner() {
    var s = _cloudLoadStatus;
    if (!s || window._denariiStorageMode !== 'cloud_primary' || (s.ok && !s.hidden)) return;
    if (typeof document === 'undefined' || !document.body || document.getElementById('cloud-load-banner')) return;
    if (s.ok && !(await _claimHiddenNotice(s.hiddenKeys))) return;
    if (document.getElementById('cloud-load-banner')) return;
    var msg = s.ok
        ? s.hidden + (s.hidden === 1 ? ' item' : ' items') + ' saved only in this browser ' + (s.hidden === 1 ? 'is' : 'are') +
          ' not in your cloud data, so ' + (s.hidden === 1 ? 'it is' : 'they are') + ' hidden. A copy is kept in this browser.'
        : s.reason === _CLOUD_SESSION_ENDED
        ? 'You were signed out of the cloud. Your changes stay in this browser. Log out and sign in again to sync them.'
        : 'Couldn’t load your cloud data. Showing this browser’s copy; your changes stay in this browser and sync at your next sign-in with a connection.';
    var bar = document.createElement('div');
    bar.id = 'cloud-load-banner';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:16px;transform:translateX(-50%);z-index:9999;' +
        'max-width:calc(100vw - 32px);width:640px;box-sizing:border-box;padding:10px 14px;border-radius:8px;' +
        'background:var(--bg-secondary,#1f2937);color:var(--text-primary,#f9fafb);border:1px solid var(--warning,#f59e0b);' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:13px;display:flex;gap:12px;align-items:center;';
    var text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = msg;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary';
    btn.textContent = 'Dismiss';
    btn.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(text);
    bar.appendChild(btn);
    document.body.appendChild(bar);
}

// True when hiddenKeys holds a key not shown before; the shown list then
// gains these keys (newest last, capped). Without keys or an account the
// notice is shown and nothing is recorded; a settings error also shows it.
async function _claimHiddenNotice(hiddenKeys) {
    if (!Array.isArray(hiddenKeys) || !hiddenKeys.length || !currentAccountId) return true;
    var settingKey = 'cloudHiddenShown:' + currentAccountId;
    try {
        var shown = await getSetting(settingKey);
        shown = Array.isArray(shown) ? shown : [];
        var seen = {};
        shown.forEach(function (k) { seen[k] = true; });
        var fresh = hiddenKeys.filter(function (k) { return !seen[k]; });
        if (!fresh.length) return false;
        await setSetting(settingKey, shown.concat(fresh).slice(-_CLOUD_HIDDEN_SHOWN_MAX));
    } catch (e) {
        console.warn('[Denarii] Hidden-items notice list error:', e.message || e);
    }
    return true;
}

// ── Batch D3: checked saves, tracked deletes, conflicts, re-sync ─────────
// cloud_primary only, non-trade data. Every table has a `rev` the database
// bumps on each real change. A known row is updated only "where rev = the
// rev this browser last saw"; no row back means another device changed it,
// and the cloud wins (this browser's version is kept as a conflict copy).
// A new row is inserted; a duplicate key means another device made it
// first. Explicit deletes are queued while offline or paused and pushed
// later; a record edited elsewhere after this browser deleted it is kept.
// Only an explicit user delete ever removes a row.

var _CLOUD_PK = {
    reviews: ['review_type', 'review_key'],
    dailyPlanners: ['planner_key'],
    weeklyPlanners: ['planner_key'],
    _meta: ['key']
};
var _CLOUD_RESYNC_IDLE_MS = 5 * 60 * 1000;

function _cloudTable(dk) {
    return dk === '_meta' ? 'user_meta' : (_SHADOW_DOMAINS[dk] && _SHADOW_DOMAINS[dk].table);
}

function _cloudPk(dk) {
    return _CLOUD_PK[dk] || ['id'];
}

// Primary-key column values for a local row key.
function _cloudPkValues(dk, key) {
    if (dk === 'reviews') {
        var parts = String(key).split('|');
        return { review_type: parts[0] || '', review_key: parts.slice(1).join('|') || '' };
    }
    if (dk === 'dailyPlanners' || dk === 'weeklyPlanners') return { planner_key: key };
    if (dk === '_meta') return { key: key };
    return { id: String(key) };
}

function _cloudFilterPk(q, dk, vals) {
    _cloudPk(dk).forEach(function (c) { q = q.eq(c, vals[c]); });
    return q;
}

// A request that throws (network) is returned as { error } like a failed one.
async function _cloudCall(fn) {
    try { return await fn(); } catch (e) { return { data: null, error: e }; }
}

function _isDuplicateKey(err) {
    return !!err && (err.code === '23505' || /duplicate key/i.test(String(err.message || '')));
}

// The Supabase session's user id, only when it is this account.
async function _cloudSessionUid() {
    try {
        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) return null;
        var s = await SupabaseAuth.supabaseGetSession();
        var uid = s && s.data && s.data.user ? s.data.user.id : null;
        return _sessionMatchesAccount(uid) ? uid : null;
    } catch (e) {
        return null;
    }
}

function _saveRevs() {
    if (!currentAccountId) return;
    Promise.resolve(setSetting('cloudRevs:' + currentAccountId, JSON.parse(JSON.stringify(_rowRev)))).catch(function () {});
}

function _saveCloudDeletes() {
    if (!currentAccountId) return;
    var val = Object.keys(_cloudDeletes).length ? JSON.parse(JSON.stringify(_cloudDeletes)) : null;
    Promise.resolve(setSetting('cloudDeletes:' + currentAccountId, val)).catch(function () {});
}

// New revs from a cloud load. Rows with unsent changes or deletes keep the
// rev this browser last saw, so a change made meanwhile on another device
// is still detected. With no rev known, the cloud's is used (D2 rule:
// pending rows win).
function _adoptRevs(newRevs) {
    var out = newRevs || {};
    [_cloudPending, _cloudDeletes].forEach(function (src) {
        Object.keys(src).forEach(function (dk) {
            Object.keys(src[dk] || {}).forEach(function (key) {
                var old = _rowRev[dk] && _rowRev[dk][key];
                if (old == null) return;
                (out[dk] || (out[dk] = {}))[key] = old;
            });
        });
    });
    _rowRev = out;
    _saveRevs();
}

// After an explicit delete reached the cloud.
function _forgetCloudRow(dk, key) {
    if (_rowRev[dk]) delete _rowRev[dk][key];
    if (_rowBaseline[dk]) delete _rowBaseline[dk][key];
    if (_cloudPending[dk] && _cloudPending[dk][key]) {
        delete _cloudPending[dk][key];
        if (!Object.keys(_cloudPending[dk]).length) delete _cloudPending[dk];
        _savePendingRows();
    }
}

// ── Local record access by row key ──
function _localValue(dk, key) {
    if (typeof journalData === 'undefined' || !journalData) return undefined;
    if (dk === '_meta') return journalData[key];
    var d = journalData[dk];
    if (Array.isArray(d)) {
        for (var i = 0; i < d.length; i++) if (String(d[i].id) === String(key)) return d[i];
        return undefined;
    }
    return d && typeof d === 'object' ? d[key] : undefined;
}

// Puts the cloud version in journalData (array records are laid over the
// local one, so fields the cloud does not store survive).
function _setLocalValue(dk, key, val) {
    if (dk === '_meta') { journalData[key] = val; return; }
    if (_CLOUD_KEYED_DOMAINS.indexOf(dk) !== -1) {
        if (!journalData[dk] || typeof journalData[dk] !== 'object') journalData[dk] = {};
        journalData[dk][key] = val;
        return;
    }
    if (!Array.isArray(journalData[dk])) journalData[dk] = [];
    var arr = journalData[dk];
    for (var i = 0; i < arr.length; i++) {
        if (String(arr[i].id) === String(key)) { arr[i] = _overlayRecord(arr[i], val); return; }
    }
    arr.push(val);
}

// Signature of a cloud row, computed the way local rows are (cloud row →
// local record → row), so the two compare equal when the data is the same.
function _cloudRowSig(dk, cloudRow, uid) {
    var local = _cloudRowToLocal(dk, cloudRow);
    var key = dk === 'reviews' ? cloudRow.review_type + '|' + cloudRow.review_key
        : (dk === 'dailyPlanners' || dk === 'weeklyPlanners') ? cloudRow.planner_key
        : dk === '_meta' ? cloudRow.key : null;
    if (dk === '_meta') return JSON.stringify(local);
    var obj = {};
    if (key != null) obj[key] = local;
    var rows = _mapDomainRows(uid, dk, key != null ? obj : [local]);
    return rows.length ? _rowSig(dk, rows[0]) : null;
}

// ── Conflict copies ──
// Kept in this browser only, encrypted like the journal, newest 100.
var _conflictChain = Promise.resolve();
function _recordCloudConflict(dk, key, localValue, reason) {
    _cloudConflictCount++;
    if (currentAccountId) {
        var acct = currentAccountId;
        var encKey = sessionDek || sessionPassword;
        var entry = {
            domain: dk, key: String(key), at: new Date().toISOString(), reason: reason || 'changed on another device',
            local: (localValue === undefined || !encKey) ? null : encrypt(localValue, encKey)
        };
        _conflictChain = _conflictChain.then(function () {
            return Promise.resolve(getSetting('cloudConflicts:' + acct)).then(function (list) {
                list = Array.isArray(list) ? list : [];
                list.push(entry);
                if (list.length > 100) list = list.slice(list.length - 100);
                return setSetting('cloudConflicts:' + acct, list);
            });
        }).catch(function (e) { console.warn('[Denarii] Could not keep the conflict copy:', e.message || e); });
    }
    _afterCloudConflicts();
}

// The cloud row won: put it in journalData and make it the baseline.
function _applyCloudWin(dk, key, cloudRow, uid, reason, keepLocal) {
    var editorHits = _editorGuardsForRow(dk, key);   // Batch 2: before the local copy changes
    if (keepLocal) _recordCloudConflict(dk, key, _localValue(dk, key), reason);
    else _recordCloudConflict(dk, key, undefined, reason);
    _setLocalValue(dk, key, _cloudRowToLocal(dk, cloudRow));
    if (cloudRow.rev != null) (_rowRev[dk] || (_rowRev[dk] = {}))[key] = Number(cloudRow.rev);
    (_rowBaseline[dk] || (_rowBaseline[dk] = {}))[key] = _cloudRowSig(dk, cloudRow, uid);
    if (_cloudPending[dk] && _cloudPending[dk][key]) {
        delete _cloudPending[dk][key];
        if (!Object.keys(_cloudPending[dk]).length) delete _cloudPending[dk];
        _savePendingRows();
    }
    _editorGuardsApply(editorHits);
}

// ── Batch 2: open editors ──
// An open editor registers the record it shows (_editorGuardOpen). When a
// re-sync or a cloud win replaces that record, a clean form reloads with a
// short notice; a form with unsaved edits is marked stale and shows a
// Reload bar. A save while stale does not write: the cloud version (already
// in journalData) stays and the editor's version is kept as a conflict
// copy (_editorGuardConflict), then the editor reloads. Same rule as D3.
// A record removed by the re-sync is not stale (D3 rule: editing keeps
// it); an editor may pass goneMessage to say so instead.
// window._denariiEditorGuardOff = true turns all of this off.
//
// hooks: isDirty() unsaved edits, reload() show the current record,
// resolve() keep this version as a conflict copy and reload, optional
// isOpen() false when the form is closed (then it is only marked stale),
// optional goneMessage.
var _editorGuards = {};              // editor id -> { dk, key, stale, gone, hooks }

function _editorGuardOpen(id, dk, key, hooks) {
    _editorGuards[id] = { dk: dk, key: String(key), stale: false, gone: false, hooks: hooks || {} };
    _hideEditorNotice(id);
}

function _editorGuardClose(id) {
    delete _editorGuards[id];
    _hideEditorNotice(id);
}

// key (optional): only when the guard is for that record.
function _editorGuardStale(id, key) {
    var g = _editorGuards[id];
    if (!g || !g.stale || (typeof window !== 'undefined' && window._denariiEditorGuardOff)) return false;
    return key == null || g.key === String(key);
}

function _editorGuardGone(id) {
    var g = _editorGuards[id];
    return !!g && g.gone;
}

// A save while stale: the cloud version stays, localValue is kept.
function _editorGuardConflict(id, localValue) {
    var g = _editorGuards[id];
    if (!g) return;
    g.stale = false;
    _hideEditorNotice(id);
    _recordCloudConflict(g.dk, g.key, localValue, 'edited here while another device changed it');
}

function _editorRecord(jd, dk, key) {
    var d = jd && jd[dk];
    if (Array.isArray(d)) {
        for (var i = 0; i < d.length; i++) if (d[i] && String(d[i].id) === key) return d[i];
        return undefined;
    }
    return d && typeof d === 'object' ? d[key] : undefined;
}

// Signature through the app's mappers (only fields the cloud stores).
function _editorRecordSig(dk, key, val) {
    if (val === undefined || val === null) return null;
    var src = val;
    if (_CLOUD_KEYED_DOMAINS.indexOf(dk) !== -1) { src = {}; src[key] = val; } else src = [val];
    var rows = _mapDomainRows(window._denariiSupabaseUid, dk, src);
    return rows.length ? _rowSig(dk, rows[0]) : JSON.stringify(val);
}

// Asked while journalData still holds the version the editor loaded.
function _editorGuardHit(id, g, gone) {
    var open = !g.hooks.isOpen, dirty = false;
    try { if (g.hooks.isOpen) open = !!g.hooks.isOpen(); } catch (e) { open = false; }
    if (open && !gone) {
        try { dirty = !g.hooks.isDirty || !!g.hooks.isDirty(); } catch (e) { dirty = true; }
    }
    return { id: id, g: g, open: open, dirty: dirty, gone: !!gone };
}

function _editorGuardsForRow(dk, key) {
    var out = [];
    if (window._denariiEditorGuardOff) return out;
    Object.keys(_editorGuards).forEach(function (id) {
        var g = _editorGuards[id];
        if (g.dk === dk && g.key === String(key)) out.push(_editorGuardHit(id, g, false));
    });
    return out;
}

// Re-sync: guarded records that changed (rev moved and the data differs;
// trades have no rev, so the data alone) or were removed.
function _editorGuardsBeforeResync(oldJd, newJd, newRevs) {
    var out = [];
    if (window._denariiEditorGuardOff) return out;
    Object.keys(_editorGuards).forEach(function (id) {
        var g = _editorGuards[id];
        var before = _editorRecord(oldJd, g.dk, g.key), after = _editorRecord(newJd, g.dk, g.key);
        if (after === undefined) {
            if (before !== undefined) out.push(_editorGuardHit(id, g, true));
            return;
        }
        var oldRev = _rowRev[g.dk] && _rowRev[g.dk][g.key];
        var newRev = newRevs && newRevs[g.dk] && newRevs[g.dk][g.key];
        if (oldRev != null && newRev != null && Number(oldRev) === Number(newRev)) return;
        if (_editorRecordSig(g.dk, g.key, before) === _editorRecordSig(g.dk, g.key, after)) return;
        out.push(_editorGuardHit(id, g, false));
    });
    return out;
}

function _editorGuardsApply(hits) {
    (hits || []).forEach(function (h) {
        var g = _editorGuards[h.id];
        if (g !== h.g) return;   // closed or reopened meanwhile
        if (h.gone) {
            g.gone = true;
            if (g.hooks.goneMessage) _showEditorNotice(h.id, g.hooks.goneMessage, false, true);
            return;
        }
        if (!h.open) { g.stale = true; return; }
        if (h.dirty) {
            g.stale = true;
            _showEditorNotice(h.id, 'This item was updated on another device.', true);
            return;
        }
        try {
            g.hooks.reload();
        } catch (e) {
            console.warn('[Denarii] Editor reload failed:', e.message || e);
            g.stale = true;
            return;
        }
        _showEditorNotice(h.id, 'Updated from another device.', false);
    });
}

// Fixed bar in the conflict banner's style. withReload: Reload button
// (keeps this version as a conflict copy, then loads the current one).
// Without it the bar hides itself after a few seconds unless sticky.
function _showEditorNotice(id, msg, withReload, sticky) {
    if (typeof document === 'undefined' || !document.body) return;
    var old = document.getElementById('editor-sync-notice');
    if (old) old.remove();
    var bar = document.createElement('div');
    bar.id = 'editor-sync-notice';
    bar.setAttribute('data-editor', id);
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:9999;' +
        'max-width:calc(100vw - 32px);width:640px;box-sizing:border-box;padding:10px 14px;border-radius:8px;' +
        'background:var(--bg-secondary,#1f2937);color:var(--text-primary,#f9fafb);border:1px solid var(--warning,#f59e0b);' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:13px;display:flex;gap:12px;align-items:center;';
    var text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = msg;
    bar.appendChild(text);
    if (withReload) {
        var reload = document.createElement('button');
        reload.type = 'button';
        reload.className = 'btn btn-primary';
        reload.textContent = 'Reload';
        reload.addEventListener('click', function () {
            bar.remove();
            var g = _editorGuards[id];
            if (g && g.stale && g.hooks.resolve) g.hooks.resolve();
        });
        bar.appendChild(reload);
    }
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary';
    btn.textContent = 'Dismiss';
    btn.addEventListener('click', function () { bar.remove(); });
    bar.appendChild(btn);
    document.body.appendChild(bar);
    if (!withReload && !sticky) setTimeout(function () { if (bar.parentNode) bar.remove(); }, 4000);
}

function _hideEditorNotice(id) {
    if (typeof document === 'undefined' || typeof document.getElementById !== 'function') return;
    var bar = document.getElementById('editor-sync-notice');
    if (bar && bar.getAttribute('data-editor') === id) bar.remove();
}

// Coalesced: save the updated local copy, redraw, show the banner.
var _conflictFlushTimer = null;
function _afterCloudConflicts() {
    if (_conflictFlushTimer) return;
    _conflictFlushTimer = setTimeout(function () {
        _conflictFlushTimer = null;
        _persistLocalCopy();
        if (typeof window._denariiRefreshUI === 'function') {
            try { window._denariiRefreshUI(); } catch (e) { console.warn('[Denarii] Refresh after conflict failed:', e.message || e); }
        }
        _showCloudConflictBanner();
    }, 0);
}

// IndexedDB copy only; no cloud write.
async function _persistLocalCopy() {
    try {
        var encKey = sessionDek || sessionPassword;
        if (!encKey || !currentAccountId || typeof journalData === 'undefined') return;
        await saveJournalRecord(currentAccountId, { encrypted: true, data: encrypt(journalData, encKey), lastSaved: new Date().toISOString() });
    } catch (e) {
        console.warn('[Denarii] Local copy could not be saved:', e.message || e);
    }
}

function _showCloudConflictBanner() {
    if (!_cloudConflictCount || typeof document === 'undefined' || !document.body) return;
    var n = _cloudConflictCount;
    var msg = n + (n === 1 ? ' change from this browser was' : ' changes from this browser were') +
        ' replaced by newer changes from another device. A copy is kept in this browser.';
    var bar = document.getElementById('cloud-conflict-banner');
    if (bar) { bar.firstChild.textContent = msg; return; }
    bar = document.createElement('div');
    bar.id = 'cloud-conflict-banner';
    bar.setAttribute('role', 'status');
    bar.style.cssText = 'position:fixed;left:50%;bottom:64px;transform:translateX(-50%);z-index:9999;' +
        'max-width:calc(100vw - 32px);width:640px;box-sizing:border-box;padding:10px 14px;border-radius:8px;' +
        'background:var(--bg-secondary,#1f2937);color:var(--text-primary,#f9fafb);border:1px solid var(--warning,#f59e0b);' +
        'box-shadow:0 4px 16px rgba(0,0,0,.25);font-size:13px;display:flex;gap:12px;align-items:center;';
    var text = document.createElement('span');
    text.style.flex = '1';
    text.textContent = msg;
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'btn btn-secondary';
    btn.textContent = 'Dismiss';
    btn.addEventListener('click', function () { bar.remove(); _cloudConflictCount = 0; });
    bar.appendChild(text);
    bar.appendChild(btn);
    document.body.appendChild(bar);
}

// ── Checked writes ──
// Returns { failed, conflicts, error, pendingChanged }. Rows that fail stay
// pending (retried on the next save); the caller saves the pending list.
async function _checkedWriteRows(client, uid, dk, rows) {
    var table = _cloudTable(dk), pk = _cloudPk(dk);
    var revs = _rowRev[dk] || (_rowRev[dk] = {});
    var base = _rowBaseline[dk] || {};
    var out = { failed: 0, conflicts: 0, error: null, pendingChanged: false };
    var inserts = [], known = [];
    rows.forEach(function (r) {
        var k = _rowKey(dk, r);
        if (revs[k] == null && base[k] === undefined) inserts.push(r); else known.push(r);
    });
    function done(row, ok, err) {
        if (_markRows(dk, [row], ok)) out.pendingChanged = true;
        if (!ok) { out.failed++; out.error = err || out.error; }
    }

    // New rows: one insert per key set. A duplicate key (another device made
    // the same row) sends that group through the per-row check instead.
    var groups = _groupRowsByKeySet(inserts);
    for (var gi = 0; gi < groups.length; gi++) {
        var g = groups[gi];
        var res = await _cloudCall(function () { return client.from(table).insert(g).select(pk.concat('rev').join(',')); });
        if (!res.error) {
            (res.data || []).forEach(function (r) { if (r.rev != null) revs[_rowKey(dk, r)] = Number(r.rev); });
            g.forEach(function (r) { done(r, true); });
        } else if (_isDuplicateKey(res.error)) {
            known = known.concat(g);
        } else {
            console.warn('[Denarii] Cloud insert failed (' + table + '):', res.error.message || res.error);
            g.forEach(function (r) { done(r, false, res.error.message); });
        }
    }

    for (var i = 0; i < known.length; i++) {
        var st = await _checkedWriteOne(client, uid, dk, known[i]);
        if (st === 'ok') done(known[i], true);
        else if (st === 'conflict') out.conflicts++;
        else done(known[i], false, 'Cloud save failed');
    }
    _saveRevs();
    return out;
}

// 'ok' | 'conflict' | 'error'
async function _checkedWriteOne(client, uid, dk, row) {
    var table = _cloudTable(dk), pk = _cloudPk(dk);
    var key = _rowKey(dk, row);
    var revs = _rowRev[dk] || (_rowRev[dk] = {});
    var baseRev = revs[key];
    if (baseRev != null) {
        var res = await _cloudCall(function () {
            return _cloudFilterPk(client.from(table).update(_withoutPk(dk, row)).eq('user_id', uid), dk, row)
                .eq('rev', baseRev).select('rev');
        });
        if (res.error) { console.warn('[Denarii] Cloud update failed (' + table + '):', res.error.message || res.error); return 'error'; }
        if (res.data && res.data.length) { revs[key] = Number(res.data[0].rev); return 'ok'; }
    }
    return _resolveCloudRow(client, uid, dk, row);
}

function _withoutPk(dk, row) {
    var pk = _cloudPk(dk), out = {};
    for (var c in row) if (c !== 'user_id' && pk.indexOf(c) === -1) out[c] = row[c];
    return out;
}

// The rev did not match, no rev is known, or the insert hit an existing row:
// look at the cloud row and decide.
async function _resolveCloudRow(client, uid, dk, row) {
    var table = _cloudTable(dk);
    var key = _rowKey(dk, row);
    var revs = _rowRev[dk] || (_rowRev[dk] = {});
    var fetched = await _cloudCall(function () {
        return _cloudFilterPk(client.from(table).select('*').eq('user_id', uid), dk, row).limit(1);
    });
    if (fetched.error) return 'error';
    var cloudRow = (fetched.data || [])[0] || null;

    if (!cloudRow) {
        // Not in the cloud (never sent, or deleted on another device after
        // this browser's edit): the edited record is kept.
        var ins = await _cloudCall(function () { return client.from(table).insert([row]).select('rev'); });
        if (ins.error) return 'error';
        if (ins.data && ins.data[0] && ins.data[0].rev != null) revs[key] = Number(ins.data[0].rev);
        else delete revs[key];
        return 'ok';
    }

    var cloudSig = _cloudRowSig(dk, cloudRow, uid);
    if (cloudSig === _rowSig(dk, row)) {
        if (cloudRow.rev != null) revs[key] = Number(cloudRow.rev);
        return 'ok';
    }
    var base = (_rowBaseline[dk] || {})[key];
    if (base !== undefined && cloudSig === base) {
        // The cloud still holds what this browser last saw: write over it.
        var q = _cloudFilterPk(client.from(table).update(_withoutPk(dk, row)).eq('user_id', uid), dk, row);
        if (cloudRow.rev != null) q = q.eq('rev', cloudRow.rev);
        var up = await _cloudCall(function () { return q.select('rev'); });
        if (up.error || !up.data || !up.data.length) return 'error';
        if (up.data[0].rev != null) revs[key] = Number(up.data[0].rev);
        return 'ok';
    }
    // Changed on another device since this browser last saw it.
    _applyCloudWin(dk, key, cloudRow, uid, 'changed on another device', true);
    return 'conflict';
}

// ── Single-record entry points (used by the _save*/_delete* helpers) ──
async function _cloudSaveRow(dk, item) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return { success: false, error: 'Cloud save not available' };
    var row = _mapArrayRow(ctx.userId, dk, item);
    if (!row) return { success: false, error: 'Mapping failed' };
    return _cloudSaveRows(ctx, dk, [row]);
}

async function _cloudSaveRows(ctx, dk, rows) {
    try {
        if (!_cloudWriteAllowed()) {
            var changedRows = _changedRows(dk, rows);
            if (changedRows.length && _markRows(dk, changedRows, false)) _savePendingRows();
            return { success: false, error: 'Cloud writes paused; saved in this browser', queued: true };
        }
        var uid = await _cloudSessionUid();
        if (!uid) {
            if (_markRows(dk, rows, false)) _savePendingRows();
            return { success: false, error: 'Cloud session is not this account', queued: true };
        }
        var send = _changedRows(dk, rows);
        if (!send.length) return { success: true, error: null };
        var r = await _checkedWriteRows(ctx.client, uid, dk, send);
        if (r.pendingChanged) _savePendingRows();
        if (r.failed) return { success: false, error: r.error || 'Cloud save failed', queued: true };
        return { success: true, error: null, conflicts: r.conflicts };
    } catch (err) {
        console.error('[CloudSave] Checked save exception:', err.message || err);
        return { success: false, error: err.message || String(err) };
    }
}

// Explicit user delete. Offline / paused / failed: queued and pushed later.
async function _cloudDeleteRow(dk, id) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return { success: false, error: 'Cloud save not available' };
    var key = String(id);
    try {
        (_cloudDeletes[dk] || (_cloudDeletes[dk] = {}))[key] = true;
        if (_cloudPending[dk] && _cloudPending[dk][key]) {
            delete _cloudPending[dk][key];
            if (!Object.keys(_cloudPending[dk]).length) delete _cloudPending[dk];
            _savePendingRows();
        }
        _saveCloudDeletes();
        if (!_cloudWriteAllowed()) return { success: true, error: null, queued: true };
        var uid = await _cloudSessionUid();
        if (!uid) return { success: true, error: null, queued: true };
        var pushed = await _pushCloudDeletes(ctx.client, uid, dk, key);
        var queued = !!(_cloudDeletes[dk] && _cloudDeletes[dk][key]);
        return { success: true, error: null, queued: queued, kept: pushed.kept > 0 };
    } catch (err) {
        console.error('[CloudSave] Delete exception:', err.message || err);
        return { success: true, error: null, queued: true };
    }
}

// Pushes queued deletes (all, or one when onlyDk/onlyKey are given).
async function _pushCloudDeletes(client, uid, onlyDk, onlyKey) {
    var changed = false, kept = 0;
    var dks = onlyDk ? [onlyDk] : Object.keys(_cloudDeletes);
    for (var i = 0; i < dks.length; i++) {
        var dk = dks[i];
        var keys = onlyDk ? [onlyKey] : Object.keys(_cloudDeletes[dk] || {});
        for (var j = 0; j < keys.length; j++) {
            var st = await _deleteCloudRowNow(client, uid, dk, keys[j]);
            if (st === 'error') continue;
            if (st === 'kept') kept++;
            if (_cloudDeletes[dk]) delete _cloudDeletes[dk][keys[j]];
            changed = true;
        }
        if (_cloudDeletes[dk] && !Object.keys(_cloudDeletes[dk]).length) delete _cloudDeletes[dk];
    }
    if (changed) { _saveCloudDeletes(); _saveRevs(); }
    return { kept: kept };
}

// 'ok' (deleted or already gone) | 'kept' (edited elsewhere) | 'error'
async function _deleteCloudRowNow(client, uid, dk, key) {
    var table = _cloudTable(dk);
    if (!table) return 'ok';
    var vals = _cloudPkValues(dk, key);
    var fetched = await _cloudCall(function () {
        return _cloudFilterPk(client.from(table).select('*').eq('user_id', uid), dk, vals).limit(1);
    });
    if (fetched.error) return 'error';
    var cloudRow = (fetched.data || [])[0] || null;
    if (!cloudRow) { _forgetCloudRow(dk, key); return 'ok'; }

    var baseRev = _rowRev[dk] && _rowRev[dk][key];
    var baseSig = _rowBaseline[dk] && _rowBaseline[dk][key];
    var edited = baseRev != null
        ? (cloudRow.rev != null && Number(cloudRow.rev) !== Number(baseRev))
        : (baseSig !== undefined && _cloudRowSig(dk, cloudRow, uid) !== baseSig);
    if (edited) {
        // Edited on another device after this browser deleted it: keep it.
        _applyCloudWin(dk, key, cloudRow, uid, 'deleted here, edited on another device', false);
        return 'kept';
    }
    var q = _cloudFilterPk(client.from(table).delete().eq('user_id', uid), dk, vals);
    if (cloudRow.rev != null) q = q.eq('rev', cloudRow.rev);
    var del = await _cloudCall(function () { return q.select('rev'); });
    if (del.error || !del.data || !del.data.length) return 'error';
    _forgetCloudRow(dk, key);
    console.log('[CloudSave] Deleted', table, key);
    return 'ok';
}

// ── Strategy rename ──
// Trades link to a strategy by name (setup_type), so a rename moves them with
// one UPDATE: it applies fully or not at all, and touches only that column.
// Trades have no pending list and the cloud wins on load, so a cloud account
// must be online to rename. The device setting strategyRename:<acct> covers
// the gap between the trades and the strategy row (closed tab, lost response):
// the next cloud load finishes or reverses the rename.
function _strategyRenameMarkerKey() {
    return 'strategyRename:' + currentAccountId;
}

async function _clearStrategyRenameMarker() {
    await setSetting(_strategyRenameMarkerKey(), null);
}

async function _cloudCountTradesBySetup(name) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return { count: null, error: 'Cloud save not available' };
    var res = await _cloudCall(function () {
        return ctx.client.from('trades').select('id', { count: 'exact', head: true })
            .eq('user_id', ctx.userId).eq('setup_type', name);
    });
    if (res.error) return { count: null, error: res.error.message || String(res.error) };
    if (typeof res.count !== 'number') return { count: null, error: 'No count returned' };
    return { count: res.count, error: null };
}

async function _cloudRenameTrades(oldName, newName) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return { success: false, count: 0, error: 'Cloud save not available' };
    var res = await _cloudCall(function () {
        return ctx.client.from('trades').update({ setup_type: newName }, { count: 'exact' })
            .eq('user_id', ctx.userId).eq('setup_type', oldName);
    });
    if (res.error) {
        console.error('[CloudSave] Strategy rename of trades failed:', res.error.message || res.error);
        return { success: false, count: 0, error: res.error.message || String(res.error) };
    }
    return { success: true, count: res.count || 0, error: null };
}

// 'ok' | 'changed' (edited on another device) | 'error'. Same check as a delete.
async function _cloudStrategyUnchanged(strategy) {
    var ctx = _getCloudSaveContext();
    if (!ctx) return 'error';
    var key = String(strategy.id);
    var fetched = await _cloudCall(function () {
        return ctx.client.from('strategies').select('*').eq('user_id', ctx.userId).eq('id', key).limit(1);
    });
    if (fetched.error) return 'error';
    var cloudRow = (fetched.data || [])[0] || null;
    if (!cloudRow) return 'ok';
    var baseRev = _rowRev.strategies && _rowRev.strategies[key];
    var baseSig = _rowBaseline.strategies && _rowBaseline.strategies[key];
    var edited = baseRev != null
        ? (cloudRow.rev != null && Number(cloudRow.rev) !== Number(baseRev))
        : (baseSig !== undefined && _cloudRowSig('strategies', cloudRow, ctx.userId) !== baseSig);
    return edited ? 'changed' : 'ok';
}

// Everything that must hold before a rename starts. Writes nothing.
async function _cloudRenamePreflight(strategy, newName) {
    var needCloud = { ok: false, message: 'Renaming a strategy needs a connection to your cloud data. Nothing was changed.' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return needCloud;
    if (!_cloudWriteAllowed() || !_getCloudSaveContext()) return needCloud;
    if (!(await _cloudSessionUid())) return needCloud;

    var state = await _cloudStrategyUnchanged(strategy);
    if (state === 'error') return needCloud;
    if (state === 'changed') {
        return { ok: false, message: 'This strategy was changed on another device. Nothing was changed here. Reload the page and try again.' };
    }
    var taken = await _cloudCountTradesBySetup(newName);
    if (taken.error) return needCloud;
    if (taken.count > 0) {
        return { ok: false, message: 'Some trades in your cloud data already use this name. Please choose a unique name.' };
    }
    var moving = await _cloudCountTradesBySetup(strategy.name);
    if (moving.error) return needCloud;
    return { ok: true, count: moving.count };
}

// Sets the marker, then moves the trades. An error may be a lost response, so
// the new name is counted: the preflight proved none had it before.
async function _cloudMoveStrategyTrades(strategyId, oldName, newName) {
    try {
        await setSetting(_strategyRenameMarkerKey(), { strategyId: String(strategyId), oldName: oldName, newName: newName, phase: 'forward' });
    } catch (e) {
        return { ok: false, message: 'Couldn\'t rename this strategy. Nothing was changed.' };
    }
    var res = await _cloudRenameTrades(oldName, newName);
    if (res.success) return { ok: true, count: res.count };
    var check = await _cloudCountTradesBySetup(newName);
    if (check.error) {
        return { ok: false, message: 'Couldn\'t confirm the rename with your cloud data. It will be checked at your next sign-in.' };
    }
    if (check.count > 0) return { ok: true, count: check.count };
    await _clearStrategyRenameMarker();
    return { ok: false, message: 'Couldn\'t rename this strategy. Nothing was changed.' };
}

// Returns true when the cloud is back to the old name. If not, the marker
// asks the next cloud load to finish the reversal.
async function _cloudReverseStrategyRename(strategyId, oldName, newName) {
    await setSetting(_strategyRenameMarkerKey(), { strategyId: String(strategyId), oldName: oldName, newName: newName, phase: 'rollback' });
    var res = await _cloudRenameTrades(newName, oldName);
    if (!res.success) return false;
    await _clearStrategyRenameMarker();
    return true;
}

// Local trades and saved report filters. Report text stays as written.
function _applyStrategyNameToLocal(oldName, newName) {
    var changes = { trades: [], reports: [] };
    (journalData.trades || []).forEach(function (t) {
        if (t.setupType === oldName) { t.setupType = newName; changes.trades.push(t); }
    });
    (journalData.aiOutputHistory || []).forEach(function (r) {
        if (r.filters && r.filters.strategyFilter === oldName) {
            r.filters = Object.assign({}, r.filters, { strategyFilter: newName });
            changes.reports.push(r);
        }
    });
    return changes;
}

function _revertStrategyNameOnLocal(changes, oldName) {
    changes.trades.forEach(function (t) { t.setupType = oldName; });
    changes.reports.forEach(function (r) {
        r.filters = Object.assign({}, r.filters, { strategyFilter: oldName });
    });
}

// Best effort: a report that fails is queued and never undoes the rename.
async function _saveRenamedReports(reports) {
    for (var i = 0; i < reports.length; i++) {
        try { await _saveAiReportToSupabase(reports[i]); }
        catch (e) { console.warn('[Denarii] Saved report update failed:', e.message || e); }
    }
}

// Called on a cloud load, before the app's strategy backfill runs. A failed
// step keeps the marker, so the next load tries again.
async function _resumeStrategyRename() {
    var m = await getSetting(_strategyRenameMarkerKey());
    if (!m || typeof m.oldName !== 'string' || typeof m.newName !== 'string') return;

    if (m.phase === 'rollback') {
        var back = await _cloudRenameTrades(m.newName, m.oldName);
        if (!back.success) return;
        _applyStrategyNameToLocal(m.newName, m.oldName);
    } else {
        var strat = (journalData.strategies || []).find(function (s) { return String(s.id) === String(m.strategyId); });
        var oldCount = await _cloudCountTradesBySetup(m.oldName);
        var newCount = await _cloudCountTradesBySetup(m.newName);
        if (oldCount.error || newCount.error) return;
        // Neither the trades nor the strategy moved: nothing to finish.
        if (!(strat && strat.name === m.newName) && newCount.count === 0) {
            await _clearStrategyRenameMarker();
            return;
        }
        if (oldCount.count > 0) {
            var forward = await _cloudRenameTrades(m.oldName, m.newName);
            if (!forward.success) return;
        }
        var changes = _applyStrategyNameToLocal(m.oldName, m.newName);
        if (strat) {
            if (strat.name !== m.newName) { strat.name = m.newName; strat.updated = new Date().toISOString(); }
            var saved = await _saveStrategyToSupabase(strat);
            if (saved.conflicts || (!saved.success && !saved.queued)) return;
        }
        await _saveRenamedReports(changes.reports);
    }
    await saveJournalRecord(currentAccountId, { encrypted: true, data: encrypt(journalData, sessionDek || sessionPassword), lastSaved: new Date().toISOString() });
    await _clearStrategyRenameMarker();
}

// ── Strategy delete ──
// Same pattern as the rename: one UPDATE clears the trades, and the device
// setting strategyDelete:<acct> covers the gap to the strategy row. Cleared
// trades can't be told apart from other No Strategy trades, so nothing can
// reverse the UPDATE and every check runs before it.
function _strategyDeleteMarkerKey() {
    return 'strategyDelete:' + currentAccountId;
}

async function _clearStrategyDeleteMarker() {
    await setSetting(_strategyDeleteMarkerKey(), null);
}

// Everything that must hold before a delete starts. Writes nothing.
async function _cloudDeletePreflight(strategy) {
    var needCloud = { ok: false, message: 'Deleting a strategy needs a connection to your cloud data. Nothing was changed.' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return needCloud;
    if (!_cloudWriteAllowed() || !_getCloudSaveContext()) return needCloud;
    if (!(await _cloudSessionUid())) return needCloud;

    var state = await _cloudStrategyUnchanged(strategy);
    if (state === 'error') return needCloud;
    if (state === 'changed') {
        return { ok: false, message: 'This strategy was changed on another device. Nothing was changed here. Reload the page and try again.' };
    }
    var moving = await _cloudCountTradesBySetup(strategy.name);
    if (moving.error) return needCloud;
    return { ok: true, count: moving.count };
}

// Sets the marker, then clears the trades. An error may be a lost response, so
// the name is counted: the UPDATE applies fully or not at all.
async function _cloudClearStrategyTrades(strategyId, name, count) {
    try {
        await setSetting(_strategyDeleteMarkerKey(), { strategyId: String(strategyId), name: name });
    } catch (e) {
        return { ok: false, message: 'Couldn\'t delete this strategy. Nothing was changed.' };
    }
    if (!count) return { ok: true };
    var res = await _cloudRenameTrades(name, null);
    if (res.success) return { ok: true };
    var check = await _cloudCountTradesBySetup(name);
    if (check.error) {
        return { ok: false, message: 'Couldn\'t confirm the delete with your cloud data. It will be checked at your next sign-in.' };
    }
    if (check.count === 0) return { ok: true };
    await _clearStrategyDeleteMarker();
    return { ok: false, message: 'Couldn\'t delete this strategy. Nothing was changed.' };
}

function _applyStrategyDeleteToLocal(strategyId, name) {
    var changes = { trades: [], strategies: journalData.strategies };
    (journalData.trades || []).forEach(function (t) {
        if (t.setupType === name) { t.setupType = ''; changes.trades.push(t); }
    });
    journalData.strategies = (journalData.strategies || []).filter(function (s) { return String(s.id) !== String(strategyId); });
    changes.noted = _noteDeletedStrategyName(name);
    return changes;
}

function _revertStrategyDeleteOnLocal(changes, name) {
    changes.trades.forEach(function (t) { t.setupType = name; });
    journalData.strategies = changes.strategies;
    if (changes.noted) _clearDeletedStrategyName(name);
}

// Called on a cloud load, before the app's strategy backfill runs. Trades still
// on the name mean the UPDATE never ran: the delete did not happen. None left
// means it did, so the delete is finished. A failed step keeps the marker.
async function _resumeStrategyDelete() {
    var m = await getSetting(_strategyDeleteMarkerKey());
    if (!m || typeof m.name !== 'string') return;
    var left = await _cloudCountTradesBySetup(m.name);
    if (left.error) return;
    if (left.count > 0) {
        await _clearStrategyDeleteMarker();
        return;
    }
    _applyStrategyDeleteToLocal(m.strategyId, m.name);
    var res = await _deleteStrategyFromSupabase(m.strategyId);
    if (res.kept) _clearDeletedStrategyName(m.name);
    await _saveDeletedStrategyKeysToSupabase();
    await saveJournalRecord(currentAccountId, { encrypted: true, data: encrypt(journalData, sessionDek || sessionPassword), lastSaved: new Date().toISOString() });
    if (res.success) await _clearStrategyDeleteMarker();
}

// ── Re-sync during a session ──
// On the browser's "online" event and when the tab becomes visible after
// 5 minutes or more. Same rules as the sign-in load: cloud wins, rows with
// unsent changes (pending) and queued deletes win, local-only records are
// hidden with a kept snapshot. A paused session that loads successfully is
// resumed. Any failure changes nothing.
async function _cloudResync(reason) {
    if (window._denariiStorageMode !== 'cloud_primary' || !currentAccountId || !(sessionDek || sessionPassword)) return { ok: false, reason: 'not signed in' };
    if (!_cloudBaselineReady && !_cloudPaused) return { ok: false, reason: 'not unlocked' };
    if (_cloudResyncRunning || window._denariiMigrationRunning || window._denariiStrategyRenameRunning) return { ok: false, reason: 'busy' };
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return { ok: false, reason: 'offline' };
    _cloudResyncRunning = true;
    try {
        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) return { ok: false, reason: 'cloud unavailable' };
        var client = SupabaseAuth.getClient();
        var session = await _withTimeout(SupabaseAuth.supabaseGetSession(), _CLOUD_LOAD_TIMEOUT_MS, 'Session check');
        var uid = session && session.data && session.data.user ? session.data.user.id : null;
        if (!client || !uid || !_sessionMatchesAccount(uid)) return { ok: false, reason: 'no cloud session for this account' };
        var revs = {};
        var cloud = await _withTimeout(_loadJournalFromSupabaseRows(client, uid, { strict: true, revs: revs }), _CLOUD_LOAD_TIMEOUT_MS, 'Cloud load');

        // Changes not sent yet (debounced or failed) win like pending rows.
        if (_cloudBaselineReady) _recordPendingRows(journalData);
        var merged = _mergeCloudIntoLocal(journalData, cloud, _cloudPending, _cloudDeletes);
        if (!merged.jd.brokerAccounts) merged.jd.brokerAccounts = [];
        if (merged.changed) {
            if (merged.hidden > 0) await _keepCloudLoadSnapshot(currentAccountId);
            await saveJournalRecord(currentAccountId, { encrypted: true, data: encrypt(merged.jd, sessionDek || sessionPassword), lastSaved: new Date().toISOString() });
        }
        var editorHits = _editorGuardsBeforeResync(journalData, merged.jd, revs);   // Batch 2
        journalData = merged.jd;
        _adoptRevs(revs);
        _setCloudBaseline(journalData, true, cloud);
        _editorGuardsApply(editorHits);
        _lastCloudResyncMs = Date.now();
        _cloudLoadStatus = { ok: true, hidden: merged.hidden, hiddenKeys: merged.hiddenKeys, reason: null };
        _pruneCloudLoadSnapshots(currentAccountId, cloud);
        var oldBanner = typeof document !== 'undefined' && document.getElementById('cloud-load-banner');
        if (oldBanner) oldBanner.remove();
        console.log('[CloudLoad] Re-sync (' + reason + ') complete. Changed:', merged.changed, '| hidden:', merged.hidden);

        await _shadowWriteRowsAwaited(journalData);
        if (merged.demoTrades.length) _saveDemoTradesAndRefresh(merged.demoTrades);
        _triggerCloudDashRefresh();
        if (typeof window._denariiRefreshUI === 'function') window._denariiRefreshUI();
        if (merged.hidden > 0) _showCloudLoadBanner();
        return { ok: true, changed: merged.changed, hidden: merged.hidden };
    } catch (e) {
        console.warn('[CloudLoad] Re-sync (' + reason + ') failed; nothing changed:', e.message || e);
        return { ok: false, reason: e.message || String(e) };
    } finally {
        _cloudResyncRunning = false;
    }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function' && typeof document !== 'undefined') {
    window.addEventListener('online', function () { _cloudResync('online'); });
    document.addEventListener('visibilitychange', function () {
        if (document.visibilityState === 'visible' && Date.now() - _lastCloudResyncMs >= _CLOUD_RESYNC_IDLE_MS) {
            _cloudResync('visible');
        }
    });
}

// ── Phase 2A: Blocking cloud migration runner ─────────────────────
// Called from unlockApp() BEFORE UI rendering for migration_pending accounts.
// Writes all journalData domains to Supabase, verifies, then promotes to
// cloud_primary. On failure, leaves storageMode unchanged and the app
// continues with IndexedDB-primary behavior.

async function _runCloudMigration(auth, jd, onStatus) {
    // Status callback helper — safe to call even without a callback
    function _s(msg, pct) {
        console.log('[Migration]', msg);
        if (typeof onStatus === 'function') onStatus(msg, pct);
    }

    // ── Preconditions ────────────────────────────────────────────
    if (!auth || auth.storageMode !== 'migration_pending') return false;
    if (!auth.supabaseUid) { console.warn('[Migration] No supabaseUid — skipping.'); return false; }
    if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) {
        console.warn('[Migration] Supabase not ready — skipping. Will retry next login.');
        return false;
    }
    var client = SupabaseAuth.getClient();
    if (!client) { console.warn('[Migration] No Supabase client — skipping.'); return false; }
    var session = await SupabaseAuth.supabaseGetSession();
    if (!session.data || !session.data.user) {
        console.warn('[Migration] No active Supabase session — skipping.');
        return false;
    }
    var userId = session.data.user.id;

    _s('Starting cloud migration for user: ' + auth.username, 5);

    try {
        // ── Step 1: Write all domains to Supabase row tables ─────
        // Reuses _executeShadowWrite which upserts with onConflict (idempotent).
        _s('Preparing account data', 10);
        var allDomains = Object.keys(_SHADOW_DOMAINS);
        var snapshot = {};
        for (var i = 0; i < allDomains.length; i++) {
            var dk = allDomains[i];
            if (jd[dk] !== undefined && jd[dk] !== null) {
                snapshot[dk] = JSON.parse(JSON.stringify(jd[dk]));
            }
        }
        var dirtyDomains = Object.keys(snapshot);

        if (dirtyDomains.length > 0) {
            // Report domain-level progress
            var _domainLabels = {
                trades: 'Syncing trades', strategies: 'Syncing strategies',
                brokerAccounts: 'Syncing broker accounts', tags: 'Syncing tags',
                noteTemplates: 'Syncing note templates', reviews: 'Syncing reviews',
                dailyPlanners: 'Syncing daily planners', weeklyPlanners: 'Syncing weekly planners'
            };
            for (var d = 0; d < dirtyDomains.length; d++) {
                var dLabel = _domainLabels[dirtyDomains[d]] || ('Syncing ' + dirtyDomains[d]);
                var dPct = 15 + Math.round((d / dirtyDomains.length) * 45);
                _s(dLabel, dPct);
            }
            console.log('[Migration] Writing', dirtyDomains.length, 'domains:', dirtyDomains.join(', '));
            await _executeShadowWrite(client, snapshot, dirtyDomains);
            _s('Data sync complete', 60);
        } else {
            _s('No domain data to write', 60);
        }

        // ── Step 2: Verify row counts per domain ─────────────────
        _s('Verifying cloud data', 65);
        var verifyPassed = true;

        for (var v = 0; v < allDomains.length; v++) {
            var vdk = allDomains[v];
            var cfg = _SHADOW_DOMAINS[vdk];
            if (!cfg) continue;

            // Determine expected local count
            var localData = jd[vdk];
            var expectedCount = 0;
            if (Array.isArray(localData)) {
                expectedCount = localData.length;
            } else if (localData && typeof localData === 'object') {
                expectedCount = Object.keys(localData).length;
            }
            if (expectedCount === 0) continue; // no data to verify

            var countRes = await client
                .from(cfg.table)
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId);

            if (countRes.error) {
                console.warn('[Migration] Verify count failed (' + cfg.table + '):', countRes.error.message);
                verifyPassed = false;
                break;
            }

            var remoteCount = countRes.count || 0;
            if (remoteCount < expectedCount) {
                console.warn('[Migration] Verify mismatch: ' + cfg.table + ' local=' + expectedCount + ' remote=' + remoteCount);
                verifyPassed = false;
                break;
            }
            console.log('[Migration] Verified: ' + cfg.table + ' (' + remoteCount + ' remote >= ' + expectedCount + ' local)');
        }

        if (!verifyPassed) {
            _s('Verification failed. Will retry next login.', 0);
            return false;
        }

        // ── Step 3: Spot-check trades ────────────────────────────
        if (Array.isArray(jd.trades) && jd.trades.length > 0) {
            _s('Verifying trade integrity', 80);
            var spotOk = await _spotCheckTrades(client, userId, jd.trades);
            if (!spotOk) {
                _s('Trade verification failed. Will retry next login.', 0);
                return false;
            }
        }

        // ── Step 4: Verify user_profiles exists ──────────────────
        _s('Verifying account profile', 85);
        var profileRes = await client.from('user_profiles').select('user_id').eq('user_id', userId).single();
        if (profileRes.error || !profileRes.data) {
            console.warn('[Migration] user_profiles not found for uid:', userId);
            verifyPassed = false;
        }

        // ── Step 5: Verify journal_backups exists ────────────────
        var backupRes = await client.from('journal_backups').select('user_id').eq('user_id', userId).single();
        if (backupRes.error || !backupRes.data) {
            console.warn('[Migration] journal_backups not found for uid:', userId);
            verifyPassed = false;
        }

        if (!verifyPassed) {
            _s('Profile verification failed. Will retry next login.', 0);
            return false;
        }

        // ── Step 6: Promote to cloud_primary ─────────────────────
        _s('Finalizing upgrade', 90);
        auth.storageMode = 'cloud_primary';
        auth.cloudPrimaryAt = new Date().toISOString();
        await saveAuthRecord(auth); // writes to IndexedDB + awaits _upsertAuthProfile to Supabase

        // ── Step 7: Verify promotion landed in Supabase ─────────
        // PostgREST upsert can return 200 without actually updating the row
        // (e.g., RLS policy mismatch). Read back and patch if needed.
        var _promoCheck = await client.from('user_profiles')
            .select('auth_record')
            .eq('user_id', userId)
            .single();
        var _cloudMode = (_promoCheck.data && _promoCheck.data.auth_record)
            ? _promoCheck.data.auth_record.storageMode
            : null;

        if (_cloudMode !== 'cloud_primary') {
            console.warn('[Migration] Promotion read-back mismatch (got: ' + _cloudMode + '). Patching via direct update...');
            // Read the full auth record we just saved to IndexedDB
            var _freshAuth = await getAuthRecord();
            var _patchRes = await client.from('user_profiles')
                .update({ auth_record: _freshAuth, updated_at: new Date().toISOString() })
                .eq('user_id', userId);
            if (_patchRes.error) {
                console.error('[Migration] Direct update also failed:', _patchRes.error.message);
            } else {
                // Verify the patch
                var _patchCheck = await client.from('user_profiles')
                    .select('auth_record')
                    .eq('user_id', userId)
                    .single();
                var _patchMode = (_patchCheck.data && _patchCheck.data.auth_record)
                    ? _patchCheck.data.auth_record.storageMode
                    : null;
                if (_patchMode === 'cloud_primary') {
                    console.log('[Migration] Direct update succeeded — cloud_primary confirmed in user_profiles.');
                } else {
                    console.error('[Migration] Direct update did not persist. Cloud profile may be stale. (got: ' + _patchMode + ')');
                }
            }
        } else {
            console.log('[Migration] Promotion verified in Supabase user_profiles.');
        }

        _s('Promoted to cloud_primary at ' + auth.cloudPrimaryAt, 100);

        return true;
    } catch (e) {
        console.error('[Migration] Cloud migration failed:', e.message || e);
        console.warn('[Migration] Staying migration_pending. Local data is intact.');
        return false;
    }
}

// ── Phase 3: Resumable backfill ─────────────────────────────────
// Runs once after unlockApp() + UI render. Migrates historical local
// journalData rows into Supabase row tables in the background.
// Never blocks the UI, never affects local saves.

// Backfill order (small tables first, trades chunked)
var _BACKFILL_ORDER = ['strategies', 'brokerAccounts', 'tags', 'trades', 'reviews', 'noteTemplates', 'dailyPlanners', 'weeklyPlanners'];

// Demo data identification helpers
var _DEMO_BROKER_ID = (typeof DEMO_BROKER_ID !== 'undefined') ? DEMO_BROKER_ID : 'ba_demo_pelosi';

function _isDemoItem(domainKey, item) {
    switch (domainKey) {
        case 'strategies':
            return !!(item.isDemoSeed || item.createdBy === 'System');
        case 'brokerAccounts':
            return !!(item.isDemo || item.id === _DEMO_BROKER_ID);
        case 'trades':
            return item.brokerAccountId === _DEMO_BROKER_ID;
        case 'tags':
            return !!(item.isDemoSeed);
        case 'noteTemplates':
            return item.sourceType === 'system';
        default:
            return false;
    }
}

function _isDemoReviewKey(key) {
    // Reviews keyed as "type|key"; demo reviews have _isDemo: true on the data
    return false; // checked via data._isDemo instead
}

// Create a fresh progress record
function _newBackfillProgress() {
    return {
        version: _BACKFILL_VERSION,
        started_at: null,
        completed_at: null,
        verified_at: null,
        last_attempt_at: null,
        attempt_count: 0,
        last_error: null,
        last_error_table: null,
        last_error_at: null,
        tables: {},
        trades_cursor: 0,        // index into sorted trades array for resume
        demo_rows_included: {}   // per-domain demo row counts for transparency
    };
}

// Initialize per-table status in progress record
function _ensureTableStatus(progress, domainKey) {
    if (!progress.tables[domainKey]) {
        progress.tables[domainKey] = {
            status: 'pending',   // pending | complete | error
            local_count: 0,
            upserted_count: 0,
            demo_count: 0,
            completed_at: null
        };
    }
    return progress.tables[domainKey];
}

async function _loadBackfillProgress() {
    try {
        var stored = await getSetting(_BACKFILL_SETTINGS_KEY);
        if (stored && stored.version === _BACKFILL_VERSION) return stored;
    } catch (e) {
        console.warn('[Denarii] Backfill progress load error:', e.message || e);
    }
    return _newBackfillProgress();
}

async function _saveBackfillProgress(progress) {
    try {
        await setSetting(_BACKFILL_SETTINGS_KEY, progress);
    } catch (e) {
        console.warn('[Denarii] Backfill progress save error:', e.message || e);
    }
}

// Entry point — called from unlockApp() via setTimeout
async function _startBackfillIfNeeded(jd) {
    try {
        // Guard: only one backfill per session
        if (_backfillRunning) return;

        // Preconditions
        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) return;
        var client = SupabaseAuth.getClient();
        if (!client) return;
        var session = await SupabaseAuth.supabaseGetSession();
        if (!session.data || !session.data.user) return;
        var userId = session.data.user.id;

        // Load progress
        var progress = await _loadBackfillProgress();

        // Already completed and verified for this version?
        if (progress.verified_at && progress.version === _BACKFILL_VERSION) {
            return;
        }

        _backfillRunning = true;
        progress.last_attempt_at = new Date().toISOString();
        progress.attempt_count = (progress.attempt_count || 0) + 1;
        if (!progress.started_at) progress.started_at = progress.last_attempt_at;
        await _saveBackfillProgress(progress);

        console.log('[Denarii] Phase 3 backfill starting (attempt ' + progress.attempt_count + ')...');

        var allComplete = true;

        for (var i = 0; i < _BACKFILL_ORDER.length; i++) {
            var dk = _BACKFILL_ORDER[i];
            var tableStatus = _ensureTableStatus(progress, dk);

            // Skip already completed tables
            if (tableStatus.status === 'complete') continue;

            var ok = false;
            try {
                if (dk === 'trades') {
                    ok = await _backfillTrades(client, userId, jd, progress);
                } else if (dk === 'reviews' || dk === 'dailyPlanners' || dk === 'weeklyPlanners') {
                    ok = await _backfillKeyedObject(client, userId, jd, dk, progress);
                } else {
                    ok = await _backfillSmallTable(client, userId, jd, dk, progress);
                }
            } catch (err) {
                progress.last_error = err.message || String(err);
                progress.last_error_table = dk;
                progress.last_error_at = new Date().toISOString();
                console.warn('[Denarii] Backfill error (' + dk + '):', progress.last_error);
                await _saveBackfillProgress(progress);
                allComplete = false;
                break; // stop on first error, resume next session
            }

            if (!ok) {
                allComplete = false;
                break;
            }
        }

        if (allComplete) {
            // Backfill user_meta flags
            try {
                var metaRows = _mapUserMetaRows(userId, jd);
                if (metaRows.length > 0) {
                    var metaRes = await client.from('user_meta').upsert(metaRows, { onConflict: 'user_id,key' });
                    if (metaRes.error) console.warn('[Denarii] Backfill user_meta failed:', metaRes.error.message);
                }
            } catch (metaErr) {
                console.warn('[Denarii] Backfill user_meta error:', metaErr.message || metaErr);
            }

            progress.completed_at = new Date().toISOString();
            await _saveBackfillProgress(progress);
            console.log('[Denarii] Phase 3 backfill complete. Running verification...');

            // Run verification
            await _verifyBackfill(client, userId, jd, progress);
            await _saveBackfillProgress(progress);
        }
    } catch (e) {
        console.warn('[Denarii] Backfill orchestration error:', e.message || e);
    } finally {
        _backfillRunning = false;
    }
}

// Backfill a small table (strategies, brokerAccounts, tags, noteTemplates)
async function _backfillSmallTable(client, userId, jd, domainKey, progress) {
    var cfg = _SHADOW_DOMAINS[domainKey];
    if (!cfg) return true;
    var tableStatus = _ensureTableStatus(progress, domainKey);

    var arr = Array.isArray(jd[domainKey]) ? jd[domainKey] : [];
    if (arr.length === 0) {
        tableStatus.status = 'complete';
        tableStatus.local_count = 0;
        tableStatus.upserted_count = 0;
        tableStatus.completed_at = new Date().toISOString();
        await _saveBackfillProgress(progress);
        return true;
    }

    var rows = [];
    var demoCount = 0;
    for (var j = 0; j < arr.length; j++) {
        var mapped = _mapArrayRow(userId, domainKey, arr[j]);
        if (mapped) {
            rows.push(mapped);
            if (_isDemoItem(domainKey, arr[j])) demoCount++;
        }
    }

    tableStatus.local_count = arr.length;
    tableStatus.demo_count = demoCount;

    // Upsert in chunks
    var CHUNK = 500;
    var upserted = 0;
    for (var c = 0; c < rows.length; c += CHUNK) {
        var chunk = rows.slice(c, c + CHUNK);
        var res = await client.from(cfg.table).upsert(chunk, { onConflict: cfg.onConflict });
        if (res.error) {
            // Retry once
            var retry = await client.from(cfg.table).upsert(chunk, { onConflict: cfg.onConflict });
            if (retry.error) {
                tableStatus.status = 'error';
                progress.last_error = retry.error.message;
                progress.last_error_table = domainKey;
                progress.last_error_at = new Date().toISOString();
                await _saveBackfillProgress(progress);
                return false;
            }
        }
        upserted += chunk.length;
    }

    tableStatus.status = 'complete';
    tableStatus.upserted_count = upserted;
    tableStatus.completed_at = new Date().toISOString();
    progress.demo_rows_included[domainKey] = demoCount;
    await _saveBackfillProgress(progress);
    console.log('[Denarii] Backfill complete: ' + cfg.table + ' (' + upserted + ' rows, ' + demoCount + ' demo)');
    return true;
}

// Backfill trades with cursor-based resume in batches
async function _backfillTrades(client, userId, jd, progress) {
    var cfg = _SHADOW_DOMAINS.trades;
    var tableStatus = _ensureTableStatus(progress, 'trades');

    var arr = Array.isArray(jd.trades) ? jd.trades : [];
    if (arr.length === 0) {
        tableStatus.status = 'complete';
        tableStatus.local_count = 0;
        tableStatus.upserted_count = 0;
        tableStatus.completed_at = new Date().toISOString();
        progress.trades_cursor = 0;
        await _saveBackfillProgress(progress);
        return true;
    }

    // Sort trades by id for deterministic cursor
    var sorted = arr.slice().sort(function (a, b) {
        var aid = String(a.id || '');
        var bid = String(b.id || '');
        return aid < bid ? -1 : aid > bid ? 1 : 0;
    });

    tableStatus.local_count = sorted.length;

    // Count demo trades
    var demoCount = 0;
    for (var d = 0; d < sorted.length; d++) {
        if (_isDemoItem('trades', sorted[d])) demoCount++;
    }
    tableStatus.demo_count = demoCount;

    var cursor = progress.trades_cursor || 0;
    var upserted = tableStatus.upserted_count || 0;

    while (cursor < sorted.length) {
        var end = Math.min(cursor + _BACKFILL_TRADE_BATCH, sorted.length);
        var rows = [];
        for (var j = cursor; j < end; j++) {
            var mapped = _mapArrayRow(userId, 'trades', sorted[j]);
            if (mapped) rows.push(mapped);
        }

        if (rows.length > 0) {
            var res = await client.from(cfg.table).upsert(rows, { onConflict: cfg.onConflict });
            if (res.error) {
                // Retry once
                var retry = await client.from(cfg.table).upsert(rows, { onConflict: cfg.onConflict });
                if (retry.error) {
                    tableStatus.status = 'error';
                    progress.last_error = retry.error.message;
                    progress.last_error_table = 'trades';
                    progress.last_error_at = new Date().toISOString();
                    progress.trades_cursor = cursor;
                    tableStatus.upserted_count = upserted;
                    await _saveBackfillProgress(progress);
                    return false;
                }
            }
            upserted += rows.length;
        }

        cursor = end;
        progress.trades_cursor = cursor;
        tableStatus.upserted_count = upserted;

        // Save progress after each batch for resume safety
        await _saveBackfillProgress(progress);
    }

    tableStatus.status = 'complete';
    tableStatus.completed_at = new Date().toISOString();
    progress.demo_rows_included.trades = demoCount;
    await _saveBackfillProgress(progress);
    console.log('[Denarii] Backfill complete: trades (' + upserted + ' rows, ' + demoCount + ' demo)');
    return true;
}

// Backfill keyed-object domains (reviews, dailyPlanners, weeklyPlanners)
async function _backfillKeyedObject(client, userId, jd, domainKey, progress) {
    var cfg = _SHADOW_DOMAINS[domainKey];
    if (!cfg) return true;
    var tableStatus = _ensureTableStatus(progress, domainKey);

    var obj = jd[domainKey];
    if (!obj || typeof obj !== 'object') {
        tableStatus.status = 'complete';
        tableStatus.local_count = 0;
        tableStatus.upserted_count = 0;
        tableStatus.completed_at = new Date().toISOString();
        await _saveBackfillProgress(progress);
        return true;
    }

    var rows;
    if (domainKey === 'reviews') {
        rows = _mapReviewRows(userId, obj);
    } else {
        rows = _mapPlannerRows(userId, obj);
    }

    if (rows.length === 0) {
        tableStatus.status = 'complete';
        tableStatus.local_count = 0;
        tableStatus.upserted_count = 0;
        tableStatus.completed_at = new Date().toISOString();
        await _saveBackfillProgress(progress);
        return true;
    }

    // Count demo entries (reviews have _isDemo; planners have _isDemo)
    var demoCount = 0;
    var objKeys = Object.keys(obj);
    for (var k = 0; k < objKeys.length; k++) {
        if (obj[objKeys[k]] && obj[objKeys[k]]._isDemo) demoCount++;
    }

    tableStatus.local_count = rows.length;
    tableStatus.demo_count = demoCount;

    // Upsert in chunks
    var CHUNK = 500;
    var upserted = 0;
    for (var c = 0; c < rows.length; c += CHUNK) {
        var chunk = rows.slice(c, c + CHUNK);
        var res = await client.from(cfg.table).upsert(chunk, { onConflict: cfg.onConflict });
        if (res.error) {
            var retry = await client.from(cfg.table).upsert(chunk, { onConflict: cfg.onConflict });
            if (retry.error) {
                tableStatus.status = 'error';
                progress.last_error = retry.error.message;
                progress.last_error_table = domainKey;
                progress.last_error_at = new Date().toISOString();
                await _saveBackfillProgress(progress);
                return false;
            }
        }
        upserted += chunk.length;
    }

    tableStatus.status = 'complete';
    tableStatus.upserted_count = upserted;
    tableStatus.completed_at = new Date().toISOString();
    progress.demo_rows_included[domainKey] = demoCount;
    await _saveBackfillProgress(progress);
    console.log('[Denarii] Backfill complete: ' + cfg.table + ' (' + upserted + ' rows, ' + demoCount + ' demo)');
    return true;
}

// ── Phase 3: Verification ───────────────────────────────────────
// After all tables complete, compare counts and spot-check trades.

async function _verifyBackfill(client, userId, jd, progress) {
    try {
        var allPass = true;

        for (var i = 0; i < _BACKFILL_ORDER.length; i++) {
            var dk = _BACKFILL_ORDER[i];
            var cfg = _SHADOW_DOMAINS[dk];
            if (!cfg) continue;
            var tableStatus = progress.tables[dk];
            if (!tableStatus || tableStatus.status !== 'complete') {
                allPass = false;
                continue;
            }

            // Count remote rows
            var countRes = await client
                .from(cfg.table)
                .select('*', { count: 'exact', head: true })
                .eq('user_id', userId);

            if (countRes.error) {
                console.warn('[Denarii] Verification count failed (' + cfg.table + '):', countRes.error.message);
                allPass = false;
                continue;
            }

            var remoteCount = countRes.count || 0;
            var localCount = tableStatus.local_count || 0;

            if (remoteCount < localCount) {
                console.warn('[Denarii] Verification mismatch: ' + cfg.table + ' local=' + localCount + ' remote=' + remoteCount);
                tableStatus.status = 'pending';
                tableStatus.completed_at = null;
                allPass = false;
                continue;
            }

            console.log('[Denarii] Verification OK: ' + cfg.table + ' (' + remoteCount + ' remote, ' + localCount + ' local)');
        }

        // Spot-check trades if counts match
        if (allPass && Array.isArray(jd.trades) && jd.trades.length > 0) {
            var tradesOk = await _spotCheckTrades(client, userId, jd.trades);
            if (!tradesOk) {
                console.warn('[Denarii] Trade spot-check failed. Marking trades for re-backfill.');
                if (progress.tables.trades) {
                    progress.tables.trades.status = 'pending';
                    progress.tables.trades.completed_at = null;
                }
                progress.trades_cursor = 0;
                allPass = false;
            }
        }

        if (allPass) {
            progress.verified_at = new Date().toISOString();
            console.log('[Denarii] Phase 3 backfill verified successfully.');
        } else {
            console.warn('[Denarii] Phase 3 verification found mismatches. Will retry next session.');
            progress.completed_at = null; // allow re-run
        }
    } catch (e) {
        console.warn('[Denarii] Verification error:', e.message || e);
        progress.completed_at = null;
    }
}

async function _spotCheckTrades(client, userId, trades) {
    try {
        if (trades.length === 0) return true;

        // Sort by id to pick deterministic samples
        var sorted = trades.slice().sort(function (a, b) {
            return String(a.id || '') < String(b.id || '') ? -1 : 1;
        });

        var checks = [];
        // Oldest
        checks.push(sorted[0]);
        // Newest
        if (sorted.length > 1) checks.push(sorted[sorted.length - 1]);
        // Random middle (deterministic based on length)
        if (sorted.length > 2) {
            var midIdx = Math.floor(sorted.length / 2);
            checks.push(sorted[midIdx]);
        }

        for (var i = 0; i < checks.length; i++) {
            var trade = checks[i];
            var res = await client
                .from('trades')
                .select('id, symbol, pnl')
                .eq('user_id', userId)
                .eq('id', String(trade.id))
                .single();

            if (res.error || !res.data) {
                console.warn('[Denarii] Spot-check: trade ' + trade.id + ' not found in Supabase');
                return false;
            }

            // Verify symbol and pnl match
            if (res.data.symbol !== (trade.symbol || '') ||
                Number(res.data.pnl) !== Number(trade.pnl)) {
                console.warn('[Denarii] Spot-check: trade ' + trade.id + ' data mismatch');
                return false;
            }
        }

        return true;
    } catch (e) {
        console.warn('[Denarii] Spot-check error:', e.message || e);
        return false;
    }
}
