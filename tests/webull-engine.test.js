// Webull sync engine: pure-core fixtures, import planning and the local applyBatch.
// Covers docs/webull-sync-plan.md §9 engine cases plus short/cover, reversal,
// orphan closes, options x100, skips, overlap dedupe and FIFO slice pricing.

const test = require('node:test');
const assert = require('node:assert/strict');
const engine = require('../js/services/webull-sync.js');

// Copy of deriveTradeSummaryFromFills + finalizeTradeSummary (Denarii.js).
// The engine takes finalize by injection; the browser passes the real one.
function finalize(trade) {
    if (!trade || !Array.isArray(trade.fills) || trade.fills.length === 0) return trade;
    const side = trade.type || 'long';
    const mult = trade.assetType === 'option' ? 100 : 1;
    let qty = 0, en = 0, ex = 0, comm = 0, pnl = 0, gross = 0, first = Infinity, last = -Infinity;
    for (const f of trade.fills) {
        const q = Number(f.quantity) || 0;
        if (q <= 0) continue;
        const ep = Number(f.entryPrice) || 0, xp = Number(f.exitPrice) || 0, c = Number(f.commissionFees) || 0;
        qty += q; en += ep * q; ex += xp * q; comm += c;
        const g = side === 'long' ? (xp - ep) * q * mult : (ep - xp) * q * mult;
        gross += g;
        pnl += (f.pnl != null && Number.isFinite(Number(f.pnl))) ? Number(f.pnl) : g - c;
        const a = f.entryTime ? new Date(f.entryTime).getTime() : NaN;
        const b = f.exitTime ? new Date(f.exitTime).getTime() : NaN;
        if (Number.isFinite(a) && a < first) first = a;
        if (Number.isFinite(b) && b > last) last = b;
    }
    if (qty <= 0) return trade;
    trade.quantity = qty;
    trade.entryPrice = en / qty;
    trade.exitPrice = ex / qty;
    trade.entryTime = Number.isFinite(first) ? new Date(first).toISOString() : null;
    trade.exitTime = Number.isFinite(last) ? new Date(last).toISOString() : null;
    trade.grossPnl = gross;
    trade.pnl = pnl;
    trade.commissionFees = comm;
    trade.holdSeconds = Number.isFinite(first) && Number.isFinite(last) ? Math.max(0, (last - first) / 1000) : 0;
    return trade;
}

const at = (min) => new Date(Date.UTC(2026, 6, 1, 14, min)).toISOString();

let seq = 0;
function fill(o) {
    seq++;
    return Object.assign({
        orderId: 'o' + seq, symbol: 'AAA', side: 'BUY', positionIntent: null, status: 'FILLED',
        instrumentType: 'EQUITY', filledQty: 10, filledPrice: 10, filledAt: at(seq), placedAt: null,
        fees: 0, legs: [],
    }, o);
}

function optFill(o, leg) {
    return fill(Object.assign({
        symbol: 'MSFT', instrumentType: 'OPTION',
        legs: [Object.assign({ symbol: 'MSFT', optionType: 'CALL', strike: 537.5, expiry: '2026-10-16', multiplier: 100, quantity: 1 }, leg)],
    }, o));
}

function ctx(journalId) {
    let n = 1000;
    return { journalId: journalId || 'J1', webullAccountId: 'A1', finalize, nextId: () => n++ };
}

const run = (fills, existing, c) => engine.buildPreview(fills, existing || [], c || ctx());
const near = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
const closedTrades = (p) => p.create.filter(t => t.exitTime);
const openTrades = (p) => p.create.filter(t => !t.exitTime);

test('two journals + same order → two trades with different externalId', () => {
    const fills = [fill({ side: 'BUY' }), fill({ side: 'SELL', filledPrice: 12 })];
    const a = run(fills, [], ctx('J1'));
    const b = run(fills, [], ctx('J2'));
    assert.equal(a.create.length, 1);
    assert.equal(b.create.length, 1);
    assert.notEqual(a.create[0].externalId, b.create[0].externalId);
    assert.equal(a.create[0].externalId, 'webull:J1:A1:' + fills[0].orderId);
    assert.equal(b.create[0].brokerAccountId, 'J2');
});

test('re-running the same window changes nothing', () => {
    const fills = [fill({ side: 'BUY' }), fill({ side: 'SELL', filledPrice: 12 }), fill({ side: 'BUY', symbol: 'BBB' })];
    const first = run(fills);
    assert.equal(first.create.length, 2);
    const existing = first.create.map(t => ({ ...t }));
    const second = run(fills, existing);
    assert.equal(second.create.length, 0);
    assert.equal(second.update.length, 0);
    assert.equal(second.skipped.length, 0);
    assert.equal(second.alreadyImported, 3);
});

