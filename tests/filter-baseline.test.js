// Shared filter bar, Phase 0: pins what every page's filter returns today, so
// each later phase changes only what it means to. Expected values are worked
// out by hand from the fixtures below, in two timezones.
//
// Same harness as bug-batch-2.test.js: real functions are cut out of the
// browser scripts and run in a `with` scope (unknown globals are inert).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const APP = read('Denarii.js');
const AUTH = read('js/auth.js');
const JOURNAL = read('js/pages/journal.js');
const CALENDAR = read('js/pages/calendar.js');

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

// The real shared filter, reading the given fake document.
function sharedFilters(doc) {
    const w = {};
    new Function('window', 'document', read('js/shared/filter-bar.js'))(w, doc);
    return w.DenariiFilters;
}

// ── Clock and timezones ─────────────────────────────────────────────────────

// 2026-03-18T01:00Z is Tue Mar 17 21:00 in New York (UTC date is a day ahead)
// and Wed Mar 18 10:00 in Tokyo. The Sunday-Saturday week is Mar 15-21 in both.
const NOW = Date.parse('2026-03-18T01:00:00Z');

class FrozenDate extends Date {
    constructor(...args) {
        if (args.length === 0) super(NOW);
        else super(...args);
    }
}

const ZONES = [
    { tz: 'America/New_York', offsetNow: 240 },
    { tz: 'Asia/Tokyo', offsetNow: -540 },
];

function useZone(z) {
    process.env.TZ = z.tz;
    assert.equal(new Date(NOW).getTimezoneOffset(), z.offsetNow, 'TZ not applied: ' + z.tz);
}

// ── Fixtures ────────────────────────────────────────────────────────────────

//       exit (UTC)              New York       Tokyo
const PERIOD_TRADES = [
    { id: 'a', exitTime: '2026-03-18T00:30:00Z' }, // Mar 17         Mar 18
    { id: 'b', exitTime: '2026-03-17T12:00:00Z' }, // Mar 17         Mar 17
    { id: 'c', exitTime: '2026-03-15T05:00:00Z' }, // Mar 15 (Sun)   Mar 15
    { id: 'd', exitTime: '2026-03-15T03:00:00Z' }, // Mar 14 (Sat)   Mar 15
    { id: 'e', exitTime: '2026-03-21T20:00:00Z' }, // Mar 21 (Sat)   Mar 22 (Sun)
    { id: 'f', exitTime: '2026-03-01T02:00:00Z' }, // Feb 28         Mar 1
    { id: 'g', exitTime: '2026-02-20T12:00:00Z' }, // Feb 20         Feb 20
    { id: 'h', exitTime: '2026-01-01T02:00:00Z' }, // Dec 31 2025    Jan 1
    { id: 'i', exitTime: '2025-12-31T20:00:00Z' }, // Dec 31 2025    Jan 1
    { id: 'j', exitTime: '2026-06-01T12:00:00Z' }, // future         future
    { id: 'k', exitTime: null, entryTime: '2026-03-17T15:00:00Z' }, // open: Mar 17 / Mar 18
    { id: 'l' },                                   // no dates
    { id: 'm', exitTime: 'garbage' },              // invalid date
];
const ALL_IDS = PERIOD_TRADES.map(t => t.id);

const DASH_PERIOD = {
    'America/New_York': {
        today: 'a b k', week: 'a b c e k', month: 'a b c d e k', ytd: 'a b c d f g k',
        custom: 'a b c k',
    },
    'Asia/Tokyo': {
        today: 'a k', week: 'a b c d k', month: 'a b c d e f k', ytd: 'a b c d f g h i k',
        custom: 'b c d',
    },
};
const CUSTOM_FROM = '2026-03-15';
const CUSTOM_TO = '2026-03-17';

