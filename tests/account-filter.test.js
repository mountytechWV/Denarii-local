// Account selector: every analytics page, Trade Reflection and Run Analysis
// use the header account the way the Dashboard does, hidden accounts included.
//
// Real functions are cut out of the browser scripts and run together.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const BROKER = read('js/pages/broker-accounts.js');

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

function extractConst(src, name) {
    const start = src.indexOf('const ' + name + ' =');
    if (start < 0) throw new Error(name + ' not found');
    return src.slice(start, src.indexOf('};', start) + 2);
}

const ACCOUNTS = [
    { id: 'a1', tradingStyle: 'scalping' },
    { id: 'a2', tradingStyle: 'day_trading' },
    { id: 'hid', tradingStyle: 'scalping', visible: false },
];
const trade = (id, brokerAccountId, extra) => Object.assign(
    { id, brokerAccountId, symbol: 'AAPL', type: 'long', entryTime: '2026-03-10T14:00:00Z', exitTime: '2026-03-10T15:00:00Z', pnl: 1 }, extra);
const TRADES = [
    trade('t1', 'a1'),
    trade('t2', 'a1', { symbol: 'MSFT', exitTime: '2025-03-10T15:00:00Z' }),
    trade('t3', 'a2'),
    trade('t4', 'hid'),
];
const ids = list => list.map(t => t.id).join(' ');

function sharedFilters() {
    const w = {};
    new Function('window', 'document', read('js/shared/filter-bar.js'))(w, { getElementById: () => null });
    return w.DenariiFilters;
}

// The real account functions and applyGlobalFilters, in one scope.
function brokerScope(account, activeTab, accounts) {
    const calls = [];
    const window = { filterBrokerAccountId: account };
    const journalData = { brokerAccounts: accounts || ACCOUNTS, trades: TRADES };
    const document = {
        getElementById: id => (id === 'filter-broker-account' ? { value: window.nextAccount || account } : null),
        querySelector: sel => (sel === '.tab-content.active' && activeTab ? { id: activeTab } : null),
    };
    const code = [extractConst(BROKER, 'ACCOUNT_RERENDER')]
        .concat(['applyGlobalFilters', 'getSelectedAccountTrades', 'getGlobalFilteredTrades'].map(n => extractFunction(BROKER, n)))
        .join('\n');
    const api = new Function('window', 'journalData', 'document', 'ensureBrokerAccounts', 'updateDashboard',
        code + '\nreturn { applyGlobalFilters, getSelectedAccountTrades, getGlobalFilteredTrades, ACCOUNT_RERENDER };'
    )(window, journalData, document, () => {}, () => calls.push('dashboard'));
    return Object.assign(api, { window, journalData, calls });
}

const PAGES = [
    { page: 'snapshot', fn: 'getSnapTrades', tab: 'snapshot', render: 'renderSnapshot' },
    { page: 'perf-trends', fn: 'getTrendTrades', tab: 'perf-trends', render: 'renderTrends' },
    { page: 'setups', fn: 'getSetupTrades', tab: 'setups', render: 'renderSetups' },
    { page: 'timing', fn: 'getTimingTrades', tab: 'timing', render: 'renderTiming' },
    { page: 'symbols', fn: 'getSymTrades', tab: 'symbols', render: 'renderSymbols' },
    { page: 'risk', fn: 'getRiskTrades', tab: 'risk', render: 'renderRisk' },
    { page: 'discipline', fn: 'getDiscTrades', tab: 'discipline', render: 'renderDisc' },
];

function pageTrades(p, account, state) {
    const b = brokerScope(account);
    const get = new Function('DenariiFilters', 'journalData', 'getSelectedAccountTrades', '_state',
        extractFunction(read('js/pages/' + p.page + '.js'), p.fn) + '\nreturn ' + p.fn + ';'
    )(sharedFilters(), b.journalData, b.getSelectedAccountTrades, Object.assign({ period: 'all' }, state));
    return get();
}

for (const p of PAGES) {
    test(p.page + ': a chosen account limits the page to its trades', () => {
        assert.equal(ids(pageTrades(p, 'a1')), 't1 t2');
        assert.equal(ids(pageTrades(p, 'a2')), 't3');
    });

    test(p.page + ': All Accounts matches the Dashboard and leaves out hidden accounts', () => {
        const dash = brokerScope('all').getGlobalFilteredTrades(TRADES);
        assert.equal(ids(pageTrades(p, 'all')), ids(dash));
        assert.equal(ids(pageTrades(p, 'all')), 't1 t2 t3');
    });

    test(p.page + ': the account combines with the bar', () => {
        assert.equal(ids(pageTrades(p, 'a1', { symbol: 'msft' })), 't2');
        assert.equal(ids(pageTrades(p, 'a1', { style: 'day_trading' })), '');
        assert.equal(ids(pageTrades(p, 'a1', { period: 'custom', from: '2026-01-01', to: '2026-12-31' })), 't1');
    });

    test(p.page + ': changing the account redraws the open page once', () => {
        const b = brokerScope('all', p.tab);
        b.window[p.render] = () => b.calls.push('render');
        b.window.nextAccount = 'a1';
        b.applyGlobalFilters();
        assert.equal(b.window.filterBrokerAccountId, 'a1');
        assert.deepEqual(b.calls, ['dashboard', 'render']);
    });
}

