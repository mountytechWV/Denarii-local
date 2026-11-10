// ── Broker Account Management ────────────────────────────────────────────────
// Extracted from Denarii.js — copy-first (original still present in Denarii.js)
// Dependencies (remain global in Denarii.js):
//   journalData, saveToIndexedDB, updateDashboard,
//   escapeHtml, openModal, closeModal
//
// State variables initialized here as window globals:
//   window.selectedBrokerColor, window.filterBrokerAccountId
//
// Note: window._pendingImportAccountCreate is set by broker import code in Denarii.js.
//   During deletion phase, that setter must be updated to use window._pendingImportAccountCreate.

(function () {

    // ── Module state ──────────────────────────────────────────────────────────

    window.selectedBrokerColor  = '#3b82f6';
    window.filterBrokerAccountId = 'all';

    // ── Constants ─────────────────────────────────────────────────────────────

    // Derive label map from the shared TRADING_STYLES array (Denarii.js)
    const TRADING_STYLE_LABELS = (function () {
        var map = {};
        if (typeof TRADING_STYLES !== 'undefined') {
            for (var i = 0; i < TRADING_STYLES.length; i++) {
                map[TRADING_STYLES[i].value] = TRADING_STYLES[i].label;
            }
        }
        return map;
    })();

    const BROKER_COLOR_PALETTE = ['#3b82f6','#8b5cf6','#f97316','#22c55e','#ef4444','#eab308','#06b6d4','#ec4899'];

    // ── Internal helpers ──────────────────────────────────────────────────────

    function ensureBrokerAccounts() {
        if (!journalData.brokerAccounts) journalData.brokerAccounts = [];
    }

    function getBrokerAccount(id) {
        ensureBrokerAccounts();
        return journalData.brokerAccounts.find(a => a.id === id) || null;
    }

    function generateBrokerAccountId() {
        return 'ba_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    }

    function generateBrokerDisplayName(broker, accountNumber, excludeId) {
        ensureBrokerAccounts();
        if (accountNumber) return `${broker} - ${accountNumber}`;
        const existing = journalData.brokerAccounts.filter(a => a.broker === broker && a.id !== excludeId);
        if (existing.length === 0) return broker;
        return `${broker} #${existing.length + 1}`;
    }

    function getTradeCountForAccount(accountId) {
        return (journalData.trades || []).filter(t => t.brokerAccountId === accountId).length;
    }

    // ── Account-level cash (opening balance + manual deposits/withdrawals) ────
    // Backward-compatible: all new fields are optional. Old saved accounts
    // with no openingBalance / openingBalanceDate / cashAdjustments[] load
    // unchanged and the summary helper just reports zeros.

    function _ensureCashFields(acct) {
        if (!acct) return;
        if (!Array.isArray(acct.cashAdjustments)) acct.cashAdjustments = [];
    }

    function _ensureRecurringFeesFields(acct) {
        if (!acct) return;
        if (!Array.isArray(acct.recurringFees)) acct.recurringFees = [];
    }

    function _genAdjustmentId() {
        return 'adj_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    }

    function _genFeeId() {
        return 'rf_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5);
    }

    // Today in local date as 'YYYY-MM-DD'. Denarii's accrual math uses
    // date-only comparisons so timezones don't matter beyond ±1 day on
    // the exact anniversary boundary.
    function _todayIso() {
        var d = new Date();
        return d.getFullYear()
            + '-' + String(d.getMonth() + 1).padStart(2, '0')
            + '-' + String(d.getDate()).padStart(2, '0');
    }

    // Advance an ISO 'YYYY-MM-DD' by one billing period, with safe
    // last-of-month clamping (e.g. Jan 31 monthly → Feb 28/29).
    function _advanceByFrequency(iso, frequency) {
        if (typeof iso !== 'string' || iso.length < 10) return iso;
        var parts = iso.split('-');
        var y = parseInt(parts[0], 10);
        var m = parseInt(parts[1], 10); // 1-12
        var d = parseInt(parts[2], 10);
        if (!isFinite(y) || !isFinite(m) || !isFinite(d)) return iso;
        var addMonths =
            frequency === 'monthly'   ? 1 :
            frequency === 'quarterly' ? 3 :
            frequency === 'yearly'    ? 12 : 0;
        if (!addMonths) return iso;
        var targetM = m + addMonths;  // still 1-based
        var targetY = y;
        while (targetM > 12) { targetM -= 12; targetY += 1; }
        // Last day of target month: Date(year, month, 0) where month is
        // 0-based-plus-one (i.e. targetM) gives the last day of targetM.
        var lastDay = new Date(targetY, targetM, 0).getDate();
        var clampedD = Math.min(d, lastDay);
        return String(targetY).padStart(4, '0')
            + '-' + String(targetM).padStart(2, '0')
            + '-' + String(clampedD).padStart(2, '0');
    }

    // Accrual rule (start-anchored, whole periods only):
    //   • If fee.active is false           → 0
    //   • If fee.startDate is missing      → 0
    //   • If effectiveEnd < fee.startDate  → 0
    //     where effectiveEnd = min(today, fee.endDate || today)
    //   • Else count complete periods by advancing from startDate by
    //     frequency until cursor > effectiveEnd.
    function _computeFeeAccrual(fee, asOfIso) {
        var out = { periods: 0, amount: 0, accrued: 0 };
        if (!fee || !fee.active) return out;
        var startIso = fee.startDate || '';
        if (!startIso) return out;
        var freq = fee.frequency;
        if (freq !== 'monthly' && freq !== 'quarterly' && freq !== 'yearly') return out;
        var today = asOfIso || _todayIso();
        var effectiveEnd = today;
        if (fee.endDate && fee.endDate < effectiveEnd) effectiveEnd = fee.endDate;
        if (effectiveEnd < startIso) return out;
        var amount = Number(fee.amount) || 0;
        if (!(amount > 0)) return out;
        var periods = 0;
        var cursor  = startIso;
        var maxIters = 2400; // ~200 years of monthly — safety cap
        while (cursor <= effectiveEnd && maxIters-- > 0) {
            periods += 1;
            cursor = _advanceByFrequency(cursor, freq);
        }
        out.periods = periods;
        out.amount  = amount;
        out.accrued = periods * amount;
        return out;
    }

    // Returns { total, perFee: [{ feeId, name, periods, accrued, active }] }
    // for the given account as of today (or a caller-supplied ISO date).
    function getAccountRecurringFeesAccrued(accountId, asOfIso) {
        var acct = getBrokerAccount(accountId);
        if (!acct) return { total: 0, perFee: [] };
        _ensureRecurringFeesFields(acct);
        var today = asOfIso || _todayIso();
        var total = 0;
        var perFee = acct.recurringFees.map(function(f) {
            var r = _computeFeeAccrual(f, today);
            total += r.accrued;
            return { feeId: f.id, name: f.name, periods: r.periods, accrued: r.accrued, active: !!f.active };
        });
        return { total: total, perFee: perFee };
    }

    async function addRecurringFeeEntry(accountId, fee) {
        var acct = getBrokerAccount(accountId);
        if (!acct) throw new Error('Account not found.');
        var name = (fee && fee.name != null ? String(fee.name) : '').trim();
        if (!name) throw new Error('Name is required.');
        var amt = parseFloat(fee && fee.amount);
        if (!(amt > 0) || !isFinite(amt)) throw new Error('Amount must be a positive number.');
        var freq = fee && fee.frequency;
        if (freq !== 'monthly' && freq !== 'quarterly' && freq !== 'yearly') {
            throw new Error('Frequency must be monthly, quarterly, or yearly.');
        }
        var startDate = fee && fee.startDate;
        if (!startDate) throw new Error('Start date is required.');
        _ensureRecurringFeesFields(acct);
        acct.recurringFees.push({
            id:        _genFeeId(),
            name:      name,
            amount:    amt,
            frequency: freq,
            startDate: startDate,
            endDate:   (fee && fee.endDate) ? fee.endDate : null,
            active:    !(fee && fee.active === false),
            note:      (fee && fee.note != null ? String(fee.note) : '').trim()
        });
        if (typeof _saveBrokerAccountToSupabase === 'function') {
            try { await _saveBrokerAccountToSupabase(acct); } catch (e) { /* best-effort */ }
        }
        await saveToIndexedDB();
        return true;
    }

    async function updateRecurringFeeEntry(accountId, feeId, patch) {
        var acct = getBrokerAccount(accountId);
        if (!acct) throw new Error('Account not found.');
        _ensureRecurringFeesFields(acct);
        var fee = acct.recurringFees.find(function(f) { return f.id === feeId; });
        if (!fee) throw new Error('Fee not found.');
        patch = patch || {};
        if (patch.name != null) {
            var n = String(patch.name).trim();
            if (!n) throw new Error('Name is required.');
            fee.name = n;
        }
        if (patch.amount != null) {
            var amt = parseFloat(patch.amount);
            if (!(amt > 0) || !isFinite(amt)) throw new Error('Amount must be a positive number.');
            fee.amount = amt;
        }
        if (patch.frequency != null) {
            if (patch.frequency !== 'monthly' && patch.frequency !== 'quarterly' && patch.frequency !== 'yearly') {
                throw new Error('Frequency must be monthly, quarterly, or yearly.');
            }
            fee.frequency = patch.frequency;
        }
        if (patch.startDate != null) {
            if (!patch.startDate) throw new Error('Start date is required.');
            fee.startDate = patch.startDate;
        }
        if (patch.endDate !== undefined) fee.endDate = patch.endDate || null;
        if (patch.active !== undefined) fee.active = !!patch.active;
        if (patch.note != null) fee.note = String(patch.note).trim();
        if (typeof _saveBrokerAccountToSupabase === 'function') {
            try { await _saveBrokerAccountToSupabase(acct); } catch (e) { /* best-effort */ }
        }
        await saveToIndexedDB();
        return true;
    }

    async function removeRecurringFeeEntry(accountId, feeId) {
        var acct = getBrokerAccount(accountId);
        if (!acct) return false;
        _ensureRecurringFeesFields(acct);
        acct.recurringFees = acct.recurringFees.filter(function(f) { return f.id !== feeId; });
        if (typeof _saveBrokerAccountToSupabase === 'function') {
            try { await _saveBrokerAccountToSupabase(acct); } catch (e) { /* best-effort */ }
        }
        await saveToIndexedDB();
        return true;
    }

    function _fmtMoney(n) {
        var v = Number(n) || 0;
        return (v < 0 ? '-$' : '$') + Math.abs(v).toFixed(2);
    }

    // Returns per-account financial summary:
    //   {
    //     openingBalance, openingBalanceDate,
    //     totalDeposits, totalWithdrawals, netCashFlow,
    //     cashAdjustments,
    //     realizedPnlSinceStart,  // 0 when openingBalanceDate missing
    //     currentAccountValue     // null when openingBalanceDate missing
    //   }
    // or null if the account doesn't exist.
    //
    // Realized P&L Since Start is the sum of pnl over closed trades
    // attached to this account with exitTime on or after
    // openingBalanceDate. Unrealized/open-position P&L is not included
    // (Denarii stores only paired entry/exit trades today; every saved
    // trade with a valid exitTime + numeric pnl is treated as closed).
    //
    // Current Account Value = openingBalance + netCashFlow + realized
    // P&L Since Start, but only when the user has set an opening
    // balance date — otherwise the window for realized P&L is
    // undefined, so we return null rather than fake a number.
    function getAccountCashSummary(accountId) {
        var acct = getBrokerAccount(accountId);
        if (!acct) return null;
        _ensureCashFields(acct);

        var deposits = 0, withdrawals = 0;
        acct.cashAdjustments.forEach(function(adj) {
            var amt = Number(adj && adj.amount) || 0;
            if (!adj || !(amt > 0)) return;
            if (adj.type === 'deposit')    deposits    += amt;
            if (adj.type === 'withdrawal') withdrawals += amt;
        });
        var openingBalance     = Number(acct.openingBalance) || 0;
        var openingBalanceDate = acct.openingBalanceDate || null;
        var netCashFlow        = deposits - withdrawals;

        // Walk all trades once and accumulate both all-time realized
        // P&L for this account AND (when we have an opening date)
        // realized P&L since that date. Same closed-trade gate: requires
        // a finite pnl and a non-empty exitTime. Denarii's matcher only
        // emits paired round-trips, so this is effectively "every
        // stored trade"; the guards are belt-and-suspenders.
        var startIso = openingBalanceDate ? String(openingBalanceDate) : null;
        var trades = (journalData && Array.isArray(journalData.trades)) ? journalData.trades : [];
        var realizedPnlAllTime    = 0;
        var realizedPnlSinceStart = 0;
        for (var i = 0; i < trades.length; i++) {
            var t = trades[i];
            if (!t || t.brokerAccountId !== accountId) continue;
            if (!t.exitTime) continue;
            var pnl = Number(t.pnl);
            if (!isFinite(pnl)) continue;
            realizedPnlAllTime += pnl;
            if (startIso) {
                // Compare by date portion of exitTime (YYYY-MM-DD).
                // Lexical compare works because both sides are ISO.
                var exitDay = String(t.exitTime).slice(0, 10);
                if (exitDay && exitDay >= startIso) {
                    realizedPnlSinceStart += pnl;
                }
            }
        }

        var currentAccountValue = openingBalanceDate
            ? (openingBalance + netCashFlow + realizedPnlSinceStart)
            : null;

        // Phase A: expose the accrued recurring-fee total as a read-only
        // field on the summary. No consumer subtracts it yet — Dashboard
        // and Broker Accounts page Account Value are unchanged. Phase B
        // will flip the subtraction on.
        var accruedRecurringFees = 0;
        try {
            accruedRecurringFees = getAccountRecurringFeesAccrued(accountId).total || 0;
        } catch (e) { /* ignore */ }

        return {
            openingBalance:        openingBalance,
            openingBalanceDate:    openingBalanceDate,
            totalDeposits:         deposits,
            totalWithdrawals:      withdrawals,
            netCashFlow:           netCashFlow,
            cashAdjustments:       acct.cashAdjustments.slice(),
            realizedPnlSinceStart: realizedPnlSinceStart,
            realizedPnlAllTime:    realizedPnlAllTime,
            currentAccountValue:   currentAccountValue,
            accruedRecurringFees:  accruedRecurringFees
        };
    }

    async function setAccountOpeningBalanceData(accountId, amount, date) {
        var acct = getBrokerAccount(accountId);
        if (!acct) return false;
        _ensureCashFields(acct);
        var parsed = parseFloat(amount);
        acct.openingBalance     = isFinite(parsed) ? parsed : 0;
        acct.openingBalanceDate = date || null;
        if (typeof _saveBrokerAccountToSupabase === 'function') {
            try { await _saveBrokerAccountToSupabase(acct); } catch (e) { /* best-effort */ }
        }
        await saveToIndexedDB();
        return true;
    }

    async function addCashAdjustmentEntry(accountId, type, amount, date, note) {
        var acct = getBrokerAccount(accountId);
        if (!acct) throw new Error('Account not found.');
        if (type !== 'deposit' && type !== 'withdrawal') {
            throw new Error('Adjustment type must be deposit or withdrawal.');
        }
        var amt = parseFloat(amount);
        if (!isFinite(amt) || amt <= 0) {
            throw new Error('Amount must be a positive number.');
        }
        _ensureCashFields(acct);
        acct.cashAdjustments.push({
            id:     _genAdjustmentId(),
            type:   type,
            amount: amt,
            date:   date || new Date().toISOString().slice(0, 10),
            note:   (note == null ? '' : String(note)).trim()
        });
        if (typeof _saveBrokerAccountToSupabase === 'function') {
            try { await _saveBrokerAccountToSupabase(acct); } catch (e) { /* best-effort */ }
        }
        await saveToIndexedDB();
        return true;
    }

    async function removeCashAdjustmentEntry(accountId, adjustmentId) {
        var acct = getBrokerAccount(accountId);
        if (!acct) return false;
        _ensureCashFields(acct);
        acct.cashAdjustments = acct.cashAdjustments.filter(function(a) { return a.id !== adjustmentId; });
        if (typeof _saveBrokerAccountToSupabase === 'function') {
            try { await _saveBrokerAccountToSupabase(acct); } catch (e) { /* best-effort */ }
        }
        await saveToIndexedDB();
        return true;
    }

    // ── Balance & Cash modal ──────────────────────────────────────────────────

    function openAccountCashModal(accountId) {
        var acct = getBrokerAccount(accountId);
        if (!acct) return;
        _ensureCashFields(acct);

        var titleEl = document.getElementById('bac-cash-title');
        if (titleEl) titleEl.textContent = 'Cash Ledger — ' + (acct.displayName || acct.broker || 'Account');

        var idEl = document.getElementById('bac-cash-account-id');
        if (idEl) idEl.value = accountId;

        // Prefill opening balance inputs
        var amtEl = document.getElementById('bac-opening-amount');
        if (amtEl) amtEl.value = (acct.openingBalance != null) ? acct.openingBalance : '';
        var dateEl = document.getElementById('bac-opening-date');
        if (dateEl) dateEl.value = acct.openingBalanceDate || '';

        // Reset adjustment form — default date to today
        var adjTypeEl = document.getElementById('bac-adj-type');   if (adjTypeEl) adjTypeEl.value = 'deposit';
        var adjAmtEl  = document.getElementById('bac-adj-amount'); if (adjAmtEl)  adjAmtEl.value  = '';
        var adjDateEl = document.getElementById('bac-adj-date');   if (adjDateEl) adjDateEl.value = new Date().toISOString().slice(0, 10);
        var adjNoteEl = document.getElementById('bac-adj-note');   if (adjNoteEl) adjNoteEl.value = '';

        _renderAccountCashModal(accountId);
        _resetRecurringFeeForm();
        _renderRecurringFeesSection(accountId);
        // Default to the Opening Balance tab on every modal open.
        switchBacTab('opening');
        openModal('broker-account-cash-modal');
    }

    function _renderAccountCashModal(accountId) {
        var summary = getAccountCashSummary(accountId);
        var summaryEl = document.getElementById('bac-cash-summary');
        var listEl    = document.getElementById('bac-cash-list');
        if (!summary) {
            if (summaryEl) summaryEl.textContent = '';
            if (listEl)    listEl.innerHTML = '';
            return;
        }

        if (summaryEl) {
            var asOf = summary.openingBalanceDate
                ? ' (as of ' + new Date(summary.openingBalanceDate + 'T00:00:00').toLocaleDateString() + ')'
                : '';
            var cashBasisTotal = summary.openingBalance + summary.netCashFlow;

            // Modal uses date-anchored, ledger-window labels to stay
            // clearly distinct from the broader Account Value shown
            // on the Dashboard and Broker Accounts page (which uses
            // full all-time realized P&L for the account). The
            // renamed headline "Ledger Value Since Start" and the
            // inline derivation note make that scope explicit.
            var realizedLine = '';
            if (summary.openingBalanceDate) {
                var rp = summary.realizedPnlSinceStart;
                var rpColor = rp >= 0 ? 'var(--success)' : 'var(--danger)';
                var rpSign  = rp >= 0 ? '+' : '';
                var cavColor = summary.currentAccountValue >= 0 ? 'var(--success)' : 'var(--danger)';
                realizedLine = ''
                    + '<div style="margin-top:4px;"><strong>Realized P&amp;L Since Start:</strong> '
                        + '<span style="color:' + rpColor + ';">'
                            + rpSign + _fmtMoney(rp)
                        + '</span></div>'
                    + '<div style="margin-top:6px;padding-top:6px;border-top:1px dashed var(--border);">'
                        + '<strong>Ledger Value Since Start:</strong> '
                        + '<span style="color:' + cavColor + ';font-weight:600;">'
                            + _fmtMoney(summary.currentAccountValue)
                        + '</span>'
                        + ' <span style="color:var(--text-secondary);font-size:11px;">(opening + net cash flow + realized P&amp;L since the opening date; ledger-window view — the Dashboard / Broker Accounts <strong>Account Value</strong> uses full all-time P&amp;L)</span>'
                    + '</div>';
            } else {
                realizedLine = ''
                    + '<div style="margin-top:4px;color:var(--text-secondary);font-size:12px;">'
                        + 'Set an <strong>opening balance date</strong> to calculate Realized P&amp;L Since Start and Ledger Value Since Start. (The Dashboard / Broker Accounts <strong>Account Value</strong> uses full all-time P&amp;L and does not require a start date.)'
                    + '</div>';
            }

            summaryEl.innerHTML = ''
                + '<div><strong>Opening Balance:</strong> ' + _fmtMoney(summary.openingBalance) + asOf + '</div>'
                + '<div style="margin-top:4px;"><strong>Deposits:</strong> ' + _fmtMoney(summary.totalDeposits)
                    + '  ·  <strong>Withdrawals:</strong> ' + _fmtMoney(summary.totalWithdrawals)
                    + '  ·  <strong>Net Cash Flow:</strong> '
                    + '<span style="color:' + (summary.netCashFlow >= 0 ? 'var(--success)' : 'var(--danger)') + ';">'
                    + (summary.netCashFlow >= 0 ? '+' : '') + _fmtMoney(summary.netCashFlow)
                    + '</span></div>'
                + '<div style="margin-top:4px;"><strong>Cash Basis Total:</strong> ' + _fmtMoney(cashBasisTotal)
                    + ' <span style="color:var(--text-secondary);font-size:11px;">(opening + net cash flow; excludes trading P&amp;L)</span></div>'
                + realizedLine;
        }

        if (listEl) {
            if (summary.cashAdjustments.length === 0) {
                listEl.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:8px 0;">No manual deposits or withdrawals yet.</div>';
            } else {
                // Render newest first
                var sorted = summary.cashAdjustments.slice().sort(function(a, b) {
                    return (b.date || '').localeCompare(a.date || '');
                });
                listEl.innerHTML = sorted.map(function(adj) {
                    var isDep = adj.type === 'deposit';
                    var color = isDep ? 'var(--success)' : 'var(--danger)';
                    var sign  = isDep ? '+' : '-';
                    var dateStr = adj.date
                        ? new Date(adj.date + 'T00:00:00').toLocaleDateString()
                        : '';
                    return ''
                        + '<div style="display:grid;grid-template-columns:110px 90px 1fr auto;gap:10px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:13px;">'
                            + '<span style="color:var(--text-secondary);">' + escapeHtml(dateStr) + '</span>'
                            + '<span style="color:' + color + ';font-weight:600;">' + sign + _fmtMoney(adj.amount) + '</span>'
                            + '<span style="color:var(--text-secondary);">' + (adj.note ? escapeHtml(adj.note) : (isDep ? 'Deposit' : 'Withdrawal')) + '</span>'
                            + '<button class="btn btn-small btn-secondary" onclick="deleteAccountCashAdjustment(\'' + adj.id + '\')" style="color:var(--danger);">Delete</button>'
                        + '</div>';
                }).join('');
            }
        }
    }

    async function saveAccountOpeningBalance() {
        var accountId = (document.getElementById('bac-cash-account-id') || {}).value || '';
        if (!accountId) return;
        var amount = (document.getElementById('bac-opening-amount') || {}).value || '';
        var date   = (document.getElementById('bac-opening-date')   || {}).value || '';
        try {
            await setAccountOpeningBalanceData(accountId, amount, date);
            _renderAccountCashModal(accountId);
            renderBrokerAccountsList();
        } catch (e) {
            alert('Could not save opening balance: ' + (e && e.message ? e.message : e));
        }
    }

    async function addAccountCashAdjustment() {
        var accountId = (document.getElementById('bac-cash-account-id') || {}).value || '';
        if (!accountId) return;
        var type   = (document.getElementById('bac-adj-type')   || {}).value || 'deposit';
        var amount = (document.getElementById('bac-adj-amount') || {}).value || '';
        var date   = (document.getElementById('bac-adj-date')   || {}).value || '';
        var note   = (document.getElementById('bac-adj-note')   || {}).value || '';
        try {
            await addCashAdjustmentEntry(accountId, type, amount, date, note);
            // Reset amount + note; keep type + date so adding several
            // similar entries in a row is quick.
            var amtEl = document.getElementById('bac-adj-amount'); if (amtEl) amtEl.value = '';
            var noteEl = document.getElementById('bac-adj-note');  if (noteEl) noteEl.value = '';
            _renderAccountCashModal(accountId);
            renderBrokerAccountsList();
        } catch (e) {
            alert('Could not add adjustment: ' + (e && e.message ? e.message : e));
        }
    }

    async function deleteAccountCashAdjustment(adjustmentId) {
        var accountId = (document.getElementById('bac-cash-account-id') || {}).value || '';
        if (!accountId || !adjustmentId) return;
        if (!confirm('Delete this cash adjustment? This cannot be undone.')) return;
        try {
            await removeCashAdjustmentEntry(accountId, adjustmentId);
            _renderAccountCashModal(accountId);
            renderBrokerAccountsList();
        } catch (e) {
            alert('Could not delete adjustment: ' + (e && e.message ? e.message : e));
        }
    }

    // ── Cash Ledger modal tab system ──────────────────────────────────────────
    // Three panes: opening | adjustments | fees. Only one visible at a time.
    // The summary block stays above the tabs so it's always in view.

    function switchBacTab(tabKey) {
        // Toggle pane visibility
        document.querySelectorAll('.bac-tab-pane').forEach(function(pane) {
            pane.style.display = (pane.dataset.bacPane === tabKey) ? '' : 'none';
        });
        // Toggle tab button active styling
        document.querySelectorAll('.bac-tab-btn').forEach(function(btn) {
            var isActive = btn.dataset.bacTab === tabKey;
            btn.style.color = isActive ? 'var(--text-primary)' : 'var(--text-secondary)';
            btn.style.borderBottomColor = isActive ? 'var(--primary, #3b82f6)' : 'transparent';
        });
    }

    // ── Recurring Fees UI (inside Cash Ledger modal, Phase A) ─────────────────

    function _renderRecurringFeesSection(accountId) {
        var listEl    = document.getElementById('bac-fees-list');
        var accruedEl = document.getElementById('bac-fees-accrued');
        if (!listEl || !accruedEl) return;
        var acct = getBrokerAccount(accountId);
        if (!acct) return;
        _ensureRecurringFeesFields(acct);

        if (acct.recurringFees.length === 0) {
            listEl.innerHTML = '<div style="color:var(--text-secondary);font-size:12px;padding:4px 0 8px;">No recurring fees on this account yet.</div>';
            accruedEl.style.display = 'none';
            return;
        }

        // Sort: active first, then by startDate desc.
        var sorted = acct.recurringFees.slice().sort(function(a, b) {
            if (!!a.active !== !!b.active) return a.active ? -1 : 1;
            return (b.startDate || '').localeCompare(a.startDate || '');
        });

        listEl.innerHTML = sorted.map(function(f) {
            var freqSuffix = f.frequency === 'monthly' ? '/mo'
                           : f.frequency === 'quarterly' ? '/qtr'
                           : '/yr';
            var startLabel = f.startDate
                ? 'from ' + new Date(f.startDate + 'T00:00:00').toLocaleDateString()
                : '';
            var endLabel = f.endDate
                ? ' · until ' + new Date(f.endDate + 'T00:00:00').toLocaleDateString()
                : '';
            var activeBadge = f.active
                ? '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:rgba(34,197,94,0.15);color:var(--success);font-weight:600;">Active</span>'
                : '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg-secondary);color:var(--text-secondary);font-weight:600;border:1px solid var(--border);">Paused</span>';
            var noteLine = f.note
                ? '<div style="color:var(--text-secondary);font-size:11px;margin-top:2px;">' + escapeHtml(f.note) + '</div>'
                : '';
            return ''
                + '<div style="display:grid;grid-template-columns:1fr auto auto auto;gap:8px;align-items:center;padding:6px 0;border-bottom:1px solid var(--border);font-size:12px;">'
                    + '<div>'
                        + '<span style="font-weight:600;">' + escapeHtml(f.name || '') + '</span> '
                        + activeBadge
                        + '<div style="color:var(--text-secondary);font-size:11px;margin-top:2px;">'
                            + '$' + (Number(f.amount) || 0).toFixed(2) + freqSuffix
                            + (startLabel ? '  ·  ' + startLabel : '')
                            + endLabel
                        + '</div>'
                        + noteLine
                    + '</div>'
                    + '<button type="button" class="btn btn-small btn-secondary" onclick="toggleRecurringFeeActive(\'' + f.id + '\')" style="padding:2px 8px;font-size:11px;">'
                        + (f.active ? 'Pause' : 'Resume')
                    + '</button>'
                    + '<button type="button" class="btn btn-small btn-secondary" onclick="editRecurringFee(\'' + f.id + '\')" style="padding:2px 8px;font-size:11px;">Edit</button>'
                    + '<button type="button" class="btn btn-small btn-secondary" onclick="deleteRecurringFee(\'' + f.id + '\')" style="color:var(--danger);padding:2px 8px;font-size:11px;">Delete</button>'
                + '</div>';
        }).join('');

        var totalAccrued = getAccountRecurringFeesAccrued(accountId).total || 0;
        accruedEl.innerHTML = 'Accrued to date: <strong>$' + totalAccrued.toFixed(2) + '</strong>'
            + ' <span style="color:var(--text-secondary);font-size:11px;">(subtracted from Account Value on the Dashboard and Broker Accounts page)</span>';
        accruedEl.style.display = '';
    }

    function _resetRecurringFeeForm() {
        var formEl = document.getElementById('bac-fee-form');
        var btnEl  = document.getElementById('bac-fee-add-btn');
        if (formEl) formEl.style.display = 'none';
        if (btnEl)  btnEl.style.display = '';
        var ids = ['bac-fee-id','bac-fee-name','bac-fee-amount','bac-fee-start','bac-fee-end','bac-fee-note'];
        ids.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        var freq = document.getElementById('bac-fee-frequency'); if (freq) freq.value = 'monthly';
        var act  = document.getElementById('bac-fee-active');    if (act)  act.checked = true;
    }

    function openAddRecurringFee() {
        _resetRecurringFeeForm();
        var startEl = document.getElementById('bac-fee-start');
        if (startEl && !startEl.value) startEl.value = _todayIso();
        var formEl = document.getElementById('bac-fee-form');
        var btnEl  = document.getElementById('bac-fee-add-btn');
        if (formEl) formEl.style.display = '';
        if (btnEl)  btnEl.style.display  = 'none';
        var nameEl = document.getElementById('bac-fee-name');
        if (nameEl) nameEl.focus();
    }

    function cancelRecurringFeeForm() {
        _resetRecurringFeeForm();
    }

    function editRecurringFee(feeId) {
        var accountId = (document.getElementById('bac-cash-account-id') || {}).value || '';
        var acct = getBrokerAccount(accountId);
        if (!acct) return;
        _ensureRecurringFeesFields(acct);
        var fee = acct.recurringFees.find(function(f) { return f.id === feeId; });
        if (!fee) return;
        _resetRecurringFeeForm();
        document.getElementById('bac-fee-id').value        = feeId;
        document.getElementById('bac-fee-name').value      = fee.name || '';
        document.getElementById('bac-fee-amount').value    = fee.amount != null ? fee.amount : '';
        document.getElementById('bac-fee-frequency').value = fee.frequency || 'monthly';
        document.getElementById('bac-fee-start').value     = fee.startDate || '';
        document.getElementById('bac-fee-end').value       = fee.endDate   || '';
        document.getElementById('bac-fee-active').checked  = fee.active !== false;
        document.getElementById('bac-fee-note').value      = fee.note || '';
        document.getElementById('bac-fee-form').style.display = '';
        document.getElementById('bac-fee-add-btn').style.display = 'none';
    }

    async function saveRecurringFeeForm() {
        var accountId = (document.getElementById('bac-cash-account-id') || {}).value || '';
        if (!accountId) return;
        var feeId = (document.getElementById('bac-fee-id') || {}).value || '';
        var payload = {
            name:      (document.getElementById('bac-fee-name')      || {}).value,
            amount:    (document.getElementById('bac-fee-amount')    || {}).value,
            frequency: (document.getElementById('bac-fee-frequency') || {}).value || 'monthly',
            startDate: (document.getElementById('bac-fee-start')     || {}).value || '',
            endDate:   (document.getElementById('bac-fee-end')       || {}).value || null,
            active:    !!(document.getElementById('bac-fee-active')  || {}).checked,
            note:      (document.getElementById('bac-fee-note')      || {}).value
        };
        try {
            if (feeId) {
                await updateRecurringFeeEntry(accountId, feeId, payload);
            } else {
                await addRecurringFeeEntry(accountId, payload);
            }
            _resetRecurringFeeForm();
            _renderRecurringFeesSection(accountId);
        } catch (e) {
            alert('Could not save recurring fee: ' + (e && e.message ? e.message : e));
        }
    }

    async function deleteRecurringFee(feeId) {
        var accountId = (document.getElementById('bac-cash-account-id') || {}).value || '';
        if (!accountId || !feeId) return;
        if (!confirm('Delete this recurring fee? Its history will stop accruing here.')) return;
        try {
            await removeRecurringFeeEntry(accountId, feeId);
            _renderRecurringFeesSection(accountId);
        } catch (e) {
            alert('Could not delete recurring fee: ' + (e && e.message ? e.message : e));
        }
    }

    async function toggleRecurringFeeActive(feeId) {
        var accountId = (document.getElementById('bac-cash-account-id') || {}).value || '';
        if (!accountId || !feeId) return;
        var acct = getBrokerAccount(accountId);
        if (!acct) return;
        _ensureRecurringFeesFields(acct);
        var fee = acct.recurringFees.find(function(f) { return f.id === feeId; });
        if (!fee) return;
        try {
            await updateRecurringFeeEntry(accountId, feeId, { active: !fee.active });
            _renderRecurringFeesSection(accountId);
        } catch (e) {
            alert('Could not update recurring fee: ' + (e && e.message ? e.message : e));
        }
    }

    // ── Render broker accounts list (Settings page) ───────────────────────────

    function getLastTradeDate(accountId) {
        const trades = (journalData.trades || []).filter(t => t.brokerAccountId === accountId);
        if (trades.length === 0) return null;
        let latest = null;
        for (const t of trades) {
            const d = t.exitTime || t.entryTime;
            if (d && (!latest || d > latest)) latest = d;
        }
        return latest;
    }

    function formatRelativeDate(isoStr) {
        if (!isoStr) return 'Never';
        const d = new Date(isoStr);
        const now = new Date();
        const diffMs = now - d;
        const days = Math.floor(diffMs / 86400000);
        if (days === 0) return 'Today';
        if (days === 1) return 'Yesterday';
        if (days < 30) return days + ' days ago';
        if (days < 365) return Math.floor(days / 30) + ' mo ago';
        return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short' });
    }

    function renderBrokerAccountsList() {
        ensureBrokerAccounts();
        const list  = document.getElementById('broker-accounts-list');
        const empty = document.getElementById('broker-accounts-empty');
        if (!list) return;

        if (journalData.brokerAccounts.length === 0) {
            list.innerHTML = '';
            if (empty) empty.style.display = '';
            return;
        }
        if (empty) empty.style.display = 'none';

        list.innerHTML = journalData.brokerAccounts.map(acct => {
            const count = getTradeCountForAccount(acct.id);
            const isHidden = acct.visible === false;
            const lastDate = getLastTradeDate(acct.id);

            // Status badges
            let badges = '';
            if (acct.isDefault) badges += '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--primary);color:var(--on-primary);font-weight:600;">Default</span> ';
            if (acct.isDemo)    badges += '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--warning);color:#000;font-weight:600;">Demo</span> ';
            if (isHidden)       badges += '<span style="font-size:10px;padding:1px 6px;border-radius:4px;background:var(--bg-secondary);color:var(--text-secondary);font-weight:600;border:1px solid var(--border);">Hidden</span> ';

            // Optional balance summary line — only render when the user
            // has set an opening balance or recorded any adjustments.
            const cash = getAccountCashSummary(acct.id);
            let balanceLine = '';
            // Broker Accounts page summary line — matches the Dashboard
            // Account Value meaning exactly:
            //     Account Value = openingBalance
            //                   + netCashFlow
            //                   + realizedPnlAllTime
            // openingBalanceDate no longer gates this figure on the
            // page; the Cash Ledger modal retains its date-aware rows.
            // The separate "Realized P&L" chip has been removed for
            // this task — only Opening Balance, Net Cash Flow, and
            // Account Value are surfaced on the card.
            if (cash) {
                const acctValue = (Number(cash.openingBalance)       || 0)
                                + (Number(cash.netCashFlow)          || 0)
                                + (Number(cash.realizedPnlAllTime)   || 0)
                                - (Number(cash.accruedRecurringFees) || 0);
                const hasCashData  = cash.openingBalance !== 0 || cash.cashAdjustments.length > 0;
                const hasRealizedP = Number(cash.realizedPnlAllTime) !== 0;
                if (hasCashData || hasRealizedP) {
                    const netColor = cash.netCashFlow >= 0 ? 'var(--success)' : 'var(--danger)';
                    const netSign  = cash.netCashFlow >= 0 ? '+' : '';
                    const avColor  = acctValue       >= 0 ? 'var(--success)' : 'var(--danger)';
                    balanceLine = `
                        <div class="ba-meta" style="font-size:12px;">
                            <span><strong>Opening Balance:</strong> ${_fmtMoney(cash.openingBalance)}</span>
                            <span style="color:${netColor};"><strong>Net Cash Flow:</strong> ${netSign}${_fmtMoney(cash.netCashFlow)}</span>
                            <span style="color:${avColor};"><strong>Account Value:</strong> ${_fmtMoney(acctValue)}</span>
                            <span style="color:var(--text-secondary);">${cash.cashAdjustments.length} cash adjustment${cash.cashAdjustments.length === 1 ? '' : 's'}</span>
                        </div>
                    `;
                }
            }

            return `
            <div class="broker-account-card" style="margin-bottom:10px;border-left:3px solid ${acct.color};${isHidden ? 'opacity:0.6;' : ''}">
                <div class="ba-info">
                    <div class="ba-name" style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
                        <span class="broker-dot" style="background:${acct.color};"></span>
                        ${escapeHtml(acct.displayName)}
                        ${badges}
                    </div>
                    <div class="ba-meta">
                        <span>${escapeHtml(acct.broker)}</span>
                        ${acct.accountNumber ? `<span>#${escapeHtml(acct.accountNumber)}</span>` : ''}
                        <span class="style-badge ${acct.tradingStyle}">${TRADING_STYLE_LABELS[acct.tradingStyle] || acct.tradingStyle}</span>
                        <span>${count} trade${count !== 1 ? 's' : ''}</span>
                        <span style="color:var(--text-secondary);">Updated ${formatRelativeDate(wbCardLastSync.get(String(acct.id)) || lastDate)}</span>
                    </div>
                    ${balanceLine}
                    ${wbCardNeedsApproval.has(String(acct.id)) ? '<div class="ba-meta" style="font-size:12px;' + WB_WARN_STYLE + '">Webull needs re-approval</div>' : ''}
                    ${_wbCardReviewHtml(acct.id)}
                </div>
                <div class="ba-actions" style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                    ${acct.isDemo
                        ? '<button class="btn btn-small btn-secondary" onclick="toggleBrokerVisibility(\'' + acct.id + '\')" title="' + (isHidden ? 'Show in app' : 'Hide from app') + '" style="font-size:14px;padding:4px 8px;">' + (isHidden ? '👁' : '👁‍🗨') + '</button>'
                        + '<button class="btn btn-small btn-secondary" onclick="openAccountCashModal(\'' + acct.id + '\')">Cash Ledger</button>'
                        + '<button class="btn btn-small btn-secondary" onclick="deleteDemoBroker()" style="color:var(--danger);">Delete</button>'
                        : '<button class="btn btn-small btn-secondary" onclick="toggleBrokerVisibility(\'' + acct.id + '\')" title="' + (isHidden ? 'Show in app' : 'Hide from app') + '" style="font-size:14px;padding:4px 8px;">' + (isHidden ? '👁' : '👁‍🗨') + '</button>'
                        + '<button class="btn btn-small btn-secondary" onclick="openAccountCashModal(\'' + acct.id + '\')">Cash Ledger</button>'
                        + '<button class="btn btn-small btn-secondary" onclick="editBrokerAccount(\'' + acct.id + '\')">Edit</button>'
                        + '<button class="btn btn-small btn-secondary" onclick="deleteBrokerAccount(\'' + acct.id + '\')" style="color:var(--danger);">Delete</button>'}
                </div>
            </div>`;
        }).join('');
        _wbRefreshCardFlags();
    }

    // ── Color picker & broker select helpers ──────────────────────────────────

    function selectBrokerColor(btn) {
        document.querySelectorAll('#ba-color-picker .color-btn').forEach(b => {
            b.classList.remove('selected');
            b.style.border = '2px solid transparent';
        });
        btn.classList.add('selected');
        btn.style.border = '2px solid #fff';
        window.selectedBrokerColor = btn.dataset.color;
    }

    function handleBrokerSelect(sel) {
        const customGroup = document.getElementById('ba-custom-broker-group');
        customGroup.style.display = sel.value === '__custom__' ? '' : 'none';
    }

    // ── Open / edit broker account modal ─────────────────────────────────────

    function openBrokerAccountModal(editId) {
        const form = document.getElementById('broker-account-form');
        form.reset();
        document.getElementById('ba-edit-id').value = '';
        document.getElementById('ba-custom-broker-group').style.display = 'none';
        document.getElementById('ba-visible').checked = true;
        window.selectedBrokerColor = '#3b82f6';
        document.querySelectorAll('#ba-color-picker .color-btn').forEach(b => {
            b.classList.remove('selected');
            b.style.border = '2px solid transparent';
            if (b.dataset.color === '#3b82f6') { b.classList.add('selected'); b.style.border = '2px solid #fff'; }
        });

        if (editId) {
            const acct = getBrokerAccount(editId);
            if (!acct) return;
            document.getElementById('broker-account-modal-title').textContent = 'Edit Broker Account';
            document.getElementById('ba-edit-id').value = editId;

            // Check if broker is in predefined list
            const brokerSelect = document.getElementById('ba-broker');
            const predefined = Array.from(brokerSelect.options).some(o => o.value === acct.broker);
            if (predefined) {
                brokerSelect.value = acct.broker;
            } else {
                brokerSelect.value = '__custom__';
                document.getElementById('ba-custom-broker-group').style.display = '';
                document.getElementById('ba-custom-broker').value = acct.broker;
            }

            document.getElementById('ba-account-number').value  = acct.accountNumber || '';
            document.getElementById('ba-display-name').value    = acct.displayName || '';
            document.getElementById('ba-trading-style').value   = acct.tradingStyle || 'day_trading';
            document.getElementById('ba-is-default').checked    = !!acct.isDefault;
            document.getElementById('ba-visible').checked       = acct.visible !== false;
            window.selectedBrokerColor = acct.color || '#3b82f6';
            document.querySelectorAll('#ba-color-picker .color-btn').forEach(b => {
                b.classList.remove('selected');
                b.style.border = '2px solid transparent';
                if (b.dataset.color === window.selectedBrokerColor) { b.classList.add('selected'); b.style.border = '2px solid #fff'; }
            });
        } else {
            document.getElementById('broker-account-modal-title').textContent = 'Add Broker Account';
            // If no accounts exist, default the "set as default" checkbox on
            if (journalData.brokerAccounts.length === 0) {
                document.getElementById('ba-is-default').checked = true;
            }
        }

        _wbInitSection(editId || null);
        openModal('broker-account-modal');
        if (editId) _baGuardOpen(editId);
        else if (typeof _editorGuardClose === 'function') _editorGuardClose('broker-account-editor');
    }

    // Batch 2: re-sync guard for the open account form. A re-sync that
    // replaces the account reloads a clean form; Save while it is stale
    // keeps this version as a conflict copy and loads the newer one instead.
    // Add/remove fees and cash entries change the current record directly,
    // so they need no guard.
    function _baFormValues() {
        const brokerSelect = document.getElementById('ba-broker').value;
        return {
            broker: brokerSelect === '__custom__' ? document.getElementById('ba-custom-broker').value.trim() : brokerSelect,
            accountNumber: document.getElementById('ba-account-number').value.trim(),
            displayName:   document.getElementById('ba-display-name').value.trim(),
            tradingStyle:  document.getElementById('ba-trading-style').value,
            isDefault:     document.getElementById('ba-is-default').checked,
            visible:       document.getElementById('ba-visible').checked,
            color:         window.selectedBrokerColor
        };
    }

    function _baStaleSave(editId) {
        _editorGuardConflict('broker-account-editor', Object.assign({}, getBrokerAccount(editId) || { id: editId }, _baFormValues()));
        openBrokerAccountModal(editId);
    }

    function _baGuardOpen(editId) {
        if (typeof _editorGuardOpen !== 'function') return;
        const openSig = JSON.stringify(_baFormValues());
        _editorGuardOpen('broker-account-editor', 'brokerAccounts', String(editId), {
            isOpen: () => document.getElementById('ba-edit-id').value === String(editId) &&
                document.getElementById('broker-account-modal').classList.contains('active'),
            isDirty: () => JSON.stringify(_baFormValues()) !== openSig,
            reload: () => openBrokerAccountModal(editId),
            resolve: () => _baStaleSave(editId)
        });
    }

    function editBrokerAccount(id) {
        openBrokerAccountModal(id);
    }

    // ── Webull link (per-journal import settings) ────────────────────────────
    // Reads and writes the link through window.denariiWebull (status, setLink,
    // removeLink); main runs the sync and the page applies each window (see
    // js/services/webull-sync.js). Saved by Save Account: the link is checked
    // first, then the account and the link are saved (see _wbRunSave). The
    // link itself never touches trades; only the Needs review actions do,
    // through WebullSync.resolveReview.

    const WB_APPROVE_MSG  = 'Webull needs re-approval. Go to Settings → Integrations to approve again.';
    const WB_CONNECT_MSG  = 'Connect Webull in Settings → Integrations to link this account.';
    const WB_LOAD_MSG     = 'Could not load the Webull link. Close and reopen this account to try again.';
    const WB_SAVE_MSG     = 'Could not save the Webull link. Try again.';
    const WB_LINK_FAILED_MSG = 'Account saved, but the Webull link was not.';
    const BA_LOCAL_ONLY_MSG = 'Saved in this browser only. Not synced to the cloud.';
    const WB_BUSY_MSG     = 'Wait for the Webull link to finish saving, then save again.';
    const WB_SYNC_BUSY_MSG = 'A Webull sync is already running.';
    const WB_DATE_MSG     = 'Enter a start date between 2018-05-21 and today, or leave it empty.';
    const WB_REMOVE_CONFIRM = 'Remove the Webull link from this account? Trades already imported stay as they are.';
    const WB_START_WARN   = 'Existing imported trades will not be deleted. Moving the date earlier imports older history; moving it later only affects future syncs.';
    const WB_STATUS_LABELS = { ok: 'OK', error: 'Error', running: 'Running', needs_approval: 'Needs approval', busy: 'Webull busy', offline: 'Offline' };
    // A link's last error is shown only for these statuses; a later success
    // clears it, so an older failure never shows after it.
    const WB_ERROR_STATUSES = ['error', 'busy', 'offline', 'needs_approval'];
    const WB_HISTORY_START = '2018-05-21';
    // The expiry line turns amber this long before the approval expires.
    const WB_EXPIRY_WARN_MS = 3 * 24 * 60 * 60 * 1000;
    // Amber text that stays readable on light themes.
    const WB_WARN_STYLE = 'color:color-mix(in srgb, var(--warning) 50%, var(--text-primary));';

    // Main is running a sync (from 'run' status events). Outlives modal
    // reopen (wbUi resets per open).
    let wbSyncRunning = false;

    // Linked journals whose cards show "Webull needs re-approval" (the
    // connection is not approved). Refreshed from status() at most every
    // WB_CARD_TTL_MS, or right after a sync; the list re-renders only when
    // the set changes.
    const WB_CARD_TTL_MS = 30 * 1000;
    let wbCardNeedsApproval = new Set();
    // Journal id -> lastSyncedAt for linked journals that have synced;
    // the card's "Updated" shows it instead of the last trade date.
    let wbCardLastSync = new Map();
    let wbCardCheckedAt = 0;
    let wbCardChecking = false;
    // Bumps on sign-out/Lock so a check still in flight is dropped.
    let wbCardGen = 0;

    // Sign-out/Lock: forget the card lines so another account never sees
    // them. They reload on the next check after sign-in.
    function _clearBrokerCardCache() {
        wbCardGen++;
        wbCardNeedsApproval = new Set();
        wbCardLastSync = new Map();
        wbCardCheckedAt = 0;
        wbCardChecking = false;
    }

    async function _wbRefreshCardFlags(force) {
        if (wbCardChecking || (!force && Date.now() - wbCardCheckedAt < WB_CARD_TTL_MS)) return;
        const gen = wbCardGen;
        wbCardChecking = true;
        const s = await _wbStatus();
        if (gen !== wbCardGen) return;   // signed out while checking
        wbCardChecking = false;
        wbCardCheckedAt = Date.now();
        if (!s) return;   // unknown: keep the current lines
        const links = Array.isArray(s.links) ? s.links.filter(l => l && l.journalId) : [];
        const syncNext = new Map(links.filter(l => l.lastSyncedAt).map(l => [String(l.journalId), l.lastSyncedAt]));
        const next = new Set(s.connected && s.approvalState !== 'ok' ? links.map(l => String(l.journalId)) : []);
        const syncChanged = syncNext.size !== wbCardLastSync.size
            || [...syncNext].some(([id, at]) => wbCardLastSync.get(id) !== at);
        wbCardLastSync = syncNext;
        const changed = next.size !== wbCardNeedsApproval.size || [...next].some(id => !wbCardNeedsApproval.has(id));
        wbCardNeedsApproval = next;
        if (changed || syncChanged) renderBrokerAccountsList();
    }

    const wbUi = {
        seq: 0,              // bumps on every modal open; stale async results are dropped
        journalId: null,
        status: null,        // denariiWebull.status() result
        row: null,           // this journal's entry in status.links, or null
        rowLoaded: false,
        loadError: null,
        draft: { accountId: '', startDate: '' },
        busy: false,
        reviewBusy: false,   // a review action is saving
        msg: null,
        msgType: 'info'
    };

    // Desktop only: the preload exposes window.denariiWebull.
    function _wbUnavailable() {
        return !window.denariiWebull;
    }

    // status(), or null when unavailable or it failed.
    async function _wbStatus() {
        if (_wbUnavailable()) return null;
        try {
            const s = await window.denariiWebull.status();
            return s && typeof s.connected === 'boolean' ? s : null;
        } catch (e) { return null; }
    }

    // ── New York market-date helpers (DST-aware) ──

    function _wbNyParts(ms) {
        const parts = new Intl.DateTimeFormat('en-US', {
            timeZone: 'America/New_York', hourCycle: 'h23',
            year: 'numeric', month: '2-digit', day: '2-digit',
            hour: '2-digit', minute: '2-digit', second: '2-digit'
        }).formatToParts(new Date(ms));
        const o = {};
        parts.forEach(p => { if (p.type !== 'literal') o[p.type] = Number(p.value); });
        if (o.hour === 24) o.hour = 0;
        return o;
    }

    function _wbNyDate(ms) {
        if (!isFinite(ms)) return '';
        const p = _wbNyParts(ms);
        return p.year + '-' + String(p.month).padStart(2, '0') + '-' + String(p.day).padStart(2, '0');
    }

    // Main checks start dates against today in UTC.
    function _wbTodayUtc() {
        return new Date().toISOString().slice(0, 10);
    }

    // '' (all history) or a real 'YYYY-MM-DD' between 2018-05-21 and today.
    function _wbValidStartDate(d) {
        if (d === '') return true;
        const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(d || '');
        if (!m) return false;
        const t = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
        if (t.toISOString().slice(0, 10) !== d) return false;
        return d >= WB_HISTORY_START && d <= _wbTodayUtc();
    }

    function _wbSavedDate() {
        return wbUi.row ? String(wbUi.row.startDate || '') : '';
    }

    // A new link starts from the date chosen when Webull was connected.
    function _wbResetDraft() {
        const r = wbUi.row;
        const s = wbUi.status;
        wbUi.draft = {
            accountId: r ? String(r.webullAccountId || '') : '',
            startDate: r ? _wbSavedDate() : String((s && s.defaultStartDate) || '')
        };
    }

    function _wbIsDirty() {
        const r = wbUi.row, d = wbUi.draft;
        if (!r) return !!d.accountId;
        return d.accountId !== String(r.webullAccountId || '') || d.startDate !== _wbSavedDate();
    }

    function _wbBrokerIsWebull() {
        const sel = document.getElementById('ba-broker');
        if (!sel) return false;
        if (sel.value === 'Webull') return true;
        const custom = document.getElementById('ba-custom-broker');
        return sel.value === '__custom__' && !!custom && custom.value.trim().toLowerCase() === 'webull';
    }

    function _wbHasImportedTrades(journalId) {
        const trades = (typeof journalData !== 'undefined' && Array.isArray(journalData.trades)) ? journalData.trades : [];
        return trades.some(t => t && t.brokerAccountId === journalId && t.source === 'webull');
    }

    // Id of another journal linked to this Webull account in status.links, or null.
    function _wbLinkedElsewhere(status, journalId, accountId) {
        const links = status && Array.isArray(status.links) ? status.links : [];
        const other = links.find(l => l && String(l.webullAccountId) === String(accountId) && String(l.journalId) !== String(journalId));
        return other ? String(other.journalId) : null;
    }

    function _wbAlreadyLinkedMsg(otherId) {
        const accts = (typeof journalData !== 'undefined' && journalData && Array.isArray(journalData.brokerAccounts)) ? journalData.brokerAccounts : [];
        const a = otherId ? accts.find(x => x && String(x.id) === otherId) : null;
        const name = a ? (a.displayName || a.broker) : '';
        return 'This Webull account is linked to ' + (name ? '"' + name + '"' : 'another journal') + '. Unlink it there first (its trades stay).';
    }

    // Warns when another journal holds trades imported from this Webull
    // account on or after the start date (New York market dates). Every
    // imported trade's externalId is 'webull:<journal>:<account>:<order>',
    // so this still works after that journal is unlinked. '' otherwise.
    function _wbOverlapNote(journalId, accountId, startDate, trades, accounts) {
        if (!accountId || !startDate || !Array.isArray(trades)) return '';
        const mark = ':' + accountId + ':';
        let newest = '', otherId = null;
        trades.forEach(t => {
            if (!t || t.source !== 'webull' || String(t.brokerAccountId) === String(journalId)) return;
            const ext = String(t.externalId || '');
            if (ext.indexOf('webull:') !== 0 || ext.indexOf(mark) === -1) return;
            const times = [t.entryTime, t.exitTime].map(v => Date.parse(v || '')).filter(isFinite);
            if (!times.length) return;
            const day = _wbNyDate(Math.max.apply(null, times));
            if (day > newest) { newest = day; otherId = String(t.brokerAccountId); }
        });
        if (!newest || startDate > newest) return '';
        const a = Array.isArray(accounts) ? accounts.find(x => x && String(x.id) === otherId) : null;
        const name = a ? (a.displayName || a.broker) : 'Another journal';
        const p = newest.split('-').map(Number);
        const when = new Date(Date.UTC(p[0], p[1] - 1, p[2], 12))
            .toLocaleDateString(undefined, { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' });
        return name + ' already has trades from this account through ' + when + '. An earlier start date will copy them here too.';
    }

    function _wbSection() {
        let el = document.getElementById('ba-webull-section');
        if (!el) {
            const form = document.getElementById('broker-account-form');
            const anchor = document.getElementById('ba-edit-id');
            if (!form || !anchor) return null;
            el = document.createElement('div');
            el.id = 'ba-webull-section';
            el.style.cssText = 'margin-top:16px;padding-top:16px;border-top:1px solid var(--border);';
            // Needs review buttons (re-rendered often), handled in one place.
            el.addEventListener('click', e => {
                const b = e.target && e.target.closest ? e.target.closest('[data-wb-review]') : null;
                if (b && !b.disabled) _wbReviewAction(b.dataset.wbReview, b.dataset.wbArg);
            });
            form.insertBefore(el, anchor);
        }
        return el;
    }

    function _wbInitSection(editId) {
        wbUi.seq++;
        wbUi.journalId = editId;
        wbUi.status = null;
        wbUi.row = null;
        wbUi.rowLoaded = false;
        wbUi.loadError = null;
        wbUi.busy = false;
        wbUi.reviewBusy = false;
        wbUi.msg = null;
        _wbResetDraft();
        _wbRender();
        if (editId && !_wbUnavailable()) _wbLoad(wbUi.seq, editId);
    }

    // One status() call (local database, no Webull call). keepDraft keeps
    // unsaved edits when this is a refresh after a sync.
    async function _wbLoad(seq, journalId, keepDraft) {
        const s = await _wbStatus();
        if (seq !== wbUi.seq) return;
        const keep = keepDraft && wbUi.rowLoaded && _wbIsDirty();
        wbUi.status = s;
        wbUi.loadError = s ? null : WB_LOAD_MSG;
        wbUi.row = s && Array.isArray(s.links) ? (s.links.find(l => l && l.journalId === journalId) || null) : null;
        wbUi.rowLoaded = true;
        if (!keep) _wbResetDraft();
        _wbRender();
    }

    function _wbOnBrokerChange() {
        if (!document.getElementById('ba-webull-section')) return;
        _wbRender();
    }

    function _wbFmtLocal(iso) {
        const ms = Date.parse(iso || '');
        return isFinite(ms) ? new Date(ms).toLocaleString() : 'Never';
    }

    function _wbProgressText(progress) {
        return (progress && typeof WebullSync !== 'undefined' && typeof WebullSync.progressText === 'function') ? WebullSync.progressText(progress) : '';
    }

    function _wbStatusText(r) {
        const s = wbUi.status;
        if (!s || !s.connected) return 'Not connected';
        return (r && WB_STATUS_LABELS[r.status]) || 'Never';
    }

    function _wbRender() {
        const el = _wbSection();
        if (!el) return;
        const r = wbUi.row;
        const show = !_wbUnavailable() && (!!r || _wbBrokerIsWebull());
        el.style.display = show ? '' : 'none';
        if (!show) { el.innerHTML = ''; return; }

        const muted = 'color:var(--text-secondary);font-size:13px;';
        let html = '<h3 style="font-size:15px;margin-bottom:8px;">Webull link</h3>';

        if (!wbUi.journalId) {
            el.innerHTML = html + '<p style="' + muted + '">Save this account first, then choose Edit to link Webull.</p>';
            return;
        }
        if (!wbUi.rowLoaded) {
            el.innerHTML = html + '<p style="' + muted + '">Loading Webull link…</p>';
            return;
        }
        if (wbUi.loadError) {
            el.innerHTML = html + '<div class="alert alert-danger" style="margin-bottom:0;">' + escapeHtml(wbUi.loadError) + '</div>';
            return;
        }

        const s = wbUi.status;
        const d = wbUi.draft;
        const connected = !!(s && s.connected);
        const approvalOk = connected && s.approvalState === 'ok';
        const needsApproval = connected && s.approvalState !== 'ok';
        const accounts = connected && Array.isArray(s.accounts) ? s.accounts : [];
        const savedId = r ? String(r.webullAccountId || '') : '';
        const busy = wbUi.busy;

        // Notices
        if (!connected) {
            html += '<div class="alert alert-info" style="margin-bottom:12px;">' + escapeHtml(WB_CONNECT_MSG) + '</div>';
        } else if (needsApproval || (r && r.status === 'needs_approval')) {
            html += '<div class="alert alert-warning" style="margin-bottom:12px;">' + escapeHtml(WB_APPROVE_MSG) + '</div>';
        }

        // Account options: labels only. A saved account that isn't in the
        // list stays selectable so a save never silently changes it.
        let options = '<option value="">Not linked</option>';
        let savedListed = false;
        accounts.forEach(a => {
            if (!a || a.id == null) return;
            const id = String(a.id);
            if (id === savedId) savedListed = true;
            options += '<option value="' + escapeHtml(id) + '"' + (id === d.accountId ? ' selected' : '') + '>' +
                escapeHtml(String(a.label || 'Webull account')) + '</option>';
        });
        if (savedId && !savedListed) {
            options += '<option value="' + escapeHtml(savedId) + '"' + (savedId === d.accountId ? ' selected' : '') + '>' +
                'Linked Webull account (unavailable)</option>';
        }

        // Account select is usable to link (connected) or to pick "Not
        // linked"; the date needs a connected Webull.
        const selDis  = (busy || (!connected && !savedId)) ? ' disabled' : '';
        const editDis = (busy || !connected) ? ' disabled' : '';

        html +=
            '<div class="form-group">' +
                '<label for="ba-wb-account">Linked Webull account</label>' +
                '<select id="ba-wb-account"' + selDis + '>' + options + '</select>' +
            '</div>' +
            '<div class="form-group">' +
                '<label for="ba-wb-start">Import trades starting from</label>' +
                '<input type="date" id="ba-wb-start" min="' + WB_HISTORY_START + '" max="' + _wbTodayUtc() + '" value="' + escapeHtml(d.startDate) + '"' + editDis + '>' +
                '<div style="' + muted + 'margin-top:4px;">Leave empty to import all history.</div>' +
                '<div id="ba-wb-overlap" style="' + WB_WARN_STYLE + 'font-size:13px;margin-top:4px;display:none;"></div>' +
            '</div>';

        if (r) {
            // While approval is needed the notice above is the only message.
            const showErr = r.error && WB_ERROR_STATUSES.indexOf(r.status) !== -1
                && !needsApproval && r.status !== 'needs_approval';
            html += '<div style="' + muted + 'margin-bottom:12px;line-height:1.6;">' +
                '<div>Last synced: ' + escapeHtml(_wbFmtLocal(r.lastSyncedAt)) + '</div>' +
                '<div>Status: <span id="ba-wb-status">' + escapeHtml(_wbStatusText(r)) + '</span></div>' +
                '<div id="ba-wb-progress"' + (r.progress ? '' : ' style="display:none;"') + '>' + escapeHtml(_wbProgressText(r.progress)) + '</div>' +
                (approvalOk ? _wbExpiryHtml(s.approvalExpiresAt, Date.now()) : '') +
                (showErr ? '<div style="color:var(--danger);">' + escapeHtml(String(r.error)) + '</div>' : '') +
                _wbLastResultHtml(wbUi.journalId) +
            '</div>';
            html += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;">' +
                    '<button type="button" id="ba-wb-sync" class="btn btn-small btn-secondary">Sync now</button>' +
                '</div>';
        }
        html += _wbReviewHtml(wbUi.journalId);

        if (wbUi.msg) {
            html += '<div class="alert alert-' + wbUi.msgType + '" style="margin-bottom:12px;">' + escapeHtml(wbUi.msg) + '</div>';
        }

        html += '<div style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                '<span id="ba-wb-dirty" style="' + muted + '">Unsaved Webull link changes</span>' +
            '</div>';

        el.innerHTML = html;

        document.getElementById('ba-wb-account')?.addEventListener('change', e => { wbUi.draft.accountId = e.target.value; _wbUpdateActions(); });
        const startEl = document.getElementById('ba-wb-start');
        startEl?.addEventListener('input', e => { wbUi.draft.startDate = e.target.value; _wbUpdateActions(); });
        startEl?.addEventListener('change', e => { wbUi.draft.startDate = e.target.value; _wbUpdateActions(); });
        document.getElementById('ba-wb-sync')?.addEventListener('click', _wbSyncNow);
        _wbUpdateActions();
    }

    // ── Needs review (fills and edits the sync held back) ──
    // Lists WebullSync.reviewItems for this journal; each action saves the
    // journal through WebullSync.resolveReview and the item goes away only
    // after that save succeeded.

    const WB_USE_WEBULL_CONFIRM = 'Replace this trade\'s quantity, prices, times and fees with Webull\'s values and apply the held fills? Notes, tags and strategy are kept.';
    const WB_IGNORE_CONFIRM = 'Ignore these orders? They won\'t be imported, now or in later syncs.';
    const WB_NO_BASE_TITLE = 'Webull\'s values from the last sync weren\'t saved for this trade.';

    function _wbReview(journalId) {
        if (!journalId || typeof WebullSync === 'undefined' || typeof WebullSync.reviewItems !== 'function') return null;
        if (typeof journalData === 'undefined' || !journalData) return null;
        return WebullSync.reviewItems(journalData, journalId);
    }

    // Card line: "Webull: 2 need review (Edit to resolve)", or ''.
    function _wbCardReviewHtml(journalId) {
        const r = _wbReview(journalId);
        if (!r || !r.count) return '';
        return '<div class="ba-meta" style="font-size:12px;' + WB_WARN_STYLE + '">Webull: ' + r.count + ' need review (Edit to resolve)</div>';
    }

    function _wbReasonLabel(reason) {
        if (typeof WebullSync !== 'undefined' && reason === WebullSync.BEFORE_EXISTING) return 'Before earliest Webull trade';
        return 'Edited after import';
    }

    function _wbNum(v) {
        const n = Number(v);
        return isFinite(n) ? n.toLocaleString(undefined, { maximumFractionDigits: 4 }) : '?';
    }

    function _wbDay(iso) {
        const ms = Date.parse(iso || '');
        return isFinite(ms) ? new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' }) : '?';
    }

    // "AAPL · Jul 2, 2026 · SELL · 10 @ 12"
    function _wbFillLine(f) {
        return [f.symbol || '?', _wbDay(f.filledAt), f.positionIntent || f.side || '?',
            _wbNum(f.filledQty) + ' @ ' + _wbNum(f.filledPrice)].join(' · ');
    }

    function _wbTradeLine(t) {
        const side = (t.type || t.direction) === 'short' ? 'Short' : 'Long';
        return [t.contractName || t.symbol || '?', _wbDay(t.entryTime), side,
            _wbNum(t.quantity) + ' @ ' + _wbNum(t.entryPrice)].join(' · ');
    }

    // "Last sync: 3 imported, 1 updated, 2 held for review, 0 skipped" from
    // the last window applied this session. '' before any.
    function _wbLastResultHtml(journalId) {
        const res = (typeof WebullSync !== 'undefined' && typeof WebullSync.lastResult === 'function') ? WebullSync.lastResult(journalId) : null;
        if (!res) return '';
        if (!res.ok) return '<div style="color:var(--danger);">Last sync not saved: ' + escapeHtml(String(res.error || 'unknown error')) + '</div>';
        return '<div>Last sync: ' + res.created + ' imported, ' + res.updated + ' updated, ' +
            res.review + ' held for review, ' + res.skipped + ' skipped</div>';
    }

    function _wbReviewHtml(journalId) {
        const rv = _wbReview(journalId);
        if (!rv || !rv.count) return '';
        const dis = wbUi.reviewBusy ? ' disabled' : '';
        const muted = 'color:var(--text-secondary);font-size:13px;';
        const box = 'border:1px solid var(--border);border-radius:8px;padding:8px 10px;margin-bottom:8px;font-size:13px;';
        const btn = (action, arg, label, extra) => '<button type="button" class="btn btn-small btn-secondary" data-wb-review="' + action +
            '" data-wb-arg="' + escapeHtml(String(arg)) + '"' + (extra || dis) + '>' + label + '</button>';
        const reason = text => ' · <span style="' + WB_WARN_STYLE + '">' + escapeHtml(text) + '</span>';
        const fillRows = entries => entries.map(e => '<div style="' + muted + 'margin-left:12px;">Held: ' + escapeHtml(_wbFillLine(e.fill)) + '</div>').join('');

        let html = '<div id="ba-wb-review" style="margin-bottom:12px;">' +
            '<div style="font-weight:600;font-size:14px;margin-bottom:6px;' + WB_WARN_STYLE + '">Needs review (' + rv.count + ')</div>';
        rv.edited.forEach(item => {
            const webullDis = item.canUseWebull ? dis : ' disabled title="' + escapeHtml(WB_NO_BASE_TITLE) + '"';
            html += '<div style="' + box + '">' +
                '<div>' + escapeHtml(_wbTradeLine(item.trade)) + reason('Edited after import') + '</div>' +
                fillRows(item.entries) +
                '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">' +
                    btn('keep', item.trade.id, 'Keep my edits') +
                    btn('webull', item.trade.id, 'Use Webull\'s data', webullDis) +
                '</div></div>';
        });
        rv.held.forEach(g => {
            html += '<div style="' + box + '">' +
                g.entries.map(e => '<div>' + escapeHtml(_wbFillLine(e.fill)) + reason(_wbReasonLabel(e.reason)) + '</div>').join('') +
                '<div style="display:flex;gap:8px;flex-wrap:wrap;margin-top:6px;">' +
                    btn('import', g.id, 'Import') +
                    btn('ignore', g.id, 'Ignore') +
                '</div></div>';
        });
        return html + '</div>';
    }

    async function _wbReviewAction(action, arg) {
        if (wbUi.reviewBusy || typeof WebullSync === 'undefined' || typeof WebullSync.resolveReview !== 'function') return;
        if (action === 'webull' && !confirm(WB_USE_WEBULL_CONFIRM)) return;
        if (action === 'ignore' && !confirm(WB_IGNORE_CONFIRM)) return;
        const seq = wbUi.seq;
        wbUi.reviewBusy = true;
        _wbSetMsg(null);
        _wbRender();
        const args = (action === 'keep' || action === 'webull') ? { tradeId: arg } : { groupId: arg };
        let res;
        try {
            res = await WebullSync.resolveReview(wbUi.journalId, action, args,
                { webullAccountId: wbUi.row ? String(wbUi.row.webullAccountId || '') : null });
        } catch (e) {
            res = { ok: false, error: (e && e.message) || 'Could not resolve.' };
        }
        renderBrokerAccountsList();
        if (seq !== wbUi.seq) return;
        wbUi.reviewBusy = false;
        _wbSetMsg(res.ok ? res.message : res.error, res.ok ? 'success' : 'danger');
        _wbRender();
    }

    // Status, progress and Sync now in place, so a progress event never
    // re-renders the inputs the user may be typing in.
    function _wbPaintProgress() {
        const r = wbUi.row;
        if (!r) return;
        const st = document.getElementById('ba-wb-status');
        if (st) st.textContent = _wbStatusText(r);
        const pr = document.getElementById('ba-wb-progress');
        if (pr) {
            pr.textContent = _wbProgressText(r.progress);
            pr.style.display = r.progress ? '' : 'none';
        }
        _wbUpdateActions();
    }

    // "Webull approval expires Nov 3, 2026", amber within WB_EXPIRY_WARN_MS.
    // '' when the expiry is unknown.
    function _wbExpiryHtml(iso, nowMs) {
        const ms = Date.parse(iso || '');
        if (!isFinite(ms)) return '';
        const soon = ms - nowMs < WB_EXPIRY_WARN_MS;
        const text = 'Webull approval expires ' + new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
        return '<div' + (soon ? ' style="' + WB_WARN_STYLE + '"' : '') + '>' + escapeHtml(text) + '</div>';
    }

    // Sync now needs a saved, unchanged link, a connected and approved
    // Webull, and no sync running.
    function _wbCanSync() {
        const s = wbUi.status;
        if (wbSyncRunning || wbUi.busy || !wbUi.row || !wbUi.rowLoaded || wbUi.loadError || _wbIsDirty()) return false;
        if (wbUi.row.status === 'running') return false;
        return !!(s && s.connected && s.approvalState === 'ok');
    }

    // Asks main to sync this journal. Progress and the result arrive as
    // status events (_wbOnStatus).
    async function _wbSyncNow() {
        if (!_wbCanSync()) return;
        const seq = wbUi.seq;
        wbUi.busy = true;
        _wbSetMsg(null);
        _wbRender();
        let res = null;
        try { res = await window.denariiWebull.syncNow(wbUi.journalId); } catch (e) { res = null; }
        if (seq !== wbUi.seq) return;
        wbUi.busy = false;
        if (res && res.ok && res.busy) _wbSetMsg(WB_SYNC_BUSY_MSG, 'info');
        else if (res && res.ok) wbSyncRunning = true;
        else _wbSetMsg((res && typeof res.error === 'string' && res.error) || WB_SAVE_MSG, 'danger');
        _wbRender();
    }

    // Main's progress and status events. A finished journal or run reloads
    // status (last sync time, error) for the open modal and the cards.
    function _wbOnStatus(ev) {
        if (!ev || typeof ev !== 'object') return;
        const r = wbUi.row;
        const mine = !!r && ev.journalId === r.journalId;
        if (ev.kind === 'run') {
            wbSyncRunning = !!ev.running;
            if (ev.running) { _wbUpdateActions(); return; }
            renderBrokerAccountsList();   // cards recount the imported trades
            _wbRefreshCardFlags(true);
            if (wbUi.journalId && wbUi.rowLoaded && !wbUi.busy) _wbLoad(wbUi.seq, wbUi.journalId, true);
        } else if (ev.kind === 'progress' && mine) {
            r.progress = ev;
            r.status = 'running';
            _wbPaintProgress();
        } else if (ev.kind === 'journal' && mine) {
            r.status = ev.status || null;
            r.error = ev.error || null;
            if (ev.status === 'running') { _wbPaintProgress(); return; }
            r.progress = null;
            if (!wbUi.busy) _wbLoad(wbUi.seq, wbUi.journalId, true);
        }
    }

    // A link change Save Account must write: the section is shown, status
    // loaded, and the draft differs from the saved link. A draft with no
    // account and no saved link has nothing to save.
    function _wbLinkChanged() {
        if (!wbUi.journalId || !wbUi.rowLoaded || wbUi.loadError) return false;
        if (!wbUi.row && !_wbBrokerIsWebull()) return false;
        return _wbIsDirty();
    }

    function _wbUpdateActions() {
        const syncBtn = document.getElementById('ba-wb-sync');
        if (syncBtn) {
            syncBtn.disabled = !_wbCanSync();
            syncBtn.textContent = (wbSyncRunning || (wbUi.row && wbUi.row.status === 'running')) ? 'Syncing…' : 'Sync now';
        }
        const hint = document.getElementById('ba-wb-dirty');
        if (hint) hint.style.display = (!wbUi.busy && _wbIsDirty()) ? '' : 'none';
        const overlap = document.getElementById('ba-wb-overlap');
        if (overlap) {
            const jd = typeof journalData !== 'undefined' && journalData ? journalData : {};
            const note = _wbOverlapNote(wbUi.journalId, wbUi.draft.accountId, wbUi.draft.startDate, jd.trades, jd.brokerAccounts);
            overlap.textContent = note;
            overlap.style.display = note ? '' : 'none';
        }
    }

    function _wbSetMsg(text, type) {
        wbUi.msg = text || null;
        wbUi.msgType = type || 'info';
    }

    // Save Account with a Webull link change: the link is checked first so a
    // link error stops the whole save, then the account is saved, then the
    // link. If the link write fails the modal stays open with the draft.
    // Returns 'blocked', 'link-failed' or 'saved'.
    async function _wbRunSave(deps) {
        let plan = null;
        if (deps.linkChanged()) {
            plan = await deps.prepare();
            if (!plan) return 'blocked';
        }
        await deps.saveAccount();
        if (plan) {
            const err = await deps.commit(plan);
            if (err) {
                deps.refresh();
                deps.showLinkError(WB_LINK_FAILED_MSG + ' ' + err);
                return 'link-failed';
            }
        }
        deps.close();
        return 'saved';
    }

    // Checks a link change before anything is saved. Returns the plan for
    // _wbCommitSave, or null when the whole save must stop (the reason is
    // shown in the section; a cancelled confirm shows nothing new).
    async function _wbPrepareSave() {
        const fail = text => { _wbSetMsg(text, 'danger'); _wbRender(); return null; };
        if (wbUi.busy) return fail(WB_BUSY_MSG);

        const seq = wbUi.seq;
        const journalId = wbUi.journalId;
        const row = wbUi.row;
        const d = Object.assign({}, wbUi.draft);

        // Remove link: trades are untouched.
        if (!d.accountId) {
            if (!confirm(WB_REMOVE_CONFIRM)) return null;
            return { seq: seq, journalId: journalId, remove: true };
        }

        if (!_wbValidStartDate(d.startDate)) return fail(WB_DATE_MSG);
        const startChanged = !!row && d.startDate !== _wbSavedDate();
        if (startChanged && _wbHasImportedTrades(journalId) && !confirm(WB_START_WARN)) return null;

        // One journal per Webull account: two would import every fill twice.
        // Main enforces this too.
        const otherId = _wbLinkedElsewhere(wbUi.status, journalId, d.accountId);
        if (otherId) return fail(_wbAlreadyLinkedMsg(otherId));

        return { seq: seq, journalId: journalId, accountId: d.accountId, startDate: d.startDate || null };
    }

    // Writes a link change checked by _wbPrepareSave, then starts a sync for
    // a new or changed link. Returns null when saved, or the error text (the
    // draft is kept). Never touches trades.
    async function _wbCommitSave(plan) {
        const seq = plan.seq, journalId = plan.journalId;
        wbUi.busy = true; _wbSetMsg(null); _wbRender();
        let res = null;
        try {
            res = plan.remove
                ? await window.denariiWebull.removeLink(journalId)
                : await window.denariiWebull.setLink({ journalId: journalId, webullAccountId: plan.accountId, startDate: plan.startDate });
        } catch (e) { res = null; }
        const ok = !!(res && res.ok);
        if (ok && !plan.remove) {
            try { await window.denariiWebull.syncNow(journalId); } catch (e) { /* the next 15-minute run picks it up */ }
        }
        if (ok) _wbRefreshCardFlags(true);
        if (seq !== wbUi.seq) return null;
        wbUi.busy = false;
        if (!ok) {
            _wbRender();
            return (res && typeof res.error === 'string' && res.error) || WB_SAVE_MSG;
        }
        await _wbLoad(seq, journalId);
        return null;
    }

    document.getElementById('ba-broker')?.addEventListener('change', _wbOnBrokerChange);
    document.getElementById('ba-custom-broker')?.addEventListener('input', _wbOnBrokerChange);
    if (window.denariiWebull && typeof window.denariiWebull.onStatus === 'function') window.denariiWebull.onStatus(_wbOnStatus);

    var _toggleVisBusy = false;

    async function toggleBrokerVisibility(id) {
        if (_toggleVisBusy) return;
        const acct = getBrokerAccount(id);
        if (!acct) return;

        // Flip in-memory state immediately (before any await) so every
        // code path that reads journalData.brokerAccounts — including
        // getGlobalFilteredTrades and _cloudDashGetFilters — sees the
        // updated visibility even if the user navigates to Dashboard
        // before the async save finishes.
        var prevVisible = acct.visible;
        acct.visible = prevVisible === false ? true : false;

        // Optimistic UI: re-render broker list, rebuild dropdowns, and
        // kick off dashboard refresh synchronously. All of this runs
        // before the first await so the UI is consistent immediately.
        _toggleVisBusy = true;
        renderBrokerAccountsList();
        populateBrokerAccountDropdowns();
        if (typeof window._invalidateCloudDash === 'function') window._invalidateCloudDash();
        updateDashboard();

        // Cloud-primary: persist visibility change to Supabase
        if (typeof _saveBrokerAccountToSupabase === 'function') {
            try { await _saveBrokerAccountToSupabase(acct); } catch (e) {
                console.warn('[Denarii] Broker visibility cloud save failed:', e.message || e);
            }
        }

        // Persist in background — rollback on failure
        try {
            await saveToIndexedDB();
        } catch (e) {
            console.warn('[Denarii] Broker visibility save failed — rolling back:', e.message || e);
            acct.visible = prevVisible;
            renderBrokerAccountsList();
            populateBrokerAccountDropdowns();
            if (typeof window._invalidateCloudDash === 'function') window._invalidateCloudDash();
            updateDashboard();
        } finally {
            _toggleVisBusy = false;
        }
    }

    // ── Delete broker account ─────────────────────────────────────────────────

    // Orphan-detection helper: counts trades whose brokerAccountId does
    // not match any existing account. Trades with empty/null/undefined
    // brokerAccountId are "unlinked" (legacy manual trades) and are not
    // flagged as orphans — only trades that reference a specific id that
    // no longer exists in journalData.brokerAccounts are counted.
    function _getOrphanedTradeCount() {
        var trades   = (journalData && Array.isArray(journalData.trades))          ? journalData.trades          : [];
        var accounts = (journalData && Array.isArray(journalData.brokerAccounts))  ? journalData.brokerAccounts  : [];
        var validIds = {};
        accounts.forEach(function(a) { if (a && a.id) validIds[a.id] = true; });
        var orphaned = 0;
        for (var i = 0; i < trades.length; i++) {
            var t = trades[i];
            if (!t || !t.brokerAccountId) continue;
            if (!validIds[t.brokerAccountId]) orphaned++;
        }
        return orphaned;
    }

    function _warnIfOrphans() {
        var n = _getOrphanedTradeCount();
        if (n > 0) {
            alert(
                'Warning: ' + n + ' trade' + (n === 1 ? '' : 's')
                + ' now reference a broker account that no longer exists.\n\n'
                + 'These trades still count toward Total P&L on the Dashboard, '
                + 'but they are not included in any account\u2019s Account Value.\n\n'
                + 'To fix this, open each affected trade in Edit Trade and '
                + 'assign it to an active broker account.'
            );
        }
    }

    var _pendingDeleteBrokerId = null;

    async function deleteBrokerAccount(id) {
        ensureBrokerAccounts();
        const acct = getBrokerAccount(id);
        if (!acct) return;
        if (acct.isDemo) {
            if (typeof deleteDemoBroker === 'function') deleteDemoBroker();
            return;
        }
        const count = getTradeCountForAccount(id);
        if (count === 0) {
            if (!confirm('Delete "' + acct.displayName + '"?')) return;
            // Cloud-primary: delete from Supabase first
            if (typeof _deleteBrokerAccountFromSupabase === 'function') {
                var _bdRes;
                try { _bdRes = await _deleteBrokerAccountFromSupabase(id); } catch (e) {
                    console.warn('[Denarii] Broker cloud delete failed:', e.message || e);
                    _bdRes = { success: false, error: e.message || String(e) };
                }
                // Stop with nothing changed; local modes get "not available" here and carry on.
                if (_bdRes && !_bdRes.success && typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                    alert('Failed to delete: ' + (_bdRes.error || 'unknown error') + '\nYour data was not changed. Please try again.');
                    return;
                }
            }
            journalData.brokerAccounts = journalData.brokerAccounts.filter(a => a.id !== id);
            if (typeof window._clearAllDrafts === 'function') window._clearAllDrafts();
            await saveToIndexedDB();
            renderBrokerAccountsList();
            populateBrokerAccountDropdowns();
            if (typeof window._invalidateCloudDash === 'function') window._invalidateCloudDash();
            updateDashboard();
            return;
        }

        // Broker has trades — show explicit choice modal
        _pendingDeleteBrokerId = id;

        var msgEl = document.getElementById('broker-delete-msg');
        if (msgEl) msgEl.textContent = '"' + acct.displayName + '" has ' + count + ' trade' + (count !== 1 ? 's' : '') + '. Choose how to handle them before deleting this broker.';

        // Populate reassignment dropdown — exclude the broker being deleted and demo
        var sel = document.getElementById('broker-delete-reassign-select');
        var reassignBtn = document.getElementById('broker-delete-reassign-btn');
        var reassignGroup = document.getElementById('broker-delete-reassign-group');
        if (sel) {
            var targets = journalData.brokerAccounts.filter(function(a) {
                return a.id !== id && !a.isDemo;
            });
            sel.innerHTML = '';
            if (targets.length === 0) {
                sel.innerHTML = '<option value="">No available accounts</option>';
                if (reassignBtn) reassignBtn.disabled = true;
                if (reassignGroup) reassignGroup.style.display = 'none';
            } else {
                targets.forEach(function(a) {
                    var opt = document.createElement('option');
                    opt.value = a.id;
                    opt.textContent = a.displayName || a.broker;
                    sel.appendChild(opt);
                });
                if (reassignBtn) reassignBtn.disabled = false;
                if (reassignGroup) reassignGroup.style.display = '';
            }
        }

        openModal('broker-delete-modal');
    }

    async function confirmBrokerDeleteReassign() {
        var id = _pendingDeleteBrokerId;
        if (!id) return;
        var sel = document.getElementById('broker-delete-reassign-select');
        var targetId = sel ? sel.value : '';
        if (!targetId) { alert('Please select a broker account to reassign trades to.'); return; }

        var targetAcct = getBrokerAccount(targetId);
        if (!targetAcct) {
            alert('The target account no longer exists. Close this dialog and try again.');
            return;
        }
        var sourceAcct = getBrokerAccount(id);
        var count = getTradeCountForAccount(id);
        if (!confirm('Reassign ' + count + ' trade' + (count !== 1 ? 's' : '') + ' from "' + (sourceAcct ? sourceAcct.displayName : 'this broker') + '" to "' + (targetAcct ? targetAcct.displayName : targetId) + '" and delete the broker?')) return;

        // Reassign trades locally
        var reassignedTrades = [];
        journalData.trades.forEach(function(t) {
            if (t.brokerAccountId === id) {
                t.brokerAccountId = targetId;
                reassignedTrades.push(t);
            }
        });

        // Cloud-primary: save reassigned trades, then delete the broker
        if (typeof _saveTradesToSupabase === 'function' && reassignedTrades.length > 0) {
            var _raRes;
            try { _raRes = await _saveTradesToSupabase(reassignedTrades); } catch (e) {
                console.warn('[Denarii] Reassigned trades cloud save failed:', e.message || e);
                _raRes = { success: false, error: e.message || String(e) };
            }
            // Stop before deleting the broker; local modes get "not available" here and carry on.
            if (_raRes && !_raRes.success && typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                reassignedTrades.forEach(function(t) { t.brokerAccountId = id; });
                alert('Failed to reassign trades: ' + (_raRes.error || 'unknown error') + '\nYour data was not changed. Please try again.');
                return;
            }
        }
        if (typeof _deleteBrokerAccountFromSupabase === 'function') {
            try { await _deleteBrokerAccountFromSupabase(id); } catch (e) {
                console.warn('[Denarii] Broker cloud delete failed:', e.message || e);
            }
        }

        journalData.brokerAccounts = journalData.brokerAccounts.filter(function(a) { return a.id !== id; });
        if (typeof window._clearAllDrafts === 'function') window._clearAllDrafts();

        _pendingDeleteBrokerId = null;
        closeModal('broker-delete-modal');
        await saveToIndexedDB();
        renderBrokerAccountsList();
        populateBrokerAccountDropdowns();
        if (typeof window._invalidateCloudDash === 'function') window._invalidateCloudDash();
        updateDashboard();
        _warnIfOrphans();
    }

    async function confirmBrokerDeleteAll() {
        var id = _pendingDeleteBrokerId;
        if (!id) return;
        var acct = getBrokerAccount(id);
        var count = getTradeCountForAccount(id);
        if (!confirm('Permanently delete "' + (acct ? acct.displayName : 'this broker') + '" and all ' + count + ' of its trade' + (count !== 1 ? 's' : '') + '?\n\nThis cannot be undone.')) return;

        // Cloud-primary: delete trades from Supabase first, then the broker
        var tradeIdsToDelete = journalData.trades
            .filter(function(t) { return t.brokerAccountId === id; })
            .map(function(t) { return t.id; });
        if (typeof _deleteTradesFromSupabase === 'function' && tradeIdsToDelete.length > 0) {
            var _tdRes;
            try { _tdRes = await _deleteTradesFromSupabase(tradeIdsToDelete); } catch (e) {
                console.warn('[Denarii] Broker trades cloud delete failed:', e.message || e);
                _tdRes = { success: false, error: e.message || String(e) };
            }
            // Stop before deleting the broker; the broker and its trades stay.
            // Local modes get "not available" here and carry on.
            if (_tdRes && !_tdRes.success && typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                alert('Failed to delete: ' + (_tdRes.error || 'unknown error') + '\nYour data was not changed. Please try again.');
                return;
            }
        }
        if (typeof _deleteBrokerAccountFromSupabase === 'function') {
            try { await _deleteBrokerAccountFromSupabase(id); } catch (e) {
                console.warn('[Denarii] Broker cloud delete failed:', e.message || e);
            }
        }

        journalData.trades = journalData.trades.filter(function(t) { return t.brokerAccountId !== id; });
        journalData.brokerAccounts = journalData.brokerAccounts.filter(function(a) { return a.id !== id; });
        if (typeof window._clearAllDrafts === 'function') window._clearAllDrafts();

        _pendingDeleteBrokerId = null;
        closeModal('broker-delete-modal');
        await saveToIndexedDB();
        renderBrokerAccountsList();
        populateBrokerAccountDropdowns();
        if (typeof window._invalidateCloudDash === 'function') window._invalidateCloudDash();
        updateDashboard();
        // Warn if any other trades were already orphaned before
        // this delete (pre-existing orphans from earlier operations).
        _warnIfOrphans();
    }

    // ── Save broker account form ──────────────────────────────────────────────

    // Blocks a second submit while one is saving.
    let baSaving = false;

    document.getElementById('broker-account-form')?.addEventListener('submit', async (e) => {
        e.preventDefault();
        ensureBrokerAccounts();

        const editId      = document.getElementById('ba-edit-id').value;
        // Batch 2: changed on another device while open → conflict copy, reload.
        if (editId && !baSaving && typeof _editorGuardStale === 'function' && _editorGuardStale('broker-account-editor', editId) === true) {
            _baStaleSave(editId);
            return;
        }
        const brokerSelect = document.getElementById('ba-broker').value;
        let broker = brokerSelect === '__custom__'
            ? document.getElementById('ba-custom-broker').value.trim()
            : brokerSelect;

        if (!broker) { alert('Please select or enter a broker name.'); return; }

        const accountNumber = document.getElementById('ba-account-number').value.trim();
        let displayName     = document.getElementById('ba-display-name').value.trim();
        const tradingStyle  = document.getElementById('ba-trading-style').value;
        const isDefault     = document.getElementById('ba-is-default').checked;
        const visible       = document.getElementById('ba-visible').checked;

        if (!displayName) {
            displayName = generateBrokerDisplayName(broker, accountNumber, editId || null);
        }

        if (baSaving) return;
        baSaving = true;
        // cloud_primary: set when the account was only queued in this browser
        let cloudSaveFailed = false;
        const trackCloudSave = r => {
            if (window._denariiStorageMode === 'cloud_primary' && !(r && r.success === true)) cloudSaveFailed = true;
        };
        try {
            await _wbRunSave({
                linkChanged: _wbLinkChanged,
                prepare: _wbPrepareSave,
                commit: _wbCommitSave,
                showLinkError: text => {
                    if (cloudSaveFailed) text = text.replace(WB_LINK_FAILED_MSG, BA_LOCAL_ONLY_MSG + ' The Webull link was not saved.');
                    _wbSetMsg(text, 'danger'); _wbRender();
                },
                refresh: () => { renderBrokerAccountsList(); populateBrokerAccountDropdowns(); },
                saveAccount: async () => {
                    if (isDefault) {
                        journalData.brokerAccounts.forEach(a => a.isDefault = false);
                    }

                    var savedAcct;
                    if (editId) {
                        const acct = getBrokerAccount(editId);
                        if (acct) {
                            acct.broker        = broker;
                            acct.accountNumber = accountNumber;
                            acct.displayName   = displayName;
                            acct.tradingStyle  = tradingStyle;
                            acct.color         = window.selectedBrokerColor;
                            acct.isDefault     = isDefault;
                            acct.visible       = visible;
                            savedAcct = acct;
                        }
                    } else {
                        savedAcct = {
                            id: generateBrokerAccountId(),
                            broker,
                            accountNumber,
                            displayName,
                            tradingStyle,
                            color:     window.selectedBrokerColor,
                            isDefault,
                            visible,
                            createdAt: new Date().toISOString()
                        };
                        journalData.brokerAccounts.push(savedAcct);
                    }

                    // Cloud-primary: save to Supabase first
                    if (savedAcct && typeof _saveBrokerAccountToSupabase === 'function') {
                        try { trackCloudSave(await _saveBrokerAccountToSupabase(savedAcct)); } catch (e) {
                            trackCloudSave(null);
                            console.warn('[Denarii] Broker cloud save failed:', e.message || e);
                        }
                        // If isDefault was set, other accounts had isDefault cleared — sync them
                        if (isDefault) {
                            for (var i = 0; i < journalData.brokerAccounts.length; i++) {
                                var ba = journalData.brokerAccounts[i];
                                if (ba.id !== savedAcct.id) {
                                    try { trackCloudSave(await _saveBrokerAccountToSupabase(ba)); } catch (e) { trackCloudSave(null); }
                                }
                            }
                        }
                    }

                    await saveToIndexedDB();
                },
                close: () => {
                    closeModal('broker-account-modal');
                    renderBrokerAccountsList();
                    populateBrokerAccountDropdowns();
                    if (cloudSaveFailed) alert(BA_LOCAL_ONLY_MSG);

                    // If opened from the import account dropdown, auto-select the new account there
                    if (window._pendingImportAccountCreate && !editId) {
                        const newAcct   = journalData.brokerAccounts[journalData.brokerAccounts.length - 1];
                        const importSel = document.getElementById('broker-import-account-select');
                        if (importSel && newAcct) importSel.value = newAcct.id;
                        window._pendingImportAccountCreate = false;
                    }
                }
            });
        } finally {
            baSaving = false;
        }
    });

    // Clear the import-context flag if the user cancels the broker account modal
    document.querySelector('#broker-account-modal .btn-secondary')?.addEventListener('click', () => {
        window._pendingImportAccountCreate = false;
    });

    // ── Populate broker account dropdowns across the app ──────────────────────

    function populateBrokerAccountDropdowns() {
        ensureBrokerAccounts();
        const accounts  = journalData.brokerAccounts;
        const visibleAccounts = accounts.filter(a => a.visible !== false);
        const defaultId = (visibleAccounts.find(a => a.isDefault) || visibleAccounts[0] || {}).id || '';

        // Trade form dropdown — visible accounts only
        const tradeSelect = document.getElementById('trade-broker-account');
        if (tradeSelect) {
            const currentVal = tradeSelect.value;
            tradeSelect.innerHTML = '<option value="">Select account...</option>' +
                visibleAccounts.map(a => `<option value="${a.id}" ${a.id === (currentVal || defaultId) ? 'selected' : ''}>${escapeHtml(a.displayName)}</option>`).join('');
        }

        // Dashboard filter dropdown — visible accounts only
        const filterSelect = document.getElementById('filter-broker-account');
        if (filterSelect) {
            const currentFilter = filterSelect.value;
            filterSelect.innerHTML = '<option value="all">All Accounts</option>' +
                visibleAccounts.map(a => `<option value="${a.id}" ${a.id === currentFilter ? 'selected' : ''}>${escapeHtml(a.displayName)}</option>`).join('');
            // Sync the runtime filter variable to match the rebuilt dropdown.
            // If the previously selected account was hidden or deleted, the
            // dropdown falls back to "All Accounts" — the variable must follow.
            window.filterBrokerAccountId = filterSelect.value || 'all';
        }

        // Broker import account selector — visible accounts only
        const importSelect = document.getElementById('broker-import-account-select');
        if (importSelect) {
            const prevImportVal = importSelect.value !== '__add_new__' ? importSelect.value : '';
            importSelect.innerHTML =
                '<option value="">Select account...</option>' +
                visibleAccounts.map(a => `<option value="${a.id}">${escapeHtml(a.displayName)}</option>`).join('') +
                '<option value="" disabled style="color:var(--text-secondary);">──────────────</option>' +
                '<option value="__add_new__">+ Add New Account</option>';
            // Restore previous selection (never restore the sentinel itself)
            if (prevImportVal) importSelect.value = prevImportVal;
        }

        // Prompt modal account selector — visible accounts only
        const promptSelect = document.getElementById('import-prompt-account-select');
        if (promptSelect) {
            promptSelect.innerHTML = '<option value="">Select account...</option>' +
                visibleAccounts.map(a => `<option value="${a.id}">${escapeHtml(a.displayName)}</option>`).join('');
        }

    }

    // ── Data migration ────────────────────────────────────────────────────────

    function migrateBrokerAccounts() {
        ensureBrokerAccounts();
        const trades = journalData.trades || [];
        const needsMigration = trades.some(t => !t.brokerAccountId && t.account);
        if (!needsMigration) return false;

        const uniqueAccounts = [...new Set(trades.filter(t => !t.brokerAccountId && t.account).map(t => t.account))];
        let colorIndex = 0;

        uniqueAccounts.forEach(accountName => {
            // Check if we already created a broker account for this name
            const existing = journalData.brokerAccounts.find(a => a.broker === accountName || a.displayName === accountName);
            let accountId;
            if (existing) {
                accountId = existing.id;
            } else {
                accountId = generateBrokerAccountId();
                journalData.brokerAccounts.push({
                    id: accountId,
                    broker:       accountName === 'Manual Entry' ? 'Manual' : accountName,
                    accountNumber: '',
                    displayName:  accountName,
                    tradingStyle: 'day_trading',
                    color:        BROKER_COLOR_PALETTE[colorIndex % BROKER_COLOR_PALETTE.length],
                    isDefault:    journalData.brokerAccounts.length === 0,
                    createdAt:    new Date().toISOString()
                });
                colorIndex++;
            }

            trades.forEach(t => {
                if (!t.brokerAccountId && t.account === accountName) {
                    t.brokerAccountId = accountId;
                }
            });
        });

        // Also handle trades with no account at all
        trades.forEach(t => {
            if (!t.brokerAccountId) {
                if (journalData.brokerAccounts.length > 0) {
                    const def = journalData.brokerAccounts.find(a => a.isDefault) || journalData.brokerAccounts[0];
                    t.brokerAccountId = def.id;
                }
            }
        });

        return true;
    }

    // ── Global filter logic ───────────────────────────────────────────────────

    // Page id → the window function that redraws it when the account changes.
    const ACCOUNT_RERENDER = {
        'snapshot':      'renderSnapshot',
        'perf-trends':   'renderTrends',
        'setups':        'renderSetups',
        'timing':        'renderTiming',
        'symbols':       'renderSymbols',
        'risk':          'renderRisk',
        'discipline':    'renderDisc',
        'trade-journal': 'renderJournalTradeList'
    };

    function applyGlobalFilters() {
        window.filterBrokerAccountId = document.getElementById('filter-broker-account')?.value || 'all';
        updateDashboard();
        if (typeof window._jnlOnAccountChange === 'function') window._jnlOnAccountChange();

        // The open page redraws at once; other pages pick the account up on arrival.
        const activeTab = document.querySelector('.tab-content.active');
        const render = activeTab && window[ACCOUNT_RERENDER[activeTab.id]];
        if (typeof render === 'function') render();
    }

    // The header account's trades, or accountId's when given.
    // "All Accounts" leaves out hidden accounts.
    function getSelectedAccountTrades(trades, accountId) {
        ensureBrokerAccounts();
        const list = trades || [];
        const selectedId = accountId || window.filterBrokerAccountId;

        // Exclude trades from hidden broker accounts (unless user explicitly selected one)
        if (selectedId === 'all') {
            // Cloud: visible accounts only, like the Dashboard's query, so trades
            // left behind by deleted accounts stay out. No accounts: unfiltered.
            if (window._denariiStorageMode === 'cloud_primary' && journalData.brokerAccounts.length > 0) {
                const visibleIds = journalData.brokerAccounts
                    .filter(a => a.visible !== false)
                    .map(a => a.id);
                return list.filter(t => visibleIds.includes(t.brokerAccountId));
            }
            const hiddenIds = journalData.brokerAccounts
                .filter(a => a.visible === false)
                .map(a => a.id);
            return hiddenIds.length > 0
                ? list.filter(t => !hiddenIds.includes(t.brokerAccountId))
                : list;
        }

        return list.filter(t => t.brokerAccountId === selectedId);
    }

    function getGlobalFilteredTrades(trades) {
        return getSelectedAccountTrades(trades);
    }

    // ── Window exposures ──────────────────────────────────────────────────────

    window.renderBrokerAccountsList      = renderBrokerAccountsList;
    window.selectBrokerColor             = selectBrokerColor;
    window.handleBrokerSelect            = handleBrokerSelect;
    window.openBrokerAccountModal        = openBrokerAccountModal;
    window.editBrokerAccount             = editBrokerAccount;
    window.deleteBrokerAccount           = deleteBrokerAccount;
    window.confirmBrokerDeleteReassign   = confirmBrokerDeleteReassign;
    window.confirmBrokerDeleteAll        = confirmBrokerDeleteAll;
    window.toggleBrokerVisibility        = toggleBrokerVisibility;
    window.populateBrokerAccountDropdowns = populateBrokerAccountDropdowns;
    window.migrateBrokerAccounts         = migrateBrokerAccounts;
    window.applyGlobalFilters            = applyGlobalFilters;
    window.getSelectedAccountTrades      = getSelectedAccountTrades;
    window.getGlobalFilteredTrades       = getGlobalFilteredTrades;
    window.getBrokerAccount              = getBrokerAccount;
    window.generateBrokerAccountId       = generateBrokerAccountId;

    // Account-level cash (opening balance + deposits/withdrawals)
    window.getAccountCashSummary         = getAccountCashSummary;
    window.openAccountCashModal          = openAccountCashModal;
    window.saveAccountOpeningBalance     = saveAccountOpeningBalance;
    window.addAccountCashAdjustment      = addAccountCashAdjustment;
    window.deleteAccountCashAdjustment   = deleteAccountCashAdjustment;

    // Cash Ledger modal tab switcher
    window.switchBacTab                   = switchBacTab;

    // Recurring fees
    window.getAccountRecurringFeesAccrued = getAccountRecurringFeesAccrued;
    window.openAddRecurringFee            = openAddRecurringFee;
    window.cancelRecurringFeeForm         = cancelRecurringFeeForm;
    window.editRecurringFee               = editRecurringFee;
    window.saveRecurringFeeForm           = saveRecurringFeeForm;
    window.deleteRecurringFee             = deleteRecurringFee;
    window.toggleRecurringFeeActive       = toggleRecurringFeeActive;

    // Webull: Lock clears the card lines
    window._clearBrokerCardCache          = _clearBrokerCardCache;

})();
