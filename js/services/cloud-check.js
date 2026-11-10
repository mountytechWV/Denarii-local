// ── DenariiCloudCheck (Batch D3) ─────────────────────────────────────────────
// Console self-check: compares this browser's journalData with the cloud,
// table by table and user_meta key by key, and prints one PASS/FAIL line per
// data type plus a summary. Read-only: it only runs selects.
//
//   await DenariiCloudCheck.run()                  // PASS/FAIL lines + summary
//   await DenariiCloudCheck.run({ verbose: true }) // + the first differing keys
//   await DenariiCloudCheck.conflicts()            // conflict copies kept in this browser
//
// A row compares equal when the local record and the cloud row give the same
// signature through the app's own mappers (_mapArrayRow / _rowSig), so only
// fields the cloud stores are compared and key order / timestamp format do
// not matter. Trades compare on the columns the local trade sets.
(function (global) {
    'use strict';

    var TABLES = [
        ['trades', 'trades'], ['strategies', 'strategies'], ['brokerAccounts', 'broker_accounts'],
        ['tags', 'tags'], ['noteTemplates', 'note_templates'], ['reviews', 'reviews'],
        ['dailyPlanners', 'daily_planners'], ['weeklyPlanners', 'weekly_planners'],
        ['aiOutputHistory', 'ai_reports'], ['aiPrompts', 'ai_prompts']
    ];

    function pad(s, n) { s = String(s); while (s.length < n) s += ' '; return s; }

    function sig(dk, row) {
        if (dk === 'trades') {
            var c = {};
            for (var k in row) if (k !== 'user_id') c[k] = row[k];
            return _stableSig(c);
        }
        return _rowSig(dk, row);
    }

    // Cloud row → local record → row, the same path local rows take.
    function cloudSig(dk, r, uid, localRow) {
        if (dk === 'trades') {
            var mapped = _mapArrayRow(uid, 'trades', _mapSupabaseTradeRow(r));
            var c = {};
            // Only the columns the local row sets (a field left out locally is
            // not written, so the cloud value is not compared). A NULL column
            // the trade mapper leaves out counts as null, as the local row writes it.
            for (var k in (localRow || mapped)) if (k !== 'user_id') c[k] = mapped[k] === undefined ? null : mapped[k];
            return _stableSig(c);
        }
        return _cloudRowSig(dk, r, uid);
    }

    function cloudKey(dk, r) {
        if (dk === 'reviews') return r.review_type + '|' + r.review_key;
        if (dk === 'dailyPlanners' || dk === 'weeklyPlanners') return r.planner_key;
        return String(r.id);
    }

    function pendingCount(dk) {
        var p = (typeof _cloudPending !== 'undefined' && _cloudPending[dk]) || {};
        var d = (typeof _cloudDeletes !== 'undefined' && _cloudDeletes[dk]) || {};
        return Object.keys(p).length + Object.keys(d).length;
    }

    function compare(dk, localRows, cloudRows, uid) {
        var localByKey = {}, cloudByKey = {};
        localRows.forEach(function (r) { localByKey[_rowKey(dk, r)] = r; });
        cloudRows.forEach(function (r) { cloudByKey[cloudKey(dk, r)] = r; });
        var localOnly = [], cloudOnly = [], differ = [];
        Object.keys(localByKey).forEach(function (k) {
            if (!cloudByKey[k]) localOnly.push(k);
            else if (sig(dk, localByKey[k]) !== cloudSig(dk, cloudByKey[k], uid, localByKey[k])) differ.push(k);
        });
        Object.keys(cloudByKey).forEach(function (k) { if (!localByKey[k]) cloudOnly.push(k); });
        return { local: localRows.length, cloud: cloudRows.length, localOnly: localOnly, cloudOnly: cloudOnly, differ: differ };
    }

    async function run(opts) {
        opts = opts || {};
        var verbose = !!opts.verbose;
        var results = [];
        function line(name, ok, detail, extra) {
            results.push({ name: name, ok: ok, detail: detail, extra: extra || null });
            var text = (ok === null ? 'INFO' : ok ? 'PASS' : 'FAIL') + '  ' + pad(name, 30) + detail;
            if (ok === false) console.warn(text); else console.log(text);
        }

        if (typeof SupabaseAuth === 'undefined' || !SupabaseAuth.isReady()) {
            console.warn('FAIL  cloud not available');
            return { ok: false, results: [] };
        }
        var client = SupabaseAuth.getClient();
        var sess = await SupabaseAuth.supabaseGetSession();
        var uid = sess && sess.data && sess.data.user ? sess.data.user.id : null;
        var jd = (typeof journalData !== 'undefined') ? journalData : {};

        line('session', !!uid && _sessionMatchesAccount(uid),
            'mode ' + global._denariiStorageMode + ' | baseline ' + (typeof _cloudBaselineReady !== 'undefined' && _cloudBaselineReady) +
            ' | paused ' + (typeof _cloudPaused !== 'undefined' && _cloudPaused) +
            ' | online ' + (typeof navigator === 'undefined' || navigator.onLine !== false));
        if (!uid || !_sessionMatchesAccount(uid)) return summarize(results);

        for (var i = 0; i < TABLES.length; i++) {
            var dk = TABLES[i][0], table = TABLES[i][1];
            try {
                var cloudRows = await _fetchAllRows(client, table, uid);
                var localRows = (jd[dk] === undefined || jd[dk] === null) ? [] : _mapDomainRows(uid, dk, jd[dk]);
                if (dk === 'trades') {
                    localRows = (jd.trades || []).map(function (t) { return _mapArrayRow(uid, 'trades', t); }).filter(Boolean);
                }
                if (dk === 'aiPrompts') cloudRows = cloudRows.filter(function (r) { return r.created_by !== 'Denarii'; });
                var c = compare(dk, localRows, cloudRows, uid);
                var pend = dk === 'trades' ? 0 : pendingCount(dk);
                var ok = !c.localOnly.length && !c.cloudOnly.length && !c.differ.length && !pend;
                var detail = 'local ' + c.local + ' / cloud ' + c.cloud +
                    (c.localOnly.length ? ' / local-only ' + c.localOnly.length : '') +
                    (c.cloudOnly.length ? ' / cloud-only ' + c.cloudOnly.length : '') +
                    (c.differ.length ? ' / differ ' + c.differ.length : '') +
                    (pend ? ' / pending ' + pend : '');
                line(table, ok, detail, c);
                if (verbose && !ok) {
                    if (c.localOnly.length) console.log('      local-only:', c.localOnly.slice(0, 5));
                    if (c.cloudOnly.length) console.log('      cloud-only:', c.cloudOnly.slice(0, 5));
                    if (c.differ.length) console.log('      differ:', c.differ.slice(0, 5));
                }
            } catch (e) {
                line(table, false, 'error: ' + (e.message || e));
            }
        }

        // user_meta: one line per key the app syncs.
        try {
            var metaRows = await _fetchAllRows(client, 'user_meta', uid);
            var cloudMeta = {};
            metaRows.forEach(function (r) { cloudMeta[r.key] = r; });
            var localMeta = {};
            _mapUserMetaRows(uid, jd).forEach(function (r) { localMeta[r.key] = r.value; });
            var metaPend = (typeof _cloudPending !== 'undefined' && _cloudPending._meta) || {};
            _USER_META_KEYS.forEach(function (k) {
                var hasL = Object.prototype.hasOwnProperty.call(localMeta, k), hasC = !!cloudMeta[k];
                if (!hasL && !hasC) return;
                var cv = hasC ? JSON.stringify(_cloudRowToLocal('_meta', cloudMeta[k])) : null;
                var ok = hasL && hasC && cv === localMeta[k] && !metaPend[k];
                var detail = !hasC ? 'missing in cloud' : !hasL ? 'missing in this browser' :
                    cv !== localMeta[k] ? 'differs' : metaPend[k] ? 'pending' : 'same';
                line('user_meta.' + k, ok, detail);
            });
        } catch (e) {
            line('user_meta', false, 'error: ' + (e.message || e));
        }

        // user_settings: the encrypted Gemini key, cloud vs this browser's cache.
        try {
            var us = await client.from('user_settings').select('gemini_key_encrypted, rev').eq('user_id', uid).maybeSingle();
            if (us.error) throw new Error(us.error.message);
            var acct = (typeof currentAccountId !== 'undefined') ? currentAccountId : null;
            var cached = await global.getAppSetting(acct ? 'gemini-api-key:' + acct : 'gemini-api-key');
            var cloudBlob = us.data ? (us.data.gemini_key_encrypted || null) : null;
            var same = (cached || null) === cloudBlob;
            line('user_settings (Gemini key)', same,
                (cloudBlob ? 'cloud has a key' : 'no key in cloud') + ' / ' + (cached ? 'browser has a key' : 'no key in browser') +
                (same ? '' : ' / differ'));
        } catch (e) {
            line('user_settings (Gemini key)', false, 'error: ' + (e.message || e));
        }

        // user_integration_keys: the encrypted Twelve Data key. Presence only;
        // the key and its blob are never printed.
        try {
            var tk = await client.from('user_integration_keys').select('key_encrypted, rev')
                .eq('user_id', uid).eq('provider', 'twelvedata').maybeSingle();
            if (tk.error) throw new Error(tk.error.message);
            var tAcct = (typeof currentAccountId !== 'undefined') ? currentAccountId : null;
            var tCached = await global.getAppSetting(tAcct ? 'twelvedata-api-key:' + tAcct : 'twelvedata-api-key');
            var tCloud = tk.data ? (tk.data.key_encrypted || null) : null;
            var tSame = (tCached || null) === tCloud;
            line('user_integration_keys (Twelve Data key)', tSame,
                (tCloud ? 'cloud has a key' : 'no key in cloud') + ' / ' + (tCached ? 'browser has a key' : 'no key in browser') +
                (tSame ? '' : ' / differ'));
        } catch (e) {
            line('user_integration_keys (Twelve Data key)', false, 'error: ' + (e.message || e));
        }

        // journal_backups: retired for cloud_primary; last_saved must not move.
        try {
            var jb = await client.from('journal_backups').select('last_saved').eq('user_id', uid).maybeSingle();
            line('journal_backups', null, 'last_saved ' + (jb.data ? jb.data.last_saved : 'none') + ' (should not change after D3)');
        } catch (e) {
            line('journal_backups', null, 'error: ' + (e.message || e));
        }

        var conflictsKept = 0;
        try { conflictsKept = ((await global.getAppSetting('cloudConflicts:' + currentAccountId)) || []).length; } catch (e) { /* none */ }
        line('conflict copies', null, conflictsKept + ' kept in this browser (DenariiCloudCheck.conflicts())');
        return summarize(results);
    }

    function summarize(results) {
        var checked = results.filter(function (r) { return r.ok !== null; });
        var failed = checked.filter(function (r) { return !r.ok; });
        var ok = failed.length === 0 && checked.length > 1;
        var text = (ok ? 'PASS' : 'FAIL') + '  SUMMARY: ' + (checked.length - failed.length) + '/' + checked.length + ' passed' +
            (failed.length ? ' — failed: ' + failed.map(function (r) { return r.name; }).join(', ') : '');
        if (ok) console.log(text); else console.warn(text);
        return { ok: ok, results: results };
    }

    // Conflict copies kept in this browser (newest last), decrypted.
    async function conflicts() {
        var acct = (typeof currentAccountId !== 'undefined') ? currentAccountId : null;
        if (!acct) return [];
        var list = (await global.getAppSetting('cloudConflicts:' + acct)) || [];
        var encKey = (typeof sessionDek !== 'undefined' && sessionDek) || (typeof sessionPassword !== 'undefined' && sessionPassword) || null;
        var out = list.map(function (c) {
            var local = null;
            if (c.local && encKey) { try { local = decrypt(c.local, encKey); } catch (e) { local = null; } }
            return { domain: c.domain, key: c.key, at: c.at, reason: c.reason, local: local };
        });
        if (typeof console.table === 'function') console.table(out.map(function (c) { return { domain: c.domain, key: c.key, at: c.at, reason: c.reason }; }));
        return out;
    }

    global.DenariiCloudCheck = { run: run, conflicts: conflicts };
})(typeof window !== 'undefined' ? window : globalThis);
