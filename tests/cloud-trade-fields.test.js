// Batch D1: browser-only trade fields stored in Supabase.
// - _mapArrayRow / _mapSupabaseTradeRow round-trip every new field; old rows
//   load unchanged; type comes from direction.
// - Undefined fields are left out of the row, and the single and bulk upserts
//   never send a NULL for a column a row left out (checked against a fake
//   table that applies PostgREST's upsert rule: every listed column is set).
// - The one-time backfill uploads only missing values, never overwrites,
//   resumes after an interruption, and never touches the Webull columns.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { _mapArrayRow, _mapSupabaseTradeRow } = require('./helpers/auth-mappers.js');
const Backfill = require('../js/services/trade-field-backfill.js');

const AUTH = fs.readFileSync(path.join(__dirname, '..', 'js', 'auth.js'), 'utf8');
const HTML = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const clone = v => JSON.parse(JSON.stringify(v));
const UID = 'U';

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

const NEW_COLS = ['fills', 'gross_pnl', 'fee_source', 'contract_name', 'source_file', 'tos_ref_num',
    'notes_updated_at', 'session_header_date', 'entry_commission_fees', 'exit_commission_fees'];
const FILLS = [
    { fillId: 'f1', quantity: 10, entryPrice: 10, exitPrice: 11, commissionFees: 0.33, pnl: 9.67,
        source: { file: 'a.csv', entryCommissionFees: 0.1, exitCommissionFees: 0.23 } },
    { fillId: 'f2', quantity: 20, entryPrice: 10.15, exitPrice: 11, commissionFees: 0.66, pnl: 16.34, _tmp: 'x' },
];
const full = (extra) => Object.assign({
    id: 501, symbol: 'ZZTEST1', type: 'long', quantity: 30, pnl: 26.01, entryTime: '2026-10-20T14:30:00.000Z',
    exitTime: '2026-10-20T15:00:00.000Z', source: 'csv', brokerAccountId: 'pelosi',
    fills: clone(FILLS), grossPnl: 27, feeSource: 'actual', contractName: 'ZZ261016C00010000',
    sourceFile: 'tos.csv', tosRefNum: 123456, notesUpdatedAt: 1793000000123, sessionHeaderDate: 'Oct 20, 2026',
    entryCommissionFees: 0.4, exitCommissionFees: 0.59, _tempId: 't1', _positionId: 'p1',
}, extra || {});

// ── Mappers ─────────────────────────────────────────────────────────────────

test('mapper: every new field round-trips; temp fields are never written', () => {
    const t = full();
    const row = clone(_mapArrayRow(UID, 'trades', t));
    assert.equal(row.gross_pnl, 27);
    assert.equal(row.fee_source, 'actual');
    assert.equal(row.contract_name, 'ZZ261016C00010000');
    assert.equal(row.source_file, 'tos.csv');
    assert.equal(row.tos_ref_num, '123456');
    assert.equal(row.notes_updated_at, 1793000000123);
    assert.equal(row.session_header_date, 'Oct 20, 2026');
    assert.equal(row.entry_commission_fees, 0.4);
    assert.equal(row.exit_commission_fees, 0.59);
    assert.equal(row.fills.length, 2);
    assert.equal('_tmp' in row.fills[1], false);
    assert.deepEqual(row.fills[0].source, FILLS[0].source);
    assert.equal(JSON.stringify(row).includes('_tempId') || JSON.stringify(row).includes('_positionId'), false);

    const loaded = _mapSupabaseTradeRow(row);
    assert.deepEqual(loaded.fills, row.fills);
    assert.equal(loaded.grossPnl, 27);
    assert.equal(loaded.feeSource, 'actual');
    assert.equal(loaded.contractName, t.contractName);
    assert.equal(loaded.sourceFile, 'tos.csv');
    assert.equal(loaded.tosRefNum, '123456');
    assert.equal(loaded.notesUpdatedAt, 1793000000123);
    assert.equal(loaded.sessionHeaderDate, 'Oct 20, 2026');
    assert.equal(loaded.entryCommissionFees, 0.4);
    assert.equal(loaded.exitCommissionFees, 0.59);
    // Saving the loaded trade again writes the identical row.
    assert.deepEqual(clone(_mapArrayRow(UID, 'trades', loaded)), row);
});

test("mapper: sessionHeaderDate '' stays ''; ISO notesUpdatedAt becomes milliseconds", () => {
    const row = _mapArrayRow(UID, 'trades', { id: 1, sessionHeaderDate: '', notesUpdatedAt: '2026-10-20T14:30:00.000Z' });
    assert.equal(row.session_header_date, '');
    assert.equal(row.notes_updated_at, Date.parse('2026-10-20T14:30:00.000Z'));
    assert.equal(_mapSupabaseTradeRow(clone(row)).sessionHeaderDate, '');
});

