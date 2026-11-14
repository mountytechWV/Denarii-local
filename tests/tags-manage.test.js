// Tags Management: the page opens from the sidebar only (no Settings nav
// item), and opening Settings itself falls back to Profile.
//
// Same approach as batch-c1.test.js: the real functions are cut out of the
// source and run inside a `with` scope where unknown globals are inert.
// Sources are read with LF line endings so a Windows (CRLF) checkout matches.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SET  = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'settings.js'), 'utf8').replace(/\r\n/g, '\n');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8').replace(/\r\n/g, '\n');

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

// parts: [[source, [function names]], ...]
function sandbox(parts, vals) {
    const names = [];
    const code = parts.map(([src, fnNames]) => {
        names.push(...fnNames);
        return fnNames.map(n => extractFunction(src, n)).join('\n');
    }).join('\n');
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

// Minimal panel/nav DOM for switchSettingsTab and openSettings.
function settingsDoc(activePanel) {
    const mk = (id, extra) => {
        const cls = new Set();
        return Object.assign({
            id, dataset: {},
            classList: {
                contains: c => cls.has(c),
                toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); },
                remove: c => cls.delete(c),
            },
        }, extra);
    };
    const panels = ['settings-profile', 'settings-tags', 'settings-integrations'].map(id => mk(id));
    panels.find(p => p.id === activePanel).classList.toggle('active', true);
    const navItems = ['settings-profile', 'settings-integrations'].map(t => mk('', { dataset: { settingsTab: t } }));
    return {
        panels, navItems,
        getElementById: id => panels.find(p => p.id === id) || null,
        querySelectorAll: sel => sel === '.settings-panel' ? panels : sel === '.settings-nav-item' ? navItems : [],
    };
}
const activeIds = doc => doc.panels.filter(p => p.classList.contains('active')).map(p => p.id);

// ── Step A: Settings nav ────────────────────────────────────────────────────

test('Settings nav has no Tags Management item; the sidebar link and panel stay', () => {
    assert.ok(!HTML.includes('data-settings-tab="settings-tags"'));
    assert.match(HTML, /title="Tags Management" onclick="setTimeout\(function\(\)\{switchSettingsTab\('settings-tags'\)\},0\)"/);
    assert.ok(HTML.includes('<div class="settings-panel" id="settings-tags">'));
    assert.ok(HTML.includes('<strong>Strategy &amp; Tags &rarr; Tags Management</strong>'));
    assert.ok(!HTML.includes('Settings &rarr; Tags Management'));
});

test('openSettings: falls back to Profile when Tags Management was the open panel', () => {
    const doc = settingsDoc('settings-tags');
    const { fns } = sandbox([[SET, ['openSettings', 'switchSettingsTab']]], { document: doc });
    fns.openSettings();
    assert.deepEqual(activeIds(doc), ['settings-profile']);
    assert.ok(doc.navItems[0].classList.contains('active'));
});

test('openSettings: keeps any other open panel', () => {
    const doc = settingsDoc('settings-integrations');
    const { fns } = sandbox([[SET, ['openSettings', 'switchSettingsTab']]], { document: doc });
    fns.openSettings();
    assert.deepEqual(activeIds(doc), ['settings-integrations']);
});

test('switchSettingsTab: Tags Management opens with no Settings nav item highlighted', () => {
    const doc = settingsDoc('settings-profile');
    const { fns } = sandbox([[SET, ['switchSettingsTab']]], { document: doc });
    fns.switchSettingsTab('settings-tags');
    assert.deepEqual(activeIds(doc), ['settings-tags']);
    assert.ok(doc.navItems.every(b => !b.classList.contains('active')));
});

// ── Tags Management as its own page ─────────────────────────────────────────

const APP_SRC = fs.readFileSync(path.join(ROOT, 'Denarii.js'), 'utf8').replace(/\r\n/g, '\n');
const SECTION_META = new Function('return ' +
    APP_SRC.slice(APP_SRC.indexOf('const sectionMeta = {') + 'const sectionMeta = '.length, APP_SRC.indexOf('\n        };\n', APP_SRC.indexOf('const sectionMeta = {')) + 10) + ';')();

