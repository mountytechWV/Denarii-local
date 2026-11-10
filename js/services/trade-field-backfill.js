// ── Batch D1: one-time upload of browser-only trade fields ──────────────────
// fills, grossPnl, feeSource, contractName, sourceFile, tosRefNum,
// notesUpdatedAt, sessionHeaderDate and entry/exitCommissionFees used to live
// only in this browser's journalData. After sign-in this uploads the values
// the cloud row is still missing, once.
//
// Safety:
// - One UPDATE per trade naming only the missing new columns, each guarded
//   with IS NULL, so a value already in the cloud is never overwritten, and
//   totals, P&L, times, ids and the Webull columns are never sent.
// - UPDATE never creates a row; a trade deleted in the cloud matches nothing.
// - A local trade whose quantity / P&L / times / symbol differ from the cloud
//   row, or whose fills don't add up to the cloud quantity, is stale: it is
//   skipped and listed in the marker and the console.
// - Values go through _mapArrayRow, the same mapping every save uses, and
//   are uploaded exactly as stored.
//
// Progress marker: localStorage 'denarii_d1_backfill_v1_<uid>'. "Still NULL in
// the cloud" is what decides whether a trade needs uploading, so an
// interrupted run resumes safely on the next sign-in.
//
// Console:
//   await DenariiTradeBackfill.run({ force: true, dryRun: true })  // counts only
//   await DenariiTradeBackfill.run({ force: true })                 // upload
//   await DenariiTradeBackfill.run({ force: true, source: obj })    // from the saved JSON copy
(function (root) {
    'use strict';

    var NEW_COLUMNS = ['fills', 'gross_pnl', 'fee_source', 'contract_name', 'source_file', 'tos_ref_num',
        'notes_updated_at', 'session_header_date', 'entry_commission_fees', 'exit_commission_fees'];
    var BATCH = 25;

    // Globals from js/auth.js and Denarii.js, resolved when used; tests replace them.
    var deps = {
        getCtx: function () { return typeof _getCloudSaveContext === 'function' ? _getCloudSaveContext() : null; },
        fetchRows: function (client, uid) { return _fetchAllRows(client, 'trades', uid); },
        mapRow: function (uid, trade) { return _mapArrayRow(uid, 'trades', trade); },
        getTrades: function () {
            /* global journalData */
            return (typeof journalData !== 'undefined' && journalData && Array.isArray(journalData.trades)) ? journalData.trades : null;
        },
        storage: function () { try { return root.localStorage || null; } catch (e) { return null; } },
        pause: function () { return new Promise(function (r) { setTimeout(r, 150); }); }
    };

    function markerKey(uid) { return 'denarii_d1_backfill_v1_' + uid; }

    function readMarker(uid) {
        try { var s = deps.storage(); var v = s && s.getItem(markerKey(uid)); return v ? JSON.parse(v) : null; }
        catch (e) { return null; }
    }
    function writeMarker(uid, m) {
        try { var s = deps.storage(); if (s) s.setItem(markerKey(uid), JSON.stringify(m)); } catch (e) { /* ignore */ }
    }

    function sameNum(a, b, tol) {
        if (a == null || b == null) return a == null && b == null;
        return Math.abs(Number(a) - Number(b)) <= tol;
    }
    function sameTime(a, b) {
        if (!a || !b) return !a && !b;
        if (a === b) return true;
        var ta = Date.parse(a), tb = Date.parse(b);
        return isFinite(ta) && ta === tb;
    }

    // Why the local trade can't be trusted against this cloud row, or null.
    // P&L allows half a cent: Batch B rounded a few cloud rows only.
    function staleReason(row, cloud) {
        if (String(row.symbol || '') !== String(cloud.symbol || '')) return 'symbol';
        if (!sameNum(row.quantity, cloud.quantity, 1e-6)) return 'quantity';
        if (!sameNum(row.pnl, cloud.pnl, 0.0051)) return 'pnl';
        if (!sameTime(row.entry_time, cloud.entry_time)) return 'entry_time';
        if (!sameTime(row.exit_time, cloud.exit_time)) return 'exit_time';
        return null;
    }

    // Pure: which new columns each local trade can fill in the cloud.
    // Returns { patches: [{ id, symbol, patch }], stale: [{ id, symbol, reason }], counts }.
    function buildPlan(uid, localTrades, cloudRows) {
        var byId = {};
        for (var i = 0; i < cloudRows.length; i++) byId[String(cloudRows[i].id)] = cloudRows[i];
        var out = { patches: [], stale: [], counts: { local: localTrades.length, noId: 0, noCloudRow: 0, nothingToUpload: 0 } };
        for (var j = 0; j < localTrades.length; j++) {
            var t = localTrades[j];
            if (!t || t.id == null || t.id === '') { out.counts.noId++; continue; }
            var cloud = byId[String(t.id)];
            if (!cloud) { out.counts.noCloudRow++; continue; }
            var row = deps.mapRow(uid, t);
            if (!row) { out.counts.nothingToUpload++; continue; }
            var patch = {}, n = 0;
            for (var c = 0; c < NEW_COLUMNS.length; c++) {
                var col = NEW_COLUMNS[c];
                if (!Object.prototype.hasOwnProperty.call(row, col) || row[col] === null) continue;
                if (cloud[col] != null) continue;
                patch[col] = row[col];
                n++;
            }
            if (n === 0) { out.counts.nothingToUpload++; continue; }
            var reason = staleReason(row, cloud);
            if (!reason && patch.fills) {
                var sum = 0;
                for (var f = 0; f < patch.fills.length; f++) sum += Number(patch.fills[f].quantity) || 0;
                if (!sameNum(sum, cloud.quantity, 1e-6)) reason = 'fills quantity';
            }
            if (reason) { out.stale.push({ id: String(t.id), symbol: t.symbol || '', reason: reason }); continue; }
            out.patches.push({ id: String(t.id), symbol: t.symbol || '', patch: patch });
        }
        return out;
    }

    function tradesFromSource(src) {
        if (Array.isArray(src)) return src;
        if (src && Array.isArray(src.trades)) return src.trades;
        return null;
    }

    function isNetworkError(msg) { return /fetch|network|timeout|offline/i.test(String(msg || '')); }

    var _running = false;

    async function run(opts) {
        opts = opts || {};
        if (_running) return { status: 'busy' };
        var ctx = deps.getCtx();
        if (!ctx) { console.log('[D1Backfill] Not run: cloud save not available.'); return { status: 'no-cloud' }; }
        var uid = ctx.userId;
        var marker = readMarker(uid);
        if (marker && marker.status === 'done' && !opts.force) {
            console.log('[D1Backfill] Already done (' + (marker.finishedAt || '') + '); nothing to do.');
            return { status: 'done', marker: marker };
        }
        var local = opts.source ? tradesFromSource(opts.source) : deps.getTrades();
        if (!local) { console.log('[D1Backfill] Not run: no local trades.'); return { status: 'no-local' }; }

        _running = true;
        try {
            var plan = buildPlan(uid, local, await deps.fetchRows(ctx.client, uid));
            var summary = { candidates: plan.patches.length, stale: plan.stale.length, counts: plan.counts };
            if (opts.dryRun) {
                console.log('[D1Backfill] Dry run: ' + plan.patches.length + ' trades to upload, ' + plan.stale.length + ' stale.', plan.counts);
                if (plan.stale.length && console.table) console.table(plan.stale);
                return { status: 'dry-run', summary: summary, patches: plan.patches, stale: plan.stale };
            }

            var m = {
                version: 1, status: 'running', startedAt: new Date().toISOString(), finishedAt: null,
                candidates: plan.patches.length, uploaded: 0, alreadySet: 0, failed: 0,
                failedIds: [], stale: plan.stale, counts: plan.counts, lastError: null
            };
            writeMarker(uid, m);
            console.log('[D1Backfill] Uploading ' + plan.patches.length + ' trades in batches of ' + BATCH + '.');

            var aborted = false;
            for (var b = 0; b < plan.patches.length && !aborted; b += BATCH) {
                var batch = plan.patches.slice(b, b + BATCH);
                for (var k = 0; k < batch.length; k++) {
                    var p = batch[k];
                    var res;
                    try {
                        var q = ctx.client.from('trades').update(p.patch, { count: 'exact' })
                            .eq('user_id', uid).eq('id', p.id);
                        Object.keys(p.patch).forEach(function (col) { q = q.is(col, null); });
                        res = await q;
                    } catch (e) {
                        res = { error: { message: (e && e.message) || String(e) } };
                    }
                    if (res.error) {
                        m.lastError = res.error.message;
                        if (isNetworkError(res.error.message)) { aborted = true; break; }
                        m.failed++;
                        m.failedIds.push(p.id);
                    } else if (res.count === 0) {
                        m.alreadySet++;   // filled in or deleted since the cloud rows were read
                    } else {
                        m.uploaded++;
                    }
                }
                writeMarker(uid, m);
                console.log('[D1Backfill] ' + Math.min(b + BATCH, plan.patches.length) + ' / ' + plan.patches.length);
                if (!aborted && b + BATCH < plan.patches.length) await deps.pause();
            }

            if (aborted) {
                m.status = 'running';
                console.warn('[D1Backfill] Stopped (network): ' + m.lastError + '. It resumes on the next sign-in.');
            } else {
                m.status = m.failed > 0 ? 'partial' : 'done';
                m.finishedAt = new Date().toISOString();
                console.log('[D1Backfill] ' + m.status + ': uploaded ' + m.uploaded + ', already set ' + m.alreadySet +
                    ', failed ' + m.failed + ', stale skipped ' + m.stale.length + '.');
            }
            if (m.stale.length) {
                console.warn('[D1Backfill] Stale local trades (skipped, not uploaded):');
                if (console.table) console.table(m.stale); else console.log(m.stale);
            }
            writeMarker(uid, m);
            return { status: m.status, marker: m };
        } catch (err) {
            console.error('[D1Backfill] Error:', (err && err.message) || err);
            return { status: 'error', error: (err && err.message) || String(err) };
        } finally {
            _running = false;
        }
    }

    // Starts once per page load, after the trade load finishes. Denarii.js sets
    // window._wbAutoSyncScheduled at that point; the delay lets Webull
    // auto-sync go first.
    function scheduleOnLoad() {
        var waited = 0;
        var timer = setInterval(function () {
            waited += 1000;
            if (root._wbAutoSyncScheduled) {
                clearInterval(timer);
                setTimeout(function () { run(); }, 20000);
            } else if (waited > 600000) {
                clearInterval(timer);
            }
        }, 1000);
    }

    root.DenariiTradeBackfill = {
        run: run, buildPlan: buildPlan, markerKey: markerKey, readMarker: readMarker,
        NEW_COLUMNS: NEW_COLUMNS, BATCH: BATCH, _deps: deps
    };
    if (typeof module !== 'undefined' && module.exports) module.exports = root.DenariiTradeBackfill;
    else if (root.document) scheduleOnLoad();
})(typeof window !== 'undefined' ? window : globalThis);
