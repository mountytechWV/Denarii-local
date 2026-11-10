// Bug batch 2:
// 1. Saved Reports Copy puts the "N trades analyzed" line at the top of the
//    copied text (Print already shows it in the viewer header).
// 2. Planner doSave clears its timer; "Append to Plan" builds a copy so a
//    stale save leaves the stored record without appendedAt.
// 3. Saving a strategy deleted on another device puts it back in the list.
// 4. Note Template save matches the id as a string.
//
// Same harness as batch-2-editor-guard.test.js: real functions are cut out
// of the browser scripts and run in a `with` scope (unknown globals are inert).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const REPORTS = read('js/ai-reports.js');
const DP = read('js/pages/daily-planner.js');
const WP = read('js/pages/weekly-planner.js');
const APP = read('Denarii.js');
const CSS = read('Denarii.css');
const HTML = read('index.html');

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

// Body of the strategy form submit handler, as an async function of (e).
function extractStrategySubmit() {
    const head = "document.getElementById('strategy-form')?.addEventListener('submit', async (e) => {";
    const start = APP.indexOf(head);
    if (start < 0) throw new Error('strategy submit not found');
    let depth = 0;
    for (let i = start + head.length - 1; i < APP.length; i++) {
        if (APP[i] === '{') depth++;
        else if (APP[i] === '}' && --depth === 0) {
            return 'async function _strategySubmit(e) ' + APP.slice(start + head.length - 1, i + 1);
        }
    }
    throw new Error('strategy submit: unbalanced braces');
}

const inert = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
});

