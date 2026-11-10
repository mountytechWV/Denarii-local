// Bug batch 1:
// 1. Run Analysis shows the trades actually sent to Gemini ("300 trades
//    analyzed (most recent)" when trimmed) and saves that count with the
//    report so Saved Reports show it.
// 2. Broker Accounts card cache (last-sync times, "needs re-approval") is
//    cleared on sign-out/Lock; a check still in flight is dropped.
// 3. Settings → Conflict Copies: read-only list of D3 conflict copies kept in
//    this browser, with "Clear all" behind an app-styled confirm.
//
// Browser scripts: functions are cut out of the source with brace matching
// (as webull-ui.test.js does) and run with stubbed globals.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const HTML = read('index.html');
const GEMINI = read('js/services/ai/gemini.js');
const RUN = read('js/ai-run.js');
const REPORTS = read('js/ai-reports.js');
const BA = read('js/pages/broker-accounts.js');
const AUTH = read('js/auth.js');
const SETTINGS = read('js/pages/settings.js');

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

function between(src, from, to) {
    const a = src.indexOf(from), b = src.indexOf(to, a);
    if (a < 0 || b < 0) throw new Error('block not found: ' + from);
    return src.slice(a, b);
}

const quiet = { log() {}, warn() {}, error() {} };

// ── 1. Run Analysis trade count ─────────────────────────────────────────────

function makeGeminiCall() {
    const consts = ['TIMEOUT_MS', 'PAYLOAD_CHAR_LIMIT', 'PAYLOAD_TRIM_TO', 'DEFAULT_MAX_OUTPUT_TOKENS', 'DEFAULT_THINKING_BUDGET']
        .map(n => new RegExp('var ' + n + '\\s*=\\s*\\d+;').exec(GEMINI)[0]).join('\n');
    return new Function('console', '_callDirect',
        consts + '\n' +
        'var PROVIDER = "gemini", DEFAULT_MODEL = "m";\n' +
        'function _buildPromptText(p, payload) { return p; }\n' +
        'function _djb2() { return "fp"; }\n' +
        'function _getApiKey() { return "key"; }\n' +
        'function _defaultProxyAvailable() { return false; }\n' +
        'async function getModel() { return DEFAULT_MODEL; }\n' +
        'var DEFAULT_THINKING_LEVEL = "low";\n' +
        extractFunction(GEMINI, '_thinkingConfig') + '\n' +
        extractFunction(GEMINI, '_guardPayloadSize') + '\n' +
        'return async ' + extractFunction(GEMINI, 'call') + ';'
    )(quiet, async () => ({ success: true, rawText: 'ok' }));
}

const bigTrades = n => Array.from({ length: n }, (_, i) => ({ id: 't' + i, note: 'x'.repeat(200) }));

test('Gemini response carries the trades actually sent and the pre-trim count', async () => {
    const call = makeGeminiCall();
    const trimmed = await call('p', { summary: {}, trades: bigTrades(1570) }, 'r1', {});
    assert.equal(trimmed.tradesSent, 300);
    assert.equal(trimmed.tradesTrimmedFrom, 1570);

    const plain = await call('p', { summary: {}, trades: bigTrades(12) }, 'r2', {});
    assert.equal(plain.tradesSent, 12);
    assert.equal(plain.tradesTrimmedFrom, null);
});

test('Gemini: the trim itself is unchanged (still the most recent 300)', () => {
    assert.match(GEMINI, /var PAYLOAD_TRIM_TO = 300;/);
    assert.ok(GEMINI.includes('trades: payload.trades.slice(-PAYLOAD_TRIM_TO),'));
    assert.equal((GEMINI.match(/\}\)\.then\(stampSent\);/g) || []).length, 2, 'direct and proxy paths both stamp');
});

test('Run Analysis label: "(most recent)" only when trimmed', () => {
    const label = new Function('return ' + extractFunction(RUN, '_tradeCountLabel'))();
    assert.equal(label(300, true), '300 trades analyzed (most recent)');
    assert.equal(label(12, false), '12 trades analyzed');
    assert.equal(label(1, false), '1 trade analyzed');
});

