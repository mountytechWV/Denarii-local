        // ═══════════════════════════════════════════════════════
        // SYMBOLS PAGE — Phase 1
        // Which tickers deserve attention, and which are draining me?
        //
        // Depends on globals: journalData, escapeHtml,
        // openStockChart (if available), saveToIndexedDB.
        // Plotly must be loaded before this file.
        // ═══════════════════════════════════════════════════════
        (function() {
            'use strict';

            // ── Constants ─────────────────────────────────────
            var MIN_TRADES_FOR_CLASSIFICATION = 5;

            // ── State ─────────────────────────────────────────
            var _state = {
                period: 'all',
                from: '', to: '',
                style: 'all', assetType: 'all', strategy: 'all', symbol: '',
                editMode: false, layout: null
            };

            // ── Default layout ────────────────────────────────
            var SYM_DEFAULT = [
                { id: 'sy10', wid: 'sym-concentration-insight',  size: 'large'  },
                { id: 'sy1',  wid: 'sym-total-symbols',          size: 'small'  },
                { id: 'sy2',  wid: 'sym-best-symbol',            size: 'small'  },
                { id: 'sy3',  wid: 'sym-worst-symbol',           size: 'small'  },
                { id: 'sy4',  wid: 'sym-edge-count',             size: 'small'  },
                { id: 'sy5',  wid: 'sym-performance-table',      size: 'large'  },
                { id: 'sy6',  wid: 'sym-top-winners',            size: 'medium' },
                { id: 'sy7',  wid: 'sym-top-losers',             size: 'medium' },
                { id: 'sy8',  wid: 'sym-focus-concentration',    size: 'medium' },
                { id: 'sy9',  wid: 'sym-high-freq-low-quality',  size: 'medium' }
            ];

            // ── Widget catalog ────────────────────────────────
            var SYM_LIB = [
                { wid: 'sym-total-symbols',        name: 'Total Symbols Traded',      desc: 'Count of unique symbols in the filtered period',             cat: 'Summary',       def: 'small'  },
                { wid: 'sym-best-symbol',           name: 'Best Symbol',               desc: 'Symbol with highest net P&L',                                cat: 'Summary',       def: 'small'  },
                { wid: 'sym-worst-symbol',          name: 'Worst Symbol',              desc: 'Symbol with lowest net P&L',                                 cat: 'Summary',       def: 'small'  },
                { wid: 'sym-edge-count',            name: 'Classification Summary',    desc: 'Symbols by classification: EDGE, NEUTRAL, LEAK, HEMORRHAGE', cat: 'Summary',       def: 'small'  },
                { wid: 'sym-performance-table',     name: 'Symbol Performance Table',  desc: 'Full table with P&L, win rate, avg $/trade, classification', cat: 'Rankings',      def: 'large'  },
                { wid: 'sym-top-winners',           name: 'Top Winners by Symbol',     desc: 'Top symbols by net P&L as horizontal bar chart',             cat: 'Rankings',      def: 'medium' },
                { wid: 'sym-top-losers',            name: 'Top Losers by Symbol',      desc: 'Worst symbols by net P&L as horizontal bar chart',           cat: 'Rankings',      def: 'medium' },
                { wid: 'sym-focus-concentration',   name: 'Focus Concentration',       desc: 'How concentrated your trading is across symbols',            cat: 'Concentration', def: 'medium' },
                { wid: 'sym-concentration-insight', name: 'Concentration Insight',     desc: 'Plain-language interpretation of where your losses concentrate by symbol', cat: 'Insight', def: 'medium' },
                { wid: 'sym-high-freq-low-quality', name: 'High-Trade / Low-Quality',  desc: 'Symbols traded often but with weak or negative results',     cat: 'Quality',       def: 'medium' },
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
            function getSymTrades() {
                return DenariiFilters.filterTrades(getSelectedAccountTrades(journalData.trades), _state, journalData.brokerAccounts, new Date());
            }

            // ── Symbol analysis ───────────────────────────────
            function analyzeSymbols(trades) {
                var map = {};
                trades.forEach(function(t) {
                    var sym = t.symbol || 'UNKNOWN';
                    if (!map[sym]) map[sym] = { symbol: sym, trades: [], pnl: 0 };
                    map[sym].trades.push(t);
                    map[sym].pnl += (t.pnl || 0);
                });

                return Object.keys(map).map(function(sym) {
                    var entry = map[sym];
                    var winners = entry.trades.filter(function(t) { return (t.pnl || 0) > 0; }).length;
                    var winRate = entry.trades.length > 0 ? (winners / entry.trades.length * 100) : 0;
                    var dollarPerTrade = entry.trades.length > 0 ? entry.pnl / entry.trades.length : 0;

                    var label = 'Insufficient Sample';
                    if (entry.trades.length >= MIN_TRADES_FOR_CLASSIFICATION) {
                        if (entry.pnl > 0 && winRate >= 55) {
                            label = 'EDGE';
                        } else if (entry.pnl > 0 || (entry.pnl >= -50 && entry.pnl <= 0)) {
                            label = 'NEUTRAL';
                        } else if (entry.pnl < 0 && entry.pnl >= -200) {
                            label = 'LEAK';
                        } else {
                            label = 'HEMORRHAGE';
                        }
                    }

                    return {
                        symbol: entry.symbol,
                        count: entry.trades.length,
                        pnl: entry.pnl,
                        winRate: winRate,
                        dollarPerTrade: dollarPerTrade,
                        label: label
                    };
                }).sort(function(a, b) { return b.pnl - a.pnl; });
            }

            // ── Widget shell ──────────────────────────────────
            function widgetHtml(id, title, bodyHtml, size) {
                var dragAttr = _state.editMode ? ' draggable="true"' : '';
                var handle   = _state.editMode
                    ? '<span class="snap-drag-handle" title="Drag to reorder">⠿</span>'
                    : '';
                var controls = _state.editMode
                    ? '<div class="snap-widget-controls">' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='small'?' snap-ctrl-sz-active':'')+'" onclick="symResizeWidget(\''+id+'\',\'small\')" title="Small">S</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='medium'?' snap-ctrl-sz-active':'')+'" onclick="symResizeWidget(\''+id+'\',\'medium\')" title="Medium">M</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='large'?' snap-ctrl-sz-active':'')+'" onclick="symResizeWidget(\''+id+'\',\'large\')" title="Large">L</button>' +
                          '<span class="snap-ctrl-sep"></span>' +
                          '<button class="snap-ctrl-btn snap-ctrl-remove" onclick="symRemoveWidget(\''+id+'\')" title="Remove widget">✕</button>' +
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

            // ── Classification badge ──────────────────────────
            function classificationBadge(label) {
                var cls = 'sym-badge-neutral';
                if (label === 'EDGE') cls = 'sym-badge-edge';
                else if (label === 'LEAK') cls = 'sym-badge-leak';
                else if (label === 'HEMORRHAGE') cls = 'sym-badge-hemorrhage';
                else if (label === 'Insufficient Sample') cls = 'sym-badge-insufficient';
                return '<span class="sym-badge ' + cls + '">' + label + '</span>';
            }

            // ── Renderers ─────────────────────────────────────
            var RENDERERS = {

                'sym-total-symbols': function(id, trades, symbols, sz) {
                    return widgetHtml(id, 'Total Symbols Traded', kpiHtml(
                        String(symbols.length),
                        'across ' + trades.length + ' trade' + (trades.length !== 1 ? 's' : ''),
                        'snap-kpi-neutral'), sz);
                },

                'sym-best-symbol': function(id, trades, symbols, sz) {
                    if (!symbols.length) return widgetHtml(id, 'Best Symbol', '<div class="snap-empty">No data.</div>', sz);
                    var best = symbols[0]; // already sorted desc by pnl
                    return widgetHtml(id, 'Best Symbol', kpiHtml(
                        best.symbol,
                        (best.pnl >= 0 ? '+' : '') + fmt$(best.pnl) + ' · ' + best.count + ' trade' + (best.count !== 1 ? 's' : ''),
                        pnlColorClass(best.pnl)), sz);
                },

                'sym-worst-symbol': function(id, trades, symbols, sz) {
                    if (!symbols.length) return widgetHtml(id, 'Worst Symbol', '<div class="snap-empty">No data.</div>', sz);
                    var worst = symbols[symbols.length - 1];
                    return widgetHtml(id, 'Worst Symbol', kpiHtml(
                        worst.symbol,
                        (worst.pnl >= 0 ? '+' : '') + fmt$(worst.pnl) + ' · ' + worst.count + ' trade' + (worst.count !== 1 ? 's' : ''),
                        pnlColorClass(worst.pnl)), sz);
                },

                'sym-edge-count': function(id, trades, symbols, sz) {
                    var counts = { EDGE: 0, NEUTRAL: 0, LEAK: 0, HEMORRHAGE: 0, 'Insufficient Sample': 0 };
                    symbols.forEach(function(s) { if (counts.hasOwnProperty(s.label)) counts[s.label]++; });
                    function tile(cls, label, n) {
                        return '<div class="sym-class-tile sym-class-tile--' + cls + '">' +
                            '<div class="sym-class-tile-count">' + n + '</div>' +
                            '<div class="sym-class-tile-label">' + label + '</div>' +
                        '</div>';
                    }
                    var body = '<div class="sym-class-grid">' +
                        tile('edge', 'Edge', counts.EDGE) +
                        tile('neutral', 'Neutral', counts.NEUTRAL) +
                        tile('leak', 'Leak', counts.LEAK) +
                        tile('hemorrhage', 'Hemorrhage', counts.HEMORRHAGE) +
                        tile('insufficient', 'Insufficient', counts['Insufficient Sample']) +
                    '</div>';
                    return widgetHtml(id, 'Classification Summary', body, sz);
                },

                'sym-performance-table': function(id, trades, symbols, sz) {
                    if (!symbols.length) return widgetHtml(id, 'Symbol Performance Table', '<div class="snap-empty">No trade data.</div>', sz);
                    var hasChart = typeof openStockChart === 'function';
                    var rows = symbols.map(function(s) {
                        var symCell = hasChart
                            ? '<strong class="sym-clickable" onclick="openStockChart(\'' + s.symbol + '\')" title="View ' + s.symbol + ' chart">' + s.symbol + '</strong>'
                            : '<strong>' + s.symbol + '</strong>';
                        var pnlColor = s.pnl >= 0 ? 'var(--success)' : 'var(--danger)';
                        var dptColor = s.dollarPerTrade >= 0 ? 'var(--success)' : 'var(--danger)';
                        return '<tr>' +
                            '<td>' + symCell + '</td>' +
                            '<td>' + s.count + '</td>' +
                            '<td style="color:' + pnlColor + ';font-weight:600;">' + (s.pnl >= 0 ? '+' : '') + fmt$(s.pnl) + '</td>' +
                            '<td>' + fmtPct(s.winRate) + '</td>' +
                            '<td style="color:' + dptColor + ';font-weight:600;">' + (s.dollarPerTrade >= 0 ? '+' : '') + fmt$(s.dollarPerTrade) + '</td>' +
                            '<td>' + classificationBadge(s.label) + '</td>' +
                        '</tr>';
                    }).join('');
                    var body = '<div style="overflow-x:auto;"><table class="snap-trades-table sym-perf-table">' +
                        '<thead><tr><th>Symbol</th><th>Trades</th><th>Net P&L</th><th>Win Rate</th><th>Avg $/Trade</th><th>Classification</th></tr></thead>' +
                        '<tbody>' + rows + '</tbody></table></div>';
                    return widgetHtml(id, 'Symbol Performance Table', body, sz);
                },

                'sym-top-winners': function(id, trades, symbols, sz) {
                    var winners = symbols.filter(function(s) { return s.pnl > 0; }).slice(0, 10);
                    if (!winners.length) return widgetHtml(id, 'Top Winners by Symbol', '<div class="snap-empty">No winning symbols.</div>', sz);
                    return widgetHtml(id, 'Top Winners by Symbol',
                        '<div id="sym-chart-' + id + '" class="snap-chart-wrap" style="height:220px;"></div>', sz);
                },

                'sym-top-losers': function(id, trades, symbols, sz) {
                    var losers = symbols.filter(function(s) { return s.pnl < 0; });
                    losers = losers.slice(Math.max(losers.length - 10, 0)).reverse();
                    if (!losers.length) return widgetHtml(id, 'Top Losers by Symbol', '<div class="snap-empty">No losing symbols.</div>', sz);
                    return widgetHtml(id, 'Top Losers by Symbol',
                        '<div id="sym-chart-' + id + '" class="snap-chart-wrap" style="height:220px;"></div>', sz);
                },

                'sym-focus-concentration': function(id, trades, symbols, sz) {
                    if (!symbols.length) return widgetHtml(id, 'Focus Concentration', '<div class="snap-empty">No data.</div>', sz);
                    return widgetHtml(id, 'Focus Concentration',
                        '<div id="sym-chart-' + id + '" class="snap-chart-wrap" style="height:260px;"></div>', sz);
                },

                'sym-concentration-insight': function(id, trades, symbols, sz) {
                    var losers = symbols.filter(function(s) { return s.pnl < 0; });
                    if (losers.length < 2) return widgetHtml(id, 'Concentration Insight',
                        '<div class="snap-empty">No meaningful loss concentration detected in the current view.</div>', sz);

                    var totalLoss = losers.reduce(function(s, sym) { return s + Math.abs(sym.pnl); }, 0);
                    if (totalLoss === 0) return widgetHtml(id, 'Concentration Insight',
                        '<div class="snap-empty">No meaningful loss concentration detected in the current view.</div>', sz);

                    // Sort losers by absolute loss desc
                    var sortedLosers = losers.slice().sort(function(a, b) { return Math.abs(b.pnl) - Math.abs(a.pnl); });
                    var topN = Math.min(3, sortedLosers.length);
                    var topLoss = 0;
                    var topNames = [];
                    for (var j = 0; j < topN; j++) {
                        topLoss += Math.abs(sortedLosers[j].pnl);
                        topNames.push(sortedLosers[j].symbol);
                    }
                    var topPct = (topLoss / totalLoss * 100);

                    var text = '';
                    if (topPct >= 60) {
                        text = 'You traded ' + symbols.length + ' symbols, but ' + topN + ' account for ' + fmtPct(topPct) +
                               ' of your losses: ' + topNames.join(', ') + '. Reviewing those names first will have more impact than trimming everything.';
                    } else if (topPct >= 40) {
                        text = 'Your worst ' + topN + ' symbols (' + topNames.join(', ') + ') represent ' + fmtPct(topPct) +
                               ' of losses. Some concentration exists, but losses are partially spread across other names too.';
                    } else {
                        text = 'Losses are spread across many symbols \u2014 no small group dominates. This suggests a broader approach issue rather than one or two bad names.';
                    }

                    var body = '<div class="sym-insight-text">' + text + '</div>';
                    return widgetHtml(id, 'Concentration Insight', body, sz);
                },

                'sym-high-freq-low-quality': function(id, trades, symbols, sz) {
                    // Symbols with >= 5 trades and negative or near-zero P&L
                    var flagged = symbols.filter(function(s) {
                        return s.count >= MIN_TRADES_FOR_CLASSIFICATION && s.dollarPerTrade < 1;
                    }).sort(function(a, b) { return a.dollarPerTrade - b.dollarPerTrade; });
                    if (!flagged.length) return widgetHtml(id, 'High-Trade / Low-Quality', '<div class="snap-empty">No high-frequency low-quality symbols found.</div>', sz);
                    var rows = flagged.map(function(s) {
                        return '<tr>' +
                            '<td><strong>' + s.symbol + '</strong></td>' +
                            '<td>' + s.count + '</td>' +
                            '<td style="color:var(--danger);font-weight:600;">' + (s.pnl >= 0 ? '+' : '') + fmt$(s.pnl) + '</td>' +
                            '<td>' + fmtPct(s.winRate) + '</td>' +
                            '<td style="color:var(--danger);font-weight:600;">' + (s.dollarPerTrade >= 0 ? '+' : '') + fmt$(s.dollarPerTrade) + '</td>' +
                        '</tr>';
                    }).join('');
                    var body = '<div style="overflow-x:auto;"><table class="snap-trades-table">' +
                        '<thead><tr><th>Symbol</th><th>Trades</th><th>Net P&L</th><th>Win Rate</th><th>Avg $/Trade</th></tr></thead>' +
                        '<tbody>' + rows + '</tbody></table></div>';
                    return widgetHtml(id, 'High-Trade / Low-Quality', body, sz);
                }
            };

            // ── Chart rendering ───────────────────────────────
            function symRenderCharts(symbols, layout) {
                var bg   = 'transparent';
                var gc   = 'rgba(255,255,255,0.07)';
                var tc   = '#8b9aae';
                var ax   = { gridcolor: gc, tickfont: { size: 11, color: tc }, linecolor: gc, zeroline: false };
                var base = { paper_bgcolor: bg, plot_bgcolor: bg,
                             margin: { t: 10, r: 10, b: 36, l: 80 },
                             font: { family: 'Inter,sans-serif', color: tc }, showlegend: false };

                layout.forEach(function(item) {
                    var el = document.getElementById('sym-chart-' + item.id);
                    if (!el) return;

                    if (item.wid === 'sym-top-winners') {
                        var winners = symbols.filter(function(s) { return s.pnl > 0; }).slice(0, 10);
                        if (!winners.length) return;
                        var wNames = winners.map(function(s) { return s.symbol; }).reverse();
                        var wVals  = winners.map(function(s) { return s.pnl; }).reverse();
                        try { Plotly.react(el, [{
                            x: wVals, y: wNames, type: 'bar', orientation: 'h',
                            marker: { color: 'rgba(34,197,94,0.75)' },
                            hovertemplate: '%{y}: +$%{x:.2f}<extra></extra>'
                        }], Object.assign({}, base, {
                            xaxis: Object.assign({}, ax, { tickprefix: '$' }),
                            yaxis: Object.assign({}, ax, { automargin: true })
                        }), { responsive: true, displayModeBar: false }); } catch(e) {}
                    }

                    if (item.wid === 'sym-top-losers') {
                        var losers = symbols.filter(function(s) { return s.pnl < 0; });
                        losers = losers.slice(Math.max(losers.length - 10, 0)).reverse();
                        if (!losers.length) return;
                        var lNames = losers.map(function(s) { return s.symbol; });
                        var lVals  = losers.map(function(s) { return s.pnl; });
                        try { Plotly.react(el, [{
                            x: lVals, y: lNames, type: 'bar', orientation: 'h',
                            marker: { color: 'rgba(239,68,68,0.75)' },
                            hovertemplate: '%{y}: $%{x:.2f}<extra></extra>'
                        }], Object.assign({}, base, {
                            xaxis: Object.assign({}, ax, { tickprefix: '$' }),
                            yaxis: Object.assign({}, ax, { automargin: true })
                        }), { responsive: true, displayModeBar: false }); } catch(e) {}
                    }

                    if (item.wid === 'sym-focus-concentration') {
                        if (!symbols.length) return;
                        // Show top 8 symbols by trade count, rest as "Other"
                        var sorted = symbols.slice().sort(function(a, b) { return b.count - a.count; });
                        var topN = sorted.slice(0, 8);
                        var rest = sorted.slice(8);
                        var labels = topN.map(function(s) { return s.symbol; });
                        var values = topN.map(function(s) { return s.count; });
                        if (rest.length) {
                            labels.push('Other (' + rest.length + ')');
                            values.push(rest.reduce(function(sum, s) { return sum + s.count; }, 0));
                        }
                        var colors = [
                            'rgba(34,197,94,0.75)', 'rgba(59,130,246,0.75)', 'rgba(168,85,247,0.75)',
                            'rgba(245,158,11,0.75)', 'rgba(236,72,153,0.75)', 'rgba(20,184,166,0.75)',
                            'rgba(99,102,241,0.75)', 'rgba(249,115,22,0.75)', 'rgba(107,114,128,0.5)'
                        ];
                        try { Plotly.react(el, [{
                            labels: labels, values: values, type: 'pie',
                            hole: 0.45,
                            marker: { colors: colors },
                            textinfo: 'label+percent',
                            textfont: { size: 11, color: '#fff' },
                            hovertemplate: '%{label}: %{value} trades (%{percent})<extra></extra>'
                        }], Object.assign({}, base, {
                            margin: { t: 10, r: 10, b: 10, l: 10 }
                        }), { responsive: true, displayModeBar: false }); } catch(e) {}
                    }
                });
            }

            // ── Drag-and-drop ─────────────────────────────────
            var _drag = { srcId: null, overId: null };

            function setupSymDrag() {
                var grid = document.getElementById('sym-grid');
                if (!grid || grid._symDragBound) return;
                grid._symDragBound = true;

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
                    renderSymbols();
                });
            }

            // ── Main render ───────────────────────────────────
            function renderSymbols() {
                Object.assign(_state, DenariiFilters.readState('sym'));

                var trades  = getSymTrades();
                var symbols = analyzeSymbols(trades);
                var layout  = _state.layout || SYM_DEFAULT.map(function(w) { return Object.assign({}, w); });

                var grid = document.getElementById('sym-grid');
                if (!grid) return;
                grid.className = 'snap-grid' + (_state.editMode ? ' snap-edit-mode' : '');
                grid.innerHTML = layout.map(function(item) {
                    return RENDERERS[item.wid] ? RENDERERS[item.wid](item.id, trades, symbols, item.size || 'small') : '';
                }).join('');

                setTimeout(function() { symRenderCharts(symbols, layout); }, 60);
            }

            // ── Populate filter dropdowns ─────────────────────
            function populateSymFilters() {
                var stlSel   = document.getElementById('sym-style');
                var perSel   = document.getElementById('sym-period');
                var astSel   = document.getElementById('sym-asset-type');
                var stratSel = document.getElementById('sym-strategy');
                var symEl    = document.getElementById('sym-symbol');
                var fromEl   = document.getElementById('sym-from');
                var toEl     = document.getElementById('sym-to');
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
                journalData.symbolsLayout = JSON.parse(JSON.stringify(_state.layout));
                if (typeof saveToIndexedDB === 'function') saveToIndexedDB();
            }

            // ── Init ──────────────────────────────────────────
            function initSymbols() {
                _state.layout = journalData.symbolsLayout
                    ? JSON.parse(JSON.stringify(journalData.symbolsLayout))
                    : SYM_DEFAULT.map(function(w) { return Object.assign({}, w); });
                populateSymFilters();
                renderSymbols();
                setupSymDrag();
            }

            // ═══ Window-exposed API ═══════════════════════════

            window.renderSymbols = renderSymbols;

            window.toggleSymEdit = function() {
                _state.editMode = !_state.editMode;
                var banner = document.getElementById('sym-edit-banner');
                var btn    = document.getElementById('sym-edit-btn');
                if (banner) banner.style.display = _state.editMode ? 'flex' : 'none';
                if (btn)    btn.textContent = _state.editMode ? '✓ Done Editing' : 'Edit Layout';
                renderSymbols();
            };

            window.symResizeWidget = function(id, newSize) {
                var item = (_state.layout || []).find(function(w) { return w.id === id; });
                if (item) { item.size = newSize; saveLayout(); renderSymbols(); }
            };

            window.symRemoveWidget = function(id) {
                if (!_state.layout) return;
                _state.layout = _state.layout.filter(function(w) { return w.id !== id; });
                saveLayout(); renderSymbols();
            };

            window.symResetLayout = function() {
                if (!confirm('Reset Symbols widget layout to default?')) return;
                _state.layout = SYM_DEFAULT.map(function(w) { return Object.assign({}, w); });
                saveLayout(); renderSymbols();
            };

            window.openSymPicker = function() {
                symRenderPicker();
                var o = document.getElementById('sym-picker-overlay');
                var p = document.getElementById('sym-picker-panel');
                if (o) o.classList.add('open');
                if (p) p.classList.add('open');
            };

            window.closeSymPicker = function() {
                var o = document.getElementById('sym-picker-overlay');
                var p = document.getElementById('sym-picker-panel');
                if (o) o.classList.remove('open');
                if (p) p.classList.remove('open');
            };

            function symRenderPicker() {
                var q    = (document.getElementById('sym-picker-q') || {}).value || '';
                var body = document.getElementById('sym-picker-body');
                if (!body) return;
                var activeWids = {};
                (_state.layout || []).forEach(function(item) { activeWids[item.wid] = true; });
                var filtered = SYM_LIB.filter(function(w) {
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
                                    : '<button class="snap-picker-item-add" onclick="symAddWidget(\'' + w.wid + '\')">+ Add</button>') +
                            '</div>';
                        }).join('');
                }).join('');
            }
            window.symRenderPicker = symRenderPicker;

            window.symAddWidget = function(wid) {
                if (!_state.layout) _state.layout = [];
                var already = _state.layout.some(function(w) { return w.wid === wid; });
                if (already) return;
                var def = SYM_LIB.find(function(w) { return w.wid === wid; });
                _state.layout.push({ id: 'sy' + Date.now(), wid: wid, size: def ? def.def : 'small' });
                saveLayout();
                window.closeSymPicker();
                renderSymbols();
            };

            window._symbolsInit = initSymbols;

            // Mounted once at load. Fill Style here too: the app's first
            // _populateStyleSelects() may already have run.
            DenariiFilters.mountFilterBar(document.getElementById('sym-filter-bar'), {
                prefix: 'sym',
                onChange: renderSymbols
            });
            if (typeof _populateStyleSelect === 'function') _populateStyleSelect('sym-style', true);

        })();
