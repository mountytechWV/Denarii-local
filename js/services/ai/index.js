/**
 * @file index.js
 * Public API surface for the Denarii AI layer.
 * Exposes window.DenAriiAI — the only symbol callers should reference.
 *
 * Adding a new provider later:
 *  1. Create js/services/ai/yourprovider.js following the gemini.js pattern.
 *  2. Load it in index.html before this file.
 *  3. Pass it as the `provider` option to query(), or set a default here.
 *
 * Depends on (must be loaded first):
 *  - js/services/ai/formatter.js  → window._DenAriiAIFormatter
 *  - js/services/ai/gemini.js     → window._DenAriiAIGemini
 */

(function (global) {

    // ─────────────────────────────────────────────────────────────────────────
    // Request ID generation
    // Simple, reliable, no external deps. Format: <timestamp-base36>-<random-6>
    // e.g. "lxw4k2a1-f3m9qz"
    // ─────────────────────────────────────────────────────────────────────────

    function _generateRequestId() {
        return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Provider registry
    // ─────────────────────────────────────────────────────────────────────────

    var _providers = {};

    function _registerProvider(name, impl) {
        _providers[name] = impl;
    }

    function _getProvider(name) {
        var p = _providers[name || 'gemini'];
        if (!p) throw new Error('Unknown AI provider: "' + (name || 'gemini') + '"');
        return p;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Core query
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Send a prompt (with optional trade data) to the AI and return a normalised response.
     *
     * @param {import('./types').AIRequest} request
     * @param {Object}  [options]
     * @param {string}  [options.provider='gemini']       - Provider key to use.
     * @param {import('./types').ProviderConfig} [options.providerConfig] - Model/temperature overrides.
     * @returns {Promise<import('./types').AIResponse>}
     */
    async function query(request, options) {
        options = options || {};
        var providerKey    = options.provider || 'gemini';
        var providerConfig = options.providerConfig || {};

        // Resolve or generate requestId
        var requestId = (request && request.requestId && String(request.requestId).trim())
            ? String(request.requestId).trim()
            : _generateRequestId();

        var startMs = Date.now();

        var formatter = global._DenAriiAIFormatter;
        var provider  = null;

        try {
            provider = _getProvider(providerKey);
        } catch (e) {
            return {
                success:   false,
                rawText:   'No response returned.',
                provider:  providerKey,
                model:     'unknown',
                requestId: requestId,
                durationMs: Date.now() - startMs,
                error:     e.message,
                createdAt: new Date().toISOString(),
            };
        }

        if (!formatter) {
            return {
                success:   false,
                rawText:   'No response returned.',
                provider:  providerKey,
                model:     provider.MODEL || 'unknown',
                requestId: requestId,
                durationMs: Date.now() - startMs,
                error:     'AI formatter not loaded. Reload the page and try again.',
                createdAt: new Date().toISOString(),
            };
        }

        // Build the compact payload (applies filters, normalises trades)
        var payload = formatter.buildPayload(request);

        // Delegate to the provider (pass requestId and providerConfig)
        var resp = await provider.call(
            (request && request.promptText) ? request.promptText : '',
            payload,
            requestId,
            providerConfig
        );

        // Stamp durationMs and requestId (provider already sets requestId, but ensure it)
        resp.durationMs = Date.now() - startMs;
        resp.requestId  = requestId;

        // Ensure rawText is always a safe string (belt-and-suspenders)
        if (resp.rawText == null || typeof resp.rawText !== 'string') {
            resp.rawText = 'No response returned.';
        }

        console.log(
            '[DenAriiAI] Query complete —',
            'id=' + requestId,
            'success=' + resp.success,
            'durationMs=' + resp.durationMs,
            'provider=' + resp.provider,
            'model=' + resp.model
        );

        return resp;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Key management helpers (delegate to active provider)
    // ─────────────────────────────────────────────────────────────────────────

    function isConfigured(providerKey) {
        try { return _getProvider(providerKey).isConfigured(); }
        catch (e) { return false; }
    }

    // Returns true only when a user-entered key override is loaded for this session.
    function hasUserKey(providerKey) {
        try {
            var p = _getProvider(providerKey || 'gemini');
            return typeof p.hasUserKey === 'function' ? p.hasUserKey() : false;
        } catch (e) { return false; }
    }

    async function setApiKey(key, providerKey) {
        await _getProvider(providerKey || 'gemini').saveApiKey(key);
        _refreshKeyStatus();
    }

    async function clearApiKey(providerKey) {
        await _getProvider(providerKey || 'gemini').clearApiKey();
        _refreshKeyStatus();
    }

    async function loadApiKey(providerKey) {
        await _getProvider(providerKey || 'gemini').loadApiKey();
        _refreshKeyStatus();
    }

    function unloadApiKey(providerKey) {
        try { _getProvider(providerKey || 'gemini').unloadApiKey(); } catch (e) { /* ignore */ }
        _refreshKeyStatus();
    }

    // Model selection (Settings → Integrations). Every AI feature uses the
    // selected model because the provider resolves it inside call().
    async function getModel(providerKey) {
        var p = _getProvider(providerKey || 'gemini');
        return typeof p.getModel === 'function' ? p.getModel() : (p.MODEL || null);
    }

    async function setModel(name, providerKey) {
        var p = _getProvider(providerKey || 'gemini');
        if (typeof p.setModel === 'function') await p.setModel(name);
    }

    async function listModels(providerKey) {
        try {
            var p = _getProvider(providerKey || 'gemini');
            return typeof p.listModels === 'function' ? await p.listModels() : [];
        } catch (e) { return []; }
    }

    // Note shown under a result that Flash-Lite answered after the chosen
    // model was busy or slow. '' when no fallback happened.
    function fallbackNote(resp) {
        if (!resp || !resp.success || !resp.fallbackFrom) return '';
        return 'Answered with Flash-Lite because ' + resp.fallbackFrom + ' was busy or slow.';
    }

    async function reencryptApiKey(providerKey) {
        try { await _getProvider(providerKey || 'gemini').reencryptApiKey(); } catch (e) { /* ignore */ }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // UI key-status helper (updates the badge in Settings → Integrations)
    // ─────────────────────────────────────────────────────────────────────────

    function _refreshKeyStatus() {
        var badge = document.getElementById('ai-key-status-badge');
        if (!badge) return;
        var userKey   = hasUserKey('gemini');
        var available = isConfigured('gemini');
        badge.textContent = userKey
            ? 'Personal key saved'
            : (available ? 'Using Denarii default' : 'Not configured');
        badge.style.color = available ? 'var(--success)' : 'var(--danger)';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Dev test page helpers
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Called by the AI test page submit button.
     */
    async function runTestQuery() {
        var promptEl  = document.getElementById('ai-test-prompt');
        var outputEl  = document.getElementById('ai-test-output');
        var errorEl   = document.getElementById('ai-test-error');
        var btnEl     = document.getElementById('ai-test-submit');
        var useDataEl = document.getElementById('ai-test-use-data');

        if (!promptEl || !outputEl) return;

        var promptText = promptEl.value.trim();
        if (!promptText) {
            _testShowError('Enter a prompt first.');
            return;
        }

        var tradeData = [];
        if (useDataEl && useDataEl.checked) {
            try {
                tradeData = (typeof journalData !== 'undefined' && journalData.trades)
                    ? journalData.trades
                    : [];
            } catch (e) { tradeData = []; }
        }

        if (btnEl)    { btnEl.disabled = true; btnEl.textContent = 'Querying…'; }
        if (outputEl) { outputEl.textContent = ''; outputEl.style.display = 'none'; }
        if (errorEl)  { errorEl.textContent = '';  errorEl.style.display = 'none'; }
        _testShowInfo('');

        var resp = await query({ promptText: promptText, tradeData: tradeData });

        if (btnEl) { btnEl.disabled = false; btnEl.textContent = 'Send'; }

        if (resp.success) {
            outputEl.textContent = resp.rawText;
            outputEl.style.display = 'block';
            _testShowInfo(
                'id=' + resp.requestId +
                ' | ' + resp.provider + '/' + resp.model +
                ' | ' + resp.durationMs + 'ms' +
                (resp.usage ? ' | tokens=' + resp.usage.totalTokens : '')
            );
        } else {
            _testShowError(resp.error || 'Unknown error.');
            _testShowInfo(
                'id=' + resp.requestId +
                ' | ' + resp.durationMs + 'ms'
            );
        }
    }

    function _testShowError(msg) {
        var el = document.getElementById('ai-test-error');
        if (!el) return;
        if (!msg) { el.style.display = 'none'; return; }
        el.textContent = msg;
        el.style.display = 'block';
    }

    function _testShowInfo(msg) {
        var el = document.getElementById('ai-test-info');
        if (!el) return;
        if (!msg) { el.style.display = 'none'; return; }
        el.textContent = msg;
        el.style.display = 'block';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Init
    // ─────────────────────────────────────────────────────────────────────────

    function _init() {
        if (global._DenAriiAIGemini) {
            _registerProvider('gemini', global._DenAriiAIGemini);
        }

        document.addEventListener('DOMContentLoaded', function () {
            _refreshKeyStatus();

            if (window.location.hash === '#ai-test') {
                try { activateSection('ai-test'); } catch (e) { /* Denarii.js not ready yet */ }
            }
        });

        console.log('[DenAriiAI] AI service layer ready. Providers: gemini');
    }

    _init();

    // ─────────────────────────────────────────────────────────────────────────
    // Public namespace
    // ─────────────────────────────────────────────────────────────────────────

    global.DenAriiAI = {
        query,
        isConfigured,
        hasUserKey,
        setApiKey,
        clearApiKey,
        loadApiKey,
        unloadApiKey,
        reencryptApiKey,
        getModel,
        setModel,
        listModels,
        fallbackNote,
        runTestQuery,
        refreshKeyStatus: _refreshKeyStatus,
        registerProvider: _registerProvider,
    };

}(window));
