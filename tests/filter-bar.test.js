// Shared filter bar, Phase 1: js/shared/filter-bar.js must apply the Dashboard's
// rules exactly, checked against the real getDashFilteredTrades and
// _cloudDashGetFilters. Phase 2: Reflection's Strategy filter uses it.
// Phases 3 and 5 to 8: every page with filters mounts it. Phase 9: cleanup.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const APP = read('Denarii.js');
const HTML = read('index.html');
const JOURNAL = read('js/pages/journal.js');

const win = {};
new Function('window', read('js/shared/filter-bar.js'))(win);
const F = win.DenariiFilters;

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

function fromApp(names, vals) {
    const code = names.map(n => extractFunction(APP, n)).join('\n');
    const keys = Object.keys(vals);
    return new Function(...keys, code + '\nreturn {' + names.join(',') + '};')(...keys.map(k => vals[k]));
}

const NOW = Date.parse('2026-03-18T01:00:00Z');
class FrozenDate extends Date {
    constructor(...args) {
        if (args.length === 0) super(NOW);
        else super(...args);
    }
}
const frozenNow = () => new FrozenDate();

const ZONES = ['America/New_York', 'Asia/Tokyo'];
const PERIODS = ['all', 'today', 'week', 'month', 'ytd', 'custom'];
const ACCOUNTS = [{ id: 'acc1', tradingStyle: 'scalping' }, { id: 2, tradingStyle: 'day_trading' }];
const TRADES = [
    { id: 'a', exitTime: '2026-03-18T00:30:00Z', symbol: 'AAPL', brokerAccountId: 'acc1', setupType: 'Breakout', assetType: 'stock' },
    { id: 'b', exitTime: '2026-03-17T12:00:00Z', symbol: 'aapl', brokerAccountId: '2', setupType: 'Breakout ', assetType: 'option' },
    { id: 'c', exitTime: '2026-03-15T05:00:00Z', symbol: 'MSFT', brokerAccountId: 'gone', setupType: 'Dip & "Rip"', assetType: null },
    { id: 'd', exitTime: '2026-03-15T03:00:00Z', symbol: 'TSLA', brokerAccountId: 'acc1' },
    { id: 'e', exitTime: '2026-03-21T20:00:00Z', symbol: 'NVDA', brokerAccountId: '2', setupType: 'Breakout' },
    { id: 'f', exitTime: '2026-03-01T02:00:00Z', symbol: 'AMD', setupType: 'Gap' },
    { id: 'g', exitTime: '2026-02-20T12:00:00Z', symbol: 'AAPL', setupType: 'Gap', assetType: 'future' },
    { id: 'h', exitTime: '2026-01-01T02:00:00Z', symbol: 'SPY', assetType: 'stock' },
    { id: 'i', exitTime: '2025-12-31T20:00:00Z', symbol: 'SPY', assetType: 'crypto' },
    { id: 'j', exitTime: '2026-06-01T12:00:00Z', symbol: 'QQQ' },
    { id: 'k', exitTime: null, entryTime: '2026-03-17T15:00:00Z', symbol: 'IWM' },
    { id: 'l', symbol: 'NODATE' },
    { id: 'm', exitTime: 'garbage', symbol: 'BAD' },
];
const STATES = [
    {},
    { style: 'scalping' }, { style: 'day_trading' }, { style: 'leaps' },
    { assetType: 'stock' }, { assetType: 'option' }, { assetType: 'future' },
    { strategy: 'Breakout' }, { strategy: 'Breakout ' }, { strategy: 'Dip & "Rip"' }, { strategy: 'Missing' },
    { symbol: 'aap' }, { symbol: 'AAPL ' },
    { style: 'scalping', assetType: 'stock', strategy: 'Breakout', symbol: 'a' },
];

