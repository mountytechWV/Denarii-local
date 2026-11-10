// Reusing a saved report runs on the report's account for that run only, and
// the leftovers batch that shipped with it.
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

const ACCOUNTS = [
    { id: 'a1', displayName: 'One' },
    { id: 'a2', displayName: 'Two' },
    { id: 'hid', displayName: 'Hidden', visible: false },
];
const trade = (id, brokerAccountId) => ({
    id, brokerAccountId, symbol: 'AAPL', type: 'long', entryTime: '2026-03-10T14:00:00Z', exitTime: '2026-03-10T15:00:00Z', pnl: 1,
});
const TRADES = [trade('t1', 'a1'), trade('t2', 'a1'), trade('t3', 'a2'), trade('t4', 'hid')];
const REPORT = JSON.stringify({ title: 'T', summary: 'S', sections: [{ heading: 'H', items: ['a', 'b'] }] });

function page(header, success = true) {
    const els = {};
    const el = id => els[id] || (els[id] = {
        id, value: '', innerHTML: '', textContent: '', style: {}, dataset: {}, listeners: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: c => c === 'active' },
        addEventListener(type, fn) { this.listeners.push(fn); }, insertAdjacentHTML() {}, querySelectorAll: () => [], appendChild() {},
    });
    el('filter-broker-account').value = header;
    const sent = [];
    const ctx = {
        document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [], createElement: () => el('x') },
        journalData: { brokerAccounts: ACCOUNTS, trades: TRADES, aiOutputHistory: [] },
        filterBrokerAccountId: header,
        console: { log() {}, warn() {}, error() {} },
        setTimeout: () => 0, setInterval: () => 0, clearInterval() {},
        DenAriiAI: {
            isConfigured: () => true,
            query: async r => { sent.push(r); return success ? { success: true, rawText: REPORT } : { success: false, error: 'x' }; },
        },
    };
    ctx.window = ctx;
    ctx.getSelectedAccountTrades = new Function('window', 'journalData', 'ensureBrokerAccounts',
        extractFunction(BROKER, 'getSelectedAccountTrades') + '\nreturn getSelectedAccountTrades;'
    )(ctx, ctx.journalData, () => {});
    vm.createContext(ctx);
    for (const f of ['js/shared/filter-bar.js', 'js/services/ai/formatter.js', 'js/ai-run.js']) vm.runInContext(read(f), ctx);
    ctx.AIRun.init();
    el('ai-run-prompt-text').value = 'Go';
    const count = () => el('ai-run-trade-count-val').textContent;
    const sentIds = () => sent.map(r => r.tradeData.map(t => t.id).join(' '));
    return { ctx, el, sent, count, sentIds };
}

test('the report account sets the count at once and the run uses it; the header stays', async () => {
    const p = page('a1');
    assert.equal(p.count(), '2 of 3');
    p.ctx.AIRun.setFilters({ accountFilter: 'a2' });
    assert.equal(p.count(), '1 of 3');
    assert.equal(p.el('ai-run-trade-count-account').textContent, ' · Two');
    await p.ctx.AIRun.execute();
    assert.deepEqual(p.sentIds(), ['t3']);
    assert.equal(p.sent[0].accountFilter, 'a2');
    assert.equal(p.ctx.filterBrokerAccountId, 'a1');
    assert.equal(p.el('filter-broker-account').value, 'a1');
});

test('Reuse Prompt no longer touches the shared selector', () => {
    const src = read('js/ai-reports.js');
    assert.ok(!src.includes('filter-broker-account'));
    assert.ok(!src.includes('applyGlobalFilters'));
});

test('a report with no account runs on All Accounts, hidden accounts left out', async () => {
    const p = page('a1');
    p.ctx.AIRun.setFilters({});
    assert.equal(p.count(), '3 of 3');
    assert.equal(p.el('ai-run-trade-count-account').textContent, ' · All Accounts');
    await p.ctx.AIRun.execute();
    assert.deepEqual(p.sentIds(), ['t1 t2 t3']);
    assert.equal(p.sent[0].accountFilter, undefined);
});

test('the account lasts for one run; the next follows the header, and saving keeps the account that ran', async () => {
    const p = page('a1');
    p.ctx.AIRun.setFilters({ accountFilter: 'a2' });
    await p.ctx.AIRun.execute();
    assert.equal(p.count(), '2 of 3');
    assert.equal(p.el('ai-run-trade-count-account').textContent, '');
    await p.ctx.AIRun.saveOutput();
    assert.equal(p.ctx.journalData.aiOutputHistory[0].filters.accountFilter, 'a2');
    await p.ctx.AIRun.execute();
    assert.deepEqual(p.sentIds(), ['t3', 't1 t2']);
});

