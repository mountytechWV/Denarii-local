/**
 * market-data-key.js — the user's own Twelve Data API key (stock charts).
 *
 * Same storage model as the personal Gemini key (js/services/ai/gemini.js),
 * but kept as its own setting:
 *   - Encrypted with the account key (sessionDek, or sessionPassword on
 *     legacy accounts) and stored per account in SETTINGS_STORE
 *     (setting twelvedata-api-key:<acct>) via window.setAppSetting.
 *   - The Supabase sync below (user_integration_keys) is dormant code from
 *     the earlier cloud version; js/config/config.js leaves the cloud URL
 *     empty, so it never runs.
 *   - The plaintext key is held only in memory for the session.
 *
 * There is no default key: without a saved key the chart asks for one.
 */
(function (global) {
    'use strict';

    var PROVIDER = 'twelvedata';
    var TABLE = 'user_integration_keys';

    // ─────────────────────────────────────────────────────────────────────────
    // Supabase sync helpers — store/fetch the encrypted blob, never plaintext
    // ─────────────────────────────────────────────────────────────────────────

    function _getSupabaseClient() {
        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) return null;
        return SupabaseAuth.getClient();
    }

    // rev last seen; writes update only where it still matches, so a key
    // changed on another device is not overwritten.
    var _rev = null;

    function _settingKey() {
        var acct = null;
        try { if (typeof currentAccountId !== 'undefined') acct = currentAccountId; } catch (e) { /* not defined */ }
        return acct ? 'twelvedata-api-key:' + acct : 'twelvedata-api-key';
    }

    // The Supabase session's user id, only when it is the signed-in account.
    async function _sessionUid() {
        var res = await SupabaseAuth.supabaseGetSession();
        var uid = res && res.data && res.data.user ? res.data.user.id : null;
        if (!uid) return null;
        if (typeof global._sessionMatchesAccount === 'function' && !global._sessionMatchesAccount(uid)) return null;
        return uid;
    }

    function _selectRow(client, uid) {
        return client.from(TABLE).select('key_encrypted, rev').eq('user_id', uid).eq('provider', PROVIDER).maybeSingle();
    }

    // Fire-and-forget checked write — failures are non-fatal console warnings
    function _syncToSupabase(encryptedBlob) {
        _syncChecked(encryptedBlob || null).catch(function (e) {
            console.warn('[TwelveDataKey] Supabase sync error:', e.message || e);
        });
    }

    async function _syncChecked(blob) {
        var client = _getSupabaseClient();
        if (!client) return;
        var uid = await _sessionUid();
        if (!uid) { console.log('[TwelveDataKey] Key sync skipped: cloud session is not this account.'); return; }
        var now = new Date().toISOString();
        if (_rev == null) {
            var cur = await _selectRow(client, uid);
            if (cur.error) { console.warn('[TwelveDataKey] Supabase key sync failed:', cur.error.message); return; }
            if (!cur.data) {
                if (!blob) return;
                var ins = await client.from(TABLE).insert({ user_id: uid, provider: PROVIDER, key_encrypted: blob, updated_at: now }).select('rev');
                if (ins.error) { console.warn('[TwelveDataKey] Supabase key sync failed:', ins.error.message); return; }
                _rev = ins.data && ins.data[0] && ins.data[0].rev != null ? Number(ins.data[0].rev) : null;
                console.log('[TwelveDataKey] Twelve Data key synced to cloud.');
                return;
            }
            _rev = cur.data.rev != null ? Number(cur.data.rev) : null;
        }
        var q = client.from(TABLE).update({ key_encrypted: blob, updated_at: now }).eq('user_id', uid).eq('provider', PROVIDER);
        if (_rev != null) q = q.eq('rev', _rev);
        var up = await q.select('rev');
        if (up.error) { console.warn('[TwelveDataKey] Supabase key sync failed:', up.error.message); return; }
        if (up.data && up.data.length) {
            if (up.data[0].rev != null) _rev = Number(up.data[0].rev);
            console.log(blob ? '[TwelveDataKey] Twelve Data key synced to cloud.' : '[TwelveDataKey] Twelve Data key cleared from cloud.');
            return;
        }
        // Changed on another device since this browser read it: the cloud wins.
        var latest = await _selectRow(client, uid);
        if (latest.error || !latest.data) return;
        _rev = latest.data.rev != null ? Number(latest.data.rev) : null;
        var cloudBlob = latest.data.key_encrypted || null;
        if (cloudBlob === blob) return;
        if (typeof global._recordCloudConflict === 'function') {
            global._recordCloudConflict(TABLE, 'twelvedata_key_encrypted', blob, 'changed on another device');
        }
        await _applyCloudBlob(cloudBlob);
        console.warn('[TwelveDataKey] Twelve Data key was changed on another device; using that one.');
    }

    // Reads the cloud copy. null = could not read; { exists: false } = no row.
    async function _fetchFromSupabase() {
        try {
            var client = _getSupabaseClient();
            if (!client) return null;
            var uid = await _sessionUid();
            if (!uid) return null;
            var res = await _selectRow(client, uid);
            if (res.error) return null;
            if (!res.data) return { exists: false, blob: null, rev: null };
            return { exists: true, blob: res.data.key_encrypted || null, rev: res.data.rev != null ? Number(res.data.rev) : null };
        } catch (e) {
            console.warn('[TwelveDataKey] Supabase fetch error:', e.message || e);
            return null;
        }
    }

    async function _applyCloudBlob(blob) {
        if (blob) await global.setAppSetting(_settingKey(), blob);
        else await global.deleteAppSetting(_settingKey());
        _cachedKey = _decryptBlob(blob);
    }

    function _decryptBlob(blob) {
        if (!blob) return null;
        var encKey = _getSessionEncKey();
        if (!encKey) return null;
        var decrypted = null;
        try { decrypted = global.decrypt(blob, encKey); } catch (e) { /* ignore */ }
        return (typeof decrypted === 'string' && decrypted.trim()) ? decrypted.trim() : null;
    }

    // sessionDek / sessionPassword are `let` bindings in auth.js, reachable
    // only as bare identifiers (see the note in gemini.js).
    function _getSessionEncKey() {
        try {
            if (typeof sessionDek !== 'undefined' && sessionDek) return sessionDek;
        } catch (e) { /* not defined in this scope chain */ }
        try {
            if (typeof sessionPassword !== 'undefined' && sessionPassword) return sessionPassword;
        } catch (e) { /* not defined in this scope chain */ }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Key management
    // ─────────────────────────────────────────────────────────────────────────

    var _cachedKey = null; // decrypted key held in memory for the session
    var _loadedFor = null; // setting key the cache was loaded for

    function getKey() {
        return _cachedKey || null;
    }

    function hasUserKey() {
        return !!_cachedKey;
    }

    function isLoaded() {
        return _loadedFor === _settingKey();
    }

    async function saveApiKey(key) {
        if (!key || typeof key !== 'string' || !key.trim()) throw new Error('Key must be a non-empty string.');
        var trimmed = key.trim();
        var encKey = _getSessionEncKey();
        if (!encKey) {
            throw new Error('Your account session is not ready yet. Please sign in again, then retry saving the key.');
        }
        _cachedKey = trimmed;
        _loadedFor = _settingKey();
        var encrypted = global.encrypt(trimmed, encKey);
        await global.setAppSetting(_settingKey(), encrypted);
        _syncToSupabase(encrypted);
        console.log('[TwelveDataKey] Twelve Data API key saved to app settings.');
    }

    async function loadApiKey() {
        try {
            var settingKey = _settingKey();
            var stored = await global.getAppSetting(settingKey);

            var cloud = await _fetchFromSupabase();
            if (cloud) {
                _rev = cloud.rev;
                if (cloud.exists) {
                    if (cloud.blob !== (stored || null)) {
                        if (cloud.blob) await global.setAppSetting(settingKey, cloud.blob);
                        else if (stored) await global.deleteAppSetting(settingKey);
                        stored = cloud.blob;
                        console.log('[TwelveDataKey] Twelve Data key loaded from cloud.');
                    }
                } else if (stored) {
                    _syncToSupabase(stored); // saved before it ever reached the cloud
                }
            }

            _cachedKey = _decryptBlob(stored);
            _loadedFor = settingKey;
        } catch (e) {
            _cachedKey = null;
            console.warn('[TwelveDataKey] Failed to load API key:', e.message);
        }
    }

    async function clearApiKey() {
        _cachedKey = null;
        _loadedFor = _settingKey();
        await global.deleteAppSetting(_settingKey());
        _syncToSupabase(null);
        console.log('[TwelveDataKey] Twelve Data API key removed from app settings.');
    }

    // Clears the in-memory cache only — does not touch persisted storage.
    // Called on lock so the key is not accessible without re-authenticating.
    function unloadApiKey() {
        _cachedKey = null;
        _loadedFor = null;
    }

    // Legacy passphrase accounts re-encrypt on password change; DEK accounts
    // keep the same key, so nothing to do.
    async function reencryptApiKey() {
        if (!_cachedKey) return;
        var encKey = _getSessionEncKey();
        var isDek = typeof encKey === 'string' && /^[0-9a-f]{64}$/.test(encKey);
        if (isDek) return;
        await saveApiKey(_cachedKey);
    }

    global.TwelveDataKey = {
        saveApiKey,
        loadApiKey,
        clearApiKey,
        unloadApiKey,
        reencryptApiKey,
        hasUserKey,
        isLoaded,
        getKey,
        settingKey: _settingKey,
        PROVIDER,
        TABLE,
    };

}(window));
