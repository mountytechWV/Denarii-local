// ── DEK Crypto Utilities ─────────────────────────────────────────────
// Standalone helpers for the Data Encryption Key (DEK) model.
// Depends on CryptoJS (must be loaded first). No side effects.
//
// The DEK is a random 256-bit AES key stored as a 64-char hex string.
// It is "wrapped" (encrypted) by a wrapping key derived from a passphrase
// (password or recovery key) via PBKDF2-SHA256 with a per-wrap random salt.
//
// Wrap formats (wrappedDekByPassword / wrappedDekByRecovery):
//   v1: base64(IV + AES-256-CBC ciphertext of the hex DEK), CryptoJS PBKDF2
//       100,000 iterations, salt kept beside it in dekPasswordSalt /
//       dekRecoverySalt. Read only (unwrapDekAny); nothing writes it now.
//   v2: { v: 2, alg: 'pbkdf2-sha256/aes-256-gcm', iter, salt, iv, ct } via
//       crypto.subtle, 600,000 iterations, AES-256-GCM over the 32 raw DEK
//       bytes (base64 fields). Written by wrapDekV2.

var DekCrypto = (function () {
    'use strict';

    var PBKDF2_ITERATIONS = 100000;
    var SALT_BYTES = 16;
    var DEK_BYTES = 32; // 256-bit AES key

    // ── Key generation ──────────────────────────────────────────

    // Generate a random 256-bit DEK as a 64-char hex string.
    function generateDek() {
        var bytes = CryptoJS.lib.WordArray.random(DEK_BYTES);
        return bytes.toString(CryptoJS.enc.Hex);
    }

    // Generate a random 16-byte salt as a base64 string.
    function generateSalt() {
        var bytes = CryptoJS.lib.WordArray.random(SALT_BYTES);
        return bytes.toString(CryptoJS.enc.Base64);
    }

    // ── Key derivation ──────────────────────────────────────────

    // Derive a 256-bit wrapping key from a passphrase and salt via PBKDF2-SHA256.
    function deriveWrappingKey(passphrase, saltBase64, iterations) {
        var salt = CryptoJS.enc.Base64.parse(saltBase64);
        return CryptoJS.PBKDF2(passphrase, salt, {
            keySize: 256 / 32,
            iterations: iterations || PBKDF2_ITERATIONS,
            hasher: CryptoJS.algo.SHA256
        });
    }

    // ── Wrap / Unwrap ───────────────────────────────────────────

    // Encrypt the DEK hex string with the wrapping key.
    // Uses AES-256-CBC with a random IV. Returns base64(IV + ciphertext).
    function wrapDek(dekHex, wrappingKey) {
        var iv = CryptoJS.lib.WordArray.random(16);
        var ciphertext = CryptoJS.AES.encrypt(dekHex, wrappingKey, {
            iv: iv,
            mode: CryptoJS.mode.CBC,
            padding: CryptoJS.pad.Pkcs7
        });
        // Concatenate IV + raw ciphertext bytes, encode as base64
        var combined = iv.concat(ciphertext.ciphertext);
        return combined.toString(CryptoJS.enc.Base64);
    }

    // Decrypt a wrapped DEK. Returns the DEK hex string, or null on failure.
    function unwrapDek(wrappedBase64, wrappingKey) {
        try {
            var combined = CryptoJS.enc.Base64.parse(wrappedBase64);
            // First 16 bytes = IV, rest = ciphertext
            var iv = CryptoJS.lib.WordArray.create(combined.words.slice(0, 4), 16);
            var ciphertext = CryptoJS.lib.WordArray.create(
                combined.words.slice(4),
                combined.sigBytes - 16
            );
            var decrypted = CryptoJS.AES.decrypt(
                { ciphertext: ciphertext },
                wrappingKey,
                { iv: iv, mode: CryptoJS.mode.CBC, padding: CryptoJS.pad.Pkcs7 }
            );
            var hex = decrypted.toString(CryptoJS.enc.Utf8);
            // Validate: must be a 64-char hex string
            if (hex && /^[0-9a-f]{64}$/.test(hex)) return hex;
            return null;
        } catch (e) {
            return null;
        }
    }

    // ── Password / recovery-key hashes ──────────────────────────
    // Stored on the account record as passwordHash / recoveryHash:
    //   { v: 2, alg: 'pbkdf2-sha256', iter, salt, hash }   (salt, hash: base64)
    // PBKDF2-SHA256 via crypto.subtle with a random 16-byte salt per hash.
    // Older records hold an unsalted SHA-256 hex string; verifySecret still
    // accepts it and returns a v2 replacement only when it matched.

    var SECRET_HASH_ITERATIONS = 600000;
    var SECRET_HASH_MAX_ITERATIONS = 10000000; // refuse absurd values from a file
    var SECRET_HASH_BYTES = 32;

    function _toB64(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
        return btoa(s);
    }

    function _fromB64(b64) {
        var s = atob(b64);
        var out = new Uint8Array(s.length);
        for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
        return out;
    }

    // Constant-time comparison of two byte arrays (or two strings).
    function _equal(a, b) {
        if (a.length !== b.length) return false;
        var diff = 0;
        for (var i = 0; i < a.length; i++) {
            diff |= (typeof a === 'string' ? a.charCodeAt(i) ^ b.charCodeAt(i) : a[i] ^ b[i]);
        }
        return diff === 0;
    }

    async function _pbkdf2(secret, saltBytes, iterations) {
        var key = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), 'PBKDF2', false, ['deriveBits']);
        var bits = await crypto.subtle.deriveBits(
            { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iterations },
            key,
            SECRET_HASH_BYTES * 8
        );
        return new Uint8Array(bits);
    }

    function isV2Hash(stored) {
        return !!stored && typeof stored === 'object' && stored.v === 2 && stored.alg === 'pbkdf2-sha256' &&
            Number.isInteger(stored.iter) && stored.iter > 0 && stored.iter <= SECRET_HASH_MAX_ITERATIONS &&
            typeof stored.salt === 'string' && typeof stored.hash === 'string';
    }

    function isLegacyHash(stored) {
        return typeof stored === 'string' && /^[0-9a-f]{64}$/i.test(stored);
    }

    // New salted hash of a password or recovery key.
    async function hashSecret(secret) {
        var salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        var hash = await _pbkdf2(secret, salt, SECRET_HASH_ITERATIONS);
        return { v: 2, alg: 'pbkdf2-sha256', iter: SECRET_HASH_ITERATIONS, salt: _toB64(salt), hash: _toB64(hash) };
    }

    // Checks secret against a stored hash. Returns { ok, upgrade }: upgrade is
    // a fresh v2 hash when the stored value was a legacy SHA-256 hex string
    // that matched (the caller saves it); otherwise null. A wrong secret or an
    // unrecognised stored value is { ok: false, upgrade: null }.
    async function verifySecret(secret, stored) {
        try {
            if (isV2Hash(stored)) {
                var actual = await _pbkdf2(secret, _fromB64(stored.salt), stored.iter);
                return { ok: _equal(actual, _fromB64(stored.hash)), upgrade: null };
            }
            if (isLegacyHash(stored)) {
                var legacy = CryptoJS.SHA256(String(secret)).toString(CryptoJS.enc.Hex);
                if (!_equal(legacy, stored.toLowerCase())) return { ok: false, upgrade: null };
                return { ok: true, upgrade: await hashSecret(secret) };
            }
        } catch (e) {
            /* malformed stored value: treat as no match */
        }
        return { ok: false, upgrade: null };
    }

    // ── v2 DEK wrap (crypto.subtle) ─────────────────────────────

    var WRAP_ALG = 'pbkdf2-sha256/aes-256-gcm';
    var WRAP_ITERATIONS = 600000;
    var WRAP_IV_BYTES = 12;

    function _hexToBytes(hex) {
        var out = new Uint8Array(hex.length / 2);
        for (var i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
        return out;
    }

    function _bytesToHex(bytes) {
        var s = '';
        for (var i = 0; i < bytes.length; i++) s += (bytes[i] < 16 ? '0' : '') + bytes[i].toString(16);
        return s;
    }

    async function _gcmKey(secret, saltBytes, iterations) {
        var base = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret)), 'PBKDF2', false, ['deriveKey']);
        return crypto.subtle.deriveKey(
            { name: 'PBKDF2', hash: 'SHA-256', salt: saltBytes, iterations: iterations },
            base,
            { name: 'AES-GCM', length: 256 },
            false,
            ['encrypt', 'decrypt']
        );
    }

    function isV2Wrap(wrapped) {
        return !!wrapped && typeof wrapped === 'object' && wrapped.v === 2 && wrapped.alg === WRAP_ALG &&
            Number.isInteger(wrapped.iter) && wrapped.iter > 0 && wrapped.iter <= SECRET_HASH_MAX_ITERATIONS &&
            typeof wrapped.salt === 'string' && typeof wrapped.iv === 'string' && typeof wrapped.ct === 'string';
    }

    // True when unwrapDekAny can try this wrap: v2, or a v1 string with its salt.
    function isWrapReadable(wrapped, legacySalt) {
        if (isV2Wrap(wrapped)) return true;
        return typeof wrapped === 'string' && wrapped.length > 0 && typeof legacySalt === 'string' && legacySalt.length > 0;
    }

    function hasPasswordWrap(auth) {
        return !!auth && auth.dekVersion === 1 && isWrapReadable(auth.wrappedDekByPassword, auth.dekPasswordSalt);
    }

    function hasRecoveryWrap(auth) {
        return !!auth && auth.dekVersion === 1 && isWrapReadable(auth.wrappedDekByRecovery, auth.dekRecoverySalt);
    }

    // Wraps a DEK (64-char hex) with a password or recovery key as v2.
    async function wrapDekV2(dekHex, secret) {
        if (typeof dekHex !== 'string' || !/^[0-9a-f]{64}$/.test(dekHex)) throw new Error('Invalid DEK');
        var salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES));
        var iv = crypto.getRandomValues(new Uint8Array(WRAP_IV_BYTES));
        var key = await _gcmKey(secret, salt, WRAP_ITERATIONS);
        var ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv }, key, _hexToBytes(dekHex));
        return { v: 2, alg: WRAP_ALG, iter: WRAP_ITERATIONS, salt: _toB64(salt), iv: _toB64(iv), ct: _toB64(new Uint8Array(ct)) };
    }

    // Unwraps a v2 wrap, or a v1 wrap with its legacySalt. Returns
    // { dek, upgraded }: upgraded is true when the wrap was v1 (the caller
    // may replace it with a v2 wrap). A wrong secret or an unreadable wrap
    // is { dek: null, upgraded: false }.
    async function unwrapDekAny(wrapped, legacySalt, secret) {
        try {
            if (isV2Wrap(wrapped)) {
                var iv = _fromB64(wrapped.iv);
                if (iv.length !== WRAP_IV_BYTES) return { dek: null, upgraded: false };
                var key = await _gcmKey(secret, _fromB64(wrapped.salt), wrapped.iter);
                var raw = new Uint8Array(await crypto.subtle.decrypt({ name: 'AES-GCM', iv: iv }, key, _fromB64(wrapped.ct)));
                if (raw.length !== DEK_BYTES) return { dek: null, upgraded: false };
                return { dek: _bytesToHex(raw), upgraded: false };
            }
            if (isWrapReadable(wrapped, legacySalt)) {
                var dek = unwrapDek(wrapped, deriveWrappingKey(String(secret), legacySalt));
                if (dek) return { dek: dek, upgraded: true };
            }
        } catch (e) {
            /* wrong secret (GCM tag mismatch) or malformed wrap */
        }
        return { dek: null, upgraded: false };
    }

    // ── Public API ──────────────────────────────────────────────

    return {
        generateDek: generateDek,
        generateSalt: generateSalt,
        // v1 (CryptoJS) wrap functions: kept for reading old wraps only
        deriveWrappingKey: deriveWrappingKey,
        wrapDek: wrapDek,
        unwrapDek: unwrapDek,
        wrapDekV2: wrapDekV2,
        unwrapDekAny: unwrapDekAny,
        isV2Wrap: isV2Wrap,
        isWrapReadable: isWrapReadable,
        hasPasswordWrap: hasPasswordWrap,
        hasRecoveryWrap: hasRecoveryWrap,
        hashSecret: hashSecret,
        verifySecret: verifySecret,
        isV2Hash: isV2Hash,
        isLegacyHash: isLegacyHash,
        SECRET_HASH_ITERATIONS: SECRET_HASH_ITERATIONS,
        WRAP_ITERATIONS: WRAP_ITERATIONS
    };
})();
