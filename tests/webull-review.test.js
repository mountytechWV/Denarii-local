// Webull W5: resolving what the sync held back (WebullSync.reviewItems /
// resolveReview) and deleteAccount stopping the batch handler. Trades come
// from the real applyBatch, so the held items are exactly what a sync saves.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const engine = require('../js/services/webull-sync.js');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');

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

// The real finalizeTradeSummary from Denarii.js.
const APP = read('Denarii.js');
const finalize = new Function(['_isOpenTrade', '_contractMultiplier', 'deriveTradeSummaryFromFills', 'finalizeTradeSummary']
    .map(n => extractFunction(APP, n)).join('\n') + '\nreturn finalizeTradeSummary;')();

const ACCOUNT = 'acct-1', J = 'ba_review', WID = 'A1';
const day = (d, min) => new Date(Date.UTC(2026, 6, d, 14, min || 0)).toISOString();
let seq = 0, nextTradeId = 9000, runSeq = 0;
function fill(o) {
    seq++;
    return Object.assign({
        orderId: 'r' + seq, symbol: 'AAA', side: 'BUY', positionIntent: null, status: 'FILLED',
        instrumentType: 'EQUITY', filledQty: 10, filledPrice: 10, filledAt: day(1, seq), placedAt: null,
        fees: 0, legs: [],
    }, o);
}

globalThis.denariiWebull = {
    onBatch: () => () => {}, attach: async () => ({ ok: true }), detach: async () => ({ ok: true }),
    ackBatch: async () => ({ ok: true }),
};

// In-memory journal; save() can be made to fail with h.failSave = true.
function harness() {
    engine.startBatchHandler(ACCOUNT);
    const jd = { trades: [], brokerAccounts: [{ id: J }] };
    const h = { jd, saves: 0, failSave: false, refreshes: 0 };
    h.opts = {
        journalData: jd, getAccountId: () => ACCOUNT, finalize, nextId: () => nextTradeId++,
        save: async () => { h.saves++; return h.failSave ? { ok: false, error: 'Disk full.' } : { ok: true }; },
        ack: async () => {}, refresh: () => { h.refreshes++; },
    };
    h.apply = fills => engine.applyBatch({ runId: 'r' + (++runSeq), accountId: ACCOUNT, journalId: J,
        webullAccountId: WID, windowEnd: 'w', fills }, h.opts);
    h.resolve = (action, args) => engine.resolveReview(J, action, args, h.opts);
    h.items = () => engine.reviewItems(jd, J);
    return h;
}

const snap = jd => JSON.stringify({ trades: jd.trades, review: jd.webullReview, ignored: jd.webullIgnoredOrders });

// An imported open AAA long (10 @ 10) with notes/tags/strategy, edited to
// 12 shares, and a SELL 10 @ 12 the sync then held for review.
async function editedWithHeldSell() {
    const h = harness();
    await h.apply([fill({ side: 'BUY', filledQty: 10, filledPrice: 10, filledAt: day(1) })]);
    const t = h.jd.trades[0];
    Object.assign(t, { notes: 'my plan', tags: ['swing'], strategy: 'Breakout', quantity: 12 });
    const sell = fill({ side: 'SELL', filledQty: 10, filledPrice: 12, filledAt: day(2) });
    const r = await h.apply([sell]);
    assert.equal(r.review, 1);
    return { h, t, sell };
}

test('reviewItems lists an edited open trade with its held fill', async () => {
    const { h, t, sell } = await editedWithHeldSell();
    const items = h.items();
    assert.equal(items.count, 2);
    assert.equal(items.edited.length, 1);
    assert.equal(items.edited[0].trade, t);
    assert.equal(items.edited[0].canUseWebull, true);
    assert.deepEqual(items.edited[0].entries.map(e => [e.orderId, e.reason, e.webullAccountId]), [[sell.orderId, engine.EDITED, WID]]);
    assert.deepEqual(items.held, []);
});

test('Keep my edits: the user\'s values become the baseline and the held fill applies on top', async () => {
    const { h, t, sell } = await editedWithHeldSell();
    const saves = h.saves;
    const r = await h.resolve('keep', { tradeId: t.id });
    assert.equal(r.ok, true, r.error);
    assert.match(r.message, /Kept your edits\. Applied 1 held fill\./);
    assert.equal(h.saves, saves + 1);
    assert.equal(h.jd.trades.length, 1);                     // no duplicate
    const k = h.jd.trades[0];
    assert.equal(k.id, t.id);
    assert.equal(k.quantity, 2);                             // 12 kept, 10 sold
    assert.equal(k.exitTime, null);
    assert.equal(k.webullPartials.length, 1);
    assert.equal(k.webullPartials[0].pnl, 20);
    assert.deepEqual([k.notes, k.tags, k.strategy], ['my plan', ['swing'], 'Breakout']);
    assert.equal(k.webullSyncHash, engine.engineHash(k));
    assert.equal(h.jd.webullReview[J], undefined);
    assert.equal(h.items().count, 0);
    assert.equal(h.refreshes > 0, true);

    // The next sync re-reading the same fill changes nothing.
    const again = await h.apply([sell]);
    assert.equal(again.updated + again.created + again.review, 0);
    assert.equal(h.jd.trades.length, 1);
});