function dashFor(period, st) {
    const vals = {
        'dash-from': st.from, 'dash-to': st.to, 'dash-style': st.style, 'dash-asset-type': st.assetType,
        'dash-strategy': st.strategy, 'dash-symbol': st.symbol,
    };
    const doc = { getElementById: id => (vals[id] !== undefined ? { value: vals[id] } : null) };
    const w = {};
    new Function('window', 'document', read('js/shared/filter-bar.js'))(w, doc);
    return fromApp(['getDashFilteredTrades', '_localDateStr'], {
        DenariiFilters: w.DenariiFilters,
        Date: FrozenDate,
        _dashPeriod: period,
        document: doc,
        journalData: { brokerAccounts: ACCOUNTS },
    });
}

for (const tz of ZONES) {
    test('filterTrades returns exactly what getDashFilteredTrades returns, ' + tz, () => {
        process.env.TZ = tz;
        for (const period of PERIODS) {
            for (const base of STATES) {
                const st = period === 'custom' ? Object.assign({ from: '2026-03-15', to: '2026-03-17' }, base) : base;
                const dash = dashFor(period, st).getDashFilteredTrades(TRADES);
                const shared = F.filterTrades(TRADES, Object.assign({ period }, st), ACCOUNTS, frozenNow());
                assert.deepEqual(shared.map(t => t.id), dash.map(t => t.id), JSON.stringify({ period, st }));
            }
        }
    });

    test('periodRange gives the dates the Dashboard sends to the cloud, ' + tz, () => {
        process.env.TZ = tz;
        for (const period of PERIODS) {
            const vals = { 'dash-from': '2026-03-15', 'dash-to': '' };
            const cloud = fromApp(['_cloudDashGetFilters', '_localDateStr'], {
                Date: FrozenDate,
                _dashPeriod: period,
                document: { getElementById: id => (vals[id] !== undefined ? { value: vals[id] } : null) },
                window: { filterBrokerAccountId: 'all' },
                journalData: { brokerAccounts: [] },
            })._cloudDashGetFilters();
            const r = F.periodRange(period, '2026-03-15', '', frozenNow());
            assert.deepEqual(r ? [r.from, r.to] : [undefined, undefined], [cloud.dateFrom, cloud.dateTo], period);
        }
    });
}

test('periodRange handles a week crossing the year and a leap February', () => {
    process.env.TZ = 'America/New_York';
    assert.deepEqual(F.periodRange('week', '', '', new Date(2026, 11, 30)), { from: '2026-12-27', to: '2027-01-02' });
    assert.deepEqual(F.periodRange('month', '', '', new Date(2028, 1, 10)), { from: '2028-02-01', to: '2028-02-29' });
    assert.equal(F.periodRange('all', '', '', new Date()), null);
});

test('esc covers every character that can break out of an option', () => {
    assert.equal(F.esc(`<a href="x">'&`), '&lt;a href=&quot;x&quot;&gt;&#39;&amp;');
    assert.equal(F.esc(null), '');
});

test('strategyOptions combines saved and trade-only names, exact values, trimmed labels', () => {
    const opts = F.strategyOptions(
        [{ setupType: 'Breakout ' }, { setupType: 'Breakout' }, { setupType: 'Orphan' }, { setupType: null }, { setupType: '  ' }, {}],
        [{ name: 'Zed', isFavorite: false }, { name: 'Breakout' }, {}]
    );
    assert.deepEqual(opts, [
        { value: 'Breakout', label: 'Breakout' },
        { value: 'Breakout ', label: 'Breakout' },
        { value: 'Orphan', label: 'Orphan' },
        { value: 'Zed', label: 'Zed' },
    ]);
});

test('strategyOptions is safe with names like constructor', () => {
    assert.deepEqual(F.strategyOptions([{ setupType: 'constructor' }], []), [{ value: 'constructor', label: 'constructor' }]);
});