test('mapper: undefined fields are left out of the row; explicit null / empty is written as null', () => {
    const row = _mapArrayRow(UID, 'trades', { id: 1, symbol: 'A' });
    NEW_COLS.forEach(c => assert.equal(c in row, false, c));
    const nulls = _mapArrayRow(UID, 'trades', { id: 1, fills: [], grossPnl: null, feeSource: null, contractName: '',
        sourceFile: '', tosRefNum: null, notesUpdatedAt: null, sessionHeaderDate: null,
        entryCommissionFees: null, exitCommissionFees: null });
    NEW_COLS.forEach(c => assert.equal(nulls[c], null, c));
});

test('mapper: an old row without the new columns loads exactly as before (plus type)', () => {
    const row = { id: '7', symbol: 'XOM', direction: 'long', quantity: 40, pnl: -162, entry_time: 'a', exit_time: 'b',
        external_id: null, external_order_ids: null, webull_partials: null };
    const loaded = _mapSupabaseTradeRow(row);
    ['fills', 'grossPnl', 'feeSource', 'contractName', 'sourceFile', 'tosRefNum', 'notesUpdatedAt',
        'sessionHeaderDate', 'entryCommissionFees', 'exitCommissionFees'].forEach(k => assert.equal(k in loaded, false, k));
    assert.equal(loaded.quantity, 40);
    assert.equal(loaded.pnl, -162);
    // Nulls in the new columns behave the same as missing columns.
    const withNulls = _mapSupabaseTradeRow(Object.assign({}, row, Object.fromEntries(NEW_COLS.map(c => [c, null]))));
    assert.deepEqual(withNulls, loaded);
});

test('mapper: type comes from direction when missing', () => {
    assert.equal(_mapSupabaseTradeRow({ id: '1', direction: 'short' }).type, 'short');
    assert.equal(_mapSupabaseTradeRow({ id: '1', direction: 'long' }).type, 'long');
    assert.equal('type' in _mapSupabaseTradeRow({ id: '1', direction: null }), false);
});

test('mapper: Webull trade writes fills too and keeps its Webull fields', () => {
    const wb = full({ source: 'webull', externalId: 'webull:j:a:o1', externalOrderIds: { o1: 30 },
        webullPartials: [{ quantity: 1 }] });
    const row = _mapArrayRow(UID, 'trades', wb);
    assert.equal(row.fills.length, 2);
    assert.equal(row.external_id, 'webull:j:a:o1');
    assert.deepEqual(row.external_order_ids, { o1: 30 });
    assert.deepEqual(row.webull_partials, [{ quantity: 1 }]);
});

// ── Single and bulk saves: omitted columns keep the cloud value ─────────────

// Fake trades table applying PostgREST's upsert rule: the request's column
// list is the union of the rows' keys (as supabase-js sends it), and on
// conflict every listed column is set, NULL where a row lacks the key.
function fakeClient(rows) {
    const table = new Map((rows || []).map(r => [String(r.id), clone(r)]));
    const requests = [];
    const client = {
        from: () => ({
            upsert: async (values, opts) => {
                const cols = [...new Set(values.flatMap(v => Object.keys(v)))];
                requests.push({ values: clone(values), cols, opts });
                for (const v of values) {
                    const cur = table.get(String(v.id)) || {};
                    for (const c of cols) cur[c] = c in v ? clone(v[c]) : null;
                    table.set(String(v.id), cur);
                }
                return { error: null };
            },
        }),
    };
    return { client, table, requests };
}

function saveFns(client) {
    const code = ['_groupRowsByKeySet', '_saveTradeToSupabase', '_saveTradesToSupabase']
        .map(n => extractFunction(AUTH, n)).join('\n');
    return new Function('_getCloudSaveContext', '_mapArrayRow', 'console', code +
        '\nreturn { _groupRowsByKeySet, _saveTradeToSupabase, _saveTradesToSupabase };')(
        () => ({ client, userId: UID }), _mapArrayRow, { log() {}, error() {} });
}

test('single save: a trade without fills leaves the cloud fills unchanged (no fills key sent)', async () => {
    const cloudRow = _mapArrayRow(UID, 'trades', full());
    const f = fakeClient([cloudRow]);
    const fns = saveFns(f.client);
    const t = full({ notes: 'edited' });
    delete t.fills; delete t.grossPnl;
    const r = await fns._saveTradeToSupabase(t);
    assert.equal(r.success, true);
    assert.equal('fills' in f.requests[0].values[0], false);
    assert.equal(f.requests[0].cols.includes('fills'), false);
    assert.equal(f.table.get('501').fills.length, 2);
    assert.equal(f.table.get('501').gross_pnl, 27);
    assert.equal(f.table.get('501').notes, 'edited');
});

