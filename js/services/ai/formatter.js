/**
 * @file formatter.js
 * Normalises raw journalData.trades into a deterministic, compact payload for AI consumption.
 * Strips internal IDs and bloated fields; supports stocks, options, crypto, futures.
 * No dependency on any other service file.
 */

(function (global) {

    // Same value as DenariiFilters.NO_STRATEGY.
    const NO_STRATEGY = '__no_strategy__';

    /**
     * Normalise a single raw trade into a FormattedTrade.
     * Returns null for any trade that lacks the minimum required fields.
     *
     * @param {Object} raw - Entry from journalData.trades
     * @returns {Object|null}
     */
    function _normaliseTrade(raw) {
        if (!raw || !raw.symbol || raw.pnl === undefined) return null;
        if (!raw.entryTime || !raw.exitTime) return null;

        const out = {
            symbol:       String(raw.symbol).toUpperCase(),
            direction:    String(raw.type || 'long'),
            assetType:    String(raw.assetType || 'stock'),
            quantity:     Number(raw.quantity) || 0,
            entryPrice:   parseFloat((Number(raw.entryPrice) || 0).toFixed(4)),
            exitPrice:    parseFloat((Number(raw.exitPrice)  || 0).toFixed(4)),
            entryTime:    raw.entryTime,
            exitTime:     raw.exitTime,
            holdSeconds:  Number(raw.holdSeconds) || 0,
            pnl:          parseFloat((Number(raw.pnl) || 0).toFixed(2)),
        };

        // Optional enrichment fields — only include if non-empty
        if (raw.setupType)                 out.setupType      = String(raw.setupType);
        if (raw.strategyScore != null)     out.strategyScore  = Number(raw.strategyScore);
        if (raw.emotion)                   out.emotion        = String(raw.emotion);
        if (raw.tags && raw.tags.length)   out.tags           = raw.tags.slice().sort(); // sorted for determinism
        if (raw.entryReason)               out.entryReason    = String(raw.entryReason);
        if (raw.exitReason)                out.exitReason     = String(raw.exitReason);
        if (raw.lessons)                   out.lessons        = String(raw.lessons);

        // Option-specific fields
        if (out.assetType === 'option') {
            if (raw.optionType) out.optionType = String(raw.optionType);
            if (raw.strike)     out.strike     = Number(raw.strike);
            if (raw.expiry)     out.expiry     = String(raw.expiry);
        }

        return out;
    }

    /**
     * Apply filters to a raw trades array.
     * All filters are optional; omit or pass null/'all' to skip each filter.
     */
    // A date-only value is a local day, the same rule as the shared filter bar.
    function _dayStart(value) {
        return new Date(/^\d{4}-\d{2}-\d{2}$/.test(value) ? value + 'T00:00:00' : value);
    }

    function _applyFilters(trades, filters) {
        if (!Array.isArray(trades)) return [];
        filters = filters || {};

        return trades.filter(function (t) {
            // Account filter
            if (filters.accountFilter && filters.accountFilter !== 'all') {
                if (t.brokerAccountId !== filters.accountFilter) return false;
            }

            // Date range filter (based on exitTime)
            if (filters.dateRange) {
                const exit = new Date(t.exitTime);
                if (filters.dateRange.start && exit < _dayStart(filters.dateRange.start)) return false;
                if (filters.dateRange.end) {
                    const end = _dayStart(filters.dateRange.end);
                    end.setHours(23, 59, 59, 999);
                    if (exit > end) return false;
                }
            }

            // Instrument type filter
            if (filters.instrumentType && filters.instrumentType !== 'all') {
                if ((t.assetType || 'stock') !== filters.instrumentType) return false;
            }

            // Strategy filter
            if (filters.strategyFilter === NO_STRATEGY) {
                if (String(t.setupType || '').trim()) return false;
            } else if (filters.strategyFilter && filters.strategyFilter !== 'all') {
                if (t.setupType !== filters.strategyFilter) return false;
            }

            return true;
        });
    }

    /**
     * Strict multi-key sort for deterministic trade ordering.
     * The same filtered trade set always produces the same sequence regardless of
     * storage order, insertion order, or object iteration order.
     *
     * Sort keys (ascending):
     *  1. entryTime
     *  2. exitTime
     *  3. symbol (alphabetical)
     *  4. pnl (final numeric tiebreaker)
     */
    function _sortTrades(trades) {
        return trades.slice().sort(function (a, b) {
            // 1. entryTime
            var tea = a.entryTime ? new Date(a.entryTime).getTime() : 0;
            var teb = b.entryTime ? new Date(b.entryTime).getTime() : 0;
            if (tea !== teb) return tea - teb;

            // 2. exitTime
            var txa = a.exitTime ? new Date(a.exitTime).getTime() : 0;
            var txb = b.exitTime ? new Date(b.exitTime).getTime() : 0;
            if (txa !== txb) return txa - txb;

            // 3. symbol
            var sa = String(a.symbol || '');
            var sb = String(b.symbol || '');
            if (sa !== sb) return sa < sb ? -1 : 1;

            // 4. pnl (stable final tiebreaker)
            return (a.pnl || 0) - (b.pnl || 0);
        });
    }

    /**
     * Compute a comprehensive, pre-calculated analytics block.
     * Giving the model exact numbers anchors its analysis to the real data and
     * prevents it from estimating/deriving metrics differently between runs.
     *
     * All numeric fields are rounded to a fixed precision so the same underlying
     * data always produces the same serialized values.
     *
     * @param {Array<Object>} trades - Normalised, sorted trades
     * @returns {Object}
     */
    function _buildAnalytics(trades) {
        if (!trades.length) {
            return { tradeCount: 0, totalPnl: 0, wins: 0, losses: 0, winRate: 0,
                     avgPnl: 0, avgWin: 0, avgLoss: 0, profitFactor: null,
                     expectancy: 0, largestWin: 0, largestLoss: 0, avgHoldMins: 0,
                     strategyBreakdown: [], instrumentBreakdown: [], emotionBreakdown: [],
                     assetTypes: [], strategies: [] };
        }

        const winTrades  = trades.filter(function (t) { return t.pnl > 0; });
        const lossTrades = trades.filter(function (t) { return t.pnl < 0; });

        const totalPnl     = trades.reduce(function (s, t) { return s + t.pnl; }, 0);
        const totalWinPnl  = winTrades.reduce(function (s, t) { return s + t.pnl; }, 0);
        const totalLossPnl = lossTrades.reduce(function (s, t) { return s + t.pnl; }, 0);

        const winRate  = Math.round((winTrades.length / trades.length) * 100);
        const avgPnl   = totalPnl / trades.length;
        const avgWin   = winTrades.length  ? totalWinPnl  / winTrades.length  : 0;
        const avgLoss  = lossTrades.length ? totalLossPnl / lossTrades.length : 0;

        // Profit factor: total gains / total losses (absolute value)
        const profitFactor = (totalLossPnl !== 0)
            ? parseFloat((totalWinPnl / Math.abs(totalLossPnl)).toFixed(3))
            : null;

        // Expectancy: average expected P&L per trade
        const expectancy = parseFloat(avgPnl.toFixed(2));

        const largestWin  = winTrades.length
            ? parseFloat(Math.max.apply(null, winTrades.map(function (t) { return t.pnl; })).toFixed(2))
            : 0;
        const largestLoss = lossTrades.length
            ? parseFloat(Math.min.apply(null, lossTrades.map(function (t) { return t.pnl; })).toFixed(2))
            : 0;

        const totalHoldSecs = trades.reduce(function (s, t) { return s + (t.holdSeconds || 0); }, 0);
        const avgHoldMins   = parseFloat((totalHoldSecs / trades.length / 60).toFixed(1));

        // ── Per-strategy breakdown ──────────────────────────────────────────
        const stratMap = {};
        trades.forEach(function (t) {
            var k = t.setupType || '(untagged)';
            if (!stratMap[k]) stratMap[k] = { count: 0, pnl: 0, wins: 0 };
            stratMap[k].count++;
            stratMap[k].pnl += t.pnl;
            if (t.pnl > 0) stratMap[k].wins++;
        });
        // Sort by total pnl descending, then name ascending for stable ties
        const strategyBreakdown = Object.keys(stratMap).map(function (k) {
            return {
                name:    k,
                count:   stratMap[k].count,
                pnl:     parseFloat(stratMap[k].pnl.toFixed(2)),
                winRate: Math.round((stratMap[k].wins / stratMap[k].count) * 100),
            };
        }).sort(function (a, b) {
            if (b.pnl !== a.pnl) return b.pnl - a.pnl;
            return a.name < b.name ? -1 : 1;
        });

        // ── Per-instrument breakdown (alphabetical for determinism) ─────────
        const instrMap = {};
        trades.forEach(function (t) {
            var k = t.assetType || 'stock';
            if (!instrMap[k]) instrMap[k] = { count: 0, pnl: 0 };
            instrMap[k].count++;
            instrMap[k].pnl += t.pnl;
        });
        const instrumentBreakdown = Object.keys(instrMap).sort().map(function (k) {
            return { type: k, count: instrMap[k].count, pnl: parseFloat(instrMap[k].pnl.toFixed(2)) };
        });

        // ── Emotion breakdown (alphabetical for determinism) ────────────────
        const emoMap = {};
        trades.forEach(function (t) {
            if (!t.emotion) return;
            if (!emoMap[t.emotion]) emoMap[t.emotion] = { count: 0, pnl: 0 };
            emoMap[t.emotion].count++;
            emoMap[t.emotion].pnl += t.pnl;
        });
        const emotionBreakdown = Object.keys(emoMap).sort().map(function (k) {
            return { tag: k, count: emoMap[k].count, pnl: parseFloat(emoMap[k].pnl.toFixed(2)) };
        });

        // Legacy set-based fields — sorted alphabetically for determinism
        const assetTypes = Array.from(new Set(trades.map(function (t) { return t.assetType; }))).sort();
        const strategies = Array.from(new Set(trades.map(function (t) { return t.setupType; }).filter(Boolean))).sort();

        return {
            tradeCount:          trades.length,
            totalPnl:            parseFloat(totalPnl.toFixed(2)),
            wins:                winTrades.length,
            losses:              lossTrades.length,
            winRate,
            avgPnl:              parseFloat(avgPnl.toFixed(2)),
            avgWin:              parseFloat(avgWin.toFixed(2)),
            avgLoss:             parseFloat(avgLoss.toFixed(2)),
            profitFactor,
            expectancy,
            largestWin,
            largestLoss,
            avgHoldMins,
            strategyBreakdown,
            instrumentBreakdown,
            emotionBreakdown,
            assetTypes,
            strategies,
        };
    }

    /**
     * Build the compact AI payload from an AIRequest.
     * Returns an object safe to JSON-serialize and send to any AI provider.
     *
     * @param {import('./types').AIRequest} request
     * @returns {{ trades: Array<Object>, summary: Object, filters: Object }}
     */
    function buildPayload(request) {
        request = request || {};
        const rawTrades = Array.isArray(request.tradeData) ? request.tradeData : [];

        const filtered = _applyFilters(rawTrades, {
            accountFilter:  request.accountFilter,
            dateRange:      request.dateRange,
            instrumentType: request.instrumentType,
            strategyFilter: request.strategyFilter,
            styleFilter:    request.styleFilter,
        });

        const trades = _sortTrades(filtered.map(_normaliseTrade).filter(Boolean));

        const summary = _buildAnalytics(trades);

        const activeFilters = {};
        if (request.accountFilter  && request.accountFilter  !== 'all') activeFilters.account   = request.accountFilter;
        if (request.dateRange)                                            activeFilters.dateRange  = request.dateRange;
        if (request.instrumentType && request.instrumentType !== 'all')  activeFilters.instrument = request.instrumentType;
        if (request.strategyFilter && request.strategyFilter !== 'all')  activeFilters.strategy  = request.strategyFilter === NO_STRATEGY ? 'No Strategy' : request.strategyFilter;
        if (request.styleFilter    && request.styleFilter    !== 'all')  activeFilters.style     = request.styleFilter;
        if (request.symbol)                                               activeFilters.symbol    = request.symbol;

        return { trades, summary, filters: activeFilters };
    }

    // Expose on the global DenAriiAI namespace (created by index.js)
    global._DenAriiAIFormatter = { buildPayload };

}(window));