test('Keep my edits with nothing held only accepts the edit', async () => {
    const h = harness();
    await h.apply([fill({ side: 'BUY', filledAt: day(1) })]);
    const t = h.jd.trades[0];
    t.entryPrice = 9.5;
    assert.equal(h.items().count, 1);
    const r = await h.resolve('keep', { tradeId: t.id });
    assert.equal(r.ok, true);
    assert.equal(h.jd.trades[0].entryPrice, 9.5);
    assert.equal(h.jd.trades[0].webullSyncBase.entryPrice, 9.5);
    assert.equal(h.items().count, 0);
    // Later fills update it again.
    assert.equal((await h.apply([fill({ side: 'BUY', filledQty: 1, filledAt: day(3) })])).updated, 1);
});

test('Use Webull\'s data: engine fields go back to the last sync, held fill applies, notes kept', async () => {
    const { h, t, sell } = await editedWithHeldSell();
    const r = await h.resolve('webull', { tradeId: t.id });
    assert.equal(r.ok, true, r.error);
    assert.equal(h.jd.trades.length, 1);
    const w = h.jd.trades[0];
    assert.equal(w.id, t.id);
    assert.equal(w.quantity, 10);                            // Webull's 10, not the edited 12
    assert.equal(w.exitPrice, 12);
    assert.equal(w.pnl, 20);
    assert.deepEqual(w.externalOrderIds, { [Object.keys(t.externalOrderIds)[0]]: 10, [sell.orderId]: 10 });
    assert.deepEqual([w.notes, w.tags, w.strategy], ['my plan', ['swing'], 'Breakout']);
    assert.equal('webullSyncHash' in w, false);              // closed
    assert.equal('webullSyncBase' in w, false);
    assert.equal(h.items().count, 0);
});