function sandbox(code, names, vals) {
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

function fromSource(src, names, vals) {
    return sandbox(names.map(n => extractFunction(src, n)).join('\n'), names, vals);
}

const noTimers = { setTimeout: () => 0, clearTimeout: () => {} };

// ── 1. Saved Reports Copy / Print ───────────────────────────────────────────

function copyBox(report) {
    const copied = [];
    const box = fromSource(REPORTS, ['copyReport', '_tradeCountText', '_reportPlainText'], Object.assign({
        _currentReport: report,
        navigator: { clipboard: { writeText: async t => { copied.push(t); } } },
        document: { getElementById: () => null },
    }, noTimers));
    return { box, copied };
}

test('Copy: trade count line goes at the top of the copied text', async () => {
    const { box, copied } = copyBox({ rawText: 'Report body', filters: { tradeCount: 12, tradesTrimmed: false } });
    await box.fns.copyReport();
    assert.deepEqual(copied, ['12 trades analyzed\n\nReport body']);
});

test('Copy: trimmed reports say "(most recent)", one trade is singular', async () => {
    let c = copyBox({ rawText: 'X', filters: { tradeCount: 50, tradesTrimmed: true } });
    await c.box.fns.copyReport();
    assert.deepEqual(c.copied, ['50 trades analyzed (most recent)\n\nX']);
    c = copyBox({ rawText: 'Y', filters: { tradeCount: 1 } });
    await c.box.fns.copyReport();
    assert.deepEqual(c.copied, ['1 trade analyzed\n\nY']);
});

test('Copy: reports saved before the count existed copy as before', async () => {
    for (const filters of [undefined, null, {}, { instrumentType: 'Options' }]) {
        const { box, copied } = copyBox({ rawText: 'Old body', filters });
        await box.fns.copyReport();
        assert.deepEqual(copied, ['Old body']);
    }
    const { box, copied } = copyBox({ rawText: '', filters: { tradeCount: 3 } });
    await box.fns.copyReport();
    assert.deepEqual(copied, [], 'no text → nothing copied, as before');
});

test('Print: viewer header shows the same count line and print CSS keeps it', () => {
    const viewer = extractFunction(REPORTS, '_showViewer');
    assert.match(viewer, /_tradeCountText\(r\.filters\)/);
    assert.match(viewer, /ai-report-viewer-date">' \+ _esc\(viewerCount\)/);
    assert.equal(extractFunction(REPORTS, 'printReport').includes('window.print()'), true);
    const at = CSS.indexOf('/* Hide navigation and chrome */');
    assert.ok(at > 0, 'print block found');
    const hidden = CSS.slice(at, CSS.indexOf('display: none', at));
    assert.match(hidden, /ai-report-viewer-actions/);
    assert.equal(/ai-report-viewer-(date|header)/.test(hidden), false);
});

// ── 2. Planner save timer and Append to Plan ────────────────────────────────

const PLANNERS = [
    { name: 'daily', src: DP, p: 'dp', key: '2026-10-29', store: 'dailyPlanners', append: 'dpAppendAI',
      stale: '_dpStaleSave', guard: '_DP_GUARD', label: 'dateLabel' },
    { name: 'weekly', src: WP, p: 'wp', key: '2026-W44', store: 'weeklyPlanners', append: 'wpAppendAI',
      stale: '_wpStaleSave', guard: '_WP_GUARD', label: 'weekLabel' },
];

function plannerBox(P, opts) {
    const log = { saves: 0, conflicts: [], reloads: 0, scheduled: 0 };
    const ed = { innerHTML: '<p>plan</p>' };
    const vals = Object.assign({
        journalData: { [P.store]: {} },
        ['_' + P.p + 'Key']: P.key,
        ['_' + P.p + 'SaveTimer']: null,
        [P.guard]: P.p === 'dp' ? 'daily-planner' : 'weekly-planner',
        saveToIndexedDB: () => { log.saves++; },
        collectData: () => ({ content: ed.innerHTML, behavioral: {} }),
        showStatus: () => {},
        scheduleSave: () => { log.scheduled++; },
        _editorGuardStale: () => opts.stale === true,
        _editorGuardConflict: (id, mine) => { log.conflicts.push(mine); },
        ['_' + P.p + 'Reload']: () => { log.reloads++; },
        [P.label]: k => k,
        document: { getElementById: id => (id === P.p + '-editor' ? ed : null) },
    }, noTimers);
    const box = fromSource(P.src, ['savePlanner', 'getPlanner', 'storageKey', 'esc', 'doSave', 'flushSave', P.stale, P.append], vals);
    return { box, log, ed };
}

for (const P of PLANNERS) {
    test(P.name + ' planner: doSave clears the timer, so a later flush does not save again', () => {
        const { box, log } = plannerBox(P, {});
        box.g['_' + P.p + 'SaveTimer'] = 777;
        box.fns.doSave();
        assert.equal(box.g['_' + P.p + 'SaveTimer'], null);
        assert.equal(log.saves, 1);
        box.fns.flushSave();   // what navigateToDate / navigateToWeek runs first
        assert.equal(log.saves, 1, 'no extra save on date/week change');
    });

    test(P.name + ' planner: Append to Plan saves appendedAt when the save goes through', () => {
        const { box, log } = plannerBox(P, {});
        const sk = box.fns.storageKey(P.key);
        box.g.journalData[P.store][sk] = { content: '<p>plan</p>', aiAnalysis: { text: 'AI says' } };
        box.fns[P.append]();
        const stored = box.g.journalData[P.store][sk];
        assert.equal(typeof stored.aiAnalysis.appendedAt, 'number');
        assert.equal(stored.aiAnalysis.text, 'AI says');
        assert.equal(log.saves, 1);
        assert.equal(log.scheduled, 1);
    });

    test(P.name + ' planner: a stale Append to Plan leaves appendedAt unset locally', () => {
        const { box, log } = plannerBox(P, { stale: true });
        const sk = box.fns.storageKey(P.key);
        const cloudRec = { content: '<p>cloud</p>', aiAnalysis: { text: 'AI says' } };
        box.g.journalData[P.store][sk] = cloudRec;
        box.fns[P.append]();
        const stored = box.g.journalData[P.store][sk];
        assert.equal(stored, cloudRec, 'stored record not replaced');
        assert.equal('appendedAt' in stored.aiAnalysis, false, 'local matches the cloud');
        assert.equal(log.saves, 0);
        assert.equal(log.scheduled, 0);
        assert.equal(log.conflicts.length, 1, 'this device\'s version kept as a conflict copy');
        assert.equal(log.reloads, 1);
    });
}

// ── 3. Strategy deleted on another device ───────────────────────────────────

function strategyBox(strategies, editingId) {
    const log = { cloud: [], idb: 0, listed: [] };
    const fields = { 'strategy-name': { value: 'Breakout' }, 'strategy-description': { value: 'desc' } };
    const vals = {
        journalData: { strategies },
        editingStrategyId: editingId,
        selectedStrategyColor: '#123456',
        currentStrategyGroups: [],
        currentUsername: 'test4',
        _editorGuardStale: () => false,
        _isCloudPrimarySave: () => true,
        _saveStrategyToSupabase: async s => { log.cloud.push(s); return { success: true }; },
        saveToIndexedDB: async () => { log.idb++; },
        closeStrategyEditor: () => {},
        updateStrategiesList: () => { log.listed.push(vals.journalData.strategies.map(s => s.id)); },
        updateStrategyDropdown: () => {},
        alert: () => { throw new Error('unexpected alert'); },
        document: { getElementById: id => fields[id] || null },
    };
    const code = extractStrategySubmit() + '\n' + extractFunction(APP, 'normalizeStrategyName');
    const box = sandbox(code, ['_strategySubmit', 'normalizeStrategyName'], vals);
    return { box, log };
}

const ev = { preventDefault: () => {} };

test('Strategy: saving one deleted on another device puts it back in the list', async () => {
    const { box, log } = strategyBox([{ id: 2, name: 'Other' }], 1700000000000);
    await box.fns._strategySubmit(ev);
    assert.equal(log.cloud.length, 1, 'still saved to the cloud (D3: editing keeps it)');
    assert.equal(log.cloud[0].id, 1700000000000);
    assert.deepEqual(box.g.journalData.strategies.map(s => s.id), [2, 1700000000000]);
    assert.equal(box.g.journalData.strategies[1], log.cloud[0]);
    assert.deepEqual(log.listed, [[2, 1700000000000]], 'list redrawn with it');
    assert.equal(log.idb, 1);
});

test('Strategy: a normal edit replaces in place, a new one is added once', async () => {
    let { box, log } = strategyBox([{ id: 5, name: 'Breakout', description: 'old', created: 'c' }, { id: 6, name: 'B' }], '5');
    await box.fns._strategySubmit(ev);
    assert.deepEqual(box.g.journalData.strategies.map(s => s.id), ['5', 6]);
    assert.equal(box.g.journalData.strategies[0].description, 'desc');
    assert.equal(box.g.journalData.strategies[0].created, 'c');
    ({ box, log } = strategyBox([{ id: 6, name: 'B' }], null));
    await box.fns._strategySubmit(ev);
    assert.equal(box.g.journalData.strategies.length, 2);
    assert.equal(log.cloud.length, 1);
});

// ── 4. Note Template save id lookup ─────────────────────────────────────────

function templateBox(templates, selectedId) {
    const log = { cloud: [], idb: 0, rendered: 0 };
    const box = fromSource(APP, ['tmSaveTemplate', '_tmSameId', '_tmFind'], {
        journalData: { noteTemplates: templates },
        _tmIsNewDraft: false,
        _tmplSelectedId: selectedId,
        _tmGetNotes: () => 'new notes',
        _editorGuardStale: () => false,
        _isCloudPrimarySave: () => true,
        _saveNoteTemplateToSupabase: async t => { log.cloud.push(t); return { success: true }; },
        saveToIndexedDB: async () => { log.idb++; },
        tmRenderList: () => { log.rendered++; },
        renderNoteTemplateDropdown: () => {},
        document: {
            getElementById: id => (id === 'tm-detail-name' ? { value: 'Renamed' } : null),
            querySelectorAll: () => [{ value: 'daily' }],
        },
    });
    return { box, log };
}

for (const [label, stored, selected] of [['string id, number selected', '42', 42],
                                         ['number id, string selected', 42, '42'],
                                         ['same type', 42, 42]]) {
    test('Note Template save: ' + label + ' still saves', async () => {
        const tmpl = { id: stored, name: 'Old', content: 'old', sourceType: 'user' };
        const { box, log } = templateBox([{ id: 7, name: 'Other', sourceType: 'user' }, tmpl], selected);
        await box.fns.tmSaveTemplate();
        assert.equal(tmpl.name, 'Renamed');
        assert.equal(tmpl.content, 'new notes');
        assert.deepEqual(tmpl.timeframes, ['daily']);
        assert.equal(tmpl.id, stored, 'id not changed');
        assert.deepEqual(log.cloud, [tmpl]);
        assert.equal(log.idb, 1);
    });
}

test('Note Template save: system templates and unknown ids are still not saved', async () => {
    let { box, log } = templateBox([{ id: 9, name: 'Sys', sourceType: 'system' }], '9');
    await box.fns.tmSaveTemplate();
    assert.equal(log.cloud.length, 0);
    ({ box, log } = templateBox([{ id: 9, name: 'A', sourceType: 'user' }], 10));
    await box.fns.tmSaveTemplate();
    assert.equal(log.cloud.length, 0);
});

// ── Versions ────────────────────────────────────────────────────────────────

test('index.html: changed scripts bumped', () => {
    const ver = file => Number((HTML.split('src="' + file + '?v=')[1] || '0"').split('"')[0]);
    assert.ok(ver('Denarii.js') >= 52);
    assert.ok(ver('js/ai-reports.js') >= 3);
    assert.ok(ver('js/pages/daily-planner.js') >= 3);
    assert.ok(ver('js/pages/weekly-planner.js') >= 3);
});

// ── Follow-ups: Copy as readable text ───────────────────────────────────────

test('Copy: a parsed report copies as plain text, not JSON', async () => {
    const structuredData = {
        title: 'Weekly Review', summary: 'Solid week.',
        sections: [
            { heading: 'What Worked', items: ['Waited for setups', ' Cut losers fast '] },
            { heading: 'Empty', items: [] },
            { heading: 'Fix Next', items: 'Size down after a loss' },
        ],
        bottom_line: 'Keep going.',
    };
    const { box, copied } = copyBox({ rawText: JSON.stringify(structuredData), structuredData,
        filters: { tradeCount: 8, tradesTrimmed: true } });
    await box.fns.copyReport();
    assert.equal(copied[0], [
        '8 trades analyzed (most recent)',
        'Weekly Review',
        'Executive Summary\nSolid week.',
        'What Worked\n- Waited for setups\n- Cut losers fast',
        'Fix Next\n- Size down after a loss',
        'Bottom Line\nKeep going.',
    ].join('\n\n'));
    assert.equal(/[{}"]/.test(copied[0]), false);
});

test('Copy: legacy-schema and prose reports copy with the viewer headings', async () => {
    let c = copyBox({ rawText: '{}', structuredData: {
        key_findings: ['A'], strengths: ['S'], weaknesses: ['W'],
        metrics: { win_rate: '60%', empty: '' }, recommendations: ['R1', 'R2'] } });
    await c.box.fns.copyReport();
    assert.equal(c.copied[0], ['Analysis Report', 'Top Findings\n- A',
        "Evidence From Your Trades\nWhat's Working\n- S\nWhat Needs Work\n- W",
        'Metrics Snapshot\n- Win Rate: 60%', 'Action Plan\n- R1\n- R2'].join('\n\n'));
    c = copyBox({ rawText: 'x', structuredData: { title: 'T', _prose: 'Just text.' } });
    await c.box.fns.copyReport();
    assert.deepEqual(c.copied, ['T\n\nJust text.']);
});

test('Copy: a report with no parsed structure copies its plain text as before', async () => {
    const { box, copied } = copyBox({ rawText: 'Plain **markdown**', structuredData: null, filters: { tradeCount: 2 } });
    await box.fns.copyReport();
    assert.deepEqual(copied, ['2 trades analyzed\n\nPlain **markdown**']);
});

// ── Follow-ups: template favorites, id lookups, Duplicate ───────────────────

const TM_HELPERS = ['_tmSameId', '_tmFind', '_tmIdArg', 'escapeHtml'];

function tmBox(names, templates, extra) {
    const log = { cloud: [], idb: 0, selected: [], refreshed: 0 };
    const vals = Object.assign({
        journalData: { noteTemplates: templates },
        _tmIsNewDraft: false, _tmplSelectedId: null, _tmFilter: 'all',
        _isCloudPrimarySave: () => true,
        _saveNoteTemplateToSupabase: async t => { log.cloud.push(Object.assign({}, t)); return { success: true }; },
        saveToIndexedDB: async () => { log.idb++; },
        _refreshAllTemplateDropdowns: () => { log.refreshed++; },
        tmRenderList: () => {},
        tmSelectTemplate: id => { log.selected.push(id); },
        renderNoteTemplateDropdown: () => {},
        document: { getElementById: () => null, querySelectorAll: () => [], querySelector: () => null },
    }, extra || {});
    return { box: fromSource(APP, TM_HELPERS.concat(names), vals), log };
}

const sysT = (id, name) => ({ id, name, content: name + ' body', sourceType: 'system', isFavorite: false });
const usrT = (id, name) => ({ id, name, content: name + ' body', sourceType: 'user', isFavorite: false });

test('Favorites: any number of System and user templates can be starred, each toggles alone', async () => {
    const tpls = [sysT('1', 'Pre-Trade Plan'), sysT(2, 'Post-Trade Review'), usrT('1729000000000', 'Mine')];
    const { box, log } = tmBox(['tmToggleFavoriteById'], tpls);
    await box.fns.tmToggleFavoriteById(1);              // number arg, string id stored
    await box.fns.tmToggleFavoriteById('2');            // string arg, number id stored
    await box.fns.tmToggleFavoriteById(1729000000000);
    assert.deepEqual(tpls.map(t => t.isFavorite), [true, true, true]);
    await box.fns.tmToggleFavoriteById('2');
    assert.deepEqual(tpls.map(t => t.isFavorite), [true, false, true], 'only that one unstarred');
    assert.equal(log.cloud.length, 4, 'each toggle saved through the existing template save');
    assert.deepEqual(log.cloud.map(t => t.isFavorite), [true, true, true, false]);
    assert.equal(log.idb, 4);
});

test('Favorites: the detail-panel star finds the template whatever the id type', async () => {
    const tpls = [sysT('3', 'Winning Trade Analysis'), sysT(4, 'Losing')];
    const { box } = tmBox(['tmToggleFavorite'], tpls, { _tmplSelectedId: 3 });
    await box.fns.tmToggleFavorite();
    assert.equal(tpls[0].isFavorite, true);
    assert.equal(tpls[1].isFavorite, false);
});

test('Favorites: starred System templates appear in the Reflection "Select template" dropdown', () => {
    const sel = { innerHTML: '' };
    const tpls = [Object.assign(sysT(5, 'Breakout Setup'), { isFavorite: true }),
                  Object.assign(usrT('17', 'A User One'), { isFavorite: true }),
                  sysT(6, 'Not Starred'),
                  Object.assign(usrT(18, 'Daily Only'), { isFavorite: true, timeframes: ['daily'] })];
    const { box } = tmBox(['renderNoteTemplateDropdown', '_favoriteTemplatesFor'], tpls,
        { document: { getElementById: id => (id === 'jnl-template-select' ? sel : null) } });
    box.fns.renderNoteTemplateDropdown();
    assert.equal(sel.innerHTML, '<option value="">Select template…</option>' +
        '<option value="17">A User One</option><option value="5">Breakout Setup</option>');
});

test('Template list: ids keep their type in the click handlers and the highlight matches', () => {
    const list = { innerHTML: '' };
    const tpls = [usrT('abc', 'B text id'), sysT(7, 'A number id')];
    const { box } = tmBox(['tmRenderList', 'tmGetFilteredTemplates'], tpls, {
        _tmplSelectedId: '7',
        document: { getElementById: id => (id === 'tm-list' ? list : null) },
    });
    box.fns.tmRenderList();
    assert.match(list.innerHTML, /onclick="tmSelectTemplate\(&quot;abc&quot;\)"/);
    assert.match(list.innerHTML, /tmToggleFavoriteById\(&quot;abc&quot;\)/);
    assert.match(list.innerHTML, /tm-list-item active" onclick="tmSelectTemplate\(7\)"/);
    assert.equal((list.innerHTML.match(/ active"/g) || []).length, 1);
});

test('Template lookups: delete and apply match string and number ids; no strict lookups left', async () => {
    const tpls = [usrT(42, 'Num'), usrT('43', 'Str')];
    const deleted = [];
    const { box } = tmBox(['tmDeleteTemplate', 'applyNoteTemplate'], tpls, {
        _tmplSelectedId: '42', confirm: () => true,
        _deleteNoteTemplateFromSupabase: id => { deleted.push(id); },
        _tmShowEmptyState: () => {},
    });
    await box.fns.tmDeleteTemplate();
    assert.deepEqual(box.g.journalData.noteTemplates.map(t => t.id), ['43']);
    assert.deepEqual(deleted, ['42']);
    assert.equal(box.g._tmplSelectedId, null);
    // Trade Reflection dropdown passes the option value (a string)
    let set = null;
    const ed = { innerHTML: '', focus: () => {} };
    Object.assign(box.g, { _jnlGetNotes: () => '', _jnlSetNotes: h => { set = h; },
        document: { getElementById: id => (id === 'jnl-notes' ? ed : null) } });
    box.fns.applyNoteTemplate('43');
    assert.equal(set, '<p>Str body</p>');
    assert.match(HTML, /onchange="applyNoteTemplate\(this\.value\);this\.value=''"/);
    for (const fn of ['tmSelectTemplate', 'tmToggleFavorite', 'tmToggleFavoriteById', 'tmSaveTemplate',
        'tmDeleteTemplate', 'tmApplyTemplate', 'tmRenderList', '_tmGuardOpen']) {
        assert.equal(/t\.id\s*[!=]==|_tmplSelectedId\s*===\s*id/.test(extractFunction(APP, fn)), false, fn);
    }
    assert.match(extractFunction(read('js/pages/reviews.js'), '_rvApplyTemplate'), /String\(all\[i\]\.id\) === String\(id\)/);
});

for (const [label, src] of [['System', sysT('9', 'News Catalyst Trade')], ['user', usrT(1700, 'My Setup')]]) {
    test('Duplicate: a ' + label + ' template becomes a new user template, opened under Mine', async () => {
        src.timeframes = ['trade'];
        const before = JSON.stringify(src);
        const tpls = [src];
        const { box, log } = tmBox(['tmDuplicateTemplate'], tpls, { _tmplSelectedId: Number(src.id) });
        await box.fns.tmDuplicateTemplate();
        assert.equal(tpls.length, 2);
        const copy = tpls[1];
        assert.equal(copy.name, src.name + ' (copy)');
        assert.equal(copy.content, src.content);
        assert.equal(copy.sourceType, 'user');
        assert.deepEqual(copy.timeframes, ['trade']);
        assert.notEqual(copy.timeframes, src.timeframes);
        assert.equal(typeof copy.id, 'number');
        assert.notEqual(String(copy.id), String(src.id));
        assert.equal(JSON.stringify(src), before, 'original unchanged');
        assert.deepEqual(log.cloud.map(t => t.id), [copy.id], 'saved to the cloud like any user template');
        assert.equal(log.idb, 1);
        assert.deepEqual(log.selected, [copy.id], 'selected and opened for editing');
        assert.equal(box.g._tmFilter, 'user');
    });
}

test('Duplicate: nothing for an unsaved draft; button in the existing style; System stays locked', async () => {
    const tpls = [sysT(1, 'X')];
    const { box, log } = tmBox(['tmDuplicateTemplate'], tpls, { _tmIsNewDraft: true, _tmplSelectedId: 1 });
    await box.fns.tmDuplicateTemplate();
    assert.equal(tpls.length, 1);
    assert.equal(log.cloud.length, 0);
    assert.match(HTML, /<button type="button" id="tm-duplicate-btn" class="btn btn-secondary btn-small" onclick="tmDuplicateTemplate\(\)"/);
    assert.match(extractFunction(APP, 'tmSelectTemplate'), /dupBtn\)\s+dupBtn\.style\.display\s+= ''/);
    assert.match(extractFunction(APP, 'tmNewTemplate'), /dupBtn\)\s+dupBtn\.style\.display = 'none'/);
    assert.match(extractFunction(APP, 'tmSelectTemplate'), /saveBtn\.style\.display = isSys \? 'none'/);
});

test('index.html: follow-up script bumps', () => {
    const ver = file => Number((HTML.split('src="' + file + '?v=')[1] || '0"').split('"')[0]);
    assert.ok(ver('Denarii.js') >= 53);
    assert.ok(ver('js/ai-reports.js') >= 4);
    assert.ok(ver('js/pages/reviews.js') >= 3);
});

// ── Follow-up: Copy reads what the viewer rendered ──────────────────────────

// Minimal HTML → node tree, enough for the renderer's own well-formed output.
function parseHtml(html) {
    const decode = s => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&amp;/g, '&');
    const el = (tag, attrs) => {
        const cls = ((/class="([^"]*)"/.exec(attrs || '') || [])[1] || '').split(/\s+/).filter(Boolean);
        return { nodeType: 1, tagName: tag.toUpperCase(), classList: { contains: c => cls.includes(c) }, childNodes: [],
            get textContent() { return this.childNodes.map(c => c.textContent).join(''); } };
    };
    const root = el('div', ''), stack = [root], re = /<(\/?)([a-zA-Z0-9]+)([^>]*)>|([^<]+)/g;
    let m;
    while ((m = re.exec(html))) {
        if (m[4] !== undefined) { stack[stack.length - 1].childNodes.push({ nodeType: 3, textContent: decode(m[4]) }); continue; }
        if (m[1]) { stack.pop(); continue; }
        const node = el(m[2], m[3]);
        stack[stack.length - 1].childNodes.push(node);
        if (!/^(br|hr|img|input)$/i.test(m[2]) && !/\/$/.test(m[3])) stack.push(node);
    }
    return root;
}

const RUN = read('js/ai-run.js');
const renderer = fromSource(RUN, ['_renderReport', '_toList', '_esc', '_renderMarkdown'], {}).fns;

function viewerCopyBox(report) {
    const body = parseHtml(renderer._renderReport(report.structuredData));
    const copied = [];
    const box = fromSource(REPORTS, ['copyReport', '_tradeCountText', '_reportPlainText', '_viewerPlainText'], Object.assign({
        _currentReport: report,
        navigator: { clipboard: { writeText: async t => { copied.push(t); } } },
        document: { getElementById: id => (id === 'ai-report-output-body' ? body : null) },
    }, noTimers));
    return { box, copied };
}

test('Copy: summary plus sections copies every heading and bullet the viewer shows', async () => {
    const structuredData = {
        title: 'Winners vs. Losers',
        summary: 'Your winners share tight stops & early entries.',
        sections: [
            { heading: 'Core Analysis: Patterns Defining Winners vs. Losers',
              items: ['Winners averaged a 1.2% stop vs 3.4% on losers', 'Losers clustered after 2pm'] },
            { heading: 'Behavioral Patterns', items: ['Revenge trades after a red open', 'Oversizing on "sure things"'] },
            { heading: 'Recommendations', items: ['Cap risk at 1%', 'No new entries after 2pm'] },
        ],
        bottom_line: 'Cut late-day trading.',
    };
    const { box, copied } = viewerCopyBox({ rawText: JSON.stringify(structuredData), structuredData,
        filters: { tradeCount: 40, tradesTrimmed: false } });
    await box.fns.copyReport();
    assert.equal(copied[0], [
        '40 trades analyzed',
        'Winners vs. Losers',
        'Executive Summary\nYour winners share tight stops & early entries.',
        'Core Analysis: Patterns Defining Winners vs. Losers\n- Winners averaged a 1.2% stop vs 3.4% on losers\n- Losers clustered after 2pm',
        'Behavioral Patterns\n- Revenge trades after a red open\n- Oversizing on "sure things"',
        'Recommendations\n- Cap risk at 1%\n- No new entries after 2pm',
        'Bottom Line\nCut late-day trading.',
    ].join('\n\n'));
    // Same text as the data formatter for this shape
    assert.equal(copied[0].split('\n\n').slice(1).join('\n\n'), box.fns._reportPlainText(structuredData));
});

test('Copy: legacy-schema viewer output copies its headings, bullets and metrics', async () => {
    const structuredData = { title: 'Old', key_findings: ['A'], strengths: ['S'], metrics: { win_rate: '60%' }, recommendations: ['R'] };
    const { box, copied } = viewerCopyBox({ rawText: '{}', structuredData });
    await box.fns.copyReport();
    assert.equal(copied[0], ['Old', 'Top Findings\n- A', "Evidence From Your Trades\n\nWhat's Working\n- S",
        'Metrics Snapshot\n- Win Rate: 60%', 'Action Plan\n- R'].join('\n\n'));
});

test('index.html: ai-reports.js bumped for the viewer copy', () => {
    assert.ok(Number(HTML.split('src="js/ai-reports.js?v=')[1].split('"')[0]) >= 5);
});
