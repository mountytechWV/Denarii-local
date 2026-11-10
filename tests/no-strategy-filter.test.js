// The No Strategy filter option, cloud and local, and Strategy Management
// counts staying current.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const AUTH = read('js/auth.js');
const APP = read('Denarii.js');
const HTML = read('index.html');
const AIRUN = read('js/ai-run.js');
const AIREPORTS = read('js/ai-reports.js');

const win = {};
new Function('window', read('js/shared/filter-bar.js'))(win);
const F = win.DenariiFilters;
const NO = F.NO_STRATEGY;

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

const TRADES = [
    { id: 'a', setupType: 'Breakout' }, { id: 'b', setupType: '' }, { id: 'c', setupType: null },
    { id: 'd' }, { id: 'e', setupType: '   ' }, { id: 'f', setupType: ' Breakout' },
];

test('filterTrades: No Strategy matches empty, null, missing and only spaces', () => {
    assert.deepEqual(F.filterTrades(TRADES, { strategy: NO }).map(t => t.id), ['b', 'c', 'd', 'e']);
    assert.deepEqual(F.filterTrades(TRADES, { strategy: 'Breakout' }).map(t => t.id), ['a'], 'names still match exactly');
    assert.equal(F.filterTrades(TRADES, { strategy: 'all' }).length, TRADES.length);
});

test('populateStrategy: No Strategy comes right after All and survives a repopulate', () => {
    const sel = { value: NO, innerHTML: '' };
    Object.defineProperty(sel, 'innerHTML', { set(v) { this.html = v; }, get() { return this.html; } });
    F.populateStrategy(sel, TRADES, [{ name: 'Alpha' }]);
    assert.match(sel.html, new RegExp('^<option value="all">All Strategies</option><option value="' + NO + '">No Strategy</option><option value="Alpha">'));
    assert.equal(sel.value, NO);
});

test('the reserved value is never listed as a strategy, and the editor refuses it', () => {
    assert.deepEqual(F.strategyOptions([{ setupType: NO }], [{ name: NO }]), []);
    assert.equal(F.strategyLabel(NO), 'No Strategy');
    assert.equal(F.strategyLabel('Breakout'), 'Breakout');
    assert.match(APP, /normName === DenariiFilters\.NO_STRATEGY/);
});

test('the bar markup offers No Strategy before its first populate', () => {
    assert.match(extractFunction(read('js/shared/filter-bar.js'), 'barHtml'), /No Strategy/);
});

test('New Trade and trade edit dropdowns do not offer it', () => {
    assert.equal(/NO_STRATEGY|No Strategy/.test(extractFunction(APP, 'updateStrategyDropdown')), false);
    const journal = read('js/pages/journal.js');
    const start = journal.indexOf("getElementById('jnl-setup-type')");
    assert.equal(/NO_STRATEGY|No Strategy/.test(journal.slice(start, start + 800)), false);
});

// ── Cloud ───────────────────────────────────────────────────────────────────

function applyCloud(strategy) {
    const calls = [];
    const q = { or(s) { calls.push(['or', s]); return q; }, eq(c, v) { calls.push(['eq', c, v]); return q; } };
    new Function('DenariiFilters', extractFunction(AUTH, '_applyCloudStrategy') + '; return _applyCloudStrategy;')(F)(q, strategy);
    return calls;
}

// How Postgres would evaluate the filter sent for No Strategy.
const cloudMatches = v => v === null || /^[ \t\r\n\f\v]*$/.test(v);

test('cloud: No Strategy uses null or blank, a name stays exact, All adds nothing', () => {
    assert.deepEqual(applyCloud(NO), [['or', 'setup_type.is.null,setup_type.match."^[[:space:]]*$"']]);
    assert.deepEqual(applyCloud('Breakout'), [['eq', 'setup_type', 'Breakout']]);
    assert.deepEqual(applyCloud('all'), []);
    assert.deepEqual(applyCloud(undefined), []);
});

test('cloud and local pick the same rows', () => {
    const local = F.filterTrades(TRADES, { strategy: NO }).map(t => t.id);
    const cloud = TRADES.filter(t => cloudMatches(t.setupType === undefined ? null : t.setupType)).map(t => t.id);
    assert.deepEqual(cloud, local);
});

test('the Dashboard page and metrics queries both use it', () => {
    for (const fn of ['_fetchCloudDashPage', '_fetchCloudDashMetrics']) {
        assert.match(extractFunction(AUTH, fn), /_applyCloudStrategy\(query, filters\.strategy\)/);
    }
});

// ── Run Analysis and Saved Reports ──────────────────────────────────────────

test('AI payload: filters to blank trades and Active Filters says No Strategy', () => {
    const g = {};
    new Function('window', read('js/services/ai/formatter.js').replace(/\}\)\((.*)\);\s*$/, '})(window);'))(g);
    const trade = over => Object.assign({ symbol: 'A', pnl: 1, entryTime: '2026-01-01T10:00:00Z', exitTime: '2026-01-01T11:00:00Z' }, over);
    const p = g._DenAriiAIFormatter.buildPayload({ strategyFilter: NO, tradeData: [trade({ setupType: 'X' }), trade({ setupType: ' ' }), trade({})] });
    assert.equal(p.trades.length, 2);
    assert.equal(p.filters.strategy, 'No Strategy');
    const none = g._DenAriiAIFormatter.buildPayload({ tradeData: [trade({ setupType: 'X' })] });
    assert.equal(none.trades.length, 1);
    assert.equal(none.filters.strategy, undefined);
    assert.match(read('js/services/ai/formatter.js'), new RegExp("NO_STRATEGY = '" + NO + "'"));
});

test('reports save the reserved value, restore it, and show its label', () => {
    assert.match(AIRUN, /strategyFilter: state\.strategy\s+!== 'all' \? state\.strategy/);
    assert.match(AIRUN, /_setBarValue\('strategy',\s+f\.strategyFilter \|\| 'all'\)/);
    assert.match(AIRUN, /'Strategy: ' \+ _esc\(DenariiFilters\.strategyLabel\(m\.strategy\)\)/);
    assert.match(AIREPORTS, /parts\.push\(DenariiFilters\.strategyLabel\(filters\.strategyFilter\)\)/);
});

// ── Strategy Management counts ──────────────────────────────────────────────

test('counts redraw when the page opens and after a save while it is showing', () => {
    assert.match(extractFunction(APP, 'activateSection'), /sectionId === 'strategies'\) updateStrategiesList\(\)/);
    assert.match(extractFunction(AUTH, 'saveToIndexedDB'), /_refreshStrategiesIfVisible\(\)/);
    const run = active => {
        let drawn = 0;
        const panel = { classList: { contains: c => c === 'active' && active } };
        new Function('document', 'updateStrategiesList', extractFunction(APP, '_refreshStrategiesIfVisible') + '; _refreshStrategiesIfVisible();')(
            { getElementById: id => (id === 'strategies' ? panel : null) }, () => { drawn++; });
        return drawn;
    };
    assert.equal(run(true), 1);
    assert.equal(run(false), 0);
});

test('index.html: versions bumped for this change', () => {
    const ver = file => Number((HTML.split('src="' + file + '?v=')[1] || '0"').split('"')[0]);
    assert.ok(ver('Denarii.js') >= 66);
    assert.ok(ver('js/auth.js') >= 45);
    assert.ok(ver('js/shared/filter-bar.js') >= 6);
    assert.ok(ver('js/ai-run.js') >= 11);
    assert.ok(ver('js/ai-reports.js') >= 9);
    assert.ok(ver('js/services/ai/formatter.js') >= 3);
});