test('a failed run can be retried on the same account', async () => {
    const p = page('a1', false);
    p.ctx.AIRun.setFilters({ accountFilter: 'a2' });
    await p.ctx.AIRun.execute();
    await p.ctx.AIRun.execute();
    assert.deepEqual(p.sentIds(), ['t3', 't3']);
});

test('a deleted account shows a message and does not run', async () => {
    const p = page('a1');
    p.ctx.AIRun.setFilters({ accountFilter: 'gone' });
    assert.equal(p.count(), '0 of 3');
    assert.match(p.el('ai-run-status').textContent, /no longer exists/);
    await p.ctx.AIRun.execute();
    assert.equal(p.sent.length, 0);
    assert.match(p.el('ai-run-status').textContent, /no longer exists/);
});

test('choosing a header account replaces the report account and clears the message', async () => {
    const p = page('a1');
    p.ctx.AIRun.setFilters({ accountFilter: 'gone' });
    p.ctx.filterBrokerAccountId = 'a2';
    p.el('filter-broker-account').listeners.forEach(fn => fn());
    assert.equal(p.count(), '1 of 3');
    assert.equal(p.el('ai-run-status').textContent, '');
    await p.ctx.AIRun.execute();
    assert.deepEqual(p.sentIds(), ['t3']);
});

test('picking another prompt drops the report account', () => {
    const p = page('a1');
    p.ctx.AIRun.setFilters({ accountFilter: 'a2' });
    p.ctx._DenAriiPrompts = { getPromptById: id => ({ id, promptText: 'Next' }), getAllPrompts: () => [] };
    p.ctx.AIRun.selectPrompt('x');
    assert.equal(p.el('ai-run-trade-count-account').textContent, '');
    assert.equal(p.count(), '2 of 3');
});

test('a report on an account hidden since still runs on it, and the count stays sensible', async () => {
    const p = page('a1');
    p.ctx.AIRun.setFilters({ accountFilter: 'hid' });
    assert.equal(p.count(), '1 of 4');
    await p.ctx.AIRun.execute();
    assert.deepEqual(p.sentIds(), ['t4']);
});

// ── Leftovers ────────────────────────────────────────────────────────────────

test('Strategies P&L: sign before the dollar sign, with commas', () => {
    const m = /const fmtMoney = [\s\S]*?maximumFractionDigits: 2 \}\);/.exec(read('Denarii.js'));
    const fmtMoney = new Function(m[0] + '\nreturn fmtMoney;')();
    assert.equal(fmtMoney(-1627.32), '-$1,627.32');
    assert.equal(fmtMoney(53130.7), '$53,130.70');
    assert.equal(fmtMoney(0), '$0.00');
    assert.equal(fmtMoney(-0.001), '$0.00');
});

