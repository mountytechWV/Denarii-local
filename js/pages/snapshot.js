        // ═══════════════════════════════════════════════════════
        // SNAPSHOT PAGE
        // ═══════════════════════════════════════════════════════
        (function() {
            'use strict';

            // ── State ──────────────────────────────────────────
            var _state = {
                period: 'all',
                from: '', to: '',
                style: 'all', assetType: 'all', strategy: 'all', symbol: '',
                editMode: false, layout: null
            };

            // ── Default layout ─────────────────────────────────
            var SNAP_DEFAULT = [
                { id: 'si15', wid: 'si-snapshot-direction-banner', size: 'large' },
                { id: 'si1',  wid: 'total-pnl',      size: 'small'  },
                { id: 'si2',  wid: 'win-rate',        size: 'small'  },
                { id: 'si3',  wid: 'trade-count',     size: 'small'  },
                { id: 'si4',  wid: 'expectancy',      size: 'small'  },
                { id: 'si5',  wid: 'profit-factor',   size: 'small'  },
                { id: 'si6',  wid: 'avg-win',         size: 'small'  },
                { id: 'si7',  wid: 'avg-loss',        size: 'small'  },
                { id: 'si8',  wid: 'largest-win',     size: 'small'  },
                { id: 'si9',  wid: 'largest-loss',    size: 'small'  },
                { id: 'si10', wid: 'avg-trade-pnl',   size: 'small'  },
                { id: 'si11', wid: 'equity-curve',    size: 'large'  },
                { id: 'si12', wid: 'daily-pnl-bars',  size: 'medium' },
                { id: 'si13', wid: 'top-setups',      size: 'medium' },
                { id: 'si14', wid: 'recent-trades',   size: 'large'  }
            ];

            // ── Widget catalog ──────────────────────────────────
            var SNAP_LIB = [
                { wid: 'si-snapshot-direction-banner', name: 'Snapshot Direction', desc: 'One-line directional finding from the current view', cat: 'Insight', def: 'large' },
                { wid: 'total-pnl',        name: 'Total P&L',       desc: 'Net profit/loss for the selected period',   cat: 'P&L',         def: 'small'  },
                { wid: 'avg-trade-pnl',    name: 'Avg Trade P&L',   desc: 'Average P&L per trade',                     cat: 'P&L',         def: 'small'  },
                { wid: 'best-day',         name: 'Best Day',         desc: 'Highest single-day P&L',                    cat: 'P&L',         def: 'small'  },
                { wid: 'worst-day',        name: 'Worst Day',        desc: 'Lowest single-day P&L',                     cat: 'P&L',         def: 'small'  },
                { wid: 'equity-curve',     name: 'Equity Curve',     desc: 'Cumulative P&L over time',                  cat: 'Charts',      def: 'large'  },
                { wid: 'daily-pnl-bars',   name: 'Daily P&L Bars',  desc: 'Bar chart of P&L by day',                   cat: 'Charts',      def: 'medium' },
                { wid: 'top-setups',       name: 'Top Strategies',   desc: 'P&L breakdown by strategy',               cat: 'Charts',      def: 'medium' },
                { wid: 'win-rate',         name: 'Win Rate',         desc: 'Percentage of winning trades',              cat: 'Performance', def: 'small'  },
                { wid: 'trade-count',      name: 'Trade Count',      desc: 'Total number of trades',                    cat: 'Performance', def: 'small'  },
                { wid: 'avg-win',          name: 'Avg Win',          desc: 'Average profit on winning trades',          cat: 'Performance', def: 'small'  },
                { wid: 'avg-loss',         name: 'Avg Loss',         desc: 'Average loss on losing trades',             cat: 'Performance', def: 'small'  },
                { wid: 'expectancy',       name: 'Expectancy',       desc: 'Expected value per trade',                  cat: 'Performance', def: 'small'  },
                { wid: 'profit-factor',    name: 'Profit Factor',    desc: 'Gross wins divided by gross losses',        cat: 'Performance', def: 'small'  },
                { wid: 'largest-win',      name: 'Largest Win',      desc: 'Single largest winning trade',              cat: 'Risk',        def: 'small'  },
                { wid: 'largest-loss',     name: 'Largest Loss',     desc: 'Single largest losing trade',               cat: 'Risk',        def: 'small'  },
                { wid: 'commission-total', name: 'Commission Paid',  desc: 'Total commissions and fees',                cat: 'Risk',        def: 'small'  },
                { wid: 'hold-time-avg',    name: 'Avg Hold Time',    desc: 'Average time held per trade',               cat: 'Timing',      def: 'small'  },
                { wid: 'recent-trades',    name: 'Recent Trades',    desc: 'Last 10 trades in the selected period',     cat: 'Other',       def: 'large'  }
            ];

            // ── Helpers ─────────────────────────────────────────
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
            function fmtMins(mins) {
                if (!mins || isNaN(mins)) return '—';
                if (mins < 60) return Math.round(mins) + 'm';
                return Math.floor(mins/60) + 'h ' + (Math.round(mins%60) ? Math.round(mins%60) + 'm' : '');
            }

            // ── Filter trades ───────────────────────────────────
            function getSnapTrades() {
                return DenariiFilters.filterTrades(getSelectedAccountTrades(journalData.trades), _state, journalData.brokerAccounts, new Date());
            }

            // ── Compute metrics ─────────────────────────────────
            function calcSnap(trades) {
                var m = {
                    tradeCount:0, totalPnl:0, winCount:0, lossCount:0, winRate:0,
                    sumWins:0, sumLosses:0, avgWin:0, avgLoss:0, expectancy:0,
                    profitFactor:0, largestWin:0, largestLoss:0, totalCommission:0,
                    avgHoldMins:0, avgTradePnl:0,
                    bestDayStr:'', bestDayPnl:0, worstDayStr:'', worstDayPnl:0,
                    dailyMap:{}, cumPnl:[]
                };
                m.tradeCount = trades.length;
                if (!trades.length) return m;

                var sorted = trades.slice().sort(function(a,b) {
                    return new Date(a.exitTime||a.entryTime||0) - new Date(b.exitTime||b.entryTime||0);
                });
                var cum = 0;
                sorted.forEach(function(t) {
                    var pnl = t.pnl || 0;
                    cum += pnl;
                    var ds = DenariiFilters.localDayKey(t.exitTime||t.entryTime);
                    m.cumPnl.push({ date: ds, cum: cum });
                    m.totalPnl       += pnl;
                    m.totalCommission+= (t.commissionFees||0);
                    if (pnl > 0) { m.winCount++;  m.sumWins   += pnl; if (pnl > m.largestWin)  m.largestWin  = pnl; }
                    else if (pnl < 0) { m.lossCount++; m.sumLosses += pnl; if (pnl < m.largestLoss) m.largestLoss = pnl; }
                    if (ds) m.dailyMap[ds] = (m.dailyMap[ds]||0) + pnl;
                    if (t.entryTime && t.exitTime) {
                        var mins = (new Date(t.exitTime)-new Date(t.entryTime))/60000;
                        m.avgHoldMins += mins;
                    }
                });
                m.winRate      = m.tradeCount ? m.winCount/m.tradeCount*100 : 0;
                m.avgWin       = m.winCount   ? m.sumWins/m.winCount        : 0;
                m.avgLoss      = m.lossCount  ? m.sumLosses/m.lossCount     : 0;
                m.avgTradePnl  = m.tradeCount ? m.totalPnl/m.tradeCount     : 0;
                m.expectancy   = (m.winRate/100)*m.avgWin + (1-m.winRate/100)*m.avgLoss;
                m.profitFactor = m.sumLosses  ? Math.abs(m.sumWins/m.sumLosses) : (m.sumWins>0?Infinity:0);
                m.avgHoldMins  = m.tradeCount ? m.avgHoldMins/m.tradeCount  : 0;
                var days = Object.keys(m.dailyMap);
                if (days.length) {
                    m.bestDayStr  = days.reduce(function(a,b){ return m.dailyMap[a]>=m.dailyMap[b]?a:b; });
                    m.worstDayStr = days.reduce(function(a,b){ return m.dailyMap[a]<=m.dailyMap[b]?a:b; });
                    m.bestDayPnl  = m.dailyMap[m.bestDayStr];
                    m.worstDayPnl = m.dailyMap[m.worstDayStr];
                }
                return m;
            }

            // ── Widget shell ────────────────────────────────────
            function widgetHtml(id, title, bodyHtml, size) {
                var dragAttr = _state.editMode ? ' draggable="true"' : '';
                var handle   = _state.editMode
                    ? '<span class="snap-drag-handle" title="Drag to reorder">⠿</span>'
                    : '';
                var controls = _state.editMode
                    ? '<div class="snap-widget-controls">' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='small'?' snap-ctrl-sz-active':'')+'" onclick="snapResizeWidget(\''+id+'\',\'small\')" title="Small">S</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='medium'?' snap-ctrl-sz-active':'')+'" onclick="snapResizeWidget(\''+id+'\',\'medium\')" title="Medium">M</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(size==='large'?' snap-ctrl-sz-active':'')+'" onclick="snapResizeWidget(\''+id+'\',\'large\')" title="Large">L</button>' +
                          '<span class="snap-ctrl-sep"></span>' +
                          '<button class="snap-ctrl-btn snap-ctrl-remove" onclick="snapRemoveWidget(\''+id+'\')" title="Remove widget">✕</button>' +
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

            // ── Renderers ────────────────────────────────────────
            var RENDERERS = {

                'si-snapshot-direction-banner': function(id, t, m, sz) {
                    if (!m.tradeCount) {
                        return widgetHtml(id, 'Snapshot Direction',
                            '<div class="si-insight-text">No trades in the current view.</div>', sz);
                    }

                    // Check conditions in priority order — surface only the single most notable one
                    // 1. Win/loss asymmetry problem
                    var rrRatio = Math.abs(m.avgLoss) > 0 ? m.avgWin / Math.abs(m.avgLoss) : 0;
                    if (m.winCount >= 5 && m.lossCount >= 5 && rrRatio > 0 && rrRatio < 1) {
                        return widgetHtml(id, 'Snapshot Direction',
                            '<div class="si-insight-text">Your average loss (' + fmt$(m.avgLoss) +
                            ') is larger than your average win (' + fmt$(m.avgWin) +
                            '). Review Risk for damage control.</div>', sz);
                    }

                    // 2. Win rate below 40% with enough trades
                    if (m.tradeCount >= 10 && m.winRate < 40) {
                        return widgetHtml(id, 'Snapshot Direction',
                            '<div class="si-insight-text">Win rate is ' + fmtPct(m.winRate) +
                            ' across ' + m.tradeCount + ' trades. Review Strategy and Discipline for quality issues.</div>', sz);
                    }

                    // 3. Worst day disproportionately large relative to total P&L
                    if (m.worstDayPnl < 0 && Math.abs(m.worstDayPnl) > Math.abs(m.totalPnl) * 0.5 && m.tradeCount >= 10) {
                        return widgetHtml(id, 'Snapshot Direction',
                            '<div class="si-insight-text">Your worst day (' + fmt$(m.worstDayPnl) +
                            ') accounts for a large share of your results. Review Risk for stop-loss modeling.</div>', sz);
                    }

                    // 4. Positive overall — brief acknowledgment
                    if (m.totalPnl > 0 && m.profitFactor >= 1.5 && m.tradeCount >= 10) {
                        return widgetHtml(id, 'Snapshot Direction',
                            '<div class="si-insight-text">Results are net positive with a ' +
                            (isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '—') +
                            ' profit factor. Review Performance Trends for consistency over time.</div>', sz);
                    }

                    // Default neutral
                    return widgetHtml(id, 'Snapshot Direction',
                        '<div class="si-insight-text">No single high-priority issue stands out in the current view.</div>', sz);
                },

                'total-pnl': function(id, t, m, sz) {
                    return widgetHtml(id, 'Total P&L', kpiHtml(
                        (m.totalPnl>=0?'+':'')+fmt$(m.totalPnl),
                        m.tradeCount+' trade'+(m.tradeCount!==1?'s':''), pnlColorClass(m.totalPnl)), sz);
                },
                'win-rate': function(id, t, m, sz) {
                    return widgetHtml(id, 'Win Rate', kpiHtml(
                        fmtPct(m.winRate), m.winCount+'W / '+m.lossCount+'L',
                        m.winRate>=50?'snap-kpi-positive':m.winRate>0?'snap-kpi-negative':'snap-kpi-neutral'), sz);
                },
                'trade-count': function(id, t, m, sz) {
                    return widgetHtml(id, 'Trade Count', kpiHtml(m.tradeCount,'trades logged','snap-kpi-neutral'), sz);
                },
                'avg-win': function(id, t, m, sz) {
                    return widgetHtml(id, 'Avg Win', kpiHtml(
                        fmt$(m.avgWin), m.winCount+' winning trade'+(m.winCount!==1?'s':''),
                        m.avgWin>0?'snap-kpi-positive':'snap-kpi-neutral'), sz);
                },
                'avg-loss': function(id, t, m, sz) {
                    return widgetHtml(id, 'Avg Loss', kpiHtml(
                        fmt$(m.avgLoss), m.lossCount+' losing trade'+(m.lossCount!==1?'s':''),
                        m.avgLoss<0?'snap-kpi-negative':'snap-kpi-neutral'), sz);
                },
                'expectancy': function(id, t, m, sz) {
                    return widgetHtml(id, 'Expectancy', kpiHtml(
                        (m.expectancy>=0?'+':'')+fmt$(m.expectancy),
                        'expected value per trade', pnlColorClass(m.expectancy)), sz);
                },
                'profit-factor': function(id, t, m, sz) {
                    var pf = isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞';
                    return widgetHtml(id, 'Profit Factor', kpiHtml(pf, 'gross wins ÷ gross losses',
                        m.profitFactor>=1.5?'snap-kpi-positive':m.profitFactor>=1?'snap-kpi-neutral':'snap-kpi-negative'), sz);
                },
                'largest-win': function(id, t, m, sz) {
                    return widgetHtml(id, 'Largest Win', kpiHtml(fmt$(m.largestWin),'single trade','snap-kpi-positive'), sz);
                },
                'largest-loss': function(id, t, m, sz) {
                    return widgetHtml(id, 'Largest Loss', kpiHtml(fmt$(m.largestLoss),'single trade',
                        m.largestLoss<0?'snap-kpi-negative':'snap-kpi-neutral'), sz);
                },
                'commission-total': function(id, t, m, sz) {
                    return widgetHtml(id, 'Commission Paid', kpiHtml(fmt$(m.totalCommission),'total fees',
                        m.totalCommission>0?'snap-kpi-negative':'snap-kpi-neutral'), sz);
                },
                'hold-time-avg': function(id, t, m, sz) {
                    return widgetHtml(id, 'Avg Hold Time', kpiHtml(fmtMins(m.avgHoldMins),'per trade','snap-kpi-neutral'), sz);
                },
                'avg-trade-pnl': function(id, t, m, sz) {
                    return widgetHtml(id, 'Avg Trade P&L', kpiHtml(
                        (m.avgTradePnl>=0?'+':'')+fmt$(m.avgTradePnl),'per trade', pnlColorClass(m.avgTradePnl)), sz);
                },
                'best-day': function(id, t, m, sz) {
                    return widgetHtml(id, 'Best Day', kpiHtml(
                        fmt$(m.bestDayPnl), m.bestDayStr||'no data',
                        m.bestDayPnl>0?'snap-kpi-positive':'snap-kpi-neutral'), sz);
                },
                'worst-day': function(id, t, m, sz) {
                    return widgetHtml(id, 'Worst Day', kpiHtml(
                        fmt$(m.worstDayPnl), m.worstDayStr||'no data',
                        m.worstDayPnl<0?'snap-kpi-negative':'snap-kpi-neutral'), sz);
                },
                'equity-curve': function(id, t, m, sz) {
                    if (!m.cumPnl.length) return widgetHtml(id,'Equity Curve','<div class="snap-empty">No trade data.</div>',sz);
                    return widgetHtml(id,'Equity Curve','<div id="snap-chart-'+id+'" class="snap-chart-wrap" style="height:220px;"></div>',sz);
                },
                'daily-pnl-bars': function(id, t, m, sz) {
                    if (!Object.keys(m.dailyMap).length) return widgetHtml(id,'Daily P&L','<div class="snap-empty">No trade data.</div>',sz);
                    return widgetHtml(id,'Daily P&L','<div id="snap-chart-'+id+'" class="snap-chart-wrap" style="height:220px;"></div>',sz);
                },
                'top-setups': function(id, trades, m, sz) {
                    var hasSetups = trades.some(function(t){ return t.setupType; });
                    if (!hasSetups) return widgetHtml(id,'Top Strategies','<div class="snap-empty">No strategy data.</div>',sz);
                    return widgetHtml(id,'Top Strategies','<div id="snap-chart-'+id+'" class="snap-chart-wrap" style="height:220px;"></div>',sz);
                },
                'recent-trades': function(id, trades, m, sz) {
                    if (!trades.length) return widgetHtml(id,'Recent Trades','<div class="snap-empty">No trades in this period.</div>',sz);
                    var acctMap = {};
                    (journalData.brokerAccounts||[]).forEach(function(a){ acctMap[a.id]=a.displayName; });
                    var recent = trades.slice().sort(function(a,b){
                        return new Date(b.exitTime||b.entryTime||0)-new Date(a.exitTime||a.entryTime||0);
                    }).slice(0,10);
                    var rows = recent.map(function(t) {
                        var pnl = t.pnl||0;
                        var c = pnl>=0?'var(--success)':'var(--danger)';
                        var ps = (pnl>=0?'+':'-')+'$'+Math.abs(pnl).toLocaleString('en-US',{minimumFractionDigits:2,maximumFractionDigits:2});
                        var dt = t.exitTime ? new Date(t.exitTime).toLocaleDateString() : '—';
                        return '<tr><td>'+dt+'</td><td><strong>'+DenariiFilters.esc(t.symbol||'—')+'</strong></td>' +
                            '<td style="text-transform:capitalize">'+DenariiFilters.esc(t.type||'—')+'</td>' +
                            '<td>'+DenariiFilters.esc(t.setupType||'—')+'</td>' +
                            '<td style="font-weight:600;color:'+c+'">'+ps+'</td></tr>';
                    }).join('');
                    var body = '<div style="overflow-x:auto;"><table class="snap-trades-table">' +
                        '<thead><tr><th>Date</th><th>Symbol</th><th>Side</th><th>Strategy</th><th>P&L</th></tr></thead>' +
                        '<tbody>'+rows+'</tbody></table></div>';
                    return widgetHtml(id,'Recent Trades',body,sz);
                }
            };

            // ── Plotly charts ────────────────────────────────────
            function snapRenderCharts(trades, m, layout) {
                var bg   = 'transparent';
                var gc   = 'rgba(255,255,255,0.07)';
                var tc   = '#8b9aae';
                var ax   = { gridcolor:gc, tickfont:{size:11,color:tc}, linecolor:gc, zeroline:false };
                var base = { paper_bgcolor:bg, plot_bgcolor:bg,
                             margin:{t:10,r:10,b:36,l:50},
                             font:{family:'Inter,sans-serif',color:tc}, showlegend:false };
                layout.forEach(function(item) {
                    var el = document.getElementById('snap-chart-'+item.id);
                    if (!el) return;

                    if (item.wid==='equity-curve' && m.cumPnl.length) {
                        var xs = m.cumPnl.map(function(p){return p.date;});
                        var ys = m.cumPnl.map(function(p){return p.cum;});
                        var lc = ys[ys.length-1]>=0?'#22c55e':'#ef4444';
                        try { Plotly.react(el,[{
                            x:xs,y:ys,type:'scatter',mode:'lines',
                            fill:'tozeroy',
                            fillcolor:ys[ys.length-1]>=0?'rgba(34,197,94,0.12)':'rgba(239,68,68,0.12)',
                            line:{color:lc,width:2}
                        }],Object.assign({},base,{xaxis:Object.assign({},ax),yaxis:Object.assign({},ax,{tickprefix:'$'})}),
                        {responsive:true,displayModeBar:false}); } catch(e){}
                    }

                    if (item.wid==='daily-pnl-bars') {
                        var days = Object.keys(m.dailyMap).sort();
                        var vals = days.map(function(d){return m.dailyMap[d];});
                        try { Plotly.react(el,[{
                            x:days,y:vals,type:'bar',
                            marker:{color:vals.map(function(v){return v>=0?'rgba(34,197,94,0.75)':'rgba(239,68,68,0.75)';})}
                        }],Object.assign({},base,{xaxis:Object.assign({},ax),yaxis:Object.assign({},ax,{tickprefix:'$'})}),
                        {responsive:true,displayModeBar:false}); } catch(e){}
                    }

                    if (item.wid==='top-setups') {
                        var sm={};
                        trades.forEach(function(t){ var s=t.setupType||'No Strategy'; sm[s]=(sm[s]||0)+(t.pnl||0); });
                        var sn=Object.keys(sm).sort(function(a,b){return sm[b]-sm[a];});
                        var sv=sn.map(function(n){return sm[n];});
                        try { Plotly.react(el,[{
                            x:sv,y:sn,type:'bar',orientation:'h',
                            marker:{color:sv.map(function(v){return v>=0?'rgba(34,197,94,0.75)':'rgba(239,68,68,0.75)';})}
                        }],Object.assign({},base,{
                            margin:{t:10,r:10,b:36,l:100},
                            xaxis:Object.assign({},ax,{tickprefix:'$'}),
                            yaxis:Object.assign({},ax,{automargin:true})
                        }),{responsive:true,displayModeBar:false}); } catch(e){}
                    }
                });
            }

            // ── Drag-and-drop reordering ─────────────────────────
            var _drag = { srcId: null, overId: null };

            function setupSnapDrag() {
                var grid = document.getElementById('snap-grid');
                if (!grid || grid._snapDragBound) return;
                grid._snapDragBound = true;

                grid.addEventListener('dragstart', function(e) {
                    if (!_state.editMode) { e.preventDefault(); return; }
                    // Don't initiate drag from buttons
                    if (e.target.tagName === 'BUTTON') { e.preventDefault(); return; }
                    var widget = e.target.closest('[data-instance-id]');
                    if (!widget) return;
                    _drag.srcId  = widget.dataset.instanceId;
                    _drag.overId = null;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', _drag.srcId);
                    // Defer so the ghost image renders before opacity change
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
                    if (overId === _drag.overId) return;          // no change
                    // Clear previous highlight
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

                    // Remove from current position, insert before target
                    var moved = layout.splice(srcIdx, 1)[0];
                    // Recalculate target index after splice
                    var newTgt = layout.findIndex(function(w) { return w.id === targetId; });
                    layout.splice(newTgt, 0, moved);

                    _drag.srcId  = null;
                    _drag.overId = null;
                    saveLayout();
                    renderSnapshot();
                });
            }

            // ── Main render ──────────────────────────────────────
            function renderSnapshot() {
                Object.assign(_state, DenariiFilters.readState('snap'));

                var trades = getSnapTrades();
                var m      = calcSnap(trades);
                var layout = _state.layout || SNAP_DEFAULT.map(function(w){return Object.assign({},w);});

                var grid = document.getElementById('snap-grid');
                if (!grid) return;
                grid.className = 'snap-grid'+(_state.editMode?' snap-edit-mode':'');
                grid.innerHTML = layout.map(function(item) {
                    return RENDERERS[item.wid] ? RENDERERS[item.wid](item.id, trades, m, item.size||'small') : '';
                }).join('');

                setTimeout(function(){ snapRenderCharts(trades, m, layout); }, 60);
            }

            // ── Populate filter dropdowns ────────────────────────
            function populateSnapFilters() {
                var stlSel   = document.getElementById('snap-style');
                var perSel   = document.getElementById('snap-period');
                var astSel   = document.getElementById('snap-asset-type');
                var stratSel = document.getElementById('snap-strategy');
                var symEl    = document.getElementById('snap-symbol');
                var fromEl   = document.getElementById('snap-from');
                var toEl     = document.getElementById('snap-to');
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

            // ── Save layout to local database ─────────────────────────
            function saveLayout() {
                journalData.snapshotLayout = JSON.parse(JSON.stringify(_state.layout));
                if (typeof saveToIndexedDB === 'function') saveToIndexedDB();
            }

            // ── Init ─────────────────────────────────────────────
            function initSnapshot() {
                _state.layout = journalData.snapshotLayout
                    ? JSON.parse(JSON.stringify(journalData.snapshotLayout))
                    : SNAP_DEFAULT.map(function(w){ return Object.assign({},w); });
                populateSnapFilters();
                renderSnapshot();
                setupSnapDrag();
            }

            // ═══ Window-exposed API ══════════════════════════════

            window.renderSnapshot = renderSnapshot;

            window.toggleSnapEdit = function() {
                _state.editMode = !_state.editMode;
                var banner = document.getElementById('snap-edit-banner');
                var btn    = document.getElementById('snap-edit-btn');
                if (banner) banner.style.display = _state.editMode ? 'flex' : 'none';
                if (btn)    btn.textContent = _state.editMode ? '✓ Done Editing' : 'Edit Layout';
                renderSnapshot();
            };

            window.snapResizeWidget = function(id, newSize) {
                var item = (_state.layout||[]).find(function(w){ return w.id===id; });
                if (item) { item.size=newSize; saveLayout(); renderSnapshot(); }
            };

            window.snapRemoveWidget = function(id) {
                if (!_state.layout) return;
                _state.layout = _state.layout.filter(function(w){ return w.id!==id; });
                saveLayout(); renderSnapshot();
            };

            window.snapResetLayout = function() {
                if (!confirm('Reset widget layout to default?')) return;
                _state.layout = SNAP_DEFAULT.map(function(w){ return Object.assign({},w); });
                saveLayout(); renderSnapshot();
            };

            window.openSnapPicker = function() {
                snapRenderPicker();
                var o = document.getElementById('snap-picker-overlay');
                var p = document.getElementById('snap-picker-panel');
                if (o) o.classList.add('open');
                if (p) p.classList.add('open');
            };

            window.closeSnapPicker = function() {
                var o = document.getElementById('snap-picker-overlay');
                var p = document.getElementById('snap-picker-panel');
                if (o) o.classList.remove('open');
                if (p) p.classList.remove('open');
            };

            function snapRenderPicker() {
                var q    = (document.getElementById('snap-picker-q')||{}).value || '';
                var body = document.getElementById('snap-picker-body');
                if (!body) return;
                var activeWids = {};
                (_state.layout||[]).forEach(function(w){ activeWids[w.wid] = true; });
                var filtered = SNAP_LIB.filter(function(w){
                    return !q || w.name.toLowerCase().includes(q.toLowerCase()) ||
                                 w.desc.toLowerCase().includes(q.toLowerCase());
                });
                if (!filtered.length) {
                    body.innerHTML = '<div class="snap-empty" style="padding-top:24px;">No widgets match.</div>';
                    return;
                }
                var cats=[], bycat={};
                filtered.forEach(function(w){
                    if (!bycat[w.cat]){ bycat[w.cat]=[]; cats.push(w.cat); }
                    bycat[w.cat].push(w);
                });
                body.innerHTML = cats.map(function(cat){
                    return '<div class="snap-picker-cat-label">'+cat+'</div>' +
                        bycat[cat].map(function(w){
                            var added = activeWids[w.wid];
                            return '<div class="snap-picker-item'+(added?' snap-picker-item--added':'')+'">' +
                                '<div class="snap-picker-item-info">' +
                                    '<div class="snap-picker-item-name">'+w.name+'</div>' +
                                    '<div class="snap-picker-item-desc">'+w.desc+'</div>' +
                                '</div>' +
                                (added
                                    ? '<span class="snap-picker-item-added">Added</span>'
                                    : '<button class="snap-picker-item-add" onclick="snapAddWidget(\''+w.wid+'\')">+ Add</button>') +
                            '</div>';
                        }).join('');
                }).join('');
            }
            window.snapRenderPicker = snapRenderPicker;

            window.snapAddWidget = function(wid) {
                if (!_state.layout) _state.layout = [];
                var already = _state.layout.some(function(w){ return w.wid===wid; });
                if (already) return;
                var def = SNAP_LIB.find(function(w){ return w.wid===wid; });
                _state.layout.push({ id: 'si'+Date.now(), wid: wid, size: def?def.def:'small' });
                saveLayout();
                window.closeSnapPicker();
                renderSnapshot();
            };

            window._snapInit = initSnapshot;

            // Mounted once at load. Fill Style here too: the app's first
            // _populateStyleSelects() may already have run.
            DenariiFilters.mountFilterBar(document.getElementById('snap-filter-bar'), {
                prefix: 'snap',
                onChange: renderSnapshot
            });
            if (typeof _populateStyleSelect === 'function') _populateStyleSelect('snap-style', true);

        })();