test('open in sync 1, close in sync 2 → same id, now closed', () => {
    const buy = fill({ side: 'BUY', filledPrice: 10 });
    const s1 = run([buy]);
    assert.equal(s1.create.length, 1);
    const open = s1.create[0];
    assert.equal(open.exitTime, null);
    assert.equal(open.exitPrice, null);
    assert.equal(open.pnl, null);

    const sell = fill({ side: 'SELL', filledPrice: 13 });
    const s2 = run([buy, sell], [open]);
    assert.equal(s2.create.length, 0);
    assert.equal(s2.update.length, 1);
    assert.equal(s2.alreadyImported, 1);
    const after = s2.update[0].after;
    assert.equal(after.id, open.id);
    assert.equal(after.externalId, open.externalId);
    near(after.pnl, 30);
    near(after.exitPrice, 13);
    assert.deepEqual(after.externalOrderIds, { [buy.orderId]: 10, [sell.orderId]: 10 });
});

test('partial fill that grows across syncs → only the difference is applied', () => {
    const p1 = fill({ side: 'BUY', status: 'PARTIAL_FILLED', filledQty: 4 });
    const s1 = run([p1]);
    assert.equal(s1.create[0].quantity, 4);
    const grown = { ...p1, status: 'FILLED', filledQty: 10 };
    const s2 = run([grown], [s1.create[0]]);
    assert.equal(s2.update.length, 1);
    assert.equal(s2.update[0].after.quantity, 10);
    assert.deepEqual(s2.update[0].after.externalOrderIds, { [p1.orderId]: 10 });
});

test('orphan SELL with no open long → skipped, nothing created', () => {
    const sell = fill({ side: 'SELL', filledQty: 7 });
    const p = run([sell]);
    assert.equal(p.create.length, 0);
    assert.equal(p.skipped.length, 1);
    assert.deepEqual(p.skipped[0], {
        orderId: sell.orderId, symbol: 'AAA', side: 'SELL', qty: 7, dateET: '2026-07-01',
        reason: 'skipped: opened before start date',
    });
});

test('orphan SELL larger than the open long → matched part applied, excess skipped', () => {
    const p = run([fill({ side: 'BUY', filledQty: 5 }), fill({ side: 'SELL', filledQty: 8, filledPrice: 11 })]);
    assert.equal(closedTrades(p).length, 1);
    assert.equal(p.create[0].quantity, 5);
    near(p.create[0].pnl, 5);
    assert.equal(p.skipped.length, 1);
    assert.equal(p.skipped[0].qty, 3);
    assert.equal(p.skipped[0].reason, 'skipped: opened before start date');
    assert.equal(p.checks.qtyBalanced, true);
});

test('option SELL_TO_CLOSE with no open → skipped', () => {
    const p = run([optFill({ side: 'SELL', positionIntent: 'SELL_TO_CLOSE', filledQty: 2 })]);
    assert.equal(p.create.length, 0);
    assert.equal(p.skipped[0].side, 'SELL_TO_CLOSE');
});

test('SHORT then BUY cover → one closed short trade', () => {
    const p = run([
        fill({ side: 'SHORT', filledQty: 10, filledPrice: 50, fees: 0.25 }),
        fill({ side: 'BUY', filledQty: 10, filledPrice: 45, fees: 0.05 }),
    ]);
    assert.equal(p.create.length, 1);
    const t = p.create[0];
    assert.equal(t.type, 'short');
    near(t.grossPnl, 50);
    near(t.pnl, 49.7);
    near(t.commissionFees, 0.3);
    assert.equal(p.openAtEnd.length, 0);
});

test('reversal: BUY past a short closes it and opens a long with the rest', () => {
    const short = fill({ side: 'SHORT', filledQty: 5, filledPrice: 20 });
    const buy = fill({ side: 'BUY', filledQty: 8, filledPrice: 18 });
    const p = run([short, buy]);
    assert.equal(closedTrades(p).length, 1);
    assert.equal(openTrades(p).length, 1);
    const closed = closedTrades(p)[0], open = openTrades(p)[0];
    assert.equal(closed.type, 'short');
    near(closed.pnl, 10);
    assert.equal(open.type, 'long');
    assert.equal(open.quantity, 3);
    assert.equal(open.externalId, 'webull:J1:A1:' + buy.orderId);
    assert.notEqual(open.externalId, closed.externalId);
    assert.equal(closed.externalOrderIds[buy.orderId], 5);
    assert.equal(open.externalOrderIds[buy.orderId], 3);
    assert.equal(p.openAtEnd[0].verify, true);
});

test('SHORT while a long is open → skipped', () => {
    const p = run([fill({ side: 'BUY' }), fill({ side: 'SHORT', filledQty: 3 })]);
    assert.equal(p.skipped.length, 1);
    assert.equal(p.skipped[0].reason, 'skipped: short while long open');
});

test('option BUY_TO_OPEN then SELL_TO_CLOSE uses x100 math', () => {
    const p = run([
        optFill({ side: 'BUY', positionIntent: 'BUY_TO_OPEN', filledQty: 2, filledPrice: 1.5, fees: 0.1 }),
        optFill({ side: 'SELL', positionIntent: 'SELL_TO_CLOSE', filledQty: 2, filledPrice: 2.0, fees: 0.2 }),
    ]);
    assert.equal(p.create.length, 1);
    const t = p.create[0];
    assert.equal(t.assetType, 'option');
    assert.equal(t.symbol, 'MSFT');
    assert.equal(t.optionType, 'CALL');
    assert.equal(t.strike, 537.5);
    assert.equal(t.expiry, '2026-10-16');
    assert.equal(t.contractName, 'MSFT261016C00537500');
    near(t.grossPnl, 100);
    near(t.pnl, 99.7);
});

