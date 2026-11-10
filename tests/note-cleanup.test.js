// Clean Up with AI on New Trade and Trade Reflection: the same cleanup as the
// planners (key logic, escaping, append-only block, Bullets/Paragraphs) with a
// TRADE or period REFLECTION prompt. New Trade only updates its draft; Trade
// Reflection saves through the notes' draft + commit path. A cleanup that
// finishes after the trade, form or account changed is discarded.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const AI = read('js/widgets/journal-ai.js');
const APP = read('Denarii.js');
const JNL = read('js/pages/journal.js');
const HTML = read('index.html');

function braceEnd(src, from) {
    let depth = 0;
    for (let i = src.indexOf('{', from); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return i + 1;
    }
    throw new Error('unbalanced braces');
}
function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    return src.slice(start, braceEnd(src, start));
}
// window.name = function () { ... };  →  function name() { ... }
function extractWindowFn(src, name) {
    const marker = 'window.' + name + ' = function';
    const start = src.indexOf(marker);
    if (start < 0) throw new Error(name + ' not found');
    return 'function ' + name + src.slice(start + marker.length, braceEnd(src, start)).replace(/^\s*/, '');
}

// ── Prompts ────────────────────────────────────────────────────────────────

const CONSTS = AI.slice(AI.indexOf('var PLAN_CLEANUP_BULLET_RULE ='), AI.indexOf('// Plan text with its line breaks'));
const consts = new Function(CONSTS + '\nreturn { CLEANUP_SHARED_RULES, PLAN_CLEANUP_BULLET_RULE, PLAN_CLEANUP_PARAGRAPH_RULE, PLAN_CLEANUP_FORMAT, PLAN_CLEANUP_PARAGRAPH_FORMAT };')();
const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function noteCleanup(DenAriiAI) {
    const code = ['_planEditorText', '_cleanupToHtml', '_runCleanup', '_noteCleanupRules', 'runNoteCleanup'].map(n => extractFunction(AI, n)).join('\n');
    return new Function('esc', 'friendlyError', 'DenAriiAI', CONSTS + '\n' + code + '\nreturn runNoteCleanup;')(esc, s => s, DenAriiAI);
}

function el(tag, attrs, kids) {
    const node = {
        tag, attrs: attrs || {}, kids: kids || [], parent: null,
        cloneNode() { return el(tag, Object.assign({}, node.attrs), node.kids.map(k => (typeof k === 'string' ? k : k.cloneNode()))); },
        all() { return node.kids.flatMap(k => (typeof k === 'string' ? [] : [k, ...k.all()])); },
        querySelectorAll(sel) {
            if (sel === '[data-plan-cleanup]') return node.all().filter(n => 'data-plan-cleanup' in n.attrs);
            const tags = sel.split(',');
            return node.all().filter(n => tags.includes(n.tag));
        },
        remove() { node.parent.kids.splice(node.parent.kids.indexOf(node), 1); },
        replaceWith(s) { node.parent.kids[node.parent.kids.indexOf(node)] = s; },
        append(s) { node.kids.push(s); },
        get textContent() { return node.kids.map(k => (typeof k === 'string' ? k : k.textContent)).join(''); },
    };
    node.kids.forEach(k => { if (typeof k !== 'string') k.parent = node; });
    return node;
}
const notesEditor = () => el('div', {}, [el('p', {}, ['bought aapl at the open']), el('div', { 'data-plan-cleanup': '1' }, ['old'])]);

async function promptFor(kind, format) {
    let sent;
    const run = noteCleanup({ isConfigured: () => true, query: async (r, o) => { sent = { r, o }; return { success: true, rawText: '## Lessons\n- <b>wait</b>' }; } });
    const res = await run(kind, notesEditor(), format);
    return { res, sent };
}

