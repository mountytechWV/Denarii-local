// Webull Phase 8: cloud trades row mapper safety (js/auth.js).
// The new columns (external_id, external_order_ids, webull_partials) are NULL
// for non-Webull trades, the reverse mapper adds no new keys for them, and
// every pre-Phase-8 column mapping is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const { _mapArrayRow, _mapSupabaseTradeRow } = require('./helpers/auth-mappers.js');

// Every trades column _mapArrayRow wrote before Phase 8, with the value it
// writes for an empty trade. Pinned here so any change to an existing
// mapping fails this test.
const EMPTY_ROW = {
    user_id: 'U', id: undefined, symbol: '', direction: '', entry_date: null, exit_date: null,
    entry_price: null, exit_price: null, quantity: null, pnl: null, fees: null, strategy: '', notes: '',
    tags: [], broker_account_id: null, created_at: null, updated_at: null, entry_time: null, exit_time: null,
    hold_seconds: null, asset_type: null, option_type: null, option_action: null, strike: null, expiry: null,
    setup_type: null, strategy_score: null, emotion: null, trade_grade: null, entry_reason: null,
    exit_reason: null, lessons: null, quick_notes: null, profit_targets: null, stop_losses: null,
    commission_fees: null, trade_risk: null, initial_target: null, planned_r_multiple: null,
    realized_r_multiple: null, drawdown: null, runup: null, source: null,
};
const NEW_NULLS = { external_id: null, external_order_ids: null, webull_partials: null };

// Keys _mapSupabaseTradeRow returned before Phase 8.
const OLD_TRADE_KEYS = ['id', 'symbol', 'direction', 'entryDate', 'exitDate', 'entryPrice', 'exitPrice',
    'quantity', 'pnl', 'fees', 'strategy', 'notes', 'tags', 'brokerAccountId', 'createdAt', 'updatedAt',
    'entryTime', 'exitTime', 'holdSeconds', 'assetType', 'optionType', 'optionAction', 'strike', 'expiry',
    'setupType', 'strategyScore', 'emotion', 'tradeGrade', 'entryReason', 'exitReason', 'lessons',
    'quickNotes', 'profitTargets', 'stopLosses', 'commissionFees', 'tradeRisk', 'initialTarget',
    'plannedRMultiple', 'realizedRMultiple', 'drawdown', 'runup', 'source'];

// Shape produced by js/demoSeed.js (Pelosi demo).
const pelosi = {
    id: 1700000000001, symbol: 'NVDA', type: 'short', quantity: 50, entryPrice: 120.5, exitPrice: 118.25,
    entryTime: '2026-03-02T14:35:00.000Z', exitTime: '2026-03-02T15:10:00.000Z', holdSeconds: 2100,
    pnl: 110.5, brokerAccountId: 'demo_pelosi', assetType: 'stock', optionType: null, optionAction: null,
    strike: null, expiry: null, setupType: 'Breakout', strategyScore: null, emotion: 'Calm', tags: ['A+'],
    tradeGrade: 'A', entryReason: 'r', exitReason: 'x', lessons: 'l', notes: 'n', quickNotes: 'q',
    profitTargets: [{ price: 117, qty: 50 }], stopLosses: [{ price: 122, qty: 50 }], commissionFees: 2,
    tradeRisk: 75, initialTarget: 175, plannedRMultiple: 2.33, realizedRMultiple: 1.47, drawdown: 40,
    runup: 130, source: 'manual',
};

// Shape produced by confirmBrokerImport's _expandForSave (grouped option).
const csv = {
    symbol: 'MSFT', type: 'long', assetType: 'option', optionType: 'CALL', strike: 537.5, expiry: '2026-10-16',
    contractName: 'MSFT261016C00537500', source: 'csv', sourceFile: 'webull.csv', brokerAccountId: 'ba_csv',
    id: 1700000000002, quantity: 8, entryPrice: 1.82, exitPrice: 1.11, entryTime: '2026-07-02T14:00:00.000Z',
    exitTime: '2026-07-02T15:00:00.000Z', holdSeconds: 3600, grossPnl: -568, pnl: -568.77, commissionFees: 0.77,
    feeSource: 'actual',
    fills: [{ fillId: 'f1', quantity: 8, entryPrice: 1.82, exitPrice: 1.11, commissionFees: 0.77, pnl: -568.77 }],
};