test('Run Analysis header uses the sent count, and saveOutput stores it', () => {
    const exec = extractFunction(RUN, 'execute');
    assert.ok(exec.includes('_lastAnalysisMeta.tradeCount    = resp.tradesSent;'));
    assert.ok(exec.includes('_lastAnalysisMeta.tradesTrimmed = !!resp.tradesTrimmedFrom;'));
    assert.ok(extractFunction(RUN, '_renderDataSummary').includes('_tradeCountLabel(m.tradeCount, m.tradesTrimmed)'));
    const save = extractFunction(RUN, 'saveOutput');
    assert.ok(save.includes('filters.tradeCount    = _lastAnalysisMeta.tradeCount;'));
    assert.ok(save.includes('filters.tradesTrimmed = !!_lastAnalysisMeta.tradesTrimmed;'));
    // Flipped by the filter bar work: only what the shared filter selects is sent.
    assert.ok(exec.includes('tradeData: selectedTrades,'));
});

test('Saved Reports show the saved count; older reports show nothing', () => {
    const text = new Function('return ' + extractFunction(REPORTS, '_tradeCountText'))();
    assert.equal(text({ tradeCount: 300, tradesTrimmed: true }), '300 trades analyzed (most recent)');
    assert.equal(text({ tradeCount: 42, tradesTrimmed: false }), '42 trades analyzed');
    assert.equal(text({ dateRange: null }), '');
    assert.equal(text(null), '');
    assert.ok(REPORTS.includes("_esc(countText)"), 'list card');
    assert.ok(REPORTS.includes("_esc(viewerCount)"), 'viewer header');
});

// ── 2. Broker card cache on sign-out / Lock ─────────────────────────────────

function makeCardCache() {
    const block = between(BA, 'const WB_CARD_TTL_MS', 'async function _wbRefreshCardFlags') +
        'async ' + extractFunction(BA, '_wbRefreshCardFlags');
    const env = { renders: 0, pending: null };
    // status() from window.denariiWebull (local database, no Webull call).
    env.rows = { connected: true, approvalState: 'needs_approval', links: [{ journalId: 'j1', lastSyncedAt: '2026-10-28T10:00:00Z' }] };
    const api = new Function('_wbStatus', 'renderBrokerAccountsList',
        block + '\nreturn { refresh: _wbRefreshCardFlags, clear: _clearBrokerCardCache,' +
        ' state: () => ({ needs: wbCardNeedsApproval, sync: wbCardLastSync, checking: wbCardChecking }) };'
    )(() => env.pending || Promise.resolve(env.rows), () => { env.renders++; });
    return { api, env };
}

test('card cache fills from a check and clears on sign-out', async () => {
    const { api } = makeCardCache();
    await api.refresh();
    assert.deepEqual([...api.state().needs], ['j1']);
    assert.equal(api.state().sync.get('j1'), '2026-10-28T10:00:00Z');

    api.clear();
    assert.equal(api.state().needs.size, 0);
    assert.equal(api.state().sync.size, 0);

    // Next sign-in reloads straight away (the TTL was reset).
    await api.refresh();
    assert.deepEqual([...api.state().needs], ['j1']);
});

test('a check in flight at sign-out does not bring the old lines back', async () => {
    const { api, env } = makeCardCache();
    let resolve;
    env.pending = new Promise(r => { resolve = r; });
    const p = api.refresh();
    api.clear();
    resolve(env.rows);
    await p;
    assert.equal(api.state().needs.size, 0);
    assert.equal(api.state().sync.size, 0);
    assert.equal(env.renders, 0);
});

test('Lock calls the clear, then signs out as before', () => {
    const calls = [];
    const window = {
        _clearAllDrafts: () => calls.push('drafts'),
        _clearBrokerCardCache: () => calls.push('cards')
    };
    const location = { reload: () => calls.push('reload') };
    new Function('window', 'location', 'SupabaseAuth', 'console',
        'var _lockPending, sessionPassword = "p", sessionDek = "d";\n' +
        extractFunction(AUTH, '_completeLock') + '\n_completeLock();'
    )(window, location, undefined, quiet);
    assert.deepEqual(calls, ['drafts', 'cards', 'reload']);
    assert.ok(BA.includes('window._clearBrokerCardCache          = _clearBrokerCardCache;'));
});

// ── 3. Conflict Copies in Settings ──────────────────────────────────────────

