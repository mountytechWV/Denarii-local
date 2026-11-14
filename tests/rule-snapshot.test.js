// Per-trade strategy rule snapshots: editing a strategy's rules never loses
// or misattributes the answers saved on existing trades.
// Same approach as reflection-open-trade.test.js: the real functions are cut
// out of the source and run inside a `with` scope where unknown globals are inert.
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

function sandbox(vals) {
    const code = APP_FNS.map(n => extractFunction(APP, n)).join('\n') + '\n' +
        JNL_FNS.map(n => extractFunction(JNL, n)).join('\n');
    const names = APP_FNS.concat(JNL_FNS);
    const target = Object.assign({
        _jnlFollowedRules: [], _jnlAnsweredRules: [], _jnlSelectedStrategy: null, _jnlPrevScore: null,
    }, vals);
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

const clone = v => JSON.parse(JSON.stringify(v));

// Rule 1 and 2 are scored, 3 is mandatory, 5 applies to losers only.
function strategy(over) {
    return Object.assign({
        id: 1700000000001, name: 'Breakout',
        groups: [
            { id: 1, name: 'Entry', rules: [
                { id: 1, text: 'Clean break', stars: 3, isMandatory: false, showWhen: 'always' },
                { id: 2, text: 'Volume', stars: 2, isMandatory: false, showWhen: 'always' },
                { id: 3, text: 'Stop below range', stars: 5, isMandatory: true, showWhen: 'always' },
            ] },
            { id: 2, name: 'Exit', rules: [
                { id: 5, text: 'Cut fast', stars: 5, isMandatory: true, showWhen: 'loser' },
            ] },
        ],
    }, over);
}

function withRules(s, edit) {
    const c = clone(s);
    edit(c.groups);
    return c;
}

function journal(strat, trade) {
    const doc = makeDocument();
    const box = sandbox({
        document: doc,
        window: { _jnlSelectedTradeId: trade.id },
        journalData: { strategies: [strat], trades: [trade] },
    });
    box.doc = doc;
    box.cb = id => doc.els['jnl-rule-' + id];
    return box;
}

test('a save stores a rule snapshot and keeps every existing score field', () => {
    const { fns } = sandbox({});
    const s = strategy();
    const score = fns.calculateStrategyScore(s, [1, 3], 50);
    assert.deepEqual(score.followedRules, [1, 3]);
    assert.equal(score.actualScore, 3 + 6);
    assert.equal(score.maxScore, 3 + 2 + 6);
    assert.equal(score.allMandatoryFollowed, true);
    assert.equal(score.strategyId, s.id);
    assert.equal(score.strategyName, 'Breakout');
    assert.equal(typeof score.grade, 'string');
    assert.deepEqual(score.rules.map(e => [e.id, e.text, e.groupName, e.followed, e.answered]), [
        [1, 'Clean break', 'Entry', true, true],
        [2, 'Volume', 'Entry', false, true],
        [3, 'Stop below range', 'Entry', true, true],
    ]);
    assert.deepEqual(Object.keys(score.rules[0]).sort(),
        ['answered', 'followed', 'groupName', 'id', 'isMandatory', 'showWhen', 'stars', 'text']);
});

test('a removed rule stays on the trade as Retired, even after re-saving', () => {
    const s = strategy();
    const { fns } = sandbox({});
    const saved = fns.calculateStrategyScore(s, [1, 2, 3], 50);
    const edited = withRules(s, g => { g[0].rules = g[0].rules.filter(r => r.id !== 2); });
    const trade = { id: 't1', pnl: 50, setupType: 'Breakout', strategyScore: clone(saved) };

    const j = journal(edited, trade);
    j.fns._jnlLoadStrategyRules('Breakout', trade.strategyScore);
    const html = j.doc.els['jnl-rules-list'].innerHTML;
    assert.match(html, /Retired/);
    assert.match(html, /Volume/);
    assert.match(html, /disabled checked/);

    const resaved = j.fns._jnlRuleScore(trade.pnl);
    const kept = resaved.rules.find(e => e.id === 2);
    assert.equal(kept.text, 'Volume');
    assert.equal(kept.followed, true);
    assert.ok(resaved.followedRules.includes(2));
    assert.equal(resaved.grade, saved.grade);
    // Saved twice more: the answer still survives.
    trade.strategyScore = resaved;
    j.fns._jnlLoadStrategyRules('Breakout', trade.strategyScore);
    assert.ok(j.fns._jnlRuleScore(trade.pnl).followedRules.includes(2));
});

test('a reworded rule keeps its answer and shows the old wording', () => {
    const s = strategy();
    const { fns } = sandbox({});
    const saved = fns.calculateStrategyScore(s, [1], 50);
    const edited = withRules(s, g => { g[0].rules[0].text = 'Clean break above range high'; });
    const trade = { id: 't1', pnl: 50, setupType: 'Breakout', strategyScore: saved };

    const j = journal(edited, trade);
    j.fns._jnlLoadStrategyRules('Breakout', trade.strategyScore);
    assert.equal(j.cb(1).checked, true);
    assert.match(j.doc.els['jnl-rules-list'].innerHTML, /Answered as: Clean break</);
});

test('a new rule shows unanswered on an old trade and does not lower its grade', () => {
    const s = strategy();
    const { fns } = sandbox({});
    const saved = fns.calculateStrategyScore(s, [1, 2, 3], 50);
    const edited = withRules(s, g => {
        g[0].rules.push({ id: 4, text: 'Wait for retest', stars: 5, isMandatory: true, showWhen: 'always' });
    });
    const trade = { id: 't1', pnl: 50, setupType: 'Breakout', strategyScore: saved };

    const j = journal(edited, trade);
    j.fns._jnlLoadStrategyRules('Breakout', trade.strategyScore);
    assert.equal(j.cb(4).hasAttribute('data-unanswered'), true);
    assert.match(j.doc.els['jnl-rules-list'].innerHTML, /\(unanswered\)/);

    let next = j.fns._jnlRuleScore(trade.pnl);
    assert.equal(next.grade, saved.grade);
    assert.equal(next.maxScore, saved.maxScore);
    assert.equal(next.allMandatoryFollowed, true);
    assert.equal(next.rules.find(e => e.id === 4).answered, false);

    // Ticking then unticking answers it as not followed.
    j.cb(4).checked = true;
    j.fns._jnlUpdateRuleScore(j.cb(4));
    j.cb(4).checked = false;
    j.fns._jnlUpdateRuleScore(j.cb(4));
    next = j.fns._jnlRuleScore(trade.pnl);
    const e4 = next.rules.find(e => e.id === 4);
    assert.equal(e4.answered, true);
    assert.equal(e4.followed, false);
    assert.equal(next.allMandatoryFollowed, false);
    assert.equal(next.maxScore, saved.maxScore + 6);
});

test('a trade saved before snapshots keeps unknown followed ids as retired', () => {
    const s = strategy();
    // The pre-snapshot shape: no rules array, 99 no longer in the strategy.
    const legacy = { strategyId: s.id, strategyName: 'Breakout', followedRules: [1, 99],
        actualScore: 3, maxScore: 11, percentage: 27.27, grade: 'F', allMandatoryFollowed: false };
    const trade = { id: 't1', pnl: 50, setupType: 'Breakout', strategyScore: clone(legacy) };

    const j = journal(s, trade);
    j.fns._jnlLoadStrategyRules('Breakout', trade.strategyScore);
    // Every current rule counts as answered, as before.
    assert.equal(j.cb(2).hasAttribute('data-unanswered'), false);
    assert.match(j.doc.els['jnl-rules-list'].innerHTML, /Unknown \(rule removed\)/);

    const resaved = j.fns._jnlRuleScore(trade.pnl);
    assert.deepEqual(resaved.followedRules, [1, 99]);
    const unknown = resaved.rules.find(e => e.id === 99);
    assert.equal(unknown.text, 'Unknown (rule removed)');
    assert.equal(unknown.followed, true);
    // Same numbers the old scoring gave for these answers.
    assert.equal(resaved.actualScore, legacy.actualScore);
    assert.equal(resaved.maxScore, legacy.maxScore);
    assert.equal(resaved.allMandatoryFollowed, false);
});

test('opening a trade leaves its stored score untouched', () => {
    const s = strategy();
    const { fns } = sandbox({});
    const saved = fns.calculateStrategyScore(s, [1, 3], 50);
    const edited = withRules(s, g => {
        g[0].rules = g[0].rules.filter(r => r.id !== 1);
        g[0].rules[0].text = 'Volume above average';
        g[0].rules.push({ id: 4, text: 'New', stars: 3, isMandatory: true, showWhen: 'always' });
    });
    const legacy = { strategyId: s.id, strategyName: 'Breakout', followedRules: [1, 99],
        actualScore: 3, maxScore: 11, percentage: 27.27, grade: 'F', allMandatoryFollowed: false };
    [saved, legacy].forEach(score => {
        const trade = { id: 't1', pnl: 50, setupType: 'Breakout', strategyScore: clone(score) };
        const before = clone(trade);
        const j = journal(edited, trade);
        j.fns._jnlLoadStrategyRules('Breakout', trade.strategyScore);
        j.fns._jnlUpdateRuleScore();
        assert.deepEqual(trade, before);
        assert.equal(trade.strategyScore.grade, score.grade);
    });
});

test('New Trade: rules it does not show stay unanswered and are not missed', () => {
    const { fns } = sandbox({});
    const s = strategy();
    const always = [1, 2, 3];
    const score = fns.calculateStrategyScore(s, [1, 2, 3], -20, { answered: always });
    assert.equal(score.allMandatoryFollowed, true);
    assert.equal(score.maxScore, 3 + 2 + 6);
    assert.equal(score.rules.find(e => e.id === 5).answered, false);
    // Without the shown list (old call shape) the loser rule counts as missed.
    assert.equal(fns.calculateStrategyScore(s, [1, 2, 3], -20).allMandatoryFollowed, false);
});

test('answers saved for another strategy are not merged', () => {
    const { fns } = sandbox({});
    const s = strategy();
    const other = { strategyId: 42, followedRules: [77], rules: [{ id: 77, text: 'x', stars: 3, followed: true, answered: true, showWhen: 'always' }] };
    const score = fns.calculateStrategyScore(s, [1], 50, { prev: other });
    assert.deepEqual(score.followedRules, [1]);
    assert.equal(fns._ruleChecklistView(s, other), null);
});