        // ═══════════════════════════════════════════════════════
        // RISK PAGE — Phase 1
        // Where am I exposing myself to avoidable damage?
        //
        // Depends on globals: journalData, saveToIndexedDB.
        // Plotly must be loaded before this file.
        // ═══════════════════════════════════════════════════════
        (function() {
            'use strict';

            // ── Constants ─────────────────────────────────────
            var BLOWUP_THRESHOLD = -200;
            var OVERSIZE_MULTIPLE = 2;

            // ── State ─────────────────────────────────────────
            var _state = {
                period: 'all',
                from: '', to: '',
                style: 'all', assetType: 'all', strategy: 'all', symbol: '',
                editMode: false, layout: null
            };

            // ── Default layout ────────────────────────────────
            var RK_DEFAULT = [
                { id: 'rk10', wid: 'risk-size-impact-insight', size: 'large'  },
                { id: 'rk1', wid: 'risk-largest-loss',        size: 'small'  },
                { id: 'rk2', wid: 'risk-avg-loss',            size: 'small'  },
                { id: 'rk3', wid: 'risk-rr-ratio',            size: 'small'  },
                { id: 'rk4', wid: 'risk-blowup-count',        size: 'small'  },
                { id: 'rk5', wid: 'risk-damage-concentration', size: 'medium' },
                { id: 'rk6', wid: 'risk-position-size',       size: 'large'  },
                { id: 'rk7', wid: 'risk-stop-modeling',        size: 'large'  },
                { id: 'rk8', wid: 'risk-blowup-table',        size: 'medium' },
                { id: 'rk9', wid: 'risk-oversized-trades',    size: 'medium' }
            ];

            // ── Widget catalog ────────────────────────────────
            var RK_LIB = [
                { wid: 'risk-largest-loss',        name: 'Largest Single Loss',      desc: 'The single largest losing trade in the filtered period',          cat: 'KPI',     def: 'small'  },
                { wid: 'risk-avg-loss',            name: 'Average Loss',             desc: 'Average P&L of all losing trades',                                cat: 'KPI',     def: 'small'  },
                { wid: 'risk-rr-ratio',            name: 'Win/Loss Asymmetry',       desc: 'Risk/reward ratio: avg win vs avg loss',                           cat: 'KPI',     def: 'small'  },
                { wid: 'risk-blowup-count',        name: 'Blowup Days',             desc: 'Days with losses exceeding $200',                                  cat: 'KPI',     def: 'small'  },
                { wid: 'risk-position-size',       name: 'Position Size Analysis',   desc: 'P&L performance by position size bracket',                         cat: 'Sizing',  def: 'large'  },
                { wid: 'risk-stop-modeling',        name: 'Stop-Loss Modeling',       desc: 'Modeled impact of daily stop-loss levels on results',              cat: 'Stops',   def: 'large'  },
                { wid: 'risk-blowup-table',        name: 'Blowup Day Detail',        desc: 'Table of days with catastrophic losses',                           cat: 'Damage',  def: 'medium' },
                { wid: 'risk-damage-concentration', name: 'Damage Concentration',     desc: 'How much of total losses come from the worst outliers',            cat: 'Damage',  def: 'medium' },
                { wid: 'risk-oversized-trades',    name: 'Oversized Trades',         desc: 'Trades where position size far exceeded your median',              cat: 'Sizing',  def: 'medium' },
                { wid: 'risk-size-impact-insight', name: 'Size Impact Insight',      desc: 'Plain-language interpretation of whether larger size helps or hurts', cat: 'Insight', def: 'medium' },
            ];

            // ── Helpers ───────────────────────────────────────
            function fmt$(n) {
                if (n == null || isNaN(n)) return '—';
                var abs = Math.abs(n);
                var s = abs >= 1000 ? '$' + Math.round(abs).toLocaleString() : '$' + abs.toFixed(2);
                return (n < 0 ? '-' : '') + s;
            }
            function fmtPct(n) { return (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'; }
            function pnlColorClass(n) {
                if (n == null || isNaN(n) || n === 0) return 'snap-kpi-neutral';
                return n > 0 ? 'snap-kpi-positive' : 'snap-kpi-negative';
            }
            function fmtDate(iso) {
                if (!iso) return '—';
                var d = new Date(iso);
                if (isNaN(d)) return '—';
                var months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                return months[d.getMonth()] + ' ' + d.getDate();
            }

            // ── Filter trades ─────────────────────────────────
            function getRiskTrades() {
                return DenariiFilters.filterTrades(getSelectedAccountTrades(journalData.trades), _state, journalData.brokerAccounts, new Date());
            }

            // ── Risk analysis ─────────────────────────────────
            function analyzeRisk(trades) {
                var m = {
                    losers: [], winners: [],
                    totalLosses: 0, totalWins: 0,
                    avgLoss: 0, avgWin: 0,
                    largestLoss: null,
                    rrRatio: 0,
                    // Daily
                    dailyMap: {},
                    blowupDays: [],
                    blowupCost: 0,
                    // Stop modeling
                    stopAnalysis: [],
                    // Position size
                    sizeBuckets: [],
                    // Oversized
                    medianSize: 0,
                    oversized: []
                };

                if (!trades.length) return m;

                // Split winners/losers
                trades.forEach(function(t) {
                    var pnl = t.pnl || 0;
                    if (pnl < 0) { m.losers.push(t); m.totalLosses += pnl; }
                    else if (pnl > 0) { m.winners.push(t); m.totalWins += pnl; }
                });

                // Avg win / avg loss
                m.avgLoss = m.losers.length ? m.totalLosses / m.losers.length : 0;
                m.avgWin  = m.winners.length ? m.totalWins / m.winners.length : 0;
                m.rrRatio = Math.abs(m.avgLoss) > 0 ? m.avgWin / Math.abs(m.avgLoss) : 0;

                // Largest single loss
                if (m.losers.length) {
                    m.largestLoss = m.losers.reduce(function(worst, t) {
                        return (t.pnl || 0) < (worst.pnl || 0) ? t : worst;
                    }, m.losers[0]);
                }

                // Daily P&L map
                trades.forEach(function(t) {
                    var ds = DenariiFilters.localDayKey(t.exitTime || t.entryTime);
                    if (!ds) return;
                    if (!m.dailyMap[ds]) m.dailyMap[ds] = { date: ds, trades: [], pnl: 0 };
                    m.dailyMap[ds].trades.push(t);
                    m.dailyMap[ds].pnl += (t.pnl || 0);
                });

                var daily = Object.keys(m.dailyMap).sort().map(function(ds) { return m.dailyMap[ds]; });
                var ytd = 0;
                daily.forEach(function(d) {
                    ytd += d.pnl;
                    d.ytd = ytd;
                    d.count = d.trades.length;
                    d.blowup = d.pnl < BLOWUP_THRESHOLD;
                    if (d.blowup) {
                        m.blowupDays.push(d);
                        m.blowupCost += d.pnl;
                    }
                });

                // Stop-loss modeling (migrated from legacy)
                var avgLossAbs = m.losers.length
                    ? Math.abs(m.totalLosses / m.losers.length)
                    : 50;
                var stopLevels = [
                    avgLossAbs * 1,
                    avgLossAbs * 2,
                    avgLossAbs * 3,
                    300, 500, 750, 1000
                ];
                m.stopAnalysis = stopLevels.map(function(stopLevel) {
                    var adjustedYTD = 0;
                    var breachDays = [];
                    var saved = 0;
                    daily.forEach(function(d) {
                        if (d.pnl < -stopLevel) {
                            adjustedYTD += -stopLevel;
                            saved += (Math.abs(d.pnl) - stopLevel);
                            breachDays.push({ date: d.date, actual: d.pnl, excess: Math.abs(d.pnl) - stopLevel });
                        } else {
                            adjustedYTD += d.pnl;
                        }
                    });
                    return { level: stopLevel, adjustedYTD: adjustedYTD, saved: saved, breachDays: breachDays, breachCount: breachDays.length };
                });

                // Position size analysis (migrated from legacy)
                var buckets = [
                    { name: '1–3', min: 1, max: 3, trades: [] },
                    { name: '4–5', min: 4, max: 5, trades: [] },
                    { name: '6–10', min: 6, max: 10, trades: [] },
                    { name: '11–15', min: 11, max: 15, trades: [] },
                    { name: '16–20', min: 16, max: 20, trades: [] },
                    { name: '21–25', min: 21, max: 25, trades: [] },
                    { name: '26–30', min: 26, max: 30, trades: [] },
                    { name: '31–50', min: 31, max: 50, trades: [] },
                    { name: '50+', min: 50, max: Infinity, trades: [] }
                ];
                trades.forEach(function(t) {
                    var q = t.quantity || 0;
                    var bucket = buckets.find(function(b) { return q >= b.min && q <= b.max; });
                    if (bucket) bucket.trades.push(t);
                });
                m.sizeBuckets = buckets.map(function(b) {
                    var pnl = b.trades.reduce(function(s, t) { return s + (t.pnl || 0); }, 0);
                    var wins = b.trades.filter(function(t) { return (t.pnl || 0) > 0; }).length;
                    var wr = b.trades.length > 0 ? (wins / b.trades.length * 100) : 0;
                    return { name: b.name, count: b.trades.length, pnl: pnl, winRate: wr, avgPnl: b.trades.length > 0 ? pnl / b.trades.length : 0 };
                });

                // Oversized trades
                var sizes = trades.map(function(t) { return t.quantity || 0; }).filter(function(q) { return q > 0; }).sort(function(a, b) { return a - b; });
                if (sizes.length) {
                    var mid = Math.floor(sizes.length / 2);
                    m.medianSize = sizes.length % 2 !== 0 ? sizes[mid] : (sizes[mid - 1] + sizes[mid]) / 2;
                }
                if (m.medianSize > 0) {
                    var threshold = m.medianSize * OVERSIZE_MULTIPLE;
                    m.oversized = trades.filter(function(t) {
                        return (t.quantity || 0) >= threshold;
                    }).map(function(t) {
                        return {
                            date: t.exitTime || t.entryTime || '',
                            symbol: t.symbol || '—',
                            size: t.quantity || 0,
                            pnl: t.pnl || 0,
                            multiple: (t.quantity || 0) / m.medianSize
                        };
                    }).sort(function(a, b) { return a.pnl - b.pnl; });
                }

                return m;
            }

            // ── Widget shell ──────────────────────────────────
            function widgetHtml(id, title, bodyHtml, size) {
                var dragAttr = _state.editMode ? ' draggable="true"' : '';
                var handle   = _state.editMode
                    ? '<span class="snap-drag-handle" title="Drag to reorder">⠿</span>'
                    : '';
                var controls = _state.editMode
                    ? '<div class="snap-widget-controls">' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='small'?' snap-ctrl-sz-active':'')+'" onclick="riskResizeWidget(\''+id+'\',\'small\')" title="Small">S</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='medium'?' snap-ctrl-sz-active':'')+'" onclick="riskResizeWidget(\''+id+'\',\'medium\')" title="Medium">M</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='large'?' snap-ctrl-sz-active':'')+'" onclick="riskResizeWidget(\''+id+'\',\'large\')" title="Large">L</button>' +
                          '<span class="snap-ctrl-sep"></span>' +
                          '<button class="snap-ctrl-btn snap-ctrl-remove" onclick="riskRemoveWidget(\''+id+'\')" title="Remove widget">✕</button>' +
                      '</div>'
                    : '';
                return '<div class="snap-widget snap-widget--'+size+'"'+dragAttr+' data-instance-id="'+id+'">' +
                    '<div class="snap-widget-header">' +
                        handle +
                        '<span class="snap-widget-title">'+title+'</span>' +
                        controls +
                    '</div>' +
                    '<div class="snap-widget-body">'+bodyHtml+'</div>' +
                '</div>';
            }
            function kpiHtml(value, sub, colorClass) {
                return '<div class="snap-kpi-value '+(colorClass||'snap-kpi-neutral')+'">'+value+'</div>' +
                       '<div class="snap-kpi-sub">'+(sub||'')+'</div>';
            }

            // ── Renderers ─────────────────────────────────────
            var RENDERERS = {

                'risk-largest-loss': function(id, trades, m, sz) {
                    if (!m.largestLoss) return widgetHtml(id, 'Largest Single Loss', '<div class="snap-empty">No losing trades.</div>', sz);
                    var t = m.largestLoss;
                    var sub = (t.symbol || '—') + ' · ' + fmtDate(t.exitTime || t.entryTime);
                    return widgetHtml(id, 'Largest Single Loss', kpiHtml(
                        fmt$(t.pnl), sub, 'snap-kpi-negative'), sz);
                },

                'risk-avg-loss': function(id, trades, m, sz) {
                    if (!m.losers.length) return widgetHtml(id, 'Average Loss', '<div class="snap-empty">No losing trades.</div>', sz);
                    return widgetHtml(id, 'Average Loss', kpiHtml(
                        fmt$(m.avgLoss),
                        'across ' + m.losers.length + ' loser' + (m.losers.length !== 1 ? 's' : ''),
                        'snap-kpi-negative'), sz);
                },

                'risk-rr-ratio': function(id, trades, m, sz) {
                    if (!m.winners.length && !m.losers.length) return widgetHtml(id, 'Win/Loss Asymmetry', '<div class="snap-empty">No data.</div>', sz);
                    var ratioStr = m.rrRatio > 0 ? m.rrRatio.toFixed(2) + ':1' : '—';
                    var colorCls = m.rrRatio >= 2 ? 'snap-kpi-positive' : (m.rrRatio >= 1 ? 'snap-kpi-neutral' : 'snap-kpi-negative');
                    var sub = (m.avgWin >= 0 ? '+' : '') + fmt$(m.avgWin) + ' vs ' + fmt$(m.avgLoss);
                    return widgetHtml(id, 'Win/Loss Asymmetry', kpiHtml(ratioStr, sub, colorCls), sz);
                },

                'risk-blowup-count': function(id, trades, m, sz) {
                    var count = m.blowupDays.length;
                    var sub = count > 0
                        ? 'Cost: ' + fmt$(m.blowupCost) + ' total'
                        : 'No days exceeded ' + fmt$(Math.abs(BLOWUP_THRESHOLD)) + ' loss';
                    return widgetHtml(id, 'Blowup Days', kpiHtml(
                        String(count),
                        sub,
                        count > 0 ? 'snap-kpi-negative' : 'snap-kpi-positive'), sz);
                },

                'risk-position-size': function(id, trades, m, sz) {
                    var rows = m.sizeBuckets.filter(function(b) { return b.count > 0; });
                    if (!rows.length) return widgetHtml(id, 'Position Size Analysis', '<div class="snap-empty">No trade data.</div>', sz);
                    // Find best bucket by avgPnl
                    var bestAvg = -Infinity;
                    rows.forEach(function(b) { if (b.avgPnl > bestAvg) bestAvg = b.avgPnl; });
                    var html = rows.map(function(b) {
                        var pnlColor = b.pnl >= 0 ? 'var(--success)' : 'var(--danger)';
                        var avgColor = b.avgPnl >= 0 ? 'var(--success)' : 'var(--danger)';
                        var highlight = b.avgPnl === bestAvg && bestAvg > 0 ? ' style="background:rgba(34,197,94,0.08);"' : '';
                        return '<tr' + highlight + '>' +
                            '<td><strong>' + DenariiFilters.esc(b.name) + '</strong></td>' +
                            '<td>' + b.count + '</td>' +
                            '<td style="color:' + pnlColor + ';font-weight:600;">' + (b.pnl >= 0 ? '+' : '') + fmt$(b.pnl) + '</td>' +
                            '<td>' + fmtPct(b.winRate) + '</td>' +
                            '<td style="color:' + avgColor + ';font-weight:600;">' + (b.avgPnl >= 0 ? '+' : '') + fmt$(b.avgPnl) + '</td>' +
                        '</tr>';
                    }).join('');
                    var body = '<div style="overflow-x:auto;"><table class="snap-trades-table">' +
                        '<thead><tr><th>Size</th><th>Trades</th><th>Net P&L</th><th>Win Rate</th><th>Avg P&L</th></tr></thead>' +
                        '<tbody>' + html + '</tbody></table></div>';
                    return widgetHtml(id, 'Position Size Analysis', body, sz);
                },

                'risk-stop-modeling': function(id, trades, m, sz) {
                    if (!m.stopAnalysis.length) return widgetHtml(id, 'Stop-Loss Modeling', '<div class="snap-empty">No data.</div>', sz);
                    // Find best stop
                    var bestStop = m.stopAnalysis.reduce(function(best, s) {
                        return s.adjustedYTD > best.adjustedYTD ? s : best;
                    }, m.stopAnalysis[0]);

                    var banner = '<div class="risk-stop-banner">' +
                        '<strong>Optimal Daily Stop: ' + fmt$(bestStop.level) + '</strong>' +
                        '<span>Would save ' + fmt$(bestStop.saved) + ' across ' + bestStop.breachCount + ' breach day' + (bestStop.breachCount !== 1 ? 's' : '') + '</span>' +
                        '<span>Adjusted P&L: <strong style="color:' + (bestStop.adjustedYTD >= 0 ? 'var(--success)' : 'var(--danger)') + ';">' + (bestStop.adjustedYTD >= 0 ? '+' : '') + fmt$(bestStop.adjustedYTD) + '</strong></span>' +
                    '</div>';

                    var sorted = m.stopAnalysis.slice().sort(function(a, b) { return a.level - b.level; });
                    var rows = sorted.map(function(s) {
                        var isBest = s.level === bestStop.level;
                        var highlight = isBest ? ' style="background:rgba(34,197,94,0.08);"' : '';
                        var ytdColor = s.adjustedYTD >= 0 ? 'var(--success)' : 'var(--danger)';
                        return '<tr' + highlight + '>' +
                            '<td><strong>' + fmt$(s.level) + '</strong></td>' +
                            '<td>' + s.breachCount + '</td>' +
                            '<td style="color:var(--success);font-weight:600;">' + fmt$(s.saved) + '</td>' +
                            '<td style="color:' + ytdColor + ';font-weight:600;">' + (s.adjustedYTD >= 0 ? '+' : '') + fmt$(s.adjustedYTD) + '</td>' +
                        '</tr>';
                    }).join('');
                    var body = banner +
                        '<div style="overflow-x:auto;"><table class="snap-trades-table">' +
                        '<thead><tr><th>Stop Level</th><th>Breach Days</th><th>Saved</th><th>Adjusted P&L</th></tr></thead>' +
                        '<tbody>' + rows + '</tbody></table></div>';
                    return widgetHtml(id, 'Stop-Loss Modeling', body, sz);
                },

                'risk-blowup-table': function(id, trades, m, sz) {
                    if (!m.blowupDays.length) return widgetHtml(id, 'Blowup Day Detail', '<div class="snap-empty">No blowup days found.</div>', sz);
                    var totalLoss = Math.abs(m.totalLosses) || 1;
                    var rows = m.blowupDays.slice().sort(function(a, b) { return a.pnl - b.pnl; }).map(function(d) {
                        var pctOfLosses = (Math.abs(d.pnl) / totalLoss * 100);
                        return '<tr style="background:rgba(239,68,68,0.06);">' +
                            '<td>' + d.date + '</td>' +
                            '<td>' + d.count + '</td>' +
                            '<td style="color:var(--danger);font-weight:600;">' + fmt$(d.pnl) + '</td>' +
                            '<td style="color:var(--danger);font-weight:600;">' + fmt$(d.ytd) + '</td>' +
                            '<td>' + fmtPct(pctOfLosses) + '</td>' +
                        '</tr>';
                    }).join('');
                    var body = '<div style="overflow-x:auto;"><table class="snap-trades-table">' +
                        '<thead><tr><th>Date</th><th>Trades</th><th>P&L</th><th>YTD</th><th>% of Losses</th></tr></thead>' +
                        '<tbody>' + rows + '</tbody></table></div>';
                    return widgetHtml(id, 'Blowup Day Detail', body, sz);
                },

                'risk-damage-concentration': function(id, trades, m, sz) {
                    if (!m.losers.length) return widgetHtml(id, 'Damage Concentration', '<div class="snap-empty">No losing trades.</div>', sz);
                    var totalLoss = Math.abs(m.totalLosses);
                    // Worst trades by P&L (most negative first)
                    var sortedLosers = m.losers.slice().sort(function(a, b) { return (a.pnl || 0) - (b.pnl || 0); });
                    function worstNPct(n) {
                        var slice = sortedLosers.slice(0, Math.min(n, sortedLosers.length));
                        var sum = slice.reduce(function(s, t) { return s + Math.abs(t.pnl || 0); }, 0);
                        return totalLoss > 0 ? (sum / totalLoss * 100) : 0;
                    }
                    // Worst days
                    var sortedDays = m.blowupDays.length > 0
                        ? Object.keys(m.dailyMap).map(function(k) { return m.dailyMap[k]; })
                            .filter(function(d) { return d.pnl < 0; })
                            .sort(function(a, b) { return a.pnl - b.pnl; })
                        : [];
                    function worstNDaysPct(n) {
                        var slice = sortedDays.slice(0, Math.min(n, sortedDays.length));
                        var sum = slice.reduce(function(s, d) { return s + Math.abs(d.pnl); }, 0);
                        return totalLoss > 0 ? (sum / totalLoss * 100) : 0;
                    }

                    var w5  = worstNPct(5);
                    var w10 = worstNPct(10);
                    var d3  = worstNDaysPct(3);

                    var body = '<div class="risk-conc-grid">' +
                        '<div class="risk-conc-item">' +
                            '<div class="risk-conc-pct">' + fmtPct(w5) + '</div>' +
                            '<div class="risk-conc-label">Worst 5 trades</div>' +
                        '</div>' +
                        '<div class="risk-conc-item">' +
                            '<div class="risk-conc-pct">' + fmtPct(w10) + '</div>' +
                            '<div class="risk-conc-label">Worst 10 trades</div>' +
                        '</div>' +
                        '<div class="risk-conc-item">' +
                            '<div class="risk-conc-pct">' + fmtPct(d3) + '</div>' +
                            '<div class="risk-conc-label">Worst 3 days</div>' +
                        '</div>' +
                    '</div>' +
                    '<div class="risk-conc-hint">' +
                        (w5 > 50 ? 'Damage is highly concentrated — cutting a few outlier trades would materially improve results.'
                                 : 'Losses are spread across many trades — systemic adjustments needed rather than outlier control.') +
                    '</div>';
                    return widgetHtml(id, 'Damage Concentration', body, sz);
                },

                'risk-oversized-trades': function(id, trades, m, sz) {
                    if (!m.oversized.length) {
                        var msg = m.medianSize > 0
                            ? 'No trades at ' + OVERSIZE_MULTIPLE + 'x+ median size (' + m.medianSize + ').'
                            : 'No position size data available.';
                        return widgetHtml(id, 'Oversized Trades', '<div class="snap-empty">' + msg + '</div>', sz);
                    }
                    var rows = m.oversized.slice(0, 20).map(function(t) {
                        var pnlColor = t.pnl >= 0 ? 'var(--success)' : 'var(--danger)';
                        return '<tr>' +
                            '<td>' + fmtDate(t.date) + '</td>' +
                            '<td><strong>' + t.symbol + '</strong></td>' +
                            '<td>' + t.size + '</td>' +
                            '<td style="color:' + pnlColor + ';font-weight:600;">' + (t.pnl >= 0 ? '+' : '') + fmt$(t.pnl) + '</td>' +
                            '<td>' + m.medianSize + '</td>' +
                            '<td>' + t.multiple.toFixed(1) + 'x</td>' +
                        '</tr>';
                    }).join('');
                    var body = '<div style="overflow-x:auto;"><table class="snap-trades-table">' +
                        '<thead><tr><th>Date</th><th>Symbol</th><th>Size</th><th>P&L</th><th>Median</th><th>Multiple</th></tr></thead>' +
                        '<tbody>' + rows + '</tbody></table></div>';
                    return widgetHtml(id, 'Oversized Trades', body, sz);
                },

                'risk-size-impact-insight': function(id, trades, m, sz) {
                    var active = m.sizeBuckets.filter(function(b) { return b.count >= 5; });
                    if (active.length < 2) {
                        return widgetHtml(id, 'Size Impact Insight',
                            '<div class="rk-insight-text">Not enough size data to compare. Need at least 2 brackets with 5+ trades each.</div>', sz);
                    }

                    // Split into smaller half and larger half by bucket order
                    var mid = Math.ceil(active.length / 2);
                    var smaller = active.slice(0, mid);
                    var larger  = active.slice(mid);

                    var smallTrades = 0, smallPnl = 0;
                    smaller.forEach(function(b) { smallTrades += b.count; smallPnl += b.pnl; });
                    var largeTrades = 0, largePnl = 0;
                    larger.forEach(function(b) { largeTrades += b.count; largePnl += b.pnl; });

                    var smallAvg = smallTrades > 0 ? smallPnl / smallTrades : 0;
                    var largeAvg = largeTrades > 0 ? largePnl / largeTrades : 0;
                    var gap = smallAvg - largeAvg;

                    var text = '';
                    if (gap > 10 && largeAvg < 0) {
                        text = 'Your results degrade at larger size. Smaller brackets average ' +
                            (smallAvg >= 0 ? '+' : '') + fmt$(smallAvg) + '/trade, while larger brackets average ' +
                            (largeAvg >= 0 ? '+' : '') + fmt$(largeAvg) + '/trade.';
                    } else if (gap < -10 && largeAvg > 0) {
                        text = 'Larger size is actually improving your results. Larger brackets average ' +
                            '+' + fmt$(largeAvg) + '/trade vs ' +
                            (smallAvg >= 0 ? '+' : '') + fmt$(smallAvg) + '/trade for smaller brackets.';
                    } else {
                        text = 'Size impact is not clearly directional in the current view. Performance is relatively stable across brackets.';
                    }

                    return widgetHtml(id, 'Size Impact Insight',
                        '<div class="rk-insight-text">' + text + '</div>', sz);
                }
            };

            // ── Drag-and-drop ─────────────────────────────────
            var _drag = { srcId: null, overId: null };

            function setupRiskDrag() {
                var grid = document.getElementById('risk-grid');
                if (!grid || grid._riskDragBound) return;
                grid._riskDragBound = true;

                grid.addEventListener('dragstart', function(e) {
                    if (!_state.editMode) { e.preventDefault(); return; }
                    if (e.target.tagName === 'BUTTON') { e.preventDefault(); return; }
                    var widget = e.target.closest('[data-instance-id]');
                    if (!widget) return;
                    _drag.srcId  = widget.dataset.instanceId;
                    _drag.overId = null;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', _drag.srcId);
                    setTimeout(function() { widget.classList.add('snap-dragging'); }, 0);
                });

                grid.addEventListener('dragend', function() {
                    _drag.srcId  = null;
                    _drag.overId = null;
                    grid.querySelectorAll('.snap-dragging, .snap-drag-over').forEach(function(el) {
                        el.classList.remove('snap-dragging', 'snap-drag-over');
                    });
                });

                grid.addEventListener('dragover', function(e) {
                    if (!_state.editMode || !_drag.srcId) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = 'move';
                    var widget = e.target.closest('[data-instance-id]');
                    if (!widget) return;
                    var overId = widget.dataset.instanceId;
                    if (overId === _drag.overId) return;
                    grid.querySelectorAll('.snap-drag-over').forEach(function(el) {
                        el.classList.remove('snap-drag-over');
                    });
                    _drag.overId = overId;
                    if (overId !== _drag.srcId) widget.classList.add('snap-drag-over');
                });

                grid.addEventListener('drop', function(e) {
                    if (!_state.editMode || !_drag.srcId) return;
                    e.preventDefault();
                    var widget = e.target.closest('[data-instance-id]');
                    if (!widget) return;
                    var targetId = widget.dataset.instanceId;
                    if (!targetId || targetId === _drag.srcId) return;

                    var layout = _state.layout;
                    var srcIdx = layout.findIndex(function(w) { return w.id === _drag.srcId; });
                    var tgtIdx = layout.findIndex(function(w) { return w.id === targetId; });
                    if (srcIdx < 0 || tgtIdx < 0) return;

                    var moved = layout.splice(srcIdx, 1)[0];
                    var newTgt = layout.findIndex(function(w) { return w.id === targetId; });
                    layout.splice(newTgt, 0, moved);

                    _drag.srcId  = null;
                    _drag.overId = null;
                    saveLayout();
                    renderRisk();
                });
            }

            // ── Main render ───────────────────────────────────
            function renderRisk() {
                Object.assign(_state, DenariiFilters.readState('risk'));

                var trades = getRiskTrades();
                var m      = analyzeRisk(trades);
                var layout = _state.layout || RK_DEFAULT.map(function(w) { return Object.assign({}, w); });

                var grid = document.getElementById('risk-grid');
                if (!grid) return;
                grid.className = 'snap-grid' + (_state.editMode ? ' snap-edit-mode' : '');
                grid.innerHTML = layout.map(function(item) {
                    return RENDERERS[item.wid] ? RENDERERS[item.wid](item.id, trades, m, item.size || 'small') : '';
                }).join('');
            }

            // ── Populate filter dropdowns ─────────────────────
            function populateRiskFilters() {
                var stlSel   = document.getElementById('risk-style');
                var perSel   = document.getElementById('risk-period');
                var astSel   = document.getElementById('risk-asset-type');
                var stratSel = document.getElementById('risk-strategy');
                var symEl    = document.getElementById('risk-symbol');
                var fromEl   = document.getElementById('risk-from');
                var toEl     = document.getElementById('risk-to');
                if (perSel) perSel.value = _state.period || 'all';
                if (stlSel) stlSel.value = _state.style || 'all';
                if (astSel) astSel.value = _state.assetType || 'all';
                if (stratSel) stratSel.value = _state.strategy || 'all';
                DenariiFilters.populateStrategy(stratSel, journalData.trades, journalData.strategies);
                DenariiFilters.followStrategyRename(stratSel, _state);
                if (symEl)  symEl.value  = _state.symbol || '';
                if (fromEl) fromEl.value = _state.from   || '';
                if (toEl)   toEl.value   = _state.to     || '';
            }

            // ── Save layout ───────────────────────────────────
            function saveLayout() {
                journalData.riskLayout = JSON.parse(JSON.stringify(_state.layout));
                if (typeof saveToIndexedDB === 'function') saveToIndexedDB();
            }

            // ── Init ──────────────────────────────────────────
            function initRisk() {
                _state.layout = journalData.riskLayout
                    ? JSON.parse(JSON.stringify(journalData.riskLayout))
                    : RK_DEFAULT.map(function(w) { return Object.assign({}, w); });
                populateRiskFilters();
                renderRisk();
                setupRiskDrag();
            }

            // ═══ Window-exposed API ═══════════════════════════

            window.renderRisk = renderRisk;

            window.toggleRiskEdit = function() {
                _state.editMode = !_state.editMode;
                var banner = document.getElementById('risk-edit-banner');
                var btn    = document.getElementById('risk-edit-btn');
                if (banner) banner.style.display = _state.editMode ? 'flex' : 'none';
                if (btn)    btn.textContent = _state.editMode ? '✓ Done Editing' : 'Edit Layout';
                renderRisk();
            };

            window.riskResizeWidget = function(id, newSize) {
                var item = (_state.layout || []).find(function(w) { return w.id === id; });
                if (item) { item.size = newSize; saveLayout(); renderRisk(); }
            };

            window.riskRemoveWidget = function(id) {
                if (!_state.layout) return;
                _state.layout = _state.layout.filter(function(w) { return w.id !== id; });
                saveLayout(); renderRisk();
            };

            window.riskResetLayout = function() {
                if (!confirm('Reset Risk widget layout to default?')) return;
                _state.layout = RK_DEFAULT.map(function(w) { return Object.assign({}, w); });
                saveLayout(); renderRisk();
            };

            window.openRiskPicker = function() {
                riskRenderPicker();
                var o = document.getElementById('risk-picker-overlay');
                var p = document.getElementById('risk-picker-panel');
                if (o) o.classList.add('open');
                if (p) p.classList.add('open');
            };

            window.closeRiskPicker = function() {
                var o = document.getElementById('risk-picker-overlay');
                var p = document.getElementById('risk-picker-panel');
                if (o) o.classList.remove('open');
                if (p) p.classList.remove('open');
            };

            function riskRenderPicker() {
                var q    = (document.getElementById('risk-picker-q') || {}).value || '';
                var body = document.getElementById('risk-picker-body');
                if (!body) return;
                var activeWids = {};
                (_state.layout || []).forEach(function(item) { activeWids[item.wid] = true; });
                var filtered = RK_LIB.filter(function(w) {
                    return !q || w.name.toLowerCase().includes(q.toLowerCase()) ||
                                 w.desc.toLowerCase().includes(q.toLowerCase());
                });
                if (!filtered.length) {
                    body.innerHTML = '<div class="snap-empty" style="padding-top:24px;">No widgets match.</div>';
                    return;
                }
                var cats = [], bycat = {};
                filtered.forEach(function(w) {
                    if (!bycat[w.cat]) { bycat[w.cat] = []; cats.push(w.cat); }
                    bycat[w.cat].push(w);
                });
                body.innerHTML = cats.map(function(cat) {
                    return '<div class="snap-picker-cat-label">' + cat + '</div>' +
                        bycat[cat].map(function(w) {
                            var added = activeWids[w.wid];
                            return '<div class="snap-picker-item' + (added ? ' snap-picker-item--added' : '') + '">' +
                                '<div class="snap-picker-item-info">' +
                                    '<div class="snap-picker-item-name">' + w.name + '</div>' +
                                    '<div class="snap-picker-item-desc">' + w.desc + '</div>' +
                                '</div>' +
                                (added
                                    ? '<span class="snap-picker-item-added">Added</span>'
                                    : '<button class="snap-picker-item-add" onclick="riskAddWidget(\'' + w.wid + '\')">+ Add</button>') +
                            '</div>';
                        }).join('');
                }).join('');
            }
            window.riskRenderPicker = riskRenderPicker;

            window.riskAddWidget = function(wid) {
                if (!_state.layout) _state.layout = [];
                var already = _state.layout.some(function(w) { return w.wid === wid; });
                if (already) return;
                var def = RK_LIB.find(function(w) { return w.wid === wid; });
                _state.layout.push({ id: 'rk' + Date.now(), wid: wid, size: def ? def.def : 'small' });
                saveLayout();
                window.closeRiskPicker();
                renderRisk();
            };

            window._riskInit = initRisk;

            // Mounted once at load. Fill Style here too: the app's first
            // _populateStyleSelects() may already have run.
            DenariiFilters.mountFilterBar(document.getElementById('risk-filter-bar'), {
                prefix: 'risk',
                onChange: renderRisk
            });
            if (typeof _populateStyleSelect === 'function') _populateStyleSelect('risk-style', true);

        })();
