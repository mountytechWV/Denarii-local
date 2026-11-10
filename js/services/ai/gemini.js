/**
 * @file gemini.js
 * Gemini REST API client. Self-contained; swap this file to add another provider.
 *
 * Request path (centralized in call()):
 *  • User-key path (_callDirect): the page calls Gemini directly with the
 *    user's own saved key. This is the only path used in Denarii Local.
 *  • Proxy path (_callProxy): dormant. Only used when
 *    DENARII_CONFIG.AI_DEFAULT_PROXY is true, which it never is in Local
 *    (there is no AI server and no built-in key).
 *
 * User-key storage:
 *   - Stored encrypted in SETTINGS_STORE (local database) via window.setAppSetting
 *     / window.getAppSetting / window.deleteAppSetting.
 *   - Encryption uses CryptoJS.AES with sessionDek or sessionPassword.
 *   - Never logs the key itself. All error messages are safe to show in UI.
 */

(function (global) {

    var PROVIDER        = 'gemini';
    var DEFAULT_MODEL   = 'gemini-flash-lite-latest';
    // Used once when the chosen model is busy or times out.
    var FALLBACK_MODEL  = 'gemini-flash-lite-latest';
    var FALLBACK_MIN_REMAINING_MS = 20000;  // less left than this → a fresh 60 s
    var FALLBACK_FRESH_TIMEOUT_MS = 60000;
    var BASE_URL        = 'https://generativelanguage.googleapis.com/v1beta/models/';
    var LIST_MODELS_URL = 'https://generativelanguage.googleapis.com/v1beta/models';
    // Default client timeout. Callers pass providerConfig.timeoutMs per feature
    // (the desktop app has no server time limit).
    var TIMEOUT_MS      = 120000;

    // Output limits. On Gemini 2.5 models thinking tokens count against
    // maxOutputTokens, so a long report could run out of room mid-JSON.
    // Default output is raised and thinking is capped (2.5 Flash accepts
    // 0–24576; 2.5 Pro needs at least 128, so 1024 is valid for both).
    var DEFAULT_MAX_OUTPUT_TOKENS = 16384;
    var DEFAULT_THINKING_BUDGET   = 1024;
    // Gemini 3 models (and the -latest aliases) take thinkingLevel instead.
    // "low" is the lowest level every Gemini 3 model accepts ("minimal" is
    // Flash-only).
    var DEFAULT_THINKING_LEVEL    = 'low';

    // Payload size guard — rough character limit before we refuse to send.
    // Gemini Flash supports ~1M tokens but we cap early to avoid slow/expensive calls.
    // ~200k chars ≈ ~50k tokens. Raise if needed.
    var PAYLOAD_CHAR_LIMIT = 200000;

    // If payload exceeds the hard limit, trim trade list to this many most-recent trades.
    // Higher because compact serialisation (below) makes each record much smaller.
    var PAYLOAD_TRIM_TO = 300;

    // Trade arrays above this size are serialised in compact form (shorter field names,
    // truncated timestamps, verbose text notes stripped) to reduce token overhead.
    var COMPACT_THRESHOLD = 100;

    // ─────────────────────────────────────────────────────────────────────────
    // Supabase sync helpers — store/fetch the encrypted blob, never plaintext
    // ─────────────────────────────────────────────────────────────────────────

    function _getSupabaseClient() {
        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) return null;
        return SupabaseAuth.getClient();
    }

    // Batch D3: user_settings.rev last seen; writes update only where it
    // still matches, so a key changed on another device is not overwritten.
    var _settingsRev = null;

    // Batch D3: the local cache is per account (it used to be one device-wide
    // setting shared by every account on the browser).
    function _settingKey() {
        var acct = null;
        try { if (typeof currentAccountId !== 'undefined') acct = currentAccountId; } catch (e) { /* not defined */ }
        return acct ? 'gemini-api-key:' + acct : 'gemini-api-key';
    }

    // The chosen model is stored per account, next to the key.
    function _modelSettingKey() {
        var acct = null;
        try { if (typeof currentAccountId !== 'undefined') acct = currentAccountId; } catch (e) { /* not defined */ }
        return acct ? 'gemini-model:' + acct : 'gemini-model';
    }

    // The Supabase session's user id, only when it is the signed-in account.
    async function _sessionUid() {
        var res = await SupabaseAuth.supabaseGetSession();
        var uid = res && res.data && res.data.user ? res.data.user.id : null;
        if (!uid) return null;
        if (typeof global._sessionMatchesAccount === 'function' && !global._sessionMatchesAccount(uid)) return null;
        return uid;
    }

    // Fire-and-forget checked write — failures are non-fatal console warnings
    function _syncToSupabase(encryptedBlob) {
        _syncChecked(encryptedBlob || null).catch(function (e) {
            console.warn('[DenAriiAI] Supabase sync error:', e.message || e);
        });
    }

    async function _syncChecked(blob) {
        var client = _getSupabaseClient();
        if (!client) return;
        var uid = await _sessionUid();
        if (!uid) { console.log('[DenAriiAI] Key sync skipped: cloud session is not this account.'); return; }
        var now = new Date().toISOString();
        if (_settingsRev == null) {
            var cur = await client.from('user_settings').select('gemini_key_encrypted, rev').eq('user_id', uid).maybeSingle();
            if (cur.error) { console.warn('[DenAriiAI] Supabase key sync failed:', cur.error.message); return; }
            if (!cur.data) {
                if (!blob) return;
                var ins = await client.from('user_settings').insert({ user_id: uid, gemini_key_encrypted: blob, updated_at: now }).select('rev');
                if (ins.error) { console.warn('[DenAriiAI] Supabase key sync failed:', ins.error.message); return; }
                _settingsRev = ins.data && ins.data[0] && ins.data[0].rev != null ? Number(ins.data[0].rev) : null;
                console.log('[DenAriiAI] Gemini key synced to cloud.');
                return;
            }
            _settingsRev = cur.data.rev != null ? Number(cur.data.rev) : null;
        }
        var q = client.from('user_settings').update({ gemini_key_encrypted: blob, updated_at: now }).eq('user_id', uid);
        if (_settingsRev != null) q = q.eq('rev', _settingsRev);
        var up = await q.select('rev');
        if (up.error) { console.warn('[DenAriiAI] Supabase key sync failed:', up.error.message); return; }
        if (up.data && up.data.length) {
            if (up.data[0].rev != null) _settingsRev = Number(up.data[0].rev);
            console.log(blob ? '[DenAriiAI] Gemini key synced to cloud.' : '[DenAriiAI] Gemini key cleared from cloud.');
            return;
        }
        // Changed on another device since this browser read it: the cloud wins.
        var latest = await client.from('user_settings').select('gemini_key_encrypted, rev').eq('user_id', uid).maybeSingle();
        if (latest.error || !latest.data) return;
        _settingsRev = latest.data.rev != null ? Number(latest.data.rev) : null;
        var cloudBlob = latest.data.gemini_key_encrypted || null;
        if (cloudBlob === blob) return;
        if (typeof global._recordCloudConflict === 'function') {
            global._recordCloudConflict('user_settings', 'gemini_key_encrypted', blob, 'changed on another device');
        }
        await _applyCloudBlob(cloudBlob);
        console.warn('[DenAriiAI] Gemini key was changed on another device; using that one.');
    }

    // Reads the cloud copy. null = could not read; { exists: false } = no row.
    async function _fetchFromSupabase() {
        try {
            var client = _getSupabaseClient();
            if (!client) return null;
            var uid = await _sessionUid();
            if (!uid) return null;
            var res = await client.from('user_settings').select('gemini_key_encrypted, rev').eq('user_id', uid).maybeSingle();
            if (res.error) return null;
            if (!res.data) return { exists: false, blob: null, rev: null };
            return { exists: true, blob: res.data.gemini_key_encrypted || null, rev: res.data.rev != null ? Number(res.data.rev) : null };
        } catch (e) {
            console.warn('[DenAriiAI] Supabase fetch error:', e.message || e);
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

    // ─────────────────────────────────────────────────────────────────────────
    // Key management
    // ─────────────────────────────────────────────────────────────────────────

    var _cachedKey = null; // decrypted key held in memory for the session

    // Returns the user's personal Gemini key when one is loaded, or null.
    // The default Gemini key is NOT resolved here — the server-side proxy
    // at /api/ai-query is the authoritative default path and never
    // exposes a key to the browser.
    function _getApiKey() {
        return _cachedKey || null;
    }

    // True when the deployment exposes the server-side default Gemini
    // proxy at /api/ai-query (the Vercel Function). Driven by a single
    // client flag so the provider can declare itself "configured" even
    // without a user key.
    function _defaultProxyAvailable() {
        try {
            var cfg = global.DENARII_CONFIG;
            return !!(cfg && cfg.AI_DEFAULT_PROXY);
        } catch (e) {
            return false;
        }
    }

    // Returns true only when a user-entered key is saved and loaded for this session.
    function hasUserKey() {
        return !!_cachedKey;
    }

    // Returns the current session encryption key (DEK hex or legacy
    // passphrase). `sessionDek` / `sessionPassword` are declared with
    // `let` at the top of auth.js, which places them in the shared
    // Global Lexical Environment — reachable via a BARE identifier
    // from any other classic script, but NOT via `window.sessionDek`
    // (let bindings never show up on the global object). Resolving
    // them via `global.sessionDek` previously returned undefined and
    // caused CryptoJS to throw
    //   "Cannot read properties of undefined (reading 'words')"
    // when a user tried to save a personal Gemini key.
    function _getSessionEncKey() {
        try {
            if (typeof sessionDek !== 'undefined' && sessionDek) return sessionDek;
        } catch (e) { /* not defined in this scope chain */ }
        try {
            if (typeof sessionPassword !== 'undefined' && sessionPassword) return sessionPassword;
        } catch (e) { /* not defined in this scope chain */ }
        return null;
    }

    async function saveApiKey(key) {
        if (!key || typeof key !== 'string') throw new Error('Key must be a non-empty string.');
        var trimmed = key.trim();
        var encKey = _getSessionEncKey();
        if (!encKey) {
            throw new Error('Your account session is not ready yet. Please sign in again, then retry saving the key.');
        }
        _cachedKey = trimmed;
        var encrypted = global.encrypt(trimmed, encKey);
        await global.setAppSetting(_settingKey(), encrypted);
        _syncToSupabase(encrypted);
        console.log('[DenAriiAI] Gemini API key saved to app settings.');
    }

    async function loadApiKey() {
        try {
            var settingKey = _settingKey();
            var stored = await global.getAppSetting(settingKey);

            // Batch D3: one-time move of the old device-wide copy to this
            // account's key, only when it decrypts with this account's key.
            if (!stored && settingKey !== 'gemini-api-key') {
                var shared = await global.getAppSetting('gemini-api-key');
                if (shared && _decryptBlob(shared)) {
                    stored = shared;
                    await global.setAppSetting(settingKey, shared);
                    await global.deleteAppSetting('gemini-api-key');
                }
            }

            // One-time migration from plaintext localStorage
            if (!stored) {
                var legacy = null;
                try { legacy = localStorage.getItem('denarii-ai-gemini-key'); } catch (e) { /* ignore */ }
                if (legacy && legacy.trim()) {
                    await saveApiKey(legacy.trim());
                    try { localStorage.removeItem('denarii-ai-gemini-key'); } catch (e) { /* ignore */ }
                    console.log('[DenAriiAI] Migrated Gemini key from localStorage to encrypted app settings.');
                    return;
                }
            }

            // Batch D3: the cloud copy is the main one whenever it can be read;
            // the browser's copy is only a cache (and the offline fallback).
            var cloud = await _fetchFromSupabase();
            if (cloud) {
                _settingsRev = cloud.rev;
                if (cloud.exists) {
                    if (cloud.blob !== (stored || null)) {
                        if (cloud.blob) await global.setAppSetting(settingKey, cloud.blob);
                        else if (stored) await global.deleteAppSetting(settingKey);
                        stored = cloud.blob;
                        console.log('[DenAriiAI] Gemini key loaded from cloud.');
                    }
                } else if (stored) {
                    _syncToSupabase(stored); // saved before it ever reached the cloud
                }
            }

            _cachedKey = _decryptBlob(stored);
        } catch (e) {
            _cachedKey = null;
            console.warn('[DenAriiAI] Failed to load API key:', e.message);
        }
    }

    async function clearApiKey() {
        _cachedKey = null;
        await global.deleteAppSetting(_settingKey());
        _syncToSupabase(null);
        console.log('[DenAriiAI] Gemini API key removed from app settings.');
    }

    // Clears the in-memory cache only — does not touch persisted storage.
    // Called on lock so the key is not accessible without re-authenticating.
    function unloadApiKey() {
        _cachedKey = null;
    }

    // Re-encrypts the cached key with the current encryption key.
    // For DEK accounts this is a no-op (DEK doesn't change on password change).
    // For legacy accounts, re-encrypts with the new sessionPassword.
    async function reencryptApiKey() {
        if (!_cachedKey) return;
        // DEK accounts don't rotate their key on password change, so no
        // re-encrypt is needed. Legacy passphrase accounts DO need one.
        var encKey = _getSessionEncKey();
        var isDek = typeof encKey === 'string' && /^[0-9a-f]{64}$/.test(encKey);
        if (isDek) return;
        await saveApiKey(_cachedKey);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Model selection
    // ─────────────────────────────────────────────────────────────────────────

    // The account's chosen model, or DEFAULT_MODEL.
    async function getModel() {
        try {
            var stored = await global.getAppSetting(_modelSettingKey());
            if (typeof stored === 'string' && stored.trim()) return stored.trim();
        } catch (e) { /* fall back to default */ }
        return DEFAULT_MODEL;
    }

    async function setModel(name) {
        var trimmed = (typeof name === 'string') ? name.trim() : '';
        // Any explicit choice is stored, so a later change of the default
        // never overrides it.
        if (!trimmed) {
            await global.deleteAppSetting(_modelSettingKey());
        } else {
            await global.setAppSetting(_modelSettingKey(), trimmed);
        }
    }

    // Model names (without the "models/" prefix) that support generateContent
    // for the saved key. Returns [] when there is no key or the list can't load.
    async function listModels() {
        var key = _getApiKey();
        if (!key) return [];
        try {
            var names = [];
            var pageToken = '';
            for (var page = 0; page < 10; page++) {
                var url = LIST_MODELS_URL + '?pageSize=1000&key=' + encodeURIComponent(key) +
                    (pageToken ? '&pageToken=' + encodeURIComponent(pageToken) : '');
                var res = await fetch(url);
                if (!res.ok) return [];
                var data = await res.json();
                (data.models || []).forEach(function (m) {
                    var methods = m.supportedGenerationMethods || [];
                    if (methods.indexOf('generateContent') !== -1 && typeof m.name === 'string') {
                        names.push(m.name.replace(/^models\//, ''));
                    }
                });
                pageToken = data.nextPageToken || '';
                if (!pageToken) break;
            }
            return names;
        } catch (e) {
            console.warn('[DenAriiAI] Could not list Gemini models:', e.message || e);
            return [];
        }
    }

    function isConfigured() {
        // Provider is usable when either:
        //   (a) the user has their own Gemini key loaded, or
        //   (b) the server-side default proxy is available.
        return !!_getApiKey() || _defaultProxyAvailable();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // rawText normalizer — always returns a non-null trimmed string
    // ─────────────────────────────────────────────────────────────────────────

    function _normalizeRawText(value) {
        if (value == null) return 'No response returned.';
        var s = String(value).trim();
        return s.length > 0 ? s : 'No response returned.';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Payload size guard
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Check payload size. If over limit, trims the trade list and warns.
     * Returns { payload, trimmed } where trimmed=true means trades were cut.
     *
     * @param {Object} payload
     * @returns {{ payload: Object, trimmed: boolean }}
     */
    function _guardPayloadSize(payload) {
        var serialised = JSON.stringify(payload);
        if (serialised.length <= PAYLOAD_CHAR_LIMIT) {
            return { payload: payload, trimmed: false };
        }

        // Too large — trim trade list to most recent N trades
        if (payload.trades && payload.trades.length > PAYLOAD_TRIM_TO) {
            var trimmed = Object.assign({}, payload, {
                trades: payload.trades.slice(-PAYLOAD_TRIM_TO),
            });
            // Recalc summary trade count to reflect trim
            trimmed.summary = Object.assign({}, payload.summary, {
                tradeCount: trimmed.trades.length,
                trimmedFrom: payload.trades.length,
            });
            console.warn(
                '[DenAriiAI] Payload too large (' + serialised.length + ' chars). ' +
                'Trimmed from ' + payload.trades.length + ' to ' + PAYLOAD_TRIM_TO + ' most recent trades.'
            );
            return { payload: trimmed, trimmed: true };
        }

        // Can't trim further (no trade list) — let the call proceed; Gemini will error if truly over limit
        console.warn('[DenAriiAI] Payload size (' + serialised.length + ' chars) is large. Proceeding without trim.');
        return { payload: payload, trimmed: false };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Request builder
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * For large trade arrays, produce a compact representation that strips verbose
     * free-text fields (entryReason, exitReason, lessons, tags) and shortens
     * timestamps from full ISO strings to "YYYY-MM-DDTHH:MM" (saves ~10 chars each).
     * Abbreviated field names are documented in the prompt context header.
     */
    function _compactTradesForPrompt(trades) {
        if (trades.length <= COMPACT_THRESHOLD) return trades;
        return trades.map(function (t) {
            var c = {
                sym:      t.symbol,
                dir:      t.direction,
                type:     t.assetType,
                qty:      t.quantity,
                entryP:   t.entryPrice,
                exitP:    t.exitPrice,
                entryT:   t.entryTime ? String(t.entryTime).slice(0, 16) : null,
                exitT:    t.exitTime  ? String(t.exitTime).slice(0, 16)  : null,
                holdSecs: t.holdSeconds,
                pnl:      t.pnl,
            };
            // Categorical enrichment — preserved because it is high-value for analysis
            if (t.setupType)            c.setup  = t.setupType;
            if (t.emotion)              c.emo    = t.emotion;
            if (t.strategyScore != null) c.score = t.strategyScore;
            // Option-specific fields
            if (t.optionType)           c.optType = t.optionType;
            if (t.strike != null)       c.strike  = t.strike;
            if (t.expiry)               c.expiry  = t.expiry;
            // entryReason, exitReason, lessons, tags omitted for large datasets
            return c;
        });
    }

    function _buildPromptText(promptText, payload) {
        var parts = [promptText.trim()];

        if (payload && payload.trades && payload.trades.length > 0) {
            var note = payload.summary && payload.summary.trimmedFrom
                ? ' [trimmed from ' + payload.summary.trimmedFrom + ' — showing most recent ' + payload.trades.length + ']'
                : '';

            var tradesForPrompt = _compactTradesForPrompt(payload.trades);
            var isCompact = tradesForPrompt !== payload.trades;

            parts.push(
                '\n\n--- Trade Data Context ---',
                'Summary: ' + JSON.stringify(payload.summary),
                'Active Filters: ' + JSON.stringify(payload.filters),
                'Trades (' + payload.trades.length + ' records' + note +
                    (isCompact
                        ? '; compact fields: sym=symbol, dir=direction, type=assetType, qty=quantity, entryP/exitP=prices, entryT/exitT=timestamps(UTC,truncated), holdSecs=hold duration, emo=emotion, setup=setupType'
                        : '') +
                    '):',
                JSON.stringify(tradesForPrompt),
                '--- End Trade Data ---'
            );

            console.log('[DenAriiAI] Prompt built:',
                payload.trades.length + ' trades',
                'compact=' + isCompact,
                'tradesChars=' + JSON.stringify(tradesForPrompt).length
            );
        }

        return parts.join('\n');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // API call
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Call the Gemini generateContent endpoint.
     *
     * Single centralized request-path decision:
     *   • if a user-entered Gemini key is loaded → _callDirect (browser
     *     → Gemini, user's key, unchanged behavior);
     *   • else if the server-side default proxy is available →
     *     _callProxy (browser → /api/ai-query → Gemini, server key,
     *     requires a Supabase session);
     *   • else → clear error instructing the user how to get AI working.
     *
     * @param {string} promptText
     * @param {Object} payload         - Formatted trade payload from formatter.js
     * @param {string} requestId       - Trace ID from index.js
     * @param {import('./types').ProviderConfig} [providerConfig]
     * @returns {Promise<import('./types').AIResponse>}
     */
    // Public entry point. When the chosen model is busy (503 / 429) or times
    // out, the same request is sent once with Flash-Lite. A Flash-Lite model
    // is never retried, so there is no fallback loop. The saved model choice
    // is not changed.
    async function callWithFallback(promptText, payload, requestId, providerConfig) {
        providerConfig = providerConfig || {};
        var startMs = Date.now();
        var resp = await call(promptText, payload, requestId, providerConfig);
        if (resp.success || !resp.fallbackReason || /flash-lite/i.test(resp.model || '')) return resp;

        var timeoutMs = (providerConfig.timeoutMs > 0) ? providerConfig.timeoutMs : TIMEOUT_MS;
        var remaining = timeoutMs - (Date.now() - startMs);
        if (remaining < FALLBACK_MIN_REMAINING_MS) remaining = FALLBACK_FRESH_TIMEOUT_MS;
        console.log('[DenAriiAI] Fallback →',
            'id=' + requestId,
            'feature=' + (providerConfig.feature || 'other'),
            'originalModel=' + resp.model,
            'fallbackModel=' + FALLBACK_MODEL,
            'reason=' + resp.fallbackReason,
            'timeoutMs=' + remaining);

        var fb = await call(promptText, payload, requestId,
            Object.assign({}, providerConfig, { model: FALLBACK_MODEL, timeoutMs: remaining }));
        if (!fb.success) return resp; // the feature shows its usual error
        fb.fallbackFrom   = resp.model;
        fb.fallbackReason = resp.fallbackReason;
        return fb;
    }

    async function call(promptText, payload, requestId, providerConfig) {
        var createdAt = new Date().toISOString();
        providerConfig = providerConfig || {};

        var model       = (providerConfig.model       && String(providerConfig.model).trim())       || await getModel();
        var temperature = (providerConfig.temperature != null)                                       ? providerConfig.temperature : 0.2;
        var maxTokens   = (providerConfig.maxOutputTokens != null)                                   ? providerConfig.maxOutputTokens : DEFAULT_MAX_OUTPUT_TOKENS;
        var thinkingConfig = _thinkingConfig(model, providerConfig);
        var timeoutMs   = (providerConfig.timeoutMs > 0) ? providerConfig.timeoutMs : TIMEOUT_MS;
        var feature     = providerConfig.feature || 'other';

        // Build the Gemini request body once — identical shape for both
        // the direct and proxy paths, so the server function is a pure
        // pass-through and prompt-building logic stays client-side.
        var guarded = _guardPayloadSize(payload || {});
        var geminiBody = {
            contents: [{
                parts: [{ text: _buildPromptText(promptText, guarded.payload) }]
            }],
            generationConfig: {
                temperature:     temperature,
                maxOutputTokens: maxTokens
            }
        };
        if (thinkingConfig) geminiBody.generationConfig.thinkingConfig = thinkingConfig;
        // Gemini 3 (and the -latest aliases) keep their default temperature
        // (1.0): Google warns lower values can make the reply loop, which
        // showed up as Clean Up never returning.
        if (/gemini-3|-latest$/i.test(model)) delete geminiBody.generationConfig.temperature;
        var bodyStr     = JSON.stringify(geminiBody);
        var fingerprint = _djb2(bodyStr);
        // Request settings for the log: no prompt text, no key.
        var genLog      = JSON.stringify(geminiBody.generationConfig);

        // Trades actually sent (after any trim), so Run Analysis can show the real count.
        var tradesSent        = (guarded.payload && guarded.payload.trades) ? guarded.payload.trades.length : 0;
        var tradesTrimmedFrom = (guarded.trimmed && payload && payload.trades) ? payload.trades.length : null;
        var stampSent = function (r) {
            if (r) { r.tradesSent = tradesSent; r.tradesTrimmedFrom = tradesTrimmedFrom; }
            return r;
        };

        var userKey = _getApiKey();
        var proxyAvailable = _defaultProxyAvailable();

        if (userKey) {
            console.log(
                '[DenAriiAI] Request →',
                'id=' + requestId,
                'provider=' + PROVIDER,
                'path=direct',
                'feature=' + feature,
                'model=' + model,
                'trades=' + ((guarded.payload && guarded.payload.trades) ? guarded.payload.trades.length : 0) +
                    (guarded.trimmed ? ' (trimmed)' : ''),
                'payloadChars=' + bodyStr.length,
                'endpoint=generateContent',
                'generationConfig=' + genLog,
                'fingerprint=' + fingerprint
            );
            return _callDirect({
                model:        model,
                bodyStr:      bodyStr,
                geminiBody:   geminiBody,
                apiKey:       userKey,
                feature:      feature,
                timeoutMs:    timeoutMs,
                requestId:    requestId,
                createdAt:    createdAt,
                fingerprint:  fingerprint
            }).then(stampSent);
        }

        if (proxyAvailable) {
            console.log(
                '[DenAriiAI] Request →',
                'id=' + requestId,
                'provider=' + PROVIDER,
                'path=proxy',
                'model=' + model,
                'trades=' + ((guarded.payload && guarded.payload.trades) ? guarded.payload.trades.length : 0) +
                    (guarded.trimmed ? ' (trimmed)' : ''),
                'payloadChars=' + bodyStr.length,
                'generationConfig=' + genLog,
                'fingerprint=' + fingerprint
            );
            return _callProxy({
                model:        model,
                geminiBody:   geminiBody,
                feature:      feature,
                timeoutMs:    timeoutMs,
                requestId:    requestId,
                createdAt:    createdAt,
                fingerprint:  fingerprint
            }).then(stampSent);
        }

        return {
            success:   false,
            rawText:   'No response returned.',
            provider:  PROVIDER,
            model:     model,
            requestId: requestId,
            error:     'No Gemini API key configured. Add one in Settings → Integrations.',
            createdAt: createdAt
        };
    }

    // Thinking settings by model family. Never both settings at once.
    //   gemini-2.5*             → thinkingBudget (thinking counts against output)
    //   gemini-3*, any *-latest → thinkingLevel
    //   older models            → none (they reject it)
    function _thinkingConfig(model, providerConfig) {
        if (/gemini-2\.5/i.test(model)) {
            return { thinkingBudget: (providerConfig.thinkingBudget != null) ? providerConfig.thinkingBudget : DEFAULT_THINKING_BUDGET };
        }
        if (/gemini-3|-latest$/i.test(model)) {
            return { thinkingLevel: providerConfig.thinkingLevel || DEFAULT_THINKING_LEVEL };
        }
        return null;
    }

    // A 400 caused by the thinking setting (unsupported level, or a model
    // without thinking).
    function _isThinkingRejected(status, body) {
        if (status !== 400) return false;
        var msg = '';
        try { msg = body.error.message || ''; } catch (e) { /* ignore */ }
        return /thinking/i.test(msg);
    }

    // One line per attempt: no prompt text, no key.
    function _logAttempt(opts, status, startMs) {
        console.log('[DenAriiAI] Gemini response —',
            'id=' + opts.requestId,
            'model=' + opts.model,
            'feature=' + (opts.feature || 'other'),
            'status=' + status,
            'elapsedMs=' + (Date.now() - startMs));
    }

    // Direct browser → Gemini call using the user's own API key. If the API
    // rejects the thinking setting, the same request is sent once more
    // without thinkingConfig.
    async function _callDirect(opts) {
        var endpoint = BASE_URL + opts.model + ':generateContent?key=' + opts.apiKey;
        var timeoutMs = opts.timeoutMs || TIMEOUT_MS;
        var bodyStr = opts.bodyStr;
        var canRetry = !!(opts.geminiBody && opts.geminiBody.generationConfig && opts.geminiBody.generationConfig.thinkingConfig);

        for (var attempt = 0; attempt < 2; attempt++) {
            var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
            var timeoutId  = null;
            if (controller) timeoutId = setTimeout(function () { controller.abort(); }, timeoutMs);
            var startMs = Date.now();

            try {
                var res = await fetch(endpoint, {
                    method:  'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body:    bodyStr,
                    signal:  controller ? controller.signal : undefined
                });
                if (timeoutId) clearTimeout(timeoutId);
                _logAttempt(opts, res.status, startMs);

                if (!res.ok) {
                    var errBody = null;
                    try { errBody = await res.json(); } catch (e) { /* ignore */ }
                    if (canRetry && attempt === 0 && _isThinkingRejected(res.status, errBody)) {
                        console.warn('[DenAriiAI] Thinking setting rejected — retrying without it.', 'id=' + opts.requestId);
                        var retryBody = JSON.parse(bodyStr);
                        delete retryBody.generationConfig.thinkingConfig;
                        bodyStr = JSON.stringify(retryBody);
                        continue;
                    }
                    var httpMsg = _httpErrorMessage(res.status, errBody);
                    console.warn('[DenAriiAI] Direct request failed —',
                        'id=' + opts.requestId,
                        'status=' + res.status,
                        'category=' + _httpCategory(res.status));
                    var errResp = _errorResponse(opts, httpMsg);
                    // Busy / rate limited: call() may fall back to Flash-Lite.
                    if (res.status === 503 || res.status === 429) errResp.fallbackReason = 'http ' + res.status;
                    return errResp;
                }

                var data = await res.json();
                return _successOrShapeError(opts, data);
            } catch (err) {
                if (timeoutId) clearTimeout(timeoutId);
                var isAbort = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
                _logAttempt(opts, isAbort ? 'timeout' : 'network', startMs);
                var netResp = _networkErrorResponse(opts, err);
                if (isAbort) netResp.fallbackReason = 'timeout';
                return netResp;
            }
        }
    }

    // Browser → /api/ai-query (Vercel Function) → Gemini. Forwards the
    // caller's Supabase access token so the server can authenticate the
    // request before using the server-held default Gemini key.
    async function _callProxy(opts) {
        // Fetch the current Supabase access token. Without one the
        // server proxy will reject the call with 401, so we detect up
        // front and return a clean, actionable error message.
        var accessToken = null;
        try {
            if (typeof SupabaseAuth !== 'undefined'
                && typeof SupabaseAuth.supabaseGetSession === 'function') {
                var sess = await SupabaseAuth.supabaseGetSession();
                if (sess && sess.data && sess.data.access_token) {
                    accessToken = sess.data.access_token;
                }
            }
        } catch (e) { /* treat as no session */ }

        if (!accessToken) {
            return _errorResponse(opts,
                'Sign in to use Denarii AI, or add your own Gemini key in Settings → Integrations.');
        }

        var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
        var timeoutId  = null;
        if (controller) timeoutId = setTimeout(function () { controller.abort(); }, opts.timeoutMs || TIMEOUT_MS);
        var startMs = Date.now();

        try {
            var res = await fetch('/api/ai-query', {
                method:  'POST',
                headers: {
                    'Content-Type':  'application/json',
                    'Authorization': 'Bearer ' + accessToken
                },
                body: JSON.stringify({ model: opts.model, geminiBody: opts.geminiBody }),
                signal: controller ? controller.signal : undefined
            });
            if (timeoutId) clearTimeout(timeoutId);
            _logAttempt(opts, res.status, startMs);

            var contentType = (res.headers && res.headers.get) ? (res.headers.get('content-type') || '') : '';
            var data = null;
            if (contentType.indexOf('application/json') !== -1) {
                try { data = await res.json(); } catch (e) { data = null; }
            }

            if (!res.ok) {
                var msg = (data && data.error && data.error.message)
                    ? data.error.message
                    : _httpErrorMessage(res.status, data);
                console.warn('[DenAriiAI] Proxy request failed —',
                    'id=' + opts.requestId,
                    'status=' + res.status,
                    'category=' + _httpCategory(res.status));
                return _errorResponse(opts, msg);
            }

            // On success the proxy forwards Gemini's raw JSON, so the
            // existing _extractText / _extractUsage path works unchanged.
            return _successOrShapeError(opts, data || {});
        } catch (err) {
            if (timeoutId) clearTimeout(timeoutId);
            return _networkErrorResponse(opts, err);
        }
    }

    function _successOrShapeError(opts, data) {
        var rawText = _normalizeRawText(_extractText(data));
        if (rawText === 'No response returned.') {
            console.warn('[DenAriiAI] Unexpected response shape —', 'id=' + opts.requestId,
                JSON.stringify(data).slice(0, 200));
            return _errorResponse(opts, 'AI returned an unexpected response format. Please try again.');
        }
        var usage = _extractUsage(data);
        var finishReason = _extractFinishReason(data);
        console.log(
            '[DenAriiAI] Success —',
            'id=' + opts.requestId,
            'tokens=' + (usage ? usage.totalTokens : 'unknown'),
            'finishReason=' + (finishReason || 'unknown')
        );
        return {
            success:     true,
            rawText:     rawText,
            provider:    PROVIDER,
            model:       opts.model,
            requestId:   opts.requestId,
            createdAt:   opts.createdAt,
            usage:       usage || undefined,
            fingerprint: opts.fingerprint,
            // MAX_TOKENS = the reply hit the output limit and is incomplete.
            finishReason: finishReason,
            truncated:    finishReason === 'MAX_TOKENS'
        };
    }

    function _errorResponse(opts, message) {
        return {
            success:   false,
            rawText:   'No response returned.',
            provider:  PROVIDER,
            model:     opts.model,
            requestId: opts.requestId,
            error:     message,
            createdAt: opts.createdAt
        };
    }

    function _networkErrorResponse(opts, err) {
        var isTimeout = err && (err.name === 'AbortError' || err.name === 'TimeoutError');
        console.warn('[DenAriiAI] Request error —',
            'id=' + opts.requestId,
            'category=' + (isTimeout ? 'timeout' : 'network'),
            'name=' + (err && err.name || 'unknown'),
            'message=' + (err && err.message || 'unknown'));
        return _errorResponse(opts, isTimeout
            ? 'Request timed out after ' + ((opts.timeoutMs || TIMEOUT_MS) / 1000) + ' seconds. The analysis may be too large — try narrowing your date range or filtering to fewer trades.'
            : 'Network error. Check your internet connection and try again.'
        );
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Payload fingerprinting
    // djb2 hash of the full request body — use to verify that two runs sent
    // an identical payload (same prompt, same trades, same summary stats).
    // Log line format:  [DenAriiAI] Request → ... fingerprint=<hex8>
    // ─────────────────────────────────────────────────────────────────────────

    function _djb2(str) {
        var h = 5381;
        for (var i = 0; i < str.length; i++) {
            h = (((h << 5) + h) ^ str.charCodeAt(i)) >>> 0;
        }
        return h.toString(16).padStart(8, '0');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Response helpers
    // ─────────────────────────────────────────────────────────────────────────

    function _extractText(data) {
        try {
            var parts = data.candidates[0].content.parts;
            // Gemini 2.5 thinking models include thought parts (thought: true).
            // Filter them out so we only join actual response text.
            var textParts = parts.filter(function (p) { return !p.thought && typeof p.text === 'string'; });
            if (textParts.length > 0) {
                var text = textParts.map(function (p) { return p.text; }).join('');
                var skipped = parts.length - textParts.length;
                console.log('[DenAriiAI] Extracted text: ' + text.length + ' chars from ' + textParts.length +
                    ' part(s)' + (skipped > 0 ? ' (' + skipped + ' thought part(s) skipped)' : '') +
                    ' — preview: ' + JSON.stringify(text.slice(0, 200)));
                return text;
            }
            // Fallback: no non-thought parts found, try parts[0].text
            return (parts[0] && parts[0].text) || null;
        } catch (e) {
            return null;
        }
    }

    function _extractFinishReason(data) {
        try { return data.candidates[0].finishReason || null; } catch (e) { return null; }
    }

    function _extractUsage(data) {
        try {
            var u = data.usageMetadata;
            return {
                promptTokens:     u.promptTokenCount     || 0,
                completionTokens: u.candidatesTokenCount || 0,
                totalTokens:      u.totalTokenCount      || 0,
            };
        } catch (e) {
            return null;
        }
    }

    function _httpCategory(status) {
        if (status === 400) return 'invalid_request';
        if (status === 401 || status === 403) return 'auth_failure';
        if (status === 429) return 'rate_limit';
        if (status === 404) return 'model_not_found';
        if (status >= 500) return 'service_error';
        return 'unknown_http_' + status;
    }

    var MODEL_NOT_FOUND_MSG = "This AI model isn't available for your key. Choose another model in Settings > Integrations.";

    // Gemini sometimes reports an unknown/retired model as NOT_FOUND inside a 400.
    function _isModelNotFound(body) {
        try {
            if (body.error.status === 'NOT_FOUND') return true;
            return /models\/\S+ is not found|model .*not found/i.test(body.error.message || '');
        } catch (e) { return false; }
    }

    function _httpErrorMessage(status, body) {
        var apiMsg = null;
        try { apiMsg = body.error.message; } catch (e) { /* ignore */ }

        if (status === 404 || _isModelNotFound(body)) return MODEL_NOT_FOUND_MSG;
        if (status === 400) return 'Invalid request. ' + (apiMsg || 'Check your prompt and try again.');
        if (status === 401 || status === 403) return 'API key rejected. Check your Gemini API key in Settings \u2192 Integrations.';
        if (status === 429) return 'Rate limit reached — provider limits exceeded. Please wait a moment and try again.';
        if (status >= 500) return 'Gemini service error (' + status + '). Try again shortly.';
        return 'Request failed (HTTP ' + status + ').' + (apiMsg ? ' ' + apiMsg : '');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Expose
    // ─────────────────────────────────────────────────────────────────────────

    global._DenAriiAIGemini = {
        call: callWithFallback,
        saveApiKey,
        loadApiKey,
        clearApiKey,
        unloadApiKey,
        reencryptApiKey,
        isConfigured,
        hasUserKey,
        getModel,
        setModel,
        listModels,
        PROVIDER,
        MODEL: DEFAULT_MODEL,
    };

}(window));