function makeConflicts(initial) {
    const block = between(SETTINGS, '// ── Conflict Copies (read-only) ──', '// ── Expose public API to window ──');
    const els = {};
    const el = id => els[id] || (els[id] = { id, innerHTML: '', disabled: false, style: {} });
    const store = new Map(Object.entries(initial || {}));
    const env = { store, els, opened: [], closed: [], msgs: [] };
    const window = {
        getAppSetting: async k => store.get(k),
        deleteAppSetting: async k => { store.delete(k); }
    };
    const document = { getElementById: el };
    const escapeHtml = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
    const decrypt = (blob) => JSON.parse(blob.slice(4));
    env.api = new Function('window', 'document', 'escapeHtml', 'decrypt', 'openModal', 'closeModal', 'showSettingsMsg',
        'currentAccountId', 'sessionDek', '_conflictChain',
        block + '\nreturn { load: loadConflictCopies, open: openClearConflictCopies, clear: confirmClearConflictCopies };'
    )(window, document, escapeHtml, decrypt, id => env.opened.push(id), id => env.closed.push(id),
        (e, m, err) => env.msgs.push([m, err]), 'acct1', 'dek', Promise.resolve());
    return env;
}

const enc = v => 'enc:' + JSON.stringify(v);

test('empty: "No conflict copies" and Clear all disabled', async () => {
    const env = makeConflicts();
    await env.api.load();
    assert.ok(env.els['settings-conflicts-list'].innerHTML.includes('No conflict copies'));
    assert.equal(env.els['settings-conflicts-clear-btn'].disabled, true);
});

test('lists data type, item name/date and when kept, newest first, escaped', async () => {
    const env = makeConflicts({
        'cloudConflicts:acct1': [
            { domain: 'trades', key: 't1', at: '2026-10-01T12:00:00Z', local: enc({ symbol: 'AAPL', entryDate: '2026-09-30' }) },
            { domain: 'strategies', key: 's1', at: '2026-10-02T12:00:00Z', local: enc({ name: '<b>Gap</b>' }) },
            { domain: 'dailyPlanners', key: '2026-10-03', at: '2026-10-03T12:00:00Z', local: null }
        ]
    });
    await env.api.load();
    const html = env.els['settings-conflicts-list'].innerHTML;
    assert.equal(env.els['settings-conflicts-clear-btn'].disabled, false);
    for (const s of ['Trade', 'AAPL · 2026-09-30', 'Strategy', '&lt;b&gt;Gap&lt;/b&gt;', 'Daily planner', '2026-10-03', 'Data type', 'Kept']) {
        assert.ok(html.includes(s), s);
    }
    assert.ok(!html.includes('<b>Gap'));
    assert.ok(html.indexOf('Daily planner') < html.indexOf('Strategy') && html.indexOf('Strategy') < html.indexOf('AAPL'), 'newest first');
    assert.ok(!/restore/i.test(html), 'no restore button');
});

test('Clear all: app-styled confirm, removes only this browser\'s conflict list', async () => {
    const env = makeConflicts({
        'cloudConflicts:acct1': [{ domain: 'tags', key: 'x', at: '2026-10-01T00:00:00Z', local: null }],
        'cloudConflicts:other': [{ domain: 'tags', key: 'y', at: '2026-10-01T00:00:00Z', local: null }],
        'journal:acct1': 'live data'
    });
    env.api.open();
    assert.deepEqual(env.opened, ['conflict-clear-modal']);
    await env.api.clear();
    assert.deepEqual(env.closed, ['conflict-clear-modal']);
    assert.equal(env.store.has('cloudConflicts:acct1'), false);
    assert.equal(env.store.get('journal:acct1'), 'live data');
    assert.ok(env.store.has('cloudConflicts:other'));
    assert.ok(env.els['settings-conflicts-list'].innerHTML.includes('No conflict copies'));
});

