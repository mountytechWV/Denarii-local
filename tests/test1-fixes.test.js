// Test 1 fixes, batch 1:
// - gemini.js: default model is gemini-flash-latest; the per-account model
//   choice is used by call(); ListModels keeps only generateContent models;
//   a model-not-found error points to Settings → Integrations.
// - editor-toolbar.js: in the desktop app the microphone shows the
//   Windows + H tip instead of starting speech recognition.
// - index.html: Model select under the Gemini key; TradingView link styled.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const GEMINI = read('js/services/ai/gemini.js');
const TOOLBAR = read('js/shared/editor-toolbar.js');
const HTML = read('index.html');
const MAIN = read('electron/main.js');

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

const quiet = { log() {}, warn() {}, error() {} };
const NOT_FOUND = "This AI model isn't available for your key. Choose another model in Settings > Integrations.";

test('Gemini: default model is gemini-flash-lite-latest and no 2.5 / 1.5 name is hard-coded', () => {
    assert.match(GEMINI, /var DEFAULT_MODEL\s*=\s*'gemini-flash-lite-latest';/);
    assert.equal(/'gemini-(1\.5|2\.0|2\.5)[^']*'/.test(GEMINI), false);
});

function geminiCall(storedModel) {
    const sent = [];
    const consts = ['TIMEOUT_MS', 'PAYLOAD_CHAR_LIMIT', 'PAYLOAD_TRIM_TO', 'DEFAULT_MAX_OUTPUT_TOKENS', 'DEFAULT_THINKING_BUDGET']
        .map(n => new RegExp('var ' + n + '\\s*=\\s*\\d+;').exec(GEMINI)[0]).join('\n');
    const global = {
        getAppSetting: async () => storedModel,
    };
    const call = new Function('console', '_callDirect', 'global', 'currentAccountId',
        consts + '\n' +
        'var PROVIDER = "gemini";\n' + /var DEFAULT_MODEL\s*=\s*'[^']+';/.exec(GEMINI)[0] + '\n' +
        'function _buildPromptText(p) { return p; }\n' +
        'function _djb2() { return "fp"; }\n' +
        'function _getApiKey() { return "key"; }\n' +
        'function _defaultProxyAvailable() { return false; }\n' +
        extractFunction(GEMINI, '_modelSettingKey') + '\n' +
        'async ' + extractFunction(GEMINI, 'getModel') + '\n' +
        /var DEFAULT_THINKING_LEVEL\s*=\s*'[a-z]+';/.exec(GEMINI)[0] + '\n' +
        extractFunction(GEMINI, '_thinkingConfig') + '\n' +
        extractFunction(GEMINI, '_guardPayloadSize') + '\n' +
        'return async ' + extractFunction(GEMINI, 'call') + ';'
    )(quiet, async opts => { sent.push(opts); return { success: true, rawText: 'ok' }; }, global, 'acct1');
    return { call, sent };
}

test('Gemini call(): a saved choice is kept; no saved choice → gemini-flash-lite-latest', async () => {
    for (const saved of ['gemini-pro-latest', 'gemini-flash-latest']) {
        const g = geminiCall(saved);
        await g.call('p', {}, 'r1', {});
        assert.equal(g.sent[0].model, saved);
    }

    let g = geminiCall(null);
    await g.call('p', {}, 'r2', {});
    assert.equal(g.sent[0].model, 'gemini-flash-lite-latest');
    // The -latest alias gets thinkingLevel (batch 2), not thinkingBudget.
    assert.deepEqual(JSON.parse(g.sent[0].bodyStr).generationConfig.thinkingConfig, { thinkingLevel: 'low' });
});

// ── Batch 2: thinking config by model family, retry, timeouts, logging ─────

// ── Batch 3: Gemini 3 / -latest keep the default temperature ───────────────

