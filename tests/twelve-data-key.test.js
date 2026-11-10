// User-supplied Twelve Data key: storage (js/services/market-data-key.js),
// Settings wiring, and how the chart uses it (js/pages/stock-chart.js).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fakeSupabase } = require('./helpers/fake-supabase');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const SERVICE = read('js/services/market-data-key.js');
const GEMINI = read('js/services/ai/gemini.js');
const CHART = read('js/pages/stock-chart.js');
const SETTINGS = read('js/pages/settings.js');
const HTML = read('index.html');
const CLOUD_CHECK = read('js/services/cloud-check.js');

const tick = () => new Promise(r => setImmediate(r));
async function settle(n) { for (let i = 0; i < (n || 40); i++) await tick(); }
const UID = 'u1';

// Fake encryption: readable in tests, fails with the wrong key.
const encrypt = (d, k) => 'E:' + k + ':' + JSON.stringify(d);
const decrypt = (s, k) => (typeof s === 'string' && s.indexOf('E:' + k + ':') === 0 ? JSON.parse(s.slice(('E:' + k + ':').length)) : null);

function keyBox(tables, over) {
    over = over || {};
    const client = over.client || fakeSupabase(tables || {}, { rev: true, pk: true });
    const settings = over.settingsStore || Object.assign({}, over.settings);
    const conflicts = [];
    const win = {
        encrypt, decrypt,
        setAppSetting: async (k, v) => { settings[k] = v; },
        getAppSetting: async k => settings[k],
        deleteAppSetting: async k => { delete settings[k]; },
        _sessionMatchesAccount: uid => uid === UID,
        _recordCloudConflict: (...a) => conflicts.push(a),
    };
    const SupabaseAuth = { isReady: () => true, getClient: () => client,
        supabaseGetSession: async () => ({ data: { user: { id: over.sessionUid || UID } } }) };
    const acct = over.acct || 'acct';
    new Function('window', 'SupabaseAuth', 'sessionDek', 'sessionPassword', 'currentAccountId', SERVICE)(
        win, SupabaseAuth, 'sessionDek' in over ? over.sessionDek : 'dek', null, acct);
    if (over.withGemini) {
        new Function('window', 'SupabaseAuth', 'sessionDek', 'sessionPassword', 'currentAccountId', 'localStorage', GEMINI)(
            win, SupabaseAuth, 'dek', null, acct, { getItem: () => null, removeItem() {} });
    }
    return { api: win.TwelveDataKey, gemini: win._DenAriiAIGemini, client, settings, conflicts };
}

// ── No key in code ─────────────────────────────────────────────────────────

