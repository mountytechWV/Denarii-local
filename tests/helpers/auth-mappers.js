// Loads the real trade row mappers (_mapArrayRow, _mapSupabaseTradeRow) from
// js/auth.js for Node tests. auth.js is a browser script with many globals,
// so only these two self-contained functions are cut out (brace matching)
// and compiled in this realm, so deepStrictEqual sees ordinary objects.
const fs = require('node:fs');
const path = require('node:path');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found in js/auth.js');
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(name + ': unbalanced braces');
}

const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'auth.js'), 'utf8');
// Batch D3: _mapArrayRow puts non-trade fields without a column in `extra`.
const mappedFields = /var _MAPPED_FIELDS = \{[\s\S]*?\n\};/.exec(src)[0];
const code = mappedFields + '\n' + extractFunction(src, '_extraFields') + '\n' +
    extractFunction(src, '_mapArrayRow') + '\n' + extractFunction(src, '_mapSupabaseTradeRow') +
    '\nreturn { _mapArrayRow, _mapSupabaseTradeRow };';

module.exports = new Function(code)();
