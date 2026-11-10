// Batch 2: an editor left open during a re-sync can no longer overwrite a
// newer cloud change. Each open editor registers its record (auth.js
// _editorGuardOpen). When a re-sync or a cloud win replaces that record:
// a clean form reloads with a short notice; a form with unsaved edits is
// marked stale and shows a Reload bar; a save while stale does not write —
// the cloud version stays and the editor's version is kept as a conflict
// copy (same rule as D3). Trades have no rev, so they compare data.
// A record removed by the re-sync is not stale (D3 rule: editing keeps
// it); Trade Reflection says the trade was deleted instead of failing
// silently. window._denariiEditorGuardOff turns the guard off.
//
// Same harness as batch-d3.test.js: real functions are cut out of the
// browser scripts and run in a `with` scope (unknown globals are inert).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D3 = require('./helpers/d3-auth-fns');
const { fakeSupabase } = require('./helpers/fake-supabase');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const AUTH = read('js/auth.js');
const APP = read('Denarii.js');
const HTML = read('index.html');
const RV = read('js/pages/reviews.js');
const JNL = read('js/pages/journal.js');
const DP = read('js/pages/daily-planner.js');
const WP = read('js/pages/weekly-planner.js');
const SETTINGS = read('js/pages/settings.js');
const LIB = read('js/ai-library.js');
const BA = read('js/pages/broker-accounts.js');

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

function extractVar(src, re, name) {
    const m = re.exec(src);
    if (!m) throw new Error(name + ' not found');
    return m[0];
}

const inert = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
});

function sandbox(parts, vals, extraCode) {
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
    const fns = new Function('scope', 'with (scope) { return (function () {\n' + (extraCode || '') + '\n' + code +
        '\nreturn {' + names.join(',') + '};\n})(); }')(scope);
    return { fns, g: target };
}

// Another sandbox reads and writes the auth box's journalData.
function shareJournal(box, authBox) {
    Object.defineProperty(box.g, 'journalData', {
        get: () => authBox.g.journalData, set: v => { authBox.g.journalData = v; }, configurable: true,
    });
}

const clone = v => JSON.parse(JSON.stringify(v));
const tick = () => new Promise(r => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 40); i++) await tick(); }
const UID = 'u1';
const encrypt = (d, k) => 'E:' + k + ':' + JSON.stringify(d);
const decrypt = (s, k) => (typeof s === 'string' && s.indexOf('E:' + k + ':') === 0 ? JSON.parse(s.slice(('E:' + k + ':').length)) : null);

// ── Minimal DOM for the notice bar and the reflection editor ───────────────
function fakeDoc() {
    const byId = {};
    const mk = tag => {
        const el = {
            tagName: tag, id: '', style: {}, children: [], attrs: {}, listeners: {}, textContent: '', innerHTML: '',
            className: '', parentNode: null, value: '',
            classList: { _s: new Set(), add(c) { this._s.add(c); }, remove(c) { this._s.delete(c); }, contains(c) { return this._s.has(c); } },
            get firstChild() { return this.children[0]; },
            setAttribute(k, v) { this.attrs[k] = String(v); },
            getAttribute(k) { return k in this.attrs ? this.attrs[k] : null; },
            appendChild(c) { c.parentNode = this; this.children.push(c); if (c.id) byId[c.id] = c; return c; },
            addEventListener(t, f) { (this.listeners[t] = this.listeners[t] || []).push(f); },
            remove() {
                if (this.parentNode) { this.parentNode.children = this.parentNode.children.filter(x => x !== this); this.parentNode = null; }
                if (byId[this.id] === this) delete byId[this.id];
            },
            click() { (this.listeners.click || []).forEach(f => f()); },
            focus() {},
        };
        return el;
    };
    const body = mk('body');
    return {
        byId, body, createElement: mk,
        el(id) { return byId[id] || (byId[id] = Object.assign(mk('div'), { id })); },
        getElementById: id => byId[id] || null,
        querySelectorAll: () => [], querySelector: () => null,
    };
}
const noticeOf = doc => doc.getElementById('editor-sync-notice');
const noticeText = doc => (noticeOf(doc) ? noticeOf(doc).children[0].textContent : null);
const noticeButtons = doc => (noticeOf(doc) ? noticeOf(doc).children.filter(c => c.tagName === 'button').map(b => b.textContent) : []);

// ── auth.js box (D3 functions + the Batch 2 guard) ────────────────────────
const GUARD_FNS = ['_editorGuardOpen', '_editorGuardClose', '_editorGuardStale', '_editorGuardGone', '_editorGuardConflict',
    '_editorRecord', '_editorRecordSig', '_editorGuardHit', '_editorGuardsForRow', '_editorGuardsBeforeResync',
    '_editorGuardsApply', '_showEditorNotice', '_hideEditorNotice'];
const AUTH_FNS = [
    '_loadJournalFromSupabaseRows', '_fetchAllRows', '_mapSupabaseTradeRow',
    '_mapArrayRow', '_mapReviewRows', '_mapPlannerRows', '_mapUserMetaRows', '_toISOOrNull', '_groupRowsByKeySet',
    '_shadowSkipTrades', '_shadowWriteRowsAwaited', '_shadowWriteRows', '_executeShadowWrite',
    '_detectDirtyDomains', '_updateDomainSnapshots',
    '_withTimeout', '_cloudWriteAllowed', '_sessionMatchesAccount', '_mapDomainRows', '_rowKey', '_rowSig',
    '_changedRows', '_markRows', '_savePendingRows', '_recordPendingRows', '_setCloudBaseline',
    '_enterCloudPaused', '_overlayRecord', '_mergeCloudIntoLocal', '_keepCloudLoadSnapshot', '_showCloudLoadBanner',
    ...D3.D3_FNS, ...GUARD_FNS,
];
const AUTH_VARS = [
    extractVar(AUTH, /var _SHADOW_DOMAINS = \{[\s\S]*?\n\};/, '_SHADOW_DOMAINS'),
    extractVar(AUTH, /var _USER_META_KEYS = \[[\s\S]*?\];/, '_USER_META_KEYS'),
    extractVar(AUTH, /var _CLOUD_ARRAY_DOMAINS = \[[^\]]*\];/, '_CLOUD_ARRAY_DOMAINS'),
    extractVar(AUTH, /var _CLOUD_KEYED_DOMAINS = \[[^\]]*\];/, '_CLOUD_KEYED_DOMAINS'),
    "var _DEMO_BROKER_ID = 'ba_demo_pelosi';",
    'var _SB_PAGE_SIZE = 1000;',
    D3.d3Vars(AUTH),
].join('\n');

