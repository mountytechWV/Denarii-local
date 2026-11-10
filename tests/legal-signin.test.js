// Sign-in after a legal bundle change (fix for "sign-in stalls after legal
// bundle 2.0"). The legal acceptance modal sat inside #app-container, which
// is hidden until unlockApp, so an account that still had to accept the new
// bundle got an invisible modal and sign-in seemed to do nothing.
// The real openExistingJournal and legal modal functions run in the sandbox
// harness from password-hash.test.js with the real js/legal-bundle.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const AUTH = read('js/auth.js');
const HTML = read('index.html');
const LEGAL = new Function(read('js/legal-bundle.js') + '\nreturn { LEGAL_BUNDLE, LEGAL_BUNDLE_VERSION };')();

const clone = v => JSON.parse(JSON.stringify(v));

// ── Sandbox harness (as in password-hash.test.js) ──────────────────────────

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    const isAsync = src.slice(start - 6, start) === 'async ';
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return (isAsync ? 'async ' : '') + src.slice(start, i + 1);
    }
    throw new Error(name + ': unbalanced braces');
}

const inert = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
});

function sandbox(parts, vals) {
    const names = [];
    const code = parts.map(([src, fns]) => fns.map(n => { names.push(n); return extractFunction(src, n); }).join('\n')).join('\n');
    const target = Object.assign({}, vals);
    const scope = new Proxy(target, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => {
            if (typeof k !== 'string') return undefined;
            if (k in t) return t[k];
            if (k in globalThis) return globalThis[k];
            return inert;
        },
    });
    const fns = new Function('scope', 'with (scope) { return (function () {\n' + code +
        '\nreturn {' + names.join(',') + '};\n})(); }')(scope);
    return { fns, g: target };
}

function fakeDocument(values, missing) {
    const els = {};
    return {
        els,
        getElementById: id => {
            if ((missing || []).includes(id)) return null;
            if (!els[id]) {
                const classes = new Set();
                els[id] = Object.assign({
                    value: '', checked: false, disabled: false, style: {}, textContent: '', innerHTML: '',
                    classList: { add: c => classes.add(c), remove: c => classes.delete(c), contains: c => classes.has(c) },
                }, values[id] || {});
            }
            return els[id];
        },
        querySelector: () => null,
        querySelectorAll: () => [],
    };
}

// ── Sign-in box ─────────────────────────────────────────────────────────────

const PW = 'correct horse';
const account = extra => Object.assign({ id: 'acct_1', username: 'jason', passwordHash: 'h', storageMode: 'local_legacy', legalAcceptedVersion: '1.0' }, extra);

function signInBox(opts) {
    const o = Object.assign({ record: account(), bundle: LEGAL.LEGAL_BUNDLE, missing: [] }, opts);
    const calls = { errors: [], logged: [], saved: [], unlocked: 0, reloads: 0 };
    const doc = fakeDocument({ 'login-username': { value: 'jason' }, 'login-password': { value: PW } }, o.missing);
    const box = sandbox([[AUTH, ['openExistingJournal', '_reportLoginError', 'showLegalAcceptanceModal', 'handleLegalAcceptance', 'declineLegalAcceptance']]], {
        document: doc,
        location: { reload: () => { calls.reloads++; } },
        localStorage: { setItem: () => {} },
        LEGAL_BUNDLE: o.bundle,
        LEGAL_BUNDLE_VERSION: LEGAL.LEGAL_BUNDLE_VERSION,
        APP_VERSION: '1.0.0',
        SupabaseAuth: undefined,
        DekCrypto: { verifySecret: async pw => ({ ok: pw === PW }), hasPasswordWrap: () => false },
        initDB: async () => {},
        getAuthRecordByUsername: o.getAuth || (async () => clone(o.record)),
        setActiveAccount: async () => {},
        loadFromIndexedDB: async () => true,
        _resolveStorageMode: a => a.storageMode,
        _cloudFirstReload: async () => ({ ok: false }),
        saveAuthRecord: async r => { calls.saved.push(clone(r)); return r; },
        showAuthError: (id, msg) => calls.errors.push([id, msg]),
        unlockApp: () => { calls.unlocked++; },
        sessionDek: null, sessionPassword: null, currentAccountId: null, currentUsername: null,
        console: { log: () => {}, warn: () => {}, error: (...a) => calls.logged.push(a) },
    });
    const modal = () => doc.getElementById('legal-acceptance-modal');
    return { fns: box.fns, g: box.g, doc, calls, modal, run: () => box.fns.openExistingJournal().catch(box.fns._reportLoginError) };
}

