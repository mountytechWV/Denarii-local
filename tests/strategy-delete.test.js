// Deleting a strategy clears its exactly matching trades with one bulk UPDATE,
// changes nothing when a check fails, and never comes back through the backfill.
// Same harness as strategy-rename.test.js.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const D3 = require('./helpers/d3-auth-fns');
const { fakeSupabase } = require('./helpers/fake-supabase');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const AUTH = read('js/auth.js');
const APP = read('Denarii.js');
const HTML = read('index.html');
const AIRUN = read('js/ai-run.js');

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

function extractVar(src, re, name) {
    const m = re.exec(src);
    if (!m) throw new Error(name + ' not found');
    return m[0];
}

const inert = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
});

const AUTH_FNS = [
    '_loadJournalFromSupabaseRows', '_fetchAllRows', '_mapSupabaseTradeRow', '_mapArrayRow', '_mapReviewRows',
    '_mapPlannerRows', '_mapUserMetaRows', '_toISOOrNull', '_groupRowsByKeySet', '_updateDomainSnapshots',
    '_withTimeout', '_cloudWriteAllowed', '_sessionMatchesAccount', '_mapDomainRows', '_rowKey', '_rowSig',
    '_changedRows', '_markRows', '_savePendingRows', '_setCloudBaseline', '_overlayRecord',
    '_deleteStrategyFromSupabase', '_saveDeletedStrategyKeysToSupabase',
    '_cloudCountTradesBySetup', '_cloudRenameTrades', '_cloudStrategyUnchanged',
    '_strategyDeleteMarkerKey', '_clearStrategyDeleteMarker', '_cloudDeletePreflight', '_cloudClearStrategyTrades',
    '_applyStrategyDeleteToLocal', '_revertStrategyDeleteOnLocal', '_resumeStrategyDelete',
    ...D3.D3_FNS,
];
const APP_FNS = ['_noteDeletedStrategyName', '_clearDeletedStrategyName', '_strategyDeleteBlocked', '_strategyDeleteDialog',
    '_deleteStrategyFlow', '_runStrategyDelete', 'deleteStrategy', '_refreshAfterStrategyRename', 'normalizeStrategyName',
    'backfillStrategiesFromExistingTrades', 'getCanonicalStrategies', 'saveCanonicalStrategies', 'getDemoStrategySeedList'];
const VARS = [
    extractVar(AUTH, /var _SHADOW_DOMAINS = \{[\s\S]*?\n\};/, '_SHADOW_DOMAINS'),
    extractVar(AUTH, /var _USER_META_KEYS = \[[\s\S]*?\];/, '_USER_META_KEYS'),
    extractVar(AUTH, /var _CLOUD_ARRAY_DOMAINS = \[[^\]]*\];/, '_CLOUD_ARRAY_DOMAINS'),
    extractVar(AUTH, /var _CLOUD_KEYED_DOMAINS = \[[^\]]*\];/, '_CLOUD_KEYED_DOMAINS'),
    "var _DEMO_BROKER_ID = 'ba_demo_pelosi';",
    'var _SB_PAGE_SIZE = 1000;',
    D3.d3Vars(AUTH),
].join('\n');

const clone = v => JSON.parse(JSON.stringify(v));
const UID = 'u1';
const MARKER = 'strategyDelete:acct';

function filtersApi() {
    const win = {};
    new Function('window', read('js/shared/filter-bar.js'))(win);
    return win.DenariiFilters;
}