// ── reviews.js pieces (Daily/Weekly/Monthly/Yearly Reflection) ─────────────
const RV_FNS = ['skey', 'getRev', 'saveRev', 'blankRev', 'curRev', 'captureState', 'doSave', '_rvGuardId', '_rvNfPlain',
    '_rvFormRecord', '_rvReload', '_rvStaleSave', '_rvGuardOpen', '_rvClearDraft', '_rvDraftKey', '_rvNfToggle'];
const KEY = '2026-10-29';
const RKEY = 'daily|' + KEY;
const rec = (content, extra) => Object.assign({ content, nextFocus: { cont: [], stop: [], start: [] }, status: 'draft',
    createdAt: 1000, updatedAt: 1000 }, extra);

// One box: auth functions + the reflection editor, sharing journalData.
function makeBox(tables, over) {
    over = over || {};
    const settings = {};
    const doc = fakeDoc();
    const log = [];
    const client = fakeSupabase(clone(tables), { pk: true, rev: true });
    const win = Object.assign({ _denariiStorageMode: 'cloud_primary', _denariiSupabaseUid: UID,
        _denariiRefreshUI: () => {}, _invalidateCloudDash: () => {} }, over.window);
    const h = {};
    const vals = {
        window: win,
        SupabaseAuth: { isReady: () => true, getClient: () => client, supabaseGetSession: async () => ({ data: { user: { id: UID } } }) },
        journalData: {},
        sessionDek: 'dek', sessionPassword: 'pw', currentAccountId: 'acct',
        _cloudSignInFailed: false, _cloudBaselineReady: false, _cloudPaused: false,
        _rowBaseline: {}, _cloudPending: {}, _cloudLoadStatus: null, _domainSnapshots: {},
        _CLOUD_LOAD_TIMEOUT_MS: 20000,
        _lastShadowWriteMs: 0, _shadowWriteRunning: false, _shadowWritePending: false,
        _lastCloudSaveMs: 0, _firstCloudSaveDone: false,
        ...D3.d3State(),
        _editorGuards: {},
        STORE_NAME: 'journal', makeJournalKey: id => 'journal_' + id,
        getSetting: async k => settings[k], setSetting: async (k, v) => { settings[k] = v; },
        storeGet: async () => ({ encrypted: true, data: 'ENC', lastSaved: 't0' }), storePut: async () => {},
        saveJournalRecord: async () => {},
        encrypt, decrypt,
        navigator: { onLine: true },
        document: doc,
        // Notices that hide themselves wait for a later timer; the D3 conflict
        // flush (0 ms) still runs.
        setTimeout: (fn, ms) => (ms >= 1000 ? 0 : setTimeout(fn, ms)),
        // reviews.js
        _st: { daily: { periodKey: KEY } }, _saveTimer: null,
        DEFAULT_FOCUS: { daily: { cont: [], stop: [], start: [] } },
        showStatus: () => {},
        Autosave: { clear: k => log.push('clear:' + k), save: () => {}, load: () => null },
        renderReviewPage: type => { log.push('render:' + type); h.fns._rvGuardOpen(type, h.g._st[type].periodKey); },
        saveToIndexedDB: () => { h.pending.push(h.fns._shadowWriteRowsAwaited(h.g.journalData)); },
    };
    Object.assign(vals, over.vals);
    const box = sandbox([[AUTH, AUTH_FNS], [RV, RV_FNS]], vals, AUTH_VARS);
    Object.assign(h, box, { client, settings, doc, log, pending: [] });
    const editor = doc.el('rv-editor-daily');
    editor.innerHTML = over.form != null ? over.form : '';
    h.editor = editor;
    return h;
}

async function loaded(tables, over) {
    const h = makeBox(tables, over);
    const revs = {};
    const cloud = await h.fns._loadJournalFromSupabaseRows(h.client, UID, { strict: true, revs });
    h.g.journalData = clone(cloud);
    h.g._rowRev = revs;
    h.fns._setCloudBaseline(h.g.journalData, true, cloud);
    h.client.writes.length = 0;
    return h;
}

async function flush(h) { await settle(); await Promise.all(h.pending); await settle(); }
const storedReview = h => h.client.tables.reviews.find(r => r.review_key === KEY);
const conflictCopies = async h => { await settle(); return ((await h.settings['cloudConflicts:acct']) || []).map(c => Object.assign({}, c, { local: decrypt(c.local, 'dek') })); };
const reviewTables = content => ({ reviews: [{ user_id: UID, review_type: 'daily', review_key: KEY, data: rec(content), rev: 1 }] });

// Opens today's Daily Reflection showing `form`.
async function openReflection(content, form) {
    const h = await loaded(reviewTables(content), { form });
    h.fns._rvGuardOpen('daily', KEY);
    return h;
}

function changeInCloud(h, content, rev) {
    Object.assign(storedReview(h), { data: rec(content, { updatedAt: 5000 }), rev });
}

// ── 1. Re-sync, unsaved edits: stale; the save keeps a copy and writes nothing ──

