// ── Journal page ─────────────────────────────────────────────────────────────
// Extracted from Denarii.js — copy-first (original still present in Denarii.js)
// Dependencies (remain global in Denarii.js):
//   journalData, escapeHtml, saveToIndexedDB, updateDashboard,
//   _computeTradeMetrics, _applyMetrics, _sfId,
//   _getRowData, _rehydrateRows, addTargetRow, addStopRow,
//   renderNoteTemplateChips

(function () {

    // ── Notes read / write helpers ────────────────────────────────────────────

    function _jnlGetNotes() {
        const el = document.getElementById('jnl-notes');
        if (!el) return '';
        const html = el.innerHTML.trim();
        return (html === '' || html === '<br>') ? '' : html;
    }

    function _jnlSetNotes(content) {
        const el = document.getElementById('jnl-notes');
        if (!el) return;
        if (!content) { el.innerHTML = ''; return; }
        // If content has no HTML tags (plain text / migrated content), convert to paragraphs
        if (!/<[a-z][\s\S]*>/i.test(content)) {
            el.innerHTML = content
                .split('\n\n')
                .map(para => para.trim() ? `<p>${para.replace(/\n/g, '<br>')}</p>` : '<p><br></p>')
                .join('');
        } else {
            el.innerHTML = content;
        }
    }

    // ── Module-level state ────────────────────────────────────────────────────

    window._jnlSelectedTradeId = null;

    // ── Trade list pagination ────────────────────────────────────────────────
    var _jnlListPage = 1;
    var _jnlListPageSize = 50;

    // ── Draft protection (localStorage backup, per trade) ─────────────────────
    // Trade Journal saves only on explicit Save Journal Entry. Any typed or
    // template-appended Reflection content between loads is vulnerable to loss
    // on navigation/reload/crash. Mirror the reviews.js pattern: synchronous
    // localStorage write on every keystroke, scoped per trade id, restored
    // only when newer than the last persisted save.
    function _jnlDraftKey(tradeId) { return 'jnl-notes-draft-' + tradeId; }
    function _jnlSaveDraft(tradeId /* , _legacyHtmlArg */) {
        if (!tradeId) return;
        try {
            var notesEl = document.getElementById('jnl-notes');
            var quickEl = document.getElementById('jnl-quick-notes');
            var gradeEl = document.getElementById('jnl-trade-grade');
            var setupEl = document.getElementById('jnl-setup-type');
            var tagRowsEl = document.getElementById('jnl-tag-rows');
            var tags = [];
            if (tagRowsEl) {
                tagRowsEl.querySelectorAll('.jnl-tag-row').forEach(function(r) {
                    tags.push({
                        cat:  (r.querySelector('.jnl-tag-cat')  || {}).value || '',
                        name: (r.querySelector('.jnl-tag-name') || {}).value || ''
                    });
                });
            }
            // Strategy rule checkboxes — read directly from DOM so we don't depend
            // on _jnlFollowedRules being fresh. Store id suffixes as strings; we
            // restore by matching element ids, sidestepping number/string issues.
            var rulesEl = document.getElementById('jnl-rules-list');
            var rules = [];
            if (rulesEl) {
                rulesEl.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
                    if (!cb.checked) return;
                    var m = (cb.id || '').match(/^jnl-rule-(.+)$/);
                    if (m) rules.push(m[1]);
                });
            }
            // Core trade fields — snapshot whatever is currently in the DOM so
            // edits to Symbol, Asset Type, Side, Quantity, Entry/Exit Price,
            // Entry/Exit Time, Commission & Fees, and option fields survive
            // navigation/reload before Save Journal Entry. Keyed by element id
            // for a lossless round-trip on restore.
            var _coreIds = [
                'jnl-symbol', 'jnl-asset-type', 'jnl-trade-type',
                'jnl-quantity', 'jnl-entry-price', 'jnl-exit-price',
                'jnl-entry-time', 'jnl-exit-time', 'jnl-commission-fees',
                'jnl-option-action', 'jnl-option-type', 'jnl-strike', 'jnl-expiry',
                'jnl-broker-account'
            ];
            var core = {};
            _coreIds.forEach(function(id) {
                var el = document.getElementById(id);
                if (el) core[id] = el.value;
            });
            var snap = {
                content:    notesEl ? notesEl.innerHTML : '', // legacy notes field (back-compat)
                notes:      notesEl ? notesEl.innerHTML : '',
                quickNotes: quickEl ? quickEl.value : '',
                grade:      gradeEl ? gradeEl.value : '',
                setup:      setupEl ? setupEl.value : '',
                tags:       tags,
                rules:      rules,
                core:       core,
                targets:    (typeof _getRowData === 'function')
                    ? _getRowData('jnl-plan-rows', 'target-price', 'target-qty') : [],
                stops:      (typeof _getRowData === 'function')
                    ? _getRowData('jnl-plan-rows', 'stop-price', 'stop-qty') : []
            };
            Autosave.save(_jnlDraftKey(tradeId), snap);
        } catch (e) { /* DOM read errors — ignore */ }
    }
    function _jnlLoadDraft(tradeId) {
        return tradeId ? Autosave.load(_jnlDraftKey(tradeId)) : null;
    }
    function _jnlClearDraft(tradeId) {
        if (tradeId) Autosave.clear(_jnlDraftKey(tradeId));
    }

    // ── Real record autosave (Phase 1) ───────────────────────────────────────
    // The draft layer above protects against crashes; this layer persists edits
    // into the actual trade record at sensible commit moments so users don't
    // need to click Save Journal Entry for routine edits.
    var _jnlCommitTimer = null;
    var _jnlCommitDebounceMs = 1000;
    // True only after a real edit (typing, a changed value, a grade pill,
    // a template/AI insert). Viewing, clicking into a field, blur, tab hide
    // and Back to Trades never save on their own.
    var _jnlDirty = false;
    // True only after a fill row value was edited or a filled row removed;
    // only then does a save rewrite trade.fills and the totals from the rows.
    var _jnlFillsDirty = false;
    // Rows are shown for a closed manual trade that has no saved fills yet
    // ("Use Multiple Fills" after Unlock Fields). Nothing is saved until a
    // row is edited; the first saved row edit makes them the trade's fills.
    var _jnlFillsConverting = false;
    // A split is saving; autosave waits so it can't overwrite the split.
    var _jnlSplitting = false;
    // Input values as loaded from the trade. Execution fields are written
    // back only when their input differs, so stored times keep their
    // seconds and a reflection-only save leaves P&L untouched.
    var _jnlLoaded = {};
    var _JNL_EXEC_IDS = ['jnl-quantity', 'jnl-entry-price', 'jnl-exit-price',
                         'jnl-entry-time', 'jnl-exit-time', 'jnl-commission-fees'];
    var _JNL_PNL_IDS  = _JNL_EXEC_IDS.concat(['jnl-trade-type', 'jnl-asset-type']);

    function _jnlFmtLocal(iso) {
        if (!iso) return '';
        var d = new Date(iso);
        if (isNaN(d)) return '';
        var p = function(n) { return String(n).padStart(2, '0'); };
        return d.getFullYear() + '-' + p(d.getMonth()+1) + '-' + p(d.getDate()) + 'T' + p(d.getHours()) + ':' + p(d.getMinutes());
    }

    function _jnlReadExecInputs() {
        var vals = {};
        _JNL_PNL_IDS.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) vals[id] = el.value;
        });
        return vals;
    }

    function _jnlChanged(id) {
        var el = document.getElementById(id);
        return !!el && el.value !== _jnlLoaded[id];
    }

    // Inline message under Save Reflection when an open trade has only one
    // exit field filled (same pattern as New Trade's fill-row error).
    // missingId ('jnl-exit-time' or 'jnl-exit-price') also shows the app's
    // field bubble above that field (below it would cover the Trade Grade
    // label), since autosave means Save may never be clicked.
    function _jnlShowOpenHint(show, missingId) {
        var hint = document.getElementById('jnl-open-hint');
        if (hint) {
            hint.textContent = show ? 'Enter both exit price and exit time to close this trade.' : '';
            hint.style.display = show ? '' : 'none';
        }
        _clearFieldBubble(['jnl-exit-time', 'jnl-exit-price']);
        if (!show || !missingId) return;
        var field = document.getElementById(missingId);
        var group = field && (field.closest ? field.closest('.form-group') : field.parentNode);
        if (!group) return;
        _showFieldBubble(field,
            (missingId === 'jnl-exit-time' ? 'Exit Time' : 'Exit Price') + ' is required to close this trade',
            { host: group, above: true });
    }

    // Imported Webull trades: fills and execution fields come from Webull.
    function _jnlIsWebull(trade) {
        return !!trade && (trade.source === 'webull' || !!trade.externalId);
    }

    // Fill rows are editable for a closed, non-Webull trade with fills.
    function _jnlFillsEditable(trade) {
        return !!trade && Array.isArray(trade.fills) && trade.fills.length >= 1
            && !_jnlIsWebull(trade)
            && !(typeof window._isOpenTrade === 'function' && window._isOpenTrade(trade));
    }

    // A closed, non-Webull trade without fills can be converted to fill rows.
    function _jnlCanConvertToFills(trade) {
        return !!trade && !(Array.isArray(trade.fills) && trade.fills.length >= 1)
            && !_jnlIsWebull(trade)
            && !(typeof window._isOpenTrade === 'function' && window._isOpenTrade(trade));
    }

    // The fill rows on screen are edited and saved: saved fills, or a
    // conversion in progress.
    function _jnlRowsEditable(trade) {
        return _jnlFillsEditable(trade) || (_jnlFillsConverting && _jnlCanConvertToFills(trade));
    }

    // Cloud-loaded rows carry direction, not type.
    function _jnlSideLabel(t) {
        var dir = t.type || t.direction;
        return dir ? (dir === 'short' ? 'Short' : 'Long') : '—';
    }

    // Same format as the dashboard P&L column; open trades show a dash.
    function _jnlFmtPnl(t) {
        if (typeof window._isOpenTrade === 'function' && window._isOpenTrade(t)) return '—';
        var pnl = t.pnl || 0;
        return (pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toFixed(2);
    }

    function _jnlRenderEditorHeader(trade) {
        if (!trade) return;
        var entryDate = trade.entryTime ? new Date(trade.entryTime).toLocaleDateString() : '';
        var pnl = trade.pnl || 0;
        var pnlStr = trade.pnl == null ? 'Open' : (pnl >= 0 ? '+' : '-') + '$' + Math.abs(pnl).toFixed(2) + ' P&L';
        var side = _jnlSideLabel(trade);
        var titleEl = document.getElementById('journal-editor-title');
        var subEl   = document.getElementById('journal-editor-subtitle');
        if (titleEl) titleEl.textContent = (trade.symbol || 'Trade') + ' — ' + entryDate;
        if (subEl)   subEl.textContent   = side + ' · ' + pnlStr;
    }

    // Shared persist path — writes current DOM state into the trade record,
    // recomputes metrics/P&L, stamps notesUpdatedAt, clears the draft backup
    // (record is now authoritative). opts.explicit=true means the user clicked
    // Save Journal Entry (ends the journaling session + refreshes list/dashboard).
    async function _jnlCommitTrade(opts) {
        opts = opts || {};
        if (!window._jnlSelectedTradeId) return false;
        var trade = journalData.trades.find(function(t) { return t.id === window._jnlSelectedTradeId; });
        if (!trade) { _jnlTradeMissing(); return false; }
        // A split is saving this trade; the edits stay dirty for the next save.
        if (_jnlSplitting) return false;
        // Fill rows: a partly filled row would be skipped, so stop before
        // anything changes. Explicit saves name the row; autosave just waits.
        var _fillsEdited = _jnlFillsDirty && !!document.getElementById('jnl-fills-rows') && _jnlRowsEditable(trade);
        if (_fillsEdited) {
            var _badFill = _ntFindIncompleteFillRow(_jnlSerializeFillRows());
            if (_badFill) {
                if (opts.explicit) _jnlShowFillError(_badFill);
                return false;
            }
        }
        // Webull trades keep their execution fields, side and asset type as
        // imported. A trade with saved fills takes its totals only from the
        // fill rows, so the summary inputs are never written unless the rows
        // were edited (finalizeTradeSummary below then rewrites them).
        var _isWebull = _jnlIsWebull(trade);
        var _hasFills = Array.isArray(trade.fills) && trade.fills.length >= 1;
        var _execLocked = _isWebull || (_hasFills && !_fillsEdited);
        var _lockedIds = !_execLocked ? []
            : _isWebull ? _JNL_EXEC_IDS.concat(['jnl-trade-type', 'jnl-asset-type'])
            : _JNL_EXEC_IDS;
        var _chg = function(id) {
            return _lockedIds.indexOf(id) < 0 && _jnlChanged(id);
        };
        // Put back if the cloud save fails; the form and draft keep the edits.
        var _tradeBefore = JSON.parse(JSON.stringify(trade));
        // After a successful save these inputs become the new baseline.
        var _committedInputs = _jnlReadExecInputs();

        // Core trade fields
        trade.brokerAccountId = document.getElementById('jnl-broker-account').value || trade.brokerAccountId || '';
        // Webull: the stored side and asset type, whatever the dropdowns or a
        // draft say (same fallbacks the dropdowns load with).
        trade.assetType       = _isWebull ? (trade.assetType || 'stock') : document.getElementById('jnl-asset-type').value;
        trade.symbol          = document.getElementById('jnl-symbol').value.toUpperCase();
        trade.type            = _isWebull ? (trade.type || trade.direction || 'long') : document.getElementById('jnl-trade-type').value;

        // Execution fields: write only what the user changed.
        var pnlInputsChanged = _JNL_PNL_IDS.some(_chg);
        var timesChanged     = _chg('jnl-entry-time') || _chg('jnl-exit-time');
        if (_chg('jnl-quantity'))    trade.quantity   = parseFloat(document.getElementById('jnl-quantity').value)    || trade.quantity;
        if (_chg('jnl-entry-price')) trade.entryPrice = parseFloat(document.getElementById('jnl-entry-price').value) || trade.entryPrice;
        if (_chg('jnl-commission-fees')) {
            trade.commissionFees = parseFloat(document.getElementById('jnl-commission-fees').value) || 0;
            // User is editing fees via the journal page — mark as manual.
            if (trade.commissionFees > 0) trade.feeSource = 'manual';
        }
        var entryTimeVal = document.getElementById('jnl-entry-time').value;
        var exitTimeVal  = document.getElementById('jnl-exit-time').value;
        var exitPriceVal = document.getElementById('jnl-exit-price').value;
        if (entryTimeVal && _chg('jnl-entry-time')) trade.entryTime = new Date(entryTimeVal).toISOString();

        // An open trade closes only when both exit fields are filled in; a
        // blank exit price never becomes 0, and the stored exit time is left
        // alone until the trade is closed.
        var wasOpen  = trade.exitPrice == null || !trade.exitTime;
        var closing  = !_execLocked && wasOpen && exitPriceVal !== '' && isFinite(parseFloat(exitPriceVal)) && exitTimeVal !== '';
        var stayOpen = wasOpen && !closing;
        if (closing) {
            trade.exitPrice = parseFloat(exitPriceVal);
            trade.exitTime  = new Date(exitTimeVal).toISOString();
        } else if (!wasOpen) {
            if (_chg('jnl-exit-price')) trade.exitPrice = parseFloat(exitPriceVal) || trade.exitPrice;
            if (exitTimeVal && _chg('jnl-exit-time')) trade.exitTime = new Date(exitTimeVal).toISOString();
        }
        _jnlShowOpenHint(stayOpen && (exitPriceVal !== '' || exitTimeVal !== ''),
            exitTimeVal === '' ? 'jnl-exit-time' : 'jnl-exit-price');
        if (!stayOpen && (closing || timesChanged)) {
            trade.holdSeconds = (new Date(trade.exitTime) - new Date(trade.entryTime)) / 1000;
        }

        trade.setupType      = document.getElementById('jnl-setup-type').value;

        if (trade.assetType === 'option') {
            trade.optionAction = document.getElementById('jnl-option-action').value;
            trade.optionType   = document.getElementById('jnl-option-type').value;
            trade.strike       = parseFloat(document.getElementById('jnl-strike').value) || 0;
            trade.expiry       = document.getElementById('jnl-expiry').value || null;
        } else {
            trade.optionAction = null; trade.optionType = null;
            trade.strike = 0;          trade.expiry = null;
        }

        // P&L is recomputed only for a closed trade whose execution inputs
        // changed (or that is being closed now); an open trade keeps pnl null.
        if (!stayOpen && (closing || pnlInputsChanged)) {
            var jnlMult = _contractMultiplier(trade.assetType);
            var grossPnl = trade.type === 'long'
                ? (trade.exitPrice - trade.entryPrice) * trade.quantity * jnlMult
                : (trade.entryPrice - trade.exitPrice) * trade.quantity * jnlMult;
            trade.grossPnl = grossPnl;
            trade.pnl = grossPnl - (trade.commissionFees || 0);
        }

        // Edited fill rows are the source of the execution totals.
        if (_fillsEdited) {
            var _editedFills = _fillsFromRawRows(_jnlSerializeFillRows(), trade.type, trade.assetType);
            if (_editedFills.length > 0) {
                trade.fills = _editedFills;
                finalizeTradeSummary(trade);
            }
        }

        var profitTargets = _getRowData('jnl-plan-rows', 'target-price', 'target-qty');
        var stopLosses    = _getRowData('jnl-stop-loss-rows',     'stop-price',   'stop-qty');
        trade.profitTargets = profitTargets;
        trade.stopLosses    = stopLosses;

        if (!stayOpen) {
            var m = _computeTradeMetrics(trade.entryPrice, trade.exitPrice, trade.quantity, trade.type, trade.commissionFees, profitTargets, stopLosses, trade.assetType);
            trade.drawdown          = m.drawdown;
            trade.runup             = m.runup;
            trade.initialTarget     = m.initialTarget;
            trade.tradeRisk         = m.tradeRisk;
            trade.plannedRMultiple  = m.plannedRMultiple;
            trade.realizedRMultiple = m.realizedRMultiple;
        }

        if (_jnlSelectedStrategy && !stayOpen) {
            trade.strategyScore = calculateStrategyScore(_jnlSelectedStrategy, _jnlFollowedRules, trade.pnl);
        }

        trade.tradeGrade = document.getElementById('jnl-trade-grade').value;
        trade.tags       = _jnlGetTagsFromRows();
        trade.notes      = _jnlGetNotes();
        trade.quickNotes = document.getElementById('jnl-quick-notes').value;

        // Only explicit Save Journal Entry ends the journaling session
        // (clearing sessionHeaderDate). Autosave preserves session continuity
        // so the same-session date header logic keeps working mid-edit.
        if (opts.explicit) trade.sessionHeaderDate = '';
        trade.notesUpdatedAt = Date.now();
        // Money to cents, prices to 4 decimals; a failed save restores _tradeBefore.
        if (typeof _roundTradeForSave === 'function') _roundTradeForSave(trade);

        // Batch 2: a re-sync replaced this trade while the form was open.
        // The newer version stays; these edits are kept as a conflict copy.
        if (typeof _editorGuardStale === 'function' && _editorGuardStale(_JNL_GUARD, trade.id) === true) {
            var _mine = JSON.parse(JSON.stringify(trade));
            _restoreTradeInPlace(trade, _tradeBefore);
            _jnlRenderEditorHeader(trade);
            _jnlDirty = false;
            _jnlFillsDirty = false;
            _jnlClearDraft(trade.id);
            _editorGuardConflict(_JNL_GUARD, _mine);
            _jnlReloadSoon(trade.id);
            return false;
        }

        _jnlRenderEditorHeader(trade);
        Autosave.showStatus(_JNL_STATUS_ID, 'saving');
        // Edits typed while this save is in flight mark the form dirty again.
        _jnlDirty = false;
        if (_fillsEdited) _jnlFillsDirty = false;
        try {
            // Cloud-primary: upsert trade to Supabase (notes, reflection, field edits)
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                var _jcsRes = await _saveTradeToSupabase(trade);
                if (!_jcsRes.success) {
                    _restoreTradeInPlace(trade, _tradeBefore);
                    _jnlRenderEditorHeader(trade);
                    throw new Error(_jcsRes.error);
                }
                if (typeof _triggerCloudDashRefresh === 'function') _triggerCloudDashRefresh();
            }
            await saveToIndexedDB();
        } catch (e) {
            if (window._jnlSelectedTradeId === trade.id) {
                _jnlDirty = true;
                if (_fillsEdited) _jnlFillsDirty = true;
            }
            Autosave.showStatus(_JNL_STATUS_ID, 'failed');
            return false;
        }
        if (window._jnlSelectedTradeId === trade.id) _jnlLoaded = _committedInputs;
        // Converted rows are now the trade's saved fills: no more undo.
        if (_jnlFillsConverting && window._jnlSelectedTradeId === trade.id
            && Array.isArray(trade.fills) && trade.fills.length >= 1) {
            _jnlFillsConverting = false;
            var _singleBtn = document.getElementById('jnl-fills-single-btn');
            if (_singleBtn) _singleBtn.remove();
        }
        // Keep draft alive after background autosave so a page reload can
        // restore the form (including option-type, asset-type, etc.).
        // Only clear on explicit save (Save Journal Entry) which ends the
        // editing session and returns to the list view.
        if (opts.explicit) _jnlClearDraft(trade.id);
        Autosave.showStatus(_JNL_STATUS_ID, 'saved');
        // Now closed in storage: show the realized metrics.
        if (closing && window._jnlSelectedTradeId === trade.id) _jnlRecalcMetrics();

        if (opts.explicit) {
            renderJournalTradeList();
            updateDashboard();
        }
        return true;
    }

    // ── Batch 2: re-sync guard ────────────────────────────────────────────────
    // The open trade is registered with auth.js. Trades have no rev, so a
    // re-sync compares the trade's data. A clean form reloads; a save while
    // stale keeps these edits as a conflict copy (see _jnlCommitTrade).
    var _JNL_GUARD = 'trade-reflection';
    var _JNL_GONE_MSG = 'This trade was deleted on another device, so changes made here can’t be saved.';

    function _jnlReloadSoon(tradeId) {
        if (_jnlCommitTimer) { clearTimeout(_jnlCommitTimer); _jnlCommitTimer = null; }
        setTimeout(function() {
            if (window._jnlSelectedTradeId === tradeId) selectTradeForJournal(tradeId);
        }, 0);
    }

    // The trade is gone from journalData: say so instead of failing silently.
    function _jnlTradeMissing() {
        Autosave.showStatus(_JNL_STATUS_ID, 'failed');
        // Own notice id, so closing the editor does not hide it.
        if (typeof _showEditorNotice === 'function') _showEditorNotice('trade-reflection-gone', _JNL_GONE_MSG, false, true);
    }

    function _jnlGuardOpen(tradeId) {
        if (typeof _editorGuardOpen !== 'function') return;
        _editorGuardOpen(_JNL_GUARD, 'trades', tradeId, {
            isDirty: function() { return _jnlDirty || _jnlFillsDirty; },
            reload: function() {
                _jnlClearDraft(tradeId);
                if (window._jnlSelectedTradeId === tradeId) selectTradeForJournal(tradeId);
            },
            // Reload bar: the stale save path keeps the copy and reloads. If
            // that save could not run (an incomplete fill row), the draft is
            // kept as the copy instead.
            resolve: function() {
                Promise.resolve(_jnlCommitTrade()).then(function() {
                    if (_editorGuardStale(_JNL_GUARD, tradeId) !== true) return;
                    _editorGuardConflict(_JNL_GUARD, _jnlLoadDraft(tradeId));
                    _jnlClearDraft(tradeId);
                    _jnlDirty = false;
                    _jnlFillsDirty = false;
                    _jnlReloadSoon(tradeId);
                });
            },
            goneMessage: _JNL_GONE_MSG
        });
    }

    var _JNL_STATUS_ID = 'jnl-autosave-status';
    function _jnlScheduleCommit() {
        if (!window._jnlSelectedTradeId) return;
        _jnlDirty = true;
        Autosave.showStatus(_JNL_STATUS_ID, 'unsaved');
        clearTimeout(_jnlCommitTimer);
        _jnlCommitTimer = setTimeout(function() {
            _jnlCommitTimer = null;
            _jnlCommitTrade();
        }, _jnlCommitDebounceMs);
    }

    function _jnlFlushCommit() {
        if (_jnlCommitTimer) {
            clearTimeout(_jnlCommitTimer);
            _jnlCommitTimer = null;
        }
        if (!window._jnlSelectedTradeId) return;
        if (!_jnlDirty) return true;   // nothing edited: viewing never saves
        return _jnlCommitTrade();
    }

    // ── Clean Up with AI ──────────────────────────────────────────────────────
    // Bumped on every open, reopen (including a re-sync reload) and close, so
    // a cleanup that finishes afterwards is never written into another load.
    var _jnlLoadGen = 0;
    var _jnlCleanupBusy = false;

    function _jnlCleanupMsg(text, isError) {
        var el = document.getElementById('jnl-cleanup-msg');
        if (!el) return;
        el.textContent = text;
        el.style.color = isError ? 'var(--danger)' : 'var(--text-secondary)';
    }

    // Appends below the reflection; the original text is never replaced.
    // Saved through the same draft + commit path as typing in the notes.
    function jnlCleanUpAI() {
        if (_jnlCleanupBusy || typeof _noteCleanup !== 'function') return;
        var tid = window._jnlSelectedTradeId;
        var ed = document.getElementById('jnl-notes');
        if (!tid || !ed) return;
        var gen = _jnlLoadGen;
        var acct = typeof _noteCleanupAccount === 'function' ? _noteCleanupAccount() : null;
        var sel = document.getElementById('jnl-cleanup-format');
        var btn = document.getElementById('jnl-cleanup-btn');
        _jnlCleanupBusy = true;
        if (btn) btn.disabled = true;
        _jnlCleanupMsg('Cleaning up…');
        return _noteCleanup('trade', ed, sel && sel.value === 'paragraphs' ? 'paragraphs' : 'bullets').then(function(res) {
            _jnlCleanupBusy = false;
            if (btn) btn.disabled = false;
            if (!res.ok) { _jnlCleanupMsg(res.message, true); return; }
            // The user moved on during the call: never write into another trade.
            var acctNow = typeof _noteCleanupAccount === 'function' ? _noteCleanupAccount() : null;
            if (window._jnlSelectedTradeId !== tid || _jnlLoadGen !== gen || acctNow !== acct) {
                _jnlCleanupMsg('Cleanup discarded because the trade changed. Try again.', true);
                return;
            }
            ed.insertAdjacentHTML('beforeend', res.block);
            _jnlSaveDraft(tid);
            _jnlScheduleCommit();
            return Promise.resolve(_jnlFlushCommit()).then(function(ok) {
                if (ok === false) {
                    _jnlCleanupMsg('Cleaned-up version added below, but it could not be saved yet.', true);
                    return;
                }
                _jnlCleanupMsg('Cleaned-up version added below your reflection.' + (res.note ? ' ' + res.note : ''));
            });
        });
    }

    // Window-level triggers: flush on tab hide and navigation (best-effort).
    if (!window._jnlAutosaveBound) {
        window._jnlAutosaveBound = true;
        document.addEventListener('visibilitychange', function() {
            if (document.visibilityState === 'hidden') _jnlFlushCommit();
        });
        window.addEventListener('pagehide', _jnlFlushCommit);
        window.addEventListener('beforeunload', _jnlFlushCommit);
    }

    // ── Option fields toggle ──────────────────────────────────────────────────

    function _jnlToggleOptionFields() {
        const val = (document.getElementById('jnl-asset-type') || {}).value;
        const row = document.getElementById('jnl-option-fields-row');
        if (row) row.style.display = val === 'option' ? '' : 'none';
    }

    // ── Page init / filter ────────────────────────────────────────────────────

    function initJournalPage() {
        // Populate filter dropdowns
        const strategySel = document.getElementById('jnl-filter-strategy');
        DenariiFilters.populateStrategy(strategySel, journalData.trades, journalData.strategies);
        renderJournalTradeList();
    }

    function clearJournalFilters() {
        ['jnl-filter-from','jnl-filter-to','jnl-filter-symbol'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = '';
        });
        ['jnl-filter-period','jnl-filter-style','jnl-filter-asset-type','jnl-filter-strategy'].forEach(id => {
            const el = document.getElementById(id); if (el) el.value = 'all';
        });
        _jnlListPage = 1;
        renderJournalTradeList();
    }

    // ── Trade list ────────────────────────────────────────────────────────────

    function renderJournalTradeList() {
        const filterState = DenariiFilters.readState('jnl-filter');
        filterState.symbol = filterState.symbol.trim();

        const jnlSort = window._jnlSortField || 'exitTime';
        const jnlDir = window._jnlSortDir || 'desc';
        const accountMap = {};
        (journalData.brokerAccounts || []).forEach(a => { accountMap[a.id] = a.displayName; });
        // Apply global account filter (top-right header selector)
        var _globalFiltered = typeof getGlobalFilteredTrades === 'function'
            ? getGlobalFilteredTrades((journalData.trades || []).slice())
            : (journalData.trades || []).slice();
        let trades = [..._globalFiltered].sort((a, b) => {
            let va, vb;
            switch(jnlSort) {
                case 'symbol':     va = (a.symbol||''); vb = (b.symbol||''); return jnlDir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                case 'assetType':  va = (a.assetType||'stock'); vb = (b.assetType||'stock'); return jnlDir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                case 'type':       va = (a.type||a.direction||''); vb = (b.type||b.direction||''); return jnlDir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                case 'account':    va = (accountMap[a.brokerAccountId]||''); vb = (accountMap[b.brokerAccountId]||''); return jnlDir==='asc' ? va.localeCompare(vb) : vb.localeCompare(va);
                case 'pnl':        va = a.pnl||0; vb = b.pnl||0; break;
                case 'quantity':   va = a.quantity||0; vb = b.quantity||0; break;
                case 'entryTime':  va = new Date(a.entryTime); vb = new Date(b.entryTime); break;
                case 'exitTime':   va = new Date(a.exitTime);  vb = new Date(b.exitTime);  break;
                case 'entryPrice': va = a.entryPrice||0; vb = b.entryPrice||0; break;
                case 'exitPrice':  va = a.exitPrice||0; vb = b.exitPrice||0; break;
                default:           va = new Date(a.exitTime);  vb = new Date(b.exitTime);
            }
            return jnlDir === 'asc' ? va - vb : vb - va;
        });

        trades = DenariiFilters.filterTrades(trades, filterState, journalData.brokerAccounts, new Date());

        const tbody = document.getElementById('journal-trade-list-body');
        if (!tbody) return;

        if (!trades.length) {
            _jnlListPage = 1;
            tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;padding:28px;color:var(--text-secondary);font-size:13px;">No trades found. Try adjusting your filters.</td></tr>';
            return;
        }

        // Pagination
        var totalPages = Math.max(1, Math.ceil(trades.length / _jnlListPageSize));
        if (_jnlListPage > totalPages) _jnlListPage = totalPages;
        if (_jnlListPage < 1) _jnlListPage = 1;
        var startIdx = (_jnlListPage - 1) * _jnlListPageSize;
        var pageItems = trades.slice(startIdx, startIdx + _jnlListPageSize);

        // Update thead with sort indicators
        const thead = tbody.closest('table')?.querySelector('thead tr');
        if (thead) {
            const cols = [
                { field: 'exitTime', label: 'Date' },
                { field: 'symbol', label: 'Symbol' },
                { field: 'assetType', label: 'Type' },
                { field: 'type', label: 'Side' },
                { field: 'quantity', label: 'Qty' },
                { field: 'entryPrice', label: 'Entry' },
                { field: 'exitPrice', label: 'Exit' },
                { field: 'pnl', label: 'P&L' },
                { field: 'account', label: 'Account' },
                { field: null, label: '' }
            ];
            thead.innerHTML = cols.map(c => {
                const sortable = !!c.field;
                const active = sortable && jnlSort === c.field;
                const arrow = active ? (jnlDir === 'asc' ? ' ↑' : ' ↓') : '';
                const click = sortable ? ` onclick="window._jnlSortField='${c.field}';window._jnlSortDir=window._jnlSortField==='${c.field}'&&(window._jnlSortDir||'desc')==='desc'?'asc':'desc';_jnlListResetPage();renderJournalTradeList()" style="cursor:pointer;padding:8px 10px;font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;text-align:left;user-select:none;"` : ` style="padding:8px 10px;font-size:11px;font-weight:600;color:var(--text-secondary);text-transform:uppercase;letter-spacing:0.05em;text-align:left;"`;
                return `<th${click}>${c.label}${arrow}</th>`;
            }).join('');
        }

        tbody.innerHTML = pageItems.map(t => {
            const date     = new Date(t.exitTime || t.entryTime).toLocaleDateString();
            const pnl      = t.pnl || 0;
            const isOpen   = typeof window._isOpenTrade === 'function' && window._isOpenTrade(t);
            const pnlColor = isOpen ? 'var(--text-secondary)' : (pnl >= 0 ? 'var(--success)' : 'var(--danger)');
            const pnlStr   = _jnlFmtPnl(t);
            const exitStr  = isOpen ? '<span style="color:var(--primary);font-weight:600;">Open</span>' : '$' + Number(t.exitPrice || 0).toFixed(2);
            const account  = accountMap[t.brokerAccountId] || '—';
            const assetLbl = (t.assetType || 'stock').charAt(0).toUpperCase() + (t.assetType || 'stock').slice(1);
            const hasJournal = !!(t.entryReason || t.exitReason || t.lessons || t.tradeGrade || (t.tags && t.tags.length));
            const badge    = hasJournal
                ? `<span style="font-size:10px;padding:1px 5px;border-radius:4px;background:rgba(56,191,161,0.15);color:var(--success);margin-left:5px;vertical-align:middle;">✓</span>`
                : '';
            const isSelected = t.id === window._jnlSelectedTradeId;
            const safeId = typeof t.id === 'number' ? t.id : "'" + escapeHtml(String(t.id)) + "'";
            return `<tr data-id="${escapeHtml(String(t.id))}" style="border-bottom:1px solid var(--border);cursor:pointer;${isSelected ? 'background:var(--bg-secondary);' : ''}"
                onmouseenter="if(this.dataset.id!==String(window._jnlSelectedTradeId))this.style.background='rgba(255,255,255,0.03)'"
                onmouseleave="if(this.dataset.id!==String(window._jnlSelectedTradeId))this.style.background=''">
                <td style="padding:9px 10px;font-size:13px;">${date}</td>
                <td style="padding:9px 10px;font-weight:600;">${escapeHtml(t.symbol || '')}${badge}</td>
                <td style="padding:9px 10px;">${assetLbl}</td>
                <td style="padding:9px 10px;">${_jnlSideLabel(t)}</td>
                <td style="padding:9px 10px;">${t.quantity ?? '—'}</td>
                <td style="padding:9px 10px;">$${Number(t.entryPrice || 0).toFixed(2)}</td>
                <td style="padding:9px 10px;">${exitStr}</td>
                <td style="padding:9px 10px;font-weight:600;color:${pnlColor};">${pnlStr}</td>
                <td style="padding:9px 10px;font-size:12px;color:var(--text-secondary);">${escapeHtml(account)}</td>
                <td style="padding:9px 10px;">
                    <button type="button" class="btn btn-primary btn-small"
                        onclick="event.stopPropagation();selectTradeForJournal(${safeId})">Reflect</button>
                </td>
            </tr>`;
        }).join('');

        // Pagination controls
        if (totalPages > 1) {
            var prevDis = _jnlListPage <= 1;
            var nextDis = _jnlListPage >= totalPages;
            var pagRow = document.createElement('tr');
            pagRow.innerHTML = '<td colspan="10">' +
                '<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 0;font-size:13px;color:var(--text-secondary);">' +
                '<button onclick="_jnlListPrevPage()"' + (prevDis ? ' disabled' : '') + ' style="padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:' + (prevDis ? 'default' : 'pointer') + ';opacity:' + (prevDis ? '0.4' : '1') + ';">Previous</button>' +
                '<span>Page ' + _jnlListPage + ' of ' + totalPages + ' \u00B7 ' + trades.length + ' trades</span>' +
                '<button onclick="_jnlListNextPage()"' + (nextDis ? ' disabled' : '') + ' style="padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:' + (nextDis ? 'default' : 'pointer') + ';opacity:' + (nextDis ? '0.4' : '1') + ';">Next</button>' +
                '</div></td>';
            tbody.appendChild(pagRow);
        }

        tbody.querySelectorAll('tr[data-id]').forEach(row => {
            row.addEventListener('click', () => {
                var rid = row.dataset.id;
                var parsed = Number(rid);
                selectTradeForJournal(isNaN(parsed) ? rid : parsed);
            });
        });

    }

    // ── Journal editor ────────────────────────────────────────────────────────

    function jnlRequestUnlock() {
        var trade = journalData.trades.find(function(t) { return t.id === window._jnlSelectedTradeId; });
        var isWebull = _jnlIsWebull(trade);
        // A Webull trade unlocks no core fields, so the P&L warning doesn't apply.
        if (!isWebull && !confirm(
            'Unlock execution fields for editing?\n\n' +
            'This allows changes to price, size, time, and other trade details. ' +
            'Changing core fields will recalculate P&L and metrics.\n\nProceed?'
        )) return;
        document.querySelectorAll('.jnl-locked-field').forEach(function(el) { el.disabled = false; });
        // Totals of a trade with fill rows come from those rows; a Webull
        // trade's execution fields, side and asset type come from Webull.
        // Both stay locked.
        var hasFills = !!trade && Array.isArray(trade.fills) && trade.fills.length >= 1;
        if (trade && (isWebull || hasFills || document.getElementById('jnl-fills-rows'))) {
            _JNL_EXEC_IDS.concat(isWebull ? ['jnl-trade-type', 'jnl-asset-type'] : []).forEach(function(id) {
                var el = document.getElementById(id);
                if (el) el.disabled = true;
            });
        }
        var btn = document.getElementById('jnl-unlock-btn');
        if (btn) { btn.textContent = '🔓 Unlocked'; btn.disabled = true; }
        var hint = document.getElementById('jnl-lock-hint');
        if (hint) hint.style.display = 'none';
        // A closed manual trade without fills: show "Use Multiple Fills".
        if (_jnlCanConvertToFills(trade)) _jnlRenderFillsSection(trade);
    }

    function selectTradeForJournal(tradeId) {
        // Ids can arrive as a number or a string (inline onclick, data-id).
        const trade = journalData.trades.find(t => String(t.id) === String(tradeId));
        if (!trade) { console.warn('[Reflection] Trade not found:', tradeId); return; }
        tradeId = trade.id;
        window._jnlSelectedTradeId = tradeId;
        _jnlLoadGen++;
        _jnlCleanupMsg('');
        _jnlFillsDirty = false;
        _jnlFillsConverting = false;

        // Re-lock all locked fields on each trade open
        document.querySelectorAll('.jnl-locked-field').forEach(function(el) { el.disabled = true; });
        var unlockBtn = document.getElementById('jnl-unlock-btn');
        if (unlockBtn) { unlockBtn.textContent = '🔒 Unlock Fields'; unlockBtn.disabled = false; }

        // Update editor header
        const entryDate = new Date(trade.entryTime).toLocaleDateString();
        const _isOpen = typeof window._isOpenTrade === 'function' && window._isOpenTrade(trade);
        const pnlStr = _isOpen ? 'Open' : ((trade.pnl >= 0 ? '+' : '-') + '$' + Math.abs(trade.pnl || 0).toFixed(2) + ' P&L');
        const side = _jnlSideLabel(trade);
        document.getElementById('journal-editor-title').textContent = `${trade.symbol || 'Trade'} — ${entryDate}`;
        document.getElementById('journal-editor-subtitle').textContent = `${side} · ${pnlStr}`;

        // Broker account dropdown
        const brokerSel = document.getElementById('jnl-broker-account');
        if (brokerSel) {
            brokerSel.innerHTML = '<option value="">No account</option>' +
                (journalData.brokerAccounts || []).map(a =>
                    `<option value="${a.id}" ${a.id === trade.brokerAccountId ? 'selected' : ''}>${escapeHtml(a.displayName)}</option>`
                ).join('');
        }

        // Core fields
        document.getElementById('jnl-asset-type').value   = trade.assetType || 'stock';
        document.getElementById('jnl-symbol').value       = trade.symbol || '';
        document.getElementById('jnl-trade-type').value   = trade.type || trade.direction || 'long';
        document.getElementById('jnl-quantity').value     = trade.quantity ?? '';
        document.getElementById('jnl-entry-price').value  = trade.entryPrice ?? '';
        document.getElementById('jnl-exit-price').value   = trade.exitPrice ?? '';

        document.getElementById('jnl-entry-time').value      = _jnlFmtLocal(trade.entryTime);
        // An open trade shows Exit Time blank, even if a default was stored;
        // closing it takes both exit fields entered on purpose.
        const _openForExit = trade.exitPrice == null || !trade.exitTime;
        document.getElementById('jnl-exit-time').value       = _openForExit ? '' : _jnlFmtLocal(trade.exitTime);
        document.getElementById('jnl-commission-fees').value = trade.commissionFees ?? '';
        _jnlLoaded = _jnlReadExecInputs();
        _jnlShowOpenHint(false);

        // Strategy dropdown — show favorites + current trade's strategy if hidden
        const setupSel = document.getElementById('jnl-setup-type');
        if (setupSel) {
            const _favStrats = (journalData.strategies || []).filter(s => s.isFavorite !== false);
            const _tradeSetup = trade.setupType || '';
            const _hasCurrent = !_tradeSetup || _favStrats.some(s => s.name === _tradeSetup);
            const _names = _favStrats.map(s => s.name);
            if (!_hasCurrent) _names.push(_tradeSetup);
            _names.sort(DenariiFilters.compareStrategyNames);
            const _opts = '<option value="">Select strategy...</option>' +
                _names.map(name =>
                    `<option value="${escapeHtml(name)}" ${name === _tradeSetup ? 'selected' : ''}>${escapeHtml(name)}${!_hasCurrent && name === _tradeSetup ? ' (hidden)' : ''}</option>`
                ).join('');
            setupSel.innerHTML = _opts;
        }

        // Option fields
        _jnlToggleOptionFields();
        if (trade.assetType === 'option') {
            document.getElementById('jnl-option-action').value = trade.optionAction || 'buy';
            document.getElementById('jnl-option-type').value   = trade.optionType || 'CALL';
            document.getElementById('jnl-strike').value        = trade.strike ?? '';
            document.getElementById('jnl-expiry').value        = trade.expiry || '';
        }

        // Planning rows (combined target + stop)
        _rehydratePlanRows('jnl-plan-rows', trade.profitTargets, trade.stopLosses);

        // Quick Notes
        document.getElementById('jnl-quick-notes').value = trade.quickNotes || '';

        // Journal fields
        _jnlSetGrade(trade.tradeGrade || '');
        _jnlInitTagRows(trade.tags);
        // Load notes — fall back to legacy fields if notes is empty but entry/exit/lessons exist
        var notesContent = trade.notes || '';
        if (!notesContent && (trade.entryReason || trade.exitReason || trade.lessons)) {
            var parts = [];
            if (trade.entryReason) parts.push('<p><strong>Entry:</strong> ' + trade.entryReason + '</p>');
            if (trade.exitReason)  parts.push('<p><strong>Exit:</strong> ' + trade.exitReason + '</p>');
            if (trade.lessons)     parts.push('<p><strong>Lesson:</strong> ' + trade.lessons + '</p>');
            notesContent = parts.join('');
        }
        _jnlSetNotes(notesContent);

        // Restore unsaved draft if newer than the last persisted save for this
        // trade. notesUpdatedAt is bumped by the form submit; absence means any
        // stored draft is newer than "never saved". When newer, apply the full
        // snapshot across all protected fields (notes, quick notes, grade,
        // setup, tags, profit targets, stop losses).
        var _draft = _jnlLoadDraft(trade.id);
        var _draftNotes = _draft ? (_draft.notes != null ? _draft.notes : _draft.content) : null;
        // A restored draft holds unsaved edits; otherwise nothing is edited yet.
        _jnlDirty = !!(_draft && _draft.ts > (trade.notesUpdatedAt || 0));
        if (_draft && _draft.ts > (trade.notesUpdatedAt || 0)) {
            if (typeof _draftNotes === 'string' && _draftNotes !== (notesContent || '')) {
                _jnlSetNotes(_draftNotes);
            }
            if (typeof _draft.quickNotes === 'string') {
                var _qn = document.getElementById('jnl-quick-notes');
                if (_qn) _qn.value = _draft.quickNotes;
            }
            if (typeof _draft.grade === 'string') _jnlSetGrade(_draft.grade);
            if (typeof _draft.setup === 'string') {
                var _ss = document.getElementById('jnl-setup-type');
                if (_ss) _ss.value = _draft.setup;
            }
            if (Array.isArray(_draft.tags) && _draft.tags.length) {
                var _tc = document.getElementById('jnl-tag-rows');
                if (_tc) {
                    _tc.innerHTML = '';
                    _draft.tags.forEach(function(t) {
                        addJnlTagRow(t.cat || '', t.name || '');
                    });
                    if (!_tc.querySelector('.jnl-tag-row')) addJnlTagRow();
                }
            }
            if (typeof _rehydratePlanRows === 'function') {
                _rehydratePlanRows('jnl-plan-rows', _draft.targets, _draft.stops);
            }
            // Core trade fields — restore values over the ones just loaded from
            // trade. Option-field visibility depends on jnl-asset-type, so
            // toggle again after the asset-type value may have changed.
            if (_draft.core && typeof _draft.core === 'object') {
                // Totals of a trade with saved fills (and a Webull trade's
                // execution fields, side and asset type) come from the trade,
                // never the draft, so they always match the fill rows.
                var _draftSkip = (_jnlIsWebull(trade) || (Array.isArray(trade.fills) && trade.fills.length >= 1))
                    ? _JNL_EXEC_IDS.concat(_jnlIsWebull(trade) ? ['jnl-trade-type', 'jnl-asset-type'] : [])
                    : [];
                Object.keys(_draft.core).forEach(function(id) {
                    if (_draftSkip.indexOf(id) >= 0) return;
                    // Older drafts copied the stored default exit time of an
                    // open trade; keep Exit Time blank for that case.
                    if (id === 'jnl-exit-time' && _openForExit && _draft.core[id] === _jnlFmtLocal(trade.exitTime)) return;
                    var el = document.getElementById(id);
                    if (el) el.value = _draft.core[id] != null ? _draft.core[id] : '';
                });
                _jnlToggleOptionFields();
            }
        }

        // Attach input listener once: synchronously back up every keystroke
        // across the whole protected form (not just notes).
        var _notesEl = document.getElementById('jnl-notes');
        if (_notesEl && !_notesEl.dataset.jnlDraftBound) {
            _notesEl.dataset.jnlDraftBound = '1';
            if (typeof EditorToolbar !== 'undefined') {
                EditorToolbar.bindPasteResize('jnl-notes');
                EditorToolbar.bindImagePopout('jnl-notes');
            }
            _notesEl.addEventListener('input', function() {
                if (window._jnlSelectedTradeId) {
                    _jnlSaveDraft(window._jnlSelectedTradeId);
                    _jnlScheduleCommit();
                }
            });
            _notesEl.addEventListener('blur', _jnlFlushCommit);
        }
        // Other protected fields: Quick Notes, Trade Grade (hidden input),
        // Strategy select, and the dynamic tag / target / stop row containers.
        // Use event delegation on containers to cover dynamically added rows.
        ['jnl-quick-notes', 'jnl-trade-grade', 'jnl-setup-type',
         'jnl-tag-rows', 'jnl-profit-target-rows', 'jnl-stop-loss-rows',
         'jnl-grade-pills',
         // Core trade fields (covered by draft protection):
         'jnl-symbol', 'jnl-asset-type', 'jnl-trade-type',
         'jnl-quantity', 'jnl-entry-price', 'jnl-exit-price',
         'jnl-entry-time', 'jnl-exit-time', 'jnl-commission-fees',
         'jnl-option-action', 'jnl-option-type', 'jnl-strike', 'jnl-expiry',
         'jnl-broker-account'].forEach(function(id) {
            var el = document.getElementById(id);
            if (!el || el.dataset.jnlDraftBound) return;
            el.dataset.jnlDraftBound = '1';
            var handler = function(ev) {
                if (!window._jnlSelectedTradeId) return;
                _jnlSaveDraft(window._jnlSelectedTradeId);
                // A plain click into a field is not an edit; a changed value
                // or a grade pill click is.
                if (ev && (ev.type !== 'click' || id === 'jnl-grade-pills')) _jnlDirty = true;
                // select / checkbox / pill clicks: commit immediately;
                // text/number inputs: debounce via schedule (blur will flush).
                if (ev && ev.type === 'change') _jnlFlushCommit();
                else if (ev && ev.type === 'click') _jnlFlushCommit();
                else _jnlScheduleCommit();
            };
            el.addEventListener('input', handler);
            el.addEventListener('change', handler);
            el.addEventListener('click', handler); // grade pills update hidden input on click
        });

        // Blur-flush: delegated focusout on the journal form catches any text
        // or number input losing focus, committing any pending debounced edit.
        var _jnlForm = document.getElementById('journal-editor-form');
        if (_jnlForm && !_jnlForm.dataset.jnlBlurBound) {
            _jnlForm.dataset.jnlBlurBound = '1';
            _jnlForm.addEventListener('focusout', function(ev) {
                if (!window._jnlSelectedTradeId) return;
                var tag = ev.target && ev.target.tagName;
                if (tag === 'INPUT' || tag === 'TEXTAREA') _jnlFlushCommit();
            });
        }

        renderNoteTemplateChips();
        _jnlRecalcMetrics();

        // Phase 4: render the grouped-trade fills panel below the execution
        // fields (no-op for single-fill / scalar trades).
        _jnlRenderFillsSection(trade);

        // Strategy rules checklist — honor draft's setup + rule state if newer.
        document.getElementById('jnl-strategy-rules-checklist').style.display = 'none';
        var _draftActive = _draft && _draft.ts > (trade.notesUpdatedAt || 0);
        var _effSetup = (_draftActive && typeof _draft.setup === 'string' && _draft.setup)
            ? _draft.setup
            : trade.setupType;
        if (_effSetup) {
            _jnlLoadStrategyRules(_effSetup, trade.strategyScore);
            // If the draft has rule checkbox state, override the freshly-rendered
            // checkboxes (which reflect trade.strategyScore) with the draft state,
            // then recompute score so display + _jnlFollowedRules stay consistent.
            if (_draftActive && Array.isArray(_draft.rules)) {
                var _rulesListEl = document.getElementById('jnl-rules-list');
                if (_rulesListEl) {
                    _rulesListEl.querySelectorAll('input[type="checkbox"]').forEach(function(cb) {
                        cb.checked = false;
                    });
                    _draft.rules.forEach(function(rid) {
                        var cb = document.getElementById('jnl-rule-' + rid);
                        if (cb) cb.checked = true;
                    });
                    if (typeof _jnlUpdateRuleScore === 'function') _jnlUpdateRuleScore();
                }
            }
        }
        // Event delegation: any rule checkbox toggle persists the draft immediately.
        // Attach once — the container exists in static HTML and rule checkboxes are
        // re-rendered into it, so delegation survives rerenders.
        var _rulesContainer = document.getElementById('jnl-rules-list');
        if (_rulesContainer && !_rulesContainer.dataset.jnlDraftBound) {
            _rulesContainer.dataset.jnlDraftBound = '1';
            _rulesContainer.addEventListener('change', function(ev) {
                if (ev.target && ev.target.type === 'checkbox' && window._jnlSelectedTradeId) {
                    _jnlSaveDraft(window._jnlSelectedTradeId);
                    _jnlDirty = true;
                    _jnlFlushCommit();
                }
            });
        }

        // Switch to entry view
        document.getElementById('jnl-view-list').style.display = 'none';
        document.getElementById('jnl-view-entry').style.display = '';
        window.scrollTo({ top: 0, behavior: 'instant' });
        _jnlGuardOpen(tradeId);
    }

    // Back to Trades button. An edited fill row that is only partly filled
    // can't be saved: point at its first missing field and ask before
    // leaving. Stay keeps the page and the row; Discard leaves as before
    // (the row is dropped). Everything else leaves exactly as before.
    function jnlBackToTrades() {
        var trade = window._jnlSelectedTradeId && journalData.trades.find(function(t) { return t.id === window._jnlSelectedTradeId; });
        var bad = (_jnlFillsDirty && trade && document.getElementById('jnl-fills-rows') && _jnlRowsEditable(trade))
            ? _ntFindIncompleteFillRow(_jnlSerializeFillRows()) : null;
        if (!bad) return closeJournalEditor();
        _jnlShowFillError(bad);
        // Stay: back on the missing field, bubble shown, row untouched.
        _jnlConfirmDiscardRow(function() { closeJournalEditor(); },
                              function() { _jnlShowFillError(bad); });
    }

    // In-app Stay / Discard confirm (app modal, not window.confirm).
    function _jnlConfirmDiscardRow(onDiscard, onStay) {
        var modal = document.getElementById('jnl-discard-row-modal');
        if (!modal) {
            modal = document.createElement('div');
            modal.id = 'jnl-discard-row-modal';
            modal.className = 'modal';
            modal.setAttribute('role', 'dialog');
            modal.setAttribute('aria-modal', 'true');
            modal.innerHTML = '<div class="modal-content" style="max-width:420px;">'
                + '<p style="margin:0; color:var(--text-primary);">This fill row is incomplete and can&#39;t be saved. Discard it?</p>'
                + '<div class="modal-buttons" style="justify-content:flex-end;">'
                + '<button type="button" class="btn btn-secondary btn-small" data-jnl-discard="stay">Stay</button>'
                + '<button type="button" class="btn btn-small" data-jnl-discard="discard" style="background:var(--danger); color:var(--on-danger);">Discard</button>'
                + '</div></div>';
            document.body.appendChild(modal);
        }
        var close = function() { modal.classList.remove('active'); };
        modal.querySelector('[data-jnl-discard="stay"]').onclick = function() { close(); if (onStay) onStay(); };
        modal.querySelector('[data-jnl-discard="discard"]').onclick = function() { close(); onDiscard(); };
        modal.classList.add('active');
        var stayBtn = modal.querySelector('[data-jnl-discard="stay"]');
        if (stayBtn && stayBtn.focus) stayBtn.focus();
    }

    function closeJournalEditor() {
        var _closeCommit = _jnlFlushCommit();
        var tid = window._jnlSelectedTradeId;
        // Keep the draft if that save fails, so reopening the trade restores the edits.
        if (tid) Promise.resolve(_closeCommit).then(function(ok) { if (ok !== false) _jnlClearDraft(tid); });
        if (typeof _editorGuardClose === 'function') _editorGuardClose(_JNL_GUARD);
        document.getElementById('jnl-view-entry').style.display = 'none';
        document.getElementById('jnl-view-list').style.display = '';
        window.scrollTo({ top: 0, behavior: 'instant' });
        window._jnlSelectedTradeId = null;
        _jnlLoadGen++;
        _jnlFillsConverting = false;
        // Clear any previously-rendered fills panel so the next trade
        // starts with a clean slate.
        var _fillsPanel = document.getElementById('jnl-fills-section');
        if (_fillsPanel) _fillsPanel.remove();
        renderJournalTradeList();
    }

    // ── Phase 4: grouped-trade fills panel ─────────────────────────────────────
    // View-only section shown on Trade Reflection / Journal for trades whose
    // saved record carries a multi-row `fills[]` array. Single-fill / scalar
    // trades are untouched. The panel sits directly below the execution
    // fields row (Entry/Exit prices, times, fees) and above the strategy
    // rules section. Values come straight from each fill on disk — no
    // calculation is duplicated here, so option 100x math stays correct
    // because each fill.pnl was already computed option-aware upstream.
    function _jnlFmtFillDate(v) {
        if (!v) return '--';
        var d = new Date(v);
        if (isNaN(d.getTime())) return String(v);
        return d.toLocaleString();
    }

    // Row qty as a share of the trade's total qty, 1 decimal.
    function _jnlPosPct(q, totQ) {
        return totQ > 0 ? ((q / totQ) * 100).toFixed(1) + '%' : '--';
    }

    // Fill-row P&L after fees, signed for Short, with the contract multiplier.
    function _jnlFillPnl(side, q, ep, xp, cm, mult) {
        return (side === 'short' ? (ep - xp) : (xp - ep)) * q * mult - cm;
    }

    // % Gain shared by fill rows and the Total row: P&L (after fees, already
    // signed for Short) over the dollar basis entryPrice * qty * multiplier.
    function _jnlFillGainPct(pnl, entryPrice, qty, mult) {
        var basis = entryPrice * qty * mult;
        return basis > 0 ? (pnl / basis) * 100 : null;
    }

    // Formatted Total-row cells from qty-weighted sums (sumEntry/sumExit are
    // sum of price * qty). Exit and % Gain show "--" while any row is open.
    function _jnlFillTotals(totQ, sumEntry, sumExit, totPnl, anyOpen, mult) {
        var avgEntry = totQ > 0 ? sumEntry / totQ : null;
        var avgExit = (totQ > 0 && !anyOpen) ? sumExit / totQ : null;
        var gain = (avgEntry > 0 && avgExit != null)
            ? _jnlFillGainPct(totPnl, avgEntry, totQ, mult)
            : null;
        return {
            entry: avgEntry == null ? '--' : '$' + avgEntry.toFixed(2),
            exit:  avgExit == null ? '--' : '$' + avgExit.toFixed(2),
            entryFull: avgEntry == null ? '' : avgEntry.toFixed(4),
            exitFull:  avgExit == null ? '' : avgExit.toFixed(4),
            pnl:   (totPnl >= 0 ? '+' : '') + '$' + totPnl.toFixed(2),
            gain:  gain == null ? '--' : (gain >= 0 ? '+' : '') + gain.toFixed(2) + '%',
            gainColor: gain == null ? '' : (gain >= 0 ? 'var(--success)' : 'var(--danger)')
        };
    }

    // Fills Total-row sums for the Gross / Net % Gain metrics, or null when
    // the trade shows no fills (the metrics then use the top fields).
    var _jnlFillSums = null;

    // Calculated Metrics Gross / Net % Gain, display only. Same basis and
    // math as the fills Total row; Gross adds the fees back to the P&L.
    function _jnlUpdatePctGains() {
        var side = (document.getElementById('jnl-trade-type') || {}).value || 'long';
        var mult = _contractMultiplier((document.getElementById('jnl-asset-type') || {}).value || 'stock');
        var stored = (journalData.trades || []).find(function(t) { return t.id === window._jnlSelectedTradeId; });
        var storedOpen = !!stored && typeof window._isOpenTrade === 'function' && window._isOpenTrade(stored);
        var s = _jnlFillSums;
        if (!s) {
            var q = _sfId('jnl-quantity'), ep = _sfId('jnl-entry-price'), xp = _sfId('jnl-exit-price');
            var cm = _sfId('jnl-commission-fees') || 0;
            s = (q > 0 && ep != null && xp != null)
                ? { qty: q, sumEntry: ep * q, sumExit: xp * q, pnl: _jnlFillPnl(side, q, ep, xp, cm, mult), fees: cm, anyOpen: false }
                : null;
        }
        var set = function(id, gross) {
            var el = document.getElementById(id);
            if (!el) return;
            var t = (s && s.qty > 0 && !storedOpen)
                ? _jnlFillTotals(s.qty, s.sumEntry, s.sumExit, gross ? s.pnl + s.fees : s.pnl, s.anyOpen, mult)
                : null;
            el.textContent = t ? t.gain : '--';
            el.style.color = (t && t.gainColor) || 'var(--text-primary)';
        };
        set('jnl-pnl-net-pct', false);
        set('jnl-pnl-gross-pct', true);
    }

    function _jnlRenderFillsSection(trade) {
        _jnlFillSums = null;
        var existing = document.getElementById('jnl-fills-section');
        var hasFills = trade && Array.isArray(trade.fills) && trade.fills.length >= 1;
        var isWebull = _jnlIsWebull(trade);

        // Trades without fills (scalar, or fills not cached on this device):
        // no panel; a Webull trade still shows its note. A closed manual
        // trade shows "Use Multiple Fills" once unlocked, or its rows while
        // being converted.
        var converting = !hasFills && !isWebull && _jnlCanConvertToFills(trade)
            && (_jnlFillsConverting || _jnlUnlocked());
        if (!hasFills && !isWebull && !converting) {
            if (existing) existing.remove();
            _jnlUpdatePctGains();
            return;
        }

        // Find or create the container. Anchor it after the 4-col execution
        // fields grid that wraps jnl-commission-fees so it sits below the
        // summary/execution block and above the strategy-rules section.
        var container = existing;
        if (!container) {
            var anchorInput = document.getElementById('jnl-commission-fees');
            if (!anchorInput) return;
            var anchorGrid = anchorInput.closest('.form-grid') || anchorInput.parentElement;
            if (!anchorGrid || !anchorGrid.parentElement) return;
            container = document.createElement('div');
            container.id = 'jnl-fills-section';
            container.style.margin = '8px 0 16px';
            anchorGrid.parentElement.insertBefore(container, anchorGrid.nextSibling);
        }

        if (converting) {
            if (_jnlFillsConverting) _jnlRenderConvertedFills(container, trade);
            else {
                container.innerHTML = ''
                    + '<div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap; background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">'
                        + '<span style="font-weight:600; font-size:13px;">Fills / Execution Rows '
                            + '<span style="color:var(--text-secondary); font-weight:400;">(single fill)</span></span>'
                        + '<button type="button" id="jnl-fills-convert-btn" class="btn btn-small btn-secondary" onclick="jnlUseMultipleFills()">Use Multiple Fills</button>'
                    + '</div>';
                _jnlUpdatePctGains();
            }
            return;
        }

        if (_jnlFillsEditable(trade)) {
            _jnlRenderFillsEditor(container, trade);
            return;
        }

        var webullNote = isWebull
            ? '<p class="inline-help-note" id="jnl-webull-note" style="margin:0 0 8px;">Fills come from Webull and can\'t be edited. Quantity, prices, times and fees stay locked.</p>'
            : '';
        if (!hasFills) {
            container.innerHTML = webullNote;
            _jnlUpdatePctGains();
            return;
        }

        var anyComm = trade.fills.some(function(f) {
            return Number(f.commissionFees) !== 0;
        });

        // Per-fill % uses the fill's stored pnl (already option-aware)
        // divided by the fill's dollar basis (entryPrice * qty * multiplier).
        // Multiplier is resolved once from the trade-level assetType so
        // option math stays centralized.
        var mult = (trade.assetType === 'option') ? 100 : 1;

        // Display-only totals; never written back to the trade.
        var totQ = 0, totEntry = 0, totExit = 0, totPnl = 0, totFees = 0, anyOpen = false;
        trade.fills.forEach(function(f) {
            var q = Number(f.quantity) || 0;
            totQ += q;
            totEntry += (Number(f.entryPrice) || 0) * q;
            if (f.exitPrice == null || f.exitPrice === '' || !isFinite(Number(f.exitPrice))) anyOpen = true;
            else totExit += Number(f.exitPrice) * q;
            totPnl += (f.pnl != null && isFinite(Number(f.pnl))) ? Number(f.pnl) : 0;
            totFees += Number(f.commissionFees) || 0;
        });
        var t = _jnlFillTotals(totQ, totEntry, totExit, totPnl, anyOpen, mult);
        _jnlFillSums = { qty: totQ, sumEntry: totEntry, sumExit: totExit, pnl: totPnl, fees: totFees, anyOpen: anyOpen };
        _jnlUpdatePctGains();

        var rowsHtml = trade.fills.map(function(f, idx) {
            var q = Number(f.quantity) || 0;
            var ep = Number(f.entryPrice) || 0;
            var xp = Number(f.exitPrice) || 0;
            var pnl = (f.pnl != null && isFinite(Number(f.pnl))) ? Number(f.pnl) : 0;
            var pct = _jnlFillGainPct(pnl, ep, q, mult);
            var color = pnl >= 0 ? 'var(--success)' : 'var(--danger)';
            var pctStr = (pct == null) ? '--'
                : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
            return '<tr>'
                + '<td style="padding:4px 8px;">' + (idx + 1) + '</td>'
                + '<td style="padding:4px 8px;">' + q + '</td>'
                + '<td style="padding:4px 8px;">' + _jnlPosPct(q, totQ) + '</td>'
                + '<td style="padding:4px 8px;">$' + ep.toFixed(2) + '</td>'
                + '<td style="padding:4px 8px;">$' + xp.toFixed(2) + '</td>'
                + '<td style="padding:4px 8px; white-space:nowrap;">' + _jnlFmtFillDate(f.entryTime) + '</td>'
                + '<td style="padding:4px 8px; white-space:nowrap;">' + _jnlFmtFillDate(f.exitTime) + '</td>'
                + (anyComm
                    ? '<td style="padding:4px 8px;">$' + (Number(f.commissionFees) || 0).toFixed(2) + '</td>'
                    : '')
                + '<td style="padding:4px 8px; color:' + color + '; font-weight:600;">'
                    + (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2)
                + '</td>'
                + '<td style="padding:4px 8px; color:' + color + ';">' + pctStr + '</td>'
                + '</tr>';
        }).join('');

        var totColor = totPnl >= 0 ? 'var(--success)' : 'var(--danger)';
        var totalHtml = '<tr class="jnl-fills-total" style="font-weight:700; border-top:1px solid var(--border);">'
            + '<td style="padding:4px 8px;">Total</td>'
            + '<td style="padding:4px 8px;">' + totQ + '</td>'
            + '<td style="padding:4px 8px;">' + _jnlPosPct(totQ, totQ) + '</td>'
            + '<td style="padding:4px 8px;" title="' + t.entryFull + '">' + t.entry + '</td>'
            + '<td style="padding:4px 8px;" title="' + t.exitFull + '">' + t.exit + '</td>'
            + '<td style="padding:4px 8px;"></td>'
            + '<td style="padding:4px 8px;"></td>'
            + (anyComm ? '<td style="padding:4px 8px;">$' + totFees.toFixed(2) + '</td>' : '')
            + '<td style="padding:4px 8px; color:' + totColor + ';">' + t.pnl + '</td>'
            + '<td style="padding:4px 8px; color:' + t.gainColor + ';">' + t.gain + '</td>'
            + '</tr>';

        // Fixed layout: # stays narrow, every other column gets an equal
        // share. The min-width keeps each column wide enough for a one-line
        // date-time; narrower cards scroll inside the overflow-x wrapper.
        var tableMinW = 32 + (anyComm ? 9 : 8) * 150;

        container.innerHTML = webullNote
            + '<details class="jnl-fills-details" open style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">'
                + '<summary style="cursor:pointer; font-weight:600; font-size:13px; display:flex; align-items:center; gap:8px;">'
                    + '<span class="jnl-fills-chev" aria-hidden="true">&#9656;</span>'
                    + 'Fills / Execution Rows '
                    + '<span style="color:var(--text-secondary); font-weight:400;">('
                        + trade.fills.length + ' rows)'
                    + '</span>'
                + '</summary>'
                + '<div style="margin-top:10px; overflow-x:auto;">'
                    + '<table class="jnl-fills-table" style="width:100%; min-width:' + tableMinW + 'px; table-layout:fixed; font-size:12px; border-collapse:collapse;">'
                        + '<thead>'
                            + '<tr style="text-align:left; color:var(--text-secondary); border-bottom:1px solid var(--border);">'
                                + '<th style="padding:4px 8px; width:32px;">#</th>'
                                + '<th style="padding:4px 8px;">Qty</th>'
                                + '<th style="padding:4px 8px;">% Pos.</th>'
                                + '<th style="padding:4px 8px;">Entry</th>'
                                + '<th style="padding:4px 8px;">Exit</th>'
                                + '<th style="padding:4px 8px; white-space:nowrap;">Entry time</th>'
                                + '<th style="padding:4px 8px; white-space:nowrap;">Exit time</th>'
                                + (anyComm ? '<th style="padding:4px 8px;">Fees</th>' : '')
                                + '<th style="padding:4px 8px;">P&amp;L</th>'
                                + '<th style="padding:4px 8px;">% Gain</th>'
                            + '</tr>'
                        + '</thead>'
                        + '<tbody>' + rowsHtml + totalHtml + '</tbody>'
                    + '</table>'
                + '</div>'
            + '</details>';
    }

    // ── Batch C1: editable fills + split ─────────────────────────────────────
    // Closed, non-Webull trades with fills get editable rows behind Unlock
    // Fields (inputs carry jnl-locked-field, so selectTradeForJournal locks
    // them on every open). Typing in a row marks the page dirty and saves
    // through _jnlCommitTrade, which rewrites trade.fills and the totals from
    // the rows. Ticking Split is not an edit and saves nothing.
    // Columns match the New Trade grid: #, Qty, % Pos., Entry, Exit, Entry
    // time, Exit time, Fees, P&L, % Gain, then Split and remove.
    var _JNL_FILL_GRID = 'display:grid; grid-template-columns: 28px 72px 62px repeat(4, minmax(0,1fr)) 72px 92px 74px 40px 32px; gap:6px; align-items:center; margin-bottom:6px;';
    // Calculated cells: right-aligned so the numbers line up, never wrap.
    var _JNL_FILL_NUM = 'text-align:right; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;';

    function _jnlUnlocked() {
        var btn = document.getElementById('jnl-unlock-btn');
        return !!btn && btn.disabled;
    }

    function _jnlRenderFillsEditor(container, trade) {
        var lock = _jnlUnlocked() ? '' : ' disabled';
        container.innerHTML = ''
            + '<details class="jnl-fills-details" open style="background:var(--bg-secondary);border:1px solid var(--border);border-radius:8px;padding:10px 14px;">'
                + '<summary style="cursor:pointer; font-weight:600; font-size:13px; display:flex; align-items:center; gap:8px;">'
                    + '<span class="jnl-fills-chev" aria-hidden="true">&#9656;</span>'
                    + 'Fills / Execution Rows '
                    + '<span id="jnl-fills-count" style="color:var(--text-secondary); font-weight:400;">(' + trade.fills.length + ' rows)</span>'
                + '</summary>'
                + '<div style="margin-top:10px; overflow-x:auto;">'
                    + '<div style="' + _JNL_FILL_GRID + ' font-size:10px; color:var(--text-secondary); text-transform:uppercase; letter-spacing:0.05em;">'
                        + '<span></span><span>Qty</span>'
                        + '<span style="' + _JNL_FILL_NUM + '">% Pos.</span>'
                        + '<span>Entry</span><span>Exit</span>'
                        + '<span>Entry time</span><span>Exit time</span><span>Fees</span>'
                        + '<span style="' + _JNL_FILL_NUM + '">P&amp;L</span>'
                        + '<span style="' + _JNL_FILL_NUM + '">% Gain</span>'
                        + '<span title="Mark rows to move into a new trade">Split</span><span></span>'
                    + '</div>'
                    + '<div id="jnl-fills-rows"></div>'
                    // Display-only Total row: outside #jnl-fills-rows, so it is
                    // never serialized, split, removed or saved.
                    + '<div id="jnl-fills-total" style="' + _JNL_FILL_GRID + ' font-size:11px; font-weight:700; border-top:1px solid var(--border); padding-top:6px;">'
                        + '<span style="text-align:center;">Total</span>'
                        + '<span data-jnl-tot="qty">--</span>'
                        + '<span data-jnl-tot="pos" style="' + _JNL_FILL_NUM + '">--</span>'
                        + '<span data-jnl-tot="entry">--</span><span data-jnl-tot="exit">--</span>'
                        + '<span></span><span></span>'
                        + '<span data-jnl-tot="fees">--</span>'
                        + '<span data-jnl-tot="pnl" style="' + _JNL_FILL_NUM + '">--</span>'
                        + '<span data-jnl-tot="gain" style="' + _JNL_FILL_NUM + '">--</span><span></span><span></span>'
                    + '</div>'
                    + '<div id="jnl-fills-error" style="display:none; margin-top:4px; font-size:12px; color:var(--danger, #f87171);"></div>'
                    + '<div style="display:flex; justify-content:flex-end; margin-top:6px;">'
                        + '<button type="button" class="btn btn-small btn-primary jnl-locked-field" onclick="jnlAddFillRow()" style="padding:2px 10px; font-size:12px;"' + lock + '>+ Add Fill Row</button>'
                    + '</div>'
                    + '<div id="jnl-fills-split-bar" style="display:none; align-items:center; justify-content:space-between; margin-top:10px; padding:8px 10px; background:rgba(245, 158, 11, 0.10); border:1px solid rgba(245, 158, 11, 0.35); border-radius:6px; gap:8px; flex-wrap:wrap;">'
                        + '<span id="jnl-fills-split-status" style="font-size:12px; color:var(--text-primary);">0 rows marked</span>'
                        + '<button type="button" class="btn btn-small btn-warning" id="jnl-fills-split-btn" onclick="jnlSplitMarkedFills()" style="padding:4px 12px; font-size:12px;">Split marked rows into a new trade</button>'
                    + '</div>'
                + '</div>'
            + '</details>';

        trade.fills.forEach(function(f) { _jnlAppendFillRow(f); });
        _jnlUpdateFillRowDisplay();

        if (!container.dataset.jnlFillsBound) {
            container.dataset.jnlFillsBound = '1';
            container.addEventListener('input', function(ev) {
                var t = ev.target;
                if (!t || !t.closest('.jnl-fill-row') || t.type === 'checkbox') return;
                if (!window._jnlSelectedTradeId) return;
                _jnlClearFillError();
                _jnlRecomputeFills();
                _jnlFillsDirty = true;
                _jnlScheduleCommit();
            });
            container.addEventListener('change', function(ev) {
                var t = ev.target;
                if (!t || t.type !== 'checkbox' || !t.closest('.jnl-fill-row')) return;
                _jnlClearFillError();
                // Split must leave at least one row on this trade;
                // _jnlUpdateSplitBar shows the message while it doesn't.
                _jnlUpdateSplitBar();
            });
        }
    }

    // ── Use Multiple Fills on a saved single-fill trade ─────────────────────
    // The existing editor on a copy of the trade whose one fill is the
    // trade's own execution, so the trade object is never touched here.
    // The editor's first draw only updates the row display; the summary
    // inputs, totals and dirty flags stay as they are until a row is edited.
    function _jnlRenderConvertedFills(container, trade) {
        _jnlRenderFillsEditor(container, Object.assign({}, trade, { fills: [{
            quantity:       trade.quantity,
            entryPrice:     trade.entryPrice,
            exitPrice:      trade.exitPrice,
            entryTime:      trade.entryTime,
            exitTime:       trade.exitTime,
            commissionFees: trade.commissionFees
        }] }));
        // Undo, offered only until the rows are first saved.
        var addBtn = container.querySelector('[onclick="jnlAddFillRow()"]');
        if (addBtn && addBtn.parentNode) {
            var single = document.createElement('button');
            single.type = 'button';
            single.id = 'jnl-fills-single-btn';
            single.className = 'btn btn-small btn-secondary';
            single.style.cssText = 'padding:2px 10px; font-size:12px; margin-right:6px;';
            single.textContent = 'Use Single Fill';
            single.onclick = jnlUseSingleFill;
            addBtn.parentNode.insertBefore(single, addBtn);
        }
    }

    async function jnlUseMultipleFills() {
        var trade = journalData.trades.find(function(t) { return t.id === window._jnlSelectedTradeId; });
        if (!trade || !_jnlUnlocked() || _jnlFillsConverting || !_jnlCanConvertToFills(trade)) return;
        // Unsaved execution edits are saved first through the normal save;
        // row #1 then comes from the saved trade. A failed save converts nothing.
        if (_JNL_PNL_IDS.some(_jnlChanged)) {
            if (_jnlCommitTimer) { clearTimeout(_jnlCommitTimer); _jnlCommitTimer = null; }
            if (!(await _jnlCommitTrade())) return;
            if (window._jnlSelectedTradeId !== trade.id || _jnlFillsConverting || !_jnlCanConvertToFills(trade)) return;
        }
        _jnlFillsConverting = true;
        _jnlRenderFillsSection(trade);
        // Totals now come only from the rows, as for any trade with fills.
        _JNL_EXEC_IDS.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.disabled = true;
        });
    }

    // Undo before the rows are first saved: the six summary inputs go back
    // to their saved values and unlock; nothing is saved.
    function jnlUseSingleFill() {
        var trade = journalData.trades.find(function(t) { return t.id === window._jnlSelectedTradeId; });
        if (!trade || !_jnlFillsConverting || !_jnlCanConvertToFills(trade)) return;
        _jnlFillsConverting = false;
        _jnlFillsDirty = false;
        _JNL_EXEC_IDS.forEach(function(id) {
            var el = document.getElementById(id);
            if (!el) return;
            if (_jnlLoaded[id] != null) el.value = _jnlLoaded[id];
            el.disabled = false;
        });
        _jnlRenderFillsSection(trade);
        _jnlRecalcMetrics();
    }

    function _jnlFillRowEls() {
        return Array.prototype.slice.call(document.querySelectorAll('#jnl-fills-rows .jnl-fill-row'));
    }

    function _jnlRowMarked(r) {
        var cb = r.querySelector('[data-jnl-fill="split"]');
        return !!(cb && cb.checked);
    }

    function _jnlAppendFillRow(values) {
        var rowsC = document.getElementById('jnl-fills-rows');
        if (!rowsC) return null;
        values = values || {};
        var lock = _jnlUnlocked() ? '' : ' disabled';
        var row = document.createElement('div');
        row.className = 'jnl-fill-row';
        row.style.cssText = _JNL_FILL_GRID;
        row.innerHTML = ''
            + '<span class="jnl-fill-idx" style="font-size:11px; color:var(--text-secondary); text-align:center;">#' + (rowsC.children.length + 1) + '</span>'
            + '<input data-jnl-fill="qty"         class="jnl-locked-field" type="number" step="1" min="1"' + lock + '>'
            + '<span data-jnl-fill="pos" style="font-size:11px; color:var(--text-secondary); ' + _JNL_FILL_NUM + '">--</span>'
            + '<input data-jnl-fill="entry-price" class="jnl-locked-field" type="number" step="0.0001"' + lock + '>'
            + '<input data-jnl-fill="exit-price"  class="jnl-locked-field" type="number" step="0.0001"' + lock + '>'
            + '<input data-jnl-fill="entry-time"  class="jnl-locked-field" type="datetime-local"' + lock + '>'
            + '<input data-jnl-fill="exit-time"   class="jnl-locked-field" type="datetime-local"' + lock + '>'
            + '<input data-jnl-fill="fees"        class="jnl-locked-field" type="number" step="0.01" min="0"' + lock + '>'
            + '<span data-jnl-fill="pnl" style="font-size:11px; font-weight:600; ' + _JNL_FILL_NUM + '">--</span>'
            + '<span data-jnl-fill="pct" style="font-size:11px; ' + _JNL_FILL_NUM + '">--</span>'
            + '<label style="display:flex; justify-content:center; align-items:center;" title="Mark this row to move into a new trade">'
                + '<input data-jnl-fill="split" class="jnl-locked-field" type="checkbox"' + lock + '>'
            + '</label>'
            + '<button type="button" class="btn btn-small btn-secondary jnl-locked-field" onclick="jnlRemoveFillRow(this)" style="padding:0 6px; font-size:13px;"' + lock + '>✕</button>';
        rowsC.appendChild(row);
        var set = function(key, v, isDate) {
            var el = row.querySelector('[data-jnl-fill="' + key + '"]');
            if (!el) return;
            el.value = (v == null || v === '') ? '' : (isDate ? _jnlFmtLocal(v) : String(v));
        };
        set('qty',         values.quantity);
        set('entry-price', values.entryPrice);
        set('exit-price',  values.exitPrice);
        set('entry-time',  values.entryTime, true);
        set('exit-time',   values.exitTime, true);
        set('fees',        values.commissionFees);
        return row;
    }

    // Raw row values in the shape _ntFindIncompleteFillRow reads.
    function _jnlSerializeFillRows() {
        return _jnlFillRowEls().map(function(r) {
            var v = function(key) { return (r.querySelector('[data-jnl-fill="' + key + '"]') || {}).value || ''; };
            return {
                qty:        v('qty'),
                entryPrice: v('entry-price'),
                exitPrice:  v('exit-price'),
                entryTime:  v('entry-time'),
                exitTime:   v('exit-time'),
                fees:       v('fees')
            };
        });
    }

    // Same rule as _ntFindIncompleteFillRow: no qty and no prices = empty.
    function _jnlRawRowEmpty(r) {
        return r.qty === '' && r.entryPrice === '' && r.exitPrice === '';
    }

    function _jnlFillsMsg(text, type) {
        var box = document.getElementById('jnl-fills-error');
        if (!box) return;
        box.textContent = text || '';
        box.style.color = type === 'success' ? 'var(--success)' : 'var(--danger, #f87171)';
        box.style.display = text ? '' : 'none';
    }

    function _jnlShowFillError(bad) {
        _jnlFillsMsg('Row #' + bad.row + ': ' + bad.field + ' is missing.', 'danger');
        var rowEl = _jnlFillRowEls()[bad.row - 1];
        var input = rowEl && rowEl.querySelector('[data-jnl-fill="' + bad.key + '"]');
        var details = rowEl && rowEl.closest && rowEl.closest('details');
        if (details) details.open = true;
        if (input) {
            input.style.borderColor = 'var(--danger, #f87171)';
            _fillFieldPopup(input, bad.field);
            input.focus();
        }
    }

    function _jnlClearFillError() {
        _clearFieldBubble();
        _jnlFillsMsg('');
        document.querySelectorAll('#jnl-fills-rows [data-jnl-fill]').forEach(function(el) {
            el.style.borderColor = '';
        });
    }

    function _jnlUpdateSplitBar() {
        var bar    = document.getElementById('jnl-fills-split-bar');
        var status = document.getElementById('jnl-fills-split-status');
        if (!bar || !status) return;
        var rows = _jnlFillRowEls();
        var marked = rows.filter(_jnlRowMarked).length;
        // Same rule as jnlSplitMarkedFills: empty rows don't count, and at
        // least one filled row must stay. The message shows only while the
        // selection breaks that rule.
        var raw = _jnlSerializeFillRows();
        var filled = 0, filledMarked = 0;
        rows.forEach(function(r, i) {
            if (_jnlRawRowEmpty(raw[i])) return;
            filled++;
            if (_jnlRowMarked(r)) filledMarked++;
        });
        var keepsNone = filledMarked > 0 && filledMarked === filled;
        var leaveMsg = 'Leave at least one row on this trade.';
        var box = document.getElementById('jnl-fills-error');
        if (keepsNone) _jnlFillsMsg(leaveMsg, 'danger');
        else if (box && box.textContent === leaveMsg) _jnlFillsMsg('');
        var splitBtn = document.getElementById('jnl-fills-split-btn');
        if (splitBtn) splitBtn.disabled = keepsNone;
        if (marked === 0) { bar.style.display = 'none'; return; }
        bar.style.display = 'flex';
        var remaining = rows.length - marked;
        status.textContent = marked + ' row' + (marked === 1 ? '' : 's')
            + ' marked — will move to 1 new trade, '
            + remaining + ' row' + (remaining === 1 ? '' : 's') + ' will remain on this trade';
    }

    // Per-row P&L / % and the row count; never touches the summary inputs.
    function _jnlUpdateFillRowDisplay() {
        var side = (document.getElementById('jnl-trade-type') || {}).value || 'long';
        var assetType = (document.getElementById('jnl-asset-type') || {}).value || 'stock';
        var mult = _contractMultiplier(assetType);
        var rows = _jnlFillRowEls();
        var rowNum = function(r, key) { return parseFloat((r.querySelector('[data-jnl-fill="' + key + '"]') || {}).value) || 0; };
        var totQ = 0, pricedQ = 0, sumEntry = 0, sumExit = 0, totPnl = 0, totFees = 0, pricedFees = 0, anyOpen = false;
        rows.forEach(function(r) { var q = rowNum(r, 'qty'); if (q > 0) totQ += q; });
        rows.forEach(function(r, i) {
            var num = function(key) { return rowNum(r, key); };
            var q = num('qty'), ep = num('entry-price'), xp = num('exit-price'), cm = num('fees');
            totFees += cm;
            var posEl = r.querySelector('[data-jnl-fill="pos"]');
            if (posEl) posEl.textContent = q > 0 ? _jnlPosPct(q, totQ) : '--';
            var idxEl = r.querySelector('.jnl-fill-idx');
            if (idxEl) idxEl.textContent = '#' + (i + 1);
            var pnlEl = r.querySelector('[data-jnl-fill="pnl"]');
            var pctEl = r.querySelector('[data-jnl-fill="pct"]');
            if (q > 0 && ep > 0) {
                var pnl = _jnlFillPnl(side, q, ep, xp, cm, mult);
                pricedQ += q;
                pricedFees += cm;
                sumEntry += ep * q;
                sumExit += xp * q;
                totPnl += pnl;
                if ((r.querySelector('[data-jnl-fill="exit-price"]') || {}).value === '') anyOpen = true;
                var color = pnl >= 0 ? 'var(--success)' : 'var(--danger)';
                if (pnlEl) { pnlEl.textContent = (pnl >= 0 ? '+' : '') + '$' + pnl.toFixed(2); pnlEl.style.color = color; }
                if (pctEl) {
                    var pct = _jnlFillGainPct(pnl, ep, q, mult);
                    pctEl.textContent = pct == null ? '--' : (pct >= 0 ? '+' : '') + pct.toFixed(2) + '%';
                    pctEl.style.color = color;
                }
            } else {
                if (pnlEl) { pnlEl.textContent = '--'; pnlEl.style.color = ''; }
                if (pctEl) { pctEl.textContent = '--'; pctEl.style.color = ''; }
            }
        });
        var totEl = document.getElementById('jnl-fills-total');
        if (totEl) {
            var t = _jnlFillTotals(pricedQ, sumEntry, sumExit, totPnl, anyOpen, mult);
            var setTot = function(key, text, color, title) {
                var el = totEl.querySelector('[data-jnl-tot="' + key + '"]');
                if (!el) return;
                el.textContent = text;
                el.style.color = color || '';
                el.title = title || '';
            };
            var priced = pricedQ > 0;
            setTot('qty',   totQ > 0 ? String(totQ) : '--');
            setTot('pos',   _jnlPosPct(totQ, totQ));
            setTot('entry', t.entry, '', t.entryFull);
            setTot('exit',  t.exit,  '', t.exitFull);
            setTot('fees',  '$' + totFees.toFixed(2));
            setTot('pnl',   priced ? t.pnl : '--', priced ? (totPnl >= 0 ? 'var(--success)' : 'var(--danger)') : '');
            setTot('gain',  t.gain, t.gainColor);
        }
        _jnlFillSums = { qty: pricedQ, sumEntry: sumEntry, sumExit: sumExit, pnl: totPnl, fees: pricedFees, anyOpen: anyOpen };
        _jnlUpdatePctGains();
        var cntEl = document.getElementById('jnl-fills-count');
        if (cntEl) cntEl.textContent = '(' + rows.length + ' rows)';
        _jnlUpdateSplitBar();
    }

    // After an edit: row display, then the totals from the complete rows
    // written into the (locked) summary inputs.
    function _jnlRecomputeFills() {
        _jnlUpdateFillRowDisplay();
        var side = (document.getElementById('jnl-trade-type') || {}).value || 'long';
        var assetType = (document.getElementById('jnl-asset-type') || {}).value || 'stock';
        var fills = _fillsFromRawRows(_jnlSerializeFillRows(), side, assetType);
        var summary = fills.length ? deriveTradeSummaryFromFills(fills, { type: side, assetType: assetType }) : null;
        if (!summary) return;
        var setVal = function(id, v) { var el = document.getElementById(id); if (el) el.value = v; };
        setVal('jnl-quantity',        summary.quantity);
        setVal('jnl-entry-price',     Number(summary.entryPrice).toFixed(4));
        setVal('jnl-exit-price',      Number(summary.exitPrice).toFixed(4));
        setVal('jnl-entry-time',      _jnlFmtLocal(summary.entryTime));
        setVal('jnl-exit-time',       _jnlFmtLocal(summary.exitTime));
        setVal('jnl-commission-fees', Number(summary.commissionFees || 0).toFixed(2));
        _jnlRecalcMetrics();
    }

    // An empty new row is not an edit; typing in it is.
    function jnlAddFillRow() {
        if (!_jnlUnlocked()) return;
        _jnlAppendFillRow({});
        _jnlUpdateFillRowDisplay();
    }

    function jnlRemoveFillRow(btn) {
        var row = btn && btn.closest('.jnl-fill-row');
        if (!row || !_jnlUnlocked()) return;
        _jnlClearFillError();
        var rows = _jnlFillRowEls();
        if (rows.length <= 1) {
            _jnlFillsMsg('A trade needs at least one fill row.', 'danger');
            return;
        }
        var raw = _jnlSerializeFillRows()[rows.indexOf(row)];
        row.remove();
        _jnlRecomputeFills();
        // Removing an empty row changes nothing that is saved.
        if (raw && !_jnlRawRowEmpty(raw)) {
            _jnlFillsDirty = true;
            _jnlDirty = true;
            _jnlFlushCommit();
        }
    }

    // Moves the ticked rows into one new trade. Pending edits are saved
    // first; then both trades go to the cloud in one upsert. On failure
    // nothing in memory or on screen changes. If the cloud save worked but
    // the local save fails, the split is kept (the cloud is primary).
    async function jnlSplitMarkedFills() {
        var trade = journalData.trades.find(function(t) { return t.id === window._jnlSelectedTradeId; });
        if (!trade || _jnlSplitting) return;
        if (!_jnlFillsEditable(trade)) {
            // Converted rows can split once autosave has saved them.
            if (_jnlFillsConverting && _jnlCanConvertToFills(trade)) _jnlFillsMsg('Saving rows... try Split again in a moment', 'danger');
            return;
        }
        _jnlClearFillError();

        var raw = _jnlSerializeFillRows();
        var bad = _ntFindIncompleteFillRow(raw);
        if (bad) { _jnlShowFillError(bad); return; }
        var rowEls = _jnlFillRowEls();
        var kept = [], markedIdx = [];
        raw.forEach(function(r, i) {
            if (_jnlRawRowEmpty(r)) return;
            if (_jnlRowMarked(rowEls[i])) markedIdx.push(kept.length);
            kept.push(r);
        });
        if (markedIdx.length === 0) return;
        if (markedIdx.length === kept.length) {
            _jnlFillsMsg('Leave at least one row on this trade.', 'danger');
            return;
        }
        var fills = _fillsFromRawRows(kept, trade.type || trade.direction, trade.assetType);
        if (fills.length !== kept.length) {
            _jnlFillsMsg('One or more fill rows are incomplete. Complete or remove them, then split again.', 'danger');
            return;
        }
        if (!confirm('Move ' + markedIdx.length + ' marked row' + (markedIdx.length === 1 ? '' : 's')
            + ' into a new trade?\n\n' + (kept.length - markedIdx.length) + ' row'
            + (kept.length - markedIdx.length === 1 ? '' : 's') + ' stay on this trade with its notes, tags, grade and strategy. '
            + 'The new trade starts without them.')) return;

        // Save pending edits first so the split starts from the saved trade.
        if (_jnlCommitTimer) { clearTimeout(_jnlCommitTimer); _jnlCommitTimer = null; }
        if (_jnlDirty || _jnlFillsDirty) {
            if (!(await _jnlCommitTrade())) {
                _jnlFillsMsg('Your edits didn\'t save, so the split didn\'t run. Try again.', 'danger');
                return;
            }
        }

        var newId = Date.now();
        while (journalData.trades.some(function(t) { return String(t.id) === String(newId); })) newId++;
        var parts = _splitTradeByFills(trade, fills, markedIdx, newId);
        if (!parts) return;

        var splitBtn = document.getElementById('jnl-fills-split-btn');
        if (splitBtn) splitBtn.disabled = true;
        _jnlSplitting = true;
        var failMsg = 'The split didn\'t save. Nothing was changed. Try again.';
        try {
            var cloud = typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave();
            if (cloud) {
                // The bulk save drops a row that fails to map; both must save.
                var uid = window._denariiSupabaseUid;
                if (typeof _mapArrayRow === 'function'
                    && (!_mapArrayRow(uid, 'trades', parts.updated) || !_mapArrayRow(uid, 'trades', parts.created))) {
                    _jnlFillsMsg(failMsg, 'danger');
                    return;
                }
                var res = await _saveTradesToSupabase([parts.updated, parts.created]);
                if (!res || !res.success) {
                    _jnlFillsMsg(failMsg, 'danger');
                    return;
                }
            }
            var before = JSON.parse(JSON.stringify(trade));
            _restoreTradeInPlace(trade, parts.updated);
            journalData.trades.push(parts.created);
            try {
                await saveToIndexedDB();
            } catch (e) {
                if (!cloud) {
                    _restoreTradeInPlace(trade, before);
                    journalData.trades = journalData.trades.filter(function(t) { return t !== parts.created; });
                    _jnlFillsMsg(failMsg, 'danger');
                    return;
                }
                console.warn('[Reflection] Split saved to the cloud; local save failed:', e && e.message);
            }
            if (cloud && typeof _triggerCloudDashRefresh === 'function') _triggerCloudDashRefresh();
        } finally {
            _jnlSplitting = false;
            if (splitBtn) splitBtn.disabled = false;
        }

        _jnlClearDraft(trade.id);
        selectTradeForJournal(trade.id);
        _jnlFillsMsg('Split into 2 trades. The new trade has ' + markedIdx.length + ' row' + (markedIdx.length === 1 ? '' : 's') + '.', 'success');
        renderJournalTradeList();
        if (typeof updateDashboard === 'function') updateDashboard();
    }

    // ── Metrics recalc ────────────────────────────────────────────────────────

    function _jnlRecalcMetrics() {
        var m = _computeTradeMetrics(
            _sfId('jnl-entry-price'), _sfId('jnl-exit-price'), _sfId('jnl-quantity'),
            (document.getElementById('jnl-trade-type') || {}).value || 'long',
            _sfId('jnl-commission-fees') || 0,
            _getRowData('jnl-plan-rows', 'target-price', 'target-qty'),
            _getRowData('jnl-stop-loss-rows',     'stop-price',   'stop-qty'),
            (document.getElementById('jnl-asset-type') || {}).value || 'stock'
        );
        // A trade still open in storage has no realized metrics yet; an
        // unsaved exit price must not preview them.
        var stored = (journalData.trades || []).find(function(t) { return t.id === window._jnlSelectedTradeId; });
        var storedOpen = !!stored && typeof window._isOpenTrade === 'function' && window._isOpenTrade(stored);
        if (storedOpen) {
            m = Object.assign({}, m, { netPnl: null, realizedRMultiple: null, runup: null, drawdown: null });
        }
        _applyMetrics('jnl-metric-', m);
        // Net / Gross / Fees summary (display only). Same open-trade rule:
        // no P&L until the trade is closed and saved.
        _updatePnlSummary('jnl-',
            _sfId('jnl-entry-price'), storedOpen ? null : _sfId('jnl-exit-price'), _sfId('jnl-quantity'),
            (document.getElementById('jnl-trade-type') || {}).value || 'long',
            _sfId('jnl-commission-fees'),
            (document.getElementById('jnl-asset-type') || {}).value || 'stock',
            stored ? stored.feeSource : undefined);
        _jnlUpdatePctGains();
    }

    // ── Tag rows ──────────────────────────────────────────────────────────────

    function addJnlTagRow(category, tagName) {
        const container = document.getElementById('jnl-tag-rows');
        if (!container) return;

        const categories = (journalData.tagCategories || []).filter(c =>
            typeof window.isCategoryFavorite === 'function' ? window.isCategoryFavorite(c) : true
        );
        const tagMap = {};
        (journalData.tags || []).filter(t => t.isFavorite !== false).forEach(t => {
            if (!tagMap[t.category]) tagMap[t.category] = [];
            tagMap[t.category].push(t.name);
        });

        const catOpts = categories.map(c =>
            `<option value="${escapeHtml(c)}" ${c === category ? 'selected' : ''}>${escapeHtml(c)}</option>`
        ).join('');

        const catTags = category ? (tagMap[category] || []) : [];
        const tagOpts = catTags.map(n =>
            `<option value="${escapeHtml(n)}" ${n === tagName ? 'selected' : ''}>${escapeHtml(n)}</option>`
        ).join('');

        const row = document.createElement('div');
        row.className = 'jnl-tag-row';
        row.innerHTML =
            `<select class="jnl-tag-cat" onchange="_jnlOnCategoryChange(this)">` +
                `<option value="">Select category...</option>${catOpts}` +
            `</select>` +
            `<select class="jnl-tag-name"${!category ? ' disabled' : ''}>` +
                (!category
                    ? `<option value="">Select category first</option>`
                    : `<option value="">Select tag...</option>${tagOpts}`) +
            `</select>` +
            `<button type="button" class="btn btn-small plan-remove-btn" onclick="removeJnlTagRow(this)" ` +
            `style="background:var(--danger);color:var(--on-danger);padding:2px 9px;flex-shrink:0;font-size:15px;line-height:1.3;">×</button>`;

        container.appendChild(row);
        _jnlSyncTagRemoveBtns();
    }

    function removeJnlTagRow(btn) {
        const row = btn.closest('.jnl-tag-row');
        if (row) row.remove();
        _jnlSyncTagRemoveBtns();
        // If all rows removed, add one blank row back
        const container = document.getElementById('jnl-tag-rows');
        if (container && !container.querySelector('.jnl-tag-row')) addJnlTagRow();
    }

    function _jnlSyncTagRemoveBtns() {
        const container = document.getElementById('jnl-tag-rows');
        if (!container) return;
        const rows = container.querySelectorAll('.jnl-tag-row');
        rows.forEach(r => {
            const btn = r.querySelector('.plan-remove-btn');
            if (btn) btn.style.visibility = rows.length > 1 ? 'visible' : 'hidden';
        });
    }

    function _jnlOnCategoryChange(catSel) {
        const row = catSel.closest('.jnl-tag-row');
        if (!row) return;
        const tagSel = row.querySelector('.jnl-tag-name');
        if (!tagSel) return;
        const category = catSel.value;
        if (!category) {
            tagSel.innerHTML = '<option value="">Select category first</option>';
            tagSel.disabled = true;
            return;
        }
        const catTags = (journalData.tags || []).filter(t => t.category === category && t.isFavorite !== false);
        tagSel.disabled = false;
        tagSel.innerHTML = `<option value="">Select tag...</option>` +
            catTags.map(t => `<option value="${escapeHtml(t.name)}">${escapeHtml(t.name)}</option>`).join('');
    }

    function _jnlGetTagsFromRows() {
        const container = document.getElementById('jnl-tag-rows');
        if (!container) return [];
        const seen = new Set();
        const result = [];
        container.querySelectorAll('.jnl-tag-row').forEach(row => {
            const cat = (row.querySelector('.jnl-tag-cat')  || {}).value || '';
            const tag = (row.querySelector('.jnl-tag-name') || {}).value || '';
            if (tag && cat) {
                const key = cat + '::' + tag;
                if (!seen.has(key)) { seen.add(key); result.push(tag); }
            }
        });
        return result;
    }

    function _jnlInitTagRows(tagNames) {
        const container = document.getElementById('jnl-tag-rows');
        if (!container) return;
        container.innerHTML = '';
        const names = Array.isArray(tagNames) ? tagNames.filter(Boolean) : [];
        if (!names.length) { addJnlTagRow(); return; }
        const tagCatMap = {};
        (journalData.tags || []).forEach(t => { tagCatMap[t.name] = t.category || 'Custom'; });
        names.forEach(name => addJnlTagRow(tagCatMap[name] || '', name));
    }

    // ── Grade pills ───────────────────────────────────────────────────────────

    const _JNL_GRADES = ['A+', 'A', 'B', 'C', 'D', 'F'];
    const _JNL_GRADE_COLORS = { 'A+': '#22c55e', 'A': '#4ade80', 'B': '#60a5fa', 'C': '#facc15', 'D': '#fb923c', 'F': '#f87171' };

    function _jnlSetGrade(grade) {
        const input = document.getElementById('jnl-trade-grade');
        if (input) input.value = grade;
        const container = document.getElementById('jnl-grade-pills');
        if (!container) return;
        if (!container.children.length) _jnlRenderGradePills();
        container.querySelectorAll('.jnl-grade-pill').forEach(btn => {
            const isSelected = btn.dataset.grade === grade;
            const color = _JNL_GRADE_COLORS[btn.dataset.grade] || 'var(--accent)';
            btn.style.background  = isSelected ? color : 'transparent';
            btn.style.borderColor = isSelected ? color : 'var(--border)';
            btn.style.color       = isSelected ? '#fff' : 'var(--text-secondary)';
            btn.style.fontWeight  = isSelected ? '700' : '500';
        });
    }

    function _jnlRenderGradePills() {
        const container = document.getElementById('jnl-grade-pills');
        if (!container) return;
        container.innerHTML = _JNL_GRADES.map(g => {
            const color = _JNL_GRADE_COLORS[g];
            return `<button type="button" class="jnl-grade-pill"
                data-grade="${g}"
                style="padding:5px 18px;border-radius:20px;border:1px solid var(--border);background:transparent;
                       color:var(--text-secondary);font-size:14px;font-weight:500;cursor:pointer;
                       transition:background 0.15s,border-color 0.15s,color 0.15s;letter-spacing:0.02em;"
                onclick="_jnlSelectGrade('${g}')">${g}</button>`;
        }).join('');
    }

    function _jnlSelectGrade(grade) {
        const input   = document.getElementById('jnl-trade-grade');
        const current = input ? input.value : '';
        // clicking the already-selected grade deselects it
        _jnlSetGrade(current === grade ? '' : grade);
    }

    // ── Editor form submit ────────────────────────────────────────────────────

    (function () {
        const form = document.getElementById('journal-editor-form');
        if (!form) return;
        form.addEventListener('submit', async (e) => {
            e.preventDefault();
            // Flush any pending debounced autosave before the explicit commit
            // so we don't end up running two saves back-to-back.
            if (_jnlCommitTimer) { clearTimeout(_jnlCommitTimer); _jnlCommitTimer = null; }
            const ok = await _jnlCommitTrade({ explicit: true });
            if (!ok) return;

            const btn = e.target.querySelector('[type=submit]');
            const orig = btn.textContent;
            btn.textContent = '✓ Saved';
            btn.disabled = true;
            setTimeout(() => { btn.textContent = orig; btn.disabled = false; }, 2000);
        });
    })();

    // ── Strategy rules checklist ───────────────────────────────────────────────

    var _jnlFollowedRules = [];
    var _jnlSelectedStrategy = null;

    function _jnlLoadStrategyRules(strategyName, existingScore) {
        var checklist = document.getElementById('jnl-strategy-rules-checklist');
        if (!strategyName) {
            if (checklist) checklist.style.display = 'none';
            _jnlSelectedStrategy = null;
            _jnlFollowedRules = [];
            return;
        }
        var strategy = (journalData.strategies || []).find(function(s) { return s.name === strategyName; });
        if (!strategy || !strategy.groups) {
            if (checklist) checklist.style.display = 'none';
            return;
        }

        _jnlSelectedStrategy = strategy;
        _jnlFollowedRules = existingScore ? (existingScore.followedRules || []) : [];

        var trade = journalData.trades.find(function(t) { return t.id === window._jnlSelectedTradeId; });
        var tradePnL = trade ? trade.pnl : 0;
        var outcome = tradePnL > 0 ? 'winner' : tradePnL < 0 ? 'loser' : 'breakeven';

        document.getElementById('jnl-rules-list').innerHTML =
            renderGroupedChecklist(strategy, outcome, _jnlFollowedRules, 'jnl-rule-', '_jnlUpdateRuleScore');

        if (checklist) checklist.style.display = 'block';
        _jnlUpdateRuleScore();
    }

    function _jnlUpdateRuleScore() {
        if (!_jnlSelectedStrategy) return;
        var trade = journalData.trades.find(function(t) { return t.id === window._jnlSelectedTradeId; });
        var tradePnL = trade ? trade.pnl : 0;
        var outcome = tradePnL > 0 ? 'winner' : tradePnL < 0 ? 'loser' : 'breakeven';
        var allRules = _jnlSelectedStrategy.groups.flatMap(function(g) { return g.rules; });
        var scored = allRules.filter(function(r) { return (r.showWhen === 'always' || r.showWhen === outcome) && r.stars > 0; });

        _jnlFollowedRules = [];
        var actualScore = 0, allMandatoryFollowed = true;
        scored.forEach(function(rule) {
            var cb = document.getElementById('jnl-rule-' + rule.id);
            if (cb && cb.checked) {
                _jnlFollowedRules.push(rule.id);
                actualScore += _effectiveStars(rule);
            } else if (rule.isMandatory) {
                allMandatoryFollowed = false;
            }
        });

        var maxScore = scored.reduce(function(s, r) { return s + _effectiveStars(r); }, 0);
        var percentage = maxScore > 0 ? (actualScore / maxScore * 100) : 0;
        var grade = calculateGradeWithMandatory(percentage, allMandatoryFollowed);
        var scoreEl = document.getElementById('jnl-strategy-score');
        if (scoreEl) {
            scoreEl.innerHTML =
                '<span class="grade-badge grade-' + grade.class + '">' + grade.letter + '</span>' +
                '<span style="margin-left:8px;color:var(--text-secondary);">' + actualScore + '/' + maxScore + ' points (' + percentage.toFixed(0) + '%)</span>' +
                (!allMandatoryFollowed ? '<br><span style="color:var(--danger);font-size:12px;">Mandatory rule(s) not followed</span>' : '');
        }
    }

    // ── Trade list pagination navigation ─────────────────────────────────────

    window._jnlListPrevPage = function () {
        if (_jnlListPage > 1) { _jnlListPage--; renderJournalTradeList(); }
    };
    window._jnlListNextPage = function () {
        _jnlListPage++; renderJournalTradeList(); // render() clamps to totalPages
    };
    // Account switch: back to page 1, and leave an open trade outside the new account.
    window._jnlOnAccountChange = function () {
        _jnlListPage = 1;
        var tid = window._jnlSelectedTradeId;
        if (tid && !getGlobalFilteredTrades(journalData.trades).some(function(t) { return t.id === tid; })) jnlBackToTrades();
    };
    window._jnlListResetPage = function () {
        _jnlListPage = 1;
    };

    // ── Window exposures (required for HTML inline handlers) ─────────────────

    window._jnlSetNotes           = _jnlSetNotes;
    window._jnlGetNotes           = _jnlGetNotes;
    // Outside callers (note templates, AI insert) save a draft after changing
    // the notes, so that call also marks the form edited.
    window._jnlSaveDraft          = function(tradeId, html) { _jnlDirty = true; return _jnlSaveDraft(tradeId, html); };
    window._jnlFlushCommit        = _jnlFlushCommit;
    window._jnlClearDraft         = _jnlClearDraft;
    window.jnlCleanUpAI           = jnlCleanUpAI;
    window.initJournalPage        = initJournalPage;
    window.clearJournalFilters    = clearJournalFilters;
    window.renderJournalTradeList = renderJournalTradeList;

    // Mounted once at load. Fill Style here too: the app's first
    // _populateStyleSelects() may already have run.
    DenariiFilters.mountFilterBar(document.getElementById('jnl-filter-bar'), {
        prefix: 'jnl-filter',
        onChange: function() { _jnlListPage = 1; renderJournalTradeList(); }
    });
    if (typeof _populateStyleSelect === 'function') _populateStyleSelect('jnl-filter-style', true);
    window.selectTradeForJournal  = selectTradeForJournal;
    window.jnlRequestUnlock       = jnlRequestUnlock;
    // Shared fill math, also used by the New Trade execution rows grid.
    window._jnlFillMath = {
        pnl: _jnlFillPnl, posPct: _jnlPosPct, gainPct: _jnlFillGainPct, totals: _jnlFillTotals
    };
    window.jnlAddFillRow          = jnlAddFillRow;
    window.jnlUseMultipleFills    = jnlUseMultipleFills;
    window.jnlUseSingleFill       = jnlUseSingleFill;
    window.jnlRemoveFillRow       = jnlRemoveFillRow;
    window.jnlSplitMarkedFills    = jnlSplitMarkedFills;
    window.closeJournalEditor     = closeJournalEditor;
    window.jnlBackToTrades        = jnlBackToTrades;
    window.addJnlTagRow           = addJnlTagRow;
    window.removeJnlTagRow        = removeJnlTagRow;
    window._jnlOnCategoryChange   = _jnlOnCategoryChange;
    window._jnlSelectGrade        = _jnlSelectGrade;
    window._jnlToggleOptionFields = _jnlToggleOptionFields;
    window._jnlRecalcMetrics      = _jnlRecalcMetrics;
    window._jnlLoadStrategyRules  = _jnlLoadStrategyRules;
    window._jnlUpdateRuleScore    = _jnlUpdateRuleScore;

    // ── Init shared toolbar for Trade Reflection editor ──────────────────────
    (function initJnlToolbar() {
        var slot = document.getElementById('jnl-toolbar-slot');
        if (!slot || typeof EditorToolbar === 'undefined') return;
        slot.innerHTML = EditorToolbar.build('jnl-notes');
        // Append fullscreen button inside the toolbar
        var toolbar = slot.querySelector('.rv-toolbar');
        if (toolbar) {
            var fsBtn = document.createElement('button');
            fsBtn.type = 'button';
            fsBtn.className = 'rv-tb-btn';
            fsBtn.id = 'jnl-fs-btn';
            fsBtn.title = 'Fullscreen (Esc to exit)';
            fsBtn.style.marginLeft = 'auto';
            fsBtn.textContent = '⛶';
            fsBtn.onmousedown = function(e) { e.preventDefault(); };
            fsBtn.onclick = function() { if (typeof jnlToggleFullscreen === 'function') jnlToggleFullscreen(); };
            toolbar.appendChild(fsBtn);
        }
    })();

})();