// Settings section, header and sidebar around settingsDoc. activateSection is
// a stand-in for the Denarii.js one: it lights the sidebar items whose
// data-tab matches, shows the section, sets the header, then runs the
// Settings hook, as the real one does (checked against its source below).
function pageModeHarness(activePanel) {
    const doc = settingsDoc(activePanel);
    const mk = (id, extra) => {
        const cls = new Set();
        return Object.assign({ id, dataset: {}, textContent: '', classList: {
            contains: c => cls.has(c), toggle: (c, on) => { if (on) cls.add(c); else cls.delete(c); }, remove: c => cls.delete(c),
        } }, extra);
    };
    const section = mk('settings'), title = mk('workspace-page-title'), subtitle = mk('workspace-page-subtitle');
    const sidebar = [mk('', { dataset: { tab: 'dashboard' } }), mk('', { dataset: { tab: 'settings' }, title: 'Tags Management' })];
    const byId = doc.getElementById, qsa = doc.querySelectorAll;
    doc.getElementById = id => ({ settings: section, 'workspace-page-title': title, 'workspace-page-subtitle': subtitle }[id] || byId(id));
    doc.querySelectorAll = sel => sel === '.nav-item' ? sidebar
        : sel === '.nav-item[data-tab="settings"]' ? sidebar.filter(i => i.dataset.tab === 'settings') : qsa(sel);
    const win = {};
    const { fns, g } = sandbox([[SET, ['openSettings', 'switchSettingsTab', 'applySettingsPageMode']], [APP_SRC, ['setWorkspaceHeader']]], {
        document: doc, window: win, sectionMeta: SECTION_META,
        activateSection(id) {
            sidebar.forEach(i => i.classList.toggle('active', i.dataset.tab === id));
            section.classList.toggle('active', id === 'settings');
            fns.setWorkspaceHeader(id);
            if (id === 'settings') fns.applySettingsPageMode();
        },
    });
    const header = () => [title.textContent, subtitle.textContent];
    const tagsLit = () => sidebar[1].classList.contains('active');
    return { fns, doc, section, header, tagsLit, sidebar, activate: id => g.activateSection(id) };
}
const TAGS_HEADER = ['Tags Management', 'Organize your tag categories and the tags you use on trades.'];
const SETTINGS_HEADER = ['Settings', 'Manage your profile, security, and integrations.'];

test('Tags page mode: activateSection runs the Settings hook after the header; CSS hides the nav', () => {
    const act = APP_SRC.slice(APP_SRC.indexOf('function activateSection('), APP_SRC.indexOf('// Dashboard: apply preferred default view'));
    assert.match(act, /setWorkspaceHeader\(sectionId\);\s*\/\/[^\n]*\n\s*if \(sectionId === 'settings' && typeof window\.applySettingsPageMode === 'function'\) window\.applySettingsPageMode\(\);/);
    assert.match(SET, /window\.applySettingsPageMode\s*=\s*applySettingsPageMode;/);
    const CSS = fs.readFileSync(path.join(ROOT, 'css', 'denarii-ds.css'), 'utf8').replace(/\r\n/g, '\n');
    assert.ok(CSS.includes('#settings.settings--tags-page .settings-sidebar { display: none; }'));
    assert.ok(CSS.includes('#settings.settings--tags-page .settings-layout { grid-template-columns: minmax(0, 1fr); }'));
});

test('Tags page mode: sidebar link shows the Tags header, hides the Settings nav, keeps the item lit', () => {
    const h = pageModeHarness('settings-profile');
    // Sidebar click: activateSection('settings'), then switchSettingsTab on the next tick.
    h.activate('settings');
    h.fns.switchSettingsTab('settings-tags');
    assert.deepEqual(h.header(), TAGS_HEADER);
    assert.ok(h.section.classList.contains('settings--tags-page'));
    assert.ok(h.tagsLit());
});

test('Tags page mode: "Manage Tags" buttons land on the same Tags page', () => {
    const h = pageModeHarness('settings-tags');
    h.activate('dashboard');
    h.activate('settings');
    assert.deepEqual(h.header(), TAGS_HEADER, 'header already matches when the Tags panel was the last one open');
    h.fns.switchSettingsTab('settings-tags');
    assert.deepEqual(h.header(), TAGS_HEADER);
    assert.ok(h.section.classList.contains('settings--tags-page') && h.tagsLit());
});

test('Tags page mode: Settings from the profile menu restores the normal header, nav and Profile tab', () => {
    const h = pageModeHarness('settings-profile');
    h.activate('settings');
    h.fns.switchSettingsTab('settings-tags');
    h.fns.openSettings();
    assert.deepEqual(h.header(), SETTINGS_HEADER);
    assert.ok(!h.section.classList.contains('settings--tags-page'));
    assert.deepEqual(activeIds(h.doc), ['settings-profile']);
    assert.ok(h.doc.navItems[0].classList.contains('active'));
    assert.ok(h.sidebar.every(i => !i.classList.contains('active')));

    // From another panel, too.
    const h2 = pageModeHarness('settings-integrations');
    h2.fns.openSettings();
    assert.deepEqual(h2.header(), SETTINGS_HEADER);
    assert.ok(!h2.section.classList.contains('settings--tags-page'));
    assert.ok(!h2.tagsLit());
});

test('Tags page mode: leaving and coming back keeps the header in step with the page', () => {
    const h = pageModeHarness('settings-profile');
    h.activate('settings');
    h.fns.switchSettingsTab('settings-tags');
    h.activate('dashboard');
    assert.deepEqual(h.header(), ['Dashboard', SECTION_META.dashboard.subtitle]);
    assert.ok(!h.tagsLit());
    h.activate('settings');
    h.fns.switchSettingsTab('settings-tags');
    assert.deepEqual(h.header(), TAGS_HEADER);
    h.fns.openSettings();
    assert.deepEqual(h.header(), SETTINGS_HEADER);
    h.activate('settings');
    h.fns.switchSettingsTab('settings-tags');
    assert.deepEqual(h.header(), TAGS_HEADER);
    assert.ok(h.tagsLit());
});