test('bulk save: rows with and without fills send no NULL for the missing columns', async () => {
    const a = _mapArrayRow(UID, 'trades', full({ id: 1 }));
    const b = _mapArrayRow(UID, 'trades', full({ id: 2 }));
    const f = fakeClient([a, b]);
    const fns = saveFns(f.client);
    const withFills = full({ id: 1, fills: [FILLS[0]], quantity: 10 });
    const without = full({ id: 2, notes: 'n2' });
    delete without.fills; delete without.sessionHeaderDate;
    const r = await fns._saveTradesToSupabase([withFills, without]);
    assert.equal(r.success, true);
    for (const req of f.requests) {
        // Every row in a request names exactly the request's columns.
        for (const v of req.values) assert.deepEqual(Object.keys(v).sort(), [...req.cols].sort());
        assert.deepEqual(req.opts, { onConflict: 'user_id,id' });
    }
    assert.equal(f.requests.length, 2);
    assert.equal(f.table.get('1').fills.length, 1);
    assert.equal(f.table.get('2').fills.length, 2);
    assert.equal(f.table.get('2').session_header_date, 'Oct 20, 2026');
    assert.equal(f.table.get('2').notes, 'n2');
});

test('bulk save: same key sets stay one request, chunked at 500', async () => {
    const f = fakeClient([]);
    const fns = saveFns(f.client);
    const trades = Array.from({ length: 1201 }, (_, i) => ({ id: i + 1, symbol: 'S' }));
    await fns._saveTradesToSupabase(trades);
    assert.deepEqual(f.requests.map(r => r.values.length), [500, 500, 201]);
});

test('explicit fill edit still writes the new fills; explicit [] clears them', async () => {
    const f = fakeClient([_mapArrayRow(UID, 'trades', full())]);
    const fns = saveFns(f.client);
    const edited = full({ fills: [Object.assign({}, FILLS[0], { exitPrice: 11.5 }), FILLS[1]] });
    await fns._saveTradeToSupabase(edited);
    assert.equal(f.table.get('501').fills[0].exitPrice, 11.5);
    await fns._saveTradeToSupabase(full({ fills: [] }));
    assert.equal(f.table.get('501').fills, null);
});

// ── Backfill ────────────────────────────────────────────────────────────────

// Fake client for guarded updates: update(patch).eq().eq().is()... awaited.
function fakeUpdateClient(rows, o) {
    o = o || {};
    const table = new Map(rows.map(r => [String(r.id), clone(r)]));
    const updates = [];
    let n = 0;
    const client = {
        from: () => ({
            update: (patch, opts) => {
                const q = { patch: clone(patch), opts, eqs: {}, isNull: [] };
                const b = {
                    eq: (c, v) => { q.eqs[c] = v; return b; },
                    is: (c, v) => { assert.equal(v, null); q.isNull.push(c); return b; },
                    then: (res, rej) => {
                        n++;
                        updates.push(q);
                        if (o.failAt && o.failAt(n, q)) return Promise.resolve(o.failAt(n, q)).then(res, rej);
                        const cur = table.get(String(q.eqs.id));
                        let count = 0;
                        if (cur && q.eqs.user_id === UID && q.isNull.every(c => cur[c] == null)) {
                            Object.assign(cur, clone(patch)); count = 1;
                        }
                        return Promise.resolve({ error: null, count }).then(res, rej);
                    },
                };
                return b;
            },
        }),
    };
    return { client, table, updates };
}

function memStorage() {
    const m = new Map();
    return { getItem: k => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), _m: m };
}

// Cloud rows as they were before D1: the existing columns only.
const cloudOnly = t => {
    const r = clone(_mapArrayRow(UID, 'trades', t));
    NEW_COLS.forEach(c => delete r[c]);
    r.id = String(r.id);
    return r;
};

function setup(local, cloud, o) {
    const f = fakeUpdateClient(cloud, o);
    const storage = (o && o.storage) || memStorage();
    let fetches = 0;
    Object.assign(Backfill._deps, {
        getCtx: () => ({ client: f.client, userId: UID }),
        fetchRows: async () => { fetches++; return clone([...f.table.values()]); },
        mapRow: (uid, t) => _mapArrayRow(uid, 'trades', t),
        getTrades: () => local,
        storage: () => storage,
        pause: async () => {},
    });
    return { f, storage, fetches: () => fetches, marker: () => JSON.parse(storage.getItem(Backfill.markerKey(UID))) };
}

