// A System strategy becomes the user's own when they save a real change to it.
// The seed never adds a converted, renamed or deleted System name back, the
// rule patch skips converted strategies, and Remove Demo leaves them alone.
// Local version (port 3): saves go to the local journal only; nothing about
// converted names is sent to a cloud.
// Same harness as bug-batch-2.test.js: real functions are cut out of the
// browser scripts and run in a `with` scope (unknown globals are inert).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.join(__dirname, '..');
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8');
const APP = read('Denarii.js');
const AUTH = read('js/auth.js');
const DEMO = read('js/demoSeed.js');
const HTML = read('index.html');

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

function extractStrategySubmit() {
    const head = "document.getElementById('strategy-form')?.addEventListener('submit', async (e) => {";
    const start = APP.indexOf(head);
    if (start < 0) throw new Error('strategy submit not found');
    let depth = 0;
    for (let i = start + head.length - 1; i < APP.length; i++) {
        if (APP[i] === '{') depth++;
        else if (APP[i] === '}' && --depth === 0) {
            return 'async function _strategySubmit(e) ' + APP.slice(start + head.length - 1, i + 1);
        }
    }
    throw new Error('strategy submit: unbalanced braces');
}

const inert = new Proxy(function () {}, {
    get: (t, k) => (k === 'then' ? undefined : k === Symbol.toPrimitive ? () => '' : inert),
    apply: () => inert,
});

function sandbox(code, names, vals) {
    const target = Object.assign({}, vals);
    const scope = new Proxy(target, {
        has: (t, k) => typeof k === 'string',
        get: (t, k) => {
            if (typeof k !== 'string') return undefined;
            if (k in t) return t[k];
            if (k in globalThis) return globalThis[k];
            return inert;
        },
    });
    const fns = new Function('scope', 'with (scope) { return (function () {\n' + code +
        '\nreturn {' + names.join(',') + '};\n})(); }')(scope);
    return { fns, g: target };
}

const clone = v => JSON.parse(JSON.stringify(v));
const SEEDS = new Function(extractFunction(APP, 'getDemoStrategySeedList') + '\nreturn getDemoStrategySeedList();')();
const seed = name => clone(SEEDS.find(s => s.name === name));

// ── Save form ───────────────────────────────────────────────────────────────

const HELPERS = ['normalizeStrategyName', '_isSystemStrategy', '_noteConvertedSystemName', '_systemSeedNameFor',
    'getDemoStrategySeedList', '_strategyTradeCount', '_systemConvertQuestion'];

function formBox(over) {
    const log = { cloud: [], idb: 0, closed: 0, confirms: [], renames: [], keysAtSave: [] };
    const strategy = over.strategy || seed('Support Bounce');
    const fields = {
        'strategy-name': { value: over.name !== undefined ? over.name : strategy.name },
        'strategy-description': { value: over.description !== undefined ? over.description : strategy.description },
    };
    const vals = {
        journalData: { strategies: [strategy].concat(over.others || []), trades: over.trades || [] },
        editingStrategyId: strategy.id,
        selectedStrategyColor: strategy.color,
        currentStrategyGroups: clone(strategy.groups),
        currentUsername: 'test4',
        _seOpenSig: 'open',
        _seFormSig: () => (over.changed === false ? 'open' : 'edited'),
        _editorGuardStale: () => false,
        _isCloudPrimarySave: () => false,
        _saveStrategyToSupabase: async s => { log.cloud.push(clone(s)); return { success: true }; },
        _renameStrategyFlow: async (existing, updated, systemName) => { log.renames.push({ existing, updated, systemName }); return true; },
        saveToIndexedDB: async () => {
            log.idb++;
            log.keysAtSave.push(clone(vals.journalData._convertedSystemStrategyKeys || null));
        },
        closeStrategyEditor: () => { log.closed++; },
        updateStrategiesList: () => {},
        updateStrategyDropdown: () => {},
        alert: m => { throw new Error('unexpected alert: ' + m); },
        confirm: m => { log.confirms.push(m); return over.decline !== true; },
        document: { getElementById: id => fields[id] || null, querySelector: () => null },
    };
    const code = extractStrategySubmit() + '\n' + HELPERS.map(n => extractFunction(APP, n)).join('\n');
    const box = sandbox(code, ['_strategySubmit'].concat(HELPERS), vals);
    return { box, log, strategy };
}

const ev = { preventDefault: () => {} };
const stored = box => box.g.journalData.strategies[0];

