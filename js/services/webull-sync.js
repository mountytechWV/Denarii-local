// Webull sync engine — page side of the local sync.
//
// Main (electron/webull/) reads Webull and sends one window of normalized
// fills at a time through window.denariiWebull.onBatch. `applyBatch` turns
// them into Denarii trades for one journal (= broker account), saves the
// journal locally and only then acknowledges the batch, so main moves its
// cursor only after a real save. It never deletes trades and only modifies
// source 'webull' trades of the target journal. The DEK never leaves the page.
// See docs/webull-local-plan.md §6.
//
// Slice pricing matches the CSV import (matchTradePairs / _emitSlice in
// Denarii.js): FIFO lots per instrument, each closing slice priced at the
// lot's entry price, and a row's fees charged on the first slice it touches.
//
// The pure core (dedupeFills, instrumentKey, applyFills, buildPreview,
// planImport, roundTrade) and the batch planning (partitionFills, planBatch)
// have no browser dependencies and is exported for Node tests via module.exports.
(function (root) {
    'use strict';

    const KEEP_STATUSES = ['FILLED', 'PARTIAL_FILLED'];
    const EPS = 1e-9;
    const ORPHAN = 'skipped: opened before start date';

    // Rounding applied before save: money (pnl, grossPnl, fees) to cents,
    // prices to 4 decimals so seeded average entries don't skew later P&L.
    const MONEY_DP = 2;
    const PRICE_DP = 4;
    // Fields the engine owns on an existing Webull trade. Updates copy only
    // these onto the current trade; every other property is kept.
    const ENGINE_FIELDS = Object.freeze(['type', 'quantity', 'entryPrice', 'entryTime', 'exitPrice', 'exitTime',
        'holdSeconds', 'grossPnl', 'pnl', 'commissionFees', 'externalOrderIds', 'fills', 'webullPartials']);

    function round(n) { return Math.round(n * 1e8) / 1e8; }
    function timeMs(v) { const n = Date.parse(v || ''); return Number.isFinite(n) ? n : NaN; }

    function clone(v) {
        if (typeof structuredClone === 'function') return structuredClone(v);
        return JSON.parse(JSON.stringify(v));
    }

    // Same rule as _isOpenTrade in Denarii.js.
    function isOpenTrade(t) { return !t.exitTime || t.exitPrice == null; }

    function dateET(iso) {
        const ms = timeMs(iso);
        if (!Number.isFinite(ms)) return null;
        return new Intl.DateTimeFormat('en-CA', {
            timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit'
        }).format(new Date(ms));
    }

    // One fill per orderId. Overlapping sync windows can return the same
    // order twice; keep the copy with the larger filledQty (a partial fill
    // that grew). Output is sorted by filledAt, then placedAt, then orderId.
    function dedupeFills(fills) {
        const byId = new Map();
        let duplicatesDropped = 0, malformed = 0;
        for (const f of Array.isArray(fills) ? fills : []) {
            if (!f || typeof f !== 'object' || !f.orderId || !(Number(f.filledQty) > 0)) { malformed++; continue; }
            const prev = byId.get(f.orderId);
            if (prev) {
                duplicatesDropped++;
                if (Number(f.filledQty) > Number(prev.filledQty)) byId.set(f.orderId, f);
            } else {
                byId.set(f.orderId, f);
            }
        }
        const out = Array.from(byId.values()).sort((a, b) =>
            (timeMs(a.filledAt) - timeMs(b.filledAt)) ||
            ((timeMs(a.placedAt) || 0) - (timeMs(b.placedAt) || 0)) ||
            (a.orderId < b.orderId ? -1 : a.orderId > b.orderId ? 1 : 0));
        return { fills: out, duplicatesDropped, malformed };
    }

    function occName(underlying, optionType, strike, expiry) {
        const ymd = expiry.replace(/-/g, '').slice(2);
        const k = String(Math.round(strike * 1000)).padStart(8, '0');
        return underlying + ymd + (optionType === 'CALL' ? 'C' : 'P') + k;
    }

    // Instrument identity for a fill. Equities key on symbol; options on
    // underlying + type + strike + expiry from legs[0]. Returns { skip } for
    // fills the engine doesn't handle.
    function instrumentKey(fill) {
        const legs = Array.isArray(fill.legs) ? fill.legs : [];
        if (legs.length > 1) return { skip: 'skipped: multi-leg order' };
        const isOption = fill.instrumentType === 'OPTION' || (legs[0] && legs[0].optionType);
        if (!isOption) {
            const symbol = String(fill.symbol || '').toUpperCase();
            if (!symbol) return { skip: 'skipped: missing symbol' };
            return {
                key: 'EQ|' + symbol, symbol, assetType: 'stock',
                optionType: null, strike: 0, expiry: null, contractName: ''
            };
        }
        const leg = legs[0] || {};
        if (leg.multiplier != null && Number(leg.multiplier) !== 100) return { skip: 'skipped: nonstandard multiplier' };
        const symbol = String(leg.symbol || fill.symbol || '').toUpperCase();
        const optionType = String(leg.optionType || '').toUpperCase();
        const strike = Number(leg.strike);
        const expiry = String(leg.expiry || '').slice(0, 10);
        if (!symbol || (optionType !== 'CALL' && optionType !== 'PUT') ||
            !(strike > 0) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) {
            return { skip: 'skipped: unreadable option contract' };
        }
        return {
            key: ['OPT', symbol, optionType, strike, expiry].join('|'), symbol, assetType: 'option',
            optionType, strike, expiry, contractName: occName(symbol, optionType, strike, expiry)
        };
    }

    // Key for an existing trade, built the same way as instrumentKey.
    function tradeKey(t) {
        if (t.assetType === 'option') {
            return ['OPT', String(t.symbol || '').toUpperCase(), String(t.optionType || '').toUpperCase(),
                Number(t.strike), String(t.expiry || '').slice(0, 10)].join('|');
        }
        return 'EQ|' + String(t.symbol || '').toUpperCase();
    }

    // Applies deduped fills to this journal's positions. existingTrades is
    // read only: positions are seeded from clones of this journal's open
    // Webull trades, and changed trades are reported as { before, after }.
    //
    // ctx: { journalId, webullAccountId, finalize, nextId }
    function applyFills(fills, existingTrades, ctx) {
        const finalize = ctx.finalize;
        if (typeof finalize !== 'function') throw new Error('applyFills needs ctx.finalize (finalizeTradeSummary)');
        const nextId = ctx.nextId || (() => { const base = Date.now(); let n = 0; return () => base + (n++); })();
        const journalId = ctx.journalId;
        const extPrefix = 'webull:' + journalId + ':' + ctx.webullAccountId + ':';

        const positions = new Map();
        const applied = new Map();   // orderId → qty already applied by this journal's trades
        const create = [], update = [], skipped = [];
        const qty = {};              // per key: { seeded, opened, closed }
        let alreadyImported = 0;

        const tally = (key) => qty[key] || (qty[key] = { seeded: 0, opened: 0, closed: 0, skipped: 0 });

        for (const t of Array.isArray(existingTrades) ? existingTrades : []) {
            if (!t || t.brokerAccountId !== journalId || t.source !== 'webull') continue;
            const ids = t.externalOrderIds && typeof t.externalOrderIds === 'object' ? t.externalOrderIds : {};
            for (const id of Object.keys(ids)) applied.set(id, (applied.get(id) || 0) + (Number(ids[id]) || 0));
            if (!isOpenTrade(t) || !t.externalId) continue;
            // Seed one lot at the trade's average entry. FIFO detail of lots
            // from earlier syncs isn't stored, so totals stay exact but
            // per-slice entry prices across a sync boundary use the average.
            const partials = Array.isArray(t.webullPartials) ? clone(t.webullPartials) : [];
            const partialFees = partials.reduce((s, p) => s + (Number(p.commissionFees) || 0), 0);
            const key = tradeKey(t);
            const q = Number(t.quantity) || 0;
            positions.set(key, {
                key,
                inst: {
                    symbol: t.symbol, assetType: t.assetType || 'stock', optionType: t.optionType || null,
                    strike: t.strike || 0, expiry: t.expiry || null, contractName: t.contractName || ''
                },
                // Trades loaded from cloud rows carry `direction`, not `type`.
                side: (t.type || t.direction) === 'short' ? 'short' : 'long',
                lots: q > 0 ? [{
                    qty: q, price: Number(t.entryPrice) || 0, time: t.entryTime,
                    fee: Math.max(0, round((Number(t.commissionFees) || 0) - partialFees)), orderId: null
                }] : [],
                partials,
                orderIds: Object.assign({}, ids),
                openedAt: t.entryTime,
                externalId: t.externalId,
                id: t.id,
                existing: t,
                touched: false,
            });
            tally(key).seeded += q;
        }

        function skip(f, q, reason, key) {
            skipped.push({
                orderId: f.orderId, symbol: f.symbol, side: f.positionIntent || f.side,
                qty: round(q), dateET: dateET(f.filledAt), reason
            });
            if (key) tally(key).skipped += q;
        }

        function baseTrade(pos) {
            if (pos.existing) {
                // Set type so finalizeTradeSummary prices a reloaded short as a short.
                const t = clone(pos.existing);
                t.type = pos.side;
                return t;
            }
            return {
                id: pos.id,
                symbol: pos.inst.symbol,
                type: pos.side,
                assetType: pos.inst.assetType,
                optionType: pos.inst.optionType,
                strike: pos.inst.strike,
                expiry: pos.inst.expiry,
                contractName: pos.inst.contractName,
                source: 'webull',
                brokerAccountId: journalId,
                externalId: pos.externalId,
                feeSource: 'actual',
            };
        }

        function emit(pos, trade) {
            if (pos.existing) update.push({ id: pos.id, externalId: pos.externalId, before: clone(pos.existing), after: trade });
            else create.push(trade);
        }

        function closeOut(pos) {
            const trade = baseTrade(pos);
            trade.fills = pos.partials.map((s, i) => Object.assign(s, { fillId: 'f' + (i + 1) }));
            // webullPartials only lives on open trades; the closed trade keeps fills[].
            delete trade.webullPartials;
            trade.externalOrderIds = Object.assign({}, pos.orderIds);
            finalize(trade);
            if (trade.grossPnl == null) trade.grossPnl = (trade.pnl || 0) + (trade.commissionFees || 0);
            emit(pos, trade);
            positions.delete(pos.key);
        }

        function openTrade(pos) {
            const trade = baseTrade(pos);
            const q = pos.lots.reduce((s, l) => s + l.qty, 0);
            const cost = pos.lots.reduce((s, l) => s + l.qty * l.price, 0);
            const fees = pos.lots.reduce((s, l) => s + l.fee, 0) +
                pos.partials.reduce((s, p) => s + (Number(p.commissionFees) || 0), 0);
            Object.assign(trade, {
                quantity: round(q),
                entryPrice: q > 0 ? cost / q : 0,
                entryTime: pos.openedAt,
                exitPrice: null,
                exitTime: null,
                holdSeconds: null,
                grossPnl: null,
                pnl: null,
                commissionFees: round(fees),
                externalOrderIds: Object.assign({}, pos.orderIds),
            });
            // Closed slices from partial exits of a still-open position. Kept out
            // of fills[] so finalizeTradeSummary can't stamp an exitTime on an
            // open trade. Phase 8 must confirm the cloud trades row preserves
            // this property before any save.
            if (pos.partials.length) {
                trade.webullPartials = pos.partials.map((s, i) => Object.assign(s, { fillId: 'p' + (i + 1) }));
            } else {
                delete trade.webullPartials;
            }
            return trade;
        }

        function openLot(f, inst, side, q, price, fee) {
            let pos = positions.get(inst.key);
            if (!pos) {
                pos = {
                    key: inst.key, inst, side, lots: [], partials: [], orderIds: {},
                    openedAt: f.filledAt, externalId: extPrefix + f.orderId, id: nextId(),
                    existing: null, touched: true,
                };
                positions.set(inst.key, pos);
            }
            pos.touched = true;
            pos.lots.push({ qty: q, price, time: f.filledAt, fee, orderId: f.orderId });
            pos.orderIds[f.orderId] = round((pos.orderIds[f.orderId] || 0) + q);
            tally(inst.key).opened += q;
        }

        // FIFO close, as in the CSV path's _emitSlice: each slice is priced
        // at its lot's entry price; a lot's fee and the closing order's fee
        // are each charged on the first slice that touches them. Returns the
        // quantity left over when the position runs out.
        function closeLots(pos, f, q, price, fee) {
            const mult = pos.inst.assetType === 'option' ? 100 : 1;
            let exitFee = fee, used = 0;
            while (q > EPS && pos.lots.length) {
                const lot = pos.lots[0];
                const take = Math.min(lot.qty, q);
                const comm = lot.fee + exitFee;
                const gross = pos.side === 'long' ? (price - lot.price) * take * mult : (lot.price - price) * take * mult;
                pos.partials.push({
                    quantity: round(take),
                    entryPrice: lot.price,
                    exitPrice: price,
                    entryTime: lot.time,
                    exitTime: f.filledAt,
                    commissionFees: round(comm),
                    grossPnl: gross,
                    pnl: gross - comm,
                    feeSource: 'actual',
                    source: { entryOrderId: lot.orderId, exitOrderId: f.orderId, entryCommissionFees: lot.fee, exitCommissionFees: exitFee },
                });
                lot.fee = 0;
                exitFee = 0;
                lot.qty = round(lot.qty - take);
                q = round(q - take);
                used += take;
                if (lot.qty <= EPS) pos.lots.shift();
            }
            pos.touched = true;
            pos.orderIds[f.orderId] = round((pos.orderIds[f.orderId] || 0) + used);
            tally(pos.key).closed += used;
            if (!pos.lots.length) closeOut(pos);
            return q;
        }

        const INTENTS = {
            BUY_TO_OPEN: ['open', 'long'], SELL_TO_OPEN: ['open', 'short'],
            SELL_TO_CLOSE: ['close', 'long'], BUY_TO_CLOSE: ['close', 'short'],
        };

        for (const f of fills) {
            if (!KEEP_STATUSES.includes(f.status)) { skip(f, Number(f.filledQty) || 0, 'skipped: status ' + f.status); continue; }
            const inst = instrumentKey(f);
            if (inst.skip) { skip(f, Number(f.filledQty), inst.skip); continue; }

            // Fill-level dedupe against this journal's trades: apply only
            // quantity not already recorded in externalOrderIds.
            const filled = Number(f.filledQty);
            const prior = applied.get(f.orderId) || 0;
            const q = round(filled - prior);
            if (q <= EPS) { alreadyImported++; continue; }
            applied.set(f.orderId, filled);
            const price = Number(f.filledPrice);
            const fee = round((Number(f.fees) || 0) * (q / filled));

            let action, side;
            if (f.positionIntent) {
                const m = INTENTS[f.positionIntent];
                if (!m) { skip(f, q, 'skipped: unknown position intent', inst.key); continue; }
                action = m[0]; side = m[1];
            } else if (f.side === 'SHORT') { action = 'open'; side = 'short'; }
            else if (f.side === 'BUY') {
                const p = positions.get(inst.key);
                // Equities don't mark covers: a BUY covers only when a short is open.
                if (p && p.side === 'short') { action = 'cover'; side = 'short'; }
                else { action = 'open'; side = 'long'; }
            } else if (f.side === 'SELL') { action = 'close'; side = 'long'; }
            else { skip(f, q, 'skipped: unknown side', inst.key); continue; }

            const pos = positions.get(inst.key);
            if (action === 'open') {
                if (pos && pos.side !== side) {
                    skip(f, q, side === 'short' ? 'skipped: short while long open' : 'skipped: opposite position open', inst.key);
                    continue;
                }
                openLot(f, inst, side, q, price, fee);
                continue;
            }
            // close / cover. A close dated before the position opened can't
            // belong to it (e.g. a re-read overlap fill vs. a seeded position).
            if (!pos || pos.side !== side || timeMs(f.filledAt) < timeMs(pos.openedAt)) {
                skip(f, q, pos && pos.side !== side ? 'skipped: opposite position open' : ORPHAN, inst.key);
                continue;
            }
            const left = closeLots(pos, f, q, price, fee);
            if (left > EPS) {
                // A BUY past a short's size reverses into a long (§7.3); any
                // other excess close is a pre-start position (§7.4).
                if (action === 'cover') openLot(f, inst, 'long', left, price, 0);
                else skip(f, left, ORPHAN, inst.key);
            }
        }

        const openAtEnd = [];
        for (const pos of positions.values()) {
            const q = pos.lots.reduce((s, l) => s + l.qty, 0);
            openAtEnd.push({
                key: pos.key, symbol: pos.inst.symbol, contractName: pos.inst.contractName, side: pos.side,
                qty: round(q), avgCost: q > 0 ? pos.lots.reduce((s, l) => s + l.qty * l.price, 0) / q : 0,
                externalId: pos.externalId, tradeId: pos.id,
                // A BUY with no open short opens a long, but it may be a cover of
                // a short opened before the start date. Check against Webull.
                verify: pos.inst.assetType === 'stock' && pos.side === 'long',
            });
            if (pos.touched) emit(pos, openTrade(pos));
        }

        // Every key: seeded + opened − closed must equal what is still open.
        let qtyBalanced = true;
        for (const key of Object.keys(qty)) {
            const pos = positions.get(key);
            const open = pos ? pos.lots.reduce((s, l) => s + l.qty, 0) : 0;
            if (Math.abs(qty[key].seeded + qty[key].opened - qty[key].closed - open) > 1e-6) qtyBalanced = false;
        }

        return { create, update, skipped, openAtEnd, alreadyImported, checks: { qtyBalanced } };
    }

    function buildPreview(rawFills, existingTrades, ctx) {
        const d = dedupeFills(rawFills);
        const r = applyFills(d.fills, existingTrades, ctx);
        return {
            journalId: ctx.journalId,
            webullAccountId: ctx.webullAccountId,
            fillsFetched: Array.isArray(rawFills) ? rawFills.length : 0,
            fillsUnique: d.fills.length,
            duplicatesDropped: d.duplicatesDropped,
            malformed: d.malformed,
            alreadyImported: r.alreadyImported,
            create: r.create,
            update: r.update,
            skipped: r.skipped,
            openAtEnd: r.openAtEnd,
            checks: r.checks,
            warnings: [],
        };
    }

    // ── Phase 8 import planning (pure) ──────────────────────────────────

    // Half away from zero; null/undefined/non-numeric pass through.
    function roundTo(v, dp) {
        if (v == null || v === '' || !Number.isFinite(Number(v))) return v;
        const f = Math.pow(10, dp);
        const r = Math.round(Math.abs(Number(v)) * f * (1 + Number.EPSILON)) / f;
        return Number(v) < 0 && r !== 0 ? -r : r;
    }

    function roundSlice(s) {
        for (const k of ['pnl', 'grossPnl', 'commissionFees']) if (k in s) s[k] = roundTo(s[k], MONEY_DP);
        for (const k of ['entryPrice', 'exitPrice']) if (k in s) s[k] = roundTo(s[k], PRICE_DP);
        return s;
    }

    // Copy of a trade with money rounded to cents and prices to PRICE_DP,
    // on the trade and on every fills[] / webullPartials[] slice.
    function roundTrade(trade) {
        const t = roundSlice(clone(trade));
        for (const k of ['fills', 'webullPartials']) {
            if (!Array.isArray(t[k])) continue;
            for (const s of t[k]) {
                roundSlice(s);
                if (s.source && typeof s.source === 'object') {
                    for (const f of ['entryCommissionFees', 'exitCommissionFees']) {
                        if (f in s.source) s.source[f] = roundTo(s.source[f], MONEY_DP);
                    }
                }
            }
        }
        return t;
    }

    // Checks a preview against the current trades and builds what to save.
    // Returns { error } or { creates, updates }. Each update is
    // { index, trade }: the CURRENT trade with only ENGINE_FIELDS replaced,
    // so unknown properties survive. Refuses anything that isn't a source
    // 'webull' trade of this journal, an id that already exists, or an
    // externalId this journal already has (the unique index's rule).
    function planImport(result, trades, journalId) {
        const prefix = 'webull:' + journalId + ':';
        const indexById = new Map();
        trades.forEach((t, i) => { if (t && t.id != null) indexById.set(String(t.id), i); });
        const extIds = new Set();
        for (const t of trades) if (t && t.brokerAccountId === journalId && t.externalId) extIds.add(t.externalId);

        const creates = [];
        for (const t of result.create) {
            if (!t || t.source !== 'webull' || t.brokerAccountId !== journalId ||
                typeof t.externalId !== 'string' || t.externalId.indexOf(prefix) !== 0) {
                return { error: 'Create is not a webull trade for this journal: ' + (t && t.externalId) };
            }
            if (indexById.has(String(t.id))) return { error: 'Trade id already exists: ' + t.id };
            if (extIds.has(t.externalId)) return { error: 'Already imported: ' + t.externalId };
            indexById.set(String(t.id), -1);
            extIds.add(t.externalId);
            creates.push(roundTrade(t));
        }

        const updates = [];
        for (const u of result.update) {
            const index = indexById.has(String(u.id)) ? indexById.get(String(u.id)) : -1;
            const current = index >= 0 ? trades[index] : null;
            if (!current || current.source !== 'webull' || current.brokerAccountId !== journalId ||
                !current.externalId || current.externalId !== u.externalId ||
                !u.after || u.after.brokerAccountId !== journalId) {
                return { error: 'Update target is not a webull trade of this journal: ' + u.id };
            }
            const merged = clone(current);
            for (const k of ENGINE_FIELDS) {
                if (Object.prototype.hasOwnProperty.call(u.after, k)) merged[k] = u.after[k];
                else delete merged[k];
            }
            updates.push({ index, trade: roundTrade(merged) });
        }
        return { creates, updates };
    }

    // ── Batch planning (pure) ───────────────────────────────────────────

    const EDITED = 'Edited after import, not updated';
    const BEFORE_EXISTING = 'Before existing Webull trades (start date moved earlier)';

    // FNV-1a over the fields a user can edit on an open trade. Stored on
    // open Webull trades as webullSyncHash; a mismatch at the next sync
    // means the user changed them, so the engine leaves the trade alone.
    function engineHash(t) {
        const ms = (v) => { const n = timeMs(v); return Number.isFinite(n) ? n : null; };
        const s = JSON.stringify([
            (t.type || t.direction) === 'short' ? 'short' : 'long',
            roundTo(Number(t.quantity) || 0, 8), roundTo(t.entryPrice == null ? null : Number(t.entryPrice), PRICE_DP),
            ms(t.entryTime), roundTo(t.exitPrice == null ? null : Number(t.exitPrice), PRICE_DP), ms(t.exitTime),
            roundTo(Number(t.commissionFees) || 0, MONEY_DP),
        ]);
        let h = 0x811c9dc5;
        for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
        return ('0000000' + h.toString(16)).slice(-8);
    }

    // Engine values kept on open Webull trades as webullSyncBase, so "Use
    // Webull's data" can undo a user's edit (restoredFromBase).
    const BASE_FIELDS = Object.freeze(['type', 'quantity', 'entryPrice', 'entryTime', 'exitPrice', 'exitTime',
        'holdSeconds', 'grossPnl', 'pnl', 'commissionFees']);

    function stampHash(t) {
        if (isOpenTrade(t)) {
            t.webullSyncHash = engineHash(t);
            const base = {};
            for (const k of BASE_FIELDS) if (Object.prototype.hasOwnProperty.call(t, k)) base[k] = t[k];
            t.webullSyncBase = base;
        } else {
            delete t.webullSyncHash;
            delete t.webullSyncBase;
        }
        return t;
    }

    // Records the order ids of deleted Webull trades in
    // data.webullIgnoredOrders[journalId] so a later sync never re-imports
    // them. Call before the trades leave data.trades. Returns the count added.
    function noteDeletedTrades(data, trades) {
        let added = 0;
        for (const t of Array.isArray(trades) ? trades : []) {
            if (!t || t.source !== 'webull' || !t.brokerAccountId) continue;
            const ids = t.externalOrderIds && typeof t.externalOrderIds === 'object' ? Object.keys(t.externalOrderIds) : [];
            if (!ids.length) continue;
            const all = data.webullIgnoredOrders || (data.webullIgnoredOrders = {});
            const map = all[t.brokerAccountId] || (all[t.brokerAccountId] = {});
            for (const id of ids) if (!map[id]) { map[id] = true; added++; }
        }
        return added;
    }

    // Splits a batch's fills into those to apply and those held for review.
    //   - Orders in webullIgnoredOrders (deleted trades) are dropped.
    //   - Fills for an instrument whose open trade was edited are held.
    //   - Fills dated before this journal's earliest Webull trade for the
    //     instrument are held: applyFills seeds from today's open trades, so
    //     a backfill after moving the start date earlier would mis-pair them.
    // Fills already fully applied pass through (the engine counts them).
    function partitionFills(fills, trades, journalId, ignoredMap) {
        const ignored = ignoredMap && typeof ignoredMap === 'object' ? ignoredMap : {};
        const applied = new Map(), earliest = new Map(), editedKeys = new Set(), edited = [];
        for (const t of trades) {
            if (!t || t.brokerAccountId !== journalId || t.source !== 'webull') continue;
            const ids = t.externalOrderIds && typeof t.externalOrderIds === 'object' ? t.externalOrderIds : {};
            for (const id of Object.keys(ids)) applied.set(id, (applied.get(id) || 0) + (Number(ids[id]) || 0));
            const key = tradeKey(t);
            const e = timeMs(t.entryTime);
            if (Number.isFinite(e) && !(earliest.get(key) <= e)) earliest.set(key, e);
            if (isOpenTrade(t) && t.webullSyncHash && t.webullSyncHash !== engineHash(t)) {
                editedKeys.add(key);
                edited.push({ tradeId: t.id, symbol: t.symbol, contractName: t.contractName || '', reason: EDITED });
            }
        }
        const apply = [], review = [];
        let ignoredCount = 0;
        for (const f of Array.isArray(fills) ? fills : []) {
            if (f && f.orderId && Object.prototype.hasOwnProperty.call(ignored, f.orderId)) { ignoredCount++; continue; }
            const inst = f && typeof f === 'object' ? instrumentKey(f) : { skip: true };
            if (inst.skip || (applied.get(f.orderId) || 0) >= (Number(f.filledQty) || 0) - EPS) { apply.push(f); continue; }
            if (editedKeys.has(inst.key)) { review.push({ fill: f, reason: EDITED }); continue; }
            if (timeMs(f.filledAt) < earliest.get(inst.key)) { review.push({ fill: f, reason: BEFORE_EXISTING }); continue; }
            apply.push(f);
        }
        return { apply, review, ignored: ignoredCount, edited };
    }

    // Plans one batch against data (read only). Returns { error } or
    // { creates, updates, review, preview, edited, ignored }. Creates and
    // updates are rounded and carry webullSyncHash when open.
    function planBatch(batch, data, ctx) {
        const journalId = batch.journalId;
        const trades = data.trades;
        const ignoredMap = data.webullIgnoredOrders && data.webullIgnoredOrders[journalId];
        const part = partitionFills(batch.fills, trades, journalId, ignoredMap);
        const preview = buildPreview(part.apply, trades, {
            journalId, webullAccountId: batch.webullAccountId, finalize: ctx.finalize, nextId: ctx.nextId,
        });
        if (!preview.checks.qtyBalanced) return { error: 'Quantity check failed; nothing saved.' };
        const plan = planImport(preview, trades, journalId);
        if (plan.error) return { error: plan.error };
        plan.creates.forEach(stampHash);
        plan.updates.forEach(u => stampHash(u.trade));
        return { creates: plan.creates, updates: plan.updates, review: part.review, preview, edited: part.edited, ignored: part.ignored };
    }

    // ── Review (pure) ───────────────────────────────────────────────────
    // What partitionFills held back: open trades the user edited and fills
    // held in data.webullReview[journalId] ({ orderId → { fill, reason,
    // heldAt, webullAccountId } }). Each plan is read only and returns
    // { replace, creates, remove, keep, ignore } for resolveReview, or { error }.

    function heldMap(data, journalId) {
        const m = data.webullReview && data.webullReview[journalId];
        return m && typeof m === 'object' ? m : {};
    }

    // The trade with its engine fields put back to the last sync's values,
    // or null when they weren't kept or don't match webullSyncHash.
    function restoredFromBase(t) {
        const base = t.webullSyncBase;
        if (!base || typeof base !== 'object' || !t.webullSyncHash) return null;
        const r = clone(t);
        for (const k of BASE_FIELDS) {
            if (Object.prototype.hasOwnProperty.call(base, k)) r[k] = base[k];
            else delete r[k];
        }
        return engineHash(r) === t.webullSyncHash ? r : null;
    }

    // { edited: [{ trade, entries, canUseWebull }], held: [{ id, key, symbol,
    // reason, entries }], count }. Entries are { orderId, fill, reason, heldAt,
    // webullAccountId }, oldest first. Held fills for an edited trade's
    // instrument are listed under that trade.
    function reviewItems(data, journalId) {
        const trades = data && Array.isArray(data.trades) ? data.trades : [];
        const edited = [], editedByKey = new Map();
        for (const e of partitionFills([], trades, journalId, null).edited) {
            const trade = trades.find(t => t && String(t.id) === String(e.tradeId));
            const key = trade && tradeKey(trade);
            if (!trade || editedByKey.has(key)) continue;
            const item = { trade, entries: [], canUseWebull: !!restoredFromBase(trade) };
            edited.push(item);
            editedByKey.set(key, item);
        }
        const map = heldMap(data || {}, journalId);
        const entries = Object.keys(map).filter(id => map[id] && map[id].fill)
            .map(id => Object.assign({ orderId: id }, map[id]))
            .sort((a, b) => (timeMs(a.fill.filledAt) - timeMs(b.fill.filledAt)) || (a.orderId < b.orderId ? -1 : 1));
        const groups = new Map();
        for (const e of entries) {
            const inst = instrumentKey(e.fill);
            const key = inst.skip ? 'SKIP|' + e.orderId : inst.key;
            if (e.reason === EDITED && editedByKey.has(key)) { editedByKey.get(key).entries.push(e); continue; }
            const id = e.reason + '|' + key;
            if (!groups.has(id)) groups.set(id, { id, key, symbol: inst.contractName || inst.symbol || e.fill.symbol || '', reason: e.reason, entries: [] });
            groups.get(id).entries.push(e);
        }
        const held = Array.from(groups.values());
        return { edited, held, count: edited.length + entries.length };
    }

    function accountIdFor(entries, ctx) {
        const e = entries.find(x => typeof x.webullAccountId === 'string' && x.webullAccountId);
        return e ? e.webullAccountId : (ctx.webullAccountId || null);
    }

    // Runs held fills through planBatch against `trades`, as the next sync
    // would. keep = the entries planBatch holds again.
    function replayHeld(entries, trades, data, journalId, ctx) {
        if (!entries.length) return { creates: [], updates: [], keep: {}, skipped: 0 };
        const acct = accountIdFor(entries, ctx);
        if (!acct) return { error: 'The Webull account for these fills is unknown.' };
        const heldAt = new Map(entries.map(e => [e.orderId, e.heldAt]));
        const plan = planBatch({ journalId, webullAccountId: acct, fills: entries.map(e => e.fill) },
            { trades, webullIgnoredOrders: data.webullIgnoredOrders }, ctx);
        if (plan.error) return { error: plan.error };
        const keep = {};
        for (const r of plan.review) {
            keep[r.fill.orderId] = { fill: clone(r.fill), reason: r.reason, heldAt: heldAt.get(r.fill.orderId) || null, webullAccountId: acct };
        }
        return { creates: plan.creates, updates: plan.updates, keep, skipped: plan.preview.skipped.length };
    }

    // 'keep': the user's values become the new baseline and the held fills
    // are applied on top of them. If they can't be, the baseline is still
    // saved and the fills stay held. 'webull': the last sync's engine values
    // come back and the held fills are applied; all or nothing. Notes, tags,
    // strategy and other fields are kept either way.
    function planTradeAction(data, journalId, tradeId, action, ctx) {
        const item = reviewItems(data, journalId).edited.find(i => String(i.trade.id) === String(tradeId));
        if (!item) return { error: 'This trade no longer needs review.' };
        let trade;
        if (action === 'keep') {
            trade = stampHash(clone(item.trade));
        } else {
            trade = restoredFromBase(item.trade);
            if (!trade) return { error: 'Webull\'s values from the last sync weren\'t saved for this trade. Keep your edits or correct it by hand.' };
            stampHash(trade);
        }
        const trades = data.trades.map(t => (t === item.trade ? trade : t));
        const r = replayHeld(item.entries, trades, data, journalId, ctx);
        const base = { replace: [trade], creates: [], remove: [], keep: {}, ignore: [], applied: 0, skipped: 0 };
        if (r.error) {
            if (action !== 'keep') return { error: r.error };
            return Object.assign(base, { note: 'Held fills stay in review: ' + r.error });
        }
        const byId = new Map([[String(trade.id), trade]]);
        for (const u of r.updates) byId.set(String(u.trade.id), u.trade);
        return Object.assign(base, {
            replace: Array.from(byId.values()), creates: r.creates, keep: r.keep,
            remove: item.entries.map(e => e.orderId),
            applied: item.entries.length - Object.keys(r.keep).length, skipped: r.skipped,
        });
    }

    // 'ignore': the orders go to webullIgnoredOrders. 'import': fills held
    // for an edit go through planBatch; fills dated before the instrument's
    // earliest Webull trade are imported on their own (the open trade isn't
    // seeded, so they can't pair with it) and must close out with nothing
    // skipped, or nothing is imported.
    function planHeldAction(data, journalId, groupId, action, ctx) {
        const group = reviewItems(data, journalId).held.find(g => g.id === groupId);
        if (!group) return { error: 'These fills no longer need review.' };
        const ids = group.entries.map(e => e.orderId);
        const base = { replace: [], creates: [], remove: ids, keep: {}, ignore: [], applied: 0, skipped: 0 };
        if (action === 'ignore') return Object.assign(base, { ignore: ids });

        if (group.reason !== BEFORE_EXISTING) {
            const r = replayHeld(group.entries, data.trades, data, journalId, ctx);
            if (r.error) return { error: r.error };
            return Object.assign(base, {
                replace: r.updates.map(u => u.trade), creates: r.creates, keep: r.keep,
                applied: ids.length - Object.keys(r.keep).length, skipped: r.skipped,
            });
        }

        const acct = accountIdFor(group.entries, ctx);
        if (!acct) return { error: 'The Webull account for these fills is unknown.' };
        const isOpenSame = t => t && t.brokerAccountId === journalId && t.source === 'webull' &&
            isOpenTrade(t) && tradeKey(t) === group.key;
        const idSet = new Set(ids);
        for (const t of data.trades.filter(isOpenSame)) {
            const own = t.externalOrderIds && typeof t.externalOrderIds === 'object' ? Object.keys(t.externalOrderIds) : [];
            if (own.some(id => idSet.has(id))) return { error: 'Some of these orders are already part of the open ' + group.symbol + ' trade.' };
        }
        const preview = buildPreview(group.entries.map(e => e.fill), data.trades.filter(t => !isOpenSame(t)), {
            journalId, webullAccountId: acct, finalize: ctx.finalize, nextId: ctx.nextId,
        });
        if (!preview.checks.qtyBalanced) return { error: 'Quantity check failed; nothing imported.' };
        if (preview.skipped.length) {
            return { error: preview.skipped.length + ' of these fills can\'t be matched (' +
                String(preview.skipped[0].reason).replace(/^skipped: /, '') + '). Nothing imported.' };
        }
        const left = preview.openAtEnd.filter(p => p.key === group.key && p.qty > EPS);
        if (left.length || preview.update.length) {
            return { error: 'These fills leave ' + (left.length ? left[0].qty : 'a position') +
                ' open, which would overlap the later Webull trades. Nothing imported.' };
        }
        const plan = planImport(preview, data.trades, journalId);
        if (plan.error) return { error: plan.error };
        plan.creates.forEach(stampHash);
        return Object.assign(base, { creates: plan.creates, applied: ids.length });
    }

    // ── Browser wrapper ─────────────────────────────────────────────────

    // journalData is a top-level `let` in Denarii.js and currentAccountId one
    // in auth.js (global lexical scope): referenced by name, not via root.
    function pageDeps(opts) {
        return {
            data: opts.journalData || (typeof journalData !== 'undefined' ? journalData : null),
            accountId: opts.getAccountId ? opts.getAccountId() : (typeof currentAccountId !== 'undefined' ? currentAccountId : null),
            save: opts.save || (typeof saveToIndexedDB === 'function' ? saveToIndexedDB : null),
            ack: opts.ack || ((runId, result) => root.denariiWebull.ackBatch(runId, result)),
            finalize: opts.finalize || root.finalizeTradeSummary,
            refresh: opts.refresh || (() => { if (typeof updateDashboard === 'function') updateDashboard(); }),
        };
    }

    let handler = null;          // { accountId, unsubscribe } while signed in
    let applying = false;
    const lastResults = {};      // journalId → last applyBatch result

    // Applies one window from main: check → plan → update journalData →
    // save → ackBatch. Acknowledges { ok: true } only after the local save
    // succeeded; a failed save rolls journalData back and acks { ok: false },
    // so main keeps its cursor and re-reads the window. Never throws.
    // opts (tests): journalData, getAccountId, save, ack, finalize, refresh, nextId.
    async function applyBatch(batch, opts) {
        opts = opts || {};
        const deps = pageDeps(opts);
        const runId = batch && batch.runId;
        const out = {
            ok: false, journalId: batch && batch.journalId, windowEnd: batch && batch.windowEnd,
            created: 0, updated: 0, skipped: 0, alreadyImported: 0, review: 0, ignored: 0, notUpdated: [], error: null,
        };
        const finish = async (error) => {
            out.error = error || null;
            out.ok = !error;
            if (typeof out.journalId === 'string') lastResults[out.journalId] = out;
            try { await deps.ack(runId, error ? { ok: false, error } : { ok: true }); } catch (e) { /* main times out */ }
            return out;
        };

        // After Lock or sign-out the page no longer answers; main drops the batch.
        if (!handler || !batch || handler.accountId !== batch.accountId) { out.error = 'Not handling batches.'; return out; }
        if (typeof runId !== 'string' || typeof batch.journalId !== 'string' ||
            typeof batch.webullAccountId !== 'string' || !Array.isArray(batch.fills)) {
            return finish('Malformed batch.');
        }
        if (!deps.accountId || batch.accountId !== deps.accountId) return finish('Batch is for another account.');
        const data = deps.data;
        if (!data || !Array.isArray(data.trades)) return finish('Journal is not loaded.');
        if (!Array.isArray(data.brokerAccounts) || !data.brokerAccounts.some(a => a && a.id === batch.journalId)) {
            return finish('Journal not found.');
        }
        if (!deps.save) return finish('Save is not available.');
        if (typeof deps.finalize !== 'function') return finish('finalizeTradeSummary is not available.');
        if (applying) return finish('A batch is already being applied.');
        applying = true;
        try {
            let plan;
            try {
                plan = planBatch(batch, data, { finalize: deps.finalize, nextId: opts.nextId });
            } catch (e) {
                return finish('Could not apply fills: ' + (e.message || e));
            }
            if (plan.error) return finish(plan.error);
            out.skipped = plan.preview.skipped.length;
            out.alreadyImported = plan.preview.alreadyImported;
            out.ignored = plan.ignored;
            out.notUpdated = plan.edited;

            // Held fills, keyed by orderId (the larger filledQty wins, as in dedupeFills).
            const jid = batch.journalId;
            const prevReview = data.webullReview && data.webullReview[jid];
            const review = Object.assign({}, prevReview || {});
            let reviewChanged = false;
            for (const r of plan.review) {
                const cur = review[r.fill.orderId];
                if (cur && Number(cur.fill.filledQty) >= Number(r.fill.filledQty)) continue;
                review[r.fill.orderId] = { fill: clone(r.fill), reason: r.reason, heldAt: new Date().toISOString(), webullAccountId: batch.webullAccountId };
                reviewChanged = true;
            }
            out.review = plan.review.length;

            if (!plan.creates.length && !plan.updates.length && !reviewChanged) return finish(null);

            // Apply in memory, remembering exactly what changed for a rollback.
            const replaced = [];
            for (const u of plan.updates) {
                const i = data.trades.findIndex(t => t && String(t.id) === String(u.trade.id));
                if (i < 0) {
                    for (const r of replaced) data.trades[data.trades.indexOf(r.after)] = r.before;
                    return finish('Update target disappeared: ' + u.trade.id);
                }
                replaced.push({ before: data.trades[i], after: u.trade });
                data.trades[i] = u.trade;
            }
            data.trades.push(...plan.creates);
            if (reviewChanged) (data.webullReview || (data.webullReview = {}))[jid] = review;

            let saved;
            try { saved = await deps.save(); } catch (e) { saved = { ok: false, error: e.message || String(e) }; }
            if (!saved || saved.ok !== true) {
                // Undo only this batch's changes; anything else edited meanwhile stays.
                for (const t of plan.creates) {
                    const i = data.trades.indexOf(t);
                    if (i >= 0) data.trades.splice(i, 1);
                }
                for (const r of replaced) {
                    const i = data.trades.indexOf(r.after);
                    if (i >= 0) data.trades[i] = r.before;
                }
                if (reviewChanged) {
                    if (prevReview) data.webullReview[jid] = prevReview; else delete data.webullReview[jid];
                }
                return finish(((saved && saved.error) || 'Save failed.') + ' Nothing acknowledged; the window is re-read.');
            }
            out.created = plan.creates.length;
            out.updated = plan.updates.length;
            try { deps.refresh(); } catch (e) { /* display only */ }
            return finish(null);
        } finally {
            applying = false;
        }
    }

    // Resolves one review item from Broker Accounts: plan → update
    // journalData → save. The item leaves the list only after the save
    // succeeded; a failed save undoes exactly this change. Shares the
    // `applying` lock with applyBatch, so a batch arriving meanwhile is
    // refused and re-read. Returns { ok, error, message }. Never throws.
    // action: 'keep' | 'webull' (args.tradeId), 'import' | 'ignore' (args.groupId).
    // opts: webullAccountId (the link's, for entries saved without one);
    // tests also pass journalData, save, finalize, refresh, nextId.
    async function resolveReview(journalId, action, args, opts) {
        opts = opts || {};
        const deps = pageDeps(opts);
        const data = deps.data;
        if (!data || !Array.isArray(data.trades)) return { ok: false, error: 'Journal is not loaded.' };
        if (!deps.save) return { ok: false, error: 'Save is not available.' };
        if (typeof deps.finalize !== 'function') return { ok: false, error: 'finalizeTradeSummary is not available.' };
        if (applying) return { ok: false, error: 'A Webull sync is saving. Try again in a moment.' };
        const ctx = { finalize: deps.finalize, nextId: opts.nextId, webullAccountId: opts.webullAccountId || null };
        let plan;
        try {
            if (action === 'keep' || action === 'webull') plan = planTradeAction(data, journalId, args && args.tradeId, action, ctx);
            else if (action === 'import' || action === 'ignore') plan = planHeldAction(data, journalId, args && args.groupId, action, ctx);
            else plan = { error: 'Unknown action.' };
        } catch (e) {
            return { ok: false, error: 'Could not resolve: ' + (e.message || e) };
        }
        if (plan.error) return { ok: false, error: plan.error };

        applying = true;
        const replaced = [];
        const prevReview = data.webullReview && data.webullReview[journalId];
        const hadIgnoredRoot = !!data.webullIgnoredOrders;
        const prevIgnored = hadIgnoredRoot ? data.webullIgnoredOrders[journalId] : undefined;
        const undo = () => {
            for (const t of plan.creates) {
                const i = data.trades.indexOf(t);
                if (i >= 0) data.trades.splice(i, 1);
            }
            for (const r of replaced) {
                const i = data.trades.indexOf(r.after);
                if (i >= 0) data.trades[i] = r.before;
            }
            if (prevReview) data.webullReview[journalId] = prevReview;
            else if (data.webullReview) delete data.webullReview[journalId];
            if (!plan.ignore.length) return;
            if (!hadIgnoredRoot) delete data.webullIgnoredOrders;
            else if (prevIgnored) data.webullIgnoredOrders[journalId] = prevIgnored;
            else delete data.webullIgnoredOrders[journalId];
        };
        try {
            for (const t of plan.replace) {
                const i = data.trades.findIndex(x => x && String(x.id) === String(t.id));
                if (i < 0) { undo(); return { ok: false, error: 'Trade disappeared: ' + t.id }; }
                replaced.push({ before: data.trades[i], after: t });
                data.trades[i] = t;
            }
            data.trades.push(...plan.creates);
            const review = Object.assign({}, prevReview || {});
            for (const id of plan.remove) delete review[id];
            Object.assign(review, plan.keep);
            if (Object.keys(review).length) (data.webullReview || (data.webullReview = {}))[journalId] = review;
            else if (data.webullReview) delete data.webullReview[journalId];
            if (plan.ignore.length) {
                const map = Object.assign({}, prevIgnored || {});
                for (const id of plan.ignore) map[id] = true;
                (data.webullIgnoredOrders || (data.webullIgnoredOrders = {}))[journalId] = map;
            }

            let saved;
            try { saved = await deps.save(); } catch (e) { saved = { ok: false, error: e.message || String(e) }; }
            if (!saved || saved.ok !== true) {
                undo();
                return { ok: false, error: ((saved && saved.error) || 'Save failed.') + ' Nothing was changed.' };
            }
        } finally {
            applying = false;
        }
        try { deps.refresh(); } catch (e) { /* display only */ }
        return { ok: true, error: null, message: reviewMessage(action, plan) };
    }

    function reviewMessage(action, plan) {
        const n = (v, word) => v + ' ' + word + (v === 1 ? '' : 's');
        const parts = [];
        if (action === 'keep') parts.push('Kept your edits.');
        if (action === 'webull') parts.push('Updated from Webull\'s data.');
        if (action === 'ignore') parts.push('Ignored ' + n(plan.ignore.length, 'order') + '. They won\'t be imported.');
        if (action === 'import') parts.push('Imported ' + n(plan.creates.length + plan.replace.length, 'trade') + '.');
        else if (plan.applied && action !== 'ignore') parts.push('Applied ' + n(plan.applied, 'held fill') + '.');
        if (plan.skipped) parts.push(n(plan.skipped, 'fill') + ' skipped.');
        const kept = Object.keys(plan.keep).length;
        if (kept) parts.push(n(kept, 'fill') + ' still held for review.');
        if (plan.note) parts.push(plan.note);
        return parts.join(' ');
    }

    // Called after sign-in: handles batches for this account and attaches
    // to main, which then syncs linked journals. Replaces any earlier handler.
    function startBatchHandler(accountId) {
        stopBatchHandler({ detach: false });
        const wb = root.denariiWebull;
        if (!wb || typeof wb.onBatch !== 'function' || !accountId) return false;
        const h = { accountId, unsubscribe: null };
        h.unsubscribe = wb.onBatch(batch => { if (handler === h) applyBatch(batch); });
        handler = h;
        Promise.resolve().then(() => wb.attach(accountId)).catch(() => {});
        return true;
    }

    // Lock or sign-out: stop applying batches. Main also detaches on reload.
    function stopBatchHandler(o) {
        const h = handler;
        handler = null;
        if (!h) return;
        try { if (h.unsubscribe) h.unsubscribe(); } catch (e) { /* ignore */ }
        const wb = root.denariiWebull;
        if ((!o || o.detach !== false) && wb && typeof wb.detach === 'function') {
            Promise.resolve().then(() => wb.detach()).catch(() => {});
        }
    }

    // A main-process progress event as one line for Settings and Broker Accounts:
    // "Importing Webull history: Mar 2021 - Jun 2021 (window 12 of 35, 1,240 orders)".
    // '' when the event has no usable window.
    function progressText(p) {
        if (!p || typeof p !== 'object') return '';
        const start = timeMs(p.windowStart), end = timeMs(p.windowEnd);
        if (!Number.isFinite(start) || !Number.isFinite(end)) return '';
        const month = ms => new Date(ms).toLocaleDateString('en-US', { month: 'short', year: 'numeric', timeZone: 'UTC' });
        const count = v => Math.max(0, Math.floor(Number(v) || 0)).toLocaleString('en-US');
        // windowEnd is exclusive: a window ending 2021-07-01T00:00Z covers June.
        return 'Importing Webull history: ' + month(start) + ' - ' + month(Math.max(start, end - 1)) +
            ' (window ' + count(p.windowIndex) + ' of ' + count(p.windowCount) + ', ' + count(p.ordersSoFar) + ' orders)';
    }

    const api = {
        dedupeFills, instrumentKey, tradeKey, applyFills, buildPreview, roundTo, roundTrade, planImport,
        engineHash, noteDeletedTrades, partitionFills, planBatch, applyBatch,
        reviewItems, planTradeAction, planHeldAction, resolveReview,
        startBatchHandler, stopBatchHandler, progressText,
        lastResult: (journalId) => lastResults[journalId] || null,
        EDITED, BEFORE_EXISTING, MONEY_DP, PRICE_DP,
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    if (typeof window !== 'undefined') window.WebullSync = api;
})(typeof window !== 'undefined' ? window : globalThis);
