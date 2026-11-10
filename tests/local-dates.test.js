// Local-day dates: a trade belongs to the local calendar day of its time, weeks
// run Sunday-Saturday, and the cloud queries return what the local filter returns.
// Same harness as filter-baseline.test.js: real functions are cut out of the
// browser scripts. Fixtures are built from local parts so they sit on the same
// local edges in every zone.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const AUTH = read('js/auth.js');

const win = {};
new Function('window', 'document', read('js/shared/filter-bar.js'))(win, {});
const F = win.DenariiFilters;

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

// offset is minutes behind UTC on 2026-03-18, to prove the zone really applied.
const ZONES = [
    { tz: 'America/New_York', offset: 240 },
    { tz: 'America/Los_Angeles', offset: 420 },
    { tz: 'Asia/Tokyo', offset: -540 },
];
const HAVANA = { tz: 'America/Havana', offset: 240 }; // clocks change at midnight

function useZone(z) {
    process.env.TZ = z.tz;
    assert.equal(new Date(Date.UTC(2026, 2, 18)).getTimezoneOffset(), z.offset, 'TZ not applied: ' + z.tz);
}

const at = (mo, d, h = 0, mi = 0, s = 0, ms = 0, y = 2026) => new Date(y, mo - 1, d, h, mi, s, ms).toISOString();

// ── Helpers ─────────────────────────────────────────────────────────────────

for (const z of ZONES) {
    test('parseTradeDate: date-only is that local day, stored times keep their instant, bad values are null, ' + z.tz, () => {
        useZone(z);
        const d = F.parseTradeDate('2026-03-01');
        assert.deepEqual([d.getFullYear(), d.getMonth(), d.getDate(), d.getHours()], [2026, 2, 1, 0]);
        assert.equal(F.parseTradeDate('2026-03-18T01:00:00.000Z').getTime(), Date.UTC(2026, 2, 18, 1));
        for (const bad of ['', null, undefined, 'not a date', '2026-02-31', '2026-13-01']) {
            assert.equal(F.parseTradeDate(bad), null, String(bad));
        }
    });

    test('Evening trades stay on their local day, ' + z.tz, () => {
        useZone(z);
        assert.equal(F.localDayKey(at(3, 17, 21)), '2026-03-17');
        assert.equal(F.localDayKey(at(3, 17, 23, 59, 59, 999)), '2026-03-17');
        assert.equal(F.localDayKey(at(3, 18)), '2026-03-18');
        assert.equal(F.localDayKey('garbage'), '');
    });

    test('Weeks run Sunday-Saturday and evening trades do not split them, ' + z.tz, () => {
        useZone(z);
        assert.equal(F.localWeekKey('2026-03-14'), '2026-03-08'); // Saturday
        assert.equal(F.localWeekKey('2026-03-15'), '2026-03-15'); // Sunday
        assert.equal(F.localWeekKey('2026-03-16'), '2026-03-15'); // Monday
        assert.equal(F.localWeekKey('2026-03-21'), '2026-03-15'); // Saturday
        assert.equal(F.localWeekKey('2026-03-22'), '2026-03-22'); // Sunday
        assert.equal(F.localWeekKey(at(3, 16, 9)), '2026-03-15');
        assert.equal(F.localWeekKey(at(3, 16, 21)), '2026-03-15');
        assert.equal(F.localWeekKey(''), '');
    });

    test('localWeekKey agrees with the filter bar week, across a year and clock changes, ' + z.tz, () => {
        useZone(z);
        for (const [y, mo, d] of [[2027, 0, 1], [2026, 11, 30], [2026, 2, 10], [2026, 10, 4]]) {
            const now = new Date(y, mo, d, 12);
            assert.equal(F.localWeekKey(now.toISOString()), F.periodRange('week', '', '', now).from);
        }
        assert.equal(F.localWeekKey('2027-01-01'), '2026-12-27');
    });

    test('Month edges stay in their local month, ' + z.tz, () => {
        useZone(z);
        assert.equal(F.localDayKey(at(2, 28, 21)), '2026-02-28');
        assert.equal(F.localDayKey(at(3, 1)), '2026-03-01');
        assert.equal(F.parseTradeDate('2026-03-01').getMonth(), 2);
        assert.equal(F.localDayKey(at(12, 31, 23, 59, 59, 999, 2025)), '2025-12-31');
    });

    test('filterTrades reads date-only and stored times by the same local day, ' + z.tz, () => {
        useZone(z);
        const now = new Date(2026, 2, 17, 12);
        const trades = [
            { id: 'dateonly', exitTime: '2026-03-17' },
            { id: 'evening', exitTime: at(3, 17, 21) },
            { id: 'next', exitTime: at(3, 18) },
            { id: 'bad', exitTime: 'nope' },
            { id: 'none' },
        ];
        const ids = period => F.filterTrades(trades, { period }, [], now).map(t => t.id);
        assert.deepEqual(ids('today'), ['dateonly', 'evening']);
        assert.deepEqual(ids('all'), ['dateonly', 'evening', 'next', 'bad', 'none']);
    });
}