// ── 1. The modal can be seen before unlock ─────────────────────────────────

// Open-element stack at the given id, parsed the way a browser closes
// mismatched tags (an end tag pops back to the nearest open element of its name).
function ancestorsOf(html, id) {
    const blank = s => s.replace(/[^\n]/g, ' ');
    const src = html.replace(/<!--[\s\S]*?-->/g, blank).replace(/<(script|style|textarea|pre)\b[\s\S]*?<\/\1>/gi, blank);
    const voids = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'source', 'track', 'wbr', 'path', 'circle', 'line', 'rect', 'polyline', 'polygon', 'ellipse', 'stop', 'use']);
    const stack = [];
    const re = /<(\/?)([a-zA-Z][\w-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g;
    let m;
    while ((m = re.exec(src))) {
        const tag = m[2].toLowerCase();
        if (m[1]) {
            const j = stack.map(x => x.tag).lastIndexOf(tag);
            if (j >= 0) stack.length = j;
            continue;
        }
        const elId = (m[3].match(/\bid="([^"]+)"/) || [])[1];
        if (elId === id) return stack.map(x => x.id || x.tag);
        if (!voids.has(tag) && !m[4]) stack.push({ tag, id: elId });
    }
    throw new Error(id + ' not found');
}

test('index.html: the legal acceptance modal is outside the hidden #app-container', () => {
    const anc = ancestorsOf(HTML, 'legal-acceptance-modal');
    assert.ok(!anc.includes('app-container'), 'ancestors: ' + anc.join(' > '));
    assert.ok(!anc.includes('login-screen'), 'ancestors: ' + anc.join(' > '));
});

test('index.html: the modal has Accept and Decline, and the Unlock button reports errors', () => {
    assert.match(HTML, /id="legal-modal-decline-btn"[^>]*onclick="declineLegalAcceptance\(\)"/);
    assert.match(HTML, /id="legal-modal-confirm-btn"[^>]*onclick="handleLegalAcceptance\(\)"/);
    assert.match(HTML, /onclick="openExistingJournal\(\)\.catch\(_reportLoginError\)">Unlock Journal</);
    assert.match(AUTH, /if \(e\.key === 'Enter'\) openExistingJournal\(\)\.catch\(_reportLoginError\);/);
});

// ── 2. Stored acceptance is older than the bundle ──────────────────────────

test('older accepted version: the modal shows the bundle documents and nothing unlocks yet', async () => {
    const h = signInBox();
    await h.run();
    assert.ok(h.modal().classList.contains('active'), 'modal shown');
    assert.equal(h.calls.unlocked, 0);
    assert.deepEqual(h.calls.saved, [], 'nothing saved before acceptance');
    assert.deepEqual(h.calls.errors, []);
    const shown = h.doc.els['legal-modal-documents'].innerHTML;
    assert.ok(shown.includes('DENARII END USER LICENSE AGREEMENT'));
    assert.ok(shown.includes('DENARII PRIVACY POLICY'));
    assert.equal(h.doc.els['legal-modal-accept'].checked, false, 'checkbox starts unchecked');
    assert.equal(h.g.currentAccountId, 'acct_1');
});

test('older accepted version: accepting saves legalAcceptedVersion and unlocks', async () => {
    const h = signInBox();
    await h.run();
    h.doc.els['legal-modal-accept'].checked = true;
    await h.fns.handleLegalAcceptance();
    assert.equal(h.calls.saved.length, 1);
    const saved = h.calls.saved[0];
    assert.equal(saved.legalAcceptedVersion, LEGAL.LEGAL_BUNDLE_VERSION);
    assert.equal(saved.legalAcceptedAppVersion, '1.0.0');
    assert.ok(!Number.isNaN(Date.parse(saved.legalAcceptedAt)));
    assert.equal(saved.id, 'acct_1');
    assert.equal(saved.passwordHash, 'h', 'rest of the auth record kept');
    assert.equal(h.calls.unlocked, 1);
    assert.equal(h.modal().classList.contains('active'), false, 'modal closed');
});

test('older accepted version: accepting without the checkbox shows an error and saves nothing', async () => {
    const h = signInBox();
    await h.run();
    await h.fns.handleLegalAcceptance();
    assert.deepEqual(h.calls.saved, []);
    assert.equal(h.calls.unlocked, 0);
    assert.equal(h.doc.els['legal-modal-error'].style.display, 'block');
});

test('older accepted version: declining returns to the sign-in screen without saving', async () => {
    const h = signInBox();
    await h.run();
    h.fns.declineLegalAcceptance();
    assert.equal(h.modal().classList.contains('active'), false);
    assert.equal(h.calls.reloads, 1, 'reloads to the sign-in screen, as Lock does');
    assert.equal(h.g.sessionDek, null);
    assert.equal(h.g.sessionPassword, null);
    assert.deepEqual(h.calls.saved, []);
    assert.equal(h.calls.unlocked, 0);
});

// ── 3. Already accepted ────────────────────────────────────────────────────

test('already accepted: unlocks directly without the modal', async () => {
    const h = signInBox({ record: account({ legalAcceptedVersion: LEGAL.LEGAL_BUNDLE_VERSION }) });
    await h.run();
    assert.equal(h.calls.unlocked, 1);
    assert.equal(h.modal().classList.contains('active'), false);
    assert.deepEqual(h.calls.saved, []);
    assert.deepEqual(h.calls.errors, []);
});

// ── 4. Bad bundle or markup never hangs silently ───────────────────────────

test('a bundle entry without text (e.g. a removed document id) is skipped and the modal still shows', async () => {
    const bundle = clone(LEGAL.LEGAL_BUNDLE);
    bundle.documents.push({ id: 'ai-disclaimer', title: 'AI Feature Disclaimer', version: '1.0' });
    const h = signInBox({ bundle });
    await h.run();
    assert.ok(h.modal().classList.contains('active'));
    assert.ok(!h.doc.els['legal-modal-documents'].innerHTML.includes('undefined'));
    assert.deepEqual(h.calls.errors, []);
});

test('no documents to show: the sign-in finishes with a visible, logged error and no session', async () => {
    const h = signInBox({ bundle: { version: '2.0', documents: [] } });
    await h.run();
    assert.equal(h.modal().classList.contains('active'), false);
    assert.equal(h.calls.errors.length, 1);
    assert.equal(h.calls.errors[0][0], 'login-error');
    assert.match(h.calls.errors[0][1], /legal terms/);
    assert.equal(h.calls.logged.length, 1);
    assert.equal(h.g.sessionDek, null);
    assert.equal(h.g.sessionPassword, null);
    assert.equal(h.calls.unlocked, 0);
});

test('missing modal markup: a visible, logged error instead of a silent stop', async () => {
    const h = signInBox({ missing: ['legal-acceptance-modal'] });
    await h.run();
    assert.equal(h.calls.errors.length, 1);
    assert.match(h.calls.errors[0][1], /modal not found/);
    assert.equal(h.calls.logged.length, 1);
    assert.equal(h.g.sessionPassword, null);
    assert.equal(h.calls.unlocked, 0);
});

test('an error outside the sign-in try block is logged and shown', async () => {
    const h = signInBox({ getAuth: async () => { throw new Error('store unavailable'); } });
    await h.run();
    assert.deepEqual(h.calls.errors, [['login-error', 'Sign-in failed: store unavailable']]);
    assert.equal(h.calls.logged.length, 1);
    assert.equal(h.calls.unlocked, 0);
});
