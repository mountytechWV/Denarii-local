// Combined cleanup batch: labels, contrast, escaping, strategy names, narrow sidebar.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');
const APP = read('Denarii.js');
const CSS = read('Denarii.css');
const SNAP = read('js/pages/snapshot.js');
const NAV = read('js/nav.js');
const BROKER = read('js/pages/broker-accounts.js');

const lum = hex => {
    const c = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255)
        .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
};
const contrast = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
};

test('Setup labels read Strategy; the saved column key and widget id stay', () => {
    assert.ok(APP.includes("{ key: 'setupType',  label: 'Strategy',"));
    assert.ok(SNAP.includes("wid: 'top-setups',"));
    assert.ok(SNAP.includes("name: 'Top Strategies',"));
    assert.ok(!SNAP.includes("'Top Setups'"));
    assert.ok(SNAP.includes('<th>Side</th><th>Strategy</th>'));
});

test('success text is at least 4.5:1 on every theme success color', () => {
    const blocks = CSS.slice(0, CSS.indexOf('body { font-family')).split('--on-success:').slice(1);
    assert.equal(blocks.length, 7);
    const pairs = [...CSS.slice(0, CSS.indexOf('body { font-family')).matchAll(/--success:\s*(#\w{6});[\s\S]*?--on-success:\s*(#\w{6});/g)];
    assert.equal(pairs.length, 7);
    for (const [, bg, fg] of pairs) assert.ok(contrast(bg, fg) >= 4.5, bg);
    for (const bg of ['#16A34A', '#00A87E']) assert.ok(contrast(bg, '#111111') >= 4.5, bg);
    assert.ok(!/\.btn-success \{[^}]*color: (white|#fff)/.test(CSS));
});

test('star states are readable and star-0 selected differs from unselected', () => {
    assert.ok(contrast('#ef4444', '#111111') >= 4.5);
    assert.ok(contrast('#64748b', '#ffffff') >= 4.5);
    assert.match(CSS, /\.star-btn\.star-0\.selected \{ background: #64748b; color: #fff;/);
});

test('all date inputs use the theme color scheme', () => {
    assert.match(CSS, /input\[type="date"\],\s*input\[type="datetime-local"\] \{\s*color-scheme: var\(--input-color-scheme\);/);
});

test('escapeHtml and escH escape the apostrophe', () => {
    const m = /function escapeHtml\(str\) \{[\s\S]*?\n {8}\}/.exec(APP);
    const escapeHtml = new Function(m[0] + '\nreturn escapeHtml;')();
    assert.equal(escapeHtml(`<a b="c">'&`), '&lt;a b=&quot;c&quot;&gt;&#39;&amp;');
    assert.ok(read('js/pages/reviews.js').includes(`.replace(/'/g,'&#39;')`));
});

test('strategy names are trimmed, and an unchanged saved name is left alone', () => {
    assert.ok(APP.includes('const rawName = enteredName === savedName ? enteredName : enteredName.trim();'));
});

test('the sidebar brand box stays at narrow widths and the arrow is wired for each', () => {
    assert.ok(!/@media \(max-width: 900px\) \{(?:(?!@media)[\s\S])*?\.brand-card \{ display: none; \}/.test(CSS));
    assert.ok(!/\.sidebar-toggle \{ display: none !important; \}/.test(CSS));
    assert.ok(NAV.includes('window.closeMobileSidebar();\n                return;') || NAV.includes('window.closeMobileSidebar();\r\n                return;'));
    assert.ok(NAV.includes('setRailOpen(!railOpen);'));
});

test('filterTradingStyle is gone', () => {
    assert.ok(!APP.includes('filterTradingStyle'));
    assert.ok(!BROKER.includes('filterTradingStyle'));
    assert.ok(!APP.includes('let filterBrokerAccountId'));
});