test('Gemini temperature: omitted for gemini-3* / *-latest (every feature); sent for 2.5 and older', async () => {
    for (const model of ['gemini-flash-latest', 'gemini-3-flash-preview', 'gemini-3.1-pro-preview', 'gemini-flash-lite-latest']) {
        for (const cfg of [{}, { temperature: 0.2, maxOutputTokens: 8192, feature: 'cleanup' }, { feature: 'run-analysis' }]) {
            const g = geminiCall(model);
            await g.call('p', {}, 'r', cfg);
            const gc = JSON.parse(g.sent[0].bodyStr).generationConfig;
            assert.equal('temperature' in gc, false, model + ' ' + JSON.stringify(cfg));
        }
    }
    for (const [model, t] of [['gemini-2.5-flash', 0.2], ['gemini-2.0-flash', 0.3]]) {
        const g = geminiCall(model);
        await g.call('p', {}, 'r', t === 0.2 ? {} : { temperature: t });
        assert.equal(JSON.parse(g.sent[0].bodyStr).generationConfig.temperature, t, model);
    }
});

test('Gemini request log line carries feature, endpoint and generationConfig, not the prompt or key', () => {
    const call = extractFunction(GEMINI, 'call');
    assert.ok(call.includes("'endpoint=generateContent'"));
    assert.ok(call.includes("'generationConfig=' + genLog"));
    assert.ok(call.includes("'feature=' + feature"));
    assert.match(call, /var genLog\s*=\s*JSON\.stringify\(geminiBody\.generationConfig\);/);
});

test('Gemini thinking config: 2.5 → thinkingBudget; 3 / -latest → thinkingLevel; never both', async () => {
    const cases = [
        ['gemini-2.5-flash',        { thinkingBudget: 1024 }],
        ['gemini-2.5-pro',          { thinkingBudget: 1024 }],
        ['gemini-3-flash-preview',  { thinkingLevel: 'low' }],
        ['gemini-3.1-pro-preview',  { thinkingLevel: 'low' }],
        ['gemini-flash-latest',     { thinkingLevel: 'low' }],
        ['gemini-flash-lite-latest', { thinkingLevel: 'low' }],
        ['gemini-2.0-flash',        undefined],
        ['gemini-1.5-flash',        undefined],
    ];
    for (const [model, expected] of cases) {
        const g = geminiCall(model);
        await g.call('p', {}, 'r', {});
        const tc = JSON.parse(g.sent[0].bodyStr).generationConfig.thinkingConfig;
        assert.deepEqual(tc, expected, model);
        if (tc) assert.equal('thinkingBudget' in tc && 'thinkingLevel' in tc, false, model);
    }
    // A caller's level is passed through.
    const g = geminiCall('gemini-flash-latest');
    await g.call('p', {}, 'r', { thinkingLevel: 'minimal' });
    assert.deepEqual(JSON.parse(g.sent[0].bodyStr).generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
});

test('Gemini call(): feature and timeout reach the request; default timeout otherwise', async () => {
    let g = geminiCall(null);
    await g.call('p', {}, 'r', { feature: 'cleanup', timeoutMs: 60000 });
    assert.equal(g.sent[0].feature, 'cleanup');
    assert.equal(g.sent[0].timeoutMs, 60000);
    g = geminiCall(null);
    await g.call('p', {}, 'r', {});
    assert.equal(g.sent[0].feature, 'other');
    assert.equal(g.sent[0].timeoutMs, 120000);
});

// _callDirect with a scripted fetch. Returns the bodies sent and log lines.
function directCall(responses) {
    const bodies = [], logs = [];
    const fetchImpl = async (url, init) => {
        bodies.push(JSON.parse(init.body));
        const r = responses.shift();
        return { ok: r.status === 200, status: r.status, json: async () => r.body };
    };
    const con = { log: (...a) => logs.push(a.join(' ')), warn() {}, error() {} };
    const fn = new Function('fetch', 'console',
        'var BASE_URL = "https://x/models/", TIMEOUT_MS = 120000, PROVIDER = "gemini";\n' +
        'var MODEL_NOT_FOUND_MSG = "nf";\n' +
        ['_isThinkingRejected', '_logAttempt', '_httpCategory', '_isModelNotFound', '_httpErrorMessage',
         '_errorResponse', '_networkErrorResponse', '_normalizeRawText', '_extractText', '_extractUsage',
         '_extractFinishReason', '_successOrShapeError'].map(n => extractFunction(GEMINI, n)).join('\n') + '\n' +
        'return async ' + extractFunction(GEMINI, '_callDirect') + ';'
    )(fetchImpl, con);
    const body = { contents: [], generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: 'low' } } };
    const opts = { model: 'gemini-flash-latest', feature: 'cleanup', timeoutMs: 60000, requestId: 'r1',
        apiKey: 'SECRET', geminiBody: body, bodyStr: JSON.stringify(body) };
    return { run: () => fn(opts), bodies, logs };
}

