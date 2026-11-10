        // ═══════════════════════════════════════════════════════
        // DISCIPLINE PAGE — Phase 1
        // Which behaviors are costing me money?
        //
        // Depends on globals: journalData, saveToIndexedDB.
        // ═══════════════════════════════════════════════════════
        (function() {
            'use strict';

            // ── State ─────────────────────────────────────────
            var _state = {
                period: 'all',
                from: '', to: '',
                style: 'all', assetType: 'all', strategy: 'all', symbol: '',
                editMode: false, layout: null
            };

            // ── Default layout ────────────────────────────────
            var DC_DEFAULT = [
                { id: 'dc1',  wid: 'disc-total-cost',      size: 'small'  },
                { id: 'dc2',  wid: 'disc-worst-behavior',   size: 'small'  },
                { id: 'dc3',  wid: 'disc-revenge-count',    size: 'small'  },
                { id: 'dc4',  wid: 'disc-tilt-count',       size: 'small'  },
                { id: 'dc5',  wid: 'disc-ranked-fixes',     size: 'large'  },
                { id: 'dc6',  wid: 'disc-revenge',          size: 'medium' },
                { id: 'dc7',  wid: 'disc-fomo',             size: 'medium' },
                { id: 'dc8',  wid: 'disc-premature',        size: 'medium' },
                { id: 'dc9',  wid: 'disc-tilt',             size: 'medium' },
                { id: 'dc10', wid: 'disc-overtrading',      size: 'large'  },
                { id: 'dc11', wid: 'disc-two-trader',       size: 'medium' },
                { id: 'dc12', wid: 'disc-forward',          size: 'medium' }
            ];

            // ── Widget catalog ────────────────────────────────
            var DC_LIB = [
                { wid: 'disc-total-cost',     name: 'Total Behavioral Cost',  desc: 'Summed dollar cost across all tracked behavioral patterns',  cat: 'KPI',        def: 'small'  },
                { wid: 'disc-worst-behavior',  name: 'Worst Behavior',         desc: 'The behavioral pattern with the highest dollar cost',         cat: 'KPI',        def: 'small'  },
                { wid: 'disc-revenge-count',   name: 'Revenge Trade Count',    desc: 'Total revenge trades and their cost',                         cat: 'KPI',        def: 'small'  },
                { wid: 'disc-tilt-count',      name: 'Tilt Escalation Count',  desc: 'Total tilt escalation trades and their cost',                 cat: 'KPI',        def: 'small'  },
                { wid: 'disc-ranked-fixes',    name: 'Action Plan',            desc: 'Ranked behavioral fixes by dollar impact',                    cat: 'Priority',   def: 'large'  },
                { wid: 'disc-revenge',         name: 'Revenge Trading',        desc: 'Full revenge trading breakdown with re-entry depth',          cat: 'Behavior',   def: 'medium' },
                { wid: 'disc-fomo',            name: 'FOMO / Chasing',         desc: 'Impulsive re-entries within 30 seconds',                      cat: 'Behavior',   def: 'medium' },
                { wid: 'disc-premature',       name: 'Premature Exits',        desc: 'Winning trades cut short under 2 minutes',                    cat: 'Behavior',   def: 'medium' },
                { wid: 'disc-tilt',            name: 'Tilt Escalation',        desc: 'Size escalation after losses',                                cat: 'Behavior',   def: 'medium' },
                { wid: 'disc-overtrading',     name: 'Overtrading',            desc: 'Performance by daily trade count bucket',                     cat: 'Behavior',   def: 'large'  },
                { wid: 'disc-two-trader',      name: 'Two-Trader Split',       desc: 'Disciplined vs tilt trader comparison',                       cat: 'Projection', def: 'medium' },
                { wid: 'disc-forward',         name: 'Forward Projections',    desc: 'Projected results at various execution rates',                cat: 'Projection', def: 'medium' },
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

            // ── Filter trades ─────────────────────────────────
            function getDiscTrades() {
                return DenariiFilters.filterTrades(getSelectedAccountTrades(journalData.trades), _state, journalData.brokerAccounts, new Date());
            }

            // ── Behavioral analysis (migrated from legacy) ────
            function analyzeDiscipline(trades) {
                var b = {
                    revenge: { count: 0, pnl: 0, first: { count: 0, pnl: 0 }, second: { count: 0, pnl: 0 }, thirdPlus: { count: 0, pnl: 0 } },
                    fomo: { count: 0, pnl: 0 },
                    overtrading: [],
                    premature: { count: 0, pnl: 0, avgHold: 0, avgPrematurePnl: 0 },
                    tilt: { days: 0, trades: 0, pnl: 0 },
                    // Two-trader split
                    disciplined: { trades: [], pnl: 0, winRate: 0 },
                    tiltTrader: { trades: [], pnl: 0, winRate: 0 },
                    totalPnl: 0
                };

                if (!trades.length) return b;

                b.totalPnl = trades.reduce(function(s, t) { return s + (t.pnl || 0); }, 0);

                // 1. Revenge Trading
                var dailyByTicker = {};
                trades.forEach(function(t) {
                    var ds = DenariiFilters.localDayKey(t.exitTime || t.entryTime);
                    if (!ds) return;
                    var key = ds + '_' + (t.symbol || '');
                    if (!dailyByTicker[key]) dailyByTicker[key] = [];
                    dailyByTicker[key].push(t);
                });

                Object.keys(dailyByTicker).forEach(function(key) {
                    var dayTrades = dailyByTicker[key];
                    dayTrades.sort(function(a, c) {
                        return new Date(a.exitTime || a.entryTime || 0) - new Date(c.exitTime || c.entryTime || 0);
                    });
                    var lossCount = 0;
                    dayTrades.forEach(function(t) {
                        if (lossCount > 0) {
                            b.revenge.count++;
                            b.revenge.pnl += (t.pnl || 0);
                            if (lossCount === 1) { b.revenge.first.count++; b.revenge.first.pnl += (t.pnl || 0); }
                            else if (lossCount === 2) { b.revenge.second.count++; b.revenge.second.pnl += (t.pnl || 0); }
                            else { b.revenge.thirdPlus.count++; b.revenge.thirdPlus.pnl += (t.pnl || 0); }
                        }
                        if ((t.pnl || 0) < 0) lossCount++;
                    });
                });

                // 2. FOMO / Chasing
                var sorted = trades.slice().sort(function(a, c) {
                    return new Date(a.entryTime || a.exitTime || 0) - new Date(c.entryTime || c.exitTime || 0);
                });
                for (var i = 1; i < sorted.length; i++) {
                    var prev = sorted[i - 1];
                    var curr = sorted[i];
                    if (prev.symbol === curr.symbol) {
                        var gap = (new Date(curr.entryTime || 0) - new Date(prev.exitTime || 0)) / 1000;
                        if (gap >= 0 && gap < 30) {
                            b.fomo.count++;
                            b.fomo.pnl += (curr.pnl || 0);
                        }
                    }
                }

                // 3. Overtrading
                var dailyTrades = {};
                trades.forEach(function(t) {
                    var ds = DenariiFilters.localDayKey(t.exitTime || t.entryTime);
                    if (!ds) return;
                    if (!dailyTrades[ds]) dailyTrades[ds] = [];
                    dailyTrades[ds].push(t);
                });

                var otBuckets = [
                    { name: '1–10 trades', min: 1, max: 10, days: [] },
                    { name: '11–20 trades', min: 11, max: 20, days: [] },
                    { name: '21–30 trades', min: 21, max: 30, days: [] },
                    { name: '31–50 trades', min: 31, max: 50, days: [] },
                    { name: '50+ trades', min: 50, max: Infinity, days: [] }
                ];
                Object.keys(dailyTrades).forEach(function(ds) {
                    var dayList = dailyTrades[ds];
                    var bucket = otBuckets.find(function(bk) { return dayList.length >= bk.min && dayList.length <= bk.max; });
                    if (bucket) bucket.days.push(dayList);
                });
                b.overtrading = otBuckets.map(function(bk) {
                    var all = [];
                    bk.days.forEach(function(dl) { dl.forEach(function(t) { all.push(t); }); });
                    var pnl = all.reduce(function(s, t) { return s + (t.pnl || 0); }, 0);
                    var wins = all.filter(function(t) { return (t.pnl || 0) > 0; }).length;
                    var wr = all.length > 0 ? (wins / all.length * 100) : 0;
                    return { name: bk.name, days: bk.days.length, trades: all.length, pnl: pnl, winRate: wr, avgPnl: all.length > 0 ? pnl / all.length : 0 };
                });

                // 4. Premature Exits
                var shortHolds = trades.filter(function(t) { return (t.holdSeconds || 0) < 120; });
                var winners = trades.filter(function(t) { return (t.pnl || 0) > 0; });
                var avgWinnerHold = winners.length > 0
                    ? winners.reduce(function(s, t) { return s + (t.holdSeconds || 0); }, 0) / winners.length
                    : 0;
                var prematureExits = shortHolds.filter(function(t) { return (t.pnl || 0) > 0; });
                var prematurePnl = prematureExits.reduce(function(s, t) { return s + (t.pnl || 0); }, 0);
                b.premature = {
                    count: prematureExits.length,
                    pnl: prematurePnl,
                    avgHold: avgWinnerHold,
                    avgPrematurePnl: prematureExits.length > 0 ? prematurePnl / prematureExits.length : 0
                };

                // 5. Tilt Escalation
                var tiltDays = 0, tiltTrades = 0, tiltPnl = 0;
                Object.keys(dailyTrades).forEach(function(ds) {
                    var dayList = dailyTrades[ds].slice().sort(function(a, c) {
                        return new Date(a.exitTime || a.entryTime || 0) - new Date(c.exitTime || c.entryTime || 0);
                    });
                    var first3 = dayList.slice(0, 3);
                    var avgFirst3Size = first3.length > 0
                        ? first3.reduce(function(s, t) { return s + (t.quantity || 0); }, 0) / first3.length
                        : 0;
                    var hitLoss = false;
                    var dayHasTilt = false;
                    dayList.forEach(function(t, idx) {
                        if (idx >= 3 && hitLoss && (t.quantity || 0) > avgFirst3Size * 1.5) {
                            tiltTrades++;
                            tiltPnl += (t.pnl || 0);
                            dayHasTilt = true;
                        }
                        if ((t.pnl || 0) < -50) hitLoss = true;
                    });
                    if (dayHasTilt) tiltDays++;
                });
                b.tilt = { days: tiltDays, trades: tiltTrades, pnl: tiltPnl };

                // 6. Two-Trader Split (legacy thresholds)
                var discTrades = trades.filter(function(t) { return (t.holdSeconds || 0) >= 300 && (t.quantity || 0) <= 10; });
                var tiltTr = trades.filter(function(t) { return (t.holdSeconds || 0) < 120 || (t.quantity || 0) > 15; });
                var discPnl = discTrades.reduce(function(s, t) { return s + (t.pnl || 0); }, 0);
                var tiltTrPnl = tiltTr.reduce(function(s, t) { return s + (t.pnl || 0); }, 0);
                var discWins = discTrades.filter(function(t) { return (t.pnl || 0) > 0; }).length;
                var tiltWins = tiltTr.filter(function(t) { return (t.pnl || 0) > 0; }).length;
                b.disciplined = {
                    trades: discTrades, pnl: discPnl,
                    winRate: discTrades.length > 0 ? (discWins / discTrades.length * 100) : 0
                };
                b.tiltTrader = {
                    trades: tiltTr, pnl: tiltTrPnl,
                    winRate: tiltTr.length > 0 ? (tiltWins / tiltTr.length * 100) : 0
                };

                return b;
            }

            // ── Stop modeling for Action Plan ─────────────────
            function computeOptimalStop(trades) {
                var dailyMap = {};
                trades.forEach(function(t) {
                    var ds = DenariiFilters.localDayKey(t.exitTime || t.entryTime);
                    if (!ds) return;
                    if (!dailyMap[ds]) dailyMap[ds] = 0;
                    dailyMap[ds] += (t.pnl || 0);
                });
                var daily = Object.keys(dailyMap).sort().map(function(ds) { return { date: ds, pnl: dailyMap[ds] }; });
                var losers = trades.filter(function(t) { return (t.pnl || 0) < 0; });
                var avgLossAbs = losers.length
                    ? Math.abs(losers.reduce(function(s, t) { return s + (t.pnl || 0); }, 0) / losers.length)
                    : 50;
                var stopLevels = [avgLossAbs, avgLossAbs * 2, avgLossAbs * 3, 300, 500, 750, 1000];
                var best = { level: 0, saved: 0, adjustedYTD: -Infinity };
                stopLevels.forEach(function(lv) {
                    var adj = 0, saved = 0;
                    daily.forEach(function(d) {
                        if (d.pnl < -lv) { adj += -lv; saved += (Math.abs(d.pnl) - lv); }
                        else { adj += d.pnl; }
                    });
                    if (adj > best.adjustedYTD) { best = { level: lv, saved: saved, adjustedYTD: adj }; }
                });
                return best;
            }

            // ── Widget shell ──────────────────────────────────
            function widgetHtml(id, title, bodyHtml, size) {
                var dragAttr = _state.editMode ? ' draggable="true"' : '';
                var handle   = _state.editMode
                    ? '<span class="snap-drag-handle" title="Drag to reorder">⠿</span>'
                    : '';
                var controls = _state.editMode
                    ? '<div class="snap-widget-controls">' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='small'?' snap-ctrl-sz-active':'')+'" onclick="discResizeWidget(\''+id+'\',\'small\')" title="Small">S</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='medium'?' snap-ctrl-sz-active':'')+'" onclick="discResizeWidget(\''+id+'\',\'medium\')" title="Medium">M</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='large'?' snap-ctrl-sz-active':'')+'" onclick="discResizeWidget(\''+id+'\',\'large\')" title="Large">L</button>' +
                          '<span class="snap-ctrl-sep"></span>' +
                          '<button class="snap-ctrl-btn snap-ctrl-remove" onclick="discRemoveWidget(\''+id+'\')" title="Remove widget">✕</button>' +
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

            // ── Impact helpers ─────────────────────────────────
            function buildImpacts(b) {
                return [
                    { name: 'Revenge Trading', cost: Math.abs(b.revenge.pnl) },
                    { name: 'FOMO / Chasing', cost: Math.abs(b.fomo.pnl) },
                    { name: 'Tilt Escalation', cost: Math.abs(b.tilt.pnl) },
                    { name: 'Premature Exits', cost: Math.abs(b.premature.pnl) }
                ].sort(function(a, c) { return c.cost - a.cost; });
            }

            // ── Renderers ─────────────────────────────────────
            var RENDERERS = {

                'disc-total-cost': function(id, trades, b, sz) {
                    var total = Math.abs(b.revenge.pnl) + Math.abs(b.fomo.pnl) + Math.abs(b.tilt.pnl) + Math.abs(b.premature.pnl);
                    return widgetHtml(id, 'Total Behavioral Cost', kpiHtml(
                        fmt$(total > 0 ? -total : 0),
                        'across all behavioral patterns',
                        total > 0 ? 'snap-kpi-negative' : 'snap-kpi-positive'), sz);
                },

                'disc-worst-behavior': function(id, trades, b, sz) {
                    var impacts = buildImpacts(b);
                    if (!impacts.length || impacts[0].cost === 0) return widgetHtml(id, 'Worst Behavior', kpiHtml('None', 'No behavioral issues detected', 'snap-kpi-positive'), sz);
                    return widgetHtml(id, 'Worst Behavior', kpiHtml(
                        impacts[0].name,
                        'Cost: ' + fmt$(-impacts[0].cost),
                        'snap-kpi-negative'), sz);
                },

                'disc-revenge-count': function(id, trades, b, sz) {
                    return widgetHtml(id, 'Revenge Trades', kpiHtml(
                        String(b.revenge.count),
                        b.revenge.count > 0 ? 'Cost: ' + fmt$(b.revenge.pnl) : 'No revenge trades detected',
                        b.revenge.count > 0 ? 'snap-kpi-negative' : 'snap-kpi-positive'), sz);
                },

                'disc-tilt-count': function(id, trades, b, sz) {
                    var sub = b.tilt.trades > 0
                        ? 'Cost: ' + fmt$(b.tilt.pnl) + ' across ' + b.tilt.days + ' day' + (b.tilt.days !== 1 ? 's' : '')
                        : 'No tilt escalation detected';
                    return widgetHtml(id, 'Tilt Escalation', kpiHtml(
                        String(b.tilt.trades),
                        sub,
                        b.tilt.trades > 0 ? 'snap-kpi-negative' : 'snap-kpi-positive'), sz);
                },

                'disc-ranked-fixes': function(id, trades, b, sz) {
                    var stop = computeOptimalStop(trades);
                    var actions = [
                        { rule: 'Stop revenge trading — no re-entry on same ticker after loss', impact: Math.abs(b.revenge.pnl), detail: b.revenge.count + ' revenge trades cost ' + fmt$(Math.abs(b.revenge.pnl)) },
                        { rule: 'Implement daily stop-loss at ' + fmt$(stop.level), impact: stop.saved, detail: 'Would save ' + fmt$(stop.saved) + ' on blow-up days' },
                        { rule: 'No trades under 2 minutes — let winners run', impact: Math.abs(b.premature.pnl), detail: b.premature.count + ' premature exits left ' + fmt$(Math.abs(b.premature.pnl)) + ' on table' },
                        { rule: 'Stop FOMO — wait 60+ seconds before re-entering same ticker', impact: Math.abs(b.fomo.pnl), detail: b.fomo.count + ' impulsive re-entries cost ' + fmt$(Math.abs(b.fomo.pnl)) }
                    ].sort(function(a, c) { return c.impact - a.impact; });

                    var html = actions.map(function(a, idx) {
                        var cls = idx === 0 ? 'disc-action-high' : idx === 1 ? 'disc-action-med' : 'disc-action-low';
                        return '<div class="disc-action-item ' + cls + '">' +
                            '<div class="disc-action-rank">' + (idx + 1) + '</div>' +
                            '<div class="disc-action-body">' +
                                '<div class="disc-action-rule">' + a.rule + '</div>' +
                                '<div class="disc-action-detail">' + a.detail + '</div>' +
                            '</div>' +
                            '<div class="disc-action-savings">Potential Savings: ' + fmt$(a.impact) + '</div>' +
                        '</div>';
                    }).join('');
                    return widgetHtml(id, 'Action Plan', html, sz);
                },

                'disc-revenge': function(id, trades, b, sz) {
                    if (!b.revenge.count) return widgetHtml(id, 'Revenge Trading', '<div class="snap-empty">No revenge trades detected.</div>', sz);
                    var html = '<div class="disc-detail-stat">' +
                        '<span class="disc-detail-big" style="color:var(--danger);">' + b.revenge.count + ' trades</span>' +
                        '<span class="disc-detail-cost">Cost: ' + fmt$(b.revenge.pnl) + '</span>' +
                    '</div>' +
                    '<div class="disc-detail-breakdown">' +
                        '<div>1st re-entry: ' + b.revenge.first.count + ' trades · ' + fmt$(b.revenge.first.pnl) + '</div>' +
                        '<div>2nd re-entry: ' + b.revenge.second.count + ' trades · ' + fmt$(b.revenge.second.pnl) + '</div>' +
                        '<div>3rd+ re-entry: ' + b.revenge.thirdPlus.count + ' trades · ' + fmt$(b.revenge.thirdPlus.pnl) + '</div>' +
                    '</div>';
                    return widgetHtml(id, 'Revenge Trading', html, sz);
                },

                'disc-fomo': function(id, trades, b, sz) {
                    if (!b.fomo.count) return widgetHtml(id, 'FOMO / Chasing', '<div class="snap-empty">No FOMO re-entries detected.</div>', sz);
                    var html = '<div class="disc-detail-stat">' +
                        '<span class="disc-detail-big" style="color:var(--danger);">' + b.fomo.count + ' trades</span>' +
                        '<span class="disc-detail-cost">Cost: ' + fmt$(b.fomo.pnl) + '</span>' +
                    '</div>' +
                    '<div class="disc-detail-hint">Re-entries within 30 seconds of prior exit on the same symbol.</div>';
                    return widgetHtml(id, 'FOMO / Chasing', html, sz);
                },

                'disc-premature': function(id, trades, b, sz) {
                    if (!b.premature.count) return widgetHtml(id, 'Premature Exits', '<div class="snap-empty">No premature exits detected.</div>', sz);
                    var avgHoldMin = b.premature.avgHold > 0 ? (b.premature.avgHold / 60).toFixed(1) : '—';
                    var html = '<div class="disc-detail-stat">' +
                        '<span class="disc-detail-big" style="color:var(--danger);">' + b.premature.count + ' winners cut short</span>' +
                        '<span class="disc-detail-cost">P&L Captured: ' + fmt$(b.premature.pnl) + '</span>' +
                    '</div>' +
                    '<div class="disc-detail-hint">Winning trades held under 2 minutes. Avg winner hold: ' + avgHoldMin + ' min.</div>';
                    return widgetHtml(id, 'Premature Exits', html, sz);
                },

                'disc-tilt': function(id, trades, b, sz) {
                    if (!b.tilt.trades) return widgetHtml(id, 'Tilt Escalation', '<div class="snap-empty">No tilt escalation detected.</div>', sz);
                    var html = '<div class="disc-detail-stat">' +
                        '<span class="disc-detail-big" style="color:var(--danger);">' + b.tilt.trades + ' trades on ' + b.tilt.days + ' day' + (b.tilt.days !== 1 ? 's' : '') + '</span>' +
                        '<span class="disc-detail-cost">Cost: ' + fmt$(b.tilt.pnl) + '</span>' +
                    '</div>' +
                    '<div class="disc-detail-hint">Sized up &gt;1.5x baseline after $50+ loss.</div>';
                    return widgetHtml(id, 'Tilt Escalation', html, sz);
                },

                'disc-overtrading': function(id, trades, b, sz) {
                    var rows = b.overtrading.filter(function(o) { return o.days > 0; });
                    if (!rows.length) return widgetHtml(id, 'Overtrading', '<div class="snap-empty">No trade data.</div>', sz);
                    var bestAvg = -Infinity;
                    rows.forEach(function(o) { if (o.avgPnl > bestAvg) bestAvg = o.avgPnl; });
                    var html = rows.map(function(o) {
                        var pnlColor = o.pnl >= 0 ? 'var(--success)' : 'var(--danger)';
                        var highlight = o.avgPnl === bestAvg && bestAvg > 0 ? ' style="background:rgba(34,197,94,0.08);"' : '';
                        return '<tr' + highlight + '>' +
                            '<td><strong>' + DenariiFilters.esc(o.name) + '</strong></td>' +
                            '<td>' + o.days + '</td>' +
                            '<td>' + o.trades + '</td>' +
                            '<td style="color:' + pnlColor + ';font-weight:600;">' + (o.pnl >= 0 ? '+' : '') + fmt$(o.pnl) + '</td>' +
                            '<td>' + fmtPct(o.winRate) + '</td>' +
                        '</tr>';
                    }).join('');
                    var body = '<div style="overflow-x:auto;"><table class="snap-trades-table">' +
                        '<thead><tr><th>Daily Count</th><th>Days</th><th>Trades</th><th>P&L</th><th>Win Rate</th></tr></thead>' +
                        '<tbody>' + html + '</tbody></table></div>';
                    return widgetHtml(id, 'Overtrading', body, sz);
                },

                'disc-two-trader': function(id, trades, b, sz) {
                    var dc = b.disciplined;
                    var tl = b.tiltTrader;
                    if (!dc.trades.length && !tl.trades.length) return widgetHtml(id, 'Two-Trader Split', '<div class="snap-empty">No data.</div>', sz);
                    var html = '<div class="disc-split-grid">' +
                        '<div class="disc-split-card disc-split-good">' +
                            '<div class="disc-split-label">Disciplined</div>' +
                            '<div class="disc-split-desc">5+ min hold · Size ≤10</div>' +
                            '<div class="disc-split-value" style="color:var(--success);">' + (dc.pnl >= 0 ? '+' : '') + fmt$(dc.pnl) + '</div>' +
                            '<div class="disc-split-meta">' + dc.trades.length + ' trades · ' + fmtPct(dc.winRate) + ' WR</div>' +
                        '</div>' +
                        '<div class="disc-split-card disc-split-bad">' +
                            '<div class="disc-split-label">Tilt</div>' +
                            '<div class="disc-split-desc">&lt;2 min hold OR size &gt;15</div>' +
                            '<div class="disc-split-value" style="color:' + (tl.pnl >= 0 ? 'var(--success)' : 'var(--danger)') + ';">' + (tl.pnl >= 0 ? '+' : '') + fmt$(tl.pnl) + '</div>' +
                            '<div class="disc-split-meta">' + tl.trades.length + ' trades · ' + fmtPct(tl.winRate) + ' WR</div>' +
                        '</div>' +
                    '</div>';
                    return widgetHtml(id, 'Two-Trader Split', html, sz);
                },

                'disc-forward': function(id, trades, b, sz) {
                    var dc = b.disciplined;
                    if (!dc.trades.length) return widgetHtml(id, 'Forward Projections', '<div class="snap-empty">No disciplined trades to project.</div>', sz);
                    var avgDailyDisc = dc.pnl / dc.trades.length * 20;
                    var now = new Date();
                    var daysLeft = 252 - (now.getMonth() * 21);
                    if (daysLeft < 1) daysLeft = 1;
                    var rates = [100, 75, 50, 33, 25];
                    var rows = rates.map(function(pct) {
                        var projected = avgDailyDisc * daysLeft * (pct / 100);
                        var net = b.totalPnl + projected;
                        var netColor = net >= 0 ? 'var(--success)' : 'var(--danger)';
                        return '<tr>' +
                            '<td><strong>' + pct + '%</strong></td>' +
                            '<td style="color:var(--success);font-weight:600;">+' + fmt$(projected) + '</td>' +
                            '<td style="color:' + netColor + ';font-weight:600;">' + (net >= 0 ? '+' : '') + fmt$(net) + '</td>' +
                        '</tr>';
                    }).join('');
                    var body = '<div style="overflow-x:auto;"><table class="snap-trades-table">' +
                        '<thead><tr><th>Execution Rate</th><th>Projected P&L</th><th>Net After Current</th></tr></thead>' +
                        '<tbody>' + rows + '</tbody></table></div>';
                    return widgetHtml(id, 'Forward Projections', body, sz);
                }
            };

            // ── Drag-and-drop ─────────────────────────────────
            var _drag = { srcId: null, overId: null };

            function setupDiscDrag() {
                var grid = document.getElementById('disc-grid');
                if (!grid || grid._discDragBound) return;
                grid._discDragBound = true;

                grid.addEventListener('dragstart', function(e) {
                    if (!_state.editMode) { e.preventDefault(); return; }
                    if (e.target.tagName === 'BUTTON') { e.preventDefault(); return; }
                    var widget = e.target.closest('[data-instance-id]');
                    if (!widget) return;
                    _drag.srcId = widget.dataset.instanceId;
                    _drag.overId = null;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', _drag.srcId);
                    setTimeout(function() { widget.classList.add('snap-dragging'); }, 0);
                });

                grid.addEventListener('dragend', function() {
                    _drag.srcId = null;
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
                    grid.querySelectorAll('.snap-drag-over').forEach(function(el) { el.classList.remove('snap-drag-over'); });
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
                    _drag.srcId = null;
                    _drag.overId = null;
                    saveLayout();
                    renderDisc();
                });
            }

            // ── Main render ───────────────────────────────────
            function renderDisc() {
                Object.assign(_state, DenariiFilters.readState('disc'));

                var trades = getDiscTrades();
                var b      = analyzeDiscipline(trades);
                var layout = _state.layout || DC_DEFAULT.map(function(w) { return Object.assign({}, w); });

                var grid = document.getElementById('disc-grid');
                if (!grid) return;
                grid.className = 'snap-grid' + (_state.editMode ? ' snap-edit-mode' : '');
                grid.innerHTML = layout.map(function(item) {
                    return RENDERERS[item.wid] ? RENDERERS[item.wid](item.id, trades, b, item.size || 'small') : '';
                }).join('');
            }

            // ── Populate filter dropdowns ─────────────────────
            function populateDiscFilters() {
                var stlSel   = document.getElementById('disc-style');
                var perSel   = document.getElementById('disc-period');
                var astSel   = document.getElementById('disc-asset-type');
                var stratSel = document.getElementById('disc-strategy');
                var symEl    = document.getElementById('disc-symbol');
                var fromEl   = document.getElementById('disc-from');
                var toEl     = document.getElementById('disc-to');
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
                journalData.disciplineLayout = JSON.parse(JSON.stringify(_state.layout));
                if (typeof saveToIndexedDB === 'function') saveToIndexedDB();
            }

            // ── Init ──────────────────────────────────────────
            function initDisc() {
                _state.layout = journalData.disciplineLayout
                    ? JSON.parse(JSON.stringify(journalData.disciplineLayout))
                    : DC_DEFAULT.map(function(w) { return Object.assign({}, w); });
                populateDiscFilters();
                renderDisc();
                setupDiscDrag();
            }

            // ═══ Window-exposed API ═══════════════════════════

            window.renderDisc = renderDisc;

            window.toggleDiscEdit = function() {
                _state.editMode = !_state.editMode;
                var banner = document.getElementById('disc-edit-banner');
                var btn    = document.getElementById('disc-edit-btn');
                if (banner) banner.style.display = _state.editMode ? 'flex' : 'none';
                if (btn)    btn.textContent = _state.editMode ? '✓ Done Editing' : 'Edit Layout';
                renderDisc();
            };

            window.discResizeWidget = function(id, newSize) {
                var item = (_state.layout || []).find(function(w) { return w.id === id; });
                if (item) { item.size = newSize; saveLayout(); renderDisc(); }
            };

            window.discRemoveWidget = function(id) {
                if (!_state.layout) return;
                _state.layout = _state.layout.filter(function(w) { return w.id !== id; });
                saveLayout(); renderDisc();
            };

            window.discResetLayout = function() {
                if (!confirm('Reset Discipline widget layout to default?')) return;
                _state.layout = DC_DEFAULT.map(function(w) { return Object.assign({}, w); });
                saveLayout(); renderDisc();
            };

            window.openDiscPicker = function() {
                discRenderPicker();
                var o = document.getElementById('disc-picker-overlay');
                var p = document.getElementById('disc-picker-panel');
                if (o) o.classList.add('open');
                if (p) p.classList.add('open');
            };

            window.closeDiscPicker = function() {
                var o = document.getElementById('disc-picker-overlay');
                var p = document.getElementById('disc-picker-panel');
                if (o) o.classList.remove('open');
                if (p) p.classList.remove('open');
            };

            function discRenderPicker() {
                var q    = (document.getElementById('disc-picker-q') || {}).value || '';
                var body = document.getElementById('disc-picker-body');
                if (!body) return;
                var activeWids = {};
                (_state.layout || []).forEach(function(item) { activeWids[item.wid] = true; });
                var filtered = DC_LIB.filter(function(w) {
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
                                    : '<button class="snap-picker-item-add" onclick="discAddWidget(\'' + w.wid + '\')">+ Add</button>') +
                            '</div>';
                        }).join('');
                }).join('');
            }
            window.discRenderPicker = discRenderPicker;

            window.discAddWidget = function(wid) {
                if (!_state.layout) _state.layout = [];
                var already = _state.layout.some(function(w) { return w.wid === wid; });
                if (already) return;
                var def = DC_LIB.find(function(w) { return w.wid === wid; });
                _state.layout.push({ id: 'dc' + Date.now(), wid: wid, size: def ? def.def : 'small' });
                saveLayout();
                window.closeDiscPicker();
                renderDisc();
            };

            window._disciplineInit = initDisc;

            // Mounted once at load. Fill Style here too: the app's first
            // _populateStyleSelects() may already have run.
            DenariiFilters.mountFilterBar(document.getElementById('disc-filter-bar'), {
                prefix: 'disc',
                onChange: renderDisc
            });
            if (typeof _populateStyleSelect === 'function') _populateStyleSelect('disc-style', true);

        })();