function box(over) {
    over = over || {};
    const settings = Object.assign({}, over.settings);
    const client = over.client || fakeSupabase({}, { pk: true, rev: true });
    const log = { alerts: [], confirms: [], idb: 0 };
    const target = Object.assign({
        window: Object.assign({ _denariiStorageMode: 'cloud_primary', _denariiSupabaseUid: UID, _invalidateCloudDash: () => {} }, over.window),
        SupabaseAuth: { isReady: () => true, getClient: () => client,
            supabaseGetSession: async () => ({ data: { user: { id: over.sessionUid || UID } } }) },
        journalData: {}, sessionDek: 'dek', sessionPassword: 'pw', currentAccountId: 'acct', currentUsername: 'me',
        _cloudBaselineReady: false, _cloudPaused: false, _rowBaseline: {}, _cloudPending: {}, _domainSnapshots: {},
        _journalDirty: false, ...D3.d3State(),
        getSetting: async k => settings[k],
        setSetting: async (k, v) => { settings[k] = v; },
        saveJournalRecord: async () => {},
        encrypt: d => JSON.stringify(d),
        navigator: { onLine: true },
        DenariiFilters: filtersApi(),
        document: { getElementById: () => null, querySelectorAll: () => [], body: null },
        alert: m => { log.alerts.push(m); },
        confirm: m => { log.confirms.push(m); if (over.onConfirm) over.onConfirm(); return !over.decline; },
        saveToIndexedDB: async () => { log.idb++; },
        updateStrategiesList: () => {},
        updateStrategyDropdown: () => {},
        updateDashboard: () => {},
    }, over.vals);
    const scope = new Proxy(target, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => {
            if (typeof k !== 'string') return undefined;
            if (k in t) return t[k];
            if (k in globalThis) return globalThis[k];
            return inert;
        },
    });
    const code = AUTH_FNS.map(n => extractFunction(AUTH, n)).concat(APP_FNS.map(n => extractFunction(APP, n))).join('\n');
    const fns = new Function('scope', 'with (scope) { return (function () {\n' + VARS + '\n' + code +
        '\nreturn {' + AUTH_FNS.concat(APP_FNS).join(',') + '};\n})(); }')(scope);
    return { fns, g: target, client, settings, log };
}

const TABLES = () => ({
    strategies: [{ id: '10', name: 'Old', rev: 1 }, { id: '11', name: 'Other', rev: 1 }],
    trades: [
        { id: 't1', user_id: UID, symbol: 'A', notes: 'keep', setup_type: 'Old' },
        { id: 't2', user_id: UID, symbol: 'B', setup_type: 'Old' },
        { id: 't3', user_id: UID, symbol: 'C', setup_type: 'Other' },
        { id: 'x1', user_id: 'someone-else', symbol: 'Z', setup_type: 'Old' },
    ],
});

async function loaded(tables, over) {
    const client = fakeSupabase(clone(tables), { pk: true, rev: true });
    const h = box(Object.assign({ client }, over));
    const revs = {};
    const cloud = await h.fns._loadJournalFromSupabaseRows(client, UID, { strict: true, revs });
    h.g.journalData = clone(cloud);
    h.g.journalData.trades = h.g.journalData.trades.filter(t => t.id !== 'x1');
    h.g._rowRev = revs;
    h.fns._setCloudBaseline(h.g.journalData, true, cloud);
    client.writes.length = 0;
    return h;
}

const del = h => h.fns._runStrategyDelete(h.g.journalData.strategies.find(s => String(s.id) === '10'));
const cloudSetups = h => h.client.tables.trades.filter(t => t.user_id === UID).map(t => t.setup_type);
const localSetups = h => h.g.journalData.trades.map(t => t.setupType);
const stratNames = h => h.g.journalData.strategies.map(s => s.name);
const cloudStrats = h => h.client.tables.strategies.map(s => s.id);

function assertNothingChanged(h) {
    assert.deepEqual(cloudSetups(h), ['Old', 'Old', 'Other']);
    assert.deepEqual(localSetups(h), ['Old', 'Old', 'Other']);
    assert.deepEqual(stratNames(h), ['Old', 'Other']);
    assert.deepEqual(cloudStrats(h), ['10', '11']);
    assert.equal(h.g.journalData._deletedStrategyKeys, undefined);
}

// Runs fn just before the trade UPDATE. mode 'fail': it errors without applying.
// 'lost': it applies, then errors.
function onTradeUpdate(client, mode, fn) {
    const from = client.from;
    client.from = table => {
        const b = from(table);
        if (table !== 'trades') return b;
        const update = b.update;
        b.update = (p, o) => {
            if (fn) fn();
            const real = update(p, o);
            if (!mode) return real;
            const fake = { eq(c, v) { real.eq(c, v); return fake; }, select() { return fake; },
                then(res) {
                    if (mode === 'lost') return real.then(() => res({ data: null, error: { message: 'boom' } }));
                    return res({ data: null, error: { message: 'boom' } });
                } };
            return fake;
        };
        return b;
    };
}

function failCounts(client) {
    const from = client.from;
    client.from = table => {
        const b = from(table);
        const select = b.select;
        b.select = (c, o) => {
            if (!(o && o.head)) return select(c, o);
            const fake = { eq() { return fake; }, then(res) { return res({ data: null, error: { message: 'down' } }); } };
            return fake;
        };
        return b;
    };
}

// ── Cloud delete ────────────────────────────────────────────────────────────

