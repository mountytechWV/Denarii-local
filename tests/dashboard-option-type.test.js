// Dashboard "Option Type" column: Call / Put for option trades, an em dash
// otherwise, off by default, and blanks sort last in both directions.
//
// Same approach as option-side-sync.test.js: the real functions (and the
// column's sort case) are cut out of Denarii.js and run on their own.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'Denarii.js'), 'utf8');

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

const label = new Function(extractFunction(APP, 'getAssetType') + '\n' +
    extractFunction(APP, '_dashOptionTypeLabel') + '\nreturn _dashOptionTypeLabel;')();

// The local (non-cloud) table sort's optionType case, run as a comparator.
const sortCase = /case 'optionType':\s*va = _dashOptionTypeLabel[\s\S]*?vb\.localeCompare\(va\);/.exec(APP)[0];
const compare = new Function('_dashOptionTypeLabel', '_sd',
    'return function (a, b) { var va, vb; switch (\'optionType\') { ' + sortCase + ' } };');

const columns = new Function(/var _DASH_COLUMNS = \[[\s\S]*?\];/.exec(APP)[0] + '\nreturn _DASH_COLUMNS;')();

test('label: Call / Put for options (any case), blank for other trades', () => {
    assert.equal(label({ assetType: 'option', optionType: 'CALL' }), 'Call');
    assert.equal(label({ assetType: 'option', optionType: 'put' }), 'Put');
    assert.equal(label({ optionType: 'PUT' }), 'Put');            // older trade without assetType
    assert.equal(label({ assetType: 'option' }), '');
    assert.equal(label({ assetType: 'stock', optionType: 'CALL' }), '');
});

test('column: listed before Side, sortable, off by default', () => {
    const i = columns.findIndex(c => c.key === 'optionType');
    assert.ok(i >= 0);
    assert.equal(columns[i].label, 'Option Type');
    assert.equal(columns[i].sortField, 'optionType');
    assert.equal(columns[i].defaultOn, false);
    assert.equal(columns[i + 1].key, 'type');
});

test('sort: blanks last in both directions', () => {
    const trades = [
        { id: 1, assetType: 'stock' },
        { id: 2, assetType: 'option', optionType: 'PUT' },
        { id: 3, assetType: 'option' },
        { id: 4, assetType: 'option', optionType: 'CALL' },
    ];
    const ids = dir => trades.slice().sort(compare(label, dir)).map(t => t.id);
    assert.deepEqual(ids('asc').slice(0, 2), [4, 2]);
    assert.deepEqual(ids('desc').slice(0, 2), [2, 4]);
    assert.deepEqual(ids('asc').slice(2).sort(), [1, 3]);
    assert.deepEqual(ids('desc').slice(2).sort(), [1, 3]);
});

test('cell and first-click direction', () => {
    assert.ok(APP.includes("tbl += '<td>' + (_dashOptionTypeLabel(t) || '—') + '</td>';"));
    assert.ok(APP.includes("field === 'optionType' || field === 'type'"));
});
