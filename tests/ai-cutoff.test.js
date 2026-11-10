// Run Analysis reports cut off at the output limit.
// - gemini.js: default maxOutputTokens 16384 and thinkingBudget 1024 on 2.5
//   models (thinking tokens count against the output limit); finishReason
//   is read and MAX_TOKENS marks the reply as truncated.
// - ai-run.js: a cut-off reply (MAX_TOKENS, or JSON that never closes) shows
//   a notice above what was recovered; Save to Reports still works and
//   stores filters.cutOff.
// - ai-reports.js: a saved cut-off report shows the same notice.
// The trades sent and the 300-trade trim are unchanged.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const GEMINI = read('js/services/ai/gemini.js');
const RUN = read('js/ai-run.js');
const REPORTS = read('js/ai-reports.js');
const HTML = read('index.html');

const NOTICE = 'This report was cut off before it finished. Try fewer trades or run it again.';
const quiet = { log() {}, warn() {}, error() {} };

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

// ── gemini.js ───────────────────────────────────────────────────────────────

// gemini call() with the real request building; _callDirect records the body.
function geminiCall() {
    const sent = [];
    const consts = ['TIMEOUT_MS', 'PAYLOAD_CHAR_LIMIT', 'PAYLOAD_TRIM_TO', 'DEFAULT_MAX_OUTPUT_TOKENS', 'DEFAULT_THINKING_BUDGET']
        .map(n => new RegExp('var ' + n + '\\s*=\\s*\\d+;').exec(GEMINI)[0]).join('\n');
    const call = new Function('console', '_callDirect',
        consts + '\n' +
        'var PROVIDER = "gemini", DEFAULT_MODEL = "gemini-2.5-flash";\n' +
        'function _buildPromptText(p) { return p; }\n' +
        'function _djb2() { return "fp"; }\n' +
        'function _getApiKey() { return "key"; }\n' +
        'function _defaultProxyAvailable() { return false; }\n' +
        'async function getModel() { return DEFAULT_MODEL; }\n' +
        'var DEFAULT_THINKING_LEVEL = "low";\n' +
        extractFunction(GEMINI, '_thinkingConfig') + '\n' +
        extractFunction(GEMINI, '_guardPayloadSize') + '\n' +
        'return async ' + extractFunction(GEMINI, 'call') + ';'
    )(quiet, async opts => { sent.push(JSON.parse(opts.bodyStr)); return { success: true, rawText: 'ok' }; });
    return { call, sent };
}

test('Gemini request: 16384 output tokens and a 1024 thinking budget for gemini-2.5-flash', async () => {
    const { call, sent } = geminiCall();
    await call('p', { trades: [{ id: 1 }] }, 'r1', {});
    assert.deepEqual(sent[0].generationConfig, {
        temperature: 0.2, maxOutputTokens: 16384, thinkingConfig: { thinkingBudget: 1024 },
    });
    // Callers that set their own limit keep it; non-2.5 models get no thinkingConfig.
    await call('p', { trades: [] }, 'r2', { maxOutputTokens: 4096 });
    assert.equal(sent[1].generationConfig.maxOutputTokens, 4096);
    assert.deepEqual(sent[1].generationConfig.thinkingConfig, { thinkingBudget: 1024 });
    await call('p', { trades: [] }, 'r3', { model: 'gemini-1.5-flash' });
    assert.equal('thinkingConfig' in sent[2].generationConfig, false);
    // Trades sent and the trim are unchanged.
    assert.match(GEMINI, /var PAYLOAD_TRIM_TO = 300;/);
    assert.ok(GEMINI.includes('trades: payload.trades.slice(-PAYLOAD_TRIM_TO),'));
});

function geminiResponse(data) {
    const fn = new Function('console',
        ['_successOrShapeError', '_errorResponse', '_extractText', '_extractUsage', '_extractFinishReason', '_normalizeRawText']
            .map(n => extractFunction(GEMINI, n)).join('\n') +
        '\nvar PROVIDER = "gemini";\nreturn _successOrShapeError;')(quiet);
    return fn({ model: 'gemini-2.5-flash', requestId: 'r', createdAt: 'now', fingerprint: 'fp' }, data);
}

test('Gemini response: finishReason is read; MAX_TOKENS marks it truncated', () => {
    const parts = [{ text: 'thinking', thought: true }, { text: '{"title":"T","summary":"S","sections":[{"heading":"H","items":["a' }];
    const cut = geminiResponse({ candidates: [{ content: { parts }, finishReason: 'MAX_TOKENS' }] });
    assert.equal(cut.success, true, 'what came back is still returned');
    assert.equal(cut.finishReason, 'MAX_TOKENS');
    assert.equal(cut.truncated, true);
    assert.equal(cut.rawText.startsWith('{"title":"T"'), true);
    const done = geminiResponse({ candidates: [{ content: { parts: [{ text: '{}' }] }, finishReason: 'STOP' }] });
    assert.equal(done.finishReason, 'STOP');
    assert.equal(done.truncated, false);
});

// ── Run Analysis and Saved Reports, whole scripts in a fake page ────────────