test('Malformed days give no boundary', () => {
    for (const bad of ['', null, 'nope', '2026-02-31', '2026-03-18T01:00:00.000Z']) {
        assert.equal(F.localDayStartUtc(bad), null, String(bad));
        assert.equal(F.nextLocalDayStartUtc(bad), null, String(bad));
    }
});

// ── Clock changes ───────────────────────────────────────────────────────────

const CLOCK_DAYS = [
    // Spring day is 23 hours, autumn day is 25, where the zone has them.
    { z: ZONES[0], day: '2026-03-08', start: '2026-03-08T05:00:00.000Z', next: '2026-03-09T04:00:00.000Z' },
    { z: ZONES[0], day: '2026-11-01', start: '2026-11-01T04:00:00.000Z', next: '2026-11-02T05:00:00.000Z' },
    { z: ZONES[1], day: '2026-03-08', start: '2026-03-08T08:00:00.000Z', next: '2026-03-09T07:00:00.000Z' },
    { z: ZONES[1], day: '2026-11-01', start: '2026-11-01T07:00:00.000Z', next: '2026-11-02T08:00:00.000Z' },
    { z: ZONES[2], day: '2026-03-08', start: '2026-03-07T15:00:00.000Z', next: '2026-03-08T15:00:00.000Z' },
    { z: ZONES[2], day: '2026-11-01', start: '2026-10-31T15:00:00.000Z', next: '2026-11-01T15:00:00.000Z' },
    // Havana skips 00:00-01:00 on Mar 8, so that day starts at 01:00 local.
    // On Nov 1 it repeats 00:00-01:00, so the day starts at the first 00:00.
    { z: HAVANA, day: '2026-03-08', start: '2026-03-08T05:00:00.000Z', next: '2026-03-09T04:00:00.000Z' },
    { z: HAVANA, day: '2026-11-01', start: '2026-11-01T04:00:00.000Z', next: '2026-11-02T05:00:00.000Z' },
];

for (const c of CLOCK_DAYS) {
    test('Day boundaries on ' + c.day + ', ' + c.z.tz, () => {
        useZone(c.z);
        assert.equal(F.localDayStartUtc(c.day), c.start);
        assert.equal(F.nextLocalDayStartUtc(c.day), c.next);
        // The day runs right up to its boundaries, and no further.
        assert.equal(F.localDayKey(c.start), c.day);
        assert.equal(F.localDayKey(new Date(Date.parse(c.next) - 1).toISOString()), c.day);
        assert.notEqual(F.localDayKey(c.next), c.day);
        assert.notEqual(F.localDayKey(new Date(Date.parse(c.start) - 1).toISOString()), c.day);
    });
}

test('A late trade on the 25-hour day stays on that day', () => {
    useZone(ZONES[0]);
    assert.equal(F.localDayKey('2026-11-02T04:30:00.000Z'), '2026-11-01'); // 23:30 EST
    assert.equal(F.localDayKey('2026-11-02T05:00:00.000Z'), '2026-11-02');
});

// ── Cloud and local return the same trades ──────────────────────────────────

