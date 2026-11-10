/* ═══════════════════════════════════════════════════════════════
   Week View  —  Weekly performance cards embedded in Dashboard
   Groups dashboard-filtered trades into calendar weeks and
   renders one card per week with day tiles, metrics, a
   cumulative P&L chart, and a clickable day-detail modal.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    var DAY_NAMES = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
    var MONTH_SHORT = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

    /* ── Helpers ───────────────────────────────────────────── */
    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function fmtPnl(v) {
        if (v === 0) return '$0.00';
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

    function fmtDateFull(dateStr) {
        var d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }

    function fmtDateShort(dateStr) {
        var d = new Date(dateStr + 'T12:00:00');
        return MONTH_SHORT[d.getMonth()] + ' ' + d.getDate();
    }

    function pnlClass(v) {
        return v > 0 ? 'wv-positive' : v < 0 ? 'wv-negative' : 'wv-neutral';
    }

    /* ── Compute metrics (closed trades only for realized) ────────── */
    function computeMetrics(trades) {
        var _isOpen = typeof window._isOpenTrade === 'function' ? window._isOpenTrade : function () { return false; };
        var totalPnl = 0, grossWins = 0, grossLosses = 0, winners = 0, losers = 0;
        trades.forEach(function (t) {
            if (_isOpen(t)) return; // exclude open trades from realized metrics
            var pnl = t.pnl || 0;
            totalPnl += pnl;
            if (pnl > 0) { winners++; grossWins += pnl; }
            else if (pnl < 0) { losers++; grossLosses += Math.abs(pnl); }
        });
        var closed = trades.filter(function (t) { return !_isOpen(t); });
        return {
            totalPnl: totalPnl,
            totalTrades: trades.length,
            winners: winners,
            losers: losers,
            winRate: closed.length > 0 ? (winners / closed.length * 100).toFixed(1) : '0.0',
            grossWins: grossWins,
            grossLosses: grossLosses,
            profitFactor: grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : (grossWins > 0 ? '\u221E' : '0.00')
        };
    }

    /* ── SVG mini chart (same lightweight approach as Day View) ── */
    function buildChart(trades, w, h) {
        var sorted = trades.slice().sort(function (a, b) {
            return new Date(a.exitTime || a.entryTime) - new Date(b.exitTime || b.entryTime);
        });
        var points = [0], cum = 0;
        sorted.forEach(function (t) { cum += (t.pnl || 0); points.push(cum); });
        if (points.length < 2) return '';

        var W = w || 280, H = h || 50, P = 2;
        var minY = Math.min.apply(null, points);
        var maxY = Math.max.apply(null, points);
        var rY = maxY - minY || 1;
        var coords = points.map(function (v, i) {
            return (P + (i / (points.length - 1)) * (W - P * 2)).toFixed(1) + ',' +
                   (P + (1 - (v - minY) / rY) * (H - P * 2)).toFixed(1);
        });
        var lineColor = cum >= 0 ? 'var(--success)' : 'var(--danger)';
        var fillColor = cum >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';
        var zeroY = (P + (1 - (0 - minY) / rY) * (H - P * 2)).toFixed(1);
        var area = 'M' + coords[0] + ' L' + coords.join(' L') +
            ' L' + (W - P).toFixed(1) + ',' + zeroY + ' L' + P.toFixed(1) + ',' + zeroY + ' Z';

        return '<svg class="wv-chart-svg" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
            '<path d="' + area + '" fill="' + fillColor + '"/>' +
            '<line x1="' + P + '" y1="' + zeroY + '" x2="' + (W - P) + '" y2="' + zeroY +
            '" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,2"/>' +
            '<polyline points="' + coords.join(' ') + '" fill="none" stroke="' + lineColor +
            '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/></svg>';
    }

    /* ── Week grouping ─────────────────────────────────────── */
    function getWeekSunday(dateStr) {
        var d = new Date(dateStr + 'T12:00:00');
        d.setDate(d.getDate() - d.getDay());
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function getWeekDates(sundayStr) {
        var sun = new Date(sundayStr + 'T12:00:00');
        var dates = [];
        for (var i = 0; i < 7; i++) {
            var d = new Date(sun);
            d.setDate(sun.getDate() + i);
            dates.push(d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()));
        }
        return dates;
    }

    function getWeekGroups() {
        var allTrades = journalData.trades || [];
        var globalFiltered = (typeof getGlobalFilteredTrades === 'function')
            ? getGlobalFilteredTrades(allTrades.slice()) : allTrades.slice();
        var trades = (typeof getDashFilteredTrades === 'function')
            ? getDashFilteredTrades(globalFiltered) : globalFiltered;

        // Group by day first
        var dayMap = {};
        trades.forEach(function (t) {
            var dateStr = DenariiFilters.localDayKey(t.exitTime || t.entryTime);
            if (!dateStr) return;
            if (!dayMap[dateStr]) dayMap[dateStr] = [];
            dayMap[dateStr].push(t);
        });

        // Group days into weeks (keyed by Sunday)
        var weekMap = {};
        Object.keys(dayMap).forEach(function (dateStr) {
            var sun = getWeekSunday(dateStr);
            if (!weekMap[sun]) weekMap[sun] = { sunday: sun, dayMap: {} };
            weekMap[sun].dayMap[dateStr] = dayMap[dateStr];
        });

        // Sort newest first
        return Object.keys(weekMap)
            .sort(function (a, b) { return b.localeCompare(a); })
            .map(function (k) { return weekMap[k]; });
    }

    /* ── Pagination state ─────────────────────────────────────
       Limits the number of week cards shown per page.
       Reset to page 1 on re-render (filter change, etc.).
       ─────────────────────────────────────────────────────── */
    var _wvPage = 1;
    var _wvPageSize = 15;

    /* ── Inline drill-down state ──────────────────────────────
       Tracks which day tile is currently expanded. Reset on
       re-render (filter change, tab switch, dashboard refresh).
       ─────────────────────────────────────────────────────── */
    var _wvOpenDate = null;

    function _wvToggleDrilldown(dateStr, tileEl) {
        // Remove any existing inline drill-down
        var existing = document.querySelector('.wv-card .wv-drilldown');
        if (existing) existing.remove();

        // Clear active state on all tiles
        document.querySelectorAll('.wv-day-tile-active').forEach(function (el) {
            el.classList.remove('wv-day-tile-active');
        });

        if (_wvOpenDate === dateStr) {
            // Toggle off — same tile clicked again
            _wvOpenDate = null;
            return;
        }

        // Build drill-down content from shared renderer
        _wvOpenDate = dateStr;
        var drillHtml = (typeof _renderDayTradeList === 'function')
            ? _renderDayTradeList(dateStr) : '';
        if (!drillHtml) { _wvOpenDate = null; return; }

        // Insert between .wv-day-strip and .wv-card-body inside the card
        var card = tileEl.closest('.wv-card');
        if (!card) return;
        var body = card.querySelector('.wv-card-body');
        if (!body) return;

        var wrapper = document.createElement('div');
        wrapper.className = 'wv-drilldown';
        wrapper.innerHTML = drillHtml;
        card.insertBefore(wrapper, body);

        // Mark clicked tile as active
        tileEl.classList.add('wv-day-tile-active');
    }

    /* ── Render week cards ─────────────────────────────────── */
    function render() {
        var container = document.getElementById('weekview-container');
        if (!container) return;

        // Reset drill-down state on re-render
        _wvOpenDate = null;

        var weeks = getWeekGroups();
        if (weeks.length === 0) {
            _wvPage = 1;
            container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px;">No trading weeks match the current filter.</p>';
            return;
        }

        // Pagination
        var totalPages = Math.max(1, Math.ceil(weeks.length / _wvPageSize));
        if (_wvPage > totalPages) _wvPage = totalPages;
        if (_wvPage < 1) _wvPage = 1;
        var startIdx = (_wvPage - 1) * _wvPageSize;
        var pageItems = weeks.slice(startIdx, startIdx + _wvPageSize);

        var html = '<div class="wv-cards">';

        pageItems.forEach(function (week) {
            var weekDates = getWeekDates(week.sunday);
            var allTrades = [];
            Object.keys(week.dayMap).forEach(function (d) {
                allTrades = allTrades.concat(week.dayMap[d]);
            });
            var m = computeMetrics(allTrades);
            var cls = pnlClass(m.totalPnl);

            // Week range label
            var rangeLabel = fmtDateShort(weekDates[0]) + ' \u2013 ' + fmtDateShort(weekDates[6]) + ', ' +
                new Date(weekDates[6] + 'T12:00:00').getFullYear();

            html += '<div class="wv-card ' + cls + '">';

            // Header
            html += '<div class="wv-card-header">';
            html += '<div class="wv-week-range">' + rangeLabel + '</div>';
            html += '<div class="wv-week-pnl">' + fmtPnl(m.totalPnl) + '</div>';
            html += '</div>';

            // Day strip
            html += '<div class="wv-day-strip">';
            weekDates.forEach(function (dateStr, i) {
                var dayTrades = week.dayMap[dateStr] || [];
                var hasTrades = dayTrades.length > 0;
                var dayPnl = 0;
                dayTrades.forEach(function (t) { dayPnl += (t.pnl || 0); });
                var tileCls = 'wv-day-tile' + (hasTrades ? ' wv-day-has-trades ' + pnlClass(dayPnl) : ' wv-day-empty');

                html += '<div class="' + tileCls + '"' +
                    (hasTrades ? ' data-wv-date="' + dateStr + '"' : '') + '>';
                html += '<div class="wv-day-name">' + DAY_NAMES[i] + '</div>';
                html += '<div class="wv-day-date">' + new Date(dateStr + 'T12:00:00').getDate() + '</div>';
                if (hasTrades) {
                    html += '<div class="wv-day-pnl">' + fmtPnlShort(dayPnl) + '</div>';
                    html += '<div class="wv-day-count">' + dayTrades.length + 't</div>';
                }
                html += '</div>';
            });
            html += '</div>';

            // Body: chart + metrics
            html += '<div class="wv-card-body">';
            html += '<div class="wv-chart-wrap">' + buildChart(allTrades, 280, 50) + '</div>';
            html += '<div class="wv-metrics">';
            html += '<div class="wv-metric"><span class="wv-metric-label">Trades</span><span class="wv-metric-value">' + m.totalTrades + '</span></div>';
            html += '<div class="wv-metric"><span class="wv-metric-label">Win Rate</span><span class="wv-metric-value">' + m.winRate + '%</span></div>';
            html += '<div class="wv-metric"><span class="wv-metric-label">Winners</span><span class="wv-metric-value wv-positive">' + m.winners + '</span></div>';
            html += '<div class="wv-metric"><span class="wv-metric-label">Gross P&L</span><span class="wv-metric-value">' + fmtPnl(m.grossWins - m.grossLosses) + '</span></div>';
            html += '<div class="wv-metric"><span class="wv-metric-label">Profit Factor</span><span class="wv-metric-value">' + m.profitFactor + '</span></div>';
            html += '<div class="wv-metric"><span class="wv-metric-label">Losers</span><span class="wv-metric-value wv-negative">' + m.losers + '</span></div>';
            html += '</div>';
            html += '</div>';

            html += '</div>'; // .wv-card
        });

        html += '</div>';

        // Pagination controls (only when more than one page)
        if (totalPages > 1) {
            var prevDis = _wvPage <= 1;
            var nextDis = _wvPage >= totalPages;
            html += '<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 0;font-size:13px;color:var(--text-secondary);">';
            html += '<button onclick="_wvPrevPage()"' + (prevDis ? ' disabled' : '') + ' style="padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:' + (prevDis ? 'default' : 'pointer') + ';opacity:' + (prevDis ? '0.4' : '1') + ';">Previous</button>';
            html += '<span>Page ' + _wvPage + ' of ' + totalPages + ' \u00B7 ' + weeks.length + ' weeks</span>';
            html += '<button onclick="_wvNextPage()"' + (nextDis ? ' disabled' : '') + ' style="padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:' + (nextDis ? 'default' : 'pointer') + ';opacity:' + (nextDis ? '0.4' : '1') + ';">Next</button>';
            html += '</div>';
        }

        container.innerHTML = html;

        // Attach click handlers to day tiles with trades
        container.querySelectorAll('.wv-day-has-trades[data-wv-date]').forEach(function (tile) {
            tile.addEventListener('click', function () {
                var dateStr = tile.getAttribute('data-wv-date');
                if (dateStr) _wvToggleDrilldown(dateStr, tile);
            });
        });
    }

    /* ── Pagination navigation ────────────────────────────── */
    window._wvPrevPage = function () {
        if (_wvPage > 1) { _wvPage--; render(); }
    };
    window._wvNextPage = function () {
        _wvPage++; render(); // render() clamps to totalPages
    };

    /* ── Refresh ───────────────────────────────────────────── */
    function refresh() {
        var panel = document.getElementById('dash-panel-weekview');
        if (panel && panel.style.display !== 'none') {
            _wvPage = 1; // reset on data/filter change
            render();
        }
    }

    /* ── Expose ─────────────────────────────────────────────── */
    window._weekViewRender  = render;
    window._weekViewRefresh = refresh;

}());