const ACCOUNTS = [
    { id: 'acc1', tradingStyle: 'scalping' },
    { id: 2, tradingStyle: 'day_trading' },
];
const FIELD_TRADES = [
    { id: 'p', exitTime: '2026-03-10T12:00:00Z', symbol: 'AAPL', brokerAccountId: 'acc1', setupType: 'Breakout', assetType: 'stock' },
    { id: 'q', exitTime: '2026-03-10T12:00:00Z', symbol: 'aapl', brokerAccountId: '2', setupType: 'Breakout ', assetType: 'option' },
    { id: 'r', exitTime: '2026-03-10T12:00:00Z', symbol: 'MSFT', brokerAccountId: 'gone', setupType: 'Dip & "Rip"', assetType: null },
    { id: 's', exitTime: '2026-03-10T12:00:00Z', symbol: 'TSLA', setupType: null },
];

const ids = list => list.map(t => t.id).join(' ');
const sorted = list => list.map(t => t.id).sort().join(' ');

function fakeDoc(values) {
    return {
        getElementById: id => (id in values ? { value: values[id] } : null),
        querySelectorAll: () => [],
        createElement: () => ({ style: {} }),
    };
}

// ── Dashboard: getDashFilteredTrades ────────────────────────────────────────

function dash(trades, period, values, accounts) {
    const doc = fakeDoc(values || {});
    const box = fromSource(APP, ['getDashFilteredTrades', '_localDateStr'], {
        DenariiFilters: sharedFilters(doc),
        Date: FrozenDate,
        _dashPeriod: period,
        document: doc,
        journalData: { brokerAccounts: accounts || [] },
    });
    return box.fns.getDashFilteredTrades(trades);
}

for (const z of ZONES) {
    test('Dashboard period rules, ' + z.tz, () => {
        useZone(z);
        assert.equal(ids(dash(PERIOD_TRADES, 'all')), ALL_IDS.join(' '));
        for (const p of ['today', 'week', 'month', 'ytd']) {
            assert.equal(ids(dash(PERIOD_TRADES, p)), DASH_PERIOD[z.tz][p], p);
        }
        assert.equal(
            ids(dash(PERIOD_TRADES, 'custom', { 'dash-from': CUSTOM_FROM, 'dash-to': CUSTOM_TO })),
            DASH_PERIOD[z.tz].custom
        );
    });

    test('Dashboard Custom with blank dates drops only undated and invalid trades, ' + z.tz, () => {
        useZone(z);
        const out = dash(PERIOD_TRADES, 'custom', { 'dash-from': '', 'dash-to': '' });
        assert.equal(ids(out), ALL_IDS.filter(i => i !== 'l' && i !== 'm').join(' '));
    });
}

test('Dashboard field filters', () => {
    useZone(ZONES[0]);
    const f = v => ids(dash(FIELD_TRADES, 'all', v, ACCOUNTS));
    assert.equal(f({}), 'p q r s');
    assert.equal(f({ 'dash-style': 'scalping' }), 'p');
    assert.equal(f({ 'dash-style': 'day_trading' }), 'q', 'account ids match as strings');
    assert.equal(f({ 'dash-style': 'leaps' }), '', 'no account has the style');
    assert.equal(f({ 'dash-asset-type': 'stock' }), 'p r s', 'missing asset type counts as stock');
    assert.equal(f({ 'dash-asset-type': 'option' }), 'q');
    assert.equal(f({ 'dash-strategy': 'Breakout' }), 'p', 'exact: padded name does not match');
    assert.equal(f({ 'dash-strategy': 'Breakout ' }), 'q');
    assert.equal(f({ 'dash-strategy': 'Dip & "Rip"' }), 'r');
    assert.equal(f({ 'dash-symbol': 'aap' }), 'p q', 'case-insensitive substring');
    assert.equal(f({ 'dash-symbol': 'AAPL ' }), '', 'symbol is not trimmed');
    assert.equal(f({ 'dash-style': 'scalping', 'dash-symbol': 'msft' }), '', 'filters combine');
});