// Reads each .or() the way PostgREST would, comparing as text like the TEXT
// columns do. A filter in any other shape fails here rather than matching nothing.
const OR_SHAPE = /^exit_time\.(gte|lt)\."([^"]+)",and\(exit_time\.is\.null,entry_time\.(gte|lt)\."([^"]+)"\)$/;
const passes = (v, op, bound) => v != null && (op === 'gte' ? v >= bound : v < bound);

function fakeClient(rows) {
    const groups = [];
    let window = null;
    const q = new Proxy({}, {
        get(t, k) {
            if (k === 'then') {
                return res => {
                    const out = rows.filter(r => groups.every(g =>
                        passes(r.exit_time, g[1], g[2]) || (r.exit_time == null && passes(r.entry_time, g[3], g[4]))));
                    res({ data: window ? out.slice(window[0], window[1] + 1) : out, count: out.length, error: null });
                };
            }
            return (...args) => {
                if (k === 'or') {
                    const g = OR_SHAPE.exec(args[0]);
                    if (!g) throw new Error('Unexpected .or(): ' + args[0]);
                    groups.push(g);
                }
                if (k === 'range') window = args;
                return q;
            };
        },
    });
    return { from: () => q };
}

function cloudFns() {
    const names = ['_fetchCloudDashPage', '_fetchCloudDashMetrics', '_applyCloudDateRange', '_applyCloudStrategy'];
    const code = names.map(n => extractFunction(AUTH, n)).join('\n');
    return new Function('DenariiFilters', '_CLOUD_DASH_SORT_MAP', '_mapSupabaseTradeRow', 'console',
        code + '\nreturn {' + names.join(',') + '};')(F, {}, r => r, { log() {}, error() {} });
}

// Every trade sits on an edge. Each P&L is a distinct power of two, so a total
// can only match when exactly the same trades are counted.
function fixtures() {
    const list = [
        ['dec31-last',     at(12, 31, 23, 59, 59, 999, 2025)],
        ['jan1-midnight',  at(1, 1)],
        ['feb28-last',     at(2, 28, 23, 59, 59, 999)],
        ['mar1-midnight',  at(3, 1)],
        ['mar7-last',      at(3, 7, 23, 59, 59, 999)],
        ['mar8-first',     at(3, 8, 3)],
        ['mar9-last',      at(3, 9, 23, 59, 59, 999)],
        ['mar10-midnight', at(3, 10)],
        ['sat-last',       at(3, 14, 23, 59, 59, 999)],
        ['sun-midnight',   at(3, 15)],
        ['today-midnight', at(3, 17)],
        ['today-evening',  at(3, 17, 21)],
        ['today-last-sec', at(3, 17, 23, 59, 59, 500)],
        ['tomorrow',       at(3, 18)],
        ['sat-end',        at(3, 21, 23, 59, 59, 999)],
        ['next-sun',       at(3, 22)],
        ['mar31-last',     at(3, 31, 23, 59, 59, 999)],
        ['apr1-midnight',  at(4, 1)],
    ].map(([id, exit], i) => ({ id, exitTime: exit, entryTime: at(1, 1, 0, 0, 0, 0, 2020), pnl: 2 ** i }));
    // Open trades count by their entry time, and only a closed trade adds to P&L.
    list.push({ id: 'open-today', exitTime: null, entryTime: at(3, 17, 21, 30), pnl: 0 });
    list.push({ id: 'open-midnight', exitTime: null, entryTime: at(3, 18), pnl: 0 });
    list.push({ id: 'no-times', exitTime: null, entryTime: null, pnl: 0 });
    return list;
}

const toRow = t => ({ id: t.id, exit_time: t.exitTime, entry_time: t.entryTime, pnl: t.pnl });

const CASES = [
    { name: 'All', state: { period: 'all' } },
    { name: 'Today', state: { period: 'today' } },
    { name: 'Week', state: { period: 'week' } },
    { name: 'Month', state: { period: 'month' } },
    { name: 'YTD', state: { period: 'ytd' } },
    { name: 'Custom over a clock change', state: { period: 'custom', from: '2026-03-08', to: '2026-03-09' } },
    { name: 'Custom, From only', state: { period: 'custom', from: '2026-03-17', to: '' } },
    { name: 'Custom, To only', state: { period: 'custom', from: '', to: '2026-03-17' } },
];

for (const z of [...ZONES, HAVANA]) {
    for (const c of CASES) {
        test('Cloud and local match: ' + c.name + ', ' + z.tz, async () => {
            useZone(z);
            const now = new Date(2026, 2, 17, 12);
            const trades = fixtures();
            const rows = trades.map(toRow);
            const local = F.filterTrades(trades, c.state, [], now);
            const range = F.periodRange(c.state.period, c.state.from, c.state.to, now) || {};
            const filters = { brokerAccountId: 'all', dateFrom: range.from || undefined, dateTo: range.to || undefined };
            const fns = cloudFns();

            const page = await fns._fetchCloudDashPage(fakeClient(rows), 'u1', filters, { field: 'exitTime', dir: 'desc' }, 1, 1000);
            assert.equal(page.error, null);
            assert.deepEqual(page.rows.map(r => r.id).sort(), local.map(t => t.id).sort());
            assert.equal(page.totalCount, local.length);

            const metrics = await fns._fetchCloudDashMetrics(fakeClient(rows), 'u1', filters);
            const closed = local.filter(t => t.exitTime);
            assert.equal(metrics.totalTrades, local.length);
            assert.equal(metrics.closedTrades, closed.length);
            assert.equal(metrics.totalPnl, closed.reduce((s, t) => s + t.pnl, 0));
        });
    }
}

// Guards the comparison above: both sides could agree on the wrong trades.
for (const z of ZONES) {
    test('Today and Week hold exactly the expected edge trades, ' + z.tz, () => {
        useZone(z);
        const now = new Date(2026, 2, 17, 12);
        const ids = period => F.filterTrades(fixtures(), { period }, [], now).map(t => t.id);
        assert.deepEqual(ids('today'), ['today-midnight', 'today-evening', 'today-last-sec', 'open-today']);
        assert.deepEqual(ids('week'), ['sun-midnight', 'today-midnight', 'today-evening', 'today-last-sec',
            'tomorrow', 'sat-end', 'open-today', 'open-midnight']);
    });
}

test('An unusable date adds no cloud bound', async () => {
    const calls = [];
    const q = { or: s => { calls.push(s); return q; } };
    cloudFns()._applyCloudDateRange(q, { dateFrom: null, dateTo: undefined });
    assert.deepEqual(calls, []);
});

// ── Pages: real page code, each trade on its local day ─────────────────────

function pageFns(file, names, vals) {
    const src = read('js/pages/' + file + '.js');
    const scope = Object.assign({ DenariiFilters: F }, vals);
    const keys = Object.keys(scope);
    const code = names.map(n => extractFunction(src, n)).join('\n');
    return new Function(...keys, code + '\nreturn {' + names.join(',') + '};')(...keys.map(k => scope[k]));
}

// Runs one chart's own block from the Performance Trends render, as written,
// and returns what it would have plotted.
function runTrendChart(wid, trades, gb) {
    const src = read('js/pages/perf-trends.js');
    const marker = "if (wid === '" + wid + "') {";
    const start = src.indexOf(marker);
    assert.ok(start >= 0, wid + ' block not found');
    let depth = 0, end = -1;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i; break; }
    }
    const { getDateStr, getPeriodKey } = trendFns();
    let plotted = null;
    new Function('wid', 'trades', 'gb', 'getDateStr', 'getPeriodKey', 'pnlOf', 'mkBase', 'mkAx', 'GREEN', 'RED', 'tc', 'el', 'tryPlot',
        src.slice(start, end + 1))(wid, trades, gb, getDateStr, getPeriodKey, t => parseFloat(t.pnl) || 0, () => ({}), o => o || {},
        'g', 'r', 't', {}, (el, data) => { plotted = data; });
    return plotted;
}