test('the helper keeps the Dashboard rule: exact account match, hidden account still selectable', () => {
    for (const account of ['all', 'a1', 'a2', 'hid', 'gone']) {
        const b = brokerScope(account);
        assert.equal(ids(b.getSelectedAccountTrades(TRADES)), ids(b.getGlobalFilteredTrades(TRADES)), account);
    }
    assert.equal(ids(brokerScope('hid').getSelectedAccountTrades(TRADES)), 't4');
    assert.equal(ids(brokerScope('gone').getSelectedAccountTrades(TRADES)), '');
});

test('with nothing hidden, All Accounts returns every trade, deleted accounts and blanks included', () => {
    const list = [trade('x', 'a1'), trade('y', 'deleted'), trade('z', undefined)];
    assert.equal(ids(brokerScope('all', null, [{ id: 'a1' }]).getSelectedAccountTrades(list)), 'x y z');
});

test('a missing trade list is treated as empty', () => {
    assert.deepEqual(brokerScope('a1').getSelectedAccountTrades(undefined), []);
    assert.deepEqual(brokerScope('all').getSelectedAccountTrades(undefined), []);
});

test('Trade Reflection: the open list redraws on an account change', () => {
    const b = brokerScope('all', 'trade-journal');
    b.window.renderJournalTradeList = () => b.calls.push('list');
    b.applyGlobalFilters();
    assert.deepEqual(b.calls, ['dashboard', 'list']);
});

test('every render in the map is exposed by its page', () => {
    const b = brokerScope('all');
    const owner = { 'trade-journal': 'journal' };
    for (const [tab, fn] of Object.entries(b.ACCOUNT_RERENDER)) {
        const src = read('js/pages/' + (owner[tab] || tab) + '.js');
        assert.match(src, new RegExp('window\\.' + fn + '\\s*=\\s*' + fn + '\\b'), tab);
    }
    assert.equal(Object.keys(b.ACCOUNT_RERENDER).length, PAGES.length + 1);
});

test('Dashboard and other pages redraw nothing extra', () => {
    for (const tab of ['dashboard', 'calendar', 'settings', 'ai-run', null]) {
        const b = brokerScope('all', tab);
        for (const fn of Object.values(b.ACCOUNT_RERENDER)) b.window[fn] = () => b.calls.push(fn);
        b.applyGlobalFilters();
        assert.deepEqual(b.calls, ['dashboard'], String(tab));
    }
});

// ── Run Analysis ─────────────────────────────────────────────────────────────

function runAnalysis(account) {
    const els = {};
    const el = id => els[id] || (els[id] = {
        id, value: '', innerHTML: '', textContent: '', style: {}, dataset: {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, insertAdjacentHTML() {}, querySelectorAll: () => [], appendChild() {},
    });
    const b = brokerScope(account);
    const sent = [];
    const ctx = {
        document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => el('x') },
        journalData: b.journalData,
        getSelectedAccountTrades: b.getSelectedAccountTrades,
        filterBrokerAccountId: account,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: () => 0,
        setInterval: () => 0,
        clearInterval() {},
        DenAriiAI: { isConfigured: () => true, query: async r => { sent.push(r); return { success: false, error: 'x' }; } },
    };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ['js/shared/filter-bar.js', 'js/services/ai/formatter.js', 'js/ai-run.js']) vm.runInContext(read(f), ctx);
    return { ctx, el, sent };
}

test('Run Analysis: Trades Selected follows the account, with the real formatter', () => {
    const count = account => {
        const { ctx, el } = runAnalysis(account);
        ctx.AIRun.init();
        return el('ai-run-trade-count-val').textContent;
    };
    assert.equal(count('a1'), '2 of 3');
    assert.equal(count('a2'), '1 of 3');
    assert.equal(count('all'), '3 of 3', 'both numbers leave out the hidden account');
});

test('Run Analysis: the trades sent follow the account and leave out hidden accounts', async () => {
    const sentFor = async account => {
        const { ctx, el, sent } = runAnalysis(account);
        el('ai-run-prompt-text').value = 'Go';
        await ctx.AIRun.execute();
        return ids(sent[0].tradeData);
    };
    assert.equal(await sentFor('a1'), 't1 t2');
    assert.equal(await sentFor('all'), 't1 t2 t3');
});

// ── Cache busting ────────────────────────────────────────────────────────────

test('index.html serves the changed scripts at new versions', () => {
    const HTML = read('index.html');
    const ver = file => Number((HTML.split('src="' + file + '?v=')[1] || '0"').split('"')[0]);
    const min = {
        'js/ai-run.js': 6, 'js/pages/broker-accounts.js': 14, 'js/pages/snapshot.js': 6, 'js/pages/perf-trends.js': 8,
        'js/pages/setups.js': 6, 'js/pages/timing.js': 5, 'js/pages/symbols.js': 5, 'js/pages/risk.js': 6, 'js/pages/discipline.js': 6,
    };
    for (const [file, v] of Object.entries(min)) assert.ok(ver(file) >= v, file);
});
