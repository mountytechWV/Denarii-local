// The Daily and Weekly Plan cleanup prompts are frozen. The fixture was
// written from the code before the cleanup was shared with the trade and
// reflection editors; the planners must keep sending exactly these bytes.
//
// Regenerate only on purpose: node tests/plan-cleanup-snapshot.test.js --write
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const AI = fs.readFileSync(path.join(root, 'js/widgets/journal-ai.js'), 'utf8');
const FIXTURE = path.join(__dirname, 'fixtures', 'plan-cleanup-prompts.json');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) return null;
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return src.slice(start, i + 1);
    }
    throw new Error(name + ': unbalanced braces');
}

// Real prompt constants and the real functions (helpers included when present).
const CONSTS = AI.slice(AI.indexOf('var PLAN_CLEANUP_BULLET_RULE ='), AI.indexOf('// Plan text with its line breaks'));
const FNS = ['_planEditorText', '_cleanupToHtml', '_runCleanup', 'runPlanCleanup']
    .map(n => extractFunction(AI, n)).filter(Boolean).join('\n');

function plannerCleanup(DenAriiAI) {
    const esc = s => String(s);
    const friendlyError = s => s;
    return new Function('esc', 'friendlyError', 'DenAriiAI', CONSTS + '\n' + FNS + '\nreturn runPlanCleanup;')(esc, friendlyError, DenAriiAI);
}

// Minimal element tree (same shape as plan-cleanup.test.js).
function el(tag, attrs, kids) {
    const node = {
        tag, attrs: attrs || {}, kids: kids || [], parent: null,
        cloneNode() { return el(tag, Object.assign({}, node.attrs), node.kids.map(k => (typeof k === 'string' ? k : k.cloneNode()))); },
        all() { return node.kids.flatMap(k => (typeof k === 'string' ? [] : [k, ...k.all()])); },
        querySelectorAll(sel) {
            if (sel === '[data-plan-cleanup]') return node.all().filter(n => 'data-plan-cleanup' in n.attrs);
            const tags = sel.split(',');
            return node.all().filter(n => tags.includes(n.tag));
        },
        remove() { node.parent.kids.splice(node.parent.kids.indexOf(node), 1); },
        replaceWith(s) { node.parent.kids[node.parent.kids.indexOf(node)] = s; },
        append(s) { node.kids.push(s); },
        get textContent() { return node.kids.map(k => (typeof k === 'string' ? k : k.textContent)).join(''); },
    };
    node.kids.forEach(k => { if (typeof k !== 'string') k.parent = node; });
    return node;
}

function editor() {
    return el('div', {}, [
        el('p', {}, ['Watch spy  above 500']),
        el('p', {}, ['um so wait for vwap', el('br'), 'then enter']),
        el('div', { 'data-plan-cleanup': '1' }, [el('p', {}, ['old cleanup'])]),
    ]);
}

async function capture() {
    const out = {};
    for (const type of ['daily', 'weekly']) {
        for (const format of [undefined, 'bullets', 'paragraphs']) {
            let sent;
            const run = plannerCleanup({
                isConfigured: () => true,
                query: async (req, opts) => { sent = { req, opts }; return { success: true, rawText: '- x' }; },
            });
            const res = await run(type, editor(), format);
            assert.equal(res.ok, true);
            out[type + ':' + (format || 'default')] = {
                promptText: sent.req.promptText,
                tradeData: sent.req.tradeData,
                providerConfig: sent.opts.providerConfig,
            };
        }
    }
    return out;
}

if (process.argv.includes('--write')) {
    capture().then(out => {
        fs.writeFileSync(FIXTURE, JSON.stringify(out, null, 2) + '\n');
        console.log('wrote', FIXTURE);
    });
} else {
    test('planner cleanup prompts and request options are byte-for-byte unchanged', async () => {
        const expected = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        const actual = await capture();
        assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected).sort());
        for (const k of Object.keys(expected)) assert.deepEqual(actual[k], expected[k], k);
    });

    test('the fixture holds the real prompts, not stubs', () => {
        const f = JSON.parse(fs.readFileSync(FIXTURE, 'utf8'));
        assert.ok(f['daily:default'].promptText.startsWith('You are cleaning up a trading plan'));
        assert.ok(f['daily:default'].promptText.includes('Plan type: DAILY\n'));
        assert.ok(f['weekly:paragraphs'].promptText.includes('Plan type: WEEKLY\n'));
        assert.ok(f['daily:default'].promptText.includes('--- Plan ---\nWatch spy  above 500\num so wait for vwap\nthen enter\n--- End Plan ---'));
        assert.equal(f['daily:default'].promptText, f['daily:bullets'].promptText);
        assert.notEqual(f['daily:bullets'].promptText, f['daily:paragraphs'].promptText);
    });
}