const trendFns = () => pageFns('perf-trends', ['getPeriodKey', 'getDateStr', 'buildPeriodMap'], {});
const trade = (exitTime, pnl, extra) => Object.assign({ exitTime, pnl, symbol: 'AAPL', quantity: 1 }, extra);

for (const z of ZONES) {
    test('Snapshot: an evening trade counts on its local day in daily bars, equity curve, Best and Worst Day, ' + z.tz, () => {
        useZone(z);
        const { calcSnap } = pageFns('snapshot', ['calcSnap'], {});
        const m = calcSnap([trade(at(3, 17, 9), 100), trade(at(3, 17, 21), 50), trade(at(3, 18, 9), -30)]);
        assert.deepEqual(m.dailyMap, { '2026-03-17': 150, '2026-03-18': -30 });
        assert.deepEqual(m.cumPnl.map(p => p.date), ['2026-03-17', '2026-03-17', '2026-03-18']);
        assert.deepEqual([m.bestDayStr, m.bestDayPnl, m.worstDayStr, m.worstDayPnl], ['2026-03-17', 150, '2026-03-18', -30]);
    });

    test('Snapshot: a trade with no times adds to totals but is not charted as a 1970 day, ' + z.tz, () => {
        useZone(z);
        const { calcSnap } = pageFns('snapshot', ['calcSnap'], {});
        const m = calcSnap([trade(at(3, 17, 9), 100), { pnl: 5, symbol: 'X' }]);
        assert.equal(m.totalPnl, 105);
        assert.deepEqual(Object.keys(m.dailyMap), ['2026-03-17']);
    });

    test('Performance Trends: period keys use local days and Sunday weeks, ' + z.tz, () => {
        useZone(z);
        const { getPeriodKey, getDateStr } = trendFns();
        assert.equal(getDateStr(at(3, 17, 21)), '2026-03-17');
        assert.equal(getPeriodKey(at(3, 17, 21), 'day'), '2026-03-17');
        assert.equal(getPeriodKey(at(3, 16, 9), 'week'), '2026-03-15');
        assert.equal(getPeriodKey(at(3, 16, 21), 'week'), '2026-03-15');
        assert.equal(getPeriodKey(at(3, 15), 'week'), '2026-03-15');
        assert.equal(getPeriodKey(at(3, 14, 23, 59), 'week'), '2026-03-08');
        assert.equal(getPeriodKey(at(3, 31, 23, 59), 'month'), '2026-03');
        assert.equal(getPeriodKey(at(3, 31, 23, 59), 'quarter'), '2026-Q1');
        assert.equal(getPeriodKey(at(12, 31, 23, 59, 0, 0, 2025), 'year'), '2025');
        assert.equal(getPeriodKey('2026-03-01', 'month'), '2026-03');
        assert.equal(getPeriodKey('nope', 'week'), '');
        assert.equal(getPeriodKey('', 'day'), '');
    });

    test('Performance Trends: Weekly P&L keeps one bar per Sunday week, ' + z.tz, () => {
        useZone(z);
        const [bar] = runTrendChart('weekly-pnl', [
            trade(at(3, 14, 12), 1), trade(at(3, 15, 12), 2), trade(at(3, 16, 9), 4), trade(at(3, 16, 21), 8),
        ], 'week');
        assert.deepEqual(bar.x, ['Mar 8', 'Mar 15']);
        assert.deepEqual(bar.y, [1, 14]);
    });

    // The two charts below pass date-only keys to getPeriodKey. Their code is unchanged.
    const edge = () => [trade(at(2, 28, 21), 5), trade(at(3, 1, 9), -10)];

    test('Red Day Rate: days stay in their own month and week, ' + z.tz, () => {
        useZone(z);
        const [month] = runTrendChart('red-day-rate', edge(), 'month');
        assert.deepEqual([month.x, month.y], [['2026-02', '2026-03'], [0, 100]]);
        const [week] = runTrendChart('red-day-rate', edge(), 'week');
        assert.deepEqual([week.x, week.y], [['2026-02-22', '2026-03-01'], [0, 100]]);
        const [day] = runTrendChart('red-day-rate', edge(), 'day');
        assert.deepEqual(day.x, ['2026-02-22', '2026-03-01']);
    });

    test('Green vs Red Days: days stay in their own month and week, ' + z.tz, () => {
        useZone(z);
        const [green, red] = runTrendChart('green-red-days', edge(), 'month');
        assert.deepEqual([green.x, green.y, red.y], [['2026-02', '2026-03'], [1, 0], [0, 1]]);
        const [wkGreen, wkRed] = runTrendChart('green-red-days', edge(), 'week');
        assert.deepEqual([wkGreen.x, wkGreen.y, wkRed.y], [['2026-02-22', '2026-03-01'], [1, 0], [0, 1]]);
    });

    test('Discipline: revenge, overtrading and stop modeling read the local day, ' + z.tz, () => {
        useZone(z);
        const { analyzeDiscipline, computeOptimalStop } = pageFns('discipline', ['analyzeDiscipline', 'computeOptimalStop'], {});
        const b = analyzeDiscipline([trade(at(3, 17, 15), -100), trade(at(3, 17, 21), 50), trade(at(3, 18, 9), 25)]);
        assert.equal(b.revenge.count, 1);
        assert.equal(b.revenge.pnl, 50);
        assert.equal(b.overtrading[0].days, 2);
        assert.equal(b.totalPnl, -25);
        // Two losses on one local day are one -800 day: a 300 stop saves 500.
        const stop = computeOptimalStop([trade(at(3, 17, 15), -400), trade(at(3, 17, 21), -400)]);
        assert.deepEqual([stop.level, stop.saved], [300, 500]);
    });

    test('Risk: daily map and blow-up days read the local day, ' + z.tz, () => {
        useZone(z);
        const { analyzeRisk } = pageFns('risk', ['analyzeRisk'], { BLOWUP_THRESHOLD: -500, OVERSIZE_MULTIPLE: 2 });
        const m = analyzeRisk([trade(at(3, 17, 15), -300), trade(at(3, 17, 21), -300), trade(at(3, 18, 9), 25)]);
        assert.deepEqual(Object.keys(m.dailyMap).sort(), ['2026-03-17', '2026-03-18']);
        assert.equal(m.dailyMap['2026-03-17'].count, 2);
        assert.deepEqual(m.blowupDays.map(d => [d.date, d.pnl]), [['2026-03-17', -600]]);
    });

    test('Setups: date helpers use local days, months and Sunday weeks, ' + z.tz, () => {
        useZone(z);
        const { suGetDateStr, suGetPeriodKey } = pageFns('setups', ['suGetDateStr', 'suGetPeriodKey'], {});
        assert.equal(suGetDateStr(at(3, 17, 21)), '2026-03-17');
        assert.equal(suGetPeriodKey(at(3, 31, 23, 59), 'month'), '2026-03');
        assert.equal(suGetPeriodKey(at(3, 16, 21), 'week'), '2026-03-15');
        assert.equal(suGetPeriodKey(at(3, 17, 21), 'day'), '2026-03-17');
        assert.equal(suGetPeriodKey('nope', 'month'), '');
    });
}

