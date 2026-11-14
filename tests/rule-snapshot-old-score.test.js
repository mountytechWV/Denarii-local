// Rule snapshots (port 2), local check: a trade saved before snapshots (its
// strategyScore has followedRules but no rules list) gives the same score
// when it is opened in Trade Reflection and re-saved without changes.
// The expected values are what the pre-snapshot calculateStrategyScore stored.
// Same approach as rule-snapshot.test.js: the real functions are cut out of
// the source and run inside a `with` scope where unknown globals are inert.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP = fs.readFileSync(path.join(__dirname, '..', 'Denarii.js'), 'utf8');
const JNL = fs.readFileSync(path.join(__dirname, '..', 'js', 'pages', 'journal.js'), 'utf8');

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

const inert = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
});

const APP_FNS = ['calculateStrategyScore', '_strategyScorePrevRules', '_effectiveStars',
    'calculateGradeWithMandatory', 'renderGroupedChecklist', '_ruleChecklistView', 'getStarDisplay', 'escapeHtml'];
const JNL_FNS = ['_jnlLoadStrategyRules', '_jnlMarkRuleAnswered', '_jnlUpdateRuleScore', '_jnlRuleScore'];

// A rules list whose innerHTML becomes checkbox elements, like the browser.
function makeDocument() {
    const els = {};
    const mk = id => ({ id, value: '', style: {}, innerHTML: '' });
    const list = mk('jnl-rules-list');
    let html = '';
    Object.defineProperty(list, 'innerHTML', {
        get: () => html,
        set(v) {
            html = v;
            Object.keys(els).filter(k => k.startsWith('jnl-rule-')).forEach(k => delete els[k]);
            for (const m of v.matchAll(/<input type="checkbox" id="(jnl-rule-[^"]+)"[^>]*>/g)) {
                const attrs = {};
                if (/ data-unanswered="true"/.test(m[0])) attrs['data-unanswered'] = 'true';
                els[m[1]] = {
                    id: m[1], checked: / checked/.test(m[0]), attrs,
                    hasAttribute: k => k in attrs, removeAttribute: k => { delete attrs[k]; },
                    parentNode: { querySelector: () => null },
                };
            }
        },
    });
    els['jnl-rules-list'] = list;
    return { els, getElementById: id => (els[id] = els[id] || mk(id)) };
}

function journal(strat, trade) {
    const code = APP_FNS.map(n => extractFunction(APP, n)).join('\n') + '\n' +
        JNL_FNS.map(n => extractFunction(JNL, n)).join('\n');
    const names = APP_FNS.concat(JNL_FNS);
    const target = {
        _jnlFollowedRules: [], _jnlAnsweredRules: [], _jnlSelectedStrategy: null, _jnlPrevScore: null,
        document: makeDocument(),
        window: { _jnlSelectedTradeId: trade.id },
        journalData: { strategies: [strat], trades: [trade] },
    };
    const scope = new Proxy(target, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => {
            if (typeof k !== 'string') return undefined;
            if (k in t) return t[k];
            if (k in globalThis) return globalThis[k];
            return inert;
        },
    });
    return new Function('scope', 'with (scope) { return (function () {\n' + code +
        '\nreturn {' + names.join(',') + '};\n})(); }')(scope);
}

// Rule 1 and 2 are scored, 3 is mandatory, 4 is a note, 5 applies to losers only.
const strategy = () => ({
    id: 1700000000001, name: 'Breakout',
    groups: [
        { id: 1, name: 'Entry', rules: [
            { id: 1, text: 'Clean break', stars: 3, isMandatory: false, showWhen: 'always' },
            { id: 2, text: 'Volume', stars: 2, isMandatory: false, showWhen: 'always' },
            { id: 3, text: 'Stop below range', stars: 5, isMandatory: true, showWhen: 'always' },
            { id: 4, text: 'Note only', stars: 0, isMandatory: false, showWhen: 'always' },
        ] },
        { id: 2, name: 'Exit', rules: [
            { id: 5, text: 'Cut fast', stars: 5, isMandatory: true, showWhen: 'loser' },
        ] },
    ],
});

// Old scores, as the pre-snapshot code saved them (mandatory rules count 6;
// checked against calculateStrategyScore in Denarii 1.0.0). The grade is added below.
const CASES = [
    { name: 'winner, all mandatory followed', pnl: 50,
      old: { followedRules: [1, 3], actualScore: 9, maxScore: 11, percentage: 9 / 11 * 100, allMandatoryFollowed: true } },
    { name: 'winner, mandatory missed', pnl: 50,
      old: { followedRules: [1, 2], actualScore: 5, maxScore: 11, percentage: 5 / 11 * 100, allMandatoryFollowed: false } },
    { name: 'loser, outcome rule missed', pnl: -20,
      old: { followedRules: [1, 2, 3], actualScore: 11, maxScore: 17, percentage: 11 / 17 * 100, allMandatoryFollowed: false } },
    { name: 'loser, everything followed', pnl: -20,
      old: { followedRules: [1, 2, 3, 5], actualScore: 17, maxScore: 17, percentage: 100, allMandatoryFollowed: true } },
];

for (const c of CASES) {
    test('old-format score re-saved unchanged keeps its score: ' + c.name, () => {
        const s = strategy();
        const fns = journal(s, { id: 9, pnl: c.pnl, setupType: s.name });
        // The grade letter comes from the same grading function the old code used.
        const expectGrade = fns.calculateGradeWithMandatory(c.old.percentage, c.old.allMandatoryFollowed).letter;
        const old = Object.assign({ strategyId: s.id, strategyName: s.name }, c.old, { grade: expectGrade });
        assert.equal('rules' in old, false);

        fns._jnlLoadStrategyRules(s.name, JSON.parse(JSON.stringify(old)));
        const resaved = fns._jnlRuleScore(c.pnl);

        assert.deepEqual(resaved.followedRules, old.followedRules);
        assert.equal(resaved.actualScore, old.actualScore);
        assert.equal(resaved.maxScore, old.maxScore);
        assert.equal(resaved.percentage, old.percentage);
        assert.equal(resaved.grade, old.grade);
        assert.equal(resaved.allMandatoryFollowed, old.allMandatoryFollowed);
        assert.equal(String(resaved.strategyId), String(old.strategyId));
        // The snapshot is added; every rule shown was answered.
        assert.ok(Array.isArray(resaved.rules));
        assert.ok(resaved.rules.every(e => e.answered));
    });
}