test('Conflict Copies code: no window.confirm, no cloud calls', () => {
    const block = between(SETTINGS, '// ── Conflict Copies (read-only) ──', '// ── Expose public API to window ──');
    assert.ok(!/\bconfirm\(/.test(block.replace(/confirmClearConflictCopies\(/g, '')));
    for (const s of ['SupabaseAuth', '.from(', 'journalData', '_cloud', 'saveToIndexedDB']) assert.ok(!block.includes(s), s);
});

test('index.html: Conflict Copies after Integrations, panel, confirm modal', () => {
    const integ = HTML.indexOf("data-settings-tab=\"settings-integrations\"");
    const conf = HTML.indexOf("data-settings-tab=\"settings-conflicts\"");
    assert.ok(integ > 0 && conf > integ);
    assert.ok(HTML.includes('<div class="settings-panel" id="settings-conflicts">'));
    assert.ok(HTML.includes('<div id="conflict-clear-modal" class="modal"'));
    assert.ok(HTML.includes('onclick="confirmClearConflictCopies()"'));
    assert.ok(SETTINGS.includes("if (tabId === 'settings-conflicts')"));
});

// ── Follow-ups: Run Analysis page ───────────────────────────────────────────

// init / prompt / output / save functions from ai-run.js with the page's
// state as plain vars, a fake DOM and stubbed renderers.
function makeRunPage(opts) {
    opts = opts || {};
    const els = {};
    const el = id => els[id] || (els[id] = {
        id, value: '', innerHTML: '', textContent: '', style: {}, disabled: false, listeners: [],
        classList: { on: new Set(), contains(c) { return this.on.has(c); } },
        addEventListener(type, fn) { this.listeners.push(fn); }
    });
    const env = { el, log: [], toasts: [] };
    const window = { filterBrokerAccountId: 'all' };
    const journalData = {
        trades: [{ id: 't1', brokerAccountId: 'wb' }, { id: 't2', brokerAccountId: 'wb' }, { id: 't3', brokerAccountId: 'other' }],
        aiOutputHistory: []
    };
    const global = {
        _DenAriiAIFormatter: {
            buildPayload: req => ({ trades: req.tradeData.filter(t => !req.accountFilter || t.brokerAccountId === req.accountFilter) })
        },
        _DenAriiPrompts: { getPromptById: id => ({ id, promptText: 'prompt ' + id }) }
    };
    const fns = ['init', '_brokerAccounts', '_findAccount', '_rerunAccountGone', '_selectedTrades', '_readFilters', '_totalTradeCount', '_computeFilteredCount', '_updateTradeCount', '_applyPromptToForm', 'onPromptSelectChange',
        '_renderOutput', '_renderDataSummary', '_tradeCountLabel', '_clearOutput', '_esc',
        '_cutOffNoticeHtml']
        .map(n => extractFunction(RUN, n)).join('\n') + '\nasync ' + extractFunction(RUN, 'saveOutput');
    const barWin = {};
    new Function('window', 'document', read('js/shared/filter-bar.js'))(barWin, { getElementById: el });
    env.api = new Function('document', 'window', 'journalData', 'global', 'console', 'setTimeout', 'env', 'DenariiFilters',
        'var _lastResponse = null, _lastAnalysisMeta = null, _lastParsedStructured = null, _lastRenderedReportData = null;\n' +
        'var _selectedPromptId = null, _lastCutOff = false, _CUT_OFF_MSG = "cut off", _rerunAccount = null;\n' +
        'function _isCutOff(r) { return !!(r && r.truncated); }\n' +
        'function _populatePromptSelector() {} function _populateStrategyFilter() {} function _restoreDateRange() {}\n' +
        'function _applyTimeframePreset() {} function _showState() {} function _setRunStatus() {}\n' +
        'function _hasBodyContent() { return true; } function _buildFallbackReport() { return {}; }\n' +
        'function _renderReport() { return "BODY"; } function _updateMetaBadges() {}\n' +
        'function _showOutputToast(m) { env.toasts.push(m); }\n' +
        'function _isCloudPrimarySave() { return true; }\n' +
        'function _saveAiReportToSupabase(entry) { env.log.push("cloud-start"); return env.cloudSave(entry); }\n' +
        'async function saveToIndexedDB() { env.log.push("idb"); }\n' +
        fns + '\n' +
        'return { init, onPromptSelectChange, saveOutput,' +
        ' set: s => { if ("resp" in s) _lastResponse = s.resp; if ("meta" in s) _lastAnalysisMeta = s.meta; if ("prompt" in s) _selectedPromptId = s.prompt; },' +
        ' get: () => ({ resp: _lastResponse, meta: _lastAnalysisMeta }) };'
    )({ getElementById: el }, window, journalData, global, quiet, opts.setTimeout || setTimeout, env, barWin.DenariiFilters);
    env.window = window;
    env.journalData = journalData;
    env.cloudSave = async () => { await null; env.log.push('cloud-done'); return { success: true }; };
    return env;
}

// Mirrors the header select: its inline onchange (applyGlobalFilters) sets
// the global first, then listeners added by init run.
function pickAccount(env, value) {
    env.window.filterBrokerAccountId = value;
    env.el('filter-broker-account').listeners.forEach(fn => fn());
}

test('Trades Selected recounts when the header account changes while Run Analysis is open', () => {
    const env = makeRunPage();
    const count = () => env.el('ai-run-trade-count-val').textContent;
    env.api.init();
    assert.equal(count(), '3 of 3');

    // Another page is open: no recount.
    pickAccount(env, 'wb');
    assert.equal(count(), '3 of 3');

    // Run Analysis open: recounts at once.
    env.el('ai-run').classList.on.add('active');
    pickAccount(env, 'wb');
    assert.equal(count(), '2 of 3');
    pickAccount(env, 'all');
    assert.equal(count(), '3 of 3');

    // Revisiting the page does not bind a second listener.
    env.api.init();
    assert.equal(env.el('filter-broker-account').listeners.length, 1);
});

test('back from Saved Reports: the restored result keeps its count header', () => {
    const env = makeRunPage();
    env.api.set({ resp: { success: true, rawText: 'x' }, meta: { tradeCount: 300, tradesTrimmed: true }, prompt: 'p1' });
    env.api.init();
    assert.equal(env.el('ai-run-output').innerHTML, 'BODY');
    assert.ok(env.el('ai-run-data-summary').innerHTML.includes('300 trades analyzed (most recent)'));
    assert.equal(env.api.get().meta.tradeCount, 300);
});

test('picking a different prompt clears body and header together; a revisit restores neither', () => {
    const env = makeRunPage();
    env.api.set({ resp: { success: true, rawText: 'x' }, meta: { tradeCount: 12, tradesTrimmed: false }, prompt: 'p1' });
    env.api.init();
    env.api.onPromptSelectChange('p2');
    assert.equal(env.api.get().resp, null);
    assert.equal(env.el('ai-run-output').innerHTML, '');
    assert.equal(env.el('ai-run-data-summary').innerHTML, '');
    env.api.init();
    assert.equal(env.el('ai-run-output').innerHTML, '');
    assert.equal(env.el('ai-run-data-summary').innerHTML, '');
});

const savedResp = { success: true, rawText: 'report', requestId: 'r1', provider: 'gemini', model: 'm' };

test('Save to Reports: the cloud save finishes before the journal save (no second insert)', async () => {
    const env = makeRunPage();
    env.api.set({ resp: savedResp, meta: { tradeCount: 300, tradesTrimmed: true } });
    await env.api.saveOutput();
    assert.deepEqual(env.log, ['cloud-start', 'cloud-done', 'idb']);
    assert.equal(env.journalData.aiOutputHistory.length, 1);
    assert.equal(env.journalData.aiOutputHistory[0].id, 'out-r1');
    assert.equal(env.journalData.aiOutputHistory[0].filters.tradeCount, 300);
    assert.deepEqual(env.toasts, ['Output saved to history.']);
});

test('Save to Reports: a stalled cloud save does not block the local save', async () => {
    const env = makeRunPage({ setTimeout: fn => fn() });
    env.cloudSave = () => new Promise(() => {});
    env.api.set({ resp: savedResp, meta: { tradeCount: 5, tradesTrimmed: false } });
    await env.api.saveOutput();
    assert.deepEqual(env.log, ['cloud-start', 'idb']);
    assert.equal(env.journalData.aiOutputHistory.length, 1);
});

// ── Versions ────────────────────────────────────────────────────────────────

test('index.html: changed scripts bumped', () => {
    // At least these versions (later batches bump them again).
    for (const s of ['js/auth.js?v=37', 'js/services/ai/gemini.js?v=3', 'js/ai-run.js?v=3', 'js/ai-reports.js?v=2',
        'js/pages/settings.js?v=8', 'js/pages/broker-accounts.js?v=12']) {
        const [file, min] = s.split('?v=');
        assert.ok(Number(HTML.split('src="' + file + '?v=')[1].split('"')[0]) >= Number(min), s);
    }
});