test('re-sync brings a newer rev for an open reflection with unsaved edits → stale, Reload bar; the save writes nothing, cloud wins, copy kept', async () => {
    const h = await openReflection('v1', 'v1 + mine');
    changeInCloud(h, 'B2', 2);
    const r = await h.fns._cloudResync('online');
    assert.equal(r.ok, true);
    assert.equal(h.g._editorGuards['review:daily'].stale, true);
    assert.equal(h.g.journalData.reviews[RKEY].content, 'B2');
    assert.equal(noticeText(h.doc), 'This item was updated on another device.');
    assert.deepEqual(noticeButtons(h.doc), ['Reload', 'Dismiss']);

    h.client.writes.length = 0;
    h.fns.doSave('daily', KEY, {});
    await flush(h);
    assert.equal(h.client.writes.filter(w => w.table === 'reviews').length, 0, 'nothing sent');
    assert.equal(storedReview(h).data.content, 'B2');
    assert.equal(h.g.journalData.reviews[RKEY].content, 'B2');
    assert.equal(h.g._cloudConflictCount, 1);
    const copies = await conflictCopies(h);
    assert.equal(copies.length, 1);
    assert.equal(copies[0].key, RKEY);
    assert.equal(copies[0].local.content, 'v1 + mine');
    assert.equal(copies[0].reason, 'edited here while another device changed it');
    assert.equal(h.g._editorGuards['review:daily'].stale, false, 'reloaded editor is fresh');
    assert.equal(noticeOf(h.doc), null, 'bar removed');
});

test('after a stale save, typing on the reloaded editor saves normally', async () => {
    const h = await openReflection('v1', 'v1 + mine');
    changeInCloud(h, 'B2', 2);
    await h.fns._cloudResync('online');
    h.fns.doSave('daily', KEY, {});            // stale → copy + reload
    await flush(h);
    h.editor.innerHTML = 'B2 + more';          // typing on the reloaded editor
    h.client.writes.length = 0;
    h.fns.doSave('daily', KEY, {});
    await flush(h);
    assert.equal(storedReview(h).data.content, 'B2 + more');
    assert.equal(h.g._cloudConflictCount, 1, 'no new conflict');
});

// ── 2. Re-sync with no change for that record ──────────────────────────────

test('re-sync with no change for the open record → not stale; the save writes as before (D3 unchanged)', async () => {
    const tables = reviewTables('v1');
    tables.reviews.push({ user_id: UID, review_type: 'daily', review_key: '2026-10-28', data: rec('other'), rev: 1 });
    const h = await loaded(tables, { form: 'v1' });
    h.fns._rvGuardOpen('daily', KEY);
    Object.assign(h.client.tables.reviews.find(r => r.review_key === '2026-10-28'), { data: rec('other B'), rev: 2 });
    await h.fns._cloudResync('visible');
    assert.equal(h.g._editorGuards['review:daily'].stale, false);
    assert.equal(noticeOf(h.doc), null);
    h.editor.innerHTML = 'v1 edited';
    h.fns.doSave('daily', KEY, {});
    await flush(h);
    assert.equal(storedReview(h).data.content, 'v1 edited');
    assert.equal(storedReview(h).rev, 2);
    assert.equal(h.g._cloudConflictCount, 0);
});

// ── 3. A saved-but-unsent row at re-sync ───────────────────────────────────

test('row saved here but not sent at re-sync → not stale; the D3 conflict runs once (no double count), clean editor reloads', async () => {
    const h = await openReflection('v1', 'v1');
    h.fns._enterCloudPaused('offline');
    h.editor.innerHTML = 'offline A';
    h.fns.doSave('daily', KEY, {});            // pending (paused)
    await flush(h);
    assert.ok(h.g._cloudPending.reviews[RKEY]);
    changeInCloud(h, 'online B', 2);
    await h.fns._cloudResync('online');
    await flush(h);
    assert.equal(storedReview(h).data.content, 'online B', 'cloud wins (D3)');
    assert.equal(h.g.journalData.reviews[RKEY].content, 'online B');
    assert.equal(h.g._cloudConflictCount, 1, 'one conflict, not two');
    assert.equal((await conflictCopies(h))[0].local.content, 'offline A');
    assert.equal(h.g._editorGuards['review:daily'].stale, false);
    assert.ok(h.log.includes('render:daily'), 'editor reloaded with the winning version');
    assert.equal(noticeText(h.doc), 'Updated from another device.');
});

// ── 4. This browser's own save between open and re-sync ────────────────────

test('own save moves the rev between open and re-sync → not stale, no notice', async () => {
    const h = await openReflection('v1', 'v1');
    h.editor.innerHTML = 'mine';
    h.fns.doSave('daily', KEY, {});
    await flush(h);
    assert.equal(storedReview(h).rev, 2);
    await h.fns._cloudResync('visible');
    assert.equal(h.g._editorGuards['review:daily'].stale, false);
    assert.equal(noticeOf(h.doc), null);
    assert.equal(h.log.filter(l => l === 'render:daily').length, 0);
});

// ── 5. A cloud win while the editor is open ────────────────────────────────

test('cloud win (D3 conflict from this editor\'s own autosave) on a clean form → reload, no second copy; next save does not undo the win', async () => {
    const h = await openReflection('v1', 'v1');
    changeInCloud(h, 'B2', 2);                 // another device, no re-sync here yet
    h.editor.innerHTML = 'mine';
    h.fns.doSave('daily', KEY, {});            // rev 1 no longer matches → conflict
    await flush(h);
    assert.equal(h.g._cloudConflictCount, 1);
    assert.equal(h.g.journalData.reviews[RKEY].content, 'B2');
    assert.ok(h.log.includes('render:daily'), 'reloaded');
    assert.equal(noticeText(h.doc), 'Updated from another device.');
    assert.equal(h.g._editorGuards['review:daily'].stale, false);
    assert.equal((await conflictCopies(h)).length, 1);
});

test('cloud win while the form has newer unsaved typing → stale; the next autosave keeps that typing as a copy instead of undoing the win', async () => {
    const h = await openReflection('v1', 'v1');
    changeInCloud(h, 'B2', 2);
    h.editor.innerHTML = 'mine';
    h.fns.saveRev('daily', KEY, Object.assign(clone(h.g.journalData.reviews[RKEY]), { content: 'mine' }));
    h.editor.innerHTML = 'mine + more';        // typed while that save was in flight
    await flush(h);
    assert.equal(h.g._editorGuards['review:daily'].stale, true);
    h.client.writes.length = 0;
    h.fns.doSave('daily', KEY, {});
    await flush(h);
    assert.equal(h.client.writes.filter(w => w.table === 'reviews').length, 0);
    assert.equal(storedReview(h).data.content, 'B2');
    const copies = await conflictCopies(h);
    assert.equal(copies.length, 2);
    assert.equal(copies[1].local.content, 'mine + more');
});