test('saving a System strategy with no changes does nothing', async () => {
    const { box, log, strategy } = formBox({ changed: false });
    const before = clone(strategy);
    await box.fns._strategySubmit(ev);
    assert.equal(log.confirms.length, 0);
    assert.equal(log.cloud.length, 0);
    assert.equal(log.idb, 0);
    assert.equal(log.closed, 1, 'editor closed');
    assert.deepEqual(stored(box), before);
    assert.equal(box.g.journalData._convertedSystemStrategyKeys, undefined);
});

test('a real change converts it: isDemoSeed false, convertedFromSystem true, owned by the user', async () => {
    const { box, log, strategy } = formBox({ description: 'my notes' });
    const ruleIds = strategy.groups.map(g => g.rules.map(r => r.id));
    await box.fns._strategySubmit(ev);
    const s = stored(box);
    assert.equal(s.isDemoSeed, false);
    assert.ok('isDemoSeed' in s, 'written as false, not deleted');
    assert.equal(s.convertedFromSystem, true);
    assert.equal(s.createdBy, 'test4');
    assert.equal(s.id, strategy.id);
    assert.equal(s.name, 'Support Bounce');
    assert.equal(s.created, strategy.created);
    assert.equal(s.isFavorite, true);
    assert.equal(s.ruleVersion, strategy.ruleVersion);
    assert.equal(s.description, 'my notes');
    assert.deepEqual(s.groups.map(g => g.rules.map(r => r.id)), ruleIds, 'rule ids kept');
    assert.equal(log.cloud.length, 0, 'no cloud call');
    assert.equal(log.idb, 1, 'saved to the local journal once');
    assert.deepEqual(box.g.journalData._convertedSystemStrategyKeys, ['support bounce']);
    assert.deepEqual(log.keysAtSave, [['support bounce']], 'recorded name is in the same save');
});

test('the confirm shows the number of trades using it (case and spacing insensitive)', async () => {
    const trades = [{ id: 1, setupType: 'Support Bounce' }, { id: 2, setupType: ' support  bounce' },
        { id: 3, setupType: 'Other' }, { id: 4, setupType: '' }];
    const { box, log } = formBox({ description: 'x', trades });
    await box.fns._strategySubmit(ev);
    assert.equal(log.confirms[0], 'This will become your strategy and will no longer receive System updates. ' +
        'It is used by 2 trades; they will stay assigned to it. Continue?');
});

test('the confirm with one trade and a new name says they move to the new name', async () => {
    const { box, log } = formBox({ name: 'My Bounce', trades: [{ id: 1, setupType: 'Support Bounce' }] });
    await box.fns._strategySubmit(ev);
    assert.equal(log.confirms[0], 'This will become your strategy and will no longer receive System updates. ' +
        'It is used by 1 trade; they will be moved to the new name. Continue?');
    assert.equal(log.renames.length, 1, 'name change goes through the rename flow');
    assert.equal(log.renames[0].updated.convertedFromSystem, true);
    assert.equal(log.renames[0].updated.isDemoSeed, false);
    assert.equal(log.renames[0].systemName, 'Support Bounce');
    assert.equal(log.idb, 0, 'the rename flow does the save');
});

test('the confirm with no trades', async () => {
    const { box, log } = formBox({ description: 'x' });
    await box.fns._strategySubmit(ev);
    assert.equal(log.confirms[0], 'This will become your strategy and will no longer receive System updates. Continue?');
});

test('Cancel keeps the editor open and saves nothing', async () => {
    const { box, log, strategy } = formBox({ description: 'x', decline: true });
    const before = clone(strategy);
    await box.fns._strategySubmit(ev);
    assert.equal(log.closed, 0);
    assert.equal(log.cloud.length, 0);
    assert.equal(log.idb, 0);
    assert.deepEqual(stored(box), before);
});

test('conversion leaves rule snapshots and followed rules on trades untouched', async () => {
    const trades = [{
        id: 1, setupType: 'Support Bounce', followedRules: [10101, 10102],
        strategyScore: { strategyId: 1000001, strategyName: 'Support Bounce', grade: 'A',
            rules: [{ id: 10101, text: 'Rule A', stars: 3 }, { id: 10102, text: 'Rule B', stars: 2 }] },
    }];
    const before = clone(trades);
    const { box } = formBox({ description: 'x', trades });
    await box.fns._strategySubmit(ev);
    assert.deepEqual(box.g.journalData.trades, before);
});