test('multi-leg and nonstandard multiplier are skipped', () => {
    const multi = fill({ instrumentType: 'OPTION', legs: [{ symbol: 'X', optionType: 'CALL', strike: 1, expiry: '2026-10-16' }, { symbol: 'X', optionType: 'PUT', strike: 1, expiry: '2026-10-16' }] });
    const odd = optFill({ positionIntent: 'BUY_TO_OPEN' }, { multiplier: 10 });
    const p = run([multi, odd]);
    assert.equal(p.create.length, 0);
    assert.deepEqual(p.skipped.map(s => s.reason), ['skipped: multi-leg order', 'skipped: nonstandard multiplier']);
});

test('dedupe across overlapping windows keeps one copy (the larger fill)', () => {
    const buy = fill({ side: 'BUY', status: 'PARTIAL_FILLED', filledQty: 6 });
    const sell = fill({ side: 'SELL', filledQty: 10, filledPrice: 11 });
    const window1 = [buy];
    const window2 = [{ ...buy, status: 'FILLED', filledQty: 10 }, sell];
    const p = run([...window1, ...window2, { ...sell }]);
    assert.equal(p.fillsFetched, 4);
    assert.equal(p.fillsUnique, 2);
    assert.equal(p.duplicatesDropped, 2);
    assert.equal(p.create.length, 1);
    assert.equal(p.create[0].quantity, 10);
    assert.equal(p.skipped.length, 0);
});

test('existing trades are never mutated and unknown properties survive', () => {
    const buy = fill({ side: 'BUY' });
    const open = run([buy]).create[0];
    open.customNote = 'keep me';
    open.tags = ['a'];
    const manual = { id: 1, symbol: 'AAA', type: 'long', source: 'manual', brokerAccountId: 'J1', quantity: 1, entryPrice: 1, entryTime: at(0), exitTime: null, exitPrice: null };
    const csv = { id: 2, symbol: 'AAA', type: 'long', source: 'csv', brokerAccountId: 'J1', quantity: 1, entryPrice: 1, entryTime: at(0), exitTime: null, exitPrice: null };
    const existing = [open, manual, csv];
    const snapshot = JSON.parse(JSON.stringify(existing));

    const p = run([buy, fill({ side: 'SELL', filledPrice: 12 })], existing);
    assert.deepEqual(JSON.parse(JSON.stringify(existing)), snapshot);
    assert.equal(p.update.length, 1);
    assert.equal(p.update[0].id, open.id);
    assert.equal(p.update[0].after.customNote, 'keep me');
    assert.deepEqual(p.update[0].after.tags, ['a']);
    assert.deepEqual(p.update[0].before, snapshot[0]);
});

test('slice pricing is FIFO, matching the CSV import', () => {
    const b1 = fill({ side: 'BUY', filledQty: 10, filledPrice: 10, fees: 1 });
    const b2 = fill({ side: 'BUY', filledQty: 10, filledPrice: 20, fees: 2 });
    const s1 = fill({ side: 'SELL', filledQty: 15, filledPrice: 30, fees: 0.5 });
    const p = run([b1, b2, s1]);
    assert.equal(p.create.length, 1);
    const t = p.create[0];
    // Partial sell: still open, slices kept in webullPartials, not fills.
    assert.equal(t.exitTime, null);
    assert.equal(t.fills, undefined);
    assert.equal(t.webullPartials.length, 2);
    const [x, y] = t.webullPartials;
    // FIFO: 10 from the $10 lot, 5 from the $20 lot (average cost would price both at $15).
    assert.equal(x.quantity, 10); assert.equal(x.entryPrice, 10);
    assert.equal(y.quantity, 5);  assert.equal(y.entryPrice, 20);
    // Fees: each row charged on the first slice that touches it.
    near(x.commissionFees, 1.5);
    near(y.commissionFees, 2);
    // Remaining open lot is 5 @ $20; its fee was already charged to slice y.
    assert.equal(t.quantity, 5);
    assert.equal(t.entryPrice, 20);
    near(t.commissionFees, 3.5);
    assert.equal(p.openAtEnd[0].verify, true);

    // Closing the rest in a later sync finishes the same trade.
    const s2 = fill({ side: 'SELL', filledQty: 5, filledPrice: 25 });
    const p2 = run([s2], [t]);
    const after = p2.update[0].after;
    assert.equal(after.id, t.id);
    assert.equal(after.webullPartials, undefined);
    assert.equal(after.fills.length, 3);
    assert.equal(after.quantity, 20);
    near(after.grossPnl, 200 + 50 + 25);
    near(after.pnl, 275 - 3.5);
    near(after.entryPrice, 15);
});

test('equity long open at end is marked verify; short is not', () => {
    const p = run([fill({ side: 'BUY', symbol: 'L' }), fill({ side: 'SHORT', symbol: 'S' })]);
    const bySym = Object.fromEntries(p.openAtEnd.map(o => [o.symbol, o]));
    assert.equal(bySym.L.verify, true);
    assert.equal(bySym.S.verify, false);
    assert.equal(openTrades(p).length, 2);
    assert.equal(p.checks.qtyBalanced, true);
});

