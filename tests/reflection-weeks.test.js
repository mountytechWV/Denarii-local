// Weekly Reflection weeks run Sunday-Saturday (local), matching the Weekly
// Planner. Keys keep the ISO YYYY-WNN of the week's Monday, so saved
// reflections stay where they are; only the dates a key covers shift back a
// day. Monthly "Green / Red Weeks" groups trades by the same weeks.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const RV = fs.readFileSync(path.join(root, 'js/pages/reviews.js'), 'utf8');
const HTML = fs.readFileSync(path.join(root, 'index.html'), 'utf8');

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

const HELPERS = ['pad', 'todayISO', 'isoWeekNum', 'weekKey', 'sunWeekKey', 'defaultKey',
    'periodRange', 'periodLabel', 'stepKey', '_tradePnl', '_tradeDay', 'buildSnapshot'];

// Fake clock: `now` is local parts [y, m, d]; new Date() with no args returns it.
// buildSnapshot hands its metrics to the snapshot cards; a single stub card
// captures them into `captured.ctx`.
const captured = {};
const SNAP_STUBS = {
    journalData: {},
    _rvSnap: { monthly: { layout: ['probe'], editMode: false } },
    RV_SNAP_LIB: { monthly: [{ id: 'probe', render: ctx => { captured.ctx = ctx; return ''; } }] },
    RV_SNAP_DEFAULT: { monthly: ['probe'] },
    escH: s => String(s),
};
function load(now) {
    const RealDate = Date;
    class FakeDate extends RealDate {
        constructor(...a) { if (a.length) super(...a); else super(now[0], now[1] - 1, now[2], 10); }
    }
    const code = HELPERS.map(n => extractFunction(RV, n)).join('\n');
    const names = Object.keys(SNAP_STUBS);
    return new Function('Date', ...names, code + '\nreturn {' + HELPERS.join(',') + '};')(
        FakeDate, ...names.map(n => SNAP_STUBS[n]));
}

const ymd = d => d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');

for (const tz of ['America/New_York', 'America/Los_Angeles', 'Asia/Tokyo']) {
    test('weekly periodRange runs Sunday-Saturday, ' + tz, () => {
        process.env.TZ = tz;
        const R = load([2026, 11, 2]);
        const r = R.periodRange('weekly', '2026-W45');
        assert.deepEqual(r.map(ymd), ['2026-11-01', '2026-11-07']);
        assert.equal(r[0].getDay(), 0);
        assert.equal(r[1].getDay(), 6);
        assert.equal(R.periodLabel('weekly', '2026-W45'), 'Week 45 · Nov 1 – Nov 7, 2026');
        assert.deepEqual(R.periodRange('weekly', '2026-W44').map(ymd), ['2026-10-25', '2026-10-31']);
        assert.deepEqual(R.periodRange('weekly', '2026-W46').map(ymd), ['2026-11-08', '2026-11-14']);
    });

    test('defaultKey: every day Sun-Sat lands on the week containing it, ' + tz, () => {
        process.env.TZ = tz;
        for (let d = 1; d <= 7; d++) assert.equal(load([2026, 11, d]).defaultKey('weekly'), '2026-W45', 'Nov ' + d);
        assert.equal(load([2026, 11, 8]).defaultKey('weekly'), '2026-W46'); // Sunday
        assert.equal(load([2026, 10, 31]).defaultKey('weekly'), '2026-W44'); // Saturday
    });

    test('week-53 year boundary, ' + tz, () => {
        process.env.TZ = tz;
        const R = load([2026, 12, 27]); // Sunday
        assert.equal(R.defaultKey('weekly'), '2026-W53');
        assert.deepEqual(R.periodRange('weekly', '2026-W53').map(ymd), ['2026-12-27', '2027-01-02']);
        assert.equal(load([2027, 1, 2]).defaultKey('weekly'), '2026-W53');  // Saturday
        assert.equal(load([2027, 1, 3]).defaultKey('weekly'), '2027-W01');  // Sunday
        assert.equal(R.stepKey('weekly', '2026-W53', 1), '2027-W01');
        assert.equal(R.stepKey('weekly', '2027-W01', -1), '2026-W53');
        assert.deepEqual(R.periodRange('weekly', '2027-W01').map(ymd), ['2027-01-03', '2027-01-09']);
    });
}

test('prev/next still move exactly one week', () => {
    const R = load([2026, 11, 2]);
    assert.equal(R.stepKey('weekly', '2026-W45', -1), '2026-W44');
    assert.equal(R.stepKey('weekly', '2026-W45', 1), '2026-W46');
});

test('Daily, Monthly and Yearly periods are unchanged', () => {
    const R = load([2026, 11, 8]);
    assert.equal(R.defaultKey('daily'), '2026-11-08');
    assert.equal(R.defaultKey('monthly'), '2026-11');
    assert.equal(R.defaultKey('yearly'), '2026');
    assert.deepEqual(R.periodRange('monthly', '2026-11').map(ymd), ['2026-11-01', '2026-11-30']);
    assert.deepEqual(R.periodRange('yearly', '2026').map(ymd), ['2026-01-01', '2026-12-31']);
});

test('Monthly Green / Red Weeks groups trades Sunday-Saturday', () => {
    process.env.TZ = 'America/New_York';
    const R = load([2026, 11, 30]);
    const t = (date, pnl) => ({ date, pnl });
    // Sun Nov 1 +100 and Mon Nov 2 -50 share a week (green); under Mon-Sun
    // they would split into one green and one red week.
    // Sat Nov 7 -10 and Sun Nov 8 +30 are different weeks (red, green).
    const trades = [t('2026-11-01', 100), t('2026-11-02', -50), t('2026-11-07', -10), t('2026-11-08', 30)];
    R.buildSnapshot('monthly', { totalPnl: 70 }, trades, null);
    const snap = captured.ctx;
    // Weeks: W45 (Nov 1-7) = +40, W46 (Nov 8-14) = +30
    assert.equal(snap.greenWeeks, 2);
    assert.equal(snap.redWeeks, 0);

    R.buildSnapshot('monthly', { totalPnl: -30 }, [t('2026-11-07', -40), t('2026-11-08', 10)], null);
    const snap2 = captured.ctx;
    assert.equal(snap2.greenWeeks, 1);
    assert.equal(snap2.redWeeks, 1);
});

test('reviews.js cache-bust bumped', () => {
    assert.ok(Number(HTML.split('src="js/pages/reviews.js?v=')[1].split('"')[0]) >= 9);
});
