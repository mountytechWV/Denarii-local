// Strategy names with ' " & or < must survive every dropdown and list in full.
// Runs the real rendering code, then reads its HTML the way a browser would.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const APP = read('Denarii.js');
const JOURNAL = read('js/pages/journal.js');
const SNAPSHOT = read('js/pages/snapshot.js');
const HTML = read('index.html');

const win = {};
new Function('window', read('js/shared/filter-bar.js'))(win);
const F = win.DenariiFilters;

const NAMES = [
    `Bob's "Best" Setup`,
    `Bob's Setup`,
    `The "Best" Setup`,
    'Risk & Reward',
    'Price < VWAP',
    'Literal &amp; entity',
    `All ' " & < > together`
];

function braceBlock(src, start, label) {
    if (start < 0) throw new Error(label + ' not found');
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(label + ': unbalanced braces');
}
const extractFunction = (src, name) => braceBlock(src, src.indexOf('function ' + name + '('), name);
const ESCAPE_HTML = extractFunction(APP, 'escapeHtml');

function decode(s) {
    return s.replace(/&(amp|lt|gt|quot|#39);/g, (_, e) =>
        ({ amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" })[e]);
}

// An attribute ends at its first unescaped " and raw < in text starts a tag,
// so this returns cut-off values for unescaped names, as a browser would.
function parseOptions(html) {
    const out = [];
    const re = /<option value="([^"]*)"([^>]*)>([^<]*)/g;
    let m;
    while ((m = re.exec(html))) {
        out.push({ value: decode(m[1]), selected: /\bselected\b/.test(m[2]), label: decode(m[3]) });
    }
    return out;
}

function newTradeOptions(strategies) {
    const el = { innerHTML: '' };
    const run = new Function('journalData', 'document', 'DenariiFilters',
        ESCAPE_HTML + '\n' + extractFunction(APP, 'updateStrategyDropdown') + '\nupdateStrategyDropdown();');
    run({ strategies }, { getElementById: id => (id === 'setup-type' ? el : null) }, F);
    return parseOptions(el.innerHTML);
}

function reflectionOptions(strategies, setupType) {
    const start = JOURNAL.indexOf('const _favStrats =');
    const end = JOURNAL.indexOf('setupSel.innerHTML = _opts;', start);
    assert.ok(start > 0 && end > start);
    const setupSel = { innerHTML: '' };
    new Function('journalData', 'trade', 'setupSel', 'DenariiFilters',
        ESCAPE_HTML + '\n' + JOURNAL.slice(start, end) + 'setupSel.innerHTML = _opts;')(
        { strategies }, { setupType }, setupSel, F);
    return parseOptions(setupSel.innerHTML);
}

function strategiesPageHtml(strategies, trades) {
    const list = { innerHTML: '' };
    const menu = { innerHTML: '' };
    const run = new Function('journalData', 'document', 'let _stratSortCol = null, _stratSortAsc = true;\n' +
        ESCAPE_HTML + '\n' + extractFunction(APP, 'updateStrategiesList') + '\nupdateStrategiesList();');
    run({ strategies, trades }, {
        getElementById: id => (id === 'strategies-list' ? list : id === 'strat-add-fav-menu' ? menu : null)
    });
    return { list: list.innerHTML, menu: menu.innerHTML };
}

function snapshotRecentTradesHtml(trades) {
    const start = SNAPSHOT.indexOf("'recent-trades': function(");
    const fn = braceBlock(SNAPSHOT, start, 'recent-trades').slice("'recent-trades': ".length);
    return new Function('journalData', 'DenariiFilters', 'widgetHtml', 'return (' + fn + ');')(
        { brokerAccounts: [] }, F, (id, title, body) => body)('w1', trades, {}, 'md');
}

test('New Trade dropdown keeps the full, exact name in value and label', () => {
    const opts = newTradeOptions(NAMES.map((name, i) => ({ id: i + 1, name })));
    const sorted = NAMES.slice().sort(F.compareStrategyNames);
    assert.deepEqual(opts.map(o => o.value), ['', ...sorted]);
    assert.deepEqual(opts.map(o => o.label), ['Select strategy...', ...sorted]);
});

test('every strategy dropdown sorts A to Z ignoring case', () => {
    const strategies = ['zeta', 'Beta', 'alpha', 'Gamma'].map((name, i) => ({ id: i, name }));
    const original = strategies.map(s => s.name);
    const az = ['alpha', 'Beta', 'Gamma', 'zeta'];

    assert.deepEqual(newTradeOptions(strategies).map(o => o.value), ['', ...az]);
    assert.deepEqual(reflectionOptions(strategies, '').map(o => o.value), ['', ...az]);

    const sel = { value: 'all', innerHTML: '' };
    F.populateStrategy(sel, [{ setupType: 'delta' }], strategies);
    assert.deepEqual(parseOptions(sel.innerHTML).map(o => o.value),
        ['all', F.NO_STRATEGY, 'alpha', 'Beta', 'delta', 'Gamma', 'zeta']);

    assert.deepEqual(strategies.map(s => s.name), original, 'saved strategy order is untouched');
});

test('sorting does not change which strategies each dropdown offers', () => {
    const strategies = [{ id: 1, name: 'Zed' }, { id: 2, name: 'Off', isFavorite: false }, { id: 3, name: 'able' }];
    assert.deepEqual(newTradeOptions(strategies).map(o => o.value), ['', 'able', 'Zed']);
    assert.deepEqual(reflectionOptions(strategies, 'Zed').map(o => o.value), ['', 'able', 'Zed']);

    const hidden = reflectionOptions(strategies, 'Off');
    assert.deepEqual(hidden.map(o => o.label), ['Select strategy...', 'able', 'Off (hidden)', 'Zed']);
    assert.deepEqual(hidden.filter(o => o.selected).map(o => o.value), ['Off']);
});

test('Bob\'s "Best" Setup is saved whole, not as the text before the first quote', () => {
    const name = `Bob's "Best" Setup`;
    const picked = newTradeOptions([{ id: 1, name }]).find(o => o.label === name);
    assert.equal(picked.value, name);
    assert.notEqual(picked.value, "Bob's ");
});

test('New Trade dropdown still leaves out hidden strategies', () => {
    const opts = newTradeOptions([{ id: 1, name: 'Shown' }, { id: 2, name: `Hid"den`, isFavorite: false }]);
    assert.deepEqual(opts.map(o => o.value), ['', 'Shown']);
});

test('names without special characters render exactly as before', () => {
    const el = { innerHTML: '' };
    new Function('journalData', 'document', 'DenariiFilters',
        ESCAPE_HTML + '\n' + extractFunction(APP, 'updateStrategyDropdown') + '\nupdateStrategyDropdown();')(
        { strategies: [{ id: 1, name: 'Opening Range Breakout' }, { id: 2, name: 'VWAP-Bounce (5m)' }] },
        { getElementById: () => el }, F);
    assert.equal(el.innerHTML,
        '<option value="">Select strategy...</option>' +
        '<option value="Opening Range Breakout">Opening Range Breakout</option>' +
        '<option value="VWAP-Bounce (5m)">VWAP-Bounce (5m)</option>');
});

test('trade edit (Reflection) selects the saved name, shown or hidden', () => {
    NAMES.forEach(name => {
        const shown = reflectionOptions([{ id: 1, name }], name).filter(o => o.selected);
        assert.deepEqual(shown.map(o => [o.value, o.label]), [[name, name]]);

        const hidden = reflectionOptions([], name).filter(o => o.selected);
        assert.deepEqual(hidden.map(o => [o.value, o.label]), [[name, name + ' (hidden)']]);
    });
});

test('filter bar options keep the full name and filter by exact match', () => {
    const sel = { value: 'all', innerHTML: '' };
    const trades = NAMES.map((setupType, i) => ({ id: i, setupType, exitTime: '2026-03-01T15:00:00Z' }));
    F.populateStrategy(sel, trades, NAMES.map((name, i) => ({ id: i, name })));
    const opts = parseOptions(sel.innerHTML).filter(o => o.value !== 'all' && o.value !== F.NO_STRATEGY);
    assert.deepEqual(opts.map(o => o.value).sort(), NAMES.slice().sort());
    assert.deepEqual(opts.map(o => o.label).sort(), NAMES.slice().sort());

    opts.forEach(o => {
        const hits = F.filterTrades(trades, { strategy: o.value });
        assert.deepEqual(hits.map(t => t.setupType), [o.value]);
    });
});

test('a trade holding a cut-off name stays apart from the full name', () => {
    const trades = [
        { id: 1, setupType: "Bob's ", exitTime: '2026-03-01T15:00:00Z' },
        { id: 2, setupType: `Bob's "Best" Setup`, exitTime: '2026-03-01T15:00:00Z' }
    ];
    assert.deepEqual(F.filterTrades(trades, { strategy: "Bob's " }).map(t => t.id), [1]);
    assert.deepEqual(F.filterTrades(trades, { strategy: `Bob's "Best" Setup` }).map(t => t.id), [2]);
});

test('Strategies page shows the full name and counts its trades', () => {
    NAMES.forEach(name => {
        const { list } = strategiesPageHtml([{ id: 7, name, color: '#000' }],
            [{ setupType: name, pnl: 5 }, { setupType: name, pnl: -2 }]);
        const m = /<strong>([^<]*)<\/strong>/.exec(list);
        assert.equal(decode(m[1]), name);
        assert.match(list, /<td>2<\/td>/);
    });
});

test('Strategies page buttons pass only the id, never the name', () => {
    const { list, menu } = strategiesPageHtml([
        { id: 7, name: `Bob's "Best" Setup`, color: '#000' },
        { id: 8, name: `Bob's "Hidden"`, color: '#000', isFavorite: false }
    ], []);
    [...(list + menu).matchAll(/onclick="([^"]*)"/g)].forEach(m => {
        assert.doesNotMatch(m[1], /Bob/);
    });
    const hiddenLabel = /<span style="flex:1;">([^<]*)<\/span>/.exec(menu);
    assert.equal(decode(hiddenLabel[1]), `Bob's "Hidden"`);
});

test('Snapshot Recent Trades escapes the setup name', () => {
    NAMES.forEach(name => {
        const html = snapshotRecentTradesHtml([{ symbol: 'AAPL', type: 'long', setupType: name, pnl: 1 }]);
        const cells = [...html.matchAll(/<td(?: [^>]*)?>([^<]*)<\/td>/g)].map(m => decode(m[1]));
        assert.ok(cells.includes(name), name);
    });
});

test('script versions were bumped for the changed files', () => {
    assert.ok(+/Denarii\.js\?v=(\d+)"/.exec(HTML)[1] >= 59);
    assert.ok(+/js\/pages\/snapshot\.js\?v=(\d+)"/.exec(HTML)[1] >= 9);
});