// Flipped in Phase 3: the Setup filter is gone, so a leftover value does nothing.
test('Dashboard has no Setup filter', () => {
    useZone(ZONES[0]);
    const f = v => ids(dash(FIELD_TRADES, 'all', v, ACCOUNTS));
    assert.equal(f({ 'dash-setup': 'Breakout' }), 'p q r s');
    assert.equal(f({ 'dash-setup': 'Breakout', 'dash-strategy': 'Breakout ' }), 'q');
});

test('Dashboard Strategy options are deduped and sorted, trade-only names included', () => {
    useZone(ZONES[0]);
    const sel = { value: 'all', innerHTML: '' };
    const box = fromSource(APP, ['_populateDashStrategies'], {
        DenariiFilters: sharedFilters(fakeDoc({})),
        document: { getElementById: () => sel },
        journalData: { strategies: [{ name: 'Zed' }, { name: 'Alpha' }, { name: 'Zed' }, {}] },
    });
    box.fns._populateDashStrategies();
    assert.equal(
        sel.innerHTML,
        '<option value="all">All Strategies</option><option value="__no_strategy__">No Strategy</option><option value="Alpha">Alpha</option><option value="Zed">Zed</option>'
    );
    const withTrades = fromSource(APP, ['_populateDashStrategies'], {
        DenariiFilters: sharedFilters(fakeDoc({})),
        document: { getElementById: () => sel },
        journalData: { strategies: [{ name: 'Zed' }], trades: [{ setupType: 'Orphan' }] },
    });
    withTrades.fns._populateDashStrategies();
    assert.match(sel.innerHTML, /<option value="Orphan">Orphan<\/option>/);
});

// ── Analytics pages ─────────────────────────────────────────────────────────

const ANALYTICS = [
    { page: 'snapshot', fn: 'getSnapTrades' },
    { page: 'perf-trends', fn: 'getTrendTrades' },
    { page: 'setups', fn: 'getSetupTrades' },
    { page: 'timing', fn: 'getTimingTrades' },
    { page: 'symbols', fn: 'getSymTrades' },
    { page: 'risk', fn: 'getRiskTrades' },
    { page: 'discipline', fn: 'getDiscTrades' },
];

function analytics(a, trades, state, accounts) {
    const box = fromSource(read('js/pages/' + a.page + '.js'), [a.fn], {
        DenariiFilters: sharedFilters(fakeDoc({})),
        Date: FrozenDate,
        _state: Object.assign({ period: 'all', from: '', to: '', style: 'all', setup: 'all', symbol: '' }, state),
        journalData: { trades, brokerAccounts: accounts || [] },
        getSelectedAccountTrades: list => list,
    });
    return box.fns[a.fn]();
}