test('TRADE prompt: shared rules, trade headings, Notes delimiters, no planner wording', async () => {
    const { res, sent } = await promptFor('trade');
    const p = sent.r.promptText;
    assert.ok(p.startsWith('You are cleaning up a trade reflection the user wrote about one trade.'));
    assert.ok(p.includes('Rewrite it into a clean, readable, bulleted reflection.'));
    assert.ok(p.includes('Reflection type: TRADE (one trade)\n\n'));
    assert.ok(p.includes(consts.CLEANUP_SHARED_RULES), 'same rules as the planners, including Other Notes and no em dashes');
    assert.ok(p.includes('Other Notes') && p.includes('- Do not use em dashes.'));
    assert.ok(p.includes('Headings (skip any not covered): Setup / Thesis; Entry & Execution; Management & Exit; What Went Well; What to Improve; Emotions / Mindset; Lessons.\n'));
    assert.ok(p.includes(consts.PLAN_CLEANUP_BULLET_RULE + 'Output only the cleaned reflection, with no intro or commentary.'));
    assert.ok(p.includes('--- Notes ---\nbought aapl at the open\n--- End Notes ---'), 'earlier cleanup blocks are left out');
    assert.ok(p.endsWith(consts.PLAN_CLEANUP_FORMAT));
    assert.ok(!p.includes('Plan type') && !p.includes('DAILY headings') && !p.includes('{DAILY or WEEKLY}'));
    assert.deepEqual(sent.r.tradeData, []);
    assert.deepEqual(sent.o.providerConfig, { maxOutputTokens: 8192, temperature: 0.2, feature: 'cleanup', timeoutMs: 60000, thinkingLevel: 'low' });
    assert.equal(res.ok, true);
    assert.match(res.block, /^<p><br><\/p><div data-plan-cleanup="1">/);
    assert.ok(res.block.includes('&lt;b&gt;wait&lt;/b&gt;') && !res.block.includes('<b>'), 'reply is escaped');
});

test('Paragraphs: paragraph rule and format, no bullet wording', async () => {
    const p = (await promptFor('trade', 'paragraphs')).sent.r.promptText;
    assert.ok(p.includes('Rewrite it into a clean, readable reflection.'));
    assert.ok(p.includes(consts.PLAN_CLEANUP_PARAGRAPH_RULE) && p.endsWith(consts.PLAN_CLEANUP_PARAGRAPH_FORMAT));
    assert.ok(!p.includes('bulleted') && !p.includes(consts.PLAN_CLEANUP_BULLET_RULE));
    assert.equal((await promptFor('trade', 'bullets')).sent.r.promptText, (await promptFor('trade')).sent.r.promptText);
});

test('period reflections name the period and its next-period heading', async () => {
    for (const [kind, label, next] of [['daily', 'DAILY REFLECTION (one trading day)', 'Day'], ['weekly', 'WEEKLY REFLECTION (one trading week)', 'Week'],
        ['monthly', 'MONTHLY REFLECTION (one trading month)', 'Month'], ['yearly', 'YEARLY REFLECTION (one trading year)', 'Year']]) {
        const p = (await promptFor(kind)).sent.r.promptText;
        assert.ok(p.includes('Reflection type: ' + label + '\n'), kind);
        assert.ok(p.includes("Headings (skip any not covered): Summary; What Went Well; What Didn't Go Well; Mistakes / Rule Breaks; Emotions / Mindset; Lessons; Focus for Next " + next + '.\n'), kind);
    }
});

test('empty notes, unknown kind and missing key never call the AI', async () => {
    let calls = 0;
    const run = noteCleanup({ isConfigured: () => true, query: async () => { calls++; } });
    assert.deepEqual(await run('trade', el('div', {}, [el('div', { 'data-plan-cleanup': '1' }, ['x'])])), { ok: false, message: 'Write your reflection first.' });
    assert.equal((await run('nope', notesEditor())).ok, false);
    const noKey = noteCleanup({ isConfigured: () => false, query: async () => { calls++; } });
    assert.equal((await noKey('trade', notesEditor())).message, 'Add your Gemini key in Settings → Integrations.');
    assert.equal(calls, 0);
});