test('editing a user strategy is unchanged: no confirm, nothing recorded', async () => {
    const own = { id: 5, name: 'Mine', description: '', color: '#123456', groups: [], createdBy: 'test4' };
    const { box, log } = formBox({ strategy: own, description: 'x' });
    await box.fns._strategySubmit(ev);
    assert.equal(log.confirms.length, 0);
    assert.equal(log.idb, 1);
    assert.equal('convertedFromSystem' in stored(box), false);
    assert.equal(box.g.journalData._convertedSystemStrategyKeys, undefined);
});

test('editor: System strategies open for editing with a note, no read-only alert', () => {
    const fn = extractFunction(APP, 'editStrategy');
    assert.equal(/read-only/.test(fn), false);
    assert.match(fn, /_seOpenSig = _seFormSig\(\);/);
    assert.match(fn, /se-system-note/);
    assert.match(HTML, /id="se-system-note"[^>]*>System strategy\. Saving a change makes it your own strategy\.</);
    assert.equal(/editBtn = isSystem/.test(APP), false, 'Edit button shown for System strategies');
});

// ── Seeding and backfill ────────────────────────────────────────────────────

const SEED_FNS = ['ensureDemoStrategiesExist', 'getDemoStrategySeedList', 'getCanonicalStrategies',
    'saveCanonicalStrategies', 'normalizeStrategyName', 'backfillStrategiesFromExistingTrades'];
const seedBox = journalData => sandbox(SEED_FNS.map(n => extractFunction(APP, n)).join('\n'), SEED_FNS,
    { journalData, currentUsername: 'test4', console: { log: () => {} } });
const names = box => box.g.journalData.strategies.map(s => s.name);
const count = (box, name) => box.g.journalData.strategies.filter(s => s.name === name).length;

test('a new user gets every System strategy', () => {
    const box = seedBox({ strategies: [] });
    assert.equal(box.fns.ensureDemoStrategiesExist(), true);
    assert.equal(box.g.journalData.strategies.length, SEEDS.length);
    assert.ok(box.g.journalData.strategies.every(s => s.isDemoSeed && s.createdBy === 'System'));
    assert.equal(box.fns.ensureDemoStrategiesExist(), false, 'a second run adds nothing');
});

test('seed not re-added after convert (same id and name)', () => {
    const conv = Object.assign(seed('Support Bounce'), { isDemoSeed: false, convertedFromSystem: true, createdBy: 'test4' });
    const box = seedBox({ strategies: [conv], _convertedSystemStrategyKeys: ['support bounce'] });
    box.fns.ensureDemoStrategiesExist();
    assert.equal(count(box, 'Support Bounce'), 1);
    assert.equal(box.g.journalData.strategies.find(s => s.name === 'Support Bounce'), conv);
});

test('seed not re-added after a converted rename (same id, other name)', () => {
    const conv = Object.assign(seed('Support Bounce'), { name: 'My Bounce', isDemoSeed: false, convertedFromSystem: true });
    // Even without the recorded name (another device not synced yet), the id blocks it.
    const box = seedBox({ strategies: [conv] });
    box.fns.ensureDemoStrategiesExist();
    assert.equal(count(box, 'Support Bounce'), 0);
    assert.equal(count(box, 'My Bounce'), 1);
});

test('converted and renamed System strategies: no re-seed, every strategy id stays unique', () => {
    const conv = Object.assign(seed('Support Bounce'), { isDemoSeed: false, convertedFromSystem: true, createdBy: 'test4' });
    const convRenamed = Object.assign(seed('Breakout'), { name: 'My Breakout', isDemoSeed: false, convertedFromSystem: true, createdBy: 'test4' });
    const box = seedBox({ strategies: [conv, convRenamed], _convertedSystemStrategyKeys: ['support bounce', 'breakout'] });
    box.fns.ensureDemoStrategiesExist();
    box.fns.ensureDemoStrategiesExist();
    const ids = box.g.journalData.strategies.map(s => String(s.id));
    assert.equal(new Set(ids).size, ids.length, 'no duplicate ids');
    assert.equal(box.g.journalData.strategies.length, SEEDS.length, 'one strategy per seed id');
    assert.equal(count(box, 'Support Bounce'), 1);
    assert.equal(count(box, 'Breakout'), 0);
    assert.equal(count(box, 'My Breakout'), 1);
});