for (const a of ANALYTICS) {
    // Flipped in Phases 5, 6 and 7: every analytics page follows the Dashboard's rules.
    for (const z of ZONES) {
        const expected = DASH_PERIOD[z.tz];
        test(a.page + ' period rules, ' + z.tz, () => {
            useZone(z);
            assert.equal(ids(analytics(a, PERIOD_TRADES, {})), ALL_IDS.join(' '));
            for (const p of ['today', 'week', 'month', 'ytd']) {
                assert.equal(ids(analytics(a, PERIOD_TRADES, { period: p })), expected[p], p);
            }
            assert.equal(
                ids(analytics(a, PERIOD_TRADES, { period: 'custom', from: CUSTOM_FROM, to: CUSTOM_TO })),
                expected.custom
            );
        });
    }

    test(a.page + ' Style and Symbol filters', () => {
        useZone(ZONES[0]);
        const f = s => ids(analytics(a, FIELD_TRADES, s, ACCOUNTS));
        assert.equal(f({}), 'p q r s');
        assert.equal(f({ style: 'scalping' }), 'p');
        assert.equal(f({ style: 'day_trading' }), 'q');
        assert.equal(f({ style: 'leaps' }), '');
        assert.equal(f({ symbol: 'aap' }), 'p q');
    });

    // Flipped in Phases 5, 6 and 7: Setup is gone, Asset Type and Strategy replace it.
    test(a.page + ' has no Setup filter; Asset Type and Strategy apply', () => {
        useZone(ZONES[0]);
        const f = s => ids(analytics(a, FIELD_TRADES, s, ACCOUNTS));
        assert.equal(f({ setup: 'Breakout' }), 'p q r s');
        assert.equal(f({ strategy: 'Breakout' }), 'p');
        assert.equal(f({ strategy: 'Breakout ' }), 'q');
        assert.equal(f({ strategy: 'Dip & "Rip"' }), 'r');
        assert.equal(f({ assetType: 'stock' }), 'p r s');
        assert.equal(f({ assetType: 'option' }), 'q');
    });

    // Flipped by the account selector work; account-filter.test.js holds the cases.
    test(a.page + ' follows the account selector', () => {
        useZone(ZONES[0]);
        const box = fromSource(read('js/pages/' + a.page + '.js'), [a.fn], {
            DenariiFilters: sharedFilters(fakeDoc({})),
            Date: FrozenDate,
            _state: { period: 'all', from: '', to: '', style: 'all', setup: 'all', symbol: '' },
            journalData: { trades: FIELD_TRADES, brokerAccounts: ACCOUNTS },
            getSelectedAccountTrades: list => list.filter(t => t.brokerAccountId === 'acc1'),
        });
        assert.equal(ids(box.fns[a.fn]()), 'p');
    });
}

// ── Trade Reflection: renderJournalTradeList ────────────────────────────────

function journalBox(trades, values, opts) {
    opts = opts || {};
    const tbody = { innerHTML: '', closest: () => null, appendChild() {}, querySelectorAll: () => [] };
    const doc = {
        getElementById: id => {
            if (id === 'journal-trade-list-body') return tbody;
            return id in values ? (values[id] && values[id].isEl ? values[id] : { value: values[id] }) : null;
        },
        querySelectorAll: () => [],
        createElement: () => ({ style: {} }),
    };
    const box = fromSource(JOURNAL, ['renderJournalTradeList', 'initJournalPage', 'clearJournalFilters'], {
        DenariiFilters: sharedFilters(doc),
        Date: FrozenDate,
        document: doc,
        window: opts.window || {},
        journalData: { trades, strategies: opts.strategies || [], brokerAccounts: opts.accounts || [] },
        getGlobalFilteredTrades: opts.global || (t => t),
        escapeHtml: s => String(s),
        _jnlListPage: 1,
        _jnlListPageSize: 1000,
    });
    return { box, tbody };
}

function journalRows(trades, values, opts) {
    const { box, tbody } = journalBox(trades, values, opts);
    box.fns.renderJournalTradeList();
    return [...tbody.innerHTML.matchAll(/data-id="([^"]+)"/g)].map(m => m[1]);
}

const jr = (values, opts) => journalRows(PERIOD_TRADES, values, opts).sort().join(' ');
const jf = (values, opts) => journalRows(FIELD_TRADES, values, opts).sort().join(' ');

// Flipped in Phase 8: Reflection follows the Dashboard's period rules.
for (const z of ZONES) {
    test('Reflection period rules, ' + z.tz, () => {
        useZone(z);
        const p = (period, extra) => journalRows(PERIOD_TRADES, Object.assign({ 'jnl-filter-period': period }, extra)).sort().join(' ');
        for (const period of ['today', 'week', 'month', 'ytd']) {
            assert.equal(p(period), DASH_PERIOD[z.tz][period], period);
        }
        assert.equal(p('custom', { 'jnl-filter-from': CUSTOM_FROM, 'jnl-filter-to': CUSTOM_TO }), DASH_PERIOD[z.tz].custom);
    });
}

