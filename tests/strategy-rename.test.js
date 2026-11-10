// Renaming a strategy moves its exactly matching trades with one bulk UPDATE,
// never half-applies, and never brings the old name back through the backfill.
// Same harness as batch-d3.test.js: real functions are cut out of the browser
// scripts and run in a `with` scope (unknown globals are inert).
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
const DEMO = read('js/demoSeed.js');
const PAGES = ['timing', 'symbols', 'snapshot', 'discipline', 'setups', 'risk', 'perf-trends'];

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
    '_changedRows', '_markRows', '_savePendingRows', '_setCloudBaseline', '_overlayRecord', '_saveStrategyToSupabase', '_saveAiReportToSupabase',
    '_strategyRenameMarkerKey', '_clearStrategyRenameMarker', '_cloudCountTradesBySetup', '_cloudRenameTrades',
    '_cloudStrategyUnchanged', '_cloudRenamePreflight', '_cloudMoveStrategyTrades', '_cloudReverseStrategyRename',
    '_applyStrategyNameToLocal', '_revertStrategyNameOnLocal', '_saveRenamedReports', '_resumeStrategyRename',
    ...D3.D3_FNS,
];
const APP_FNS = ['_runStrategyRename', '_refreshAfterStrategyRename', 'normalizeStrategyName',
    'backfillStrategiesFromExistingTrades', 'getCanonicalStrategies', 'saveCanonicalStrategies'];
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

function filtersApi() {
    const win = {};
    new Function('window', read('js/shared/filter-bar.js'))(win);
    return win.DenariiFilters;
}