// Same instants in every zone: days move, totals must not.
test('Total P&L, win rate and profit factor do not depend on the time zone', () => {
    const trades = [
        trade('2026-03-18T01:00:00.000Z', 100), trade('2026-03-18T03:30:00.000Z', -50),
        trade('2026-03-15T02:00:00.000Z', 200), trade('2026-03-01T00:30:00.000Z', -150),
    ];
    for (const z of [...ZONES, HAVANA]) {
        useZone(z);
        const { calcSnap } = pageFns('snapshot', ['calcSnap'], {});
        const m = calcSnap(trades);
        assert.deepEqual([m.totalPnl, m.winRate, m.profitFactor], [100, 50, 1.5], z.tz);
        assert.equal(Object.values(m.dailyMap).reduce((s, v) => s + v, 0), 100, z.tz);
    }
});

test('No filter-bar page keys trades by UTC day any more', () => {
    for (const page of ['snapshot', 'perf-trends', 'discipline', 'risk', 'setups']) {
        assert.doesNotMatch(read('js/pages/' + page + '.js'), /toISOString\(\)\.(slice|split|substring)/, page);
    }
});

// ── Calendar, Day View, Week View ───────────────────────────────────────────

// Each closed P&L is distinct so a total shows exactly which trades it holds.
function reviewTrades() {
    return [
        trade(at(2, 28, 23, 59, 59, 999), 16, { id: 'feb-last' }),
        trade(at(3, 1), 8, { id: 'mar1-midnight' }),
        trade(at(3, 14, 12), 1, { id: 'sat' }),
        trade(at(3, 15, 12), 2, { id: 'sun' }),
        trade(at(3, 16, 9), 4, { id: 'mon' }),
        trade(at(3, 17, 9), 100, { id: 'morning' }),
        trade(at(3, 17, 21), 50, { id: 'evening' }),
        { id: 'open', exitTime: null, entryTime: at(3, 17, 21, 30), pnl: 0, symbol: 'AAPL', quantity: 1 },
        trade(at(3, 31, 23, 59, 59, 999), 32, { id: 'mar-last' }),
        trade(at(4, 1), 64, { id: 'apr1-midnight' }),
    ];
}