test('populateStrategy escapes, keeps a valid choice, and falls back to All', () => {
    const sel = { value: 'Old', innerHTML: '' };
    F.populateStrategy(sel, [], [{ name: '<b>"x"&' }], '');
    assert.equal(
        sel.innerHTML,
        '<option value="">All Strategies</option><option value="__no_strategy__">No Strategy</option><option value="&lt;b&gt;&quot;x&quot;&amp;">&lt;b&gt;&quot;x&quot;&amp;</option>'
    );
    assert.equal(sel.value, '', 'deleted choice returns to All');

    sel.value = 'Keep';
    F.populateStrategy(sel, [], [{ name: 'Keep' }]);
    assert.equal(sel.value, 'Keep');
    assert.match(sel.innerHTML, /^<option value="all">/);
    F.populateStrategy(null, [], []);
});

test('barHtml has the five filters in Dashboard style, always-visible dates and no Setup', () => {
    const html = F.barHtml('snap');
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    for (const id of ['snap-period', 'snap-from', 'snap-to', 'snap-style', 'snap-asset-type', 'snap-strategy', 'snap-symbol',
        'snap-fg-period', 'snap-fg-daterange']) {
        assert.ok(ids.includes(id), id);
    }
    assert.ok(!ids.includes('snap-date-range') && !ids.includes('snap-custom-dates'));
    assert.doesNotMatch(html, /display:none/);
    assert.equal(new Set(ids).size, ids.length, 'ids are unique');
    assert.doesNotMatch(html, /setup/i);
    const period = html.slice(html.indexOf('snap-period'), html.indexOf('</select>'));
    assert.deepEqual([...period.matchAll(/value="(\w+)"/g)].map(m => m[1]), ['all', 'ytd', 'month', 'week', 'today', 'custom']);
    assert.equal((html.match(/snap-fg-sep/g) || []).length, 4);
});

function fakeBar() {
    const handlers = {};
    return {
        dataset: {},
        inserted: [],
        insertAdjacentHTML(pos, h) { this.inserted.push([pos, h]); },
        addEventListener(type, fn) { handlers[type] = fn; },
        fire(type, target) { handlers[type]({ target }); },
    };
}

test('mountFilterBar goes before page actions, mounts once, and filters live', () => {
    const els = { 'snap-period': { value: 'all' }, 'snap-from': { value: '' }, 'snap-to': { value: '' } };
    const prev = global.document;
    global.document = { getElementById: id => els[id] || null };
    try {
        const el = fakeBar();
        let renders = 0;
        F.mountFilterBar(el, { prefix: 'snap', onChange: () => renders++ });
        F.mountFilterBar(el, { prefix: 'snap', onChange: () => renders++ });
        assert.equal(el.inserted.length, 1);
        assert.equal(el.inserted[0][0], 'afterbegin');

        el.fire('change', { id: 'snap-style', value: 'leaps' });
        assert.equal(renders, 1);
        el.fire('input', { id: 'snap-symbol', value: 'A' });
        assert.equal(renders, 2);
        el.fire('change', { id: 'snap-symbol', value: 'A' });
        assert.equal(renders, 2, 'symbol renders once, on input');
        el.fire('change', { id: 'snap-edit-btn' });
        assert.equal(renders, 2, 'page actions are ignored');

        const range = F.periodRange('month', '', '', new Date());
        els['snap-period'].value = 'month';
        el.fire('change', { id: 'snap-period' });
        assert.deepEqual([els['snap-from'].value, els['snap-to'].value], [range.from, range.to], 'Period fills the dates');
        assert.equal(renders, 3);

        els['snap-from'].value = '2026-01-05';
        el.fire('change', { id: 'snap-from' });
        assert.equal(els['snap-period'].value, 'custom', 'editing a date switches to Custom');
        assert.equal(els['snap-from'].value, '2026-01-05');
        assert.equal(els['snap-to'].value, range.to);
        assert.equal(renders, 4, 'and filters live');

        el.fire('change', { id: 'snap-period' });
        assert.equal(els['snap-from'].value, '2026-01-05', 'Custom keeps the dates');

        els['snap-period'].value = 'all';
        el.fire('change', { id: 'snap-period' });
        assert.deepEqual([els['snap-from'].value, els['snap-to'].value], ['', ''], 'All blanks them');
    } finally {
        global.document = prev;
    }
});