function box(over) {
    over = over || {};
    const settings = Object.assign({}, over.settings);
    const client = over.client || fakeSupabase({}, { pk: true, rev: true });
    const log = { alerts: [], confirms: [], idb: 0, closed: 0, lists: 0 };
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
        confirm: m => { log.confirms.push(m); return over.decline ? false : true; },
        saveToIndexedDB: async () => { log.idb++; },
        closeStrategyEditor: () => { log.closed++; },
        updateStrategiesList: () => { log.lists++; },
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

const TABLES = names => ({
    strategies: [{ id: '10', name: names[0], rev: 1 }, { id: '11', name: 'Other', rev: 1 }],
    trades: [
        { id: 't1', user_id: UID, symbol: 'A', notes: 'keep', setup_type: names[0] },
        { id: 't2', user_id: UID, symbol: 'B', setup_type: names[0] },
        { id: 't3', user_id: UID, symbol: 'C', setup_type: 'Other' },
        { id: 'x1', user_id: 'someone-else', symbol: 'Z', setup_type: names[0] },
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

const strat = h => h.g.journalData.strategies.find(s => String(s.id) === '10');
const renamed = (h, name) => Object.assign({}, strat(h), { name });
const rename = (h, name) => h.fns._runStrategyRename(strat(h), renamed(h, name));
const setups = rows => rows.map(t => t.setupType);
const cloudSetups = h => h.client.tables.trades.filter(t => t.user_id === UID).map(t => t.setup_type);
const MARKER = 'strategyRename:acct';
const marker = phase => ({ strategyId: '10', oldName: 'Old', newName: 'New', phase });

// Replaces a matching write with an error. after: also apply it (a lost response).
function failWrite(client, match, after) {
    const from = client.from;
    client.from = table => {
        const b = from(table);
        const update = b.update;
        b.update = (p, o) => {
            const real = update(p, o);
            if (!match(table, p)) return real;
            const fake = { eq(c, v) { real.eq(c, v); return fake; }, select() { return fake; },
                then(res) {
                    if (after) return real.then(() => res({ data: null, error: { message: 'boom' } }));
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

// ── Cloud rename ────────────────────────────────────────────────────────────

test('cloud: one update filtered by user and old name, trades and strategy both move, no upsert', async () => {
    const h = await loaded(TABLES(['Old']));
    assert.equal(await rename(h, 'New'), true);
    const tradeWrites = h.client.writes.filter(w => w.table === 'trades');
    assert.equal(tradeWrites.length, 1);
    assert.equal(tradeWrites[0].op, 'update');
    assert.deepEqual(tradeWrites[0].rows[0], { user_id: UID, setup_type: 'New' });
    assert.deepEqual(cloudSetups(h), ['New', 'New', 'Other']);
    assert.equal(h.client.tables.trades.find(t => t.id === 'x1').setup_type, 'Old', 'another user is untouched');
    assert.equal(h.client.tables.trades[0].notes, 'keep');
    assert.deepEqual(setups(h.g.journalData.trades), ['New', 'New', 'Other']);
    assert.equal(h.client.tables.strategies.find(s => s.id === '10').name, 'New');
    assert.equal(h.settings[MARKER], null);
    assert.equal(h.log.closed, 1);
    assert.deepEqual(h.log.alerts, []);
});

test('the backfill adds nothing after a rename, so the old name stays gone', async () => {
    const h = await loaded(TABLES(['Old']));
    await rename(h, 'New');
    assert.equal(h.fns.backfillStrategiesFromExistingTrades(h.g.journalData.trades), false);
    assert.equal(h.g.journalData.strategies.some(s => s.name === 'Old'), false);
});

test('the confirmation shows the count; declining changes nothing', async () => {
    const h = await loaded(TABLES(['Old']), { decline: true });
    assert.equal(await rename(h, 'New'), false);
    assert.match(h.log.confirms[0], /2 trades will be updated/);
    assert.equal(h.client.writes.length, 0);
    assert.equal(strat(h).name, 'Old');
    assert.equal(h.settings[MARKER], undefined);
});

test('spacing variants are warned about and not moved', async () => {
    const t = TABLES(['My Setup']);
    t.trades.push({ id: 't4', user_id: UID, symbol: 'D', setup_type: 'My  Setup' });
    const h = await loaded(t);
    await rename(h, 'New');
    assert.match(h.log.confirms[0], /1 trade with different spacing won't be updated/);
    assert.equal(h.client.tables.trades.find(r => r.id === 't4').setup_type, 'My  Setup');
});

for (const name of [`Bob's "Best" Setup`, `All ' " & < > together`, 'Literal &amp; entity', 'Has, comma (and) %']) {
    test('names with special characters pass through exactly: ' + name, async () => {
        const h = await loaded(TABLES([name]));
        assert.equal(await rename(h, name + ' v2'), true);
        assert.deepEqual(cloudSetups(h), [name + ' v2', name + ' v2', 'Other']);
        const h2 = await loaded(TABLES(['Plain']));
        await rename(h2, name);
        assert.deepEqual(setups(h2.g.journalData.trades), [name, name, 'Other']);
    });
}

test('System strategies are refused even if the editor was reached', async () => {
    for (const flag of [{ isDemoSeed: true }, { createdBy: 'System' }]) {
        const h = await loaded(TABLES(['Old']));
        Object.assign(strat(h), flag);
        assert.equal(await rename(h, 'New'), false);
        assert.match(h.log.alerts[0], /System strategies/);
        assert.equal(h.client.writes.length, 0);
    }
});

// ── Blocked before anything is written ──────────────────────────────────────

const assertUntouched = h => {
    assert.equal(h.client.writes.length, 0);
    assert.equal(strat(h).name, 'Old');
    assert.deepEqual(setups(h.g.journalData.trades), ['Old', 'Old', 'Other']);
    assert.equal(h.settings[MARKER], undefined);
    assert.equal(h.log.closed, 0);
    assert.equal(h.log.alerts.length, 1);
};

test('offline: blocked with a message', async () => {
    const h = await loaded(TABLES(['Old']), { vals: { navigator: { onLine: false } } });
    assert.equal(await rename(h, 'New'), false);
    assertUntouched(h);
    assert.match(h.log.alerts[0], /needs a connection.*Nothing was changed/);
});

test('paused session: blocked', async () => {
    const h = await loaded(TABLES(['Old']));
    h.g._cloudPaused = true;
    assert.equal(await rename(h, 'New'), false);
    assertUntouched(h);
});

test('Supabase not ready on a cloud account: blocked, not treated as a local rename', async () => {
    const h = await loaded(TABLES(['Old']));
    h.g.SupabaseAuth = Object.assign({}, h.g.SupabaseAuth, { isReady: () => false });
    assert.equal(await rename(h, 'New'), false);
    assertUntouched(h);
});

test('session of another account: blocked', async () => {
    const h = await loaded(TABLES(['Old']), { sessionUid: 'someone-else' });
    assert.equal(await rename(h, 'New'), false);
    assertUntouched(h);
});

test('strategy already changed on another device: blocked', async () => {
    const h = await loaded(TABLES(['Old']));
    const row = h.client.tables.strategies.find(s => s.id === '10');
    row.description = 'edited elsewhere'; row.rev = 5;
    assert.equal(await rename(h, 'New'), false);
    assertUntouched(h);
    assert.match(h.log.alerts[0], /another device/);
});

// ── Collisions ──────────────────────────────────────────────────────────────

test('collision: a local trade already uses the name, in any case or spacing', async () => {
    for (const taken of ['Other', 'OTHER', ' other ']) {
        const h = await loaded(TABLES(['Old']));
        assert.equal(await rename(h, taken), false);
        assertUntouched(h);
    }
});

test('collision: only the cloud has a trade with the name', async () => {
    const t = TABLES(['Old']);
    const h = await loaded(t);
    h.client.tables.trades.push({ id: 'c9', user_id: UID, symbol: 'Q', setup_type: 'New' });
    assert.equal(await rename(h, 'New'), false);
    assertUntouched(h);
    assert.match(h.log.alerts[0], /already use this name/);
});

test('the save form still blocks a name another strategy has', () => {
    assert.match(APP, /A strategy with this name already exists/);
    assert.ok(APP.indexOf('A strategy with this name already exists') < APP.indexOf('await _renameStrategyFlow(existingStrat, strategy)'));
});

test('a case-only rename of the same strategy is allowed', async () => {
    const h = await loaded(TABLES(['orb']));
    assert.equal(await rename(h, 'ORB'), true);
    assert.deepEqual(cloudSetups(h), ['ORB', 'ORB', 'Other']);
});

// ── Failures ────────────────────────────────────────────────────────────────

test('update error: nothing changes, the marker is gone, a clear message', async () => {
    const h = await loaded(TABLES(['Old']));
    failWrite(h.client, t => t === 'trades');
    assert.equal(await rename(h, 'New'), false);
    assert.equal(strat(h).name, 'Old');
    assert.deepEqual(setups(h.g.journalData.trades), ['Old', 'Old', 'Other']);
    assert.deepEqual(cloudSetups(h), ['Old', 'Old', 'Other']);
    assert.equal(h.settings[MARKER], null);
    assert.match(h.log.alerts[0], /Nothing was changed/);
});

test('lost response: the update had applied, so the rename carries on', async () => {
    const h = await loaded(TABLES(['Old']));
    failWrite(h.client, t => t === 'trades', true);
    assert.equal(await rename(h, 'New'), true);
    assert.equal(strat(h).name, 'New');
    assert.deepEqual(setups(h.g.journalData.trades), ['New', 'New', 'Other']);
    assert.equal(h.settings[MARKER], null);
});

test('strategy save fails after the trades moved: queued, stays renamed, user told', async () => {
    const h = await loaded(TABLES(['Old']));
    failWrite(h.client, t => t === 'strategies');
    assert.equal(await rename(h, 'New'), true);
    assert.equal(strat(h).name, 'New');
    assert.equal(h.g._cloudPending.strategies['10'], true);
    assert.match(h.log.alerts[0], /finish syncing/);
    assert.deepEqual(h.settings[MARKER], marker('forward'), 'kept until the strategy row is in the cloud');
});

test('conflict on the strategy save: trades go back, the cloud version wins', async () => {
    const h = await loaded(TABLES(['Old']));
    const from = h.client.from;
    let hit = false;
    h.client.from = table => {
        const b = from(table);
        const update = b.update;
        b.update = (p, o) => {
            if (table === 'trades' && !hit) {
                hit = true;
                const row = h.client.tables.strategies.find(s => s.id === '10');
                row.description = 'edited elsewhere'; row.rev = 7;
            }
            return update(p, o);
        };
        return b;
    };
    assert.equal(await rename(h, 'New'), false);
    assert.deepEqual(cloudSetups(h), ['Old', 'Old', 'Other']);
    assert.deepEqual(setups(h.g.journalData.trades), ['Old', 'Old', 'Other']);
    assert.equal(strat(h).name, 'Old');
    assert.equal(strat(h).description, 'edited elsewhere');
    assert.equal(h.client.tables.strategies.find(s => s.id === '10').name, 'Old');
    assert.equal(h.settings[MARKER], null);
    assert.match(h.log.alerts[0], /another device/);
});

// ── Recovery at the next cloud load ─────────────────────────────────────────

test('recovery: closed after the trades moved, the rename is finished', async () => {
    const t = TABLES(['Old']);
    t.trades[0].setup_type = 'New'; t.trades[1].setup_type = 'New';
    const h = await loaded(t, { settings: { [MARKER]: marker('forward') } });
    await h.fns._resumeStrategyRename();
    assert.equal(strat(h).name, 'New');
    assert.equal(h.client.tables.strategies.find(s => s.id === '10').name, 'New');
    assert.equal(h.settings[MARKER], null);
    assert.equal(h.fns.backfillStrategiesFromExistingTrades(h.g.journalData.trades), false);
});

test('recovery: closed before anything moved, nothing changes', async () => {
    const h = await loaded(TABLES(['Old']), { settings: { [MARKER]: marker('forward') } });
    await h.fns._resumeStrategyRename();
    assert.equal(strat(h).name, 'Old');
    assert.deepEqual(cloudSetups(h), ['Old', 'Old', 'Other']);
    assert.equal(h.client.writes.length, 0);
    assert.equal(h.settings[MARKER], null);
});

test('recovery: a reversal that failed is finished', async () => {
    const t = TABLES(['Old']);
    t.trades[0].setup_type = 'New'; t.trades[1].setup_type = 'New';
    const h = await loaded(t, { settings: { [MARKER]: marker('rollback') } });
    await h.fns._resumeStrategyRename();
    assert.deepEqual(cloudSetups(h), ['Old', 'Old', 'Other']);
    assert.deepEqual(setups(h.g.journalData.trades), ['Old', 'Old', 'Other']);
    assert.equal(h.settings[MARKER], null);
});

test('recovery: when the cloud cannot answer, the marker is kept and nothing changes', async () => {
    const h = await loaded(TABLES(['Old']), { settings: { [MARKER]: marker('forward') } });
    failCounts(h.client);
    await h.fns._resumeStrategyRename();
    assert.deepEqual(h.settings[MARKER], marker('forward'));
    assert.equal(strat(h).name, 'Old');
});

test('recovery runs in the cloud load, before unlockApp and its backfill', () => {
    const load = extractFunction(AUTH, '_cloudFirstReload');
    assert.ok(load.indexOf('_setCloudBaseline(journalData, true, cloud)') < load.indexOf('_resumeStrategyRename()'));
    assert.ok(load.indexOf('_resumeStrategyRename()') < load.indexOf('_shadowWriteRowsAwaited(journalData)'));
});

test('a re-sync waits while a rename is running', () => {
    assert.match(extractFunction(AUTH, '_cloudResync'), /window\._denariiStrategyRenameRunning\) return \{ ok: false, reason: 'busy' \}/);
});

// ── Local accounts ──────────────────────────────────────────────────────────

const localBox = over => {
    const h = box(Object.assign({ window: { _denariiStorageMode: 'local' } }, over));
    h.g.journalData = {
        strategies: [{ id: 10, name: 'Old' }],
        trades: [{ id: 1, setupType: 'Old', notes: 'keep' }, { id: 2, setupType: 'Oldish' }],
    };
    return h;
};

test('local: only exact matches move, other fields are untouched, no cloud call', async () => {
    const h = localBox();
    assert.equal(await rename(h, 'New'), true);
    assert.deepEqual(setups(h.g.journalData.trades), ['New', 'Oldish']);
    assert.equal(h.g.journalData.trades[0].notes, 'keep');
    assert.equal(h.client.writes.length, 0);
    assert.equal(h.log.idb, 1);
    assert.match(h.log.confirms[0], /1 trade will be updated/);
    assert.equal(h.fns.backfillStrategiesFromExistingTrades(h.g.journalData.trades), true, 'only Oldish is added');
    assert.deepEqual(h.g.journalData.strategies.map(s => s.name), ['New', 'Oldish']);
});

test('local: a failed save puts everything back', async () => {
    const h = localBox();
    h.g.saveToIndexedDB = async () => { h.g._journalDirty = true; };
    assert.equal(await rename(h, 'New'), false);
    assert.equal(strat(h).name, 'Old');
    assert.deepEqual(setups(h.g.journalData.trades), ['Old', 'Oldish']);
    assert.match(h.log.alerts[0], /Nothing was changed/);
    assert.equal(h.log.closed, 0);
});

// ── Saved reports ───────────────────────────────────────────────────────────

test('saved reports: re-run filter follows the rename, report text stays', async () => {
    const t = TABLES(['Old']);
    t.ai_reports = [
        { id: 'r1', filters: { strategyFilter: 'Old', symbol: 'A' }, output_text: 'Old did well', rev: 1 },
        { id: 'r2', filters: { strategyFilter: 'Other' }, output_text: 'x', rev: 1 },
    ];
    const h = await loaded(t);
    await rename(h, 'New');
    const [r1, r2] = h.g.journalData.aiOutputHistory;
    assert.deepEqual(r1.filters, { strategyFilter: 'New', symbol: 'A' });
    assert.equal(r2.filters.strategyFilter, 'Other');
    assert.equal(h.client.tables.ai_reports.find(r => r.id === 'r1').filters.strategyFilter, 'New');
    assert.equal(h.client.tables.ai_reports.find(r => r.id === 'r1').output_text, 'Old did well');
});

test('a report save that fails does not undo the rename', async () => {
    const t = TABLES(['Old']);
    t.ai_reports = [{ id: 'r1', filters: { strategyFilter: 'Old' }, rev: 1 }];
    const h = await loaded(t);
    failWrite(h.client, tb => tb === 'ai_reports');
    assert.equal(await rename(h, 'New'), true);
    assert.deepEqual(cloudSetups(h), ['New', 'New', 'Other']);
    assert.equal(h.g._cloudPending.aiOutputHistory.r1, true);
});

// ── Filters ─────────────────────────────────────────────────────────────────

const select = value => {
    const s = { _v: value, options: [],
        get value() { return s._v; },
        set value(v) { s._v = v; },
        set innerHTML(html) { s.options = [...html.matchAll(/value="([^"]*)"/g)].map(m => m[1]); },
    };
    return s;
};

test('filters: an open selection and a page state follow the rename', () => {
    const F = filtersApi();
    const trades = [{ setupType: 'New' }, { setupType: 'Other' }];
    F.noteStrategyRename('Old', 'New');
    assert.equal(F.currentStrategyName('Old'), 'New');
    assert.equal(F.currentStrategyName('Other'), 'Other');
    assert.deepEqual(F.filterTrades(trades, { strategy: 'Old' }).map(t => t.setupType), ['New']);
    const sel = select('Old');
    F.populateStrategy(sel, trades, [{ name: 'New' }, { name: 'Other' }]);
    assert.equal(sel.value, 'New');
    const state = { strategy: 'Old' };
    const pageSel = select('all');
    F.followStrategyRename(pageSel, state);
    assert.deepEqual([state.strategy, pageSel.value], ['New', 'New']);
});

test('filters: chained renames, renaming back, and a new strategy using the old name', () => {
    const F = filtersApi();
    F.noteStrategyRename('A', 'B');
    F.noteStrategyRename('B', 'C');
    assert.equal(F.currentStrategyName('A'), 'C');
    F.noteStrategyRename('C', 'A');
    assert.equal(F.currentStrategyName('A'), 'A');
    assert.equal(F.currentStrategyName('C'), 'A');
    F.noteStrategyRename('X', 'Y');
    F.forgetStrategyRename('X');
    assert.equal(F.currentStrategyName('X'), 'X');
    assert.equal(F.currentStrategyName('__proto__'), '__proto__');
});

test('filters: no rename leaves page state and selects alone', () => {
    const F = filtersApi();
    const state = { strategy: 'all' };
    const sel = select('all');
    F.followStrategyRename(sel, state);
    assert.deepEqual([state.strategy, sel.value], ['all', 'all']);
    F.followStrategyRename(sel, null);
});

test('after a rename, selects still on the old name are repopulated', async () => {
    const h = await loaded(TABLES(['Old']));
    const onOld = select('Old');
    const other = select('Other');
    h.g.document = { getElementById: () => null, querySelectorAll: q => (q === 'select[id$="-strategy"]' ? [onOld, other] : []) };
    await rename(h, 'New');
    assert.equal(onOld.value, 'New');
    assert.equal(onOld.options.includes('New'), true);
    assert.equal(other.options.length, 0, 'other selects are left alone');
});

for (const page of PAGES) {
    test(page + ': restoring filters follows a rename', () => {
        const src = read('js/pages/' + page + '.js');
        assert.match(src, /populateStrategy\(stratSel, journalData\.trades, journalData\.strategies\);\s*DenariiFilters\.followStrategyRename\(stratSel, _state\);/);
    });
}

// ── Demo, new users, wiring ─────────────────────────────────────────────────

test('demo trades only use System strategy names, which cannot be renamed or taken', () => {
    const seeds = new Function(extractFunction(APP, 'getDemoStrategySeedList') + '\nreturn getDemoStrategySeedList();')();
    const names = seeds.map(s => s.name);
    const setupNames = new Function(/var SETUPS = \[[\s\S]*?\];/.exec(DEMO)[0] + '\nreturn SETUPS;')();
    setupNames.forEach(n => assert.ok(names.includes(n), n + ' is not a System strategy'));
    seeds.forEach(s => assert.ok(s.isDemoSeed || s.createdBy === 'System', s.name));
});

test('a load with no marker writes nothing (new users and everyone else)', async () => {
    const h = await loaded(TABLES(['Old']));
    await h.fns._resumeStrategyRename();
    assert.equal(h.client.writes.length, 0);
    assert.equal(strat(h).name, 'Old');
});

test('the save handler sends only a real name change to the rename flow', () => {
    assert.match(APP, /if \(existingStrat && existingStrat\.name !== rawName\) \{\s*await _renameStrategyFlow\(existingStrat, strategy\);\s*return;/);
    assert.match(APP, /if \(!existingStrat\) DenariiFilters\.forgetStrategyRename\(rawName\);/);
});

test('no schema or backup table is referenced by the rename code', () => {
    assert.equal(AUTH.includes('trades_setup_type_backup'), false);
    assert.equal(APP.includes('trades_setup_type_backup'), false);
});

test('index.html: versions bumped for this change', () => {
    const ver = file => Number((HTML.split('src="' + file + '?v=')[1] || '0"').split('"')[0]);
    assert.ok(ver('Denarii.js') >= 64);
    assert.ok(ver('js/auth.js') >= 43);
    assert.ok(ver('js/shared/filter-bar.js') >= 4);
    const min = { snapshot: 13, 'perf-trends': 11, setups: 9, timing: 6, symbols: 6, risk: 8, discipline: 8 };
    for (const p of PAGES) assert.ok(ver('js/pages/' + p + '.js') >= min[p], p);
});