test('Reflection Style filter uses the account style', () => {
    useZone(ZONES[0]);
    assert.equal(jf({ 'jnl-filter-style': 'scalping' }, { accounts: ACCOUNTS }), 'p');
    assert.equal(jf({ 'jnl-filter-style': 'day_trading' }, { accounts: ACCOUNTS }), 'q');
});

test('Reflection with no filters shows every trade', () => {
    useZone(ZONES[0]);
    assert.equal(jr({}), [...ALL_IDS].sort().join(' '));
});

test('Reflection Asset Type and Symbol filters', () => {
    useZone(ZONES[0]);
    assert.equal(jf({ 'jnl-filter-asset-type': 'stock' }), 'p r s', 'missing asset type counts as stock');
    assert.equal(jf({ 'jnl-filter-asset-type': 'option' }), 'q');
    assert.equal(jf({ 'jnl-filter-symbol': 'aap' }), 'p q');
    assert.equal(jf({ 'jnl-filter-symbol': ' aapl ' }), 'p q', 'Reflection trims the symbol');
    assert.equal(jf({ 'jnl-filter-asset-type': 'all', 'jnl-filter-strategy': 'all' }), 'p q r s', 'All values add no filter');
});

test('Reflection applies the account selector', () => {
    useZone(ZONES[0]);
    const only = t => t.filter(x => x.brokerAccountId === 'acc1');
    assert.equal(jf({}, { global: only }), 'p');
});

test('Reflection sorts newest first by default and by the chosen column', () => {
    useZone(ZONES[0]);
    const clean = [
        { id: 'old', symbol: 'ZZ', exitTime: '2026-01-01T12:00:00Z' },
        { id: 'new', symbol: 'AA', exitTime: '2026-03-01T12:00:00Z' },
        { id: 'mid', symbol: 'MM', exitTime: '2026-02-01T12:00:00Z' },
    ];
    assert.deepEqual(journalRows(clean, {}), ['new', 'mid', 'old']);
    assert.deepEqual(
        journalRows(clean, {}, { window: { _jnlSortField: 'symbol', _jnlSortDir: 'asc' } }),
        ['new', 'mid', 'old']
    );
    assert.deepEqual(
        journalRows(clean, {}, { window: { _jnlSortField: 'exitTime', _jnlSortDir: 'asc' } }),
        ['old', 'mid', 'new']
    );
});

test('Reflection shows the empty message when nothing matches', () => {
    useZone(ZONES[0]);
    const { box, tbody } = journalBox(FIELD_TRADES, { 'jnl-filter-symbol': 'NOPE' });
    box.fns.renderJournalTradeList();
    assert.match(tbody.innerHTML, /No trades found/);
});

// Flipped in Phase 8: Clear also resets Period and Style.
test('Reflection Clear resets every filter', () => {
    useZone(ZONES[0]);
    const els = {};
    ['jnl-filter-period', 'jnl-filter-from', 'jnl-filter-to', 'jnl-filter-style', 'jnl-filter-symbol', 'jnl-filter-asset-type', 'jnl-filter-strategy']
        .forEach(id => { els[id] = { isEl: true, value: 'x' }; });
    const { box } = journalBox(FIELD_TRADES, els);
    box.g._jnlListPage = 3;
    box.fns.clearJournalFilters();
    ['jnl-filter-period', 'jnl-filter-style', 'jnl-filter-asset-type', 'jnl-filter-strategy']
        .forEach(id => assert.equal(els[id].value, 'all', id));
    ['jnl-filter-from', 'jnl-filter-to', 'jnl-filter-symbol'].forEach(id => assert.equal(els[id].value, '', id));
    assert.equal(box.g._jnlListPage, 1);
});