test('cloud: one update by user and exact name, trades cleared, strategy row removed', async () => {
    const h = await loaded(TABLES());
    assert.equal(await del(h), true);
    const tradeWrites = h.client.writes.filter(w => w.table === 'trades');
    assert.equal(tradeWrites.length, 1);
    assert.equal(tradeWrites[0].op, 'update');
    assert.deepEqual(tradeWrites[0].rows[0], { user_id: UID, setup_type: null });
    assert.deepEqual(cloudSetups(h), [null, null, 'Other']);
    assert.equal(h.client.tables.trades.find(t => t.id === 'x1').setup_type, 'Old', 'another user is untouched');
    assert.equal(h.client.tables.trades[0].notes, 'keep');
    assert.deepEqual(localSetups(h), ['', '', 'Other']);
    assert.deepEqual(stratNames(h), ['Other']);
    assert.deepEqual(cloudStrats(h), ['11']);
    assert.equal(h.settings[MARKER], null);
    assert.deepEqual(h.log.alerts, []);
});

test('the tombstone is saved to the cloud and stops the backfill', async () => {
    const t = TABLES();
    t.trades.push({ id: 't4', user_id: UID, symbol: 'D', setup_type: 'Old ' });
    const h = await loaded(t);
    await del(h);
    assert.deepEqual(h.g.journalData._deletedStrategyKeys, ['old']);
    const row = h.client.tables.user_meta.find(r => r.key === '_deletedStrategyKeys');
    assert.equal(row.value, '["old"]');
    assert.equal(h.fns.backfillStrategiesFromExistingTrades(h.g.journalData.trades), false);
    assert.deepEqual(stratNames(h), ['Other']);
});

test('the backfill still adds other names, and a cleared name again', async () => {
    const h = box();
    h.g.journalData = { strategies: [], _deletedStrategyKeys: ['old'] };
    const trades = [{ setupType: 'Old' }, { setupType: 'Fresh' }];
    assert.equal(h.fns.backfillStrategiesFromExistingTrades(trades), true);
    assert.deepEqual(stratNames(h), ['Fresh']);
    assert.equal(h.fns._clearDeletedStrategyName('OLD '), true);
    assert.equal(h.fns.backfillStrategiesFromExistingTrades(trades), true);
    assert.deepEqual(stratNames(h), ['Fresh', 'Old']);
});

test('creating or renaming to a deleted name clears the tombstone', () => {
    assert.match(APP, /!existingStrat && _clearDeletedStrategyName\(rawName\)/);
    assert.match(extractFunction(APP, '_runStrategyRename'), /_clearDeletedStrategyName\(newName\)/);
});

test('the dialog shows the cloud count and wording; declining changes nothing', async () => {
    const h = await loaded(TABLES(), { decline: true });
    assert.equal(await del(h), false);
    assert.equal(h.log.confirms[0], "2 trades use this strategy. They will move to No Strategy. This can't be undone.");
    assert.equal(h.client.writes.length, 0);
    assert.equal(h.settings[MARKER], undefined);
    assertNothingChanged(h);
});

test('one trade uses singular wording', async () => {
    const t = TABLES();
    t.trades.splice(1, 1);
    const h = await loaded(t);
    await del(h);
    assert.match(h.log.confirms[0], /^1 trade uses this strategy\. It will move to No Strategy\./);
});