// ── 7. Reload never brings back the old draft ──────────────────────────────

test('reflection reload clears the localStorage draft before it redraws', async () => {
    const h = await openReflection('v1', 'v1 + mine');
    changeInCloud(h, 'B2', 2);
    await h.fns._cloudResync('online');
    h.fns.doSave('daily', KEY, {});
    const i = h.log.indexOf('clear:rv-draft-' + RKEY), j = h.log.indexOf('render:daily');
    assert.ok(i >= 0 && j > i, 'draft cleared, then render: ' + h.log.join(','));
});

// ── 8. Notice ──────────────────────────────────────────────────────────────

test('notice: clean form reloads with the short notice; dirty form shows one Reload bar; Reload keeps a copy and reloads; close removes it', async () => {
    const clean = await openReflection('v1', 'v1');
    changeInCloud(clean, 'B2', 2);
    await clean.fns._cloudResync('online');
    assert.equal(noticeText(clean.doc), 'Updated from another device.');
    assert.deepEqual(noticeButtons(clean.doc), ['Dismiss']);
    assert.ok(clean.log.includes('render:daily'));
    assert.equal(clean.g._cloudConflictCount, 0, 'a clean reload is not a conflict');

    const dirty = await openReflection('v1', 'v1 + mine');
    changeInCloud(dirty, 'B2', 2);
    await dirty.fns._cloudResync('online');
    changeInCloud(dirty, 'B3', 3);
    dirty.g._cloudResyncRunning = false;
    await dirty.fns._cloudResync('online');
    assert.equal(dirty.doc.body.children.filter(c => c.id === 'editor-sync-notice').length, 1, 'one bar');
    noticeOf(dirty.doc).children.find(c => c.textContent === 'Reload').click();
    await flush(dirty);
    assert.equal(dirty.g._cloudConflictCount, 1);
    assert.equal((await conflictCopies(dirty))[0].local.content, 'v1 + mine');
    assert.ok(dirty.log.includes('render:daily'));
    assert.equal(noticeOf(dirty.doc), null);
    assert.equal(dirty.client.tables.reviews[0].data.content, 'B3');

    const closing = await openReflection('v1', 'v1 + mine');
    changeInCloud(closing, 'B2', 2);
    await closing.fns._cloudResync('online');
    assert.ok(noticeOf(closing.doc));
    closing.fns._editorGuardClose('review:daily');
    assert.equal(noticeOf(closing.doc), null);
});

test('a closed form (isOpen false) is only marked stale: no reload, no notice', async () => {
    const h = await loaded(reviewTables('v1'));
    let reloads = 0;
    h.fns._editorGuardOpen('x', 'reviews', RKEY, { isOpen: () => false, isDirty: () => false, reload: () => { reloads++; } });
    changeInCloud(h, 'B2', 2);
    await h.fns._cloudResync('online');
    assert.equal(h.fns._editorGuardStale('x', RKEY), true);
    assert.equal(reloads, 0);
    assert.equal(noticeOf(h.doc), null);
});

test('switch: window._denariiEditorGuardOff = true restores the old behavior (no stale, no notice, save writes)', async () => {
    const h = await openReflection('v1', 'v1 + mine');
    h.g.window._denariiEditorGuardOff = true;
    changeInCloud(h, 'B2', 2);
    await h.fns._cloudResync('online');
    assert.equal(h.fns._editorGuardStale('review:daily'), false);
    assert.equal(noticeOf(h.doc), null);
    h.fns.doSave('daily', KEY, {});
    await flush(h);
    assert.equal(storedReview(h).data.content, 'v1 + mine', 'old behavior: overwritten');
});

// ── Decision 6: removed while open (reflection keeps the D3 rule) ──────────

test('record deleted on another device while the reflection is open → not stale; editing keeps it (D3 rule)', async () => {
    const h = await openReflection('v1', 'v1 + mine');
    h.client.tables.reviews.length = 0;
    await h.fns._cloudResync('online');
    assert.equal(h.g.journalData.reviews[RKEY], undefined);
    assert.equal(h.fns._editorGuardStale('review:daily'), false);
    assert.equal(h.fns._editorGuardGone('review:daily'), true);
    assert.equal(noticeOf(h.doc), null, 'no goneMessage for reflections');
    h.fns.doSave('daily', KEY, {});
    await flush(h);
    assert.equal(storedReview(h).data.content, 'v1 + mine');
});

// ── 6 + Decision 6: Trade Reflection ───────────────────────────────────────

const JNL_FNS = ['_jnlFmtLocal', '_jnlReadExecInputs', '_jnlChanged', '_jnlShowOpenHint',
    '_jnlSideLabel', '_jnlFmtPnl', '_jnlRenderEditorHeader', '_jnlCommitTrade', '_jnlIsWebull',
    '_jnlScheduleCommit', '_jnlFlushCommit', '_jnlRecalcMetrics', 'selectTradeForJournal',
    '_jnlReloadSoon', '_jnlTradeMissing', '_jnlGuardOpen'];
const JNL_CONSTS = new Function(
    JNL.match(/var _JNL_EXEC_IDS[\s\S]*?var _JNL_PNL_IDS\s*=[^;]*;/)[0] + '\n' +
    JNL.match(/var _JNL_GUARD = [^\n]*;/)[0] + '\n' + JNL.match(/var _JNL_GONE_MSG = [^\n]*;/)[0] +
    '\nreturn { _JNL_EXEC_IDS, _JNL_PNL_IDS, _JNL_GUARD, _JNL_GONE_MSG };')();