// Flipped in Phase 2. It used to pin the bug: options carried the strategy id,
// so choosing one matched nothing.
test('Reflection Strategy: options carry the name, so choosing one returns its trades', () => {
    useZone(ZONES[0]);
    const sel = { isEl: true, value: 'all', innerHTML: '' };
    const strategies = [{ id: 111, name: 'Breakout' }];
    const { box } = journalBox(FIELD_TRADES, { 'jnl-filter-strategy': sel }, { strategies });
    box.fns.initJournalPage();
    assert.match(sel.innerHTML, /<option value="Breakout">Breakout<\/option>/);
    assert.doesNotMatch(sel.innerHTML, /111/);
    assert.equal(jf({ 'jnl-filter-strategy': '111' }, { strategies }), '');
    assert.equal(jf({ 'jnl-filter-strategy': 'Breakout' }, { strategies }), 'p', 'exact: padded name is its own option');
    assert.equal(jf({ 'jnl-filter-strategy': 'Dip & "Rip"' }, { strategies }), 'r', 'trade-only names are offered too');
    assert.match(sel.innerHTML, /<option value="Dip &amp; &quot;Rip&quot;">/);
    assert.equal(sel.value, 'all', 'starts on All Strategies');
    assert.ok(!JOURNAL.includes('_jnlGetFilteredTrades'), 'unused twin removed');
});

// ── Cloud: _cloudDashGetFilters and both queries ────────────────────────────

function cloudFilters(period, values, accounts, acct) {
    const box = fromSource(APP, ['_cloudDashGetFilters', '_localDateStr'], {
        Date: FrozenDate,
        _dashPeriod: period,
        document: fakeDoc(values || {}),
        window: { filterBrokerAccountId: acct || 'all' },
        journalData: { brokerAccounts: accounts || [] },
    });
    return box.fns._cloudDashGetFilters();
}

const cloudBase = { brokerAccountId: 'all', assetType: 'all', strategy: 'all', symbol: null };

test('_cloudDashGetFilters date ranges, New York', () => {
    useZone(ZONES[0]);
    const d = p => { const f = cloudFilters(p); return [f.dateFrom, f.dateTo]; };
    assert.deepEqual(d('all'), [undefined, undefined]);
    assert.deepEqual(d('today'), ['2026-03-17', '2026-03-17']);
    assert.deepEqual(d('week'), ['2026-03-15', '2026-03-21']);
    assert.deepEqual(d('month'), ['2026-03-01', '2026-03-31']);
    assert.deepEqual(d('ytd'), ['2026-01-01', '2026-03-17']);
});

test('_cloudDashGetFilters date ranges, Tokyo', () => {
    useZone(ZONES[1]);
    const d = p => { const f = cloudFilters(p); return [f.dateFrom, f.dateTo]; };
    assert.deepEqual(d('today'), ['2026-03-18', '2026-03-18']);
    assert.deepEqual(d('week'), ['2026-03-15', '2026-03-21']);
    assert.deepEqual(d('ytd'), ['2026-01-01', '2026-03-18']);
});

test('_cloudDashGetFilters custom dates and field values', () => {
    useZone(ZONES[0]);
    const f = cloudFilters('custom', {
        'dash-from': CUSTOM_FROM, 'dash-to': '', 'dash-asset-type': 'option',
        'dash-strategy': 'Breakout', 'dash-symbol': 'aapl', 'dash-style': 'scalping', 'dash-setup': 'X',
    }, [{ id: 'acc1', tradingStyle: 'scalping' }, { id: 'hid', visible: false }]);
    assert.deepEqual(f, {
        brokerAccountId: 'all', dateFrom: CUSTOM_FROM, dateTo: null,
        styledBrokerAccountIds: ['acc1'], assetType: 'option',
        strategy: 'Breakout', symbol: 'AAPL', visibleBrokerAccountIds: ['acc1'],
    });
});

test('_cloudDashGetFilters leaves account lists off when one account is chosen or none exist', () => {
    useZone(ZONES[0]);
    assert.deepEqual(cloudFilters('all', {}, [{ id: 'a' }], 'a'), Object.assign({}, cloudBase, { brokerAccountId: 'a' }));
    assert.deepEqual(cloudFilters('all', {}, []), cloudBase);
});

