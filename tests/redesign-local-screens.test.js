// Redesign 2: the cloud markup classes on the local index.html, and the
// local-only screens restyled with them. Structure itself (</main> balanced,
// no modal inside #app-container) is covered by index-structure.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

const HTML = read('index.html');
const CSS = read('css/denarii-ds.css');
const SETTINGS = read('js/pages/settings.js');
const BROKER = read('js/pages/broker-accounts.js');
const BANNER = read('js/update-banner.js');
const PROMPT = read('js/shared/prompt-modal.js');

// The opening tag of the element with this id.
function tagOf(id) {
    const m = new RegExp('<[a-z0-9]+\\b[^>]*\\bid="' + id + '"[^>]*>').exec(HTML);
    assert.ok(m, id + ' exists');
    return m[0];
}
const classesOf = tag => ((/\bclass="([^"]*)"/.exec(tag) || [])[1] || '').split(/\s+/).filter(Boolean);
const styleOf = tag => (/\bstyle="([^"]*)"/.exec(tag) || [])[1] || '';
const cssHas = cls => new RegExp('\\.' + cls.replace(/-/g, '\\-') + '(?![\\w-])').test(CSS);

test('index.html: </main> is balanced', () => {
    assert.equal((HTML.match(/<main\b/g) || []).length, 1);
    assert.equal((HTML.match(/<\/main>/g) || []).length, 1);
});

// Local-only ids that JS looks up, with the class each one now uses.
// Inline styles left on them are only display:none (JS toggles display), plus
// the sign-up group's margin, which matches the legal checkbox group above it
// (auto-signin-page.test.js pins its class="form-group").
const STYLE_KEPT = { 'reg-autosignin-group': 'margin-bottom:16px;' };
const LOCAL_IDS = {
    'settings-data': ['settings-panel'],
    'settings-data-msg': [],
    'settings-data-backup-btn': ['btn'],
    'settings-data-restore-btn': ['btn'],
    'settings-data-info': ['settings-data-info'],
    'reg-autosignin-group': ['form-group'],
    'reg-autosignin': [],
    'reg-autosignin-replace': ['field-hint'],
    'autosignin-section': ['settings-section'],
    'settings-autosignin': [],
    'settings-autosignin-note': ['field-hint'],
    'settings-autosignin-msg': ['settings-msg'],
    'settings-integrations': ['settings-panel'],
    'settings-integrations-model': [],
    'help-legal': ['help-section'],
    'help-legal-content': ['help-legal-content'],
    'help-tradingview-credit': ['help-credit'],
    'chart-tradingview-credit': ['chart-credit'],
    'settings-version-label': ['settings-version'],
};

test('index.html: local-only ids exist with the new classes and no layout inline styles', () => {
    for (const [id, classes] of Object.entries(LOCAL_IDS)) {
        const tag = tagOf(id);
        for (const c of classes) assert.ok(classesOf(tag).includes(c), id + ' has .' + c);
        const style = styleOf(tag).replace(/display:\s*none;?/, '').replace(STYLE_KEPT[id] || /^$/, '').trim();
        assert.equal(style, '', id + ' keeps no inline style beyond display:none');
    }
});

test('index.html: the Stay signed in toggles use .settings-toggle', () => {
    assert.match(HTML, /<label class="settings-toggle settings-toggle--muted">\s*<input type="checkbox" id="reg-autosignin" checked>/);
    assert.match(HTML, /<label class="settings-toggle">\s*<input type="checkbox" id="settings-autosignin" onchange="toggleAutoSignIn\(this\)">/);
});

test('index.html: #settings-version-label moved its inline style to .settings-version', () => {
    assert.match(HTML, /<div id="settings-version-label" class="settings-version"><\/div>/);
    assert.match(CSS, /\.settings-version \{[^}]*white-space: pre-line;/);
});

test('index.html: TradingView credits are kept in Help > Legal and the chart modal', () => {
    assert.match(tagOf('help-tradingview-credit') + HTML.split('id="help-tradingview-credit"')[1].slice(0, 400), /TradingView Lightweight Charts™[\s\S]*Apache License 2\.0/);
    assert.match(HTML, /<div id="chart-tradingview-credit" class="chart-credit">Charts by <a class="plan-ctx-open-link" href="https:\/\/www\.tradingview\.com\/"/);
    const legal = HTML.indexOf('id="help-legal"');
    assert.ok(legal > 0 && HTML.indexOf('id="help-tradingview-credit"') > legal, 'credit sits in Help > Legal');
});

test('JS-built local screens use classes, not inline layout styles', () => {
    // Integrations > Webull connect
    assert.ok(SETTINGS.includes("el.id = 'settings-webull';"));
    assert.ok(SETTINGS.includes("el.className = 'settings-webull';"));
    assert.ok(!/el\.style\.cssText/.test(SETTINGS));
    // Broker account modal > Webull link and Needs review
    assert.ok(BROKER.includes("el.id = 'ba-webull-section';"));
    assert.ok(BROKER.includes("el.className = 'wb-link-section';"));
    assert.ok(BROKER.includes(`'<div id="ba-wb-review" class="wb-review">'`));
    assert.ok(BROKER.includes(`'<div class="wb-review-title">Needs review ('`));
    assert.ok(!BROKER.includes('WB_WARN_STYLE'));
    // Update banner
    assert.ok(BANNER.includes("bar.id = 'update-ready-banner';"));
    assert.ok(BANNER.includes("bar.className = 'update-banner';"));
    assert.ok(!/style\.cssText|\.style\.flex/.test(BANNER));
    // In-app prompt modal
    assert.ok(PROMPT.includes("modal.id = 'prompt-modal';"));
    assert.ok(PROMPT.includes('<p id="prompt-modal-message" class="prompt-modal-message"></p>'));
    assert.ok(!/modal\.style\.zIndex/.test(PROMPT));
    assert.match(CSS, /#prompt-modal \{ z-index: 4000; \}/);
});

test('every class the local-only screens use has a rule in denarii-ds.css', () => {
    const used = new Set();
    const add = s => s.split(/\s+/).filter(Boolean).forEach(c => used.add(c));
    for (const m of HTML.matchAll(/\bclass="([^"]*)"/g)) add(m[1]);
    for (const src of [SETTINGS, BROKER, BANNER, PROMPT]) {
        for (const m of src.matchAll(/class="([a-z][\w -]*)"/g)) add(m[1]);
        for (const m of src.matchAll(/className = '([a-z][\w -]*)'/g)) add(m[1]);
    }
    const checked = ['settings-section', 'settings-toggle', 'settings-toggle--muted', 'settings-data-info', 'settings-msg',
        'settings-note', 'settings-status-badge', 'settings-webull', 'wb-link-section', 'wb-link-title', 'wb-alert', 'wb-status',
        'wb-warn', 'wb-error', 'wb-review', 'wb-review-title', 'wb-review-item', 'wb-review-held', 'wb-review-actions',
        'update-banner', 'update-banner-text', 'prompt-modal-message', 'help-legal-content', 'help-credit', 'chart-credit',
        'settings-version'];
    for (const c of checked) {
        assert.ok(used.has(c), '.' + c + ' is used');
        assert.ok(cssHas(c), '.' + c + ' has a rule');
    }
});

test('cloud-only wording and Quick Notes markup did not come over', () => {
    assert.ok(!HTML.includes('default Gemini key'));
    assert.ok(!HTML.includes('works on any device'));
    assert.ok(!/id="(jnl-)?quick-notes"/.test(HTML));
    assert.match(HTML, /AI features need your own Gemini API key\. There is no built-in key\./);
});
