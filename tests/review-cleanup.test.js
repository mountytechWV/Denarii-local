// Clean Up with AI on the Daily / Weekly / Monthly / Yearly Reflection pages:
// the shared note cleanup with that period's profile, appended below the
// reflection and saved through doSave (draft first). A cleanup that finishes
// after the period, account or page changed is discarded. doSave reports
// false when the save was stale (conflict copy) or failed.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const RV = fs.readFileSync(path.join(root, 'js/pages/reviews.js'), 'utf8');
const HTML = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(name + ': unbalanced braces');
}

function box(names, vals, extra, ret) {
    const code = names.map(n => extractFunction(RV, n)).join('\n');
    const keys = Object.keys(vals);
    return new Function(...keys, (extra || '') + '\n' + code + '\nreturn ' + ret + ';')(...keys.map(k => vals[k]));
}

// ── doSave return value ────────────────────────────────────────────────────

function saveBox(opts) {
    const log = { saved: [], status: [], cleared: 0, rendered: 0 };
    const rev = { content: 'old', nextFocus: {} };
    const vals = {
        _rvStaleSave: () => !!opts.stale,
        curRev: () => rev,
        captureState: () => ({ content: 'new', nextFocus: { cont: [] } }),
        saveRev: (t, k, r) => { if (opts.throws) throw new Error('quota'); log.saved.push([t, k, r.content]); },
        showStatus: (t, m) => log.status.push(m),
        _rvClearDraft: () => log.cleared++,
        renderReviewPage: () => log.rendered++,
    };
    return { doSave: box(['doSave'], vals, '', 'doSave'), log };
}

test('doSave: true after a normal save', () => {
    const { doSave, log } = saveBox({});
    assert.equal(doSave('weekly', '2026-W45', {}), true);
    assert.deepEqual(log.saved, [['weekly', '2026-W45', 'new']]);
    assert.equal(log.status.at(-1), 'Saved');
});

test('doSave: true after Mark Complete (which re-renders)', () => {
    const { doSave, log } = saveBox({});
    assert.equal(doSave('daily', '2026-11-02', { status: 'complete' }), true);
    assert.equal(log.rendered, 1);
    assert.equal(log.cleared, 1);
});

test('doSave: false when stale, without writing', () => {
    const { doSave, log } = saveBox({ stale: true });
    assert.equal(doSave('monthly', '2026-11', {}), false);
    assert.deepEqual(log.saved, []);
});

test('doSave: false when the write throws', () => {
    const { doSave, log } = saveBox({ throws: true });
    assert.equal(doSave('yearly', '2026', {}), false);
    assert.equal(log.status.at(-1), 'Save failed');
});

test('doSave: existing callers still ignore the result', () => {
    for (const call of ["function _rvSave(type, key)     { doSave(type, key, {}); }",
        "function _rvComplete(type, key) { doSave(type, key, { status: 'complete' }); }",
        "function _rvReopen(type, key)   { doSave(type, key, { status: 'draft' }); }"]) {
        assert.ok(RV.includes(call), call);
    }
});

// ── Handler ────────────────────────────────────────────────────────────────

function handler(type, reply, opts) {
    opts = opts || {};
    let release;
    const gate = new Promise(r => { release = r; });
    const log = { inserted: [], msgs: [], drafts: [], saves: [], kinds: [], formats: [] };
    const state = { acct: 'A1', format: 'bullets' };
    const st = { [type]: { periodKey: 'K1' } };
    const ed = { innerHTML: 'ED', insertAdjacentHTML: (pos, html) => log.inserted.push([pos, html]) };
    const els = {
        ['rv-editor-' + type]: ed,
        ['rv-cleanup-format-' + type]: { get value() { return state.format; } },
        ['rv-cleanup-btn-' + type]: { disabled: false },
    };
    const saveResults = (opts.saveResults || [true]).slice();
    const vals = {
        _st: st,
        document: { getElementById: id => els[id] || null },
        _noteCleanup: (kind, e, format) => { log.kinds.push(kind); log.formats.push(format); return gate.then(() => reply); },
        _noteCleanupAccount: () => state.acct,
        _rvCleanupMsg: (t, m, e) => log.msgs.push([m, !!e]),
        _rvSaveDraft: (t, k, html) => log.drafts.push([t, k, html]),
        doSave: (t, k, o) => { log.saves.push([t, k]); return saveResults.length ? saveResults.shift() : true; },
        clearTimeout: () => {},
    };
    const extra = 'var _saveTimer = ' + (opts.pending ? '1' : 'null') + '; var _rvCleanupBusy = {};';
    const b = box(['_rvCleanupAccount', '_rvCleanUpAI'], vals, extra,
        '{ run: _rvCleanUpAI, timer: function () { return _saveTimer; } }');
    return { b, log, state, st, els, ed, release };
}