const quiet = fn => async () => {
    const saved = { log: console.log, warn: console.warn, table: console.table, error: console.error };
    const out = [];
    console.log = console.warn = console.error = (...a) => out.push(a.join(' '));
    console.table = rows => out.push('TABLE ' + JSON.stringify(rows));
    try { await fn(out); } finally { Object.assign(console, saved); }
};

test('backfill: uploads only missing values and never overwrites a set cloud value', quiet(async () => {
    const t = full();
    const cloud = cloudOnly(t);
    cloud.fee_source = 'manual';   // already set in the cloud
    const s = setup([t], [cloud]);
    const r = await Backfill.run();
    assert.equal(r.status, 'done');
    const row = s.f.table.get('501');
    assert.equal(row.fee_source, 'manual');
    assert.equal(row.fills.length, 2);
    assert.equal(row.gross_pnl, 27);
    assert.equal(row.session_header_date, 'Oct 20, 2026');
    const u = s.f.updates[0];
    assert.equal('fee_source' in u.patch, false);
    assert.deepEqual(Object.keys(u.patch).sort(), [...u.isNull].sort());   // every written column guarded
    assert.deepEqual(u.eqs, { user_id: UID, id: '501' });
    assert.deepEqual(Object.keys(u.patch).filter(c => !NEW_COLS.includes(c)), []);
    assert.equal(row.pnl, 26.01);
    assert.equal(row.quantity, 30);
}));

test('backfill: totals, times and ids never sent; temp fields skipped', quiet(async () => {
    const s = setup([full()], [cloudOnly(full())]);
    await Backfill.run();
    const p = s.f.updates[0].patch;
    ['pnl', 'quantity', 'entry_time', 'exit_time', 'id', 'user_id', 'external_id', 'external_order_ids', 'webull_partials']
        .forEach(c => assert.equal(c in p, false, c));
    assert.equal(JSON.stringify(p).includes('_tempId') || JSON.stringify(p).includes('_positionId') || JSON.stringify(p).includes('_tmp'), false);
}));

test('backfill: Webull trades upload fills; Webull columns stay exactly as stored', quiet(async () => {
    const wb = full({ id: 900, source: 'webull', externalId: 'webull:j:a:o1', externalOrderIds: { o1: 30 },
        webullPartials: [{ quantity: 1 }] });
    const cloud = cloudOnly(wb);
    cloud.external_order_ids = { o1: 30, o2: 5 };   // the cloud's own value differs from local
    const s = setup([wb], [cloud]);
    await Backfill.run();
    const row = s.f.table.get('900');
    assert.equal(row.fills.length, 2);
    assert.equal(row.external_id, 'webull:j:a:o1');
    assert.deepEqual(row.external_order_ids, { o1: 30, o2: 5 });
    assert.deepEqual(row.webull_partials, [{ quantity: 1 }]);
}));

test('backfill: nothing to do for trades already complete, missing in the cloud, or without an id', quiet(async () => {
    const done = full({ id: 1 });
    const cloudDone = clone(_mapArrayRow(UID, 'trades', done)); cloudDone.id = '1';
    const s = setup([done, full({ id: 2 }), full({ id: undefined })], [cloudDone]);
    const r = await Backfill.run();
    assert.equal(s.f.updates.length, 0);
    assert.equal(r.marker.counts.nothingToUpload, 1);
    assert.equal(r.marker.counts.noCloudRow, 1);
    assert.equal(r.marker.counts.noId, 1);
    assert.equal(s.f.table.size, 1);   // never creates a row
}));

test('backfill: stale local trades are skipped, listed in the marker and printed', quiet(async (out) => {
    const a = full({ id: 1 }), b = full({ id: 2 }), c = full({ id: 3 }), d = full({ id: 4 });
    const ca = cloudOnly(a); ca.quantity = 20;              // split elsewhere
    const cb = cloudOnly(b); cb.pnl = 26.014;               // rounding only: not stale
    const cc = cloudOnly(c); cc.exit_time = '2026-10-21T15:00:00.000Z';
    const dd = full({ id: 4, quantity: 31 }); const cd = cloudOnly(dd);   // fills add to 30, cloud 31
    const s = setup([a, b, c, dd], [ca, cb, cc, cd]);
    const r = await Backfill.run();
    assert.deepEqual(r.marker.stale.map(x => [x.id, x.reason]),
        [['1', 'quantity'], ['3', 'exit_time'], ['4', 'fills quantity']]);
    assert.equal(r.marker.uploaded, 1);
    assert.equal(s.f.table.get('1').fills, undefined);
    assert.ok(out.some(l => l.startsWith('TABLE') && l.includes('"reason":"quantity"')));
    assert.deepEqual(s.marker().stale, r.marker.stale);
}));