test('readState reads a page by prefix and treats blanks as All', () => {
    const vals = { 'x-period': 'week', 'x-style': '', 'x-asset-type': 'stock', 'x-symbol': 'a' };
    const prev = global.document;
    global.document = { getElementById: id => (id in vals ? { value: vals[id] } : null) };
    try {
        assert.deepEqual(F.readState('x'), {
            period: 'week', from: '', to: '', style: 'all', assetType: 'stock', strategy: 'all', symbol: 'a',
        });
    } finally {
        global.document = prev;
    }
});

test('readState puts the current range in the dates, for a value set by code or a new day', () => {
    const els = { 'x-period': { value: 'today' }, 'x-from': { value: '2020-01-01' }, 'x-to': { value: '2020-01-01' } };
    const prev = global.document;
    global.document = { getElementById: id => els[id] || null };
    try {
        const today = F.periodRange('today').from;
        const st = F.readState('x');
        assert.deepEqual([st.from, st.to], [today, today]);
        els['x-period'].value = 'custom';
        els['x-from'].value = '2020-01-01';
        assert.equal(F.readState('x').from, '2020-01-01');
    } finally {
        global.document = prev;
    }
});

test('Run Analysis: only the shared bar filters, mounted once, with the form controls kept', () => {
    const RUN = read('js/ai-run.js');
    const page = pageMarkup('ai-run');
    assert.match(page, /<div class="snap-filter-bar" id="ai-run-filter-bar"/);
    assert.doesNotMatch(page, /ai-run-(instrument|strategy|style|date-from|date-to)"/);
    for (const s of ['ai-run-prompt-select', 'ai-run-prompt-text', 'ai-run-trade-count-val', 'AIRun.execute()', 'ai-run-output']) assert.ok(page.includes(s), s);
    assert.equal((RUN.match(/mountFilterBar\(/g) || []).length, 1);
    assert.doesNotMatch(RUN + read('js/ai-reports.js'), /ai-run-(instrument|date-from|date-to)/);
});

function runScripts(trades, accounts) {
    const els = {};
    const el = id => els[id] || (els[id] = { id, value: '', style: {}, dataset: {}, textContent: '',
        insertAdjacentHTML() {}, addEventListener() {}, classList: { contains: () => false } });
    const sent = [];
    const ctx = { console: { log() {}, warn() {} }, journalData: { trades, brokerAccounts: accounts, aiOutputHistory: [] },
        document: { getElementById: el }, setInterval: () => 0, clearInterval() {} };
    ctx.window = ctx;
    ctx.DenAriiAI = { isConfigured: () => true, query: async r => { sent.push(r); return { success: false, error: 'x' }; } };
    const vm = require('node:vm');
    vm.createContext(ctx);
    for (const f of ['js/shared/filter-bar.js', 'js/services/ai/formatter.js', 'js/ai-run.js']) vm.runInContext(read(f), ctx);
    return { ctx, el, sent };
}

for (const z of ZONES) {
    test('Run Analysis: Trades Selected and the trades sent both follow the bar, last day included, ' + z, async () => {
        process.env.TZ = z;
        const y = new Date().getFullYear();
        const mk = (id, day, extra) => Object.assign({ id, symbol: 'AAPL', pnl: 1, type: 'long',
            entryTime: new Date(y, 2, day, 9).toISOString(), exitTime: new Date(y, 2, day, 10).toISOString() }, extra);
        const trades = [mk('a', 5), mk('b', 7, { symbol: 'MSFT' }), mk('c', 9), mk('d', 7, { assetType: 'option' }), mk('e', 7, { brokerAccountId: 'acc1' })];
        const { ctx, el, sent } = runScripts(trades, [{ id: 'acc1', tradingStyle: 'scalping' }]);
        const count = () => { ctx.AIRun.init(); return el('ai-run-trade-count-val').textContent; };
        assert.equal(count(), '5 of 5');

        el('ai-run-period').value = 'custom';
        el('ai-run-from').value = y + '-03-05';
        el('ai-run-to').value = y + '-03-07';
        assert.equal(count(), '4 of 5', 'the To day counts in full');
        el('ai-run-symbol').value = 'msft';
        assert.equal(count(), '1 of 5');
        el('ai-run-symbol').value = '';
        el('ai-run-asset-type').value = 'option';
        assert.equal(count(), '1 of 5');
        el('ai-run-asset-type').value = 'all';
        el('ai-run-style').value = 'scalping';
        assert.equal(count(), '1 of 5');

        el('ai-run-prompt-text').value = 'Go';
        await ctx.AIRun.execute();
        assert.deepEqual(sent[0].tradeData.map(t => t.id), ['e']);
        const payload = ctx._DenAriiAIFormatter.buildPayload(sent[0]);
        assert.equal(payload.trades.length, 1);
        assert.deepEqual(JSON.parse(JSON.stringify(payload.filters)),
            { dateRange: { start: y + '-03-05', end: y + '-03-07' }, style: 'scalping' }, 'Active Filters keep their form');
    });
}

function reportsPage(history) {
    const els = {};
    const el = id => els[id] || (els[id] = { id, value: '', style: {}, dataset: {}, innerHTML: '',
        insertAdjacentHTML() {}, addEventListener() {}, appendChild() {}, remove() {}, querySelectorAll: () => [] });
    const ctx = { journalData: { aiOutputHistory: history }, document: { getElementById: el, createElement: () => el('ai-reports-filter-bar') } };
    ctx.window = ctx;
    const vm = require('node:vm');
    vm.createContext(ctx);
    vm.runInContext(read('js/shared/filter-bar.js'), ctx);
    vm.runInContext(read('js/ai-reports.js'), ctx);
    const shown = () => [...el('ai-reports-results').innerHTML.matchAll(/ai-report-card" data-report-id="([^"]+)"/g)].map(m => m[1]).sort().join(' ');
    ctx.AIReports.render();
    return { ctx, el, shown };
}

test('Saved Reports: bar and Search filter together on what reports store', () => {
    process.env.TZ = 'America/New_York';
    const { el, shown, ctx } = reportsPage([
        { id: 'r1', promptTitle: 'Alpha', createdAt: '2026-03-10T15:00:00Z', filters: { instrumentType: 'stock', styleFilter: 'day_trading', strategyFilter: 'Breakout' } },
        { id: 'r2', promptTitle: 'Beta', createdAt: '2026-03-11T01:00:00Z', filters: { instrumentType: 'option', styleFilter: 'Day Trade' } },
        { id: 'r3', promptTitle: 'Alpha two', createdAt: '2026-03-20T15:00:00Z', filters: null },
        { id: 'r4', promptTitle: 'Undated', filters: {} },
    ]);
    const redraw = () => ctx.AIReports.onFilterChange('provider', 'all');
    assert.equal(shown(), 'r1 r2 r3 r4');

    el('ai-reports-period').value = 'custom';
    el('ai-reports-from').value = '2026-03-10';
    el('ai-reports-to').value = '2026-03-10';
    redraw();
    assert.equal(shown(), 'r1 r2', 'run date is the local day');
    el('ai-reports-to').value = '';
    el('ai-reports-style').value = 'day_trading';
    redraw();
    assert.equal(shown(), 'r1 r2', 'old Style labels match');
    el('ai-reports-style').value = 'all';
    el('ai-reports-asset-type').value = 'option';
    redraw();
    assert.equal(shown(), 'r2');
    el('ai-reports-asset-type').value = 'all';
    el('ai-reports-strategy').value = 'Breakout';
    redraw();
    assert.equal(shown(), 'r1');
    el('ai-reports-strategy').value = 'all';
    ctx.AIReports.onSearch('alpha');
    assert.equal(shown(), 'r1 r3', 'Search narrows within the bar');
    el('ai-reports-from').value = '2026-03-15';
    redraw();
    assert.equal(shown(), 'r3');

    ctx.AIReports.clearFilters();
    assert.equal(el('ai-reports-period').value, 'all');
    assert.equal(shown(), 'r1 r2 r3 r4');
    assert.match(el('ai-reports-strategy').innerHTML, /<option value="Breakout">/);
});

test('Saved Reports: Symbol is omitted, and no old Instrument or Style selects remain', () => {
    const REPORTS = read('js/ai-reports.js');
    assert.match(REPORTS, /getElementById\('ai-reports-fg-symbol'\)/);
    assert.doesNotMatch(REPORTS, /ai-reports-filter-(instrument|style)/);
    assert.match(REPORTS, /id="ai-reports-search"/);
});

test('filter-bar.js loads before Denarii.js and before the pages', () => {
    const at = s => HTML.indexOf('src="' + s);
    assert.ok(at('js/shared/filter-bar.js') > 0);
    assert.ok(at('js/shared/filter-bar.js') < at('Denarii.js'));
    assert.ok(at('js/shared/filter-bar.js') < at('js/pages/journal.js'));
});

const MIGRATED = [
    { tab: 'perf-trends', file: 'perf-trends', prefix: 'trend', setPeriod: 'setTrendPeriod', getFn: 'getTrendTrades' },
    { tab: 'setups', file: 'setups', prefix: 'setups', setPeriod: 'setSetupsPeriod', getFn: 'getSetupTrades' },
    { tab: 'timing', file: 'timing', prefix: 'timing', setPeriod: 'setTimingPeriod', getFn: 'getTimingTrades' },
    { tab: 'symbols', file: 'symbols', prefix: 'sym', setPeriod: 'setSymPeriod', getFn: 'getSymTrades' },
    { tab: 'risk', file: 'risk', prefix: 'risk', setPeriod: 'setRiskPeriod', getFn: 'getRiskTrades' },
    { tab: 'discipline', file: 'discipline', prefix: 'disc', setPeriod: 'setDiscPeriod', getFn: 'getDiscTrades' },
];

test('Calendar has no filter bar of its own', () => {
    assert.doesNotMatch(read('js/pages/calendar.js'), /mountFilterBar/);
});

function pageMarkup(id) {
    const start = HTML.indexOf('<div class="tab-content' + (id === 'dashboard' ? ' active' : '') + '" id="' + id + '">');
    assert.ok(start > 0, id);
    return HTML.slice(start, HTML.indexOf('class="tab-content', start + 30));
}

test('Phase 3: Dashboard mounts the shared bar once, keeps New Trade, has no Setup', () => {
    const page = pageMarkup('dashboard');
    assert.match(page, /<div class="snap-filter-bar" id="dash-filter-bar">/);
    assert.match(page, /id="dash-fg-newtrade"/);
    assert.doesNotMatch(page, /<select|dash-setup|dash-fg-setup/);
    assert.equal((APP.match(/mountFilterBar\(/g) || []).length, 1);
    assert.ok(APP.indexOf('mountFilterBar(') < APP.indexOf('_populateStyleSelects();'), 'mounted before Style is filled');
    assert.doesNotMatch(APP, /_populateDashSetups|dash-setup|f\.setup/);
    assert.doesNotMatch(read('js/auth.js'), /filters\.setup/);
});

test('Phase 5: Snapshot mounts the shared bar with its layout buttons on the right', () => {
    const page = pageMarkup('snapshot');
    const SNAP = read('js/pages/snapshot.js');
    assert.match(page, /<div class="snap-filter-bar" id="snap-filter-bar">\s*<div class="snap-layout-btns">/);
    for (const s of ['toggleSnapEdit()', 'openSnapPicker()', 'snapResetLayout()']) assert.ok(page.includes(s), s);
    assert.doesNotMatch(page, /snap-pill|setSnapPeriod|snap-setup/);
    assert.equal((SNAP.match(/mountFilterBar\(/g) || []).length, 1);
    assert.doesNotMatch(SNAP, /updateDateRange|setSnapPeriod|snap-pill|_state\.setup|snap-setup/);
    assert.match(SNAP, /_populateStyleSelect\('snap-style', true\)/);
});

for (const m of MIGRATED) {
    test('Phases 6 and 7: ' + m.tab + ' mounts the shared bar with its page actions on the right', () => {
        const page = pageMarkup(m.tab);
        const src = read('js/pages/' + m.file + '.js');
        assert.match(page, new RegExp('<div class="snap-filter-bar" id="' + m.prefix + '-filter-bar">\\s*<div class="snap-layout-btns">'));
        assert.doesNotMatch(page, new RegExp('data-period|' + m.setPeriod + '|' + m.prefix + '-setup'));
        assert.equal((src.match(/mountFilterBar\(/g) || []).length, 1);
        assert.match(src, new RegExp("_populateStyleSelect\\('" + m.prefix + "-style', true\\)"));
        assert.match(src, new RegExp("DenariiFilters\\.readState\\('" + m.prefix + "'\\)"));
        assert.doesNotMatch(src, new RegExp('updateDateRange|' + m.setPeriod + '|_state\\.setup|-pill\\[data-period\\]'));
    });

    test('Phases 6 and 7: every ' + m.tab + ' widget gets trades through ' + m.getFn, () => {
        const src = read('js/pages/' + m.file + '.js');
        assert.equal((src.match(/journalData\.trades/g) || []).length, 2, 'only the shared filter and the Strategy options');
        assert.match(src, new RegExp('function ' + m.getFn + '\\(\\) \\{\\s*return DenariiFilters\\.filterTrades\\(getSelectedAccountTrades\\(journalData\\.trades\\), _state,'));
        assert.match(src, /populateStrategy\(stratSel, journalData\.trades, journalData\.strategies\)/);
    });
}

test('Page controls below the bar stay', () => {
    for (const s of ['setSetupsRankBy(', 'setSetupsMinSample(', 'setups-hide-no-setup',
        'setTimingMetric(', 'setTimingSession(', 'setTimingMinSample(']) {
        assert.ok(HTML.includes(s), s);
    }
});

test('Performance Trends: the grouping row is gone; only the 7 charts it regroups have a dropdown', () => {
    assert.doesNotMatch(pageMarkup('perf-trends'), /Group charts by|setTrendGroupBy|data-gb/);
    const src = read('js/pages/perf-trends.js');
    assert.doesNotMatch(src, /snap-pill\[data-gb\]/);
    assert.match(src, /groupBy: 'day'/);
    const dropdown = (wid, groupBy) => new Function('_state', 'wid',
        extractFunction(src, 'groupTagHtml') + '\nreturn groupTagHtml(wid);')({ groupBy }, wid);
    const shown = html => [...html.matchAll(/value="(\w+)" selected/g)].map(m => m[1]);
    for (const wid of ['trade-count', 'win-rate-trend', 'avg-pnl-trend', 'largest-loss-trend', 'avg-loss-trend']) {
        const html = dropdown(wid, 'quarter');
        assert.deepEqual([...html.matchAll(/<option value="(\w+)"/g)].map(m => m[1]), ['day', 'week', 'month', 'quarter', 'year'], wid);
        assert.match(html, /onchange="setTrendGroupBy\(this\.value,this\)"/);
        assert.deepEqual(shown(html), ['quarter'], wid);
        assert.deepEqual(shown(dropdown(wid, 'day')), ['day'], wid);
    }
    for (const wid of ['red-day-rate', 'green-red-days']) {
        assert.deepEqual(shown(dropdown(wid, 'day')), ['week'], wid + ' draws Day as Week');
        assert.deepEqual(shown(dropdown(wid, 'month')), ['month'], wid);
    }
    for (const wid of ['equity-curve', 'daily-pnl', 'drawdown-curve', 'weekly-pnl', 'monthly-pnl', 'pnl-distribution', 'dow-trend', undefined]) {
        assert.equal(dropdown(wid, 'month'), '', String(wid));
    }
    assert.match(src, /_state\.editMode \? '' : groupTagHtml\(helpId\)/, 'hidden in Edit Layout');
});

test('Phase 8: Reflection mounts the shared bar with Clear on the right and no Apply', () => {
    const start = HTML.indexOf('Select a Trade to Reflect On');
    const part = HTML.slice(start, HTML.indexOf('<!-- Trade list table -->', start));
    assert.match(part, /id="jnl-filter-bar"[^>]*>\s*<div class="snap-layout-btns">\s*<button[^>]*onclick="clearJournalFilters\(\)">Clear<\/button>/);
    assert.doesNotMatch(part, /Apply|jnl-filter-date|<select|<input/);
    assert.equal((JOURNAL.match(/mountFilterBar\(/g) || []).length, 1);
    assert.match(JOURNAL, /prefix: 'jnl-filter'/);
    assert.match(APP, /'jnl-filter-style'/);
    const ids = [...F.barHtml('jnl-filter').matchAll(/ id="([^"]+)"/g)].map(m => m[1]);
    for (const id of ids) assert.ok(!HTML.includes('id="' + id + '"'), id + ' is free for the bar');
});

test('Phase 8: a Reflection filter change goes back to page 1', () => {
    assert.match(JOURNAL, /onChange: function\(\) \{ _jnlListPage = 1; renderJournalTradeList\(\); \}/);
});

test('Phase 9: old period pills and helpers are gone, snap-pill stays', () => {
    const CSS = read('Denarii.css');
    assert.doesNotMatch(CSS + HTML, /sym-pill|risk-pill|disc-pill/);
    assert.match(CSS, /\.snap-pill/);
    assert.doesNotMatch(APP + HTML, /_updateDashDateRange|handlePeriodChange/);
    assert.match(APP, /function _cloudDashGetFilters/);
});

// Dashboard (local and cloud) and Snapshot use gross wins / gross losses.
function snapshotCalc() {
    const src = read('js/pages/snapshot.js');
    return new Function('DenariiFilters', extractFunction(src, 'calcSnap') + '\nreturn calcSnap;')(F);
}

function dashboardPf(winners, losers) {
    return fromApp(['_grossProfitFactor'], {})._grossProfitFactor(winners, losers);
}

async function cloudPf(rows) {
    const q = new Proxy({}, {
        get(t, k) {
            if (k === 'then') return res => res({ data: rows, error: null });
            return () => q;
        },
    });
    const log = console.log;
    console.log = () => {};
    try {
        const fn = new Function('_applyCloudDateRange', '_applyCloudStrategy', extractFunction(read('js/auth.js'), '_fetchCloudDashMetrics').replace(/^function/, 'return async function'))(query => query, query => query);
        return (await fn({ from: () => q }, 'u1', {})).profitFactor;
    } finally {
        console.log = log;
    }
}

for (const [name, pnls, expected] of [
    ['mixed', [100, 200, 44, -50, -150], 1.72],
    ['uneven counts, where average win / average loss would differ', [300, -50, -50, -100], 1.5],
    ['no losses', [10, 20], Infinity],
    ['no wins', [-10], 0],
    ['no trades', [], 0],
]) {
    test('Profit Factor: Dashboard local, Dashboard cloud and Snapshot agree, ' + name, async () => {
        const trades = pnls.map((pnl, i) => ({ pnl, exitTime: '2026-03-1' + i + 'T12:00:00Z', exitPrice: 1 }));
        const snap = snapshotCalc()(trades).profitFactor;
        const local = dashboardPf(trades.filter(t => t.pnl > 0), trades.filter(t => t.pnl < 0));
        const cloud = await cloudPf(pnls.map((pnl, i) => ({ pnl, exit_time: '2026-03-1' + i + 'T12:00:00Z' })));
        assert.equal(snap, expected);
        assert.equal(local, snap);
        assert.equal(cloud, snap);
    });
}

test('Profit Factor card shows the infinity sign when there are no losses', () => {
    assert.match(APP, /isFinite\(_mProfitFactor\) \? _mProfitFactor\.toFixed\(2\) : '∞'/);
});

test('Reflection Strategy goes through the shared populator', () => {
    assert.match(JOURNAL, /DenariiFilters\.populateStrategy\(strategySel, journalData\.trades, journalData\.strategies\)/);
});
