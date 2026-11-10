// Batch D3 pieces of js/auth.js that the D2/D3 sandboxes need: the function
// names to cut out, the constants (as source), and fresh state values.
const D3_FNS = [
    '_cloudRowToLocal', '_extraFields', '_stableSig', '_adoptRevs', '_saveRevs', '_saveCloudDeletes',
    '_forgetCloudRow', '_localValue', '_setLocalValue', '_cloudRowSig', '_recordCloudConflict', '_applyCloudWin',
    '_afterCloudConflicts', '_persistLocalCopy', '_showCloudConflictBanner', '_checkedWriteRows', '_checkedWriteOne',
    '_withoutPk', '_resolveCloudRow', '_cloudSaveRow', '_cloudSaveRows', '_cloudDeleteRow', '_pushCloudDeletes',
    '_deleteCloudRowNow', '_cloudResync', '_cloudTable', '_cloudPk', '_cloudPkValues', '_cloudFilterPk', '_cloudCall',
    '_isDuplicateKey', '_cloudSessionUid', '_saveDemoTradesAndRefresh', '_triggerCloudDashRefresh',
    '_getCloudSaveContext', '_isCloudPrimarySave',
];

function extractVar(src, re, name) {
    const m = re.exec(src);
    if (!m) throw new Error(name + ' not found');
    return m[0];
}

function d3Vars(AUTH) {
    return [
        extractVar(AUTH, /var _MAPPED_FIELDS = \{[\s\S]*?\n\};/, '_MAPPED_FIELDS'),
        extractVar(AUTH, /var _CLOUD_PK = \{[\s\S]*?\n\};/, '_CLOUD_PK'),
        extractVar(AUTH, /var _ISO_TS_RE = [^\n]*;/, '_ISO_TS_RE'),
        extractVar(AUTH, /var _CLOUD_RESYNC_IDLE_MS = [^\n]*;/, '_CLOUD_RESYNC_IDLE_MS'),
    ].join('\n');
}

function d3State() {
    return {
        _rowRev: {}, _cloudDeletes: {}, _cloudConflictCount: 0, _lastCloudResyncMs: 0, _cloudResyncRunning: false,
        _conflictChain: Promise.resolve(), _conflictFlushTimer: null,
    };
}

module.exports = { D3_FNS, d3Vars, d3State };