// Records every builder call, in order. Awaiting it returns `data`.
function recordingClient(data) {
    const calls = [];
    const q = new Proxy({}, {
        get(t, k) {
            if (k === 'then') return (res) => res({ data: data || [], count: (data || []).length, error: null });
            return (...args) => { calls.push([k, ...args]); return q; };
        },
    });
    return { client: { from: tbl => { calls.push(['from', tbl]); return q; } }, calls };
}

const FULL_FILTERS = {
    brokerAccountId: 'all', visibleBrokerAccountIds: ['a', 'b'], styledBrokerAccountIds: ['a'],
    dateFrom: '2026-03-01', dateTo: '2026-03-31', setup: 'S', assetType: 'stock', strategy: 'T', symbol: 'AAP',
};
// March 2026 in UTC: the first local midnight and the one after the last day.
// New York's differ by an hour because its clocks change on Mar 8.
const MARCH_BOUNDS = {
    'America/New_York': ['2026-03-01T05:00:00.000Z', '2026-04-01T04:00:00.000Z'],
    'Asia/Tokyo': ['2026-02-28T15:00:00.000Z', '2026-03-31T15:00:00.000Z'],
};
// Shared by both queries, in the order they apply them. FULL_FILTERS still
// carries setup: 'S' to show a leftover value adds no query (Phase 3).
function fullCalls(tz) {
    const [start, end] = MARCH_BOUNDS[tz];
    return [
        ['in', 'broker_account_id', ['a', 'b']],
        ['in', 'broker_account_id', ['a']],
        ['or', `exit_time.gte."${start}",and(exit_time.is.null,entry_time.gte."${start}")`],
        ['or', `exit_time.lt."${end}",and(exit_time.is.null,entry_time.lt."${end}")`],
        ['eq', 'asset_type', 'stock'],
        ['eq', 'setup_type', 'T'],
        ['ilike', 'symbol', '%AAP%'],
    ];
}

function pageCalls(filters, sort) {
    const rec = recordingClient();
    const box = fromSource(AUTH, ['_fetchCloudDashPage', '_applyCloudDateRange', '_applyCloudStrategy'], {
        DenariiFilters: sharedFilters({}),
        _CLOUD_DASH_SORT_MAP: { exitTime: 'exit_time' },
        _mapSupabaseTradeRow: r => r,
        console: { log() {}, error() {} },
    });
    return box.fns._fetchCloudDashPage(rec.client, 'u1', filters, sort || { field: 'exitTime', dir: 'desc' }, 2, 50)
        .then(() => rec.calls);
}

function metricsCalls(filters) {
    const rec = recordingClient();
    const box = fromSource(AUTH, ['_fetchCloudDashMetrics', '_applyCloudDateRange', '_applyCloudStrategy'], {
        DenariiFilters: sharedFilters({}),
        console: { log() {}, error() {} },
    });
    return box.fns._fetchCloudDashMetrics(rec.client, 'u1', filters).then(() => rec.calls);
}

for (const z of ZONES) {
    test('Page query sends these exact filters, local day bounds in UTC, ' + z.tz, async () => {
        useZone(z);
        assert.deepEqual(await pageCalls(FULL_FILTERS), [
            ['from', 'trades'],
            ['select', '*', { count: 'exact' }],
            ['eq', 'user_id', 'u1'],
            ...fullCalls(z.tz),
            ['order', 'exit_time', { ascending: false, nullsFirst: false }],
            ['range', 50, 99],
        ]);
    });

    test('Metrics query sends the same filters, ' + z.tz, async () => {
        useZone(z);
        assert.deepEqual(await metricsCalls(FULL_FILTERS), [
            ['from', 'trades'],
            ['select', 'pnl, exit_time'],
            ['eq', 'user_id', 'u1'],
            ...fullCalls(z.tz),
            ['range', 0, 999],
        ]);
    });
}