test('a cut-off reply asks to shorten the reflection', async () => {
    const run = noteCleanup({ isConfigured: () => true, query: async () => ({ success: true, truncated: true, rawText: '- x' }) });
    assert.match((await run('trade', notesEditor())).message, /Shorten the reflection/);
});

// ── Handlers ───────────────────────────────────────────────────────────────

function gate() {
    let release;
    const p = new Promise(r => { release = r; });
    return { p, release };
}

function ntHandler(reply) {
    const g = gate(), log = { inserted: [], msgs: [], drafts: 0, formats: [] };
    const state = { acct: 'A1', format: 'bullets' };
    const ed = { insertAdjacentHTML: (pos, html) => log.inserted.push([pos, html]) };
    const els = { 'nt-notes': ed, 'nt-cleanup-format': { get value() { return state.format; } }, 'nt-cleanup-btn': { disabled: false } };
    const win = { _noteCleanupAccount: () => state.acct, _ntOnNotesInput: () => log.drafts++ };
    const vals = {
        window: win,
        document: { getElementById: id => els[id] || null },
        _noteCleanup: (kind, e, format) => { log.kind = kind; log.formats.push(format); return g.p.then(() => reply); },
        _ntCleanupMsg: (t, e) => log.msgs.push([t, !!e]),
    };
    const keys = Object.keys(vals);
    const box = new Function(...keys, 'var _ntFormGen = 0, _ntCleanupBusy = false;\n' + extractWindowFn(APP, 'ntCleanUpAI') +
        '\nreturn { run: ntCleanUpAI, reset: function () { _ntFormGen++; } };')(...keys.map(k => vals[k]));
    return { box, log, state, release: g.release, btn: els['nt-cleanup-btn'] };
}

test('New Trade: appends at the end and only updates the draft (no record save)', async () => {
    const t = ntHandler({ ok: true, block: 'BLOCK' });
    const p = t.box.run();
    assert.equal(t.btn.disabled, true);
    t.release();
    await p;
    assert.equal(t.log.kind, 'trade');
    assert.deepEqual(t.log.inserted, [['beforeend', 'BLOCK']]);
    assert.equal(t.log.drafts, 1);
    assert.equal(t.btn.disabled, false);
    assert.match(t.log.msgs.at(-1)[0], /Save Trade/);
    const fn = extractWindowFn(APP, 'ntCleanUpAI');
    assert.ok(!/_ntCommitTrade|_ntFlushCommit|_ntScheduleCommit|innerHTML/.test(fn), 'never saves the record or rewrites the editor');
});

test('New Trade: a form reset (Save Trade) or account change during the call discards it', async () => {
    for (const change of [t => t.box.reset(), t => { t.state.acct = 'A2'; }]) {
        const t = ntHandler({ ok: true, block: 'BLOCK' });
        const p = t.box.run();
        change(t);
        t.release();
        await p;
        assert.deepEqual(t.log.inserted, []);
        assert.equal(t.log.drafts, 0);
        assert.match(t.log.msgs.at(-1)[0], /discarded/);
    }
});

test('New Trade: failure shows the message; format is passed; second click ignored', async () => {
    const t = ntHandler({ ok: false, message: 'nope' });
    t.state.format = 'paragraphs';
    const p = t.box.run();
    assert.equal(t.box.run(), undefined);
    t.release();
    await p;
    assert.deepEqual(t.log.formats, ['paragraphs']);
    assert.deepEqual(t.log.inserted, []);
    assert.deepEqual(t.log.msgs.at(-1), ['nope', true]);
});

test('New Trade: the form generation moves on reset and on draft restore', () => {
    assert.ok(/_ntSetNotes\(''\);\s*_ntFormGen\+\+;/.test(extractFunction(APP, '_ntResetForm')));
    assert.ok(extractFunction(APP, '_ntApplyDraft').includes('_ntFormGen++'));
});