test('instrumentKey keys equities by symbol and options by contract', () => {
    assert.equal(engine.instrumentKey(fill({ symbol: 'aapl' })).key, 'EQ|AAPL');
    assert.equal(engine.instrumentKey(optFill({})).key, 'OPT|MSFT|CALL|537.5|2026-10-16');
});

// ── Rounding, import planning, cloud round trip ─────────────────────

const { _mapArrayRow, _mapSupabaseTradeRow } = require('./helpers/auth-mappers.js');
const J = 'ba_1792516090168_r2mg8';

// Save through the real mapper and load back as cloud-primary sign-in does
// (JSON transport, TEXT id column).
function reload(trade) {
    const row = JSON.parse(JSON.stringify(_mapArrayRow('U', 'trades', engine.roundTrade(trade))));
    row.id = String(row.id);
    return _mapSupabaseTradeRow(row);
}

const isCents = (v) => v === engine.roundTo(v, 2);
const is4dp = (v) => v === engine.roundTo(v, 4);

test('roundTo: money to cents, prices to 4 decimals, half away from zero', () => {
    assert.equal(engine.MONEY_DP, 2);
    assert.equal(engine.PRICE_DP, 4);
    assert.equal(engine.roundTo(118.12999999999792, 2), 118.13);
    assert.equal(engine.roundTo(1.005, 2), 1.01);
    assert.equal(engine.roundTo(-1.005, 2), -1.01);
    assert.equal(engine.roundTo(-0.001, 2), 0);
    assert.equal(engine.roundTo(911.666666, 4), 911.6667);
    assert.equal(engine.roundTo(null, 2), null);
    assert.equal(engine.roundTo(undefined, 2), undefined);
});

test("planImport refuses creates/updates outside this journal's webull trades", () => {
    const ext = 'webull:' + J + ':A1:o9';
    const upd = { create: [], update: [{ id: 2, externalId: ext, after: { brokerAccountId: J } }] };
    assert.match(engine.planImport(upd, [{ id: '2', source: 'csv', brokerAccountId: J, externalId: ext }], J).error, /not a webull trade/);
    assert.match(engine.planImport(upd, [{ id: '2', source: 'webull', brokerAccountId: 'J2', externalId: ext }], J).error, /not a webull trade/);
    const wrongJournal = { id: 3, source: 'webull', brokerAccountId: 'J2', externalId: 'webull:J2:A1:o1' };
    assert.match(engine.planImport({ create: [wrongJournal], update: [] }, [], J).error, /Create is not/);
    const clash = { id: 4, source: 'webull', brokerAccountId: J, externalId: ext };
    assert.match(engine.planImport({ create: [clash], update: [] }, [{ id: '4', source: 'manual' }], J).error, /id already exists/);
});

test('open option with a partial exit seeds the same key after the cloud round trip', () => {
    const c = { journalId: J, webullAccountId: 'A1', finalize, nextId: () => 900 };
    const buy = optFill({ positionIntent: 'BUY_TO_OPEN', filledQty: 8, filledPrice: 1.82, fees: 0.4 });
    const trim = optFill({ positionIntent: 'SELL_TO_CLOSE', filledQty: 3, filledPrice: 2.10, fees: 0.1 });
    const open = engine.buildPreview([buy, trim], [], c).create[0];
    assert.equal(open.quantity, 5);
    assert.equal(open.webullPartials.length, 1);

    const loaded = reload(open);
    // Batch D1: contractName is stored and type is set from direction.
    assert.equal(loaded.contractName, open.contractName);
    assert.equal(loaded.type, open.type);
    assert.equal(loaded.id, '900');
    assert.equal(engine.tradeKey(loaded), engine.tradeKey(open));
    assert.equal(engine.tradeKey(loaded), engine.instrumentKey(buy).key);
    assert.deepEqual(loaded.externalOrderIds, open.externalOrderIds);
    assert.equal(loaded.webullPartials.length, 1);

    const close = optFill({ positionIntent: 'SELL_TO_CLOSE', filledQty: 5, filledPrice: 1.5, fees: 0.1 });
    const p = engine.buildPreview([buy, trim, close], [loaded], c);
    assert.equal(p.create.length, 0);
    assert.equal(p.skipped.length, 0);
    assert.equal(p.alreadyImported, 2);
    assert.equal(p.update.length, 1);
    const after = p.update[0].after;
    assert.equal(after.id, '900');
    assert.equal(after.exitTime, close.filledAt);
    assert.equal(after.fills.length, 2);
    near(after.commissionFees, 0.6);
    near(after.pnl, 83.5 - 160.1);
});

test('reloaded short (direction only, no type) still closes as a short', () => {
    const c = { journalId: J, webullAccountId: 'A1', finalize, nextId: () => 901 };
    const sh = fill({ side: 'SHORT', filledQty: 10, filledPrice: 20 });
    const loaded = reload(engine.buildPreview([sh], [], c).create[0]);
    assert.equal(loaded.direction, 'short');
    assert.equal(loaded.type, 'short');   // Batch D1: set from direction on load
    delete loaded.type;                   // still closes as a short from direction alone
    const cover = fill({ side: 'BUY', filledQty: 10, filledPrice: 18 });
    const p = engine.buildPreview([sh, cover], [loaded], c);
    assert.equal(p.create.length, 0);
    assert.equal(p.update.length, 1);
    assert.equal(p.update[0].after.type, 'short');
    near(p.update[0].after.pnl, 20);
});

