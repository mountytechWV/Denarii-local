// ── Supabase Auth Adapter (scaffold) ─────────────────────────────
// Thin wrapper around @supabase/supabase-js auth methods.
// Safe to load even when Supabase is not configured — every function
// returns a consistent { data, error } shape and never throws.
//
// NOT wired into the app auth flow yet. Manual console testing only.

const SupabaseAuth = (function () {
    'use strict';

    let _client = null;
    let _ready = false;

    // ── Initialization ───────────────────────────────────────────

    function initSupabaseAuth() {
        if (_ready) return { data: _client, error: null };

        const cfg = window.DENARII_CONFIG || {};
        const url = cfg.SUPABASE_URL;
        const key = cfg.SUPABASE_ANON_KEY;

        if (!url || !key) {
            console.warn('[SupabaseAuth] SUPABASE_URL or SUPABASE_ANON_KEY not configured — adapter disabled.');
            return { data: null, error: 'Supabase not configured' };
        }

        if (typeof supabase === 'undefined' || !supabase.createClient) {
            console.warn('[SupabaseAuth] Supabase JS library not loaded — adapter disabled.');
            return { data: null, error: 'Supabase JS library not loaded' };
        }

        try {
            _client = supabase.createClient(url, key);
            _ready = true;
            console.info('[SupabaseAuth] Client initialized.');
            return { data: _client, error: null };
        } catch (err) {
            console.error('[SupabaseAuth] Client init failed:', err);
            return { data: null, error: err.message || String(err) };
        }
    }

    // ── Helpers ──────────────────────────────────────────────────

    function _notReady() {
        return { data: null, error: 'Supabase auth adapter not initialized. Call initSupabaseAuth() first.' };
    }

    // ── Wrapper functions ───────────────────────────────────────

    async function supabaseSignUp(email, password, username) {
        if (!_ready) return _notReady();
        try {
            const { data, error } = await _client.auth.signUp({
                email,
                password,
                options: { data: { username: username || '' } }
            });
            if (error) return { data: null, error: error.message };
            return { data, error: null };
        } catch (err) {
            return { data: null, error: err.message || String(err) };
        }
    }

    async function supabaseSignIn(email, password) {
        if (!_ready) return _notReady();
        try {
            const { data, error } = await _client.auth.signInWithPassword({ email, password });
            if (error) return { data: null, error: error.message };
            return { data, error: null };
        } catch (err) {
            return { data: null, error: err.message || String(err) };
        }
    }

    async function supabaseSignOut() {
        if (!_ready) return _notReady();
        try {
            const { error } = await _client.auth.signOut();
            if (error) return { data: null, error: error.message };
            return { data: true, error: null };
        } catch (err) {
            return { data: null, error: err.message || String(err) };
        }
    }

    async function supabaseGetSession() {
        if (!_ready) return _notReady();
        try {
            const { data, error } = await _client.auth.getSession();
            if (error) return { data: null, error: error.message };
            return { data: data.session, error: null };
        } catch (err) {
            return { data: null, error: err.message || String(err) };
        }
    }

    async function supabaseUpdatePassword(newPassword) {
        if (!_ready) return _notReady();
        try {
            const { data, error } = await _client.auth.updateUser({ password: newPassword });
            if (error) return { data: null, error: error.message };
            return { data, error: null };
        } catch (err) {
            return { data: null, error: err.message || String(err) };
        }
    }

    // ── Query helpers ───────────────────────────────────────────

    function isConfigured() {
        const cfg = window.DENARII_CONFIG || {};
        return !!(cfg.SUPABASE_URL && cfg.SUPABASE_ANON_KEY);
    }

    function isReady() {
        return _ready;
    }

    // ── Client access (for DB operations) ─────────────────────

    function getClient() {
        return _ready ? _client : null;
    }

    // ── Public API ──────────────────────────────────────────────

    return {
        isConfigured,
        isReady,
        getClient,
        initSupabaseAuth,
        supabaseSignUp,
        supabaseSignIn,
        supabaseSignOut,
        supabaseGetSession,
        supabaseUpdatePassword
    };
})();