function jnlHandler(reply, commitResult) {
    const g = gate(), log = { inserted: [], msgs: [], drafts: [], scheduled: 0, flushed: 0 };
    const state = { acct: 'A1' };
    const ed = { insertAdjacentHTML: (pos, html) => log.inserted.push([pos, html]) };
    const els = { 'jnl-notes': ed, 'jnl-cleanup-format': { value: 'bullets' }, 'jnl-cleanup-btn': { disabled: false } };
    const win = { _jnlSelectedTradeId: 7 };
    const vals = {
        window: win,
        document: { getElementById: id => els[id] || null },
        _noteCleanup: kind => { log.kind = kind; return g.p.then(() => reply); },
        _noteCleanupAccount: () => state.acct,
        _jnlCleanupMsg: (t, e) => log.msgs.push([t, !!e]),
        _jnlSaveDraft: id => log.drafts.push(id),
        _jnlScheduleCommit: () => log.scheduled++,
        _jnlFlushCommit: () => { log.flushed++; return Promise.resolve(commitResult); },
    };
    const keys = Object.keys(vals);
    const box = new Function(...keys, 'var _jnlLoadGen = 0, _jnlCleanupBusy = false;\n' + extractFunction(JNL, 'jnlCleanUpAI') +
        '\nreturn { run: jnlCleanUpAI, reload: function () { _jnlLoadGen++; } };')(...keys.map(k => vals[k]));
    return { box, log, state, win, release: g.release };
}

test('Trade Reflection: appends, saves the draft and commits through the notes path', async () => {
    const t = jnlHandler({ ok: true, block: 'BLOCK' }, true);
    const p = t.box.run();
    t.release();
    await p;
    assert.equal(t.log.kind, 'trade');
    assert.deepEqual(t.log.inserted, [['beforeend', 'BLOCK']]);
    assert.deepEqual(t.log.drafts, [7]);
    assert.equal(t.log.scheduled, 1);
    assert.equal(t.log.flushed, 1);
    assert.match(t.log.msgs.at(-1)[0], /added below your reflection/);
});

test('Trade Reflection: a commit that cannot run (stale, fill row, cloud error) is reported', async () => {
    const t = jnlHandler({ ok: true, block: 'BLOCK' }, false);
    const p = t.box.run();
    t.release();
    await p;
    assert.deepEqual(t.log.msgs.at(-1), ['Cleaned-up version added below, but it could not be saved yet.', true]);
});

test('Trade Reflection: switching trade, reopening/reloading, closing or switching account discards it', async () => {
    const changes = [
        t => { t.win._jnlSelectedTradeId = 8; },
        t => t.box.reload(),
        t => { t.win._jnlSelectedTradeId = null; },
        t => { t.state.acct = 'A2'; },
    ];
    for (const change of changes) {
        const t = jnlHandler({ ok: true, block: 'BLOCK' }, true);
        const p = t.box.run();
        change(t);
        t.release();
        await p;
        assert.deepEqual(t.log.inserted, []);
        assert.deepEqual(t.log.drafts, []);
        assert.equal(t.log.flushed, 0);
        assert.match(t.log.msgs.at(-1)[0], /discarded/);
    }
});

test('Trade Reflection: no open trade does nothing', () => {
    const t = jnlHandler({ ok: true, block: 'BLOCK' }, true);
    t.win._jnlSelectedTradeId = null;
    assert.equal(t.box.run(), undefined);
    assert.equal(t.log.kind, undefined);
});

test('Trade Reflection: the load generation moves on open and close', () => {
    assert.ok(/window\._jnlSelectedTradeId = tradeId;\s*_jnlLoadGen\+\+;/.test(extractFunction(JNL, 'selectTradeForJournal')));
    assert.ok(/window\._jnlSelectedTradeId = null;\s*_jnlLoadGen\+\+;/.test(extractFunction(JNL, 'closeJournalEditor')));
});

// ── Markup, format key, versions ───────────────────────────────────────────