function reviewScope(trades, extra) {
    return Object.assign({
        journalData: { trades },
        window: { _isOpenTrade: t => !t.exitTime },
        getDashFilteredTrades: list => F.filterTrades(list, { period: 'all' }, [], new Date(2026, 2, 17, 12)),
    }, extra);
}

const sumClosed = list => list.filter(t => t.exitTime).reduce((s, t) => s + t.pnl, 0);

function calendarRender(trades, now) {
    class FrozenDate extends Date {
        constructor(...args) { if (args.length === 0) super(now.getTime()); else super(...args); }
    }
    const els = {
        'cal-grid': { innerHTML: '', querySelectorAll: () => [] },
        'cal-month-label': {}, 'cal-summary-chips': {},
        'cal-tog-pnl': { checked: true }, 'cal-tog-count': { checked: true }, 'cal-tog-wr': { checked: true },
    };
    const names = ['pad', 'fmtPnl', 'fmtPnlShort', 'monthName', 'buildMonthData', 'dayStats', 'render'];
    pageFns('calendar', names, reviewScope(trades, {
        Date: FrozenDate, _year: 2026, _month: 2, _calOpenDate: null,
        document: { getElementById: id => els[id] },
    })).render();
    return { grid: els['cal-grid'].innerHTML, chips: els['cal-summary-chips'].innerHTML };
}