// ── Local sync: applyBatch (docs/webull-local-plan.md §6, §11 engine tests) ──

const ACCOUNT = 'acct-1';
const day = (d, min) => new Date(Date.UTC(2026, 6, d, 14, min || 0)).toISOString();

// Fake preload: records onBatch/attach/detach.
const wb = { cbs: [], attached: [], detached: 0 };
globalThis.denariiWebull = {
    onBatch: (cb) => { wb.cbs.push(cb); return () => { wb.cbs = wb.cbs.filter(c => c !== cb); }; },
    attach: async (id) => { wb.attached.push(id); return { ok: true }; },
    detach: async () => { wb.detached++; return { ok: true }; },
    ackBatch: async () => ({ ok: true }),
};

// In-memory journal with a recording save, ack and refresh. save(jd) may
// return a custom result; by default the save succeeds.
let runSeq = 0, nextTradeId = 5000;
function harness(trades, save) {
    engine.startBatchHandler(ACCOUNT);
    const jd = { trades: trades || [], brokerAccounts: [{ id: J, displayName: 'WB-Margin' }] };
    // ids stay unique across harnesses (planImport refuses an id that exists)
    const h = { jd, acks: [], saves: 0, log: [], saved: null };
    h.opts = {
        journalData: jd, getAccountId: () => ACCOUNT, finalize, nextId: () => nextTradeId++,
        save: async () => {
            h.saves++; h.log.push('save');
            if (save) return save(jd);
            h.saved = JSON.stringify(jd);
            return { ok: true };
        },
        ack: async (runId, r) => { h.log.push('ack'); h.acks.push(Object.assign({ runId }, r)); },
        refresh: () => { h.log.push('refresh'); },
    };
    h.apply = (fills, extra) => engine.applyBatch(Object.assign({
        runId: 'r' + (++runSeq), accountId: ACCOUNT, journalId: J, webullAccountId: 'A1',
        windowStart: 'w0', windowEnd: 'w1', fills,
    }, extra), h.opts);
    h.lastAck = () => h.acks[h.acks.length - 1];
    return h;
}

const closedPnl = (trades) => trades.filter(t => t.exitTime).reduce((s, t) => s + t.pnl, 0);
const qtyBy = (trades, open) => trades.filter(t => !!t.exitTime !== open).reduce((s, t) => s + t.quantity, 0);

test('applyBatch: save → refresh → ack, rows rounded, journalData updated', async () => {
    const fills = [fill({ side: 'BUY', filledPrice: 10.333333, fees: 0.0123 }), fill({ side: 'SELL', filledPrice: 10.111111, fees: 0.0177 })];
    const h = harness();
    const r = await h.apply(fills);
    assert.equal(r.ok, true);
    assert.equal(r.created, 1);
    assert.deepEqual(h.log, ['save', 'refresh', 'ack']);
    assert.deepEqual(h.lastAck(), { runId: 'r' + runSeq, ok: true });

    assert.equal(h.jd.trades.length, 1);
    const t = h.jd.trades[0];
    assert.equal(t.source, 'webull');
    assert.equal(t.brokerAccountId, J);
    assert.equal(t.pnl, -2.25);
    assert.equal(t.webullSyncHash, undefined);   // closed trades carry no hash
    for (const k of ['pnl', 'grossPnl', 'commissionFees']) assert.ok(isCents(t[k]), k + ' ' + t[k]);
    assert.equal(t.entryPrice, 10.3333);
    assert.equal(t.exitPrice, 10.1111);
    for (const s of t.fills) {
        for (const k of ['pnl', 'grossPnl', 'commissionFees']) assert.ok(isCents(s[k]), 'fill ' + k + ' ' + s[k]);
        assert.ok(is4dp(s.entryPrice) && is4dp(s.exitPrice));
        assert.ok(isCents(s.source.entryCommissionFees) && isCents(s.source.exitCommissionFees));
    }
    assert.equal(engine.lastResult(J), r);
});

test('applyBatch: a failed save never acknowledges ok and rolls journalData back', async () => {
    const buy = fill({ side: 'BUY', filledQty: 10, filledAt: day(1) });
    const keep = harness();
    await keep.apply([buy]);
    const before = JSON.stringify(keep.jd);

    for (const failing of [
        async () => ({ ok: false, error: 'forced' }),
        async () => { throw new Error('disk full'); },
        async () => undefined,                      // the old saveToIndexedDB result
    ]) {
        const h = harness(JSON.parse(before).trades);
        h.opts.save = async () => { h.saves++; return failing(); };
        const r = await h.apply([buy, fill({ side: 'SELL', filledQty: 10, filledPrice: 12, filledAt: day(2) }),
            fill({ symbol: 'NEW', side: 'BUY', filledAt: day(3) })]);
        assert.equal(r.ok, false);
        assert.equal(h.saves, 1);
        assert.equal(h.acks.length, 1);
        assert.equal(h.lastAck().ok, false);
        assert.ok(!h.acks.some(a => a.ok === true));
        assert.equal(JSON.stringify(h.jd.trades), JSON.stringify(JSON.parse(before).trades));
    }
});

