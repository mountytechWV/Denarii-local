/* ═══════════════════════════════════════════════════════════════
   Calendar  —  Monthly trading calendar embedded in Dashboard
   Shows daily P/L, trade count, win rate per day plus weekly
   summaries. Clicking a day navigates to the Trade Reflection
   page filtered for that date.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    /* ── State ─────────────────────────────────────────────── */
    var _year, _month; // 0-indexed month
    var _initialized = false;

    /* ── Helpers ───────────────────────────────────────────── */
    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function fmtPnl(v) {
        if (v === 0) return '$0';
        var sign = v > 0 ? '+' : '-';
        return sign + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtPnlShort(v) {
        if (v === 0) return '$0';
        var abs = Math.abs(v);
        var sign = v > 0 ? '+' : '-';
        if (abs >= 100000) return sign + '$' + (abs / 1000).toFixed(1) + 'k';
        return sign + '$' + abs.toLocaleString(undefined, { maximumFractionDigits: 0 });
    }

    function monthName(m) {
        return ['January','February','March','April','May','June',
                'July','August','September','October','November','December'][m];
    }

    /* ── Data aggregation ──────────────────────────────────── */
    function buildMonthData(year, month) {
        // Use dashboard-filtered trades so calendar reflects the same
        // account/period/style/setup/symbol context as the trade list.
        var allTrades = journalData.trades || [];
        var globalFiltered = (typeof getGlobalFilteredTrades === 'function')
            ? getGlobalFilteredTrades(allTrades.slice())
            : allTrades.slice();
        var trades = (typeof getDashFilteredTrades === 'function')
            ? getDashFilteredTrades(globalFiltered)
            : globalFiltered;

        // Build YYYY-MM prefix for this month
        var prefix = year + '-' + pad(month + 1);

        // Group trades by exit date (or entry date for open trades)
        var dayMap = {};
        var _isOpen = typeof window._isOpenTrade === 'function' ? window._isOpenTrade : function () { return false; };
        trades.forEach(function (t) {
            var dateStr = DenariiFilters.localDayKey(t.exitTime || t.entryTime); // YYYY-MM-DD
            if (dateStr.slice(0, 7) !== prefix) return;
            if (!dayMap[dateStr]) dayMap[dateStr] = { trades: [], pnl: 0 };
            dayMap[dateStr].trades.push(t);
            if (!_isOpen(t)) dayMap[dateStr].pnl += (t.pnl || 0);
        });

        return dayMap;
    }

    function dayStats(entry) {
        if (!entry || !entry.trades.length) return null;
        var _isOpen = typeof window._isOpenTrade === 'function' ? window._isOpenTrade : function () { return false; };
        var closed = entry.trades.filter(function (t) { return !_isOpen(t); });
        var wins = closed.filter(function (t) { return (t.pnl || 0) > 0; }).length;
        return {
            pnl: entry.pnl,
            count: entry.trades.length,
            winRate: closed.length > 0 ? (wins / closed.length * 100).toFixed(0) : '0'
        };
    }

    /* ── Inline drill-down state ──────────────────────────────
       Tracks which calendar day is currently expanded. Reset on
       render() so month nav, filter changes, and tab switches
       leave no stale drill-down behind.
       ─────────────────────────────────────────────────────── */
    var _calOpenDate = null;

    function _calToggleDrilldown(dateStr, cellEl) {
        // Remove any existing drill-down row
        var existing = document.querySelector('.cal-day-drilldown');
        if (existing) existing.remove();

        // Clear active state on all cells
        document.querySelectorAll('.cal-cell-active').forEach(function (el) {
            el.classList.remove('cal-cell-active');
        });

        if (_calOpenDate === dateStr) {
            // Toggle off — same day clicked again
            _calOpenDate = null;
            return;
        }

        // Build drill-down content from shared renderer
        _calOpenDate = dateStr;
        var drillHtml = (typeof _renderDayTradeList === 'function')
            ? _renderDayTradeList(dateStr) : '';
        if (!drillHtml) { _calOpenDate = null; return; }

        // Insert as a full-width sibling row after the clicked day's cal-row
        var calRow = cellEl.closest('.cal-row');
        if (!calRow) return;

        var wrapper = document.createElement('div');
        wrapper.className = 'cal-day-drilldown';
        wrapper.innerHTML = drillHtml;
        calRow.parentNode.insertBefore(wrapper, calRow.nextSibling);

        // Mark clicked cell as active
        cellEl.classList.add('cal-cell-active');
    }

    /* ── Render ─────────────────────────────────────────────── */
    function render() {
        var grid = document.getElementById('cal-grid');
        var label = document.getElementById('cal-month-label');
        var chips = document.getElementById('cal-summary-chips');
        if (!grid) return;

        // Reset drill-down state on re-render
        _calOpenDate = null;

        var showPnl   = document.getElementById('cal-tog-pnl').checked;
        var showCount = document.getElementById('cal-tog-count').checked;
        var showWr    = document.getElementById('cal-tog-wr').checked;

        var dayMap = buildMonthData(_year, _month);

        // Month label
        label.textContent = monthName(_month) + ' ' + _year;

        // Monthly summary
        var totalPnl = 0, tradingDays = 0;
        Object.keys(dayMap).forEach(function (k) {
            totalPnl += dayMap[k].pnl;
            tradingDays++;
        });
        chips.innerHTML =
            '<span class="cal-chip ' + (totalPnl > 0 ? 'cal-chip-green' : totalPnl < 0 ? 'cal-chip-red' : '') + '">' +
                'Monthly P/L: ' + fmtPnl(totalPnl) +
            '</span>' +
            '<span class="cal-chip">Trading Days: ' + tradingDays + '</span>';

        // Calendar grid
        var firstDay = new Date(_year, _month, 1).getDay(); // 0=Sun
        var daysInMonth = new Date(_year, _month + 1, 0).getDate();

        var html = '';

        // Header row
        var dayNames = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
        html += '<div class="cal-row cal-header-row">';
        dayNames.forEach(function (d) {
            html += '<div class="cal-hdr">' + d + '</div>';
        });
        html += '<div class="cal-hdr cal-hdr-week"></div>';
        html += '</div>';

        // Build weeks
        var dayNum = 1;
        var weekRows = [];

        while (dayNum <= daysInMonth) {
            var weekCells = [];
            var weekPnl = 0, weekTradingDays = 0;

            for (var col = 0; col < 7; col++) {
                if ((weekRows.length === 0 && col < firstDay) || dayNum > daysInMonth) {
                    weekCells.push({ empty: true });
                } else {
                    var dateStr = _year + '-' + pad(_month + 1) + '-' + pad(dayNum);
                    var entry = dayMap[dateStr];
                    var stats = dayStats(entry);
                    weekCells.push({ day: dayNum, dateStr: dateStr, stats: stats });
                    if (stats) {
                        weekPnl += stats.pnl;
                        weekTradingDays++;
                    }
                    dayNum++;
                }
            }

            weekRows.push({
                cells: weekCells,
                weekPnl: weekPnl,
                weekTradingDays: weekTradingDays
            });
        }

        // Render week rows
        var today = DenariiFilters.localDateStr(new Date());

        weekRows.forEach(function (week, weekIdx) {
            html += '<div class="cal-row">';

            week.cells.forEach(function (cell) {
                if (cell.empty) {
                    html += '<div class="cal-cell cal-cell-empty"></div>';
                    return;
                }

                var cls = 'cal-cell';
                var isToday = cell.dateStr === today;
                if (isToday) cls += ' cal-cell-today';

                if (cell.stats) {
                    cls += cell.stats.pnl > 0 ? ' cal-cell-green' : cell.stats.pnl < 0 ? ' cal-cell-red' : ' cal-cell-flat';
                    cls += ' cal-cell-has-trades';
                }

                html += '<div class="' + cls + '" data-date="' + cell.dateStr + '">';
                html += '<div class="cal-day-num">' + cell.day + '</div>';

                if (cell.stats) {
                    html += '<div class="cal-day-metrics">';
                    if (showPnl)   html += '<div class="cal-metric cal-metric-pnl">' + fmtPnlShort(cell.stats.pnl) + '</div>';
                    if (showCount) html += '<div class="cal-metric cal-metric-count">' + cell.stats.count + ' trade' + (cell.stats.count !== 1 ? 's' : '') + '</div>';
                    if (showWr)    html += '<div class="cal-metric cal-metric-wr">' + cell.stats.winRate + '% W</div>';
                    html += '</div>';
                }

                html += '</div>';
            });

            // Weekly summary cell
            var wCls = 'cal-cell cal-week-summary';
            if (week.weekPnl > 0) wCls += ' cal-week-green';
            else if (week.weekPnl < 0) wCls += ' cal-week-red';

            html += '<div class="' + wCls + '">';
            html += '<div class="cal-week-label">Week ' + (weekIdx + 1) + '</div>';
            if (week.weekTradingDays > 0) {
                html += '<div class="cal-week-pnl">' + fmtPnlShort(week.weekPnl) + '</div>';
                html += '<div class="cal-week-days">' + week.weekTradingDays + ' day' + (week.weekTradingDays !== 1 ? 's' : '') + '</div>';
            }
            html += '</div>';

            html += '</div>';
        });

        grid.innerHTML = html;

        // Attach click handlers for day cells with trades
        grid.querySelectorAll('.cal-cell-has-trades').forEach(function (el) {
            el.style.cursor = 'pointer';
            el.addEventListener('click', function () {
                _calToggleDrilldown(el.getAttribute('data-date'), el);
            });
        });
    }

    /* ── Month navigation ──────────────────────────────────── */
    function goMonth(delta) {
        _month += delta;
        if (_month > 11) { _month = 0; _year++; }
        if (_month < 0)  { _month = 11; _year--; }
        render();
    }

    function goToday() {
        var now = new Date();
        _year  = now.getFullYear();
        _month = now.getMonth();
        render();
    }

    /* ── Dashboard tab switching ───────────────────────────── */
    var _savedPeriod = null; // remembers the Trades-tab period value
    var _savedDates = null;  // and its From/To, which forcing All blanks

    window.switchDashView = function (view, btn) {
        // Any tab change drops ticked trades (Delete/Merge act on visible rows only).
        if (typeof _dashResetSelection === 'function') _dashResetSelection();
        // Track last-used view for "remember" preference
        if (typeof _dashLastView !== 'undefined') {
            _dashLastView = view;
            if (_dashRememberLastView && typeof setSetting === 'function') {
                setSetting('dashLastView', view);
            }
        }
        // Update tab active states
        document.querySelectorAll('.dash-view-tab').forEach(function (t) {
            t.classList.toggle('active', t.getAttribute('data-dash-view') === view);
        });

        // Show/hide panels
        var panels = ['dash-panel-trades', 'dash-panel-calendar', 'dash-panel-dayview', 'dash-panel-weekview'];
        panels.forEach(function (id) {
            var el = document.getElementById(id);
            if (el) el.style.display = (id === 'dash-panel-' + view) ? '' : 'none';
        });

        // Trades-only controls: Sort, Period, From/To dates
        // Select stays visible on all tabs so users can always toggle selection.
        var tradesOnly = (view === 'trades');
        var sortGrp      = document.getElementById('dash-fg-sort');
        var periodGrp    = document.getElementById('dash-fg-period');
        var dateRangeGrp = document.getElementById('dash-fg-daterange');
        if (sortGrp)      sortGrp.style.display      = tradesOnly ? '' : 'none';
        if (periodGrp)    periodGrp.style.display    = tradesOnly ? '' : 'none';
        if (dateRangeGrp) dateRangeGrp.style.display = tradesOnly ? '' : 'none';

        // Style always keeps its separator — on Trades it divides Period
        // from the filter dropdowns; on review surfaces it divides Select
        // from the filter dropdowns.

        // Period auto-switch: review surfaces (Calendar, Day View,
        // Week View) always use "All" so their own navigation/grouping
        // controls the visible range. Restore on Trades tab.
        var isReviewSurface = (view === 'calendar' || view === 'dayview' || view === 'weekview');
        if (isReviewSurface) {
            var periodSel = document.getElementById('dash-period');
            var currentPeriod = periodSel ? periodSel.value : 'all';
            if (currentPeriod !== 'all') {
                _savedPeriod = currentPeriod;
                _savedDates = {
                    from: (document.getElementById('dash-from') || {}).value || '',
                    to:   (document.getElementById('dash-to')   || {}).value || ''
                };
                if (typeof setDashPeriod === 'function') {
                    setDashPeriod('all');
                }
            }
            if (view === 'calendar') init();
        } else if (view === 'trades' && _savedPeriod) {
            var fromEl = document.getElementById('dash-from');
            var toEl   = document.getElementById('dash-to');
            if (fromEl && _savedDates) fromEl.value = _savedDates.from;
            if (toEl && _savedDates)   toEl.value   = _savedDates.to;
            if (typeof setDashPeriod === 'function') {
                setDashPeriod(_savedPeriod);
            }
            _savedPeriod = null;
            _savedDates = null;
        } else if (view === 'trades' && typeof updateDashboard === 'function') {
            // Re-render so the cleared selection shows (no stale ticks).
            updateDashboard();
        }

        // Day View: render on activation
        if (view === 'dayview') {
            if (typeof window._dayViewRender === 'function') window._dayViewRender();
        }

        // Week View: render on activation
        if (view === 'weekview') {
            if (typeof window._weekViewRender === 'function') window._weekViewRender();
        }
    };

    /* ── Init ──────────────────────────────────────────────── */
    function init() {
        if (_year === undefined) {
            var now = new Date();
            _year  = now.getFullYear();
            _month = now.getMonth();
        }

        // Bind buttons (idempotent via replaceWith-clone)
        ['cal-prev','cal-next','cal-today'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            var clone = el.cloneNode(true);
            el.parentNode.replaceChild(clone, el);
        });

        document.getElementById('cal-prev').addEventListener('click', function () { goMonth(-1); });
        document.getElementById('cal-next').addEventListener('click', function () { goMonth(1); });
        document.getElementById('cal-today').addEventListener('click', goToday);

        // Toggle checkboxes
        ['cal-tog-pnl','cal-tog-count','cal-tog-wr'].forEach(function (id) {
            var el = document.getElementById(id);
            if (!el) return;
            el.removeEventListener('change', render);
            el.addEventListener('change', render);
        });

        _initialized = true;
        render();
    }

    /* ── Refresh: called by updateDashboard when calendar tab is visible ── */
    function refresh() {
        if (!_initialized) return;
        var calPanel = document.getElementById('dash-panel-calendar');
        if (calPanel && calPanel.style.display !== 'none') {
            render();
        }
    }

    /* ── Expose ─────────────────────────────────────────────── */
    window._calendarInit = init;
    window._calendarRefresh = refresh;

}());