test('no Twelve Data key is hard-coded in the chart, the key service or index.html', () => {
    for (const [name, src] of [['stock-chart.js', CHART], ['market-data-key.js', SERVICE], ['index.html', HTML]]) {
        assert.doesNotMatch(src, /['"`][0-9a-f]{32}['"`]/i, name + ' contains a 32-hex literal');
        assert.doesNotMatch(src, /TWELVE_DATA_API_KEY/, name);
    }
    assert.doesNotMatch(HTML, /edit the script|in the script section/i, 'footer no longer says to edit the script');
    assert.match(HTML, /Twelve Data API key from <strong>Settings → Integrations<\/strong>/);
});

// ── Storage ────────────────────────────────────────────────────────────────

test('save: encrypted with the account key, cached per account, synced to user_integration_keys only', async () => {
    const b = keyBox({ user_integration_keys: [], user_settings: [] });
    await b.api.saveApiKey('  TDKEY  ');
    await settle();
    assert.equal(b.api.getKey(), 'TDKEY');
    assert.equal(b.settings['twelvedata-api-key:acct'], encrypt('TDKEY', 'dek'));
    assert.ok(b.client.writes.length > 0);
    assert.ok(b.client.writes.every(w => w.table === 'user_integration_keys'), 'never writes user_settings');
    const row = b.client.tables.user_integration_keys[0];
    assert.equal(row.user_id, UID);
    assert.equal(row.provider, 'twelvedata');
    assert.equal(row.key_encrypted, encrypt('TDKEY', 'dek'));
    assert.ok(!JSON.stringify(b.client.tables).includes('"TDKEY"'), 'plaintext never reaches the cloud');
});

test('save without a session key fails with a plain message and stores nothing', async () => {
    const b = keyBox({ user_integration_keys: [] }, { sessionDek: null });
    await assert.rejects(b.api.saveApiKey('K'), /session is not ready/);
    assert.deepEqual(b.settings, {});
    await assert.rejects(b.api.saveApiKey('   '), /non-empty/);
});

test('load: the cloud copy wins over a stale browser cache; another device sees the key', async () => {
    const b = keyBox({ user_integration_keys: [{ user_id: UID, provider: 'twelvedata', key_encrypted: encrypt('CLOUD', 'dek'), rev: 4 }] },
        { settings: { 'twelvedata-api-key:acct': encrypt('STALE', 'dek') } });
    assert.equal(b.api.isLoaded(), false);
    await b.api.loadApiKey();
    assert.equal(b.api.isLoaded(), true);
    assert.equal(b.api.getKey(), 'CLOUD');
    assert.equal(b.settings['twelvedata-api-key:acct'], encrypt('CLOUD', 'dek'));
});

test('load: a key saved before the table existed is pushed to the cloud', async () => {
    const b = keyBox({ user_integration_keys: [] }, { settings: { 'twelvedata-api-key:acct': encrypt('LOCAL', 'dek') } });
    await b.api.loadApiKey();
    await settle();
    assert.equal(b.api.getKey(), 'LOCAL');
    assert.equal(b.client.tables.user_integration_keys[0].key_encrypted, encrypt('LOCAL', 'dek'));
});

test('load: cloud unavailable (table missing) falls back to the browser copy', async () => {
    const client = fakeSupabase({}, { fail: 'user_integration_keys' });
    const b = keyBox(null, { client, settings: { 'twelvedata-api-key:acct': encrypt('LOCAL', 'dek') } });
    await b.api.loadApiKey();
    assert.equal(b.api.getKey(), 'LOCAL');
});

test('save updates where rev matches; a change on another device wins and is kept as a conflict copy', async () => {
    const b = keyBox({ user_integration_keys: [{ user_id: UID, provider: 'twelvedata', key_encrypted: encrypt('A', 'dek'), rev: 2 }] });
    await b.api.loadApiKey();
    await b.api.saveApiKey('B');
    await settle();
    const up = b.client.writes.find(w => w.op === 'update');
    assert.equal(up.rows[0].rev, 2);
    assert.equal(up.rows[0].provider, 'twelvedata');
    assert.equal(b.client.tables.user_integration_keys[0].rev, 3);

    b.client.tables.user_integration_keys[0].key_encrypted = encrypt('OTHER', 'dek');
    b.client.tables.user_integration_keys[0].rev = 9;
    await b.api.saveApiKey('C');
    await settle();
    assert.equal(b.api.getKey(), 'OTHER');
    assert.equal(b.conflicts.length, 1);
    assert.equal(b.conflicts[0][0], 'user_integration_keys');
});

test('clear removes the browser copy and the cloud blob; unload clears memory only', async () => {
    const b = keyBox({ user_integration_keys: [] });
    await b.api.saveApiKey('K');
    await settle();
    b.api.unloadApiKey();
    assert.equal(b.api.getKey(), null);
    assert.equal(b.api.isLoaded(), false);
    assert.ok(b.settings['twelvedata-api-key:acct'], 'unload keeps the stored copy');
    await b.api.loadApiKey();
    assert.equal(b.api.getKey(), 'K');
    await b.api.clearApiKey();
    await settle();
    assert.equal(b.api.getKey(), null);
    assert.equal(b.settings['twelvedata-api-key:acct'], undefined);
    assert.equal(b.client.tables.user_integration_keys[0].key_encrypted, null);
});

test('another account on the same browser does not see the key', async () => {
    const shared = {};
    const a = keyBox({ user_integration_keys: [] }, { settingsStore: shared, acct: 'A' });
    await a.api.saveApiKey('KA');
    const other = keyBox({}, { settingsStore: shared, acct: 'B', client: fakeSupabase({}, { fail: 'user_integration_keys' }) });
    await other.api.loadApiKey();
    assert.equal(other.api.getKey(), null);
});

test('saving the Twelve Data key does not make the next Gemini save look changed elsewhere', async () => {
    const tables = {
        user_settings: [{ user_id: UID, gemini_key_encrypted: encrypt('G1', 'dek'), rev: 1 }],
        user_integration_keys: [],
    };
    const client = fakeSupabase(tables, { rev: true, pk: true });
    const b = keyBox(null, { client, withGemini: true });
    await b.gemini.loadApiKey();
    await b.api.loadApiKey();
    await b.api.saveApiKey('TD');
    await settle();
    await b.gemini.saveApiKey('G2');
    await settle();
    assert.equal(b.conflicts.length, 0);
    assert.equal(tables.user_settings[0].gemini_key_encrypted, encrypt('G2', 'dek'));
    assert.equal(tables.user_settings[0].rev, 2);
    assert.equal(tables.user_integration_keys[0].key_encrypted, encrypt('TD', 'dek'));
});

// ── Chart: no key / errors ────────────────────────────────────────────────

function domStub() {
    const els = {};
    return {
        els,
        getElementById(id) {
            return els[id] || (els[id] = { id, textContent: '', innerHTML: '', style: {}, value: '5m', clientWidth: 800 });
        },
    };
}

function chartBox(over) {
    const doc = domStub();
    const calls = [];
    const win = { addEventListener() {} };
    const fetch = async url => { calls.push(url); return over.fetch(url); };
    new Function('window', 'document', 'journalData', 'LightweightCharts', 'TwelveDataKey', 'fetch', 'openModal', 'closeModal', CHART)(
        win, doc, { trades: [] }, { CrosshairMode: {}, createChart() { throw new Error('should not draw'); } },
        over.TwelveDataKey, fetch, () => {}, () => {});
    return { win, doc, calls };
}
const keyStub = key => ({ isLoaded: () => true, getKey: () => key, loadApiKey: async () => {} });

test('no key saved: the chart asks for one in Settings → Integrations and sends no request', async () => {
    let loaded = 0;
    const b = chartBox({
        TwelveDataKey: { isLoaded: () => false, getKey: () => null, loadApiKey: async () => { loaded++; } },
        fetch: () => { throw new Error('no request expected'); },
    });
    await b.win.openStockChart('TSLA', '2026-11-02T09:30:55', null, 2.31, null, '5m');
    assert.equal(loaded, 1, 'loads the saved key first');
    assert.equal(b.calls.length, 0);
    const html = b.doc.els['chart-loading'].innerHTML;
    assert.match(html, /Add your Twelve Data API key in Settings → Integrations/);
    assert.match(html, /switchSettingsTab\('settings-integrations'\)/);
});

test('the user key is the one sent to Twelve Data', async () => {
    const b = chartBox({ TwelveDataKey: keyStub('USERKEY'),
        fetch: async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok', values: [] }) }) });
    await b.win.openStockChart('TSLA', '2026-11-02T09:30:55', null, 2.31, null, '5m');
    assert.equal(b.calls.length, 1);
    assert.equal(new URL(b.calls[0]).searchParams.get('apikey'), 'USERKEY');
});

async function errorText(response, opts) {
    const b = chartBox({ TwelveDataKey: keyStub('SECRETKEY123'), fetch: async () => {
        if (response instanceof Error) throw response;
        return response;
    } });
    await b.win.openStockChart((opts && opts.symbol) || 'TSLA', '2026-11-02T09:30:55', null, 2.31, null, '5m');
    const html = b.doc.els['chart-loading'].innerHTML;
    assert.doesNotMatch(html, /SECRETKEY123/, 'the key is never shown');
    return html;
}
const jsonResp = (status, body) => ({ ok: status < 400, status, json: async () => body });

test('request errors show a plain reason', async () => {
    assert.match(await errorText(jsonResp(200, { code: 401, status: 'error',
        message: '**apikey** parameter is incorrect or not specified. SECRETKEY123' })), /API key was rejected/);
    assert.match(await errorText(jsonResp(401, null)), /API key was rejected/);
    assert.match(await errorText(jsonResp(200, { code: 404, status: 'error',
        message: '**symbol** not found: ZZZZ. Please specify it correctly' }), { symbol: 'zzzz' }), /doesn&#39;t recognise symbol ZZZZ/);
    assert.match(await errorText(jsonResp(200, { code: 400, status: 'error',
        message: '**symbol** or **figi** parameter is missing or invalid.' })), /doesn&#39;t recognise symbol TSLA/);
    assert.match(await errorText(jsonResp(200, { code: 429, status: 'error',
        message: 'You have run out of API credits for the current minute.' })), /rate limit reached/);
    assert.match(await errorText(jsonResp(429, null)), /rate limit reached/);
    assert.match(await errorText(jsonResp(200, { code: 403, status: 'error', message: 'Upgrade needed' })), /plan does not include/);
    assert.match(await errorText(jsonResp(500, null)), /HTTP 500 while requesting Twelve Data/);
    assert.match(await errorText(new TypeError('Failed to fetch')), /Couldn&#39;t reach Twelve Data/);
    assert.match(await errorText(jsonResp(200, { status: 'ok', values: [] })), /No chart data returned/);
});

test('error text from Twelve Data is escaped and the key is redacted', () => {
    const { describeTwelveDataError } = chartBox({ TwelveDataKey: keyStub('K'), fetch: async () => null }).win.StockChartMarkers;
    assert.equal(describeTwelveDataError(200, { code: 418, message: 'odd thing ABCKEY happened' }, 'TSLA', 'ABCKEY'),
        'Twelve Data: odd thing *** happened');
});

// ── Settings / lock / diagnostics wiring ──────────────────────────────────

test('Settings → Integrations has a Twelve Data block beside the unchanged Gemini block', () => {
    const panel = HTML.slice(HTML.indexOf('id="settings-integrations"'), HTML.indexOf('id="settings-conflicts"'));
    assert.match(panel, /<h3[^>]*>Gemini API Key<\/h3>/);
    assert.match(panel, /onclick="saveGeminiApiKey\(\)"/);
    assert.match(panel, /<h3[^>]*>Twelve Data API Key<\/h3>/);
    assert.match(panel, /id="settings-twelvedata-key"/);
    assert.match(panel, /onclick="saveTwelveDataApiKey\(\)"/);
    assert.match(panel, /id="settings-twelvedata-remove-btn" onclick="removeTwelveDataApiKey\(\)"/);
    assert.match(panel, /href="https:\/\/twelvedata\.com\/pricing" target="_blank" rel="noopener noreferrer"/);
    assert.match(SETTINGS, /window\.saveTwelveDataApiKey\s*=\s*saveTwelveDataApiKey/);
    assert.match(SETTINGS, /window\.removeTwelveDataApiKey\s*=\s*removeTwelveDataApiKey/);
    assert.match(SETTINGS, /loadTwelveDataSettings\(\);\r?\n\s*if \(typeof DenAriiAI === 'undefined'\) return;/);
});

test('the key service loads before the chart and settings scripts', () => {
    const at = s => HTML.indexOf(s);
    assert.ok(at('js/services/market-data-key.js?v=') > 0);
    assert.ok(at('js/services/market-data-key.js?v=') < at('js/pages/stock-chart.js?v='));
    assert.ok(at('js/services/market-data-key.js?v=') < at('js/pages/settings.js?v='));
});

test('lock clears the key from memory; password change re-encrypts it on legacy accounts', () => {
    assert.match(read('js/auth.js'), /DenAriiAI\.unloadApiKey\(\);\r?\n\s*if \(typeof TwelveDataKey !== 'undefined'\) TwelveDataKey\.unloadApiKey\(\);/);
    assert.match(SETTINGS, /TwelveDataKey\.reencryptApiKey\(\)/);
});

test('cloud check reports the Twelve Data key as present / absent only', () => {
    const i = CLOUD_CHECK.indexOf("user_integration_keys (Twelve Data key)");
    assert.ok(i > 0);
    const block = CLOUD_CHECK.slice(CLOUD_CHECK.indexOf('// user_integration_keys'), CLOUD_CHECK.indexOf('// journal_backups'));
    assert.match(block, /\.eq\('provider', 'twelvedata'\)/);
    assert.doesNotMatch(block, /console\.log/);
    // line() gets only fixed wording, never the blob itself.
    const lineCalls = block.match(/line\([^;]*;/gs).join('\n');
    assert.doesNotMatch(lineCalls, /\+\s*tCloud\b|\+\s*tCached\b|tk\.data\.key_encrypted\s*\+/);
});