function formDocument() {
    const els = {};
    const mk = id => ({
        id, value: '', style: {}, dataset: {}, textContent: '', innerHTML: '', disabled: false,
        addEventListener() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [],
        focus() {}, click() {}, remove() {}, appendChild() {}, closest: () => ({ style: {}, appendChild() {}, removeChild() {} }),
    });
    return {
        getElementById: id => (id === 'field-bubble' ? null : (els[id] = els[id] || mk(id))),
        querySelectorAll: () => [], createElement: () => mk(''),
    };
}

const tradeRow = notes => ({ user_id: UID, id: 't1', symbol: 'AAA', direction: 'long', quantity: 1, entry_price: 10, exit_price: 11,
    entry_time: '2026-10-28T14:00:00.000Z', exit_time: '2026-10-28T15:00:00.000Z', pnl: 1, notes });

async function openTrade(notes) {
    const a = await loaded({ trades: [tradeRow(notes)] });
    const document = formDocument();
    const saves = [], statuses = [], log = [], selects = [];
    const window = { _isOpenTrade: () => false, scrollTo() {} };
    const j = sandbox([[JNL, JNL_FNS], [APP, ['_restoreTradeInPlace']]], Object.assign({}, JNL_CONSTS, {
        document, window,
        console: { warn() {}, log() {}, error() {} },
        setTimeout: fn => { fn(); return 1; }, clearTimeout: () => {},
        _jnlDirty: false, _jnlFillsDirty: false, _jnlSplitting: false, _jnlLoaded: {}, _jnlCommitTimer: null, _jnlCommitDebounceMs: 1000,
        _JNL_STATUS_ID: 'jnl-autosave-status', _jnlSelectedStrategy: null,
        _jnlLoadDraft: () => null, _jnlSaveDraft: () => {}, _jnlClearDraft: id => log.push('clear:' + id),
        _jnlGetNotes: () => document.getElementById('jnl-notes').innerHTML,
        _jnlSetNotes: html => { document.getElementById('jnl-notes').innerHTML = html; },
        _jnlGetTagsFromRows: () => [], _getRowData: () => [],
        _contractMultiplier: () => 1, _computeTradeMetrics: () => ({}),
        Autosave: { showStatus: (id, s) => statuses.push(s) },
        _isCloudPrimarySave: () => true,
        _saveTradeToSupabase: async t => { saves.push(clone(t)); return { success: true }; },
        _triggerCloudDashRefresh: () => {},
        saveToIndexedDB: async () => {}, renderJournalTradeList: () => {}, updateDashboard: () => {},
        _editorGuardOpen: a.fns._editorGuardOpen, _editorGuardClose: a.fns._editorGuardClose,
        _editorGuardStale: a.fns._editorGuardStale, _editorGuardConflict: a.fns._editorGuardConflict,
        _showEditorNotice: a.fns._showEditorNotice,
    }));
    shareJournal(j, a);
    const realSelect = j.fns.selectTradeForJournal;
    j.fns.selectTradeForJournal('t1');
    const notesEl = document.getElementById('jnl-notes');
    return { a, j, document, notesEl, saves, statuses, log, selects, window, realSelect };
}
const storedTrade = a => a.client.tables.trades.find(t => t.id === 't1');

test('Trade Reflection: re-sync changes the trade\'s notes while the form has unsaved edits → stale; the commit sends nothing, the trade stays the cloud version, a copy is kept, the draft is cleared and the form reloads', async () => {
    const t = await openTrade('<p>v1</p>');
    assert.equal(t.notesEl.innerHTML, '<p>v1</p>');
    t.notesEl.innerHTML = '<p>mine</p>';
    t.j.g._jnlDirty = true;
    storedTrade(t.a).notes = '<p>B</p>';
    await t.a.fns._cloudResync('online');
    assert.equal(t.a.g._editorGuards['trade-reflection'].stale, true, 'trades: detected without a rev');
    assert.equal(noticeText(t.a.doc), 'This item was updated on another device.');

    const ok = await t.j.fns._jnlCommitTrade();
    assert.equal(ok, false);
    assert.equal(t.saves.length, 0, 'no cloud save');
    const trade = t.a.g.journalData.trades.find(x => x.id === 't1');
    assert.equal(trade.notes, '<p>B</p>', 'restored to the cloud version');
    assert.equal(storedTrade(t.a).notes, '<p>B</p>');
    assert.equal(t.a.g._cloudConflictCount, 1);
    const copies = await conflictCopies(t.a);
    assert.equal(copies[0].domain, 'trades');
    assert.equal(copies[0].local.notes, '<p>mine</p>');
    assert.ok(t.log.includes('clear:t1'), 'draft cleared');
    assert.equal(t.notesEl.innerHTML, '<p>B</p>', 'form reloaded');
    assert.equal(t.a.g._editorGuards['trade-reflection'].stale, false);
    assert.equal(t.j.g._jnlDirty, false);
});

test('Trade Reflection: clean form → reloads with the short notice, no conflict; a later edit saves normally', async () => {
    const t = await openTrade('<p>v1</p>');
    storedTrade(t.a).notes = '<p>B</p>';
    await t.a.fns._cloudResync('visible');
    assert.equal(t.notesEl.innerHTML, '<p>B</p>');
    assert.equal(noticeText(t.a.doc), 'Updated from another device.');
    assert.equal(t.a.g._cloudConflictCount, 0);
    t.notesEl.innerHTML = '<p>B + mine</p>';
    t.j.g._jnlDirty = true;
    assert.equal(await t.j.fns._jnlCommitTrade(), true);
    assert.equal(t.saves[0].notes, '<p>B + mine</p>');
});

test('Trade Reflection: a re-sync that changes nothing in the trade → not stale', async () => {
    const t = await openTrade('<p>v1</p>');
    t.notesEl.innerHTML = '<p>mine</p>';
    t.j.g._jnlDirty = true;
    await t.a.fns._cloudResync('visible');
    assert.equal(t.a.g._editorGuards['trade-reflection'].stale, false);
    assert.equal(await t.j.fns._jnlCommitTrade(), true);
    assert.equal(t.saves[0].notes, '<p>mine</p>');
});