test('applyBatch: applying per window gives the same totals as applying once', async () => {
    const w1 = [fill({ side: 'BUY', filledQty: 10, filledPrice: 10, filledAt: day(1) }),
        fill({ side: 'BUY', filledQty: 10, filledPrice: 11, filledAt: day(2) }),
        fill({ symbol: 'BBB', side: 'SHORT', filledQty: 4, filledPrice: 50, filledAt: day(2, 30), fees: 1 })];
    const w2 = [fill({ side: 'SELL', filledQty: 8, filledPrice: 12, filledAt: day(3), fees: 0.5 }),
        fill({ symbol: 'BBB', side: 'BUY', filledQty: 4, filledPrice: 45, filledAt: day(4), fees: 1 })];
    const w3 = [fill({ side: 'SELL', filledQty: 12, filledPrice: 13, filledAt: day(5), fees: 0.5 }),
        fill({ symbol: 'CCC', side: 'BUY', filledQty: 3, filledPrice: 7, filledAt: day(6) })];

    const once = harness();
    assert.equal((await once.apply([...w1, ...w2, ...w3])).ok, true);

    const windows = harness();
    // Each window after the first also re-reads the previous one (the 24 h overlap).
    for (const w of [w1, [...w1, ...w2], [...w2, ...w3]]) {
        const r = await windows.apply(w);
        assert.equal(r.ok, true);
        assert.deepEqual(r.notUpdated, []);
        assert.equal(r.review, 0);
    }
    const a = once.jd.trades, b = windows.jd.trades;
    assert.equal(b.length, a.length);
    near(closedPnl(b), closedPnl(a));
    near(closedPnl(a), 42 - 1 + 20 - 2);
    assert.equal(qtyBy(b, false), qtyBy(a, false));
    assert.equal(qtyBy(b, true), qtyBy(a, true));
    near(b.reduce((s, t) => s + t.commissionFees, 0), a.reduce((s, t) => s + t.commissionFees, 0));
});

test('applyBatch: re-acknowledging the same window is a no-op', async () => {
    const fills = [fill({ side: 'BUY', filledAt: day(1) }), fill({ side: 'SELL', filledQty: 4, filledPrice: 11, filledAt: day(2) })];
    const h = harness();
    await h.apply(fills);
    const snap = JSON.stringify(h.jd);
    const r = await h.apply(fills);
    assert.equal(r.ok, true);
    assert.equal(r.created + r.updated, 0);
    assert.equal(r.alreadyImported, 2);
    assert.equal(h.saves, 1);                 // nothing to write, no second save
    assert.equal(h.lastAck().ok, true);
    assert.equal(JSON.stringify(h.jd), snap);
});

test('applyBatch: partial fill growth applies only the difference to the same trade', async () => {
    const h = harness();
    await h.apply([fill({ orderId: 'P1', side: 'BUY', status: 'PARTIAL_FILLED', filledQty: 4, filledPrice: 10, filledAt: day(1) })]);
    assert.equal(h.jd.trades.length, 1);
    const id = h.jd.trades[0].id;
    assert.equal(h.jd.trades[0].quantity, 4);
    assert.ok(h.jd.trades[0].webullSyncHash);

    const r = await h.apply([fill({ orderId: 'P1', side: 'BUY', status: 'FILLED', filledQty: 10, filledPrice: 10, filledAt: day(1) })]);
    assert.equal(r.updated, 1);
    assert.equal(r.created, 0);
    assert.deepEqual(r.notUpdated, []);
    assert.equal(h.jd.trades.length, 1);
    assert.equal(h.jd.trades[0].id, id);
    assert.equal(h.jd.trades[0].quantity, 10);
    assert.deepEqual(h.jd.trades[0].externalOrderIds, { P1: 10 });
    assert.equal(h.jd.trades[0].webullSyncHash, engine.engineHash(h.jd.trades[0]));
});

test('applyBatch: deleted trades are not re-imported', async () => {
    const buy = fill({ side: 'BUY', filledAt: day(1) }), sell = fill({ side: 'SELL', filledPrice: 12, filledAt: day(2) });
    const open = fill({ symbol: 'OPN', side: 'BUY', filledAt: day(3) });
    const h = harness();
    await h.apply([buy, sell, open]);
    assert.equal(h.jd.trades.length, 2);

    // As deleteTrade does: note the ids, then drop the trades.
    assert.equal(engine.noteDeletedTrades(h.jd, h.jd.trades), 3);
    h.jd.trades = [];
    h.opts.journalData = h.jd;
    assert.deepEqual(Object.keys(h.jd.webullIgnoredOrders[J]).sort(), [buy.orderId, sell.orderId, open.orderId].sort());

    const r = await h.apply([buy, sell, open, fill({ symbol: 'OPN', side: 'SELL', filledAt: day(4) })]);
    assert.equal(r.ok, true);
    assert.equal(r.ignored, 3);
    assert.equal(r.created, 0);
    assert.equal(r.skipped, 1);               // the close of the deleted open is an orphan
    assert.equal(h.jd.trades.length, 0);

    // Manual/CSV trades and trades without order ids are not recorded.
    assert.equal(engine.noteDeletedTrades(h.jd, [{ source: 'csv', brokerAccountId: J, externalOrderIds: { x: 1 } }, { source: 'webull', brokerAccountId: J }]), 0);
});