test('seed not re-added after a converted strategy is deleted', () => {
    const box = seedBox({ strategies: [], _convertedSystemStrategyKeys: ['support bounce'] });
    box.fns.ensureDemoStrategiesExist();
    assert.equal(count(box, 'Support Bounce'), 0);
    assert.equal(box.g.journalData.strategies.length, SEEDS.length - 1, 'every other System strategy still added');
});

test('a pre-existing user strategy with a System name, once deleted, does not bring the seed back', () => {
    const box = seedBox({ strategies: [], _convertedSystemStrategyKeys: ['breakout'] });
    box.fns.ensureDemoStrategiesExist();
    assert.equal(names(box).some(n => n.toLowerCase() === 'breakout'), false);
});

test('seeding matches names case-insensitively', () => {
    const own = { id: 5, name: 'support  BOUNCE', groups: [], createdBy: 'test4' };
    const box = seedBox({ strategies: [own] });
    box.fns.ensureDemoStrategiesExist();
    assert.equal(names(box).filter(n => n.toLowerCase().replace(/\s+/g, ' ') === 'support bounce').length, 1);
    assert.deepEqual(own, { id: 5, name: 'support  BOUNCE', groups: [], createdBy: 'test4' }, 'user strategy untouched');
});

test('hidden System strategies: the deleted-System list still adds them back unfavorited', () => {
    const box = seedBox({ strategies: [], _deletedSystemStrategyKeys: ['support bounce'] });
    box.fns.ensureDemoStrategiesExist();
    assert.equal(box.g.journalData.strategies.find(s => s.name === 'Support Bounce').isFavorite, false);
});

test('the rule patch updates an old System strategy but never a converted one', () => {
    const old = Object.assign(seed('Support Bounce'), { ruleVersion: 0, groups: [] });
    const conv = Object.assign(seed('Breakout'), { ruleVersion: 0, groups: [{ id: 1, name: 'Mine', rules: [{ id: 9, text: 'x' }] }],
        isDemoSeed: false, convertedFromSystem: true, createdBy: 'test4' });
    // A converted strategy that still says isDemoSeed (older save) is also skipped.
    const conv2 = Object.assign(seed('VWAP Reclaim'), { ruleVersion: 0, groups: [],
        convertedFromSystem: true });
    const before = clone([conv, conv2]);
    const box = seedBox({ strategies: [old, conv, conv2] });
    box.fns.ensureDemoStrategiesExist();
    assert.ok(old.groups.length > 0, 'System strategy patched');
    assert.equal(old.ruleVersion, seed('Support Bounce').ruleVersion);
    assert.deepEqual(clone([conv, conv2]), before, 'converted strategies untouched');
});

test('backfill matches names case-insensitively', () => {
    const box = seedBox({ strategies: [{ id: 1, name: 'Support Bounce', groups: [] }] });
    const trades = [{ setupType: 'SUPPORT BOUNCE' }, { setupType: 'abc' }, { setupType: 'ABC' }];
    assert.equal(box.fns.backfillStrategiesFromExistingTrades(trades), true);
    assert.deepEqual(names(box), ['Support Bounce', 'abc']);
    assert.deepEqual(trades.map(t => t.setupType), ['SUPPORT BOUNCE', 'abc', 'ABC'], 'trades untouched');
});

// ── Remove Demo ─────────────────────────────────────────────────────────────

test('Remove Demo (local) never touches strategies, so converted ones stay', () => {
    const box = sandbox(extractFunction(DEMO, '_removeDemoBrokerData'), ['_removeDemoBrokerData'], {
        DEMO_BROKER_ID: 'ba_demo_pelosi',
    });
    const conv = Object.assign(seed('Support Bounce'), { isDemoSeed: false, convertedFromSystem: true, createdBy: 'test4' });
    const sys = seed('Breakout');
    const data = {
        brokerAccounts: [{ id: 'ba_demo_pelosi' }, { id: 'mine' }],
        trades: [{ id: 1, brokerAccountId: 'ba_demo_pelosi', setupType: 'Support Bounce' }, { id: 2, brokerAccountId: 'mine' }],
        strategies: [conv, sys],
    };
    box.fns._removeDemoBrokerData(data);
    assert.deepEqual(data.trades.map(t => t.id), [2]);
    assert.deepEqual(data.strategies, [conv, sys]);
});

// ── No cloud wiring for converted names ─────────────────────────────────────

test('converted System names are never sent to a cloud', () => {
    assert.doesNotMatch(APP, /_saveConvertedSystemStrategyKeysToSupabase|_recordConvertedSystemName/);
    assert.doesNotMatch(AUTH, /_convertedSystemStrategyKeys/);
});