test('Trade Reflection (decision 6): trade deleted on another device → app notice at re-sync and on save, never a silent failure', async () => {
    const t = await openTrade('<p>v1</p>');
    t.notesEl.innerHTML = '<p>mine</p>';
    t.j.g._jnlDirty = true;
    t.a.client.tables.trades.length = 0;
    await t.a.fns._cloudResync('online');
    assert.equal(t.a.g.journalData.trades.length, 0);
    assert.equal(noticeText(t.a.doc), JNL_CONSTS._JNL_GONE_MSG);
    assert.deepEqual(noticeButtons(t.a.doc), ['Dismiss'], 'sticky, no Reload');
    noticeOf(t.a.doc).remove();
    assert.equal(await t.j.fns._jnlCommitTrade(), false);
    assert.equal(t.saves.length, 0);
    assert.equal(noticeText(t.a.doc), JNL_CONSTS._JNL_GONE_MSG);
    assert.equal(noticeOf(t.a.doc).getAttribute('data-editor'), 'trade-reflection-gone', 'not hidden by closing the editor');
    assert.equal(t.statuses[t.statuses.length - 1], 'failed');
});

// ── Planners ───────────────────────────────────────────────────────────────

const DP_FNS = ['storageKey', 'getPlanner', 'savePlanner', 'collectData', 'doSave', 'dpBfToggle',
    '_dpFormDirty', '_dpReload', '_dpStaleSave', '_dpGuardOpen'];

async function openPlanner(content, form) {
    const a = await loaded({ daily_planners: [{ user_id: UID, planner_key: 'dp|' + KEY, rev: 1,
        data: { bias: '', keyEvents: '', watchlist: '', content, behavioral: {}, updatedAt: '2026-10-29T10:00:00.000Z' } }] });
    const doc = fakeDoc();
    const ed = doc.el('dp-editor');
    ed.innerHTML = form;
    const navs = [];
    const p = sandbox([[DP, DP_FNS]], {
        document: doc, _dpKey: KEY, _dpSaveTimer: 7,
        _DP_GUARD: /var _DP_GUARD = '([^']+)';/.exec(DP)[1],
        showStatus: () => {}, renderBfItems: () => {},
        navigateToDate: k => { navs.push(k); ed.innerHTML = p.g.journalData.dailyPlanners['dp|' + k].content; p.fns._dpGuardOpen(k); },
        saveToIndexedDB: () => { a.pending.push(a.fns._shadowWriteRowsAwaited(a.g.journalData)); },
        _editorGuardOpen: a.fns._editorGuardOpen, _editorGuardStale: a.fns._editorGuardStale, _editorGuardConflict: a.fns._editorGuardConflict,
    });
    shareJournal(p, a);
    p.fns._dpGuardOpen(KEY);
    return { a, p, ed, navs };
}
const storedPlanner = a => a.client.tables.daily_planners[0];

test('Daily Planner: unsaved edits at re-sync → stale; the save keeps a copy, writes nothing, reloads (old timer cleared first)', async () => {
    const t = await openPlanner('plan v1', 'plan v1 + mine');
    Object.assign(storedPlanner(t.a), { data: Object.assign({}, storedPlanner(t.a).data, { content: 'plan B' }), rev: 2 });
    await t.a.fns._cloudResync('online');
    assert.equal(t.a.g._editorGuards['daily-planner'].stale, true);
    t.a.client.writes.length = 0;
    t.p.fns.doSave();
    await flush(t.a);
    assert.equal(t.a.client.writes.filter(w => w.table === 'daily_planners').length, 0);
    assert.equal(storedPlanner(t.a).data.content, 'plan B');
    assert.equal((await conflictCopies(t.a))[0].local.content, 'plan v1 + mine');
    assert.deepEqual(t.navs, [KEY]);
    assert.equal(t.p.g._dpSaveTimer, null, 'the stale timer id cannot re-save the old form');
    assert.equal(t.ed.innerHTML, 'plan B');
});

test('Daily Planner: Continue/Stop/Focus toggle while stale → copy, no write, items not redrawn from the stale form', async () => {
    const t = await openPlanner('plan v1', 'plan v1 + mine');
    Object.assign(storedPlanner(t.a), { data: Object.assign({}, storedPlanner(t.a).data, { content: 'plan B', behavioral: { cont: [{ text: 'x', done: false }] } }), rev: 2 });
    await t.a.fns._cloudResync('online');
    t.a.client.writes.length = 0;
    t.p.fns.dpBfToggle('cont', 0, true);
    await flush(t.a);
    assert.equal(t.a.client.writes.length, 0);
    assert.equal(t.a.g._cloudConflictCount, 1);
});