test('Use Webull\'s data is refused when the last sync\'s values are missing or do not match', async () => {
    const { h, t } = await editedWithHeldSell();
    const before = snap(h.jd), saves = h.saves;
    delete t.webullSyncBase;
    const legacy = snap(h.jd);
    assert.equal(h.items().edited[0].canUseWebull, false);
    const r = await h.resolve('webull', { tradeId: t.id });
    assert.equal(r.ok, false);
    assert.match(r.error, /weren't saved/);
    assert.equal(snap(h.jd), legacy);
    assert.equal(h.saves, saves);
    assert.notEqual(before, legacy);

    t.webullSyncBase = { quantity: 999 };                    // doesn't hash to webullSyncHash
    assert.equal((await h.resolve('webull', { tradeId: t.id })).ok, false);
    assert.equal(h.items().count, 2);
});

// Open AAA long from day 10, then a backfill (start date moved earlier)
// with an older AAA round trip that the sync holds.
async function heldOlderPair() {
    const h = harness();
    await h.apply([fill({ side: 'BUY', filledQty: 10, filledAt: day(10) })]);
    const oldBuy = fill({ side: 'BUY', filledQty: 5, filledPrice: 10, filledAt: day(2), fees: 1 });
    const oldSell = fill({ side: 'SELL', filledQty: 5, filledPrice: 11, filledAt: day(3), fees: 1 });
    const r = await h.apply([oldBuy, oldSell]);
    assert.equal(r.review, 2);
    return { h, oldBuy, oldSell, open: JSON.stringify(h.jd.trades[0]) };
}

test('Import held older fills: one closed trade, the open trade untouched, re-reads add nothing', async () => {
    const { h, oldBuy, oldSell, open } = await heldOlderPair();
    const items = h.items();
    assert.equal(items.held.length, 1);
    assert.equal(items.held[0].reason, engine.BEFORE_EXISTING);
    assert.deepEqual(items.held[0].entries.map(e => e.orderId), [oldBuy.orderId, oldSell.orderId]);

    const r = await h.resolve('import', { groupId: items.held[0].id });
    assert.equal(r.ok, true, r.error);
    assert.match(r.message, /Imported 1 trade\./);
    assert.equal(h.jd.trades.length, 2);
    assert.equal(JSON.stringify(h.jd.trades[0]), open);
    const c = h.jd.trades[1];
    assert.equal(c.quantity, 5);
    assert.equal(c.exitPrice, 11);
    assert.equal(c.pnl, 3);                                  // 5 gross - 2 fees
    assert.equal(c.externalId, 'webull:' + J + ':' + WID + ':' + oldBuy.orderId);
    assert.equal(h.jd.webullReview[J], undefined);

    // Reading the backfill window again is a no-op, and so is a stale click.
    const again = await h.apply([oldBuy, oldSell]);
    assert.equal(again.created + again.review, 0);
    assert.equal(h.jd.trades.length, 2);
    assert.equal((await h.resolve('import', { groupId: items.held[0].id })).ok, false);
});

test('Import refuses fills that leave a position open or can\'t be matched, and keeps them held', async () => {
    const h = harness();
    await h.apply([fill({ side: 'BUY', filledQty: 10, filledAt: day(10) })]);
    const lone = fill({ side: 'BUY', filledQty: 5, filledAt: day(2) });
    await h.apply([lone]);
    const before = snap(h.jd), saves = h.saves;
    const r = await h.resolve('import', { groupId: h.items().held[0].id });
    assert.equal(r.ok, false);
    assert.match(r.error, /leave 5 open/);
    assert.equal(snap(h.jd), before);
    assert.equal(h.saves, saves);

    const h2 = harness();
    await h2.apply([fill({ symbol: 'QQQ', side: 'BUY', filledQty: 10, filledAt: day(10) })]);
    await h2.apply([fill({ symbol: 'QQQ', side: 'SELL', filledQty: 5, filledAt: day(2) })]);
    const r2 = await h2.resolve('import', { groupId: h2.items().held[0].id });
    assert.equal(r2.ok, false);
    assert.match(r2.error, /can't be matched \(opened before start date\)/);
    assert.equal(h2.items().count, 1);
});

test('Ignore held fills: order ids go to webullIgnoredOrders and later syncs drop them', async () => {
    const { h, oldBuy, oldSell, open } = await heldOlderPair();
    const r = await h.resolve('ignore', { groupId: h.items().held[0].id });
    assert.equal(r.ok, true);
    assert.match(r.message, /Ignored 2 orders/);
    assert.deepEqual(h.jd.webullIgnoredOrders[J], { [oldBuy.orderId]: true, [oldSell.orderId]: true });
    assert.equal(h.items().count, 0);
    assert.equal(JSON.stringify(h.jd.trades), '[' + open + ']');
    const again = await h.apply([oldBuy, oldSell]);
    assert.equal(again.ignored, 2);
    assert.equal(again.review, 0);
});

test('A failed save changes nothing and keeps every item', async () => {
    for (const [setup, action, arg] of [
        [editedWithHeldSell, 'keep', s => ({ tradeId: s.t.id })],
        [editedWithHeldSell, 'webull', s => ({ tradeId: s.t.id })],
        [heldOlderPair, 'import', s => ({ groupId: s.h.items().held[0].id })],
        [heldOlderPair, 'ignore', s => ({ groupId: s.h.items().held[0].id })],
    ]) {
        const s = await setup();
        const before = snap(s.h.jd), count = s.h.items().count;
        s.h.failSave = true;
        const r = await s.h.resolve(action, arg(s));
        assert.equal(r.ok, false, action);
        assert.match(r.error, /Disk full\. Nothing was changed\./);
        assert.equal(snap(s.h.jd), before, action);
        assert.equal(s.h.items().count, count, action);
    }
});

test('Held fills whose trade is no longer edited can be imported as the next sync would', async () => {
    const { h, t, sell } = await editedWithHeldSell();
    t.quantity = 10;                                         // user undoes the edit by hand
    const items = h.items();
    assert.equal(items.edited.length, 0);
    assert.equal(items.held[0].reason, engine.EDITED);
    const r = await h.resolve('import', { groupId: items.held[0].id });
    assert.equal(r.ok, true, r.error);
    assert.equal(h.jd.trades.length, 1);
    assert.equal(h.jd.trades[0].exitPrice, 12);
    assert.equal(h.jd.trades[0].notes, 'my plan');
    assert.equal(h.items().count, 0);
    assert.equal((await h.apply([sell])).updated, 0);
});

// ── deleteAccount stops the Webull batch handler before deleting ──

test('deleteAccount stops Webull batches before any local delete', async () => {
    const order = [];
    const deleteAccount = new Function('storeGet', 'storeDelete', 'AUTH_STORE', 'STORE_NAME', 'makeAccountKey',
        'makeUsernameKey', 'makeJournalKey', '_deleteSupabaseAccount', '_disableAutoSignIn', 'window',
        'getSetting', 'setSetting', 'WebullSync',
        'var currentAccountId = "acct_1";\n' + extractFunction(read('js/auth.js'), 'deleteAccount') + '\nreturn deleteAccount;')(
        async () => ({ supabaseUid: null }), async (s, k) => { order.push('delete ' + k); }, 'auth', 'journal',
        id => 'account:' + id, u => 'username:' + u, id => 'journal:' + id,
        async () => { order.push('cloud'); }, async () => {}, {}, async () => null, async () => {},
        { stopBatchHandler: () => order.push('stop') });
    await deleteAccount('acct_1', 'jason');
    assert.equal(order[0], 'stop');
    assert.deepEqual(order.slice(1), ['delete account:acct_1', 'delete username:jason', 'delete journal:acct_1']);
});