test('Cloud queries: a chosen account wins, "all" values add nothing, no visible accounts returns none', async () => {
    const quiet = { setup: 'all', assetType: 'all', strategy: 'all', symbol: null };
    const page = await pageCalls(Object.assign({ brokerAccountId: 'x' }, quiet));
    assert.deepEqual(page.slice(2, 5).map(c => c[0]), ['eq', 'eq', 'order']);
    assert.deepEqual(page[3], ['eq', 'broker_account_id', 'x']);
    const none = await metricsCalls(Object.assign({ brokerAccountId: 'all', visibleBrokerAccountIds: [] }, quiet));
    assert.deepEqual(none[3], ['eq', 'broker_account_id', '__none__']);
});

test('Known gap, pinned as is: Style with no matching accounts adds no cloud filter', async () => {
    const calls = await pageCalls({ brokerAccountId: 'all', styledBrokerAccountIds: [] });
    assert.equal(calls.filter(c => c[0] === 'in').length, 0);
});

// ── Calendar, Day and Week views force Period ───────────────────────────────

function dashView() {
    const start = CALENDAR.indexOf('window.switchDashView = function (view, btn) {');
    if (start < 0) throw new Error('switchDashView not found');
    let depth = 0, end = -1;
    for (let i = CALENDAR.indexOf('{', start); i < CALENDAR.length; i++) {
        if (CALENDAR[i] === '{') depth++;
        else if (CALENDAR[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const body = CALENDAR.slice(start, end).replace('window.switchDashView = function (view, btn)', 'function switchDashView(view, btn)');
    const els = {
        'dash-period': { value: 'month', style: {} },
        'dash-fg-period': { style: {} },
        'dash-from': { value: '2026-03-01', style: {} },
        'dash-to': { value: '2026-03-31', style: {} },
        'dash-fg-daterange': { style: {} },
    };
    const sets = [];
    const box = sandbox(body, ['switchDashView'], {
        _savedPeriod: null,
        _savedDates: null,
        document: {
            getElementById: id => els[id] || null,
            querySelectorAll: () => [],
        },
        window: {},
        setDashPeriod: p => {
            sets.push(p);
            els['dash-period'].value = p;
            // updateDashboard syncs the dates: All blanks them, Custom keeps them.
            if (p === 'all') { els['dash-from'].value = ''; els['dash-to'].value = ''; }
        },
        updateDashboard: () => {},
        init: () => {},
    });
    return { fn: box.fns.switchDashView, els, sets };
}

test('Review views force Period to All and hide it; Trades restores the saved value', () => {
    const v = dashView();
    v.fn('calendar');
    assert.deepEqual(v.sets, ['all']);
    assert.equal(v.els['dash-fg-period'].style.display, 'none');
    assert.equal(v.els['dash-fg-daterange'].style.display, 'none');
    v.fn('dayview');
    v.fn('weekview');
    assert.deepEqual(v.sets, ['all'], 'already All: nothing more to force');
    v.fn('trades');
    assert.deepEqual(v.sets, ['all', 'month']);
    assert.equal(v.els['dash-fg-period'].style.display, '');
});

test('Custom and its dates survive the round trip; the dates hide on review views', () => {
    const v = dashView();
    v.els['dash-period'].value = 'custom';
    v.els['dash-from'].value = '2026-02-03';
    v.els['dash-to'].value = '2026-02-09';
    v.fn('weekview');
    assert.equal(v.els['dash-fg-daterange'].style.display, 'none');
    assert.equal(v.els['dash-from'].value, '', 'forcing All blanks the dates');
    v.fn('calendar');
    v.fn('trades');
    assert.deepEqual(v.sets, ['all', 'custom']);
    assert.equal(v.els['dash-from'].value, '2026-02-03');
    assert.equal(v.els['dash-to'].value, '2026-02-09');
    assert.equal(v.els['dash-fg-daterange'].style.display, '');
});
