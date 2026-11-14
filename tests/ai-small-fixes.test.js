// AI and small fixes (port 4):
//  - The Gemini key goes in the x-goog-api-key header, never in a request URL
//    (generateContent and ListModels). Still only the user's own key; no proxy.
//  - The AI payload says one account is selected, never which account id.
//  - The dev AI test page is off unless config.js turns it on.
//  - A sidebar flyout click also runs the item's own inline handler.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const GEMINI = read('js/services/ai/gemini.js');
const AI_INDEX = read('js/services/ai/index.js');
const CONFIG = read('js/config/config.js');
const NAV = read('js/nav.js');

function extractFunction(src, name) {
    const start = src.indexOf('function ' + name + '(');
    if (start < 0) throw new Error(name + ' not found');
    const isAsync = src.slice(start - 6, start) === 'async ';
    let depth = 0;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) return (isAsync ? 'async ' : '') + src.slice(start, i + 1);
    }
    throw new Error(name + ': unbalanced braces');
}

const quiet = { log() {}, warn() {}, error() {} };

// ── Gemini key in a header ──────────────────────────────────────────────────

test('generateContent: the key is sent in x-goog-api-key, not in the URL', async () => {
    const calls = [];
    const callDirect = new Function('fetch', 'BASE_URL', 'TIMEOUT_MS', '_logAttempt', '_successOrShapeError', 'console',
        'return ' + extractFunction(GEMINI, '_callDirect') + ';')(
        async (url, init) => { calls.push({ url, init }); return { ok: true, status: 200, json: async () => ({ ok: 1 }) }; },
        'https://generativelanguage.googleapis.com/v1beta/models/', 1000, () => {}, (o, d) => ({ success: true, data: d }), quiet);
    const res = await callDirect({ model: 'gemini-flash-latest', apiKey: 'USER-KEY-123', bodyStr: '{}', requestId: 'r1' });
    assert.equal(res.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://generativelanguage.googleapis.com/v1beta/models/gemini-flash-latest:generateContent');
    assert.ok(!calls[0].url.includes('USER-KEY-123'));
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'USER-KEY-123');
    assert.equal(calls[0].init.headers['Content-Type'], 'application/json');
    assert.ok(!calls[0].init.body.includes('USER-KEY-123'));
});

test('ListModels: the key is sent in x-goog-api-key, not in the URL', async () => {
    const calls = [];
    const listModels = new Function('fetch', '_getApiKey', 'console', 'LIST_MODELS_URL',
        'return ' + extractFunction(GEMINI, 'listModels').replace(/^function/, 'async function') + ';')(
        async (url, init) => { calls.push({ url, init }); return { ok: true, json: async () => ({ models: [] }) }; },
        () => 'USER-KEY-123', quiet, 'https://generativelanguage.googleapis.com/v1beta/models');
    await listModels();
    assert.equal(calls.length, 1);
    assert.ok(!calls[0].url.includes('USER-KEY-123'));
    assert.ok(!/[?&]key=/.test(calls[0].url));
    assert.equal(calls[0].init.headers['x-goog-api-key'], 'USER-KEY-123');
});

test('no Gemini request puts the key in a URL; the proxy stays off', () => {
    assert.doesNotMatch(GEMINI, /[?&]key=/);
    assert.match(CONFIG, /window\.DENARII_CONFIG\.AI_DEFAULT_PROXY = false;/);
});

// ── AI payload: no account id ───────────────────────────────────────────────

test('AI payload: one account selected is sent as singleAccount, never the account id', () => {
    const ctx = { console: quiet };
    ctx.window = ctx;
    vm.createContext(ctx);
    for (const f of ['js/shared/filter-bar.js', 'js/services/ai/formatter.js']) vm.runInContext(read(f), ctx);
    const trades = [
        { id: 1, symbol: 'ZZA', type: 'long', quantity: 1, entryPrice: 1, exitPrice: 2, pnl: 1,
          entryTime: '2026-10-20T14:30:00.000Z', exitTime: '2026-10-20T15:00:00.000Z', brokerAccountId: 'ba_secret_77' },
        { id: 2, symbol: 'ZZB', type: 'long', quantity: 1, entryPrice: 1, exitPrice: 0.5, pnl: -0.5,
          entryTime: '2026-10-21T14:30:00.000Z', exitTime: '2026-10-21T15:00:00.000Z', brokerAccountId: 'other' },
    ];
    const payload = ctx._DenAriiAIFormatter.buildPayload({ tradeData: trades, accountFilter: 'ba_secret_77' });
    assert.equal(payload.filters.singleAccount, true);
    assert.equal('account' in payload.filters, false);
    assert.ok(!JSON.stringify(payload).includes('ba_secret_77'));
    const all = ctx._DenAriiAIFormatter.buildPayload({ tradeData: trades, accountFilter: 'all' });
    assert.equal('singleAccount' in all.filters, false);
});

// ── Dev AI test page ────────────────────────────────────────────────────────

test('AI test page: off in config, the query and the route check the flag', () => {
    assert.match(CONFIG, /window\.DENARII_CONFIG\.ENABLE_AI_TEST_PAGE = false;/);
    assert.match(extractFunction(AI_INDEX, 'runTestQuery'), /if \(!_aiTestPageEnabled\(\)\) return;/);
    const at = AI_INDEX.indexOf("if (window.location.hash === '#ai-test') {");
    assert.ok(at > 0);
    assert.match(AI_INDEX.slice(at, at + 500), /_aiTestPageEnabled\(\)[\s\S]*activateSection\('dashboard'\)/);
});

test('AI test page: the flag reads DENARII_CONFIG and defaults to off', () => {
    const enabled = cfg => new Function('global', extractFunction(AI_INDEX, '_aiTestPageEnabled') +
        '\nreturn _aiTestPageEnabled();')({ DENARII_CONFIG: cfg });
    assert.equal(enabled(undefined), false);
    assert.equal(enabled({}), false);
    assert.equal(enabled({ ENABLE_AI_TEST_PAGE: false }), false);
    assert.equal(enabled({ ENABLE_AI_TEST_PAGE: true }), true);
});

// ── Sidebar flyout ──────────────────────────────────────────────────────────

test('sidebar flyout: a click also runs the matching sidebar item\'s inline handler', () => {
    const fn = extractFunction(NAV, 'showSidebarFlyout');
    assert.match(fn, /forEach\(function \(btn, i\) \{/);
    assert.match(fn, /activateSection\(tab\);\s*\/\/[^\n]*\n[^\n]*\n\s*if \(typeof children\[i\]\.onclick === 'function'\) children\[i\]\.onclick\(\);/);
});
