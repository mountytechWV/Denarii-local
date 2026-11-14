// Redesign Stage 8c: ticker badges on single-symbol views.
// - window.DenariiTickerBadge(symbol, size) returns a soft colored circle
//   with the ticker's first letters, or '' when there are none.
// - The color slot is a hash of the ticker: same ticker, same color.
// - Placed only on the Trade Reflection entry header and the Symbols
//   Best / Worst cards; tables and lists stay badge-free.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
// LF line endings, so a Windows (CRLF) checkout matches.
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8').replace(/\r\n/g, '\n');
const HELPER = read('js/shared/ticker-badge.js');
const CSS = read('css/denarii-ds.css');
const HTML = read('index.html');
const JNL = read('js/pages/journal.js');
const SYM = read('js/pages/symbols.js');
const SNAP = read('js/pages/snapshot.js');

const ctx = { window: {} };
vm.runInNewContext(HELPER, ctx);
const badge = ctx.window.DenariiTickerBadge;

test('helper: letters from the ticker', () => {
    assert.equal(badge.letters('TSLA'), 'TS');
    assert.equal(badge.letters('F'), 'F');
    assert.equal(badge.letters('BRK.B'), 'BR');
    assert.equal(badge.letters('spy'), 'SP');
    assert.equal(badge.letters('BTC/USD'), 'BT');
    assert.match(badge('TSLA', 40), />TS<\/span>$/);
    assert.match(badge('F', 32), />F<\/span>$/);
    assert.match(badge('BRK.B', 32), />BR<\/span>$/);
    assert.match(badge('spy', 32), />SP<\/span>$/);
});

test('helper: empty or missing symbol renders nothing', () => {
    for (const s of ['', '   ', null, undefined, '123', '.']) assert.equal(badge(s, 32), '');
});

test('helper: same ticker, same color slot', () => {
    for (const s of ['TSLA', 'F', 'BRK.B', 'SPY', 'AAPL', 'NVDA']) {
        const slot = badge.slot(s);
        assert.ok(Number.isInteger(slot) && slot >= 0 && slot < 8);
        assert.equal(badge.slot(s), slot);
        assert.equal(badge(s, 32), badge(s, 32));
    }
    assert.equal(badge.slot('spy'), badge.slot('SPY'));
    assert.equal(badge.slot(' SPY '), badge.slot('SPY'));
    const slots = new Set(['TSLA', 'AAPL', 'NVDA', 'SPY', 'QQQ', 'AMD', 'MSFT', 'F', 'META', 'GOOG'].map(badge.slot));
    assert.ok(slots.size >= 4, 'tickers spread across the palette');
});

test('helper: markup is aria-hidden, sized, and never prints undefined / NaN', () => {
    const cases = [['TSLA', 40], ['F', 32], ['BRK.B'], ['spy', 'x'], ['AAPL', NaN], ['NVDA', Infinity], ['QQQ', -5], ['AMD', 1000]];
    for (const [s, size] of cases) {
        const html = badge(s, size);
        assert.ok(html.includes('aria-hidden="true"'));
        assert.match(html, /class="ds-ticker-badge ds-ticker-badge--[0-7]"/);
        assert.match(html, /--tb-size:\d+px/);
        assert.ok(!/undefined|NaN|Infinity/.test(html), html);
    }
    assert.match(badge('TSLA', 40), /--tb-size:40px/);
    assert.match(badge('TSLA'), /--tb-size:32px/);
});

test('CSS: 8 slots for dark and light themes, contrast at least 4.5:1, no pure green / red', () => {
    const lum = h => {
        const c = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255)
            .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const ratio = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
    const hue = h => {
        const [r, g, b] = [1, 3, 5].map(i => parseInt(h.substr(i, 2), 16) / 255);
        const max = Math.max(r, g, b), d = max - Math.min(r, g, b);
        if (!d) return null;
        const x = max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
        return (x * 60 + 360) % 360;
    };
    const block = start => CSS.slice(CSS.indexOf(start), CSS.indexOf('}', CSS.indexOf(start)));
    const dark = block(':root {\n    --ticker-0-bg');
    const light = block(':root:is([data-theme="harbor-light"], [data-theme="sage-journal"], [data-theme="dawn-ember"], [data-theme="blush-power"]) {\n    --ticker-0-bg');
    for (const b of [dark, light]) {
        for (let i = 0; i < 8; i++) {
            const bg = b.match(new RegExp('--ticker-' + i + '-bg: (#[0-9A-Fa-f]{6})'))[1];
            const fg = b.match(new RegExp('--ticker-' + i + '-fg: (#[0-9A-Fa-f]{6})'))[1];
            assert.ok(ratio(bg, fg) >= 4.5, 'slot ' + i + ' ' + bg + '/' + fg);
            const h = hue(fg);
            assert.ok(h === null || !(h < 8 || h > 352 || (h > 100 && h < 150)), 'slot ' + i + ' hue ' + h);
        }
    }
    for (let i = 0; i < 8; i++) assert.ok(CSS.includes('.ds-ticker-badge--' + i + ' { --tb-bg: var(--ticker-' + i + '-bg); --tb-fg: var(--ticker-' + i + '-fg); }'));
    const rule = CSS.slice(CSS.indexOf('.ds-ticker-badge {'), CSS.indexOf('}', CSS.indexOf('.ds-ticker-badge {')));
    assert.match(rule, /font-family: var\(--ds-font-body\)/);
    assert.match(rule, /font-weight: var\(--ds-weight-semibold\)/);
    assert.match(rule, /font-size: calc\(var\(--tb-size\) \* 0\.36\)/);
    assert.match(rule, /border-radius: 50%/);
});