for (const type of ['daily', 'weekly', 'monthly', 'yearly']) {
    test(type + ': uses its own profile, appends at the end, saves the draft then doSave', async () => {
        const t = handler(type, { ok: true, block: 'BLOCK' });
        const p = t.b.run(type);
        assert.equal(t.els['rv-cleanup-btn-' + type].disabled, true);
        t.release();
        await p;
        assert.deepEqual(t.log.kinds, [type]);
        assert.deepEqual(t.log.inserted, [['beforeend', 'BLOCK']]);
        assert.deepEqual(t.log.drafts, [[type, 'K1', 'ED']]);
        assert.deepEqual(t.log.saves, [[type, 'K1']]);
        assert.equal(t.b.timer(), null);
        assert.equal(t.els['rv-cleanup-btn-' + type].disabled, false);
        assert.match(t.log.msgs.at(-1)[0], /added below your reflection/);
    });
}

test('changing period, account or re-rendering the page during the call discards it', async () => {
    const changes = [
        t => { t.st.weekly.periodKey = 'K2'; },
        t => { t.state.acct = 'A2'; },
        t => { t.els['rv-editor-weekly'] = { insertAdjacentHTML: () => { throw new Error('wrong editor'); } }; },
    ];
    for (const change of changes) {
        const t = handler('weekly', { ok: true, block: 'BLOCK' });
        const p = t.b.run('weekly');
        change(t);
        t.release();
        await p;
        assert.deepEqual(t.log.inserted, []);
        assert.deepEqual(t.log.drafts, []);
        assert.deepEqual(t.log.saves, []);
        assert.match(t.log.msgs.at(-1)[0], /discarded/);
    }
});

test('a stale save after the append reports the conflict copy', async () => {
    const t = handler('monthly', { ok: true, block: 'BLOCK' }, { saveResults: [false] });
    const p = t.b.run('monthly');
    t.release();
    await p;
    assert.deepEqual(t.log.msgs.at(-1), ['Updated on another device; your version was kept as a conflict copy.', true]);
});

test('pending typing is saved before the call; a stale flush stops the cleanup', async () => {
    let t = handler('daily', { ok: true, block: 'BLOCK' }, { pending: true });
    const p = t.b.run('daily');
    assert.deepEqual(t.log.saves, [['daily', 'K1']], 'flushed first');
    t.release();
    await p;
    assert.equal(t.log.saves.length, 2);

    t = handler('daily', { ok: true, block: 'BLOCK' }, { pending: true, saveResults: [false] });
    assert.equal(t.b.run('daily'), undefined);
    assert.deepEqual(t.log.kinds, [], 'no AI call after a stale flush');
});

test('failure shows the message; format is passed; a second click is ignored', async () => {
    const t = handler('yearly', { ok: false, message: 'nope' });
    t.state.format = 'paragraphs';
    const p = t.b.run('yearly');
    assert.equal(t.b.run('yearly'), undefined);
    t.release();
    await p;
    assert.deepEqual(t.log.formats, ['paragraphs']);
    assert.deepEqual(t.log.inserted, []);
    assert.deepEqual(t.log.saves, []);
    assert.deepEqual(t.log.msgs.at(-1), ['nope', true]);
});

test('the handler never rewrites the editor', () => {
    assert.ok(!/innerHTML\s*=/.test(extractFunction(RV, '_rvCleanUpAI')));
});

// ── Markup and version ─────────────────────────────────────────────────────

test('Reflection header has the select and a type="button" button, wired per type', () => {
    const hdr = RV.slice(RV.indexOf("'<h3 class=\"review-section-title\">Reflection</h3>'"), RV.indexOf("buildToolbar(type) +", RV.indexOf('// Reflection Editor')));
    assert.ok(hdr.includes("id=\"rv-cleanup-msg-'+type+'\""));
    assert.ok(hdr.includes("id=\"rv-cleanup-format-'+type+'\" data-note-cleanup-format") && hdr.includes('onchange="noteCleanupFormatChange(this.value)"'));
    assert.ok(hdr.includes('<option value="bullets"') && hdr.includes('<option value="paragraphs"'));
    assert.ok(hdr.includes("'<button type=\"button\" class=\"btn btn-secondary btn-small\" id=\"rv-cleanup-btn-'+type+'\" onclick=\"window._rvCleanUpAI(\\''+type+'\\')\">Clean Up with AI</button>'"));
    assert.ok(hdr.indexOf('rv-cleanup-format-') < hdr.indexOf('rv-cleanup-btn-'));
    assert.ok(RV.includes("var cleanupFmt = typeof _noteCleanupSavedFormat === 'function' ? _noteCleanupSavedFormat() : 'bullets';"));
    assert.ok(RV.includes('window._rvCleanUpAI       = _rvCleanUpAI;'));
});

test('reviews.js version is bumped', () => {
    assert.ok(Number(HTML.split('src="js/pages/reviews.js?v=')[1].split('"')[0]) >= 7);
});
