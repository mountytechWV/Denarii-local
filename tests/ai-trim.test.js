// Remove Reflection Patterns (AI Analysis → Reflection Patterns) and the
// Analytics "AI Insight" widget. Trade Reflection AI Analysis, reflection
// Run AI, Planner AI, Run Analysis, Prompt Library, Saved Reports and the
// Gemini key stay. Saved layouts that still list an AI Insight widget are
// left as they are and render nothing for it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const HTML = read('index.html');
const APP  = read('Denarii.js');
const CSS  = read('Denarii.css');
const JAI  = read('js/widgets/journal-ai.js');
const PAGES = { snapshot: 'si', 'perf-trends': 'pt', setups: 'su', timing: 'tm', symbols: 'sy', risk: 'rk', discipline: 'dc' };
const PAGE_SRC = Object.fromEntries(Object.keys(PAGES).map(p => [p, read('js/pages/' + p + '.js')]));

// ── Removed ─────────────────────────────────────────────────────────────────

test('index.html: no Reflection Patterns page, sidebar item, save dialog or help item', () => {
    for (const s of ['ai-journal-coach', 'jpc-', '_jpc', 'Reflection Patterns', 'Reflection Pattern Analysis']) {
        assert.ok(!HTML.includes(s), s);
    }
});

test('ai-insight.js is deleted and no page loads it', () => {
    assert.ok(!fs.existsSync(path.join(ROOT, 'js', 'widgets', 'ai-insight.js')));
    assert.ok(!HTML.includes('ai-insight.js'));
});

test('Denarii.js: no DenAriiInsight and no Reflection Patterns page title', () => {
    assert.ok(!APP.includes('DenAriiInsight'));
    assert.ok(!APP.includes('ai-journal-coach'));
});

test('Analytics pages: no AI Insight in the default layout, widget picker, renderers or registration', () => {
    for (const [page, prefix] of Object.entries(PAGES)) {
        const src = PAGE_SRC[page];
        assert.ok(!src.includes(prefix + '-ai-insight'), page);
        assert.ok(!src.includes('DenAriiInsight'), page);
        assert.ok(!src.includes("cat: 'AI Insight'"), page);
    }
});

test('journal-ai.js: Reflection Patterns code is gone', () => {
    for (const s of ['_jpc', 'jpc-', 'buildReviewContext', 'REVIEW_PROMPTS', 'runJournalPatternAnalysis', 'confirmSaveReport']) {
        assert.ok(!JAI.includes(s), s);
    }
});

// ── Kept ────────────────────────────────────────────────────────────────────

test('index.html: Trade Reflection AI Analysis, its dialog and the other AI pages stay', () => {
    assert.ok(HTML.includes('onclick="openJournalAI(\'trade\')">AI Analysis</button>'));
    assert.ok(HTML.includes('id="journal-ai-modal"'));
    for (const tab of ['ai-library', 'ai-run', 'ai-reports']) assert.ok(HTML.includes('data-tab="' + tab + '"'), tab);
    for (const s of ['js/ai-library.js', 'js/ai-run.js', 'js/ai-reports.js', 'js/services/ai/gemini.js']) assert.ok(HTML.includes(s), s);
});

test('Denarii.css: the shared .ai-insight-* classes stay (used by the AI Analysis dialog and Run AI)', () => {
    for (const c of ['.ai-insight-spinner', '.ai-insight-msg', '.ai-insight-error', '.ai-insight-loading', '.ai-insight-text', '.ai-insight-footer']) {
        assert.ok(CSS.includes(c), c);
    }
});

test('Analytics pages: an old saved layout entry with an AI Insight widget renders nothing instead of throwing', () => {
    for (const page of Object.keys(PAGES)) {
        assert.match(PAGE_SRC[page], /return RENDERERS\[item\.wid\] \? RENDERERS\[item\.wid\]\(/, page);
    }
});

// Runs journal-ai.js with a fake window, document and AI service.
function loadJournalAI(extra) {
    const prompts = [];
    const el = () => ({ innerHTML: '', textContent: '', style: {} });
    const window = Object.assign({
        _rvGetReview: () => ({ content: '<p>Chased the open again.</p>', status: 'complete' }),
        _rvGetTrades: () => [],
        _rvCalcMetrics: () => ({}),
        _rvPeriodLabel: (type, key) => key,
    }, extra);
    const ctx = {
        window,
        document: {
            createElement: () => {
                const d = { _h: '' };
                Object.defineProperty(d, 'innerHTML', { set(v) { d._h = v; }, get() { return d._h; } });
                Object.defineProperty(d, 'textContent', { get() { return d._h.replace(/<[^>]*>/g, ''); } });
                return d;
            },
            getElementById: () => null,
        },
        DenAriiAI: {
            isConfigured: () => true,
            query: async q => { prompts.push(q.promptText); return { success: true, rawText: 'ok', model: 'm', durationMs: 1 }; },
        },
    };
    vm.runInNewContext(JAI, ctx);
    return { window, prompts, el };
}

test('journal-ai.js: kept exports are still there, the pattern exports are gone', () => {
    const { window } = loadJournalAI();
    for (const n of ['openJournalAI', '_jaiAppendToNotes', '_rvAiRender', '_plannerAiRun']) {
        assert.equal(typeof window[n], 'function', n);
    }
    for (const n of ['_jpcRunAnalysis', '_jpcSaveReport', '_jpcConfirmSave']) {
        assert.equal(window[n], undefined, n);
    }
});

test('journal-ai.js: reflection Run AI still sends REVIEW_SYSTEM + the single-period prompt', async () => {
    const { window, prompts, el } = loadJournalAI();
    const body = el(), footer = el();
    window._rvAiRender('daily', '2026-10-27', body, footer);
    await new Promise(r => setImmediate(r));
    assert.equal(prompts.length, 1);
    assert.match(prompts[0], /^You are a disciplined trading coach reviewing a trader's written reflection history\./);
    assert.match(prompts[0], /Below is a single daily reflection entry/);
    assert.match(prompts[0], /Daily Reflection Entry: 2026-10-27/);
    assert.match(prompts[0], /Chased the open again\./);
});

test('journal-ai.js: openJournalAI for a reflection type still hands off to the page Run AI', () => {
    const calls = [];
    const { window } = loadJournalAI({ _rvRunAI: t => calls.push(t) });
    window.openJournalAI('weekly');
    assert.deepEqual(calls, ['weekly']);
});

test('index.html: cache-bust versions bumped', () => {
    // At least the AI-trim version (later batches bump it again).
    assert.ok(Number(/src="Denarii\.js\?v=(\d+)"/.exec(HTML)[1]) >= 47);
    assert.ok(Number(HTML.split('src="js/widgets/journal-ai.js?v=')[1].split('"')[0]) >= 3);
    for (const page of Object.keys(PAGES)) {
        assert.ok(Number(HTML.split('src="js/pages/' + page + '.js?v=')[1].split('"')[0]) >= 2, page);
    }
});