test('applyBatch: an open trade the user edited is not overwritten', async () => {
    const h = harness();
    await h.apply([fill({ side: 'BUY', filledQty: 10, filledPrice: 10, filledAt: day(1) })]);
    const t = h.jd.trades[0];
    t.quantity = 12; t.notes = 'mine';                // user edit
    const edited = JSON.stringify(t);
    const sell = fill({ side: 'SELL', filledQty: 10, filledPrice: 12, filledAt: day(2) });

    const r = await h.apply([sell]);
    assert.equal(r.ok, true);
    assert.equal(r.updated, 0);
    assert.equal(r.review, 1);
    assert.deepEqual(r.notUpdated.map(x => [x.tradeId, x.reason]), [[t.id, 'Edited after import, not updated']]);
    assert.equal(JSON.stringify(h.jd.trades[0]), edited);
    assert.equal(h.jd.webullReview[J][sell.orderId].reason, engine.EDITED);
    assert.equal(h.saves, 2);                        // the held fill is saved for review
    assert.equal(h.lastAck().ok, true);

    // Notes/tags alone don't count as an edit, and a trade imported before
    // hashes existed (no webullSyncHash) is still updated.
    const h2 = harness();
    await h2.apply([fill({ symbol: 'ZZZ', side: 'BUY', filledAt: day(1) })]);
    h2.jd.trades[0].notes = 'n'; h2.jd.trades[0].tags = ['t'];
    assert.equal((await h2.apply([fill({ symbol: 'ZZZ', side: 'BUY', filledAt: day(2) })])).updated, 1);
    delete h2.jd.trades[0].webullSyncHash;
    h2.jd.trades[0].quantity = 99;
    assert.equal((await h2.apply([fill({ symbol: 'ZZZ', side: 'BUY', filledQty: 1, filledAt: day(3) })])).updated, 1);
});

test('applyBatch: moving the start date earlier routes older fills to review', async () => {
    const h = harness();
    await h.apply([fill({ side: 'BUY', filledQty: 10, filledAt: day(10) })]);
    const snapTrades = JSON.stringify(h.jd.trades);

    // Backfill window from the new, earlier start date.
    const oldBuy = fill({ side: 'BUY', filledQty: 5, filledAt: day(2) });
    const oldSell = fill({ side: 'SELL', filledQty: 5, filledPrice: 11, filledAt: day(3) });
    const otherSymbol = fill({ symbol: 'NEW', side: 'BUY', filledAt: day(2) });
    const r = await h.apply([oldBuy, oldSell, otherSymbol]);
    assert.equal(r.ok, true);
    assert.equal(r.review, 2);
    assert.equal(r.created, 1);                       // no Webull trades for NEW yet: imported
    assert.equal(JSON.stringify(h.jd.trades.filter(t => t.symbol === 'AAA')), snapTrades);
    const held = h.jd.webullReview[J];
    assert.deepEqual(Object.keys(held).sort(), [oldBuy.orderId, oldSell.orderId].sort());
    assert.equal(held[oldBuy.orderId].reason, engine.BEFORE_EXISTING);
    assert.equal(held[oldBuy.orderId].fill.filledQty, 5);

    // Re-reading the same backfill window writes nothing new.
    const saves = h.saves;
    const again = await h.apply([oldBuy, oldSell, otherSymbol]);
    assert.equal(again.ok, true);
    assert.equal(h.saves, saves);
});

test('applyBatch: wrong account, missing journal or a refused plan acks not ok and saves nothing', async () => {
    let h = harness();
    let r = await h.apply([fill({})], { accountId: 'other' });
    assert.equal(r.error, 'Not handling batches.');   // handler is for ACCOUNT only
    assert.equal(h.acks.length, 0);

    h = harness();
    h.opts.getAccountId = () => 'someone-else';
    r = await h.apply([fill({})]);
    assert.match(r.error, /another account/);
    assert.equal(h.lastAck().ok, false);

    h = harness();
    r = await h.apply([fill({})], { journalId: 'ba_gone' });
    assert.equal(r.error, 'Journal not found.');
    assert.equal(h.lastAck().ok, false);

    // An externalId the journal already has (without externalOrderIds) is refused.
    const buy = fill({ side: 'BUY' }), sell = fill({ side: 'SELL', filledPrice: 12 });
    const dup = { id: 5, source: 'webull', brokerAccountId: J, externalId: 'webull:' + J + ':A1:' + buy.orderId,
        symbol: 'AAA', type: 'long', quantity: 10, entryPrice: 10, exitPrice: 12, entryTime: buy.filledAt, exitTime: sell.filledAt };
    h = harness([dup]);
    h.jd.trades[0].entryTime = at(0);
    r = await h.apply([buy, sell]);
    assert.match(r.error, /Already imported/);
    assert.equal(h.lastAck().ok, false);
    assert.equal(h.saves, 0);
});