test('buttons are type="button" and wired; selects carry the shared format marker', () => {
    assert.ok(HTML.includes('<button type="button" class="btn btn-secondary btn-small" id="nt-cleanup-btn" style="white-space:nowrap;" onclick="ntCleanUpAI()">Clean Up with AI</button>'));
    assert.ok(HTML.includes('<button type="button" class="btn btn-secondary btn-small" id="jnl-cleanup-btn" style="white-space:nowrap;" onclick="jnlCleanUpAI()">Clean Up with AI</button>'));
    for (const p of ['nt', 'jnl']) {
        const sel = HTML.slice(HTML.indexOf('<select id="' + p + '-cleanup-format"'), HTML.indexOf('</select>', HTML.indexOf('<select id="' + p + '-cleanup-format"')));
        assert.ok(sel.includes('data-note-cleanup-format') && sel.includes('noteCleanupFormatChange(this.value)'), p);
        assert.ok(sel.includes('<option value="bullets">Bullets</option>') && sel.includes('<option value="paragraphs">Paragraphs</option>'), p);
        assert.ok(HTML.indexOf('id="' + p + '-cleanup-format"') < HTML.indexOf('id="' + p + '-cleanup-btn"'), 'select before button');
        assert.ok(HTML.indexOf('id="' + p + '-cleanup-btn"') < HTML.indexOf('id="' + p + '-notes"'), 'controls sit in the Reflection header');
    }
    // New Trade's form autosave listens for input/change on any SELECT.
    const ntSel = HTML.slice(HTML.indexOf('<select id="nt-cleanup-format"'), HTML.indexOf('>', HTML.indexOf('onchange=', HTML.indexOf('<select id="nt-cleanup-format"'))));
    assert.ok(ntSel.includes('oninput="event.stopPropagation()"') && ntSel.includes('onchange="event.stopPropagation();'));
    assert.ok(JNL.includes('window.jnlCleanUpAI           = jnlCleanUpAI;'));
    assert.ok(AI.includes('global._noteCleanup = runNoteCleanup;') && AI.includes('global._plannerCleanup = runPlanCleanup;'));
});

test('format choice: own key, defaults to Bullets, syncs every reflection select, survives blocked storage', () => {
    const start = APP.indexOf("var NOTE_CLEANUP_FORMAT_KEY = 'denarii_note_cleanup_format';");
    assert.ok(start > 0);
    const block = APP.slice(start, APP.indexOf('window._noteCleanupAccount', start));
    const selects = [{ value: '' }, { value: '' }];
    const run = ls => {
        const win = {};
        new Function('window', 'localStorage', 'document', block)(win, ls, { querySelectorAll: () => selects });
        return win;
    };
    const store = {};
    const ok = { getItem: k => (k in store ? store[k] : null), setItem: (k, v) => { store[k] = String(v); } };
    const w = run(ok);
    assert.equal(w._noteCleanupSavedFormat(), 'bullets');
    w.noteCleanupFormatChange('paragraphs');
    assert.equal(store.denarii_note_cleanup_format, 'paragraphs');
    assert.ok(!('denarii_plan_cleanup_format' in store), 'planner choice untouched');
    assert.deepEqual(selects.map(s => s.value), ['paragraphs', 'paragraphs']);
    w.noteCleanupFormatChange('junk');
    assert.equal(w._noteCleanupSavedFormat(), 'bullets');
    const broken = { getItem: () => { throw new Error('x'); }, setItem: () => { throw new Error('x'); } };
    const wb = run(broken);
    assert.equal(wb._noteCleanupSavedFormat(), 'bullets');
    assert.doesNotThrow(() => wb.noteCleanupFormatChange('paragraphs'));
});

test('script versions are bumped', () => {
    const ver = s => Number(HTML.split('src="' + s + '?v=')[1].split('"')[0]);
    assert.ok(ver('Denarii.js') >= 70);
    assert.ok(ver('js/pages/journal.js') >= 22);
    assert.ok(ver('js/widgets/journal-ai.js') >= 9);
});