const OK = { status: 200, body: { candidates: [{ content: { parts: [{ text: 'done' }] }, finishReason: 'STOP' }] } };

test('Gemini: a 400 on the thinking setting retries once without thinkingConfig', async () => {
    const d = directCall([
        { status: 400, body: { error: { status: 'INVALID_ARGUMENT', message: 'Thinking level is not supported for this model.' } } },
        OK,
    ]);
    const resp = await d.run();
    assert.equal(resp.success, true);
    assert.equal(d.bodies.length, 2);
    assert.deepEqual(d.bodies[0].generationConfig.thinkingConfig, { thinkingLevel: 'low' });
    assert.equal('thinkingConfig' in d.bodies[1].generationConfig, false);
    assert.equal(d.bodies[1].generationConfig.temperature, 0.2);
});

test('Gemini: the thinking retry happens only once, and not for other 400s', async () => {
    let d = directCall([
        { status: 400, body: { error: { message: 'thinking_level bad' } } },
        { status: 400, body: { error: { message: 'thinking still bad' } } },
    ]);
    let resp = await d.run();
    assert.equal(resp.success, false);
    assert.equal(d.bodies.length, 2);

    d = directCall([{ status: 400, body: { error: { message: 'Request contains an invalid argument.' } } }]);
    resp = await d.run();
    assert.equal(resp.success, false);
    assert.equal(d.bodies.length, 1);
});

test('Gemini: each request logs model, feature, status and elapsed ms — no key, no prompt', async () => {
    const d = directCall([OK]);
    await d.run();
    const line = d.logs.find(l => l.includes('Gemini response'));
    assert.ok(line);
    assert.match(line, /model=gemini-flash-latest/);
    assert.match(line, /feature=cleanup/);
    assert.match(line, /status=200/);
    assert.match(line, /elapsedMs=\d+/);
    assert.equal(d.logs.some(l => l.includes('SECRET')), false);
});

test('Callers: per-feature timeouts, feature names and thinking level', () => {
    const AI = read('js/widgets/journal-ai.js');
    const RUN = read('js/ai-run.js');
    assert.ok(AI.includes("feature: 'cleanup', timeoutMs: 60000, thinkingLevel: 'low'"));
    assert.ok(AI.includes("feature: 'trade-ai', timeoutMs: 90000, thinkingLevel: 'low'"));
    assert.ok(RUN.includes("feature: 'run-analysis', timeoutMs: 180000, thinkingLevel: 'low'"));
    const tip = 'You can also choose a faster model (e.g. a Flash-Lite model) in Settings > Integrations.';
    assert.ok(RUN.includes('The request took too long. Try narrowing your filters to send less data, or try again in a moment. ' + tip));
    assert.ok(AI.includes(tip));
});

test('Gemini: model setting is per account', () => {
    const fn = new Function('currentAccountId', extractFunction(GEMINI, '_modelSettingKey') + '; return _modelSettingKey();');
    assert.equal(fn('abc'), 'gemini-model:abc');
});

test('Gemini listModels(): only generateContent models, "models/" prefix removed; [] on failure', async () => {
    const make = fetchImpl => new Function('fetch', '_getApiKey', 'console', 'LIST_MODELS_URL',
        'return ' + extractFunction(GEMINI, 'listModels').replace(/^function/, 'async function') + ';'
    )(fetchImpl, () => 'k', quiet, 'https://generativelanguage.googleapis.com/v1beta/models');
    let url = null;
    const list = make(async u => { url = u; return { ok: true, json: async () => ({ models: [
        { name: 'models/gemini-flash-latest', supportedGenerationMethods: ['generateContent', 'countTokens'] },
        { name: 'models/text-embedding-004', supportedGenerationMethods: ['embedContent'] },
        { name: 'models/gemini-pro-latest', supportedGenerationMethods: ['generateContent'] },
    ] }) }; });
    assert.deepEqual(await list(), ['gemini-flash-latest', 'gemini-pro-latest']);
    assert.ok(url.startsWith('https://generativelanguage.googleapis.com/v1beta/models?'));
    assert.deepEqual(await make(async () => ({ ok: false }))(), []);
    assert.deepEqual(await make(async () => { throw new Error('offline'); })(), []);
});

