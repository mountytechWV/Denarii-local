/* ═══════════════════════════════════════════════════════════════
   Day View  —  Daily performance cards embedded in Dashboard
   Groups dashboard-filtered trades by trading day and renders
   one summary card per day with metrics and a cumulative P&L
   mini chart.
   ═══════════════════════════════════════════════════════════════ */
(function () {
    'use strict';

    /* ── Helpers ───────────────────────────────────────────── */
    function fmtPnl(v) {
        if (v === 0) return '$0.00';
        var sign = v > 0 ? '+' : '-';
        return sign + '$' + Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }

    function fmtDate(dateStr) {
        var d = new Date(dateStr + 'T12:00:00');
        return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
    }

    /* ── Data: group trades by day ─────────────────────────── */
    function getDayGroups() {
        var allTrades = journalData.trades || [];
        var globalFiltered = (typeof getGlobalFilteredTrades === 'function')
            ? getGlobalFilteredTrades(allTrades.slice())
            : allTrades.slice();
        var trades = (typeof getDashFilteredTrades === 'function')
            ? getDashFilteredTrades(globalFiltered)
            : globalFiltered;

        var dayMap = {};
        trades.forEach(function (t) {
            var dateStr = DenariiFilters.localDayKey(t.exitTime || t.entryTime);
            if (!dateStr) return;
            if (!dayMap[dateStr]) dayMap[dateStr] = [];
            dayMap[dateStr].push(t);
        });

        // Sort days newest first
        return Object.keys(dayMap)
            .sort(function (a, b) { return b.localeCompare(a); })
            .map(function (date) { return { date: date, trades: dayMap[date] }; });
    }

    /* ── Compute day metrics (closed trades only for realized) ── */
    function computeMetrics(trades) {
        var _isOpen = typeof window._isOpenTrade === 'function' ? window._isOpenTrade : function () { return false; };
        var totalPnl = 0;
        var grossWins = 0, grossLosses = 0;
        var winners = 0, losers = 0;

        trades.forEach(function (t) {
            if (_isOpen(t)) return; // exclude open trades from realized metrics
            var pnl = t.pnl || 0;
            totalPnl += pnl;
            if (pnl > 0) { winners++; grossWins += pnl; }
            else if (pnl < 0) { losers++; grossLosses += Math.abs(pnl); }
        });

        var closed = trades.filter(function (t) { return !_isOpen(t); });
        var winRate = closed.length > 0 ? (winners / closed.length * 100).toFixed(1) : '0.0';
        var profitFactor = grossLosses > 0 ? (grossWins / grossLosses).toFixed(2) : (grossWins > 0 ? '∞' : '0.00');

        return {
            totalPnl: totalPnl,
            totalTrades: trades.length,
            winners: winners,
            losers: losers,
            winRate: winRate,
            grossWins: grossWins,
            grossLosses: grossLosses,
            profitFactor: profitFactor
        };
    }

    /* ── SVG mini chart: cumulative P&L curve ──────────────── */
    function buildCumulativeChart(trades) {
        // Sort trades by exit time for intraday sequence
        var sorted = trades.slice().sort(function (a, b) {
            return new Date(a.exitTime || a.entryTime) - new Date(b.exitTime || b.entryTime);
        });

        // Build cumulative P&L points
        var points = [0]; // start at 0
        var cum = 0;
        sorted.forEach(function (t) {
            cum += (t.pnl || 0);
            points.push(cum);
        });

        if (points.length < 2) return '';

        var W = 260, H = 60, PAD = 2;
        var minY = Math.min.apply(null, points);
        var maxY = Math.max.apply(null, points);
        var rangeY = maxY - minY || 1;

        var coords = points.map(function (v, i) {
            var x = PAD + (i / (points.length - 1)) * (W - PAD * 2);
            var y = PAD + (1 - (v - minY) / rangeY) * (H - PAD * 2);
            return x.toFixed(1) + ',' + y.toFixed(1);
        });

        var lineColor = cum >= 0 ? 'var(--success)' : 'var(--danger)';
        var fillColor = cum >= 0 ? 'rgba(34,197,94,0.12)' : 'rgba(239,68,68,0.12)';

        // Zero line
        var zeroY = (PAD + (1 - (0 - minY) / rangeY) * (H - PAD * 2)).toFixed(1);

        // Area fill path (line + close to bottom)
        var areaPath = 'M' + coords[0] + ' L' + coords.join(' L') +
            ' L' + (PAD + ((points.length - 1) / (points.length - 1)) * (W - PAD * 2)).toFixed(1) + ',' + zeroY +
            ' L' + PAD.toFixed(1) + ',' + zeroY + ' Z';

        return '<svg class="dv-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
            '<path d="' + areaPath + '" fill="' + fillColor + '" />' +
            '<line x1="' + PAD + '" y1="' + zeroY + '" x2="' + (W - PAD) + '" y2="' + zeroY + '" stroke="var(--border)" stroke-width="0.5" stroke-dasharray="3,2"/>' +
            '<polyline points="' + coords.join(' ') + '" fill="none" stroke="' + lineColor + '" stroke-width="1.5" stroke-linejoin="round" stroke-linecap="round"/>' +
            '</svg>';
    }

    /* ── Pagination state ─────────────────────────────────────
       Limits the number of day cards shown per page.
       Reset to page 1 on re-render (filter change, etc.).
       ─────────────────────────────────────────────────────── */
    var _dvPage = 1;
    var _dvPageSize = 25;

    /* ── Inline drill-down state ──────────────────────────────
       Tracks which day card is currently expanded. Reset on
       re-render (filter change, tab switch, dashboard refresh).
       ─────────────────────────────────────────────────────── */
    var _dvOpenDate = null;

    function _dvToggleDrilldown(dateStr, cardEl) {
        // Collapse any existing drill-down
        var existing = document.querySelector('.dv-card .day-drilldown');
        if (existing) existing.remove();

        if (_dvOpenDate === dateStr) {
            // Toggle off — same card clicked again
            _dvOpenDate = null;
            return;
        }

        // Expand new drill-down inside the clicked card
        _dvOpenDate = dateStr;
        var drillHtml = (typeof _renderDayTradeList === 'function')
            ? _renderDayTradeList(dateStr) : '';
        if (!drillHtml) { _dvOpenDate = null; return; }
        cardEl.insertAdjacentHTML('beforeend', drillHtml);
    }

    /* ── Render ─────────────────────────────────────────────── */
    function render() {
        var container = document.getElementById('dayview-container');
        if (!container) return;

        // Reset drill-down state on re-render
        _dvOpenDate = null;

        var days = getDayGroups();

        if (days.length === 0) {
            _dvPage = 1;
            container.innerHTML = '<p style="text-align:center;color:var(--text-secondary);padding:40px;">No trading days match the current filter.</p>';
            return;
        }

        // Pagination
        var totalPages = Math.max(1, Math.ceil(days.length / _dvPageSize));
        if (_dvPage > totalPages) _dvPage = totalPages;
        if (_dvPage < 1) _dvPage = 1;
        var startIdx = (_dvPage - 1) * _dvPageSize;
        var pageItems = days.slice(startIdx, startIdx + _dvPageSize);

        var html = '<div class="dv-cards">';

        pageItems.forEach(function (day) {
            var m = computeMetrics(day.trades);
            var pnlClass = m.totalPnl > 0 ? 'dv-positive' : m.totalPnl < 0 ? 'dv-negative' : 'dv-neutral';

            html += '<div class="dv-card ' + pnlClass + '" data-dv-date="' + day.date + '">';

            // Header: date + net P&L (clickable for drill-down)
            html += '<div class="dv-card-header dv-card-header-clickable">';
            html += '<div class="dv-date">' + fmtDate(day.date) + '</div>';
            html += '<div class="dv-net-pnl">' + fmtPnl(m.totalPnl) + '</div>';
            html += '</div>';

            // Body: chart + metrics side by side
            html += '<div class="dv-card-body">';

            // Chart
            html += '<div class="dv-chart-wrap">' + buildCumulativeChart(day.trades) + '</div>';

            // Metrics grid
            html += '<div class="dv-metrics">';
            html += '<div class="dv-metric"><span class="dv-metric-label">Trades</span><span class="dv-metric-value">' + m.totalTrades + '</span></div>';
            html += '<div class="dv-metric"><span class="dv-metric-label">Win Rate</span><span class="dv-metric-value">' + m.winRate + '%</span></div>';
            html += '<div class="dv-metric"><span class="dv-metric-label">Winners</span><span class="dv-metric-value dv-positive">' + m.winners + '</span></div>';
            html += '<div class="dv-metric"><span class="dv-metric-label">Gross P&L</span><span class="dv-metric-value">' + fmtPnl(m.grossWins - m.grossLosses) + '</span></div>';
            html += '<div class="dv-metric"><span class="dv-metric-label">Profit Factor</span><span class="dv-metric-value">' + m.profitFactor + '</span></div>';
            html += '<div class="dv-metric"><span class="dv-metric-label">Losers</span><span class="dv-metric-value dv-negative">' + m.losers + '</span></div>';
            html += '</div>';

            html += '</div>'; // .dv-card-body
            html += '</div>'; // .dv-card
        });

        html += '</div>';

        // Pagination controls (only when more than one page)
        if (totalPages > 1) {
            var prevDis = _dvPage <= 1;
            var nextDis = _dvPage >= totalPages;
            html += '<div style="display:flex;align-items:center;justify-content:center;gap:12px;padding:12px 0;font-size:13px;color:var(--text-secondary);">';
            html += '<button onclick="_dvPrevPage()"' + (prevDis ? ' disabled' : '') + ' style="padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:' + (prevDis ? 'default' : 'pointer') + ';opacity:' + (prevDis ? '0.4' : '1') + ';">Previous</button>';
            html += '<span>Page ' + _dvPage + ' of ' + totalPages + ' \u00B7 ' + days.length + ' days</span>';
            html += '<button onclick="_dvNextPage()"' + (nextDis ? ' disabled' : '') + ' style="padding:4px 12px;border-radius:5px;border:1px solid var(--border);background:var(--bg-primary);color:var(--text-primary);cursor:' + (nextDis ? 'default' : 'pointer') + ';opacity:' + (nextDis ? '0.4' : '1') + ';">Next</button>';
            html += '</div>';
        }

        container.innerHTML = html;

        // Attach click handlers to card headers for inline drill-down
        container.querySelectorAll('.dv-card-header-clickable').forEach(function (hdr) {
            hdr.addEventListener('click', function () {
                var card = hdr.closest('.dv-card');
                var dateStr = card ? card.getAttribute('data-dv-date') : null;
                if (dateStr && card) _dvToggleDrilldown(dateStr, card);
            });
        });
    }

    /* ── Pagination navigation ────────────────────────────── */
    window._dvPrevPage = function () {
        if (_dvPage > 1) { _dvPage--; render(); }
    };
    window._dvNextPage = function () {
        _dvPage++; render(); // render() clamps to totalPages
    };

    /* ── Refresh (called by updateDashboard) ───────────────── */
    function refresh() {
        var panel = document.getElementById('dash-panel-dayview');
        if (panel && panel.style.display !== 'none') {
            _dvPage = 1; // reset on data/filter change
            render();
        }
    }

    /* ── Expose ─────────────────────────────────────────────── */
    window._dayViewRender  = render;
    window._dayViewRefresh = refresh;

}());
