        // ═══════════════════════════════════════════════════════
        // ANALYTICS HELPERS — Shared Analysis Functions
        //
        // Reusable trade-analysis algorithms for modern pages:
        //   - analyzeHoldTime      (used by timing.js)
        //   - analyzePositionSize
        //   - analyzeTickers
        //   - analyzeTimePatterns
        // ═══════════════════════════════════════════════════════
        (function () {
            'use strict';


            // ========== ANALYSIS ALGORITHMS ==========

            function analyzeHoldTime(trades) {
                const buckets = [
                    { name: 'Under 30s', min: 0, max: 30, trades: [] },
                    { name: '30s-1min', min: 30, max: 60, trades: [] },
                    { name: '1-2min', min: 60, max: 120, trades: [] },
                    { name: '2-5min', min: 120, max: 300, trades: [] },
                    { name: '5-10min', min: 300, max: 600, trades: [] },
                    { name: '10-15min', min: 600, max: 900, trades: [] },
                    { name: '15-20min', min: 900, max: 1200, trades: [] },
                    { name: '20-30min', min: 1200, max: 1800, trades: [] },
                    { name: '30-60min', min: 1800, max: 3600, trades: [] },
                    { name: '60min+', min: 3600, max: Infinity, trades: [] }
                ];

                trades.forEach(t => {
                    const bucket = buckets.find(b => t.holdSeconds >= b.min && t.holdSeconds < b.max);
                    if (bucket) bucket.trades.push(t);
                });

                return buckets.map(b => {
                    const pnl = b.trades.reduce((sum, t) => sum + t.pnl, 0);
                    const winners = b.trades.filter(t => t.pnl > 0).length;
                    const winRate = b.trades.length > 0 ? (winners / b.trades.length * 100).toFixed(1) : 0;
                    const avgPnL = b.trades.length > 0 ? pnl / b.trades.length : 0;

                    return {
                        name: b.name,
                        min: b.min,
                        count: b.trades.length,
                        pnl,
                        winRate: parseFloat(winRate),
                        avgPnL,
                        trades: b.trades
                    };
                });
            }

            function analyzePositionSize(trades) {
                const buckets = [
                    { name: '1-3 contracts', min: 1, max: 3, trades: [] },
                    { name: '4-5 contracts', min: 4, max: 5, trades: [] },
                    { name: '6-10 contracts', min: 6, max: 10, trades: [] },
                    { name: '11-15 contracts', min: 11, max: 15, trades: [] },
                    { name: '16-20 contracts', min: 16, max: 20, trades: [] },
                    { name: '21-25 contracts', min: 21, max: 25, trades: [] },
                    { name: '26-30 contracts', min: 26, max: 30, trades: [] },
                    { name: '31-50 contracts', min: 31, max: 50, trades: [] },
                    { name: '50+ contracts', min: 50, max: Infinity, trades: [] }
                ];

                trades.forEach(t => {
                    const bucket = buckets.find(b => t.quantity >= b.min && t.quantity <= b.max);
                    if (bucket) bucket.trades.push(t);
                });

                return buckets.map(b => {
                    const pnl = b.trades.reduce((sum, t) => sum + t.pnl, 0);
                    const winners = b.trades.filter(t => t.pnl > 0).length;
                    const winRate = b.trades.length > 0 ? (winners / b.trades.length * 100).toFixed(1) : 0;

                    return {
                        name: b.name,
                        count: b.trades.length,
                        pnl,
                        winRate: parseFloat(winRate),
                        avgPnL: b.trades.length > 0 ? pnl / b.trades.length : 0
                    };
                });
            }

            function analyzeTickers(trades) {
                const map = {};

                trades.forEach(t => {
                    if (!map[t.symbol]) map[t.symbol] = { symbol: t.symbol, trades: [], pnl: 0 };
                    map[t.symbol].trades.push(t);
                    map[t.symbol].pnl += t.pnl;
                });

                return Object.values(map).map(t => {
                    const winners = t.trades.filter(tr => tr.pnl > 0).length;
                    const winRate = (winners / t.trades.length * 100).toFixed(1);
                    const dollarPerTrade = t.pnl / t.trades.length;

                    let label = 'MARGINAL';
                    if (t.pnl > 0 && parseFloat(winRate) >= 60) label = 'EDGE';
                    else if (t.pnl < -50 && t.pnl >= -100) label = 'LEAK';
                    else if (t.pnl < -100 && t.pnl >= -500) label = 'BLEEDING';
                    else if (t.pnl < -500) label = 'HEMORRHAGE';

                    return {
                        symbol: t.symbol,
                        count: t.trades.length,
                        pnl: t.pnl,
                        winRate: parseFloat(winRate),
                        dollarPerTrade,
                        label
                    };
                }).sort((a, b) => b.pnl - a.pnl);
            }

            function analyzeTimePatterns(trades) {
                // Day of week
                const dayOfWeek = {
                    'Monday': [], 'Tuesday': [], 'Wednesday': [], 'Thursday': [], 'Friday': []
                };

                trades.forEach(t => {
                    const day = new Date(t.exitTime).toLocaleDateString('en-US', { weekday: 'long' });
                    if (dayOfWeek[day]) dayOfWeek[day].push(t);
                });

                const dayStats = Object.keys(dayOfWeek).map(day => {
                    const dayTrades = dayOfWeek[day];
                    const pnl = dayTrades.reduce((sum, t) => sum + t.pnl, 0);
                    const winners = dayTrades.filter(t => t.pnl > 0).length;
                    const winRate = dayTrades.length > 0 ? (winners / dayTrades.length * 100).toFixed(1) : 0;

                    return { day, count: dayTrades.length, pnl, winRate: parseFloat(winRate) };
                });

                // First 10 minutes vs rest
                const first10min = trades.filter(t => {
                    const exitHour = new Date(t.exitTime).getHours();
                    const exitMin = new Date(t.exitTime).getMinutes();
                    return exitHour === 9 && exitMin < 40; // Market opens at 9:30
                });

                const restOfDay = trades.filter(t => {
                    const exitHour = new Date(t.exitTime).getHours();
                    const exitMin = new Date(t.exitTime).getMinutes();
                    return !(exitHour === 9 && exitMin < 40);
                });

                const first10Stats = {
                    count: first10min.length,
                    pnl: first10min.reduce((sum, t) => sum + t.pnl, 0),
                    winRate: first10min.length > 0
                        ? (first10min.filter(t => t.pnl > 0).length / first10min.length * 100).toFixed(1)
                        : 0
                };

                const restStats = {
                    count: restOfDay.length,
                    pnl: restOfDay.reduce((sum, t) => sum + t.pnl, 0),
                    winRate: restOfDay.length > 0
                        ? (restOfDay.filter(t => t.pnl > 0).length / restOfDay.length * 100).toFixed(1)
                        : 0
                };

                return { dayOfWeek: dayStats, first10min: first10Stats, restOfDay: restStats };
            }

            // ── Expose analysis functions for modern pages ──
            window.analyzeHoldTime      = analyzeHoldTime;
            window.analyzePositionSize  = analyzePositionSize;
            window.analyzeTickers       = analyzeTickers;
            window.analyzeTimePatterns  = analyzeTimePatterns;

        }());