test('applyBatch: update keeps unknown fields; other trades are never changed', async () => {
    const buy = fill({ side: 'BUY', filledPrice: 10 });
    const sell = fill({ side: 'SELL', filledPrice: 13 });
    const first = engine.buildPreview([buy], [], { journalId: J, webullAccountId: 'A1', finalize, nextId: () => 777 }).create[0];
    const open = { ...first, notes: 'keep', tags: ['x'], customField: 1 };
    const manual = { id: 1, symbol: 'AAA', type: 'long', source: 'manual', brokerAccountId: 'demo', quantity: 10, entryPrice: 10, entryTime: at(0), exitTime: null, exitPrice: null, notes: 'p' };
    const csvSame = { id: 2, symbol: 'AAA', type: 'long', source: 'csv', brokerAccountId: J, quantity: 10, entryPrice: 10, entryTime: at(0), exitTime: null, exitPrice: null };
    const others = JSON.stringify([manual, csvSame]);

    const h = harness([manual, open, csvSame]);
    const r = await h.apply([buy, sell]);
    assert.equal(r.ok, true);
    assert.equal(r.created, 0);
    assert.equal(r.updated, 1);
    const row = h.jd.trades[1];
    assert.equal(row.id, 777);
    assert.equal(row.notes, 'keep');
    assert.deepEqual(row.tags, ['x']);
    assert.equal(row.customField, 1);
    assert.equal(row.exitPrice, 13);
    assert.equal(row.pnl, 30);
    assert.equal(h.jd.trades.length, 3);
    assert.equal(JSON.stringify([h.jd.trades[0], h.jd.trades[2]]), others);
});

test('startBatchHandler registers onBatch and attaches; stop (Lock/sign-out) unsubscribes and detaches', async () => {
    engine.stopBatchHandler();
    await Promise.resolve(); await Promise.resolve();
    wb.cbs = []; wb.attached = []; wb.detached = 0;
    assert.equal(engine.startBatchHandler(ACCOUNT), true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(wb.cbs.length, 1);
    assert.deepEqual(wb.attached, [ACCOUNT]);

    // Signing in again replaces the handler instead of adding a second one.
    engine.startBatchHandler(ACCOUNT);
    assert.equal(wb.cbs.length, 1);

    engine.stopBatchHandler();
    await Promise.resolve(); await Promise.resolve();
    assert.equal(wb.cbs.length, 0);
    assert.equal(wb.detached, 1);

    const acks = [];
    const r = await engine.applyBatch({ runId: 'x', accountId: ACCOUNT, journalId: J, webullAccountId: 'A1', fills: [] },
        { journalData: { trades: [], brokerAccounts: [{ id: J }] }, getAccountId: () => ACCOUNT, finalize,
            save: async () => ({ ok: true }), ack: async (id, res) => acks.push(res) });
    assert.equal(r.ok, false);
    assert.equal(acks.length, 0);                    // a locked page never acknowledges
});

// saveToIndexedDB (js/auth.js) reports a real result.
function loadSaveToIndexedDB(env) {
    const src = require('node:fs').readFileSync(require('node:path').join(__dirname, '..', 'js', 'auth.js'), 'utf8');
    const start = src.indexOf('async function saveToIndexedDB(');
    let depth = 0, end = -1;
    for (let i = src.indexOf('{', start); i < src.length; i++) {
        if (src[i] === '{') depth++;
        else if (src[i] === '}' && --depth === 0) { end = i + 1; break; }
    }
    const body = src.slice(start, end);
    return new Function('env', 'with (env) { return (' + body + '); }')(env);
}

test('saveToIndexedDB returns { ok: true } after the local write and { ok: false } otherwise', async () => {
    const base = () => ({
        window: {}, _migrationSavePending: false, sessionDek: 'k', sessionPassword: null, db: {}, currentAccountId: 'a',
        journalData: { trades: [] }, pendingRecoveryKey: null, _firstCloudSaveDone: true, _journalDirty: false,
        encrypt: () => 'enc', saveJournalRecord: async () => {}, _cloudBackupJournal: async () => {}, _shadowWriteRows: () => {},
        _shadowWriteRowsAwaited: async () => {}, _refreshStrategiesIfVisible: undefined,
        document: { getElementById: () => null }, console: { log() {}, warn() {}, error() {} }, setTimeout,
    });
    let env = base();
    assert.deepEqual(await loadSaveToIndexedDB(env)(), { ok: true });

    env = base(); env.saveJournalRecord = async () => { throw new Error('disk full'); };
    assert.deepEqual(await loadSaveToIndexedDB(env)(), { ok: false, error: 'disk full' });

    env = base(); env.sessionDek = null;
    assert.equal((await loadSaveToIndexedDB(env)()).ok, false);

    env = base(); env.window._denariiMigrationRunning = true;
    assert.equal((await loadSaveToIndexedDB(env)()).ok, false);

    // A cloud backup error after the local write doesn't turn it into a failure.
    env = base(); env._firstCloudSaveDone = false; env._cloudBackupJournal = async () => { throw new Error('offline'); };
    assert.deepEqual(await loadSaveToIndexedDB(env)(), { ok: true });
});