test('Gemini: 404 / NOT_FOUND shows the Settings message', () => {
    const msg = new Function(
        'var MODEL_NOT_FOUND_MSG = ' + JSON.stringify(NOT_FOUND) + ';\n' +
        extractFunction(GEMINI, '_isModelNotFound') + '\n' +
        'return ' + extractFunction(GEMINI, '_httpErrorMessage') + ';')();
    assert.equal(msg(404, null), NOT_FOUND);
    assert.equal(msg(400, { error: { status: 'NOT_FOUND', message: 'models/x is not found for API version v1beta' } }), NOT_FOUND);
    assert.match(msg(400, { error: { status: 'INVALID_ARGUMENT', message: 'bad' } }), /^Invalid request/);
    assert.ok(GEMINI.includes(JSON.stringify(NOT_FOUND).slice(1, -1)));
});

test('CSP allows the ListModels host', () => {
    assert.match(MAIN, /connect-src[^"]*https:\/\/generativelanguage\.googleapis\.com/);
});

test('Settings: Model select under the Gemini key, saved via saveGeminiModel', () => {
    assert.match(HTML, /<select id="settings-integrations-model" onchange="saveGeminiModel\(\)">/);
    const SETTINGS = read('js/pages/settings.js');
    assert.ok(SETTINGS.includes('window.saveGeminiModel'));
    assert.ok(SETTINGS.includes('DenAriiAI.listModels()'));
});

test('Dictation: desktop app shows the Windows + H tip and keeps the button', () => {
    const tip = 'To dictate, click in the editor and press Windows key + H. The first time, click the microphone in the Windows voice typing box.';
    assert.ok(TOOLBAR.includes(tip));
    const toggle = extractFunction(TOOLBAR, 'toggleSpeech');
    assert.ok(toggle.indexOf('window.denariiStore') < toggle.indexOf('new SpeechRecognition'));
    assert.match(TOOLBAR, /sttSupported = !!\(window\.denariiStore \|\|/);
    assert.ok(HTML.includes(tip));
});

test('TradingView footer link uses the accent link class', () => {
    assert.match(HTML, /Charts by <a class="plan-ctx-open-link" href="https:\/\/www\.tradingview\.com\/"/);
});

// ── Batch 4: Flash-Lite default and automatic fallback ─────────────────────

test('Gemini setModel(): an explicit choice is stored even when it equals the default', async () => {
    const calls = [];
    const global = {
        setAppSetting: async (k, v) => calls.push(['set', k, v]),
        deleteAppSetting: async k => calls.push(['delete', k]),
    };
    const setModel = new Function('global', 'currentAccountId',
        extractFunction(GEMINI, '_modelSettingKey') + '\n' +
        'return async ' + extractFunction(GEMINI, 'setModel') + ';')(global, 'a1');
    await setModel('gemini-flash-lite-latest');
    await setModel('gemini-flash-latest');
    assert.deepEqual(calls, [
        ['set', 'gemini-model:a1', 'gemini-flash-lite-latest'],
        ['set', 'gemini-model:a1', 'gemini-flash-latest'],
    ]);
});

// _callDirect sets fallbackReason for 503 / 429 / timeout only.
test('Gemini _callDirect: fallbackReason on 503, 429 and timeout; none on other errors', async () => {
    const make = fetchImpl => new Function('fetch', 'console',
        'var BASE_URL = "https://x/models/", TIMEOUT_MS = 120000, PROVIDER = "gemini";\n' +
        'var MODEL_NOT_FOUND_MSG = "nf";\n' +
        ['_isThinkingRejected', '_logAttempt', '_httpCategory', '_isModelNotFound', '_httpErrorMessage',
         '_errorResponse', '_networkErrorResponse'].map(n => extractFunction(GEMINI, n)).join('\n') + '\n' +
        'return async ' + extractFunction(GEMINI, '_callDirect') + ';'
    )(fetchImpl, quiet);
    const opts = { model: 'gemini-flash-latest', requestId: 'r', bodyStr: '{}', geminiBody: {}, timeoutMs: 1000 };
    const status = s => async () => ({ ok: false, status: s, json: async () => ({ error: { message: 'x' } }) });
    assert.equal((await make(status(503))(opts)).fallbackReason, 'http 503');
    assert.equal((await make(status(429))(opts)).fallbackReason, 'http 429');
    const abort = async () => { const e = new Error('aborted'); e.name = 'AbortError'; throw e; };
    assert.equal((await make(abort)(opts)).fallbackReason, 'timeout');
    assert.equal((await make(status(400))(opts)).fallbackReason, undefined);
    assert.equal((await make(status(500))(opts)).fallbackReason, undefined);
    assert.equal((await make(async () => { throw new TypeError('Failed to fetch'); })(opts)).fallbackReason, undefined);
});

// callWithFallback with a scripted call(): each entry answers one attempt.
function fallbackCall(script, nowSeq) {
    const calls = [], logs = [];
    let t = 0;
    const clock = { now: () => (nowSeq ? nowSeq[Math.min(t++, nowSeq.length - 1)] : 0) };
    const consts = ['TIMEOUT_MS', 'FALLBACK_MIN_REMAINING_MS', 'FALLBACK_FRESH_TIMEOUT_MS']
        .map(n => new RegExp('var ' + n + '\\s*=\\s*\\d+;').exec(GEMINI)[0]).join('\n');
    const fn = new Function('call', 'console', 'Date',
        consts + '\n' + /var FALLBACK_MODEL\s*=\s*'[^']+';/.exec(GEMINI)[0] + '\n' +
        'return async ' + extractFunction(GEMINI, 'callWithFallback') + ';'
    )(async (p, payload, id, cfg) => {
        calls.push(cfg);
        const r = script.shift();
        return Object.assign({ model: cfg.model || 'gemini-flash-latest' }, r);
    }, { log: (...a) => logs.push(a.join(' ')), warn() {}, error() {} }, clock);
    return { run: cfg => fn('p', {}, 'r1', cfg), calls, logs };
}

const FAIL = reason => ({ success: false, error: 'busy', fallbackReason: reason });
const GOOD = { success: true, rawText: 'ok' };

for (const reason of ['http 503', 'http 429', 'timeout']) {
    test('Gemini fallback: ' + reason + ' on a non-lite model retries once with gemini-flash-lite-latest', async () => {
        const f = fallbackCall([FAIL(reason), GOOD]);
        const resp = await f.run({ feature: 'cleanup', timeoutMs: 60000 });
        assert.equal(resp.success, true);
        assert.equal(f.calls.length, 2);
        assert.equal(f.calls[1].model, 'gemini-flash-lite-latest');
        assert.equal(f.calls[1].feature, 'cleanup');
        assert.equal(resp.model, 'gemini-flash-lite-latest');
        assert.equal(resp.fallbackFrom, 'gemini-flash-latest');
        assert.equal(resp.fallbackReason, reason);
        const line = f.logs.find(l => l.includes('Fallback'));
        assert.match(line, /originalModel=gemini-flash-latest/);
        assert.match(line, /fallbackModel=gemini-flash-lite-latest/);
        assert.match(line, new RegExp('reason=' + reason));
    });
}

test('Gemini fallback: remaining time is used, or a fresh 60 s when under 20 s remain', async () => {
    // 503 after 5 s of a 60 s budget → 55 s left.
    let f = fallbackCall([FAIL('http 503'), GOOD], [0, 5000]);
    await f.run({ timeoutMs: 60000 });
    assert.equal(f.calls[1].timeoutMs, 55000);
    // Timed out at 60 s → 0 left → fresh 60 s.
    f = fallbackCall([FAIL('timeout'), GOOD], [0, 60004]);
    await f.run({ timeoutMs: 60000 });
    assert.equal(f.calls[1].timeoutMs, 60000);
});

test('Gemini fallback: none when the model is already Flash-Lite, or for other errors', async () => {
    let f = fallbackCall([Object.assign(FAIL('http 503'), { model: 'gemini-flash-lite-latest' })]);
    let resp = await f.run({ model: 'gemini-flash-lite-latest' });
    assert.equal(resp.success, false);
    assert.equal(f.calls.length, 1);

    f = fallbackCall([Object.assign(FAIL('timeout'), { model: 'gemini-2.5-flash-lite' })]);
    await f.run({});
    assert.equal(f.calls.length, 1);

    f = fallbackCall([{ success: false, error: 'API key rejected.' }]);
    await f.run({});
    assert.equal(f.calls.length, 1);
});

test('Gemini fallback: a failing Flash-Lite answer is not retried; the original error is returned', async () => {
    const f = fallbackCall([FAIL('timeout'), { success: false, error: 'lite busy', fallbackReason: 'http 503' }]);
    const resp = await f.run({ timeoutMs: 60000 });
    assert.equal(f.calls.length, 2);
    assert.equal(resp.success, false);
    assert.equal(resp.error, 'busy');
    assert.equal(resp.fallbackFrom, undefined);
});

test('Gemini: the provider exposes callWithFallback as call', () => {
    assert.match(GEMINI, /call: callWithFallback,/);
});

test('Fallback note: text, and each feature shows it', () => {
    const INDEX = read('js/services/ai/index.js');
    const note = new Function('return ' + extractFunction(INDEX, 'fallbackNote'))();
    assert.equal(note({ success: true, fallbackFrom: 'gemini-flash-latest' }),
        'Answered with Flash-Lite because gemini-flash-latest was busy or slow.');
    assert.equal(note({ success: true }), '');
    assert.equal(note({ success: false, fallbackFrom: 'x' }), '');

    const AI = read('js/widgets/journal-ai.js');
    assert.ok(AI.includes("note: typeof DenAriiAI.fallbackNote === 'function' ? DenAriiAI.fallbackNote(resp) : ''"));
    assert.ok(AI.includes("'</div>' + fallbackNoteHtml(resp);"), 'Trade AI footer');
    assert.ok(AI.includes("bodyEl.insertAdjacentHTML('beforeend', fallbackNoteHtml(resp));"), 'Planner AI');
    assert.ok(AI.includes("rvFooter.insertAdjacentHTML('beforeend', fallbackNoteHtml(resp))"), 'Reflection AI');
    for (const f of ['daily-planner', 'weekly-planner', 'journal', 'reviews']) {
        assert.ok(read('js/pages/' + f + '.js').includes("(res.note ? ' ' + res.note : '')"), f);
    }
    assert.ok(read('js/ai-run.js').includes("ai.fallbackNote(resp)"), 'Run Analysis');
});

test('Clean Up: the note is returned with the block, never written into it', async () => {
    const noteText = 'Answered with Flash-Lite because gemini-flash-latest was busy or slow.';
    const AI = read('js/widgets/journal-ai.js');
    const src = extractFunction(AI, '_runCleanup');
    const run = new Function('DenAriiAI', '_planEditorText', '_cleanupToHtml', 'esc', 'friendlyError',
        'PLAN_CLEANUP_PARAGRAPH_FORMAT', 'PLAN_CLEANUP_FORMAT', 'return ' + src + ';')(
        { isConfigured: () => true, fallbackNote: r => (r.fallbackFrom ? noteText : ''),
          query: async () => ({ success: true, rawText: '- a', fallbackFrom: 'gemini-flash-latest' }) },
        () => 'text', () => '<ul><li>a</li></ul>', s => s, s => s, '', '');
    const res = await run({}, 'bullets', { label: 'Plan', emptyMsg: 'e', cutoffMsg: 'c', rules: () => 'r' });
    assert.equal(res.ok, true);
    assert.equal(res.note, noteText);
    assert.equal(res.block.includes('Flash-Lite'), false);
});

test('Settings: default option and hint text', () => {
    assert.ok(HTML.includes('<option value="gemini-flash-lite-latest">gemini-flash-lite-latest</option>'));
    assert.ok(HTML.includes('Flash-Lite is fastest and most reliable. Larger models may give deeper analysis but can be slow or busy; Denarii falls back to Flash-Lite automatically.'));
    const SETTINGS = read('js/pages/settings.js');
    assert.ok(SETTINGS.includes("let current = 'gemini-flash-lite-latest';"));
});