function weekFns(trades, doc) {
    return pageFns('week-view', ['pad', 'fmtPnl', 'fmtPnlShort', 'fmtDateFull', 'fmtDateShort', 'pnlClass',
        'computeMetrics', 'buildChart', 'getWeekSunday', 'getWeekDates', 'getWeekGroups', 'render'],
    reviewScope(trades, {
        _wvPage: 1, _wvPageSize: 15, _wvOpenDate: null,
        DAY_NAMES: ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'],
        MONTH_SHORT: ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'],
        document: doc,
    }));
}

const weekDays = w => Object.keys(w.dayMap).sort();
const weekList = w => Object.keys(w.dayMap).reduce((all, d) => all.concat(w.dayMap[d]), []);

for (const z of ZONES) {
    test('Calendar: an evening trade colors and totals its local day, month matches the Month filter, ' + z.tz, () => {
        useZone(z);
        const trades = reviewTrades();
        const fns = pageFns('calendar', ['pad', 'buildMonthData'], reviewScope(trades));
        const map = fns.buildMonthData(2026, 2);
        assert.deepEqual(Object.keys(map).sort(),
            ['2026-03-01', '2026-03-14', '2026-03-15', '2026-03-16', '2026-03-17', '2026-03-31']);
        assert.deepEqual(map['2026-03-17'].trades.map(t => t.id), ['morning', 'evening', 'open']);
        assert.equal(map['2026-03-17'].pnl, 150);

        const month = F.filterTrades(trades, { period: 'month' }, [], new Date(2026, 2, 17, 12));
        assert.equal(Object.values(map).reduce((s, e) => s + e.pnl, 0), sumClosed(month));
        assert.equal(sumClosed(month), 197);
        assert.deepEqual(Object.keys(fns.buildMonthData(2026, 3)), ['2026-04-01']);
        assert.deepEqual(Object.keys(fns.buildMonthData(2026, 1)), ['2026-02-28']);
    });

    test('Calendar: the rendered cell and Today marker follow the local day, ' + z.tz, () => {
        useZone(z);
        const { grid, chips } = calendarRender(reviewTrades(), new Date(2026, 2, 17, 21));
        const cell = day => (new RegExp('class="([^"]*)" data-date="' + day + '"').exec(grid) || [])[1] || '';
        assert.match(cell('2026-03-17'), /cal-cell-today/);
        assert.match(cell('2026-03-17'), /cal-cell-green/);
        assert.doesNotMatch(cell('2026-03-18'), /cal-cell-today|cal-cell-has-trades/);
        assert.match(chips, /197/);
        assert.match(chips, /Trading Days: 6/);
    });

    test('Calendar: a Monday stays in the week row of the Sunday before it, ' + z.tz, () => {
        useZone(z);
        const { grid } = calendarRender(reviewTrades(), new Date(2026, 2, 17, 12));
        const rows = grid.split('<div class="cal-row">').slice(1);
        const rowOf = day => rows.findIndex(r => r.includes('data-date="' + day + '"'));
        assert.equal(rowOf('2026-03-15'), rowOf('2026-03-16'));
        assert.equal(rowOf('2026-03-14') + 1, rowOf('2026-03-15'));
    });

    test('Day View: an evening trade is on its local day, day totals match a one-day filter, ' + z.tz, () => {
        useZone(z);
        const trades = reviewTrades();
        const { getDayGroups } = pageFns('day-view', ['getDayGroups'], reviewScope(trades));
        const day = getDayGroups().find(g => g.date === '2026-03-17');
        assert.deepEqual(day.trades.map(t => t.id), ['morning', 'evening', 'open']);
        const filtered = F.filterTrades(trades, { period: 'today' }, [], new Date(2026, 2, 17, 12));
        assert.equal(sumClosed(day.trades), sumClosed(filtered));
        assert.equal(getDayGroups().some(g => g.date === '2026-03-18'), false);
    });

    test('Week View: weeks run Sunday-Saturday and match the Week filter, ' + z.tz, () => {
        useZone(z);
        const trades = reviewTrades();
        const groups = weekFns(trades).getWeekGroups();
        assert.deepEqual(groups.map(w => w.sunday),
            ['2026-03-29', '2026-03-15', '2026-03-08', '2026-03-01', '2026-02-22']);
        const wk = groups.find(w => w.sunday === '2026-03-15');
        assert.deepEqual(weekDays(wk), ['2026-03-15', '2026-03-16', '2026-03-17']);
        const filtered = F.filterTrades(trades, { period: 'week' }, [], new Date(2026, 2, 17, 12));
        assert.deepEqual(weekList(wk).map(t => t.id).sort(), filtered.map(t => t.id).sort());
        assert.equal(sumClosed(weekList(wk)), 156);
        assert.deepEqual(weekDays(groups.find(w => w.sunday === '2026-03-08')), ['2026-03-14']);
        assert.equal(F.localWeekKey(at(3, 16, 9)), wk.sunday);
    });

    test('Week View: the card starts on Sunday and shows the evening trade on its day, ' + z.tz, () => {
        useZone(z);
        const container = { innerHTML: '', querySelectorAll: () => [] };
        weekFns(reviewTrades(), { getElementById: () => container }).render();
        const card = container.innerHTML.split('<div class="wv-card ').find(c => c.includes('Mar 15 – Mar 21, 2026'));
        assert.ok(card, 'week card not found');
        assert.deepEqual([...card.matchAll(/wv-day-name">(\w+)</g)].map(m => m[1]),
            ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']);
        assert.deepEqual([...card.matchAll(/data-wv-date="([\d-]+)"/g)].map(m => m[1]),
            ['2026-03-15', '2026-03-16', '2026-03-17']);
        assert.match(card, /data-wv-date="2026-03-17">[\s\S]*?\+\$150[\s\S]*?3t</);
    });

    test('Day drill-down lists the evening trade under its local day, ' + z.tz, () => {
        useZone(z);
        const code = extractFunction(read('Denarii.js'), '_renderDayTradeList');
        const scope = reviewScope(reviewTrades(), {
            DenariiFilters: F, _isOpenTrade: t => !t.exitTime, escapeHtml: s => s, _displaySymbol: s => s,
        });
        const keys = Object.keys(scope);
        const render = new Function(...keys, code + '\nreturn _renderDayTradeList;')(...keys.map(k => scope[k]));
        const html = render('2026-03-17');
        assert.match(html, /3 trades/);
        assert.match(html, />21:00</);
        assert.match(html, /\+\$150\.00 \(1 open\)/);
        assert.equal(render('2026-03-18'), '');
    });

    test('The same evening trade lands on one day in every view, ' + z.tz, () => {
        useZone(z);
        const trades = [trade(at(3, 17, 21), 50, { id: 'evening' })];
        const day = '2026-03-17';
        assert.ok(pageFns('calendar', ['pad', 'buildMonthData'], reviewScope(trades)).buildMonthData(2026, 2)[day]);
        assert.equal(pageFns('day-view', ['getDayGroups'], reviewScope(trades)).getDayGroups()[0].date, day);
        assert.deepEqual(weekDays(weekFns(trades).getWeekGroups()[0]), [day]);
        assert.equal(F.filterTrades(trades, { period: 'custom', from: day, to: day }, [], new Date()).length, 1);
        assert.deepEqual(Object.keys(pageFns('snapshot', ['calcSnap'], {}).calcSnap(trades).dailyMap), [day]);
    });
}

test('Day and Week View skip a trade with an unreadable time instead of failing', () => {
    useZone(ZONES[0]);
    const trades = [trade('nope', 5, { id: 'bad' }), trade(at(3, 17, 9), 1, { id: 'ok' })];
    assert.deepEqual(pageFns('day-view', ['getDayGroups'], reviewScope(trades)).getDayGroups().map(g => g.date), ['2026-03-17']);
    assert.deepEqual(weekFns(trades).getWeekGroups().map(w => w.sunday), ['2026-03-15']);
    assert.deepEqual(Object.keys(pageFns('calendar', ['pad', 'buildMonthData'], reviewScope(trades)).buildMonthData(2026, 2)), ['2026-03-17']);
});

test('Calendar, Day View and Week View no longer key trades by UTC day', () => {
    for (const page of ['calendar', 'day-view', 'week-view']) {
        assert.doesNotMatch(read('js/pages/' + page + '.js'), /toISOString\(\)/, page);
    }
    assert.doesNotMatch(extractFunction(read('Denarii.js'), '_renderDayTradeList'), /toISOString\(\)/);
});
