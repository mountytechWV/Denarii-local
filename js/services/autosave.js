// ── Autosave (shared draft utility) ──────────────────────────────────────────
// Minimal per-scope localStorage draft helpers extracted from journal.js and
// reviews.js. Centralizes IO + timestamp stamping; callers build their own
// key strings and define their own snapshot/restore logic.
//
// Public API (on window.Autosave):
//   save(key, payload)      — writes JSON.stringify({...payload, ts: Date.now()})
//   load(key)               — returns parsed object or null
//   clear(key)              — removes the entry
//   isNewerThan(draft, ts)  — true if draft.ts > baselineTs
//
// All methods swallow storage errors (quota / disabled) so callers don't need
// try/catch at every call site.
(function () {
    'use strict';

    function save(key, payload) {
        if (!key) return;
        try {
            var body = {};
            if (payload && typeof payload === 'object') {
                // shallow copy so callers can pass a plain snapshot without ts
                for (var k in payload) {
                    if (Object.prototype.hasOwnProperty.call(payload, k)) body[k] = payload[k];
                }
            }
            var ts = Date.now();
            body.ts = ts;
            // Batch D3: drafts are encrypted with the session key like the
            // journal; only the timestamp stays readable.
            var encKey = _sessionKey();
            var stored = (encKey && typeof encrypt === 'function') ? { ts: ts, enc: encrypt(body, encKey) } : body;
            localStorage.setItem(key, JSON.stringify(stored));
        } catch (e) { /* quota / disabled — ignore */ }
    }

    // Returns the parsed draft, or null. An encrypted draft that does not
    // decrypt with this session's key (another account) is null. Plain
    // drafts saved before Batch D3 still load.
    function load(key) {
        if (!key) return null;
        try {
            var raw = localStorage.getItem(key);
            if (!raw) return null;
            var obj = JSON.parse(raw);
            if (obj && typeof obj.enc === 'string') {
                var encKey = _sessionKey();
                var dec = (encKey && typeof decrypt === 'function') ? decrypt(obj.enc, encKey) : null;
                if (!dec || typeof dec !== 'object') return null;
                dec.ts = obj.ts;
                return dec;
            }
            return obj;
        } catch (e) { return null; }
    }

    // sessionDek / sessionPassword are `let` globals in auth.js (reachable by
    // bare name from this classic script, not via window).
    function _sessionKey() {
        try { if (typeof sessionDek !== 'undefined' && sessionDek) return sessionDek; } catch (e) { /* not defined */ }
        try { if (typeof sessionPassword !== 'undefined' && sessionPassword) return sessionPassword; } catch (e) { /* not defined */ }
        return null;
    }

    function clear(key) {
        if (!key) return;
        try { localStorage.removeItem(key); } catch (e) {}
    }

    function isNewerThan(draft, baselineTs) {
        return !!draft && typeof draft.ts === 'number' && draft.ts > (baselineTs || 0);
    }

    // ── Status indicator ────────────────────────────────────────────────────
    // Shared helper for a small inline autosave status chip.
    // States: 'unsaved' | 'saving' | 'saved' | 'failed'
    var _statusLabels = {
        unsaved: 'Unsaved changes',
        saving:  'Saving\u2026',
        saved:   'Saved',
        failed:  'Save failed'
    };
    var _statusTimers = {};

    function showStatus(elementId, state) {
        var el = document.getElementById(elementId);
        if (!el) return;
        el.textContent = _statusLabels[state] || '';
        el.className = 'autosave-status as-' + state;
        // Clear any pending fade timer
        if (_statusTimers[elementId]) {
            clearTimeout(_statusTimers[elementId]);
            _statusTimers[elementId] = null;
        }
        // 'saved' fades out after 2.5s
        if (state === 'saved') {
            _statusTimers[elementId] = setTimeout(function() {
                if (el.classList.contains('as-saved')) {
                    el.textContent = '';
                    el.className = 'autosave-status';
                }
            }, 2500);
        }
    }

    window.Autosave = {
        save: save,
        load: load,
        clear: clear,
        isNewerThan: isNewerThan,
        showStatus: showStatus
    };
})();