test('spacing variants are warned about and not changed', async () => {
    const t = TABLES();
    t.trades.push({ id: 't4', user_id: UID, symbol: 'D', setup_type: 'Old ' });
    const h = await loaded(t);
    await del(h);
    assert.match(h.log.confirms[0], /1 trade with different spacing won't be changed/);
    assert.equal(h.client.tables.trades.find(r => r.id === 't4').setup_type, 'Old ');
});

test('no trades: a normal confirmation and no trade update', async () => {
    const t = TABLES();
    t.trades = t.trades.filter(r => r.setup_type !== 'Old' || r.user_id !== UID);
    const h = await loaded(t);
    assert.equal(await del(h), true);
    assert.equal(h.log.confirms[0], 'Delete "Old"?');
    assert.equal(h.client.writes.filter(w => w.table === 'trades').length, 0);
    assert.deepEqual(cloudStrats(h), ['11']);
});

test('names with special characters match exactly', async () => {
    const name = `Bob's "Best" & <Setup>`;
    const t = TABLES();
    t.strategies[0].name = name;
    t.trades.forEach(r => { if (r.setup_type === 'Old') r.setup_type = name; });
    const h = await loaded(t);
    assert.equal(await del(h), true);
    assert.deepEqual(cloudSetups(h), [null, null, 'Other']);
});

// ── Nothing changes ─────────────────────────────────────────────────────────

test('offline, paused or the wrong session: blocked with a clear message', async () => {
    const cases = [
        h => { h.g.navigator.onLine = false; },
        h => { h.g._cloudPaused = true; },
    ];
    for (const setup of cases) {
        const h = await loaded(TABLES());
        setup(h);
        assert.equal(await del(h), false);
        assert.match(h.log.alerts[0], /needs a connection.*Nothing was changed/);
        assert.equal(h.log.confirms.length, 0);
        assert.equal(h.client.writes.length, 0);
        assertNothingChanged(h);
    }
    const h = await loaded(TABLES(), { sessionUid: 'other' });
    assert.equal(await del(h), false);
    assert.match(h.log.alerts[0], /needs a connection/);
    assertNothingChanged(h);
});

test('changed on another device before the dialog: blocked', async () => {
    const h = await loaded(TABLES());
    h.client.tables.strategies[0].rev = 9;
    assert.equal(await del(h), false);
    assert.match(h.log.alerts[0], /changed on another device.*Nothing was changed/);
    assertNothingChanged(h);
});

test('changed on another device while the dialog is open: blocked', async () => {
    let client;
    const h = await loaded(TABLES(), { onConfirm: () => { client.tables.strategies[0].rev = 9; } });
    client = h.client;
    assert.equal(await del(h), false);
    assert.match(h.log.alerts[0], /changed on another device/);
    assert.equal(h.settings[MARKER], undefined);
    assertNothingChanged(h);
});

test('the trade count changed while the dialog was open: blocked', async () => {
    let client;
    const h = await loaded(TABLES(), { onConfirm: () => { client.tables.trades[2].setup_type = 'Old'; } });
    client = h.client;
    assert.equal(await del(h), false);
    assert.match(h.log.alerts[0], /number of trades.*changed.*Nothing was changed/);
    assert.equal(h.client.writes.filter(w => w.table === 'trades').length, 0);
});

test('a failed update changes nothing and clears the marker', async () => {
    const h = await loaded(TABLES());
    onTradeUpdate(h.client, 'fail');
    assert.equal(await del(h), false);
    assert.match(h.log.alerts[0], /Couldn't delete.*Nothing was changed/);
    assert.equal(h.settings[MARKER], null);
    assertNothingChanged(h);
});

test('a lost response is recounted and the delete finishes', async () => {
    const h = await loaded(TABLES());
    onTradeUpdate(h.client, 'lost');
    assert.equal(await del(h), true);
    assert.deepEqual(cloudSetups(h), [null, null, 'Other']);
    assert.deepEqual(stratNames(h), ['Other']);
    assert.equal(h.settings[MARKER], null);
});

test('a lost response that cannot be recounted keeps the marker and changes nothing here', async () => {
    const h = await loaded(TABLES());
    onTradeUpdate(h.client, 'fail', () => failCounts(h.client));
    assert.equal(await del(h), false);
    assert.match(h.log.alerts[0], /checked at your next sign-in/);
    assert.equal(h.settings[MARKER].name, 'Old');
    assert.deepEqual(stratNames(h), ['Old', 'Other']);
    assert.deepEqual(localSetups(h), ['Old', 'Old', 'Other']);
});

test('edited on another device during the delete: kept, and the message says so', async () => {
    const h = await loaded(TABLES());
    onTradeUpdate(h.client, null, () => { h.client.tables.strategies[0].rev = 9; });
    assert.equal(await del(h), true);
    assert.match(h.log.alerts[0], /was kept\. Its trades have already moved to No Strategy/);
    assert.deepEqual(cloudStrats(h), ['10', '11']);
    assert.ok(stratNames(h).includes('Old'));
    assert.deepEqual(h.g.journalData._deletedStrategyKeys, []);
    assert.equal(h.settings[MARKER], null);
});

test('the rename lock stops a second run and is released afterwards', async () => {
    const h = await loaded(TABLES());
    h.g.window._denariiStrategyRenameRunning = true;
    assert.equal(await h.fns._deleteStrategyFlow(h.g.journalData.strategies[0]), false);
    assertNothingChanged(h);
    h.g.window._denariiStrategyRenameRunning = false;
    assert.equal(await h.fns._deleteStrategyFlow(h.g.journalData.strategies[0]), true);
    assert.equal(h.g.window._denariiStrategyRenameRunning, false);
});

// ── Recovery ────────────────────────────────────────────────────────────────

test('recovery: trades already cleared, so the delete finishes', async () => {
    const t = TABLES();
    t.trades.forEach(r => { if (r.setup_type === 'Old' && r.user_id === UID) r.setup_type = null; });
    const h = await loaded(t, { settings: { [MARKER]: { strategyId: '10', name: 'Old' } } });
    await h.fns._resumeStrategyDelete();
    assert.deepEqual(stratNames(h), ['Other']);
    assert.deepEqual(cloudStrats(h), ['11']);
    assert.deepEqual(h.g.journalData._deletedStrategyKeys, ['old']);
    assert.equal(h.settings[MARKER], null);
});

test('recovery: trades still on the name, so the update never ran and nothing changes', async () => {
    const h = await loaded(TABLES(), { settings: { [MARKER]: { strategyId: '10', name: 'Old' } } });
    await h.fns._resumeStrategyDelete();
    assert.equal(h.settings[MARKER], null);
    assert.equal(h.client.writes.length, 0);
    assertNothingChanged(h);
});

test('recovery: a failed count keeps the marker for the next load', async () => {
    const h = await loaded(TABLES(), { settings: { [MARKER]: { strategyId: '10', name: 'Old' } } });
    failCounts(h.client);
    await h.fns._resumeStrategyDelete();
    assert.equal(h.settings[MARKER].name, 'Old');
    assert.deepEqual(stratNames(h), ['Old', 'Other']);
});

test('recovery runs on the cloud load, before the backfill', () => {
    assert.match(AUTH, /await _resumeStrategyDelete\(\);/);
    assert.ok(AUTH.indexOf('await _resumeStrategyDelete();') < AUTH.indexOf('Sends what the cloud does not have yet'));
});

// ── System strategies and demo data ─────────────────────────────────────────

test('a System strategy is only hidden, never deleted', async () => {
    const t = TABLES();
    const h = await loaded(t);
    Object.assign(h.g.journalData.strategies[0], { createdBy: 'System' });
    h.fns.deleteStrategy('10');
    assert.equal(h.g.journalData.strategies[0].isFavorite, false);
    assert.deepEqual(cloudStrats(h), ['10', '11']);
    assert.equal(h.client.writes.filter(w => w.table === 'trades').length, 0);
});

test('a user strategy sharing a System name cannot be deleted', async () => {
    const t = TABLES();
    t.strategies[0].name = 'support  bounce';
    t.trades.forEach(r => { if (r.setup_type === 'Old') r.setup_type = 'support  bounce'; });
    const h = await loaded(t);
    assert.equal(await del(h), false);
    assert.match(h.log.alerts[0], /can't be deleted/);
    assert.equal(h.client.writes.length, 0);
});

test('a user strategy with Pelosi trades can be deleted; those trades move to No Strategy', async () => {
    const t = TABLES();
    t.trades.push({ id: 'd1', user_id: UID, symbol: 'D', setup_type: 'Old', broker_account_id: 'ba_demo_pelosi' });
    t.trades.push({ id: 'd2', user_id: UID, symbol: 'E', setup_type: 'Support Bounce', broker_account_id: 'ba_demo_pelosi' });
    const h = await loaded(t);
    assert.equal(await del(h), true);
    assert.match(h.log.confirms[0], /^3 trades use this strategy/);
    assert.equal(h.client.tables.trades.find(r => r.id === 'd1').setup_type, null);
    assert.equal(h.g.journalData.trades.find(r => r.id === 'd1').setupType, '');
    assert.equal(h.client.tables.trades.find(r => r.id === 'd2').setup_type, 'Support Bounce', 'other demo trades keep their name');
    assert.deepEqual(cloudStrats(h), ['11']);
});

// ── Local-only accounts ─────────────────────────────────────────────────────

const localBox = vals => {
    const h = box({ window: { _denariiStorageMode: 'local' }, vals });
    h.g.journalData = {
        strategies: [{ id: 10, name: 'Old' }, { id: 11, name: 'Other' }],
        trades: [{ id: 't1', setupType: 'Old' }, { id: 't2', setupType: 'Other' }],
    };
    return h;
};

test('local: trades and strategy update, no cloud call', async () => {
    const h = localBox();
    assert.equal(await h.fns._runStrategyDelete(h.g.journalData.strategies[0]), true);
    assert.match(h.log.confirms[0], /^1 trade uses this strategy/);
    assert.deepEqual(localSetups(h), ['', 'Other']);
    assert.deepEqual(stratNames(h), ['Other']);
    assert.equal(h.client.writes.length, 0);
    assert.equal(h.fns.backfillStrategiesFromExistingTrades(h.g.journalData.trades), false);
});

test('local: a failed save reverts everything', async () => {
    const h = localBox({ _journalDirty: true });
    assert.equal(await h.fns._runStrategyDelete(h.g.journalData.strategies[0]), false);
    assert.match(h.log.alerts[0], /Couldn't delete.*Nothing was changed/);
    assert.deepEqual(localSetups(h), ['Old', 'Other']);
    assert.deepEqual(stratNames(h), ['Old', 'Other']);
    assert.deepEqual(h.g.journalData._deletedStrategyKeys, []);
});

// ── Filters, reports, page wiring ───────────────────────────────────────────

test('filters: an open selection and a page state return to All', () => {
    const F = filtersApi();
    F.noteStrategyRename('Before', 'Old');
    F.noteStrategyDeleted('Old');
    assert.equal(F.currentStrategyName('Old'), 'all');
    assert.equal(F.currentStrategyName('Before'), 'all');
    assert.equal(F.filterTrades([{ setupType: 'Other' }], { strategy: 'Old' }).length, 1);
    const state = { strategy: 'Old' };
    const sel = { value: 'Old' };
    F.followStrategyRename(sel, state);
    assert.deepEqual([state.strategy, sel.value], ['all', 'all']);
    F.forgetStrategyRename('Old');
    assert.equal(F.currentStrategyName('Old'), 'Old');
});

test('a saved report whose strategy is gone shows a notice on re-run', () => {
    const fn = extractFunction(AIRUN, 'setFilters');
    assert.match(fn, /strategyEl\.value !== f\.strategyFilter\) _setRunStatus\(_STRATEGY_GONE_MSG, 'error'\)/);
    assert.match(AIRUN, /strategy no longer exists, so this run will use All Strategies/);
});

test('the dialog has Cancel and Delete, and clicking outside cancels', async () => {
    assert.match(HTML, /id="strategy-delete-modal"/);
    assert.match(HTML, /id="strategy-delete-cancel">Cancel</);
    assert.match(HTML, /id="strategy-delete-confirm"[^>]*>Delete</);
    const els = {
        'strategy-delete-modal': { addEventListener(t, f) { this.outside = f; }, removeEventListener() {} },
        'strategy-delete-message': {}, 'strategy-delete-note': { style: {} },
        'strategy-delete-cancel': {}, 'strategy-delete-confirm': {},
    };
    const h = box({ vals: { document: { getElementById: id => els[id] || null }, openModal() {}, closeModal() {} } });
    const modal = els['strategy-delete-modal'];
    const yes = h.fns._strategyDeleteDialog('msg', 'warn');
    assert.equal(els['strategy-delete-message'].textContent, 'msg');
    assert.equal(els['strategy-delete-note'].textContent, 'warn');
    els['strategy-delete-confirm'].onclick();
    assert.equal(await yes, true);
    const no = h.fns._strategyDeleteDialog('msg', '');
    assert.equal(els['strategy-delete-note'].style.display, 'none');
    els['strategy-delete-cancel'].onclick();
    assert.equal(await no, false);
    const out = h.fns._strategyDeleteDialog('msg', '');
    modal.outside({ target: modal });
    assert.equal(await out, false);
});

test('favorites and + Add Favorite are unchanged', () => {
    assert.match(HTML, /toggleAddFavoriteMenu\(\)/);
    for (const fn of ['toggleStrategyFavorite', 'restoreStrategyFavorite', 'toggleAddFavoriteMenu']) {
        assert.ok(extractFunction(APP, fn));
        assert.equal(/_deletedStrategyKeys|_runStrategyDelete/.test(extractFunction(APP, fn)), false);
    }
});

test('index.html: versions bumped for this change', () => {
    const ver = file => Number((HTML.split('src="' + file + '?v=')[1] || '0"').split('"')[0]);
    assert.ok(ver('Denarii.js') >= 65);
    assert.ok(ver('js/auth.js') >= 44);
    assert.ok(ver('js/shared/filter-bar.js') >= 5);
    assert.ok(ver('js/ai-run.js') >= 10);
});
