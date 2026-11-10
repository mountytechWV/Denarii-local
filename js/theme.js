const THEMES = [
    { key: 'denarii-forged', label: 'Denarii Forged' },
    { key: 'soft-dark',      label: 'Soft Dark'      },
    { key: 'harbor-light',   label: 'Harbor Light'   },
    { key: 'sage-journal',   label: 'Sage Journal'   },
    { key: 'dawn-ember',     label: 'Dawn Ember'     },
    { key: 'warm-midnight',  label: 'Warm Midnight'  },
    { key: 'blush-power',    label: 'Blush Power'    }
];

function initTheme() {
    let saved = localStorage.getItem('denarii-theme') || 'denarii-forged';
    // Remap removed Light Mode to Harbor Light
    if (saved === 'light') { saved = 'harbor-light'; localStorage.setItem('denarii-theme', saved); }
    applyTheme(saved, false);
}

function applyTheme(key, save) {
    document.documentElement.setAttribute('data-theme', key);
    if (save) localStorage.setItem('denarii-theme', key);
    const t = THEMES.find(t => t.key === key) || THEMES[0];
    const lbl = document.getElementById('theme-label');
    if (lbl) lbl.textContent = t.label;
    // Update popup theme label
    const popupLbl = document.getElementById('popup-theme-label');
    if (popupLbl) popupLbl.textContent = t.label;
    // Update theme submenu active states
    document.querySelectorAll('.theme-option').forEach(btn => {
        btn.classList.toggle('active-theme', btn.getAttribute('data-theme-key') === key);
    });
}

function toggleThemeSubmenu() {
    document.getElementById('theme-submenu').classList.toggle('active');
}

function selectThemeFromPopup(key) {
    applyTheme(key, true);
    try {
        const uid = window._denariiSupabaseUid;
        if (!uid) return;
        localStorage.setItem('denarii-theme-pending', uid);
        localStorage.setItem('denarii-theme-owner', uid);
        _saveAccountTheme(uid, key);
    } catch (e) {
        console.warn('[Denarii] Theme account save skipped:', e.message || e);
    }
}

// ── Account theme sync ───────────────────────────────────────────
// localStorage stays the working copy; the account copy (user_meta row
// 'themePref') follows the user between browsers. Failures only log.
//   denarii-theme-pending: uid whose pick has not reached the account yet
//   denarii-theme-owner:   uid the localStorage theme belongs to
var _THEME_SYNC_TIMEOUT_MS = 1500;

function isKnownTheme(key) {
    return THEMES.some(t => t.key === key);
}

// read: { ok, theme } from _fetchAccountTheme, or null when not read.
// Returns what to do: apply (theme key), store (keep it in localStorage),
// save (theme key to send to the account).
function resolveSignInTheme(uid, read, local, owner, pending) {
    const localKnown = isKnownTheme(local);
    if (pending === uid && localKnown) return { save: local };
    // A failed read is not "no account theme": change nothing.
    if (!read || !read.ok) return {};
    if (read.theme !== null && read.theme !== undefined) {
        if (isKnownTheme(read.theme)) return { apply: read.theme, store: true };
        return { apply: 'denarii-forged' };
    }
    if (localKnown && (!owner || owner === uid)) return { save: local };
    return { apply: 'denarii-forged' };
}

async function syncThemeOnSignIn(auth) {
    const uid = auth && auth.supabaseUid;
    if (!uid) return;
    let timer = null;
    try {
        const local = localStorage.getItem('denarii-theme');
        const owner = localStorage.getItem('denarii-theme-owner');
        const pending = localStorage.getItem('denarii-theme-pending');
        let read = null;
        // A pick still waiting to be saved is sent as is, so no read is needed.
        if (!(pending === uid && isKnownTheme(local))) {
            read = await Promise.race([
                _fetchAccountTheme(uid),
                new Promise(resolve => { timer = setTimeout(() => resolve({ ok: false }), _THEME_SYNC_TIMEOUT_MS); })
            ]);
        }
        const action = resolveSignInTheme(uid, read, local, owner, pending);
        if (action.apply) {
            applyTheme(action.apply, !!action.store);
            if (action.store) {
                localStorage.setItem('denarii-theme-owner', uid);
                localStorage.removeItem('denarii-theme-pending');
            }
        }
        if (action.save) {
            localStorage.setItem('denarii-theme-owner', uid);
            _saveAccountTheme(uid, action.save);
        }
    } catch (e) {
        console.warn('[Denarii] Theme sign-in sync skipped:', e.message || e);
    } finally {
        clearTimeout(timer);
    }
}
