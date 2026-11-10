// Saved report Symbol, theme before first paint, deleted accounts in cloud mode,
// and Trade Reflection on an account switch.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const HTML = read('index.html');

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

// ── Symbol ───────────────────────────────────────────────────────────────────

function pills(filters) {
    const fn = new Function('_esc', 'DenariiFilters',
        extractFunction(read('js/ai-reports.js'), '_filterPills') + '\nreturn _filterPills;'
    )(s => s, { strategyLabel: s => s });
    return fn(filters);
}

test('saved report card shows the Symbol pill only when the report has one', () => {
    assert.match(pills({ symbol: 'aapl' }), />AAPL</);
    assert.equal(pills({ symbol: null }), '');
    assert.equal(pills({}), '');
});

function payload(request) {
    const window = {};
    new Function('window', read('js/services/ai/formatter.js'))(window);
    return window._DenAriiAIFormatter.buildPayload(Object.assign({ tradeData: [] }, request));
}

test('Active Filters carries the Symbol when set, and is unchanged without one', () => {
    assert.equal(payload({ symbol: 'AAPL' }).filters.symbol, 'AAPL');
    assert.deepEqual(payload({ styleFilter: 'scalping' }).filters, { style: 'scalping' });
});

test('Run Analysis adds the Symbol to the request', () => {
    assert.match(read('js/ai-run.js'), /if \(filtersObj\.symbol\)\s+request\.symbol\s+= filtersObj\.symbol;/);
});

// ── Theme ────────────────────────────────────────────────────────────────────

function runThemeScript(saved) {
    const inline = HTML.match(/<script>\s*\/\/ Saved theme[\s\S]*?<\/script>/)[0].replace(/<\/?script>/g, '');
    const attrs = { 'data-theme': 'denarii-forged' };
    new Function('localStorage', 'document', inline)(
        typeof saved === 'function' ? { getItem: saved } : { getItem: () => saved },
        { documentElement: { setAttribute: (k, v) => { attrs[k] = v; } } }
    );
    return attrs['data-theme'];
}

test('the saved theme is applied in the head, before the stylesheet', () => {
    assert.ok(HTML.indexOf('// Saved theme') < HTML.indexOf('Denarii.css?v='));
    assert.ok(HTML.indexOf('// Saved theme') < HTML.indexOf('</head>'));
    assert.equal(runThemeScript('soft-dark'), 'soft-dark');
    assert.equal(runThemeScript('light'), 'harbor-light');
    assert.equal(runThemeScript(null), 'denarii-forged');
    assert.equal(runThemeScript(() => { throw new Error('blocked'); }), 'denarii-forged');
});

// ── Deleted accounts ─────────────────────────────────────────────────────────

const BROKER = read('js/pages/broker-accounts.js');
const TRADES = [
    { id: 1, brokerAccountId: 'a1' },
    { id: 2, brokerAccountId: 'deleted' },
    { id: 3, brokerAccountId: 'hid' },
    { id: 4 },
];
const ids = list => list.map(t => t.id).join(' ');

function selected(mode, account, accounts) {
    const fn = new Function('window', 'journalData', 'ensureBrokerAccounts',
        extractFunction(BROKER, 'getSelectedAccountTrades') + '\nreturn getSelectedAccountTrades;'
    )({ filterBrokerAccountId: account, _denariiStorageMode: mode },
      { brokerAccounts: accounts || [{ id: 'a1' }, { id: 'hid', visible: false }] }, () => {});
    return ids(fn(TRADES));
}

test('cloud All Accounts keeps visible accounts only, as the Dashboard query does', () => {
    assert.equal(selected('cloud_primary', 'all'), '1');
});

test('cloud with no accounts stays unfiltered, as the Dashboard does', () => {
    assert.equal(selected('cloud_primary', 'all', []), '1 2 3 4');
});

test('a chosen account is unchanged in cloud mode', () => {
    assert.equal(selected('cloud_primary', 'hid'), '3');
});

test('local All Accounts is unchanged', () => {
    assert.equal(selected('local', 'all'), '1 2 4');
});

// ── Trade Reflection ─────────────────────────────────────────────────────────

function accountChange(selectedId, inAccount) {
    const src = read('js/pages/journal.js');
    const start = src.indexOf('window._jnlOnAccountChange = function');
    const body = src.slice(start, src.indexOf('};', start) + 2);
    const calls = [];
    const window = { _jnlSelectedTradeId: selectedId };
    const page = new Function('window', 'journalData', 'getGlobalFilteredTrades', 'jnlBackToTrades',
        'var _jnlListPage = 5;\n' + body + '\nwindow._jnlOnAccountChange();\nreturn _jnlListPage;'
    )(window, { trades: [{ id: 1 }, { id: 2 }] }, list => list.filter(t => inAccount.includes(t.id)), () => calls.push('close'));
    return { page, calls };
}

test('an account switch resets the list to page 1', () => {
    assert.equal(accountChange(null, []).page, 1);
});

test('an open trade outside the new account closes through the Back to Trades path', () => {
    assert.deepEqual(accountChange(2, [1]).calls, ['close']);
});

test('an open trade inside the new account stays open', () => {
    assert.deepEqual(accountChange(1, [1]).calls, []);
    assert.deepEqual(accountChange(null, [1]).calls, []);
});

test('the account change runs the Trade Reflection hook', () => {
    assert.match(extractFunction(BROKER, 'applyGlobalFilters'), /window\._jnlOnAccountChange\(\)/);
});

// ── Cache busting ────────────────────────────────────────────────────────────

test('index.html serves the changed scripts at new versions', () => {
    const ver = file => Number((HTML.split('src="' + file + '?v=')[1] || '0"').split('"')[0]);
    const min = {
        'js/ai-reports.js': 10, 'js/ai-run.js': 12, 'js/services/ai/formatter.js': 4,
        'js/pages/journal.js': 21, 'js/pages/broker-accounts.js': 17,
    };
    for (const [file, v] of Object.entries(min)) assert.ok(ver(file) >= v, file);
});