test('error toast text is at least 4.5:1 on every theme danger color', () => {
    const lum = hex => {
        const c = [1, 3, 5].map(i => parseInt(hex.substr(i, 2), 16) / 255)
            .map(v => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
        return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    };
    const contrast = (a, b) => {
        const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
        return (x + 0.05) / (y + 0.05);
    };
    const CSS = read('Denarii.css');
    const vars = CSS.slice(0, CSS.indexOf('body { font-family'));
    const pairs = [...vars.matchAll(/--danger:\s*(#\w{6});[\s\S]*?--on-danger:\s*(#\w{6});/g)];
    assert.equal(pairs.length, 7);
    for (const [, bg, fg] of pairs) assert.ok(contrast(bg, fg) >= 4.5, bg);
    for (const f of ['js/ai-run.js', 'js/ai-library.js']) assert.ok(read(f).includes("isError ? 'var(--on-danger)' : ''"), f);
});

test('Setup labels read Strategy; ids stay', () => {
    const REVIEWS = read('js/pages/reviews.js');
    const TRENDS = read('js/pages/perf-trends.js');
    const SNAP = read('js/pages/snapshot.js');
    const HTML = read('index.html');
    assert.ok(!REVIEWS.includes('<th>Setup</th>'));
    assert.ok(!TRENDS.includes('Top Setups Over Time') && TRENDS.includes("wid:'top-setups-trend'"));
    assert.ok(!SNAP.includes('No setup data.') && SNAP.includes('P&L breakdown by strategy') && SNAP.includes("wid: 'top-setups',"));
    for (const f of [REVIEWS, TRENDS, SNAP, read('js/pages/setups.js'), HTML]) assert.ok(!f.includes('No Setup"') && !f.includes("'No Setup'"));
    assert.ok(HTML.includes('data-tab="setups"'));
});

test('dead code is gone; the broker color used by the modal stays', () => {
    assert.ok(!/\blet selectedBrokerColor\b/.test(read('Denarii.js')));
    assert.ok(BROKER.includes('window.selectedBrokerColor'));
    const HELPERS = read('js/pages/analytics-helpers.js');
    for (const name of ['analyzeBehavioralFlaws', 'analyzeDaily']) assert.ok(!HELPERS.includes(name), name);
    for (const name of ['analyzeHoldTime', 'analyzePositionSize', 'analyzeTickers', 'analyzeTimePatterns']) {
        assert.ok(HELPERS.includes('window.' + name), name);
    }
});

test('index.html serves the files changed in this batch at new versions', () => {
    const HTML = read('index.html');
    const min = {
        'Denarii.css': 27, 'Denarii.js': 61, 'js/ai-library.js': 4, 'js/ai-run.js': 8, 'js/ai-reports.js': 8,
        'js/pages/snapshot.js': 11, 'js/pages/perf-trends.js': 9, 'js/pages/setups.js': 7,
        'js/pages/analytics-helpers.js': 2, 'js/pages/broker-accounts.js': 16, 'js/pages/reviews.js': 5,
    };
    for (const [file, v] of Object.entries(min)) {
        assert.ok(Number((HTML.split(file + '?v=')[1] || '0"').split('"')[0]) >= v, file);
    }
});

// ── Page renames ─────────────────────────────────────────────────────────────

test('sidebar, tooltips, banners and quick nav use the new page names; tab keys stay', () => {
    const HTML = read('index.html');
    assert.match(HTML, /data-tab="setups" data-parent-group="analytics" title="Strategy">[\s\S]*?<span>Strategy<\/span>/);
    assert.match(HTML, /data-tab="strategies" data-parent-group="strategy" title="Strategy Management">[\s\S]*?<span>Strategy Management<\/span>/);
    const APP = read('Denarii.js');
    assert.match(APP, /'setups': \{\s*title: 'Strategy',/);
    assert.match(APP, /strategies: \{\s*title: 'Strategy Management',/);
    const NAV = read('js/nav.js');
    assert.match(NAV, /label: 'Strategy',\s+icon: '[^']+',\s+tab: 'setups'/);
    assert.match(NAV, /label: 'Strategy Management',\s*icon: '[^']+',\s+tab: 'strategies'/);
    assert.ok(!HTML.includes('Strategy / Setup'));
});

test('widget names and help text say Strategy; widget ids and saved layout keys stay', () => {
    const SU = read('js/pages/setups.js');
    const PT = read('js/pages/perf-trends.js');
    const RV = read('js/pages/reviews.js');
    const labels = /\b(?:name|desc|cat|title|what|why|how|watch|label|tooltip):\s*'((?:[^'\\]|\\.)*)'|(?:widgetHtml\(id, |_mc\(|setupCard\(|emptyState\()'([^']*)'/g;
    for (const [file, src] of [['setups', SU], ['perf-trends', PT], ['reviews', RV]]) {
        for (const m of src.matchAll(labels)) assert.doesNotMatch(m[1] || m[2], /setup/i, file);
    }
    for (const s of ["name:'Strategy Leaderboard'", "name:'Best Strategy'", "name:'Net P&L by Strategy'", "'Your best strategy ('", '>Strategy</th>']) assert.ok(SU.includes(s), s);
    for (const s of ["wid:'setup-leaderboard'", "wid:'best-setup'", "wid:'net-pnl-by-setup'", 'journalData.setupsLayout', 't.setupType', '_state.hideNoSetup']) assert.ok(SU.includes(s), s);
    assert.ok(PT.includes("name:'Strategy Contribution'") && PT.includes("cat:'Strategy Mix'"));
    assert.ok(PT.includes("name:'Top Strategies Over Time', desc:'Strategy P&L contribution over time'"));
    assert.ok(PT.includes("wid:'setup-contrib'") && PT.includes("wid:'top-setups-trend'"));
    assert.ok(RV.includes("id:'best-setup',   label:'Best Strategy'") && RV.includes("id:'worst-setup',  label:'Worst Strategy'"));
});

// ── Saved report filters ─────────────────────────────────────────────────────

test('a report with no date range sets Period to All and clears From and To', () => {
    const p = page('a1');
    p.el('ai-run-period').value = 'custom';
    p.el('ai-run-from').value = '2026-01-01';
    p.el('ai-run-to').value = '2026-01-31';
    p.ctx.AIRun.setFilters({ accountFilter: 'a1' });
    assert.equal(p.el('ai-run-period').value, 'all');
    assert.equal(p.el('ai-run-from').value, '');
    assert.equal(p.el('ai-run-to').value, '');
    p.el('ai-run-period').value = 'custom';
    p.el('ai-run-from').value = '2026-01-01';
    p.ctx.AIRun.setFilters({ dateRange: { start: null, end: null } });
    assert.equal(p.el('ai-run-period').value, 'all');
    assert.equal(p.el('ai-run-from').value, '');
});

test('a saved date range still loads', () => {
    const p = page('a1');
    p.ctx.AIRun.setFilters({ dateRange: { start: '2026-03-01', end: '2026-03-31' } });
    assert.equal(p.el('ai-run-from').value, '2026-03-01');
    assert.equal(p.el('ai-run-to').value, '2026-03-31');
});

test('Symbol is saved with a new report and restored on reuse; a report without one is blank', async () => {
    const p = page('a1');
    p.el('ai-run-symbol').value = 'zzz';
    await p.ctx.AIRun.execute();
    assert.equal(p.sent.length, 0);
    p.el('ai-run-symbol').value = 'aapl';
    await p.ctx.AIRun.execute();
    assert.deepEqual(p.sentIds(), ['t1 t2']);
    await p.ctx.AIRun.saveOutput();
    const saved = p.ctx.journalData.aiOutputHistory[0].filters;
    assert.equal(saved.symbol, 'aapl');
    p.el('ai-run-symbol').value = '';
    p.ctx.AIRun.setFilters(saved);
    assert.equal(p.el('ai-run-symbol').value, 'aapl');
    p.ctx.AIRun.setFilters({ accountFilter: 'a2' });
    assert.equal(p.el('ai-run-symbol').value, '');
    assert.equal(p.count(), '1 of 3');
});

test('saving keeps the filters the report ran with, not what the bar shows now', async () => {
    const p = page('a1');
    p.el('ai-run-symbol').value = 'AAPL';
    p.el('ai-run-period').value = 'custom';
    p.el('ai-run-from').value = '2026-03-01';
    p.el('ai-run-to').value = '2026-03-31';
    await p.ctx.AIRun.execute();
    p.el('ai-run-symbol').value = 'MSFT';
    p.el('ai-run-from').value = '2020-01-01';
    p.ctx.filterBrokerAccountId = 'a2';
    await p.ctx.AIRun.saveOutput();
    const saved = p.ctx.journalData.aiOutputHistory[0].filters;
    assert.equal(saved.symbol, 'AAPL');
    assert.equal(saved.dateRange.start, '2026-03-01');
    assert.equal(saved.accountFilter, 'a1');
    assert.equal(saved.tradeCount, 2);
});

test('the symbol goes in the Gemini request for Active Filters', async () => {
    const p = page('a1');
    p.el('ai-run-symbol').value = 'AAPL';
    await p.ctx.AIRun.execute();
    assert.equal(p.sent[0].symbol, 'AAPL');
    assert.equal(p.sent[0].symbolFilter, undefined);
});

// ── Text on red ──────────────────────────────────────────────────────────────

test('listed red elements use --on-danger, with no white text left on them', () => {
    const CSS = read('Denarii.css');
    for (const sel of ['.account-item-delete:hover', '.se-rule-mandatory-badge', '.se-pv-tag-mandatory']) {
        const start = CSS.indexOf(sel + ' {');
        assert.ok(start >= 0, sel);
        assert.match(CSS.slice(start, CSS.indexOf('}', start)), /color: var\(--on-danger\)/, sel);
    }
    for (const f of ['Denarii.js', 'js/pages/journal.js']) {
        assert.doesNotMatch(read(f), /background:\s*var\(--danger\);\s*color:\s*(#fff|white)/i, f);
    }
    assert.equal(read('Denarii.js').split('background:var(--danger);color:var(--on-danger);').length - 1, 2);
    assert.ok(read('js/pages/journal.js').includes('background:var(--danger);color:var(--on-danger);'));
    assert.ok(read('js/pages/journal.js').includes('background:var(--danger); color:var(--on-danger);'));
});