test('Weekly Planner has the same guard (source)', () => {
    assert.match(WP, /function savePlanner\(wk, data\) \{\s*if \(!journalData\) return;\s*if \(_wpStaleSave\(wk, data\)\) return false;/);
    assert.match(WP, /_editorGuardOpen\(_WP_GUARD, 'weeklyPlanners', storageKey\(wk\)/);
    assert.match(WP, /if \(data\) populateForm\(data\);\s*showStatus\(''\);\s*_wpGuardOpen\(key\);/);
    assert.match(WP, /clearTimeout\(_wpSaveTimer\);\s*_wpSaveTimer = null;/);
    for (const fn of ['wpBfAdd', 'wpBfToggle', 'wpBfRemove', 'doSave', 'wpAppendAI']) {
        assert.match(extractFunction(WP, fn), /savePlanner\(.*\) === false\) return;/, fn);
    }
});

// ── Decision 5: tag, AI prompt and broker account editors ──────────────────

test('Tag editor: re-sync replaces the tag while the form has edits → Save keeps a copy, sends nothing, reloads the form', async () => {
    const a = await loaded({ tags: [{ user_id: UID, id: 'tg1', name: 'A', category: 'Setups', description: '', rev: 1 }] });
    const doc = fakeDoc();
    const sent = [];
    const s = sandbox([[SETTINGS, ['editTag', '_tagFormSig', '_tagStaleSave', '_tagGuardOpen', 'cancelTagForm', 'saveTag']]], {
        document: doc, editingTagId: null,
        closeTagMenu() {}, ensureTagsArray() {}, populateCategoryDropdowns() {}, showSettingsMsg() {}, renderTagsTable() {},
        _isCloudPrimarySave: () => true, _saveTagToSupabase: t => sent.push(clone(t)), saveToIndexedDB: async () => {},
        _editorGuardOpen: a.fns._editorGuardOpen, _editorGuardClose: a.fns._editorGuardClose,
        _editorGuardStale: a.fns._editorGuardStale, _editorGuardConflict: a.fns._editorGuardConflict,
    });
    shareJournal(s, a);
    ['tag-form-title', 'tag-name-input', 'tag-category-input', 'tag-desc-input', 'tag-form-card'].forEach(id => doc.el(id));
    s.fns.editTag('tg1');
    doc.el('tag-name-input').value = 'A mine';
    Object.assign(a.client.tables.tags[0], { name: 'B', rev: 2 });
    await a.fns._cloudResync('online');
    assert.equal(a.g._editorGuards['tag-editor'].stale, true);
    await s.fns.saveTag();
    await settle();
    assert.equal(sent.length, 0);
    assert.equal(a.g.journalData.tags[0].name, 'B');
    assert.equal((await conflictCopies(a))[0].local.name, 'A mine');
    assert.equal(doc.el('tag-name-input').value, 'B', 'form reloaded');

    // Clean form: reloads by itself; cancel closes the guard.
    Object.assign(a.client.tables.tags[0], { name: 'C', rev: 3 });
    await a.fns._cloudResync('online');
    assert.equal(doc.el('tag-name-input').value, 'C');
    s.fns.cancelTagForm();
    assert.equal(a.g._editorGuards['tag-editor'], undefined);
});

test('AI prompt editor: re-sync replaces the prompt while the form has edits → Save keeps a copy, saves nothing, reopens it', async () => {
    const a = await loaded({ ai_prompts: [{ user_id: UID, id: 'usr-1', title: 'T1', description: '', prompt_text: 'p1', category: 'All', style: 'All', rev: 1 }] });
    const doc = fakeDoc();
    const modal = doc.el('prompt-editor-modal');
    ['pe-title', 'pe-description', 'pe-category', 'pe-style', 'pe-prompttext', 'prompt-editor-title', 'pe-msg'].forEach(id => doc.el(id));
    const saved = [];
    let lib;
    const global = {
        _DenAriiPrompts: {
            getPromptById: id => (lib.g.journalData.aiPrompts || []).find(p => p.id === id) || null,
            saveUserPrompt: async d => { saved.push(d); },
        },
        _editorGuardOpen: a.fns._editorGuardOpen, _editorGuardClose: a.fns._editorGuardClose,
        _editorGuardStale: a.fns._editorGuardStale, _editorGuardConflict: a.fns._editorGuardConflict,
    };
    lib = sandbox([[LIB, ['openEditor', 'closeEditor', '_formSig', '_staleSave', '_guardOpen', 'saveFromEditor', '_getVal', '_setVal']]], {
        document: doc, global, window: {}, _editingId: null,
        _PE_FIELDS: ['pe-title', 'pe-description', 'pe-category', 'pe-style', 'pe-prompttext'],
        render() {}, _showToast() {}, _editorMsg() {},
    });
    shareJournal(lib, a);
    lib.fns.openEditor('usr-1');
    assert.ok(modal.classList.contains('active'));
    doc.el('pe-prompttext').value = 'p1 mine';
    Object.assign(a.client.tables.ai_prompts[0], { prompt_text: 'pB', rev: 2 });
    await a.fns._cloudResync('online');
    assert.equal(a.g._editorGuards['prompt-editor'].stale, true);
    await lib.fns.saveFromEditor();
    assert.equal(saved.length, 0);
    assert.equal((await conflictCopies(a))[0].local.promptText, 'p1 mine');
    assert.equal(doc.el('pe-prompttext').value, 'pB', 'reopened with the newer prompt');
    lib.fns.closeEditor();
    assert.equal(a.g._editorGuards['prompt-editor'], undefined);
});

test('Broker account editor: stale Save keeps a copy and reopens (source + helpers)', async () => {
    const a = await loaded({ broker_accounts: [{ user_id: UID, id: 'ba1', broker: 'X', display_name: 'Old', rev: 1 }] });
    const doc = fakeDoc();
    ['ba-broker', 'ba-custom-broker', 'ba-account-number', 'ba-display-name', 'ba-trading-style', 'ba-is-default', 'ba-visible', 'ba-edit-id']
        .forEach(id => doc.el(id));
    const modal = doc.el('broker-account-modal');
    const opened = [];
    const b = sandbox([[BA, ['_baFormValues', '_baStaleSave', '_baGuardOpen']]], {
        document: doc, window: { selectedBrokerColor: '#fff' },
        getBrokerAccount: id => b.g.journalData.brokerAccounts.find(x => x.id === id),
        openBrokerAccountModal: id => { opened.push(id); doc.el('ba-display-name').value = b.g.journalData.brokerAccounts[0].displayName; b.fns._baGuardOpen(id); },
        _editorGuardOpen: a.fns._editorGuardOpen, _editorGuardConflict: a.fns._editorGuardConflict,
    });
    shareJournal(b, a);
    doc.el('ba-broker').value = 'X';
    doc.el('ba-display-name').value = 'Old';
    doc.el('ba-edit-id').value = 'ba1';
    modal.classList.add('active');
    b.fns._baGuardOpen('ba1');
    doc.el('ba-display-name').value = 'Mine';
    Object.assign(a.client.tables.broker_accounts[0], { display_name: 'New', rev: 2 });
    await a.fns._cloudResync('online');
    assert.equal(a.fns._editorGuardStale('broker-account-editor', 'ba1'), true);
    b.fns._baStaleSave('ba1');
    assert.equal((await conflictCopies(a))[0].local.displayName, 'Mine');
    assert.deepEqual(opened, ['ba1']);
    assert.equal(doc.el('ba-display-name').value, 'New');
    // The submit handler checks the guard before any save or Webull link work.
    const submit = BA.slice(BA.indexOf("getElementById('broker-account-form')?.addEventListener('submit'"));
    const check = submit.indexOf("_editorGuardStale('broker-account-editor', editId) === true");
    assert.ok(check > 0 && check < submit.indexOf('_wbRunSave('));
    // Fee, cash and visibility changes edit the current record directly: no guard.
    for (const fn of ['addRecurringFeeEntry', 'updateRecurringFeeEntry', 'addCashAdjustmentEntry', 'toggleBrokerVisibility']) {
        assert.doesNotMatch(extractFunction(BA, fn), /_editorGuard/, fn);
    }
});

// ── 9. Source checks: every editor opens and checks a guard ────────────────

test('source: each editor opens its guard and checks it before saving', () => {
    // Reflections
    assert.match(RV, /function doSave\(type, key, opts\) \{\s*if \(_rvStaleSave\(type, key\)\) return false;/);
    for (const fn of ['_rvNfAdd', '_rvNfToggle', '_rvNfRemove']) {
        assert.match(extractFunction(RV, fn), /^(async )?function \w+\([^)]*\) \{\s*if \(_rvStaleSave\(type, key\)\) return;/, fn);
    }
    assert.match(extractFunction(RV, 'renderReviewPage'), /_rvGuardOpen\(type, key\);\s*\}$/);
    // Trade Reflection
    assert.match(extractFunction(JNL, 'selectTradeForJournal'), /_jnlGuardOpen\(tradeId\);\s*\}$/);
    const commit = extractFunction(JNL, '_jnlCommitTrade');
    assert.match(commit, /if \(!trade\) \{ _jnlTradeMissing\(\); return false; \}/);
    assert.ok(commit.indexOf('_editorGuardStale(_JNL_GUARD, trade.id) === true') < commit.indexOf('_saveTradeToSupabase('));
    assert.match(extractFunction(JNL, 'closeJournalEditor'), /_editorGuardClose\(_JNL_GUARD\)/);
    // Daily planner
    assert.match(DP, /function savePlanner\(dk, data\) \{\s*if \(!journalData\) return;\s*if \(_dpStaleSave\(dk, data\)\) return false;/);
    assert.match(DP, /showStatus\(''\);\s*_dpGuardOpen\(key\);/);
    // Strategy editor
    assert.match(extractFunction(APP, 'editStrategy'), /_seRenderAll\(\);\s*_seGuardOpen\(id\);\s*\}$/);
    assert.match(extractFunction(APP, 'closeStrategyEditor'), /_editorGuardClose\('strategy-editor'\)/);
    const stratSubmit = APP.slice(APP.indexOf("getElementById('strategy-form')?.addEventListener('submit'"));
    const sc = stratSubmit.indexOf("_editorGuardStale('strategy-editor', String(editingStrategyId)) === true");
    assert.ok(sc > 0 && sc < stratSubmit.indexOf('_saveStrategyToSupabase('));
    // Note template editor
    assert.match(extractFunction(APP, 'tmSelectTemplate'), /else _tmGuardOpen\(id\);/);
    const tmSave = extractFunction(APP, 'tmSaveTemplate');
    const tc = tmSave.indexOf("_editorGuardStale('note-template-editor', String(_tmplSelectedId)) === true");
    assert.ok(tc > 0 && tc < tmSave.lastIndexOf('_saveNoteTemplateToSupabase('));
    // Tag, prompt, broker account
    assert.match(extractFunction(SETTINGS, 'editTag'), /_tagGuardOpen\(tagId\);\s*\}$/);
    assert.match(extractFunction(SETTINGS, 'cancelTagForm'), /_editorGuardClose\('tag-editor'\)/);
    assert.match(extractFunction(LIB, 'openEditor'), /if \(pr && id\) _guardOpen\(id\);/);
    assert.match(extractFunction(LIB, 'saveFromEditor'), /_editorGuardStale\('prompt-editor', String\(_editingId\)\) === true/);
    assert.match(extractFunction(BA, 'openBrokerAccountModal'), /if \(editId\) _baGuardOpen\(editId\);/);
});