// ── Step B: Tag Usage widget in Analytics > Strategy ────────────────────────

const SU = fs.readFileSync(path.join(ROOT, 'js', 'pages', 'setups.js'), 'utf8').replace(/\r\n/g, '\n');

// Runs the whole Strategy IIFE with a fake grid and opens the page with the
// given saved layout (initSetups copies journalData.setupsLayout).
function strategyPage(journalData, layout) {
    const grid = { className: '', innerHTML: '', addEventListener() {} };
    const win = {};
    const doc = {
        getElementById: id => (id === 'setups-grid' ? grid : null),
        querySelectorAll: () => [],
        addEventListener() {},
    };
    const DenariiFilters = {
        readState: () => ({}),
        mountFilterBar() {},
        // The page hands over trades already narrowed by the filter bar.
        filterTrades: trades => trades.filter(t => !t._filteredOut),
        populateStrategy() {},
        followStrategyRename() {},
    };
    new Function('window', 'document', 'journalData', 'DenariiFilters', 'getSelectedAccountTrades', 'setTimeout', SU)(
        win, doc, journalData, DenariiFilters, t => t, () => {});
    if (layout) journalData.setupsLayout = layout;
    win._setupsInit();
    return { win, grid, render: () => { win.renderSetups(); return grid.innerHTML; } };
}

const cells = (html, tag) => {
    const row = html.match(new RegExp('<tr[^>]*><td title="' + tag + '">.*?</tr>'));
    return row ? [...row[0].matchAll(/<td[^>]*>(.*?)<\/td>/g)].map(m => m[1].replace(/<[^>]+>/g, '')) : null;
};
const tagOrder = html => [...html.matchAll(/<tr[^>]*><td title="([^"]+)">/g)].map(m => m[1]);

function tagJournal() {
    return {
        tags: [
            { id: 't1', name: 'FOMO Entry', category: 'Mistakes', description: 'Chased it' },
            { id: 't2', name: 'Breakout', category: 'Setups', description: '' },
            { id: 't3', name: 'Never Used', category: 'Setups', description: 'idle' },
        ],
        trades: [
            { id: 1, pnl: 100, tags: ['Breakout'] },
            { id: 2, pnl: -40, tags: ['breakout', 'FOMO Entry'] },
            { id: 3, pnl: -25, tags: ['fomo entry', 'FOMO Entry'] },
            { id: 4, pnl: 500, tags: ['Breakout'], _filteredOut: true },
            { id: 5, pnl: 10 },
        ],
    };
}

test('Tag Usage: in the widget catalog and SU_DEFAULT; a saved layout is never rewritten', () => {
    assert.ok(SU.includes("{ wid:'tag-usage',"));
    assert.match(SU, /\{ id:'su17', wid:'tag-usage',\s+size:'large'\s+\}\s*\];/);
    const jd = tagJournal();
    const saved = [{ id: 'su5', wid: 'setup-leaderboard', size: 'large' }];
    const { win, grid } = strategyPage(jd, saved);
    win.setSetupsTagSort('name');
    assert.deepEqual(jd.setupsLayout, [{ id: 'su5', wid: 'setup-leaderboard', size: 'large' }]);
    assert.ok(!grid.innerHTML.includes('Tag Usage'));
    // No saved layout (new user, or after Reset): the default shows it.
    const fresh = strategyPage(tagJournal(), null);
    assert.ok(fresh.grid.innerHTML.includes('<span class="snap-widget-title">Tag Usage</span>'));
});

test('Tag Usage: Used, Net P&L, Win Rate from the filtered trades; default sort Used descending', () => {
    const jd = tagJournal();
    const page = strategyPage(jd, [{ id: 'x', wid: 'tag-usage', size: 'large' }]);
    const before = JSON.stringify(jd);
    const html = page.render();
    assert.ok(html.includes('<span class="snap-widget-title">Tag Usage</span>'));
    // Trade 4 is filtered out; trade 3 lists FOMO twice but counts once.
    assert.deepEqual(cells(html, 'Breakout'),   ['Breakout', 'Setups', '2', '$60.00', '50.0%', '']);
    assert.deepEqual(cells(html, 'FOMO Entry'), ['FOMO Entry', 'Mistakes', '2', '-$65.00', '0.0%', 'Chased it']);
    assert.deepEqual(cells(html, 'Never Used'), ['Never Used', 'Setups', '0', '—', '—', 'idle']);
    assert.match(html, /<td class="su-tu-pnl su-lb-pos">\$60\.00<\/td>/);
    assert.match(html, /<td class="su-tu-pnl su-lb-neg">-\$65\.00<\/td>/);
    assert.match(html, /<tr class="su-tu-unused"><td title="Never Used">/);
    // Ties on Used fall back to name A-Z.
    assert.deepEqual(tagOrder(html), ['Breakout', 'FOMO Entry', 'Never Used']);
    assert.equal(JSON.stringify(jd), before, 'journalData untouched');
});