function fakePage(queryResp) {
    const els = {};
    const el = id => els[id] || (els[id] = {
        id, value: '', innerHTML: '', textContent: '', title: '', disabled: false, style: {}, dataset: {},
        insertAdjacentHTML() {},
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        setAttribute() {}, removeAttribute() {}, addEventListener() {}, appendChild() {}, focus() {}, select() {},
        querySelector: () => null, querySelectorAll: () => [],
    });
    el('ai-run-prompt-text').value = 'Find my trade patterns';
    const journalData = { trades: [{ id: 't1' }, { id: 't2' }], aiOutputHistory: [], brokerAccounts: [] };
    const window = {
        filterBrokerAccountId: 'all',
        DenAriiAI: { query: async () => Object.assign({ success: true, provider: 'gemini', model: 'gemini-2.5-flash',
            requestId: 'req1', tradesSent: 2, tradesTrimmedFrom: null }, queryResp) },
        addEventListener() {},
    };
    const ctx = vm.createContext({
        window, journalData, console: quiet,
        document: { getElementById: el, querySelector: () => null, querySelectorAll: () => [],
            createElement: () => el('_tmp' + Math.random()), addEventListener() {}, body: el('body') },
        setTimeout: () => 0, clearTimeout() {}, setInterval: () => 0, clearInterval() {},
        saveToIndexedDB: async () => {}, confirm: () => true, navigator: {},
    });
    vm.runInContext(read('js/shared/filter-bar.js'), ctx);
    ctx.DenariiFilters = window.DenariiFilters;
    vm.runInContext(RUN, ctx);
    vm.runInContext(REPORTS, ctx);
    return { el, window, journalData };
}

const CUT_RAW = '{"title":"Trade Pattern Analysis","summary":"Short holds lose.","sections":[' +
    '{"heading":"Core Analysis","items":["Trades held for \'short\' durations (under 5 minutes) are overwhelmingly losing, with';

test('Run Analysis: a MAX_TOKENS reply shows the notice above what was recovered and still saves', async () => {
    const page = fakePage({ rawText: CUT_RAW, finishReason: 'MAX_TOKENS', truncated: true });
    await page.window.AIRun.execute();
    const out = page.el('ai-run-output').innerHTML;
    assert.ok(out.startsWith('<div class="ai-cutoff-notice" role="status"'), out.slice(0, 80));
    assert.ok(out.includes(NOTICE));
    assert.ok(out.includes('Short holds lose.'), 'recovered summary still shown');
    assert.notEqual(page.el('ai-save-btn').disabled, true, 'Save to Reports stays available');

    await page.window.AIRun.saveOutput();
    assert.equal(page.journalData.aiOutputHistory.length, 1);
    const saved = page.journalData.aiOutputHistory[0];
    assert.equal(saved.filters.cutOff, true);
    assert.equal(saved.rawText, CUT_RAW);

    // Saved Reports viewer shows the same notice.
    page.window.AIReports.openReport(saved.id);
    const view = page.el('ai-reports').innerHTML;
    assert.ok(view.includes('ai-cutoff-notice') && view.includes(NOTICE));
});

test('Run Analysis: JSON that never closes counts as cut off even without finishReason', async () => {
    const page = fakePage({ rawText: CUT_RAW });
    await page.window.AIRun.execute();
    assert.ok(page.el('ai-run-output').innerHTML.includes(NOTICE));
});

test('Run Analysis: a complete reply renders every section, no notice, no cutOff flag', async () => {
    const full = JSON.stringify({
        title: 'Trade Pattern Analysis', summary: 'Short holds lose.',
        sections: [
            { heading: 'Core Analysis', items: ['Short holds lose 70%', 'Afternoon entries underperform'] },
            { heading: 'Behavior', items: ['Revenge trades after losses', 'Oversizing'] },
            { heading: 'Recommendations', items: ['Hold at least 5 minutes', 'Stop at 2pm'] },
        ],
        bottom_line: 'Slow down.',
    });
    const page = fakePage({ rawText: full, finishReason: 'STOP', truncated: false });
    await page.window.AIRun.execute();
    const out = page.el('ai-run-output').innerHTML;
    assert.equal(out.includes(NOTICE), false);
    for (const s of ['Core Analysis', 'Short holds lose 70%', 'Afternoon entries underperform', 'Behavior',
        'Revenge trades after losses', 'Recommendations', 'Stop at 2pm', 'Bottom Line', 'Slow down.']) {
        assert.ok(out.includes(s), s);
    }
    await page.window.AIRun.saveOutput();
    const saved = page.journalData.aiOutputHistory[0];
    assert.equal('cutOff' in saved.filters, false);
    page.window.AIReports.openReport(saved.id);
    assert.equal(page.el('ai-reports').innerHTML.includes(NOTICE), false);
});

test('index.html: changed AI scripts bumped', () => {
    const ver = file => Number((HTML.split('src="' + file + '?v=')[1] || '0"').split('"')[0]);
    assert.ok(ver('js/services/ai/gemini.js') >= 4);
    assert.ok(ver('js/ai-run.js') >= 4);
    assert.ok(ver('js/ai-reports.js') >= 6);
});