test('backfill: interrupted by a network error, resumes and uploads only the rest', quiet(async () => {
    const local = Array.from({ length: 60 }, (_, i) => full({ id: i + 1 }));
    const cloud = local.map(cloudOnly);
    const s = setup(local, cloud, { failAt: n => (n === 30 ? { error: { message: 'TypeError: Failed to fetch' } } : null) });
    const r1 = await Backfill.run();
    assert.equal(r1.status, 'running');
    assert.equal(r1.marker.uploaded, 29);
    assert.equal(s.marker().status, 'running');
    // Next sign-in: same storage, network back.
    const s2 = setup(local, [...s.f.table.values()], { storage: s.storage });
    const r2 = await Backfill.run();
    assert.equal(r2.status, 'done');
    assert.equal(r2.marker.uploaded, 31);
    assert.equal(s2.f.updates.length, 31);
    assert.equal([...s2.f.table.values()].every(r => r.fills && r.fills.length === 2), true);
}));

test('backfill: batches of 25 with the marker written after each batch', quiet(async () => {
    const local = Array.from({ length: 60 }, (_, i) => full({ id: i + 1 }));
    const storage = memStorage();
    const writes = [];
    const set = storage.setItem;
    storage.setItem = (k, v) => { writes.push(JSON.parse(v).uploaded); set(k, v); };
    setup(local, local.map(cloudOnly), { storage });
    await Backfill.run();
    assert.equal(Backfill.BATCH, 25);
    assert.deepEqual(writes, [0, 25, 50, 60, 60]);
}));

test('backfill: a row error is counted, the run continues and ends partial; partial reruns', quiet(async () => {
    const local = [full({ id: 1 }), full({ id: 2 })];
    const s = setup(local, local.map(cloudOnly), { failAt: (n, q) => (q.eqs.id === '1' ? { error: { message: 'permission denied' } } : null) });
    const r = await Backfill.run();
    assert.equal(r.status, 'partial');
    assert.deepEqual(r.marker.failedIds, ['1']);
    assert.equal(s.f.table.get('2').fills.length, 2);
    const s2 = setup(local, [...s.f.table.values()], { storage: s.storage });
    const r2 = await Backfill.run();
    assert.equal(r2.status, 'done');
    assert.equal(s2.f.updates.length, 1);
}));

test('backfill: runs once; done means no fetch and no writes; force reruns', quiet(async () => {
    const local = [full()];
    const s = setup(local, local.map(cloudOnly));
    await Backfill.run();
    const s2 = setup(local, [...s.f.table.values()], { storage: s.storage });
    const r = await Backfill.run();
    assert.equal(r.status, 'done');
    assert.equal(s2.fetches(), 0);
    assert.equal(s2.f.updates.length, 0);
    const r3 = await Backfill.run({ force: true });
    assert.equal(s2.fetches(), 1);
    assert.equal(s2.f.updates.length, 0);   // everything already set
    assert.equal(r3.marker.counts.nothingToUpload, 1);
}));

test('backfill: dry run writes nothing; source option uploads from the saved JSON copy', quiet(async () => {
    const t = full();
    const s = setup([], [cloudOnly(t)]);
    const dry = await Backfill.run({ dryRun: true, source: { trades: [t] } });
    assert.equal(dry.status, 'dry-run');
    assert.equal(dry.patches.length, 1);
    assert.equal(s.f.updates.length, 0);
    assert.equal(s.storage.getItem(Backfill.markerKey(UID)), null);
    const r = await Backfill.run({ source: { trades: [t] } });
    assert.equal(r.status, 'done');
    assert.equal(s.f.table.get('501').fills.length, 2);
}));

test('backfill: no cloud context means no run', quiet(async () => {
    setup([full()], []);
    Backfill._deps.getCtx = () => null;
    assert.equal((await Backfill.run()).status, 'no-cloud');
}));

test('index.html: auth.js bumped and the backfill script loads after it', () => {
    // At least the D1 version (later batches bump it again).
    const m = /src="js\/auth\.js\?v=(\d+)"/.exec(HTML);
    assert.ok(m && Number(m[1]) >= 34);
    const a = m.index;
    const b = HTML.indexOf('src="js/services/trade-field-backfill.js?v=');
    assert.ok(a > 0 && b > a);
    assert.ok(Number(HTML.split('src="js/services/trade-field-backfill.js?v=')[1].split('"')[0]) >= 1);
});