test('Tag Usage: sorting by column, unused tags stay last on numeric sorts, Hide unused', () => {
    const jd = tagJournal();
    const page = strategyPage(jd, [{ id: 'x', wid: 'tag-usage', size: 'large' }]);
    page.render();
    page.win.setSetupsTagSort('pnl');
    assert.deepEqual(tagOrder(page.grid.innerHTML), ['Breakout', 'FOMO Entry', 'Never Used']);
    page.win.setSetupsTagSort('pnl');
    assert.deepEqual(tagOrder(page.grid.innerHTML), ['FOMO Entry', 'Breakout', 'Never Used']);
    page.win.setSetupsTagSort('name');
    assert.deepEqual(tagOrder(page.grid.innerHTML), ['Breakout', 'FOMO Entry', 'Never Used']);
    page.win.setSetupsTagHideUnused(true);
    assert.deepEqual(tagOrder(page.grid.innerHTML), ['Breakout', 'FOMO Entry']);
    assert.match(page.grid.innerHTML, /<input type="checkbox" checked onchange="setSetupsTagHideUnused/);
    assert.equal(jd.setupsLayout.length, 1);
});

test('Tag Usage: empty states, and category colour comes from Tags Management', () => {
    const none = strategyPage({ tags: [], trades: [] }, [{ id: 'x', wid: 'tag-usage', size: 'large' }]);
    assert.ok(none.render().includes('No tags yet. Create tags in Tags Management.'));

    const jd = tagJournal();
    jd.trades = [];
    const page = strategyPage(jd, [{ id: 'x', wid: 'tag-usage', size: 'large' }]);
    page.win.getTagCategoryColor = cat => (cat === 'Mistakes' ? '#E07070' : '#38BFA1');
    page.win.setSetupsTagHideUnused(true);
    assert.ok(page.grid.innerHTML.includes('No tags are used on trades in the current view.'));
    page.win.setSetupsTagHideUnused(false);
    assert.match(page.grid.innerHTML, /<span class="tag-category-dot" style="background:#E07070;"><\/span>Mistakes/);
    assert.match(SET, /window\.getTagCategoryColor\s*=\s*getTagCategoryColor;/);
});

// ── Step C: Tags Management, categories expand in place ─────────────────────

const APP = fs.readFileSync(path.join(ROOT, 'Denarii.js'), 'utf8').replace(/\r\n/g, '\n');
const TAG_CONSTS = new Function(
    SET.match(/const DEFAULT_CATEGORIES = [\s\S]*?const EXTRA_COLORS = [^;]*;/)[0] +
    '\nreturn { DEFAULT_CATEGORIES, CATEGORY_COLORS, EXTRA_COLORS };')();
const TAG_FNS = ['getCategories', 'isSystemCategory', 'ensureCategoryMeta', 'isCategoryFavorite', 'setCategoryFavorite',
    'getTagCategoryColor', 'populateCategoryDropdowns', 'ensureTagsArray', 'loadTagsData', 'renderCategoryList',
    'tagCategoryHtml', 'tgmCat', 'tgmToggleCategory', 'showNewCategoryForm', 'hideNewCategoryForm', 'closeTagMenu',
    'editTag', 'deleteTag', 'toggleTagFavorite', 'showAddTagForm', 'cancelTagForm', 'saveTag', 'showSettingsMsg',
    'toggleCategoryFavorite', 'editCategory', 'cancelCategoryEdit', 'saveCategoryEdit', 'deleteCategory', 'addCategory'];

const unescapeHtml = s => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

// Just enough DOM for the Tags Management panel. Elements rendered into
// #category-list exist only while their id is in its current HTML, and the
// Category <select> behaves like a real one (an unknown value selects nothing).
function tagsDom() {
    const els = {};
    let rendered = new Set();
    const mk = id => {
        const el = {
            id, style: {}, textContent: '', className: '', parentNode: null, _html: '', _v: '',
            focus() {}, select() {},
            appendChild(child) { child.parentNode = el; },
            get innerHTML() { return el._html; },
            set innerHTML(v) {
                el._html = v;
                if (id === 'category-list') {
                    rendered.forEach(r => delete els[r]);
                    rendered = new Set([...v.matchAll(/id="([^"]+)"/g)].map(m => m[1]));
                }
                if (id === 'tag-category-input') el._v = el.options()[0] ?? '';
            },
            options: () => [...el._html.matchAll(/<option value="([^"]*)"/g)].map(m => unescapeHtml(m[1])),
            get value() { return el._v; },
            set value(v) { el._v = id !== 'tag-category-input' || el.options().includes(v) ? v : ''; },
        };
        return el;
    };
    const doc = {
        getElementById(id) {
            if ((id.startsWith('tgm-') || id === 'category-edit-input') && !rendered.has(id)) return null;
            return els[id] || (els[id] = mk(id));
        },
        querySelectorAll: () => [],
        addEventListener() {},
    };
    doc.getElementById('tag-form-card').style.display = 'none';
    doc.getElementById('tag-form-card').parentNode = doc.getElementById('tag-form-home');
    return doc;
}

function tagsPage(journalData, opts) {
    opts = opts || {};
    const doc = tagsDom();
    const sent = [], removed = [];
    let idbSaves = 0;
    const { fns, g } = sandbox([[SET, TAG_FNS], [APP, ['escapeHtml']]], Object.assign({
        document: doc, journalData, window: {},
        editingTagId: null, editingCategoryName: null, _activeTagMenu: null,
        _tgmOpenCategory: null, _tgmFormCategory: null, _tgmCats: [],
        _isCloudPrimarySave: () => true,
        _saveTagToSupabase: t => sent.push(JSON.parse(JSON.stringify(t))),
        _deleteTagFromSupabase: id => removed.push(id),
        saveToIndexedDB: async () => { idbSaves++; },
        setTimeout: () => {},
        alert: () => {},
        _editorGuardOpen: undefined, _editorGuardClose: undefined, _editorGuardStale: undefined,
    }, TAG_CONSTS, opts.vals || {}));
    g.window.confirm = opts.confirm || (() => true);
    fns.loadTagsData();
    const list = () => doc.getElementById('category-list').innerHTML;
    return { fns, g, doc, list, sent, removed, idbSaves: () => idbSaves,
        catIndex: name => g._tgmCats.indexOf(name),
        formIn: () => doc.getElementById('tag-form-card').parentNode.id,
        openCats: () => [...list().matchAll(/<div class="tgm-cat is-open[^"]*">.*?<span class="tgm-cat-name">([^<]*)</g)].map(m => unescapeHtml(m[1])),
        catNames: () => [...list().matchAll(/<span class="tgm-cat-name">([^<]*)</g)].map(m => unescapeHtml(m[1])),
        tagNames: () => [...list().matchAll(/<span class="tgm-tag-name">([^<]*)</g)].map(m => unescapeHtml(m[1])),
    };
}

function tagsData() {
    return {
        tagCategories: ['Setups', 'Mistakes', 'Risk'],
        _categoryMeta: { Setups: { isFavorite: true }, Mistakes: { isFavorite: true }, Risk: { isFavorite: false } },
        tags: [
            { id: 'tag_starter_006', name: 'Gap and Go', category: 'Setups', isStarter: true },
            { id: 'tag_a', name: 'Breakout', category: 'Setups', description: 'Range break' },
            { id: 'tag_b', name: 'FOMO', category: 'Mistakes', description: 'Chased' },
            { id: 'tag_c', name: 'Sized up', category: 'Risk', description: 'Too big' },
            { id: 'tag_d', name: 'Orphan', category: '', description: '' },
        ],
        trades: [],
    };
}

test('Tags Management markup: old table, filter bar and category manager are gone; tag form ids kept', () => {
    const panel = HTML.slice(HTML.indexOf('<div class="settings-panel" id="settings-tags">'), HTML.indexOf('<!-- INTEGRATIONS -->'));
    for (const gone of ['id="tags-table"', 'tags-table-body', 'id="tag-filter-category"', 'category-manage-card', 'Manage Categories', 'tags-filter-bar', 'setTagSort'])
        assert.ok(!panel.includes(gone), gone);
    for (const id of ['tag-form-card', 'tag-form-title', 'tag-name-input', 'tag-category-input', 'tag-desc-input', 'tag-form-msg',
                      'category-list', 'category-new-card', 'new-category-input', 'category-form-msg', 'tag-save-msg', 'tag-search-input'])
        assert.ok(panel.includes('id="' + id + '"'), id);
    assert.ok(panel.indexOf('id="tag-form-home"') < panel.indexOf('id="tag-form-card"'));
    assert.match(panel, /onclick="showNewCategoryForm\(\)">\+ New category</);
    assert.match(panel, /id="tag-search-input"[^>]*oninput="renderCategoryList\(\)"/);
    for (const gone of ['renderTagsTable', 'openCategoryManager', 'closeCategoryManager', 'tag-filter-category', 'countTagUsage'])
        assert.ok(!SET.includes(gone) && !HTML.includes(gone), gone);
});

test('Categories: all listed with counts and favorite state; one open at a time; nothing is saved', () => {
    const jd = tagsData();
    const before = JSON.stringify(jd);
    const p = tagsPage(jd);
    assert.deepEqual(p.catNames(), ['Setups', 'Mistakes', 'Risk', 'No category']);
    assert.match(p.list(), /Setups<\/span><span class="tgm-cat-count">2 tags</);
    assert.match(p.list(), /<div class="tgm-cat is-unfav">.*?Risk</);
    assert.deepEqual(p.openCats(), []);
    p.fns.tgmToggleCategory(p.catIndex('Setups'));
    assert.deepEqual(p.openCats(), ['Setups']);
    assert.deepEqual(p.tagNames(), ['Breakout', 'Gap and Go']);
    assert.match(p.list(), /Gap and Go<\/span><span class="tgm-badge"/);
    assert.match(p.list(), /\+ Add tag to Setups/);
    p.fns.tgmToggleCategory(p.catIndex('Mistakes'));
    assert.deepEqual(p.openCats(), ['Mistakes']);
    p.fns.tgmToggleCategory(p.catIndex('Mistakes'));
    assert.deepEqual(p.openCats(), []);
    assert.equal(JSON.stringify(jd), before);
    assert.equal(p.idbSaves(), 0);
    assert.equal(p.sent.length, 0);
});

test('Search: filters tags across categories, opens each match; clicking a category clears it', () => {
    const p = tagsPage(tagsData());
    const search = p.doc.getElementById('tag-search-input');
    search.value = 'too';
    p.fns.renderCategoryList();
    assert.deepEqual(p.catNames(), ['Risk']);
    assert.deepEqual(p.openCats(), ['Risk']);
    search.value = 'o';
    p.fns.renderCategoryList();
    assert.deepEqual(p.openCats(), ['Setups', 'Mistakes', 'Risk', 'No category']);
    search.value = 'zzz';
    p.fns.renderCategoryList();
    assert.match(p.list(), /No tags match your search\./);
    search.value = 'fomo';
    p.fns.renderCategoryList();
    p.fns.tgmToggleCategory(p.catIndex('Mistakes'));
    assert.equal(search.value, '');
    assert.deepEqual(p.openCats(), ['Mistakes']);
});

test('Tag add: "+ Add tag to <category>" pre-fills the category, the form sits in it, save is unchanged', async () => {
    const jd = tagsData();
    const p = tagsPage(jd);
    p.fns.showAddTagForm(p.fns.tgmCat(p.catIndex('Mistakes')));
    assert.equal(p.doc.getElementById('tag-category-input').value, 'Mistakes');
    assert.equal(p.formIn(), 'tgm-form-slot-' + p.catIndex('Mistakes'));
    // Re-rendering (e.g. a favorite toggle) keeps the form and its inputs.
    p.doc.getElementById('tag-name-input').value = 'Revenge';
    p.fns.renderCategoryList();
    assert.equal(p.formIn(), 'tgm-form-slot-' + p.catIndex('Mistakes'));
    assert.equal(p.doc.getElementById('tag-name-input').value, 'Revenge');
    // Opening another category parks the form; reopening brings it back.
    p.fns.tgmToggleCategory(p.catIndex('Setups'));
    assert.equal(p.formIn(), 'tag-form-home');
    p.fns.tgmToggleCategory(p.catIndex('Mistakes'));
    assert.equal(p.formIn(), 'tgm-form-slot-' + p.catIndex('Mistakes'));

    p.doc.getElementById('tag-desc-input').value = 'After a loss';
    await p.fns.saveTag();
    const added = jd.tags.find(t => t.name === 'Revenge');
    assert.deepEqual([added.category, added.description], ['Mistakes', 'After a loss']);
    assert.match(added.id, /^tag_\d+_/);
    assert.deepEqual(p.sent.map(t => t.name), ['Revenge']);
    assert.equal(p.idbSaves(), 1);
    assert.equal(p.doc.getElementById('tag-form-card').style.display, 'none');
    assert.deepEqual(p.openCats(), ['Mistakes']);
    assert.match(p.doc.getElementById('tag-save-msg').textContent, /Tag saved/);
});

test('Tag add to an unfavorited category keeps that category (no silent fallback)', async () => {
    const jd = tagsData();
    const p = tagsPage(jd);
    p.fns.showAddTagForm('Risk');
    assert.equal(p.doc.getElementById('tag-category-input').value, 'Risk');
    p.doc.getElementById('tag-name-input').value = 'No stop';
    await p.fns.saveTag();
    assert.equal(jd.tags.find(t => t.name === 'No stop').category, 'Risk');
});

test('Tag edit: a tag in an unfavorited category keeps its category on save', async () => {
    const jd = tagsData();
    const p = tagsPage(jd);
    p.fns.editTag('tag_c');
    const sel = p.doc.getElementById('tag-category-input');
    assert.equal(sel.value, 'Risk');
    assert.ok(sel.options().includes('Risk'));
    assert.deepEqual(p.openCats(), ['Risk']);
    assert.equal(p.formIn(), 'tgm-form-slot-' + p.catIndex('Risk'));
    p.doc.getElementById('tag-desc-input').value = 'Way too big';
    await p.fns.saveTag();
    assert.deepEqual(jd.tags.find(t => t.id === 'tag_c'), { id: 'tag_c', name: 'Sized up', category: 'Risk', description: 'Way too big' });
    assert.deepEqual(p.sent.map(t => [t.id, t.category]), [['tag_c', 'Risk']]);
});

test('Tag edit: name and category change save as before; a tag with no category stays editable', async () => {
    const jd = tagsData();
    const p = tagsPage(jd);
    p.fns.editTag('tag_a');
    p.doc.getElementById('tag-name-input').value = 'Breakout 2';
    p.doc.getElementById('tag-category-input').value = 'Mistakes';
    await p.fns.saveTag();
    assert.deepEqual([jd.tags[1].name, jd.tags[1].category], ['Breakout 2', 'Mistakes']);
    assert.deepEqual(p.openCats(), ['Mistakes']);

    p.fns.editTag('tag_d');
    assert.equal(p.doc.getElementById('tag-category-input').value, '');
    assert.deepEqual(p.openCats(), ['No category']);
    p.doc.getElementById('tag-desc-input').value = 'kept';
    await p.fns.saveTag();
    assert.deepEqual([jd.tags[4].category, jd.tags[4].description], ['', 'kept']);
});

test('Tag favorite and delete use the existing save paths', () => {
    const jd = tagsData();
    const p = tagsPage(jd);
    p.fns.tgmToggleCategory(p.catIndex('Setups'));
    p.fns.toggleTagFavorite('tag_a');
    assert.equal(jd.tags[1].isFavorite, false);
    assert.deepEqual(p.sent.map(t => [t.id, t.isFavorite]), [['tag_a', false]]);
    assert.match(p.list(), /<div class="tgm-tag is-unfav">.*?Breakout/);
    assert.deepEqual(p.openCats(), ['Setups']);

    p.fns.deleteTag('tag_a');
    assert.ok(!jd.tags.some(t => t.id === 'tag_a'));
    assert.deepEqual(p.removed, ['tag_a']);
    assert.deepEqual(p.tagNames(), ['Gap and Go']);

    const kept = tagsPage(tagsData(), { confirm: () => false });
    kept.fns.deleteTag('tag_b');
    assert.ok(kept.g.journalData.tags.some(t => t.id === 'tag_b'));
});

test('Category add: "+ New category" form adds, favorites and opens it', async () => {
    const jd = tagsData();
    const p = tagsPage(jd);
    p.fns.showNewCategoryForm();
    assert.equal(p.doc.getElementById('category-new-card').style.display, 'flex');
    p.doc.getElementById('new-category-input').value = 'Psychology';
    await p.fns.addCategory();
    assert.deepEqual(jd.tagCategories, ['Setups', 'Mistakes', 'Risk', 'Psychology']);
    assert.deepEqual(jd._categoryMeta.Psychology, { isFavorite: true });
    assert.equal(p.doc.getElementById('category-new-card').style.display, 'none');
    assert.deepEqual(p.openCats(), ['Psychology']);
    assert.match(p.list(), /No tags in this category yet\./);

    p.fns.showNewCategoryForm();
    p.doc.getElementById('new-category-input').value = 'setups';
    await p.fns.addCategory();
    assert.match(p.doc.getElementById('category-form-msg').textContent, /already exists/);
    assert.equal(jd.tagCategories.length, 4);
});

test('Category rename: tags, open category and an open tag form follow the new name', async () => {
    const jd = tagsData();
    jd.tagCategories.push('Custom');
    jd.tags.push({ id: 'tag_e', name: 'Thing', category: 'Custom' });
    const p = tagsPage(jd);
    p.fns.editTag('tag_e');
    p.fns.editCategory('Custom');
    const input = p.doc.getElementById('category-edit-input');
    assert.ok(input, 'inline rename input rendered');
    input.value = 'Custom 2';
    await p.fns.saveCategoryEdit('Custom');
    assert.deepEqual(jd.tagCategories, ['Setups', 'Mistakes', 'Risk', 'Custom 2']);
    assert.equal(jd.tags.find(t => t.id === 'tag_e').category, 'Custom 2');
    assert.deepEqual(p.openCats(), ['Custom 2']);
    assert.equal(p.doc.getElementById('tag-category-input').value, 'Custom 2');
    assert.equal(p.formIn(), 'tgm-form-slot-' + p.catIndex('Custom 2'));
    await p.fns.saveTag();
    assert.equal(jd.tags.find(t => t.id === 'tag_e').category, 'Custom 2');
});

test('Category favorite and delete use the existing functions', async () => {
    const jd = tagsData();
    const p = tagsPage(jd);
    await p.fns.toggleCategoryFavorite('Risk');
    assert.equal(jd._categoryMeta.Risk.isFavorite, true);
    assert.doesNotMatch(p.list(), /<div class="tgm-cat is-unfav">(?:(?!tgm-cat-name).)*tgm-cat-name">Risk</);

    p.fns.tgmToggleCategory(p.catIndex('Risk'));
    await p.fns.deleteCategory('Risk');
    assert.deepEqual(jd.tagCategories, ['Setups', 'Mistakes', 'Uncategorized']);
    assert.equal(jd.tags.find(t => t.id === 'tag_c').category, 'Uncategorized');
    assert.deepEqual(p.openCats(), ['Uncategorized']);

    // Default categories cannot be deleted: Delete toggles favorite instead.
    await p.fns.deleteCategory('Setups');
    assert.ok(jd.tagCategories.includes('Setups'));
    assert.equal(jd._categoryMeta.Setups.isFavorite, false);
});

// ── Step C polish ───────────────────────────────────────────────────────────

test('Polish: Settings subtitle, leftover tag table rules removed, Tag Usage figures share one face', () => {
    const CSS = fs.readFileSync(path.join(ROOT, 'css', 'denarii-ds.css'), 'utf8').replace(/\r\n/g, '\n');
    assert.match(APP, /settings: \{\s*title: 'Settings',\s*subtitle: 'Manage your profile, security, and integrations\.'/);
    for (const gone of ['.tags-filter-bar', '#tags-table', '.settings-table-wrap']) assert.ok(!CSS.includes(gone), gone);
    assert.ok(CSS.includes('#strategies-list table { font-variant-numeric: tabular-nums; }'));
    const fig = CSS.match(/\.su-tag-usage td:is\(:nth-child\(3\), :nth-child\(4\), :nth-child\(5\)\) \{([^}]*)\}/);
    assert.ok(fig, 'Used / Net P&L / Win Rate rule');
    assert.match(fig[1], /font-family: var\(--ds-font-figure\);/);
    assert.match(fig[1], /font-size: inherit;/);
    assert.match(fig[1], /font-variant-numeric: tabular-nums;/);
    assert.ok(CSS.includes('.su-tag-usage td.su-tu-pnl.su-lb-pos { color: var(--success); }'));
    assert.ok(CSS.includes('.su-tag-usage td.su-tu-pnl.su-lb-neg { color: var(--danger); }'));
    assert.match(CSS, /@media \(max-width: 600px\) \{\s*\.tgm-newcat-field/);
});

// ── Duplicate heading, collapsed-sidebar flyout ─────────────────────────────

test('Tags card: no duplicate "Tags Management" heading; description shares the "+ New category" row', () => {
    const panel = HTML.slice(HTML.indexOf('<div class="settings-panel" id="settings-tags">'), HTML.indexOf('<!-- INTEGRATIONS -->'));
    assert.ok(!panel.includes('<h3'), 'no heading inside the Tags card');
    assert.match(panel, /<div class="settings-panel-head">\s*<p class="settings-desc">Open a category[^<]*<\/p>\s*<button class="btn btn-primary btn-small" onclick="showNewCategoryForm\(\)">\+ New category<\/button>\s*<\/div>/);
});

test('Collapsed-sidebar flyout: Tags Management runs the sidebar link handler and opens the Tags panel', () => {
    const NAV = fs.readFileSync(path.join(ROOT, 'js', 'nav.js'), 'utf8').replace(/\r\n/g, '\n');
    // The real inline handler from the sidebar markup.
    const tagsAttr = HTML.match(/data-tab="settings" data-parent-group="strategy" title="Tags Management" onclick="([^"]+)"/)[1];
    const timers = [];
    const calls = [];
    const switchSettingsTab = id => calls.push(['switchSettingsTab', id]);
    const mkItem = (tab, label, onclick) => ({
        dataset: { tab, parentGroup: 'strategy' }, onclick: onclick || null,
        classList: { contains: () => false },
        querySelector: () => null,
        querySelectorAll: () => [{ textContent: '' }, { textContent: label }],
    });
    const children = [
        mkItem('strategies', 'Strategy Management'),
        mkItem('settings', 'Tags Management', new Function('switchSettingsTab', 'setTimeout', tagsAttr).bind(null, switchSettingsTab, fn => timers.push(fn))),
    ];
    let buttons = [];
    const flyout = {
        style: {}, classList: { add() {}, remove() {}, contains: () => true }, contains: () => false,
        set innerHTML(v) {
            buttons = [...v.matchAll(/data-flyout-tab="([^"]*)"/g)].map(m => ({
                dataset: { flyoutTab: m[1] }, listeners: [],
                addEventListener(type, fn) { this.listeners.push(fn); },
                click() { this.listeners.forEach(fn => fn()); },
            }));
        },
        querySelectorAll: () => buttons,
    };
    const { fns } = sandbox([[NAV, ['showSidebarFlyout']]], {
        flyout, _flyoutCloseListener: null,
        document: {
            querySelectorAll: sel => (sel === '.nav-item[data-parent-group="strategy"]' ? children : []),
            querySelector: () => null, addEventListener() {}, removeEventListener() {},
        },
        window: { innerHeight: 800 },
        setTimeout: () => {},
        activateSection: id => calls.push(['activateSection', id]),
        closeSidebarFlyout: () => calls.push(['close']),
        refreshGroupActiveStates() {},
    });
    fns.showSidebarFlyout({ getBoundingClientRect: () => ({ top: 100, right: 60 }) }, 'strategy');
    assert.deepEqual(buttons.map(b => b.dataset.flyoutTab), ['strategies', 'settings']);

    buttons[1].click();
    timers.forEach(fn => fn());
    assert.deepEqual(calls, [['activateSection', 'settings'], ['close'], ['switchSettingsTab', 'settings-tags']]);

    // Items without an inline handler only activate their section, as before.
    calls.length = 0;
    buttons[0].click();
    assert.deepEqual(calls, [['activateSection', 'strategies'], ['close']]);
    assert.match(NAV, /activateSection\(tab\);\s*(?:\/\/[^\n]*\n\s*)+if \(typeof children\[i\]\.onclick === 'function'\) children\[i\]\.onclick\(\);/);
});