test('Pelosi-style trade: existing columns unchanged, new columns NULL', () => {
    const row = _mapArrayRow('U', 'trades', pelosi);
    assert.deepEqual(row, {
        ...EMPTY_ROW, ...NEW_NULLS,
        id: 1700000000001, symbol: 'NVDA', direction: 'short', entry_price: 120.5, exit_price: 118.25,
        quantity: 50, pnl: 110.5, notes: 'n', tags: ['A+'], broker_account_id: 'demo_pelosi',
        entry_time: '2026-03-02T14:35:00.000Z', exit_time: '2026-03-02T15:10:00.000Z', hold_seconds: 2100,
        asset_type: 'stock', setup_type: 'Breakout', emotion: 'Calm', trade_grade: 'A', entry_reason: 'r',
        exit_reason: 'x', lessons: 'l', quick_notes: 'q', profit_targets: [{ price: 117, qty: 50 }],
        stop_losses: [{ price: 122, qty: 50 }], commission_fees: 2, trade_risk: 75, initial_target: 175,
        planned_r_multiple: 2.33, realized_r_multiple: 1.47, drawdown: 40, runup: 130, source: 'manual',
    });
});

test('CSV-style trade: existing columns unchanged, new columns NULL', () => {
    const row = _mapArrayRow('U', 'trades', csv);
    assert.deepEqual(row, {
        ...EMPTY_ROW, ...NEW_NULLS,
        id: 1700000000002, symbol: 'MSFT', direction: 'long', entry_price: 1.82, exit_price: 1.11, quantity: 8,
        pnl: -568.77, broker_account_id: 'ba_csv', entry_time: '2026-07-02T14:00:00.000Z',
        exit_time: '2026-07-02T15:00:00.000Z', hold_seconds: 3600, asset_type: 'option', option_type: 'CALL',
        strike: 537.5, expiry: '2026-10-16', commission_fees: 0.77, source: 'csv',
        // Batch D1 columns, written because the trade has them.
        gross_pnl: -568, fee_source: 'actual', contract_name: 'MSFT261016C00537500', source_file: 'webull.csv',
        fills: csv.fills,
    });
});

test('Pelosi- and CSV-style rows load with the pre-Phase-8 keys only and round-trip unchanged', () => {
    // Batch D1: plus the fields the trade has, and type from direction.
    const keys = new Map([[pelosi, [...OLD_TRADE_KEYS, 'type']],
        [csv, [...OLD_TRADE_KEYS, 'fills', 'grossPnl', 'feeSource', 'contractName', 'sourceFile', 'type']]]);
    for (const trade of [pelosi, csv]) {
        // JSON round trip stands in for the PostgREST response.
        const row = JSON.parse(JSON.stringify(_mapArrayRow('U', 'trades', trade)));
        const loaded = _mapSupabaseTradeRow(row);
        assert.deepEqual(Object.keys(loaded), keys.get(trade));
        assert.equal('externalId' in loaded || 'externalOrderIds' in loaded || 'webullPartials' in loaded, false);
        // Saving the loaded trade again writes the identical row.
        assert.deepEqual(_mapArrayRow('U', 'trades', loaded), row);
    }
});

test('Webull fields are written only for source webull', () => {
    const stray = { ...csv, externalId: 'webull:x:y:z', externalOrderIds: { a: 1 }, webullPartials: [{}] };
    const row = _mapArrayRow('U', 'trades', stray);
    assert.equal(row.external_id, null);
    assert.equal(row.external_order_ids, null);
    assert.equal(row.webull_partials, null);
});

test('Webull trade: externalId, externalOrderIds and webullPartials survive save + load', () => {
    const wb = {
        id: 1792600000000, symbol: 'MSTR', type: 'long', assetType: 'option', optionType: 'CALL', strike: 102,
        expiry: '2026-07-02', contractName: 'MSTR260702C00102000', source: 'webull',
        brokerAccountId: 'ba_1792516090168_r2mg8', externalId: 'webull:ba_1792516090168_r2mg8:A1:o1',
        feeSource: 'actual', quantity: 5, entryPrice: 1.82, entryTime: '2026-07-01T14:00:00.000Z',
        exitPrice: null, exitTime: null, holdSeconds: null, grossPnl: null, pnl: null, commissionFees: 0.5,
        externalOrderIds: { o1: 8, o2: 3 },
        webullPartials: [{ fillId: 'p1', quantity: 3, entryPrice: 1.82, exitPrice: 2.1, pnl: 83.5 }],
    };
    const row = JSON.parse(JSON.stringify(_mapArrayRow('U', 'trades', wb)));
    assert.equal(row.external_id, wb.externalId);
    assert.deepEqual(row.external_order_ids, wb.externalOrderIds);
    assert.deepEqual(row.webull_partials, wb.webullPartials);
    const loaded = _mapSupabaseTradeRow(row);
    assert.equal(loaded.externalId, wb.externalId);
    assert.deepEqual(loaded.externalOrderIds, wb.externalOrderIds);
    assert.deepEqual(loaded.webullPartials, wb.webullPartials);
    assert.equal(loaded.source, 'webull');
    assert.equal(loaded.brokerAccountId, wb.brokerAccountId);
});
