// Calendar and Week View short amounts: whole dollars with commas and a sign,
// and "k" only from $100,000 up. Same harness as local-dates.test.js: the real
// functions are cut out of the browser scripts.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const read = rel => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

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

const load = (file, name) => new Function(extractFunction(read(file), name) + '\nreturn ' + name + ';')();

const CASES = [
    [0, '$0'],
    [150, '+$150'],
    [-999.4, '-$999'],
    [1000, '+$1,000'],
    [1970, '+$1,970'],
    [1970.49, '+$1,970'],
    [-1250, '-$1,250'],
    [12523, '+$12,523'],
    [99999, '+$99,999'],
    [99999.6, '+$100,000'],
    [100000, '+$100.0k'],
    [-125230, '-$125.2k'],
];

for (const file of ['js/pages/calendar.js', 'js/pages/week-view.js']) {
    test('Short amounts are exact whole dollars below $100,000, ' + file, () => {
        const fmt = load(file, 'fmtPnlShort');
        for (const [value, expected] of CASES) assert.equal(fmt(value), expected, String(value));
    });

    test('Exact totals keep their cents, ' + file, () => {
        const fmt = load(file, 'fmtPnl');
        assert.equal(fmt(1970), '+$1,970.00');
        assert.equal(fmt(-12523.5), '-$12,523.50');
    });
}

test('Day cells, Week N totals and day tiles use the short format', () => {
    const CAL = read('js/pages/calendar.js');
    assert.match(CAL, /cal-metric-pnl">' \+ fmtPnlShort\(cell\.stats\.pnl\)/);
    assert.match(CAL, /cal-week-pnl">' \+ fmtPnlShort\(week\.weekPnl\)/);
    assert.match(CAL, /'Monthly P\/L: ' \+ fmtPnl\(totalPnl\)/);
    const WEEK = read('js/pages/week-view.js');
    assert.match(WEEK, /wv-day-pnl">' \+ fmtPnlShort\(dayPnl\)/);
    assert.match(WEEK, /wv-week-pnl">' \+ fmtPnl\(m\.totalPnl\)/);
});