test('source: re-sync hook sits right around the journalData swap; the checked write, merge, revs and baseline code are unchanged', () => {
    const rs = extractFunction(AUTH, '_cloudResync');
    assert.match(rs, /var editorHits = _editorGuardsBeforeResync\(journalData, merged\.jd, revs\);[^\n]*\n\s*journalData = merged\.jd;\s*_adoptRevs\(revs\);\s*_setCloudBaseline\(journalData, true, cloud\);\s*_editorGuardsApply\(editorHits\);/);
    const win = extractFunction(AUTH, '_applyCloudWin');
    assert.match(win, /var editorHits = _editorGuardsForRow\(dk, key\);/);
    assert.ok(win.indexOf('_editorGuardsForRow') < win.indexOf('_setLocalValue'), 'checked before the cloud version is put in');
    for (const fn of ['_checkedWriteRows', '_checkedWriteOne', '_resolveCloudRow', '_mergeCloudIntoLocal', '_adoptRevs', '_setCloudBaseline', '_changedRows', '_markRows']) {
        assert.doesNotMatch(extractFunction(AUTH, fn), /_editorGuard/, fn);
    }
});

test('index.html: every changed script is bumped', () => {
    const ver = file => Number((HTML.split('src="' + file + '?v=')[1] || '0"').split('"')[0]);
    assert.ok(ver('Denarii.js') >= 51);
    assert.ok(ver('js/auth.js') >= 38);
    assert.ok(ver('js/ai-library.js') >= 2);
    assert.ok(ver('js/pages/settings.js') >= 9);
    assert.ok(ver('js/pages/journal.js') >= 15);
    assert.ok(ver('js/pages/broker-accounts.js') >= 13);
    assert.ok(ver('js/pages/reviews.js') >= 2);
    assert.ok(ver('js/pages/daily-planner.js') >= 2);
    assert.ok(ver('js/pages/weekly-planner.js') >= 2);
});