test('CSS: inset outline ring in the slot letter color, size unchanged', () => {
    const rule = CSS.slice(CSS.indexOf('.ds-ticker-badge {'), CSS.indexOf('}', CSS.indexOf('.ds-ticker-badge {')));
    assert.match(rule, /--tb-ring: max\(1px, calc\(var\(--tb-size\) \/ 16 - 0\.5px\)\);/);
    assert.match(rule, /box-shadow: inset 0 0 0 var\(--tb-ring\) var\(--tb-fg\);/);
    assert.ok(!/border\s*:/.test(rule.replace('border-radius', '')), 'no border, so the badge size is unchanged');
    // Width follows size: 1px floor, 1.5px at 32, 2px at 40.
    const ring = px => Math.max(1, px / 16 - 0.5);
    assert.equal(ring(16), 1);
    assert.equal(ring(24), 1);
    assert.equal(ring(32), 1.5);
    assert.equal(ring(40), 2);
    // --tb-fg is the slot text color in every theme mode.
    for (let i = 0; i < 8; i++) assert.ok(CSS.includes('.ds-ticker-badge--' + i + ' { --tb-bg: var(--ticker-' + i + '-bg); --tb-fg: var(--ticker-' + i + '-fg); }'));
});

test('Trade Reflection entry: 40px badge beside the title, title text untouched', () => {
    assert.match(HTML, /<div class="jnl-editor-ident">\s*<span class="jnl-editor-badge" id="jnl-editor-badge"><\/span>\s*<div>\s*<h3 class="card-title" id="journal-editor-title">Trade Reflection<\/h3>/);
    assert.ok(JNL.includes("window.DenariiTickerBadge(trade && trade.symbol, 40)"));
    assert.equal((JNL.match(/_jnlRenderEditorBadge\(trade\);/g) || []).length, 2);
    assert.ok(JNL.includes("titleEl.textContent = (trade.symbol || 'Trade') + ' — ' + entryDate;"));
    assert.ok(JNL.includes("document.getElementById('journal-editor-title').textContent = `${trade.symbol || 'Trade'} — ${entryDate}`;"));
});

test('Symbols: Best / Worst cards carry a 32px badge; tables do not', () => {
    assert.ok(SYM.includes('window.DenariiTickerBadge(symbol, 32)'));
    assert.ok(SYM.includes("widgetHtml(id, 'Best Symbol', tickerKpiHtml("));
    assert.ok(SYM.includes("widgetHtml(id, 'Worst Symbol', tickerKpiHtml("));
    assert.equal((SYM.match(/tickerKpiHtml\(/g) || []).length, 3);
    assert.equal((SYM.match(/DenariiTickerBadge/g) || []).length, 2);
});

test('No badges in Snapshot, tables, lists, calendar, Day / Week View or Dashboard', () => {
    assert.ok(!SNAP.includes('DenariiTickerBadge'));
    for (const f of ['Denarii.js', 'js/pages/calendar.js', 'js/pages/day-view.js', 'js/pages/week-view.js']) {
        assert.ok(!read(f).includes('DenariiTickerBadge'), f);
    }
    assert.ok(!HTML.includes('ds-ticker-badge'));
});

test('index.html: helper loaded before the pages; versions bumped (local numbering)', () => {
    const at = s => HTML.indexOf(s);
    assert.ok(at('js/shared/ticker-badge.js?v=1') > 0);
    assert.ok(at('js/shared/ticker-badge.js') < at('js/pages/symbols.js'));
    assert.ok(at('js/shared/ticker-badge.js') < at('js/pages/journal.js'));
    // At least these versions (later batches bump them again).
    const ver = file => Number((HTML.split(file + '?v=')[1] || '0"').split('"')[0]);
    assert.ok(ver('css/denarii-ds.css') >= 34);
    assert.ok(ver('js/pages/symbols.js') >= 7);
    assert.ok(ver('js/pages/journal.js') >= 28);
});
