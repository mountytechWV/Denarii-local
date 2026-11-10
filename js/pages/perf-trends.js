        // PERFORMANCE TRENDS PAGE
        // ═══════════════════════════════════════════════════════
        (function() {
            'use strict';

            // ── State ──────────────────────────────────────────
            var _state = {
                period: 'all', from: '', to: '',
                style: 'all', assetType: 'all', strategy: 'all', symbol: '',
                groupBy: 'day',
                editMode: false, layout: null
            };

            // ── Default layout ─────────────────────────────────
            var PT_DEFAULT = [
                { id:'pt16', wid:'pt-drawdown-context-insight', size:'large' },
                { id:'pt1',  wid:'equity-curve',       size:'large'  },
                { id:'pt2',  wid:'daily-pnl',          size:'medium' },
                { id:'pt3',  wid:'drawdown-curve',     size:'medium' },
                { id:'pt4',  wid:'weekly-pnl',         size:'medium' },
                { id:'pt5',  wid:'monthly-pnl',        size:'medium' },
                { id:'pt6',  wid:'trade-count',        size:'medium' },
                { id:'pt7',  wid:'win-rate-trend',     size:'medium' },
                { id:'pt8',  wid:'avg-pnl-trend',      size:'medium' },
                { id:'pt9',  wid:'red-day-rate',       size:'medium' },
                { id:'pt10', wid:'pnl-distribution',   size:'medium' },
                { id:'pt11', wid:'green-red-days',     size:'medium' },
                { id:'pt12', wid:'dow-trend',          size:'medium' },
                { id:'pt13', wid:'time-of-day',        size:'medium' },
                { id:'pt14', wid:'largest-loss-trend', size:'medium' },
                { id:'pt15', wid:'setup-contrib',      size:'medium' }
            ];

            // ── Widget library ─────────────────────────────────
            var PT_LIB = [
                // Insight
                { wid:'pt-drawdown-context-insight', name:'Drawdown Context', desc:'Plain-language read on current drawdown relative to peak and max drawdown', cat:'Insight', def:'large' },
                // Core Trend Charts
                { wid:'equity-curve',        name:'Equity Curve',         desc:'Cumulative P&L growth over time',              cat:'Core Trends',   def:'large'  },
                { wid:'daily-pnl',           name:'Daily P&L Trend',      desc:'P&L broken out by trading day',                cat:'Core Trends',   def:'medium' },
                { wid:'weekly-pnl',          name:'Weekly P&L Trend',     desc:'P&L grouped by week',                          cat:'Core Trends',   def:'medium' },
                { wid:'monthly-pnl',         name:'Monthly P&L Trend',    desc:'P&L grouped by month',                         cat:'Core Trends',   def:'medium' },
                { wid:'trade-count',         name:'Trade Count Trend',    desc:'Number of trades over time',                   cat:'Core Trends',   def:'medium' },
                { wid:'win-rate-trend',      name:'Win Rate Trend',       desc:'How win rate changes over time',               cat:'Core Trends',   def:'medium' },
                { wid:'avg-pnl-trend',       name:'Avg Trade P&L Trend',  desc:'Average trade outcome over time',              cat:'Core Trends',   def:'medium' },
                // Risk
                { wid:'drawdown-curve',      name:'Drawdown Curve',       desc:'Peak-to-trough decline over time',             cat:'Risk Trends',   def:'medium' },
                { wid:'largest-loss-trend',  name:'Largest Loss by Period',desc:'Worst trade per period',                      cat:'Risk Trends',   def:'medium' },
                { wid:'avg-loss-trend',      name:'Avg Loss Trend',       desc:'Average losing trade over time',               cat:'Risk Trends',   def:'medium' },
                { wid:'red-day-rate',        name:'Red Day Rate Trend',   desc:'Frequency of losing days over time',           cat:'Risk Trends',   def:'medium' },
                // Consistency
                { wid:'pnl-distribution',    name:'P&L Distribution',     desc:'Spread of trade outcomes across win/loss buckets', cat:'Consistency', def:'medium' },
                { wid:'green-red-days',      name:'Green vs Red Days',    desc:'Green vs red day count over time',             cat:'Consistency',   def:'medium' },
                // Setup Mix
                { wid:'top-setups-trend',    name:'Top Strategies Over Time', desc:'Strategy P&L contribution over time',             cat:'Strategy Mix',     def:'large'  },
                { wid:'setup-contrib',       name:'Strategy Contribution',   desc:'Strategy breakdown by selected period',           cat:'Strategy Mix',     def:'medium' },
                // Timing
                { wid:'dow-trend',           name:'Day-of-Week Trend',    desc:'Performance by weekday',                       cat:'Timing',        def:'medium' },
                { wid:'time-of-day',         name:'Time-of-Day Trend',    desc:'Performance by session window',                cat:'Timing',        def:'medium' },
                { wid:'month-of-year',       name:'Month-of-Year Trend',  desc:'Performance by calendar month',                cat:'Timing',        def:'medium' },
                // Summary KPIs
                { wid:'kpi-net-pnl',         name:'Net P&L Summary',      desc:'Total net P&L for current filters',            cat:'Summary',       def:'small'  },
                { wid:'kpi-win-rate',        name:'Win Rate Summary',     desc:'Win rate for current filters',                 cat:'Summary',       def:'small'  },
                { wid:'kpi-profit-factor',   name:'Profit Factor Summary',desc:'Gross wins divided by gross losses',           cat:'Summary',       def:'small'  },
                { wid:'kpi-max-drawdown',    name:'Max Drawdown Summary', desc:'Maximum peak-to-trough decline',               cat:'Summary',       def:'small'  },
                { wid:'kpi-expectancy',      name:'Trade Expectancy',     desc:'Expected dollar value per trade based on win rate and avg win/loss', cat:'Summary', def:'small' },
                { wid:'kpi-avg-net-trade',   name:'Avg Net Trade P&L',    desc:'Average profit or loss per trade',              cat:'Summary',       def:'small'  },
                { wid:'kpi-avg-win',         name:'Avg Win',              desc:'Average winning trade amount',                   cat:'Summary',       def:'small'  },
                { wid:'kpi-avg-loss',        name:'Avg Loss',             desc:'Average losing trade amount',                    cat:'Summary',       def:'small'  },
                { wid:'kpi-logged-days',     name:'Logged Days',          desc:'Number of unique trading days in current view',  cat:'Summary',       def:'small'  },
                { wid:'kpi-avg-daily-volume',name:'Avg Daily Volume',     desc:'Average contracts or shares traded per day',     cat:'Summary',       def:'small'  },
                { wid:'kpi-avg-daily-pnl',   name:'Avg Daily Net P&L',    desc:'Average net P&L per trading day',               cat:'Summary',       def:'small'  },
                { wid:'kpi-avg-trade-wl',    name:'Avg Trade Win/Loss',   desc:'Ratio of average winning trade to average losing trade', cat:'Summary', def:'small' },
                { wid:'kpi-avg-daily-wl',    name:'Avg Daily Win/Loss',   desc:'Ratio of green days to red days',               cat:'Summary',       def:'small'  }
            ];

            // ── Help content ───────────────────────────────────
            var HELP = {
                'equity-curve': {
                    title: 'Equity Curve',
                    what: 'Your cumulative running profit or loss over the selected period.',
                    why: "One of the clearest ways to see whether your trading is growing steadily, chopping sideways, or slipping over time.",
                    how: 'Look for consistency, not just size. A smoother upward curve often suggests a more repeatable edge than one driven by a few sharp spikes.',
                    watch: 'A strong-looking curve based on few trades may not be reliable. Large jumps can mean your results depend too much on outlier trades.'
                },
                'daily-pnl': {
                    title: 'Daily P&L Trend',
                    what: 'Your profit or loss broken out by day across the selected period.',
                    why: 'Shows how steady or unstable your daily trading results are.',
                    how: 'Use this to spot rhythm — are you stacking solid days, chopping around, or giving back gains too often?',
                    watch: 'Short date ranges can make the chart look more dramatic than it really is.'
                },
                'drawdown-curve': {
                    title: 'Drawdown Curve',
                    what: 'The size of your peak-to-trough decline over time.',
                    why: 'Shows how much damage your strategy or behavior creates before recovery.',
                    how: 'Compare this with your equity curve. Strong returns with harsh drawdowns may still point to weak risk management.',
                    watch: 'A profitable period can hide unstable risk if drawdowns are too deep or frequent.'
                },
                'weekly-pnl': {
                    title: 'Weekly P&L Trend',
                    what: 'Your profit or loss grouped by week.',
                    why: 'Smooths day-to-day noise and makes broader performance patterns easier to see.',
                    how: 'Use this to judge whether progress is building across multiple weeks or gains are getting interrupted.',
                    watch: 'One unusually strong or weak week can distort the story if the sample is small.'
                },
                'monthly-pnl': {
                    title: 'Monthly P&L Trend',
                    what: 'Your profit or loss grouped by month.',
                    why: 'Helps evaluate larger performance cycles and whether results are improving over time.',
                    how: 'Compare one month against another to spot whether you are building consistency across longer periods.',
                    watch: 'Monthly results can be influenced by low activity or a few outsized trades — check trade count too.'
                },
                'trade-count': {
                    title: 'Trade Count Trend',
                    what: 'How many trades you took over the selected time grouping.',
                    why: 'Gives context to all other performance data and reveals overtrading or undertrading patterns.',
                    how: 'Compare participation with results. More trades do not always mean better performance.',
                    watch: 'High trade count can look productive while actually hiding overtrading or lower-quality execution.'
                },
                'win-rate-trend': {
                    title: 'Win Rate Trend',
                    what: 'How your win rate changes over time.',
                    why: 'Shows whether your ideas are landing more consistently or starting to weaken.',
                    how: 'Use this with avg win, avg loss, and profit factor. Win rate is more meaningful when seen alongside outcome quality.',
                    watch: 'Win rate alone can be misleading. Higher win rate does not automatically mean better profitability.'
                },
                'avg-pnl-trend': {
                    title: 'Avg Trade P&L Trend',
                    what: 'Your average profit or loss per trade over time.',
                    why: 'Shows whether each trade is producing more or less value as your trading evolves.',
                    how: 'Use this to see whether your edge is improving in quality, not just quantity.',
                    watch: 'A strong average can still be skewed by one outsized winner or loser.'
                },
                'red-day-rate': {
                    title: 'Red Day Rate Trend',
                    what: 'How often your trading days finish negative over time.',
                    why: 'Measures consistency and how often you are ending the day in the red.',
                    how: 'A falling red-day frequency can be a good sign if backed by solid risk control.',
                    watch: 'A low red-day rate is not enough on its own if your losing days are too large.'
                },
                'pnl-distribution': {
                    title: 'P&L Distribution',
                    what: 'How your trade results are spread out across wins and losses.',
                    why: 'Shows whether your results come from steady outcomes or from a few extreme trades.',
                    how: 'A healthy process often shows more than one path to profitability, not just rare outsized wins.',
                    watch: 'A distribution dominated by extreme outliers may mean your edge is less stable than it appears.'
                },
                'green-red-days': {
                    title: 'Green vs Red Days',
                    what: 'The balance between profitable and losing days across the selected period.',
                    why: 'Gives a quick visual read on day-level consistency.',
                    how: 'Use this with average green day and average red day to see whether you are building stable day-to-day performance.',
                    watch: 'More green days does not always mean better results if red days are much larger.'
                },
                'dow-trend': {
                    title: 'Day-of-Week Trend',
                    what: 'How your performance differs across weekdays.',
                    why: 'Many traders perform better on certain days because of routine, market conditions, or focus.',
                    how: 'Use this to identify where your edge is stronger or weaker during the week.',
                    watch: 'A few strong Mondays or weak Fridays do not prove a true pattern unless the sample is large enough.'
                },
                'time-of-day': {
                    title: 'Time-of-Day Trend',
                    what: 'How your performance changes across different parts of the trading session.',
                    why: 'Many traders have a real time-of-day edge and perform worse outside their strongest window.',
                    how: 'Use this to focus on session blocks where your edge is strongest and avoid low-quality periods.',
                    watch: 'Do not overreact to small samples. A strong time block should prove itself across enough trades.'
                },
                'largest-loss-trend': {
                    title: 'Largest Loss by Period',
                    what: 'The worst single trade in each period.',
                    why: 'Highlights whether tail risk is shrinking or growing over time.',
                    how: 'Look for periods with outsized worst-case losses versus the norm.',
                    watch: 'One bad period can mask overall improvement. Check trade count and context alongside.'
                },
                'avg-loss-trend': {
                    title: 'Avg Loss Trend',
                    what: 'Your average losing trade over time.',
                    why: 'Shows whether you are cutting losses more effectively as your trading develops.',
                    how: 'A shrinking average loss over time is a meaningful sign of improving risk control.',
                    watch: 'Compare alongside win rate and avg win to get the full picture.'
                },
                'top-setups-trend': {
                    title: 'Top Strategies Over Time',
                    what: 'Which strategies are driving performance across periods.',
                    why: 'Helps you see which strategies are consistently contributing and which are fading.',
                    how: 'Use this to double down on strategies showing improving contribution.',
                    watch: 'A strategy with high P&L contribution might still have low trade count — verify before over-weighting it.'
                },
                'setup-contrib': {
                    title: 'Strategy Contribution',
                    what: 'How much each strategy contributed to total P&L in the selected period.',
                    why: 'Reveals which parts of your playbook are actually driving results.',
                    how: 'Use this to focus your review time on the strategies that matter most.',
                    watch: 'High contribution from one strategy can mean concentration risk if conditions change.'
                },
                'month-of-year': {
                    title: 'Month-of-Year Trend',
                    what: 'Performance grouped by calendar month across all years.',
                    why: 'Reveals seasonal patterns in your trading results.',
                    how: 'Use this to anticipate historically strong or weak months and adjust expectations.',
                    watch: 'Seasonal patterns need multiple years of data to be meaningful.'
                },
                'kpi-net-pnl':       { title: 'Net P&L Summary',      what: 'Total net P&L for current filters.',   why: 'Quick reference for overall performance in this view.' },
                'kpi-win-rate':      { title: 'Win Rate Summary',      what: 'Win rate for current filters.',        why: 'High-level read on how often you finish trades in profit.' },
                'kpi-profit-factor': { title: 'Profit Factor Summary', what: 'Gross wins divided by gross losses.',  why: 'A value above 1 means you are making more than you are losing in aggregate.' },
                'kpi-max-drawdown':  { title: 'Max Drawdown Summary',  what: 'Maximum peak-to-trough decline in cumulative P&L.', why: 'Shows the worst loss streak you have weathered in this period.' },
                'kpi-expectancy':    { title: 'Trade Expectancy',      what: 'The expected dollar value of each trade based on win rate and average win/loss.', why: 'A positive expectancy means your edge is mathematically sound over many trades.' },
                'kpi-avg-net-trade': { title: 'Avg Net Trade P&L',     what: 'Average profit or loss across all trades in this view.', why: 'Shows how much value each trade produces on average.' },
                'kpi-avg-win':       { title: 'Avg Win',               what: 'Average dollar amount of winning trades.', why: 'Helps you gauge the quality of your winners relative to your losers.' },
                'kpi-avg-loss':      { title: 'Avg Loss',              what: 'Average dollar amount of losing trades.', why: 'Smaller average losses relative to average wins indicate better risk management.' },
                'kpi-logged-days':   { title: 'Logged Days',           what: 'Number of unique trading days in current filters.', why: 'Gives context to all daily averages — more days means more reliable data.' },
                'kpi-avg-daily-volume': { title: 'Avg Daily Volume',   what: 'Average number of contracts or shares per day.', why: 'Shows whether you are increasing or decreasing activity over time.' },
                'kpi-avg-daily-pnl': { title: 'Avg Daily Net P&L',     what: 'Average net P&L per trading day.', why: 'A positive daily average suggests a consistent day-level edge.' },
                'kpi-avg-trade-wl':  { title: 'Avg Trade Win/Loss',    what: 'Ratio of average winning trade to average losing trade.', why: 'A ratio above 1 means your winners are larger than your losers on average.' },
                'kpi-avg-daily-wl':  { title: 'Avg Daily Win/Loss',    what: 'Ratio of green days to red days.', why: 'Shows how often you finish the day positive versus negative.' }
            };

            // ── Pure helpers ────────────────────────────────────
            function fmt$(n) {
                if (n == null || isNaN(n)) return '—';
                var abs = Math.abs(n);
                var s = abs >= 1000 ? '$' + Math.round(abs).toLocaleString() : '$' + abs.toFixed(2);
                return (n < 0 ? '-' : '') + s;
            }
            function fmtPct(n) { return (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'; }
            function pnlColor(n) {
                if (n == null || isNaN(n) || n === 0) return 'snap-kpi-neutral';
                return n > 0 ? 'snap-kpi-positive' : 'snap-kpi-negative';
            }

            function getPeriodKey(iso, gb) {
                var d = DenariiFilters.parseTradeDate(iso);
                if (!d) return '';
                switch (gb) {
                    case 'week':
                        return DenariiFilters.localWeekKey(iso);
                    case 'month':
                        return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0');
                    case 'quarter':
                        return d.getFullYear() + '-Q' + (Math.floor(d.getMonth() / 3) + 1);
                    case 'year':
                        return String(d.getFullYear());
                    default: // day
                        return DenariiFilters.localDayKey(iso);
                }
            }

            function getDateStr(iso) {
                return DenariiFilters.localDayKey(iso);
            }

            function buildPeriodMap(trades, gb) {
                // Returns sorted array of { key, trades[], pnl, wins, losses, count }
                var map = {};
                trades.forEach(function(t) {
                    var k = getPeriodKey(t.exitTime || t.entryTime, gb);
                    if (!k) return;
                    if (!map[k]) map[k] = { key: k, trades: [], pnl: 0, wins: 0, losses: 0, count: 0 };
                    map[k].trades.push(t);
                    var p = parseFloat(t.pnl) || 0;
                    map[k].pnl += p;
                    map[k].count++;
                    if (p > 0) map[k].wins++;
                    else if (p < 0) map[k].losses++;
                });
                return Object.keys(map).sort().map(function(k) { return map[k]; });
            }

            // ── Trade filtering ─────────────────────────────────
            function getTrendTrades() {
                return DenariiFilters.filterTrades(getSelectedAccountTrades(journalData.trades), _state, journalData.brokerAccounts, new Date());
            }

            // ── Summary metrics ─────────────────────────────────
            function calcSummaryMetrics(trades) {
                var m = { count:0, totalPnl:0, wins:0, losses:0, winRate:0, sumWins:0, sumLosses:0,
                          profitFactor:0, maxDrawdown:0,
                          avgWin:0, avgLoss:0, avgNetTrade:0, expectancy:0,
                          loggedDays:0, avgDailyPnl:0, avgDailyVolume:0,
                          avgTradeWL:0, avgDailyWL:0 };
                m.count = trades.length;
                if (!trades.length) return m;
                var sorted = trades.slice().sort(function(a,b) {
                    return new Date(a.exitTime||a.entryTime||0) - new Date(b.exitTime||b.entryTime||0);
                });
                var cum = 0, peak = 0;
                var dailyMap = {};
                sorted.forEach(function(t) {
                    var p = parseFloat(t.pnl) || 0;
                    m.totalPnl += p;
                    if (p > 0) { m.wins++; m.sumWins += p; }
                    else if (p < 0) { m.losses++; m.sumLosses += p; }
                    cum += p;
                    peak = Math.max(peak, cum);
                    var dd = cum - peak;
                    if (dd < m.maxDrawdown) m.maxDrawdown = dd;
                    var dk = getDateStr(t.exitTime || t.entryTime);
                    if (dk) {
                        if (!dailyMap[dk]) dailyMap[dk] = { pnl:0, volume:0 };
                        dailyMap[dk].pnl += p;
                        dailyMap[dk].volume += (t.quantity || 1);
                    }
                });
                m.currentDrawdown = cum - peak;
                m.winRate = m.count ? m.wins / m.count * 100 : 0;
                m.profitFactor = m.sumLosses ? Math.abs(m.sumWins / m.sumLosses) : (m.sumWins > 0 ? Infinity : 0);
                m.avgWin = m.wins ? m.sumWins / m.wins : 0;
                m.avgLoss = m.losses ? Math.abs(m.sumLosses) / m.losses : 0;
                m.avgNetTrade = m.count ? m.totalPnl / m.count : 0;
                m.expectancy = (m.winRate / 100 * m.avgWin) - ((1 - m.winRate / 100) * m.avgLoss);
                m.avgTradeWL = m.avgLoss > 0 ? m.avgWin / m.avgLoss : (m.avgWin > 0 ? Infinity : 0);
                var dayKeys = Object.keys(dailyMap);
                m.loggedDays = dayKeys.length;
                if (m.loggedDays) {
                    var totalDailyPnl = 0, totalVolume = 0, greenDays = 0, redDays = 0;
                    dayKeys.forEach(function(dk) {
                        totalDailyPnl += dailyMap[dk].pnl;
                        totalVolume += dailyMap[dk].volume;
                        if (dailyMap[dk].pnl > 0) greenDays++;
                        else if (dailyMap[dk].pnl < 0) redDays++;
                    });
                    m.avgDailyPnl = totalDailyPnl / m.loggedDays;
                    m.avgDailyVolume = totalVolume / m.loggedDays;
                    m.avgDailyWL = redDays > 0 ? greenDays / redDays : greenDays;
                }
                return m;
            }

            // ── Cumulative P&L series ───────────────────────────
            function calcCumSeries(trades) {
                var sorted = trades.slice().sort(function(a,b) {
                    return new Date(a.exitTime||a.entryTime||0) - new Date(b.exitTime||b.entryTime||0);
                });
                var cum = 0;
                // Only include trades with a valid date so the equity curve has correct x coords
                var result = [];
                sorted.forEach(function(t) {
                    var ds = getDateStr(t.exitTime||t.entryTime);
                    if (!ds) return;
                    cum += parseFloat(t.pnl) || 0;
                    result.push({ x: ds, y: cum });
                });
                return result;
            }

            // ── Plotly base layout ──────────────────────────────
            function chartBase(extraMargin) {
                var tc = '#8b9aae', gc = 'rgba(255,255,255,0.07)';
                var ax = { gridcolor:gc, tickfont:{size:10,color:tc}, linecolor:gc, zeroline:false, automargin:true };
                return {
                    paper_bgcolor:'transparent', plot_bgcolor:'transparent',
                    margin: extraMargin || {t:10,r:10,b:36,l:52},
                    font: {family:'Inter,sans-serif', color:tc},
                    showlegend: false,
                    _ax: ax
                };
            }

            // Header dropdown on the charts that regroup. All of them share one
            // setting. Red Day Rate and Green vs Red count days per period, so
            // their Day grouping draws as Week.
            function groupTagHtml(wid) {
                var usesGroup = ['trade-count', 'win-rate-trend', 'avg-pnl-trend', 'red-day-rate',
                    'green-red-days', 'largest-loss-trend', 'avg-loss-trend'].indexOf(wid) !== -1;
                if (!usesGroup) return '';
                var gb = _state.groupBy;
                var title = 'Changes the grouping on all grouped charts';
                if (wid === 'red-day-rate' || wid === 'green-red-days') {
                    title = 'This chart counts days per period, so Day shows as Week. ' + title;
                    if (gb === 'day') gb = 'week';
                }
                var options = ['day', 'week', 'month', 'quarter', 'year'].map(function(v){
                    return '<option value="'+v+'"'+(v===gb?' selected':'')+'>'+v.charAt(0).toUpperCase()+v.slice(1)+'</option>';
                }).join('');
                return '<label class="trd-group-tag" title="'+title+'">' +
                    '<span class="trd-group-label">Grouped by</span>' +
                    '<select class="trd-group-select" onchange="setTrendGroupBy(this.value,this)">'+options+'</select>' +
                '</label>';
            }

            // ── Widget shell ─────────────────────────────────────
            function widgetHtml(id, title, bodyHtml, sz, helpId) {
                var dragAttr = _state.editMode ? ' draggable="true"' : '';
                var handle   = _state.editMode ? '<span class="snap-drag-handle" title="Drag to reorder">⠿</span>' : '';
                var controls = _state.editMode
                    ? '<div class="snap-widget-controls">' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(sz==='small'?' snap-ctrl-sz-active':'')+'" onclick="trendResizeWidget(\''+id+'\',\'small\')" title="Small">S</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(sz==='medium'?' snap-ctrl-sz-active':'')+'" onclick="trendResizeWidget(\''+id+'\',\'medium\')" title="Medium">M</button>' +
                          '<button class="snap-ctrl-btn snap-ctrl-sz'+(sz==='large'?' snap-ctrl-sz-active':'')+'" onclick="trendResizeWidget(\''+id+'\',\'large\')" title="Large">L</button>' +
                          '<span class="snap-ctrl-sep"></span>' +
                          '<button class="snap-ctrl-btn snap-ctrl-remove" onclick="trendRemoveWidget(\''+id+'\')" title="Remove">✕</button>' +
                      '</div>'
                    : '';
                var helpBtn = helpId
                    ? '<button class="trd-help-btn" onclick="showTrendHelp(\''+helpId+'\',this)" title="Learn about this chart">?</button>'
                    : '';
                return '<div class="snap-widget snap-widget--'+sz+'"'+dragAttr+' data-instance-id="'+id+'">' +
                    '<div class="snap-widget-header">' +
                        handle +
                        '<span class="snap-widget-title">'+title+'</span>' +
                        (_state.editMode ? '' : groupTagHtml(helpId)) +
                        helpBtn +
                        controls +
                    '</div>' +
                    '<div class="snap-widget-body">'+bodyHtml+'</div>' +
                '</div>';
            }
            function kpiHtml(v, sub, cls) {
                return '<div class="snap-kpi-value '+(cls||'snap-kpi-neutral')+'">'+v+'</div><div class="snap-kpi-sub">'+(sub||'')+'</div>';
            }
            function chartPlaceholder(id, h) {
                return '<div id="trd-chart-'+id+'" class="snap-chart-wrap" style="height:'+(h||220)+'px;"></div>';
            }
            function emptyState(msg) {
                return '<div class="snap-empty">'+(msg||'No trades match current filters.')+'</div>';
            }

            // ── Widget renderers ─────────────────────────────────
            var RENDERERS = {

                'pt-drawdown-context-insight': function(id, trades, m, sz) {
                    if (!trades.length) {
                        return widgetHtml(id, 'Drawdown Context',
                            '<div class="pt-insight-text">No trade data in the current view.</div>', sz);
                    }
                    if (m.maxDrawdown === 0) {
                        return widgetHtml(id, 'Drawdown Context',
                            '<div class="pt-insight-text">You are at peak equity in the current view. No drawdown to report.</div>', sz);
                    }
                    var curr = m.currentDrawdown;
                    var max  = m.maxDrawdown;
                    var text = '';
                    if (curr === 0) {
                        text = 'You are at peak equity. Your max drawdown this period was ' + fmt$(max) + ', and you have fully recovered.';
                    } else {
                        var recoveryPct = max !== 0 ? ((max - curr) / max * 100) : 0;
                        text = 'Current drawdown from peak: ' + fmt$(curr) + '. ' +
                               'Your max drawdown this period was ' + fmt$(max) + '. ';
                        if (recoveryPct <= 20) {
                            text += 'Drawdown remains elevated. Recovery is still in early stages.';
                        } else if (recoveryPct <= 60) {
                            text += 'You are partially recovered \u2014 roughly ' + Math.round(recoveryPct) + '% of the way back.';
                        } else {
                            text += 'Recovery is well underway \u2014 roughly ' + Math.round(recoveryPct) + '% of the way back to peak.';
                        }
                    }
                    return widgetHtml(id, 'Drawdown Context',
                        '<div class="pt-insight-text">' + text + '</div>', sz);
                },

                'equity-curve': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id, sz==='large'?280:220) : emptyState();
                    return widgetHtml(id, 'Equity Curve', body, sz, 'equity-curve');
                },
                'daily-pnl': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Daily P&L Trend', body, sz, 'daily-pnl');
                },
                'drawdown-curve': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Drawdown Curve', body, sz, 'drawdown-curve');
                },
                'weekly-pnl': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Weekly P&L Trend', body, sz, 'weekly-pnl');
                },
                'monthly-pnl': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Monthly P&L Trend', body, sz, 'monthly-pnl');
                },
                'trade-count': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Trade Count Trend', body, sz, 'trade-count');
                },
                'win-rate-trend': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Win Rate Trend', body, sz, 'win-rate-trend');
                },
                'avg-pnl-trend': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Avg Trade P&L Trend', body, sz, 'avg-pnl-trend');
                },
                'red-day-rate': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Red Day Rate Trend', body, sz, 'red-day-rate');
                },
                'pnl-distribution': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'P&L Distribution', body, sz, 'pnl-distribution');
                },
                'green-red-days': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Green vs Red Days', body, sz, 'green-red-days');
                },
                'dow-trend': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Day-of-Week Trend', body, sz, 'dow-trend');
                },
                'time-of-day': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Time-of-Day Trend', body, sz, 'time-of-day');
                },
                'largest-loss-trend': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Largest Loss by Period', body, sz, 'largest-loss-trend');
                },
                'avg-loss-trend': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Avg Loss Trend', body, sz, 'avg-loss-trend');
                },
                'top-setups-trend': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id, sz==='large'?280:220) : emptyState();
                    return widgetHtml(id, 'Top Strategies Over Time', body, sz, 'top-setups-trend');
                },
                'setup-contrib': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Strategy Contribution', body, sz, 'setup-contrib');
                },
                'month-of-year': function(id, trades, m, sz) {
                    var body = trades.length ? chartPlaceholder(id) : emptyState();
                    return widgetHtml(id, 'Month-of-Year Trend', body, sz, 'month-of-year');
                },
                'kpi-net-pnl': function(id, trades, m, sz) {
                    var sign = m.totalPnl >= 0 ? '+' : '';
                    return widgetHtml(id, 'Net P&L', kpiHtml(sign+fmt$(m.totalPnl), m.count+' trades', pnlColor(m.totalPnl)), sz, 'kpi-net-pnl');
                },
                'kpi-win-rate': function(id, trades, m, sz) {
                    var cls = m.winRate >= 50 ? 'snap-kpi-positive' : m.count > 0 ? 'snap-kpi-negative' : 'snap-kpi-neutral';
                    return widgetHtml(id, 'Win Rate', kpiHtml(fmtPct(m.winRate), m.wins+'W / '+m.losses+'L', cls), sz, 'kpi-win-rate');
                },
                'kpi-profit-factor': function(id, trades, m, sz) {
                    var pf = isFinite(m.profitFactor) ? m.profitFactor.toFixed(2) : '∞';
                    var cls = m.profitFactor >= 1.5 ? 'snap-kpi-positive' : m.profitFactor >= 1 ? 'snap-kpi-neutral' : 'snap-kpi-negative';
                    return widgetHtml(id, 'Profit Factor', kpiHtml(pf, 'gross wins ÷ gross losses', cls), sz, 'kpi-profit-factor');
                },
                'kpi-max-drawdown': function(id, trades, m, sz) {
                    return widgetHtml(id, 'Max Drawdown', kpiHtml(fmt$(m.maxDrawdown), 'peak-to-trough', m.maxDrawdown < 0 ? 'snap-kpi-negative' : 'snap-kpi-neutral'), sz, 'kpi-max-drawdown');
                },
                'kpi-expectancy': function(id, trades, m, sz) {
                    var sign = m.expectancy >= 0 ? '+' : '';
                    return widgetHtml(id, 'Trade Expectancy', kpiHtml(sign+fmt$(m.expectancy), m.count+' trades', pnlColor(m.expectancy)), sz, 'kpi-expectancy');
                },
                'kpi-avg-net-trade': function(id, trades, m, sz) {
                    var sign = m.avgNetTrade >= 0 ? '+' : '';
                    return widgetHtml(id, 'Avg Net Trade P&L', kpiHtml(sign+fmt$(m.avgNetTrade), m.count+' trades', pnlColor(m.avgNetTrade)), sz, 'kpi-avg-net-trade');
                },
                'kpi-avg-win': function(id, trades, m, sz) {
                    return widgetHtml(id, 'Avg Win', kpiHtml('+'+fmt$(m.avgWin), m.wins+' winners', m.wins > 0 ? 'snap-kpi-positive' : 'snap-kpi-neutral'), sz, 'kpi-avg-win');
                },
                'kpi-avg-loss': function(id, trades, m, sz) {
                    return widgetHtml(id, 'Avg Loss', kpiHtml('-'+fmt$(m.avgLoss), m.losses+' losers', m.losses > 0 ? 'snap-kpi-negative' : 'snap-kpi-neutral'), sz, 'kpi-avg-loss');
                },
                'kpi-logged-days': function(id, trades, m, sz) {
                    return widgetHtml(id, 'Logged Days', kpiHtml(String(m.loggedDays), m.count+' trades', 'snap-kpi-neutral'), sz, 'kpi-logged-days');
                },
                'kpi-avg-daily-volume': function(id, trades, m, sz) {
                    return widgetHtml(id, 'Avg Daily Volume', kpiHtml(m.avgDailyVolume.toFixed(1), m.loggedDays+' days', 'snap-kpi-neutral'), sz, 'kpi-avg-daily-volume');
                },
                'kpi-avg-daily-pnl': function(id, trades, m, sz) {
                    var sign = m.avgDailyPnl >= 0 ? '+' : '';
                    return widgetHtml(id, 'Avg Daily Net P&L', kpiHtml(sign+fmt$(m.avgDailyPnl), m.loggedDays+' days', pnlColor(m.avgDailyPnl)), sz, 'kpi-avg-daily-pnl');
                },
                'kpi-avg-trade-wl': function(id, trades, m, sz) {
                    var v = isFinite(m.avgTradeWL) ? m.avgTradeWL.toFixed(2) : '\u221E';
                    var cls = m.avgTradeWL >= 1 ? 'snap-kpi-positive' : m.count > 0 ? 'snap-kpi-negative' : 'snap-kpi-neutral';
                    return widgetHtml(id, 'Avg Trade Win/Loss', kpiHtml(v, 'avg win \u00F7 avg loss', cls), sz, 'kpi-avg-trade-wl');
                },
                'kpi-avg-daily-wl': function(id, trades, m, sz) {
                    var v = isFinite(m.avgDailyWL) ? m.avgDailyWL.toFixed(2) : '\u221E';
                    var cls = m.avgDailyWL >= 1 ? 'snap-kpi-positive' : m.loggedDays > 0 ? 'snap-kpi-negative' : 'snap-kpi-neutral';
                    return widgetHtml(id, 'Avg Daily Win/Loss', kpiHtml(v, 'green days \u00F7 red days', cls), sz, 'kpi-avg-daily-wl');
                }
            };

            // ── Chart rendering ──────────────────────────────────
            function renderTrendCharts(trades, m, layout) {
                var tc = '#8b9aae', gc = 'rgba(255,255,255,0.07)';
                var GREEN = 'rgba(34,197,94,0.75)', RED = 'rgba(239,68,68,0.75)';
                var gb = _state.groupBy;

                // Always return fresh objects — Plotly mutates layout objects in-place
                // which would corrupt the shared reference across multiple chart renders.
                function mkAx(extra) {
                    return Object.assign(
                        { gridcolor:gc, tickfont:{size:10,color:tc}, linecolor:gc, zeroline:false, automargin:true },
                        extra || {}
                    );
                }
                function mkBase(extraMargin) {
                    return {
                        paper_bgcolor:'transparent', plot_bgcolor:'transparent',
                        margin: extraMargin || {t:10,r:10,b:36,l:52},
                        font:{family:'Inter,sans-serif',color:tc},
                        showlegend:false
                    };
                }

                // Purge + redraw each element to avoid Plotly carrying stale axis-type
                // state when the trace data changes type (e.g. date → category).
                function tryPlot(el, traces, layout2, config) {
                    try {
                        Plotly.purge(el);
                        Plotly.newPlot(el, traces, layout2, config || {responsive:true,displayModeBar:false});
                    } catch(e) {}
                }

                // Safe numeric pnl coercion
                function pnlOf(t) { return parseFloat(t.pnl) || 0; }

                // Parse a stored ISO timestamp — returns null if missing or invalid.
                // Does NOT fall back to epoch (0), which would produce fake 1969/1970 data.
                function parseDateSafe(iso) {
                    if (!iso) return null;
                    var d = new Date(iso);
                    return isNaN(d.getTime()) ? null : d;
                }

                layout.forEach(function(item) {
                    var el = document.getElementById('trd-chart-'+item.id);
                    if (!el) return;
                    var wid = item.wid;

                    // ── Equity Curve ─────────────────────────────
                    if (wid === 'equity-curve') {
                        var cum = calcCumSeries(trades);
                        if (!cum.length) return;
                        var xs = cum.map(function(p){return p.x;}), ys = cum.map(function(p){return p.y;});
                        var lc = ys[ys.length-1] >= 0 ? '#22c55e' : '#ef4444';
                        var fc = ys[ys.length-1] >= 0 ? 'rgba(34,197,94,0.10)' : 'rgba(239,68,68,0.10)';
                        var b = mkBase();
                        b.xaxis = mkAx({type:'date'});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:xs,y:ys,type:'scatter',mode:'lines',fill:'tozeroy',fillcolor:fc,line:{color:lc,width:2}}], b);
                    }

                    // ── Daily P&L ────────────────────────────────
                    if (wid === 'daily-pnl') {
                        var dayMap = {};
                        trades.forEach(function(t){ var d=getDateStr(t.exitTime||t.entryTime); if(d) dayMap[d]=(dayMap[d]||0)+pnlOf(t); });
                        var days = Object.keys(dayMap).sort();
                        if (!days.length) return;
                        var vals = days.map(function(d){return dayMap[d];});
                        var b = mkBase();
                        b.xaxis = mkAx({type:'date'});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:days,y:vals,type:'bar',marker:{color:vals.map(function(v){return v>=0?GREEN:RED;})}}], b);
                    }

                    // ── Drawdown Curve ───────────────────────────
                    if (wid === 'drawdown-curve') {
                        var sorted = trades.slice().sort(function(a,b){
                            return new Date(a.exitTime||a.entryTime||0) - new Date(b.exitTime||b.entryTime||0);
                        });
                        var ddCum = 0, ddPeak = 0, ddXs = [], ddYs = [];
                        sorted.forEach(function(t) {
                            var ds = getDateStr(t.exitTime||t.entryTime);
                            if (!ds) return;
                            ddCum += pnlOf(t);
                            ddPeak = Math.max(ddPeak, ddCum);
                            ddXs.push(ds);
                            ddYs.push(ddCum - ddPeak);
                        });
                        if (!ddXs.length) return;
                        var b = mkBase();
                        b.xaxis = mkAx({type:'date'});
                        b.yaxis = mkAx({tickprefix:'$'});
                        // Zero reference line so the recovery-to-zero level is always visible
                        b.shapes = [{type:'line',x0:ddXs[0],x1:ddXs[ddXs.length-1],xref:'x',
                                      y0:0,y1:0,yref:'y',line:{color:'rgba(255,255,255,0.15)',width:1,dash:'dot'}}];
                        tryPlot(el, [{x:ddXs,y:ddYs,type:'scatter',mode:'lines',fill:'tozeroy',
                                      fillcolor:'rgba(239,68,68,0.12)',line:{color:'#ef4444',width:2}}], b);
                    }

                    // ── Weekly P&L ───────────────────────────────
                    if (wid === 'weekly-pnl') {
                        var wkMap = {};
                        trades.forEach(function(t){ var k=getPeriodKey(t.exitTime||t.entryTime,'week'); if(k) wkMap[k]=(wkMap[k]||0)+pnlOf(t); });
                        var wks = Object.keys(wkMap).sort();
                        if (!wks.length) return;
                        var wkv = wks.map(function(k){return wkMap[k];});
                        // Format "2026-01-04" (a Sunday) → "Jan 4" (add year suffix only when data spans multiple years)
                        var WK_MO = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                        var wkYrSet = {}; wks.forEach(function(k){ wkYrSet[k.slice(0,4)] = 1; });
                        var wkMultiYr = Object.keys(wkYrSet).length > 1;
                        var wkLabels = wks.map(function(k){
                            var p = k.split('-');
                            var s = WK_MO[parseInt(p[1],10)-1] + ' ' + parseInt(p[2],10);
                            return wkMultiYr ? s + " '" + p[0].slice(2) : s;
                        });
                        // Show at most ~12 tick labels so the axis stays uncluttered
                        var wkStep = Math.max(1, Math.ceil(wkLabels.length / 12));
                        var wkTicks = wkLabels.filter(function(_, i){ return i % wkStep === 0; });
                        var b = mkBase({t:10,r:10,b:58,l:52});
                        b.xaxis = mkAx({type:'category', tickangle:-45, tickmode:'array', tickvals:wkTicks, ticktext:wkTicks});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:wkLabels,y:wkv,type:'bar',marker:{color:wkv.map(function(v){return v>=0?GREEN:RED;})}}], b);
                    }

                    // ── Monthly P&L ──────────────────────────────
                    if (wid === 'monthly-pnl') {
                        var moMap = {};
                        trades.forEach(function(t){ var k=getPeriodKey(t.exitTime||t.entryTime,'month'); if(k) moMap[k]=(moMap[k]||0)+pnlOf(t); });
                        var mos = Object.keys(moMap).sort();
                        if (!mos.length) return;
                        var mov = mos.map(function(k){return moMap[k];});
                        // Format "YYYY-MM" → "Jan '26" for readability
                        var MO_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                        var moLabels = mos.map(function(k){
                            var p = k.split('-');
                            return MO_ABBR[parseInt(p[1],10)-1] + " '" + p[0].slice(2);
                        });
                        // Thin tick labels when many months are present
                        var moStep = Math.max(1, Math.ceil(moLabels.length / 14));
                        var moTicks = moLabels.filter(function(_, i){ return i % moStep === 0; });
                        var b = mkBase({t:10,r:10,b:50,l:52});
                        b.xaxis = mkAx({type:'category', tickangle:-30, tickmode:'array', tickvals:moTicks, ticktext:moTicks});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:moLabels,y:mov,type:'bar',marker:{color:mov.map(function(v){return v>=0?GREEN:RED;})}}], b);
                    }

                    // ── Trade Count Trend ────────────────────────
                    if (wid === 'trade-count') {
                        var pm = buildPeriodMap(trades, gb);
                        if (!pm.length) return;
                        var pks = pm.map(function(p){return p.key;}), pct = pm.map(function(p){return p.count;});
                        var b = mkBase();
                        b.xaxis = mkAx({type:'category', tickangle:-45, nticks:12});
                        b.yaxis = mkAx();
                        tryPlot(el, [{x:pks,y:pct,type:'bar',marker:{color:'rgba(96,165,250,0.7)'}}], b);
                    }

                    // ── Win Rate Trend ────────────────────────────
                    if (wid === 'win-rate-trend') {
                        // Require ≥3 trades per period to suppress single-trade 0%/100% noise
                        var pm2 = buildPeriodMap(trades, gb).filter(function(p){return p.count >= 3;});
                        if (!pm2.length) return;
                        var wr_x = pm2.map(function(p){return p.key;});
                        var wr_y = pm2.map(function(p){return p.wins/p.count*100;});
                        var b = mkBase();
                        // 50% reference line drawn as a layout shape (works with bar chart)
                        b.shapes = [{type:'line',x0:0,x1:1,xref:'paper',y0:50,y1:50,yref:'y',
                                      line:{color:'rgba(255,255,255,0.2)',width:1,dash:'dot'}}];
                        b.xaxis = mkAx({type:'category', tickangle:-45, nticks:12});
                        b.yaxis = mkAx({ticksuffix:'%', range:[0,100]});
                        tryPlot(el, [{x:wr_x, y:wr_y, type:'bar',
                            marker:{color:wr_y.map(function(v){return v>=50?GREEN:RED;})}}], b);
                    }

                    // ── Avg P&L Trend ─────────────────────────────
                    if (wid === 'avg-pnl-trend') {
                        var pm3 = buildPeriodMap(trades, gb).filter(function(p){return p.count>=1;});
                        if (!pm3.length) return;
                        var ap_x = pm3.map(function(p){return p.key;});
                        var ap_y = pm3.map(function(p){return p.pnl/p.count;});
                        var b = mkBase();
                        b.xaxis = mkAx({type:'category', tickangle:-45, nticks:12});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:ap_x,y:ap_y,type:'bar',marker:{color:ap_y.map(function(v){return v>=0?GREEN:RED;})}}], b);
                    }

                    // ── Red Day Rate ──────────────────────────────
                    if (wid === 'red-day-rate') {
                        var dayMap2 = {};
                        trades.forEach(function(t){ var d=getDateStr(t.exitTime||t.entryTime); if(d) dayMap2[d]=(dayMap2[d]||0)+pnlOf(t); });
                        var prdMap = {};
                        Object.keys(dayMap2).forEach(function(d) {
                            var k = getPeriodKey(d, gb==='day'?'week':gb);
                            if (!prdMap[k]) prdMap[k] = {red:0, total:0};
                            prdMap[k].total++;
                            if (dayMap2[d] < 0) prdMap[k].red++;
                        });
                        var rk = Object.keys(prdMap).sort();
                        if (!rk.length) return;
                        var rv = rk.map(function(k){ return prdMap[k].total ? prdMap[k].red/prdMap[k].total*100 : 0; });
                        // Traffic-light coloring: ≤33% red days = good, >66% = bad
                        var rdColors = rv.map(function(v){ return v<=33 ? GREEN : v<=66 ? 'rgba(251,146,60,0.75)' : RED; });
                        var b = mkBase({t:10,r:10,b:58,l:52});
                        b.shapes = [{type:'line',x0:0,x1:1,xref:'paper',y0:50,y1:50,yref:'y',
                                      line:{color:'rgba(255,255,255,0.2)',width:1,dash:'dot'}}];
                        b.xaxis = mkAx({type:'category', tickangle:-45, nticks:10});
                        b.yaxis = mkAx({ticksuffix:'%', range:[0,100]});
                        tryPlot(el, [{x:rk, y:rv, type:'bar', marker:{color:rdColors}}], b);
                    }

                    // ── P&L Distribution ─────────────────────────
                    if (wid === 'pnl-distribution') {
                        if (!trades.length) return;
                        // Short unambiguous labels — no \n (Plotly ignores newlines in tick text)
                        var buckets = [
                            {label:'<-$500',      min:-1e9, max:-500},
                            {label:'-$500~-$200',  min:-500, max:-200},
                            {label:'-$200~-$50',   min:-200, max:-50 },
                            {label:'-$50~$0',      min:-50,  max:0   },
                            {label:'$0~$50',       min:0,    max:50  },
                            {label:'$50~$200',     min:50,   max:200 },
                            {label:'$200~$500',    min:200,  max:500 },
                            {label:'>$500',        min:500,  max:1e9 }
                        ];
                        var labels = buckets.map(function(b){return b.label;});
                        var counts = buckets.map(function(b){
                            return trades.filter(function(t){ var p=pnlOf(t); return p>=b.min && p<b.max; }).length;
                        });
                        var colors = buckets.map(function(b){ return b.min >= 0 ? GREEN : RED; });
                        var b = mkBase({t:10,r:10,b:48,l:40});
                        b.xaxis = mkAx({type:'category', tickfont:{size:9,color:tc}});
                        b.yaxis = mkAx();
                        tryPlot(el, [{x:labels,y:counts,type:'bar',marker:{color:colors}}], b);
                    }

                    // ── Green vs Red Days ─────────────────────────
                    if (wid === 'green-red-days') {
                        var dayMap3 = {};
                        trades.forEach(function(t){ var d=getDateStr(t.exitTime||t.entryTime); if(d) dayMap3[d]=(dayMap3[d]||0)+pnlOf(t); });
                        var prdData = {};
                        Object.keys(dayMap3).forEach(function(d) {
                            var k = getPeriodKey(d, gb==='day'?'week':gb);
                            if (!prdData[k]) prdData[k] = {green:0, red:0};
                            if (dayMap3[d] >= 0) prdData[k].green++;
                            else prdData[k].red++;
                        });
                        var gk = Object.keys(prdData).sort();
                        if (!gk.length) return;
                        var b = mkBase();
                        b.showlegend = true;
                        b.legend = {orientation:'h',y:1.05,x:0,font:{size:10,color:tc}};
                        b.barmode = 'group';
                        b.xaxis = mkAx({type:'category'});
                        b.yaxis = mkAx();
                        tryPlot(el, [
                            {x:gk, y:gk.map(function(k){return prdData[k].green;}), name:'Green', type:'bar', marker:{color:GREEN}},
                            {x:gk, y:gk.map(function(k){return prdData[k].red;}),   name:'Red',   type:'bar', marker:{color:RED}}
                        ], b);
                    }

                    // ── Day of Week ───────────────────────────────
                    if (wid === 'dow-trend') {
                        var DOW_LABELS = ['Mon','Tue','Wed','Thu','Fri'];
                        var dowPnl = [0,0,0,0,0];
                        trades.forEach(function(t) {
                            var d = parseDateSafe(t.exitTime||t.entryTime);
                            if (!d) return;  // skip trades with no valid date — no epoch fallback
                            var dow = d.getDay(); // 0=Sun…6=Sat (local time)
                            if (dow >= 1 && dow <= 5) dowPnl[dow-1] += pnlOf(t);
                        });
                        var b = mkBase();
                        b.xaxis = mkAx({type:'category'});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:DOW_LABELS, y:dowPnl, type:'bar', marker:{color:dowPnl.map(function(v){return v>=0?GREEN:RED;})}}], b);
                    }

                    // ── Time of Day ───────────────────────────────
                    if (wid === 'time-of-day') {
                        var sessions = [
                            {label:'Pre-Mkt',   h0:0,    h1:9.5 },
                            {label:'Open',      h0:9.5,  h1:10.5},
                            {label:'Mid-Morn',  h0:10.5, h1:12  },
                            {label:'Midday',    h0:12,   h1:14  },
                            {label:'Afternoon', h0:14,   h1:16  },
                            {label:'After-Hrs', h0:16,   h1:24  }
                        ];
                        var sessPnl = sessions.map(function(){return 0;});
                        trades.forEach(function(t) {
                            var d = parseDateSafe(t.entryTime||t.exitTime);
                            if (!d) return;  // skip trades with no valid timestamp
                            var hr = d.getHours() + d.getMinutes()/60;
                            var idx = sessions.findIndex(function(s){return hr>=s.h0 && hr<s.h1;});
                            if (idx !== -1) sessPnl[idx] += pnlOf(t);
                        });
                        var sl = sessions.map(function(s){return s.label;});
                        var b = mkBase();
                        b.xaxis = mkAx({type:'category'});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:sl, y:sessPnl, type:'bar', marker:{color:sessPnl.map(function(v){return v>=0?GREEN:RED;})}}], b);
                    }

                    // ── Largest Loss by Period ────────────────────
                    if (wid === 'largest-loss-trend') {
                        var pm4 = buildPeriodMap(trades, gb);
                        if (!pm4.length) return;
                        var ll_x = pm4.map(function(p){return p.key;});
                        var ll_y = pm4.map(function(p){
                            var losses = p.trades.map(pnlOf).filter(function(v){return v<0;});
                            return losses.length ? Math.min.apply(null, losses) : 0;
                        });
                        var b = mkBase();
                        b.xaxis = mkAx({type:'category'});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:ll_x,y:ll_y,type:'bar',marker:{color:RED}}], b);
                    }

                    // ── Avg Loss Trend ────────────────────────────
                    if (wid === 'avg-loss-trend') {
                        var pm5 = buildPeriodMap(trades, gb);
                        if (!pm5.length) return;
                        var al_x = pm5.map(function(p){return p.key;});
                        var al_y = pm5.map(function(p){
                            var losses = p.trades.map(pnlOf).filter(function(v){return v<0;});
                            return losses.length ? losses.reduce(function(a,b){return a+b;},0)/losses.length : 0;
                        });
                        var b = mkBase();
                        b.xaxis = mkAx({type:'category'});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:al_x,y:al_y,type:'scatter',mode:'lines+markers',line:{color:'#f97316',width:2},marker:{size:4,color:'#f97316'}}], b);
                    }

                    // ── Top Strategies Over Time ──────────────────────
                    if (wid === 'top-setups-trend') {
                        var stMap = {};
                        trades.forEach(function(t){
                            var s = t.setupType || 'No Strategy';
                            stMap[s] = (stMap[s]||0) + pnlOf(t);
                        });
                        var sn = Object.keys(stMap).sort(function(a,b){return stMap[b]-stMap[a];}).slice(0,8);
                        if (!sn.length) return;
                        var sv = sn.map(function(k){return stMap[k];});
                        var b = mkBase({t:10,r:10,b:36,l:100});
                        b.xaxis = mkAx({tickprefix:'$'});
                        b.yaxis = mkAx({type:'category', automargin:true});
                        tryPlot(el, [{x:sv,y:sn,type:'bar',orientation:'h',marker:{color:sv.map(function(v){return v>=0?GREEN:RED;})}}], b);
                    }

                    // ── Setup Contribution ────────────────────────
                    if (wid === 'setup-contrib') {
                        var scMap = {};
                        trades.forEach(function(t){ var s=t.setupType||'No Strategy'; scMap[s]=(scMap[s]||0)+pnlOf(t); });
                        var scn = Object.keys(scMap).sort(function(a,b){return Math.abs(scMap[b])-Math.abs(scMap[a]);}).slice(0,6);
                        if (!scn.length) return;
                        var scv = scn.map(function(k){return scMap[k];});
                        var b = mkBase({t:10,r:10,b:36,l:100});
                        b.xaxis = mkAx({tickprefix:'$'});
                        b.yaxis = mkAx({type:'category', automargin:true});
                        tryPlot(el, [{x:scv,y:scn,type:'bar',orientation:'h',marker:{color:scv.map(function(v){return v>=0?GREEN:RED;})}}], b);
                    }

                    // ── Month of Year ─────────────────────────────
                    if (wid === 'month-of-year') {
                        var MO_LABELS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                        var moPnl = new Array(12).fill(0);
                        trades.forEach(function(t) {
                            var d = parseDateSafe(t.exitTime||t.entryTime);
                            if (!d) return;
                            moPnl[d.getMonth()] += pnlOf(t);
                        });
                        var b = mkBase();
                        b.xaxis = mkAx({type:'category'});
                        b.yaxis = mkAx({tickprefix:'$'});
                        tryPlot(el, [{x:MO_LABELS,y:moPnl,type:'bar',marker:{color:moPnl.map(function(v){return v>=0?GREEN:RED;})}}], b);
                    }
                });
            }

            // ── Drag-and-drop ─────────────────────────────────────
            var _drag = { srcId: null, overId: null };

            function setupTrendDrag() {
                var grid = document.getElementById('trend-grid');
                if (!grid || grid._trendDragBound) return;
                grid._trendDragBound = true;

                grid.addEventListener('dragstart', function(e) {
                    if (!_state.editMode) { e.preventDefault(); return; }
                    if (e.target.tagName === 'BUTTON') { e.preventDefault(); return; }
                    var w = e.target.closest('[data-instance-id]');
                    if (!w) return;
                    _drag.srcId = w.dataset.instanceId; _drag.overId = null;
                    e.dataTransfer.effectAllowed = 'move';
                    e.dataTransfer.setData('text/plain', _drag.srcId);
                    setTimeout(function(){ w.classList.add('snap-dragging'); }, 0);
                });

                grid.addEventListener('dragend', function() {
                    _drag.srcId = null; _drag.overId = null;
                    grid.querySelectorAll('.snap-dragging,.snap-drag-over').forEach(function(el){
                        el.classList.remove('snap-dragging','snap-drag-over');
                    });
                });

                grid.addEventListener('dragover', function(e) {
                    if (!_state.editMode || !_drag.srcId) return;
                    e.preventDefault(); e.dataTransfer.dropEffect = 'move';
                    var w = e.target.closest('[data-instance-id]');
                    if (!w) return;
                    var oid = w.dataset.instanceId;
                    if (oid === _drag.overId) return;
                    grid.querySelectorAll('.snap-drag-over').forEach(function(el){el.classList.remove('snap-drag-over');});
                    _drag.overId = oid;
                    if (oid !== _drag.srcId) w.classList.add('snap-drag-over');
                });

                grid.addEventListener('drop', function(e) {
                    if (!_state.editMode || !_drag.srcId) return;
                    e.preventDefault();
                    var w = e.target.closest('[data-instance-id]');
                    if (!w) return;
                    var tid = w.dataset.instanceId;
                    if (!tid || tid === _drag.srcId) return;
                    var layout = _state.layout;
                    var si = layout.findIndex(function(x){return x.id===_drag.srcId;});
                    var ti = layout.findIndex(function(x){return x.id===tid;});
                    if (si<0||ti<0) return;
                    var moved = layout.splice(si,1)[0];
                    var nt = layout.findIndex(function(x){return x.id===tid;});
                    layout.splice(nt,0,moved);
                    _drag.srcId=null; _drag.overId=null;
                    saveLayout(); renderTrends();
                });
            }

            // ── Main render ──────────────────────────────────────
            function renderTrends() {
                Object.assign(_state, DenariiFilters.readState('trend'));

                var trades = getTrendTrades();
                var m      = calcSummaryMetrics(trades);
                var layout = _state.layout || PT_DEFAULT.map(function(w){return Object.assign({},w);});

                var grid = document.getElementById('trend-grid');
                if (!grid) return;
                grid.className = 'snap-grid'+(_state.editMode?' snap-edit-mode':'');
                grid.innerHTML = layout.map(function(item){
                    return RENDERERS[item.wid] ? RENDERERS[item.wid](item.id, trades, m, item.size||'small') : '';
                }).join('');

                setTimeout(function(){ renderTrendCharts(trades, m, layout); }, 60);
            }

            // ── Filter population ─────────────────────────────────
            function populateTrendFilters() {
                var stlSel   = document.getElementById('trend-style');
                var perSel   = document.getElementById('trend-period');
                var astSel   = document.getElementById('trend-asset-type');
                var stratSel = document.getElementById('trend-strategy');
                var symEl    = document.getElementById('trend-symbol');
                var fromEl   = document.getElementById('trend-from');
                var toEl     = document.getElementById('trend-to');
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

            // ── Picker ─────────────────────────────────────────────
            function trendRenderPicker() {
                var q    = (document.getElementById('trend-picker-q')||{}).value || '';
                var body = document.getElementById('trend-picker-body');
                if (!body) return;
                var activeWids = {};
                (_state.layout||[]).forEach(function(w){ activeWids[w.wid] = true; });
                var filtered = PT_LIB.filter(function(w){
                    return !q || w.name.toLowerCase().indexOf(q.toLowerCase())!==-1 ||
                                 w.desc.toLowerCase().indexOf(q.toLowerCase())!==-1;
                });
                if (!filtered.length) {
                    body.innerHTML = '<div class="snap-empty" style="padding-top:24px;">No widgets match.</div>'; return;
                }
                var cats=[], bycat={};
                filtered.forEach(function(w){ if(!bycat[w.cat]){bycat[w.cat]=[]; cats.push(w.cat);} bycat[w.cat].push(w); });
                body.innerHTML = cats.map(function(cat){
                    return '<div class="snap-picker-cat-label">'+cat+'</div>' +
                        bycat[cat].map(function(w){
                            var added = activeWids[w.wid];
                            return '<div class="snap-picker-item'+(added?' snap-picker-item--added':'')+'">' +
                                '<div class="snap-picker-item-info">' +
                                    '<div class="snap-picker-item-name">'+w.name+'</div>' +
                                    '<div class="snap-picker-item-desc">'+w.desc+'</div>' +
                                '</div>'+
                                (added
                                    ? '<span class="snap-picker-item-added">Added</span>'
                                    : '<button class="snap-picker-item-add" onclick="trendAddWidget(\''+w.wid+'\')">+ Add</button>') +
                            '</div>';
                        }).join('');
                }).join('');
            }

            // ── Persistence ────────────────────────────────────────
            function saveLayout() {
                journalData.perfTrendsLayout = JSON.parse(JSON.stringify(_state.layout));
                if (typeof saveToIndexedDB === 'function') saveToIndexedDB();
            }

            // ── Init ───────────────────────────────────────────────
            function initTrends() {
                _state.layout = journalData.perfTrendsLayout
                    ? JSON.parse(JSON.stringify(journalData.perfTrendsLayout))
                    : PT_DEFAULT.map(function(w){return Object.assign({},w);});
                populateTrendFilters();
                renderTrends();
                setupTrendDrag();
            }

            // ═══ Window-exposed API ════════════════════════════════

            window.setTrendGroupBy = function(gb, sel) {
                _state.groupBy = gb;
                var widget = sel && sel.closest('[data-instance-id]');
                var instanceId = widget && widget.dataset.instanceId;
                renderTrends();
                // The redraw replaces the dropdown, so keep keyboard focus on its new copy.
                var next = instanceId && document.querySelector('[data-instance-id="'+instanceId+'"] .trd-group-select');
                if (next) next.focus();
            };

            window.renderTrends = renderTrends;

            window.toggleTrendEdit = function() {
                _state.editMode = !_state.editMode;
                var banner = document.getElementById('trend-edit-banner');
                var btn    = document.getElementById('trend-edit-btn');
                if (banner) banner.style.display = _state.editMode ? 'flex' : 'none';
                if (btn)    btn.textContent = _state.editMode ? '✓ Done Editing' : 'Edit Layout';
                renderTrends();
            };

            window.trendResizeWidget = function(id, sz) {
                var item = (_state.layout||[]).find(function(w){return w.id===id;});
                if (item) { item.size=sz; saveLayout(); renderTrends(); }
            };

            window.trendRemoveWidget = function(id) {
                if (!_state.layout) return;
                _state.layout = _state.layout.filter(function(w){return w.id!==id;});
                saveLayout(); renderTrends();
            };

            window.trendResetLayout = function() {
                if (!confirm('Reset Performance Trends layout to default?')) return;
                _state.layout = PT_DEFAULT.map(function(w){return Object.assign({},w);});
                saveLayout(); renderTrends();
            };

            window.openTrendPicker = function() {
                trendRenderPicker();
                var o=document.getElementById('trend-picker-overlay'), p=document.getElementById('trend-picker-panel');
                if(o) o.classList.add('open');
                if(p) p.classList.add('open');
            };

            window.closeTrendPicker = function() {
                var o=document.getElementById('trend-picker-overlay'), p=document.getElementById('trend-picker-panel');
                if(o) o.classList.remove('open');
                if(p) p.classList.remove('open');
            };

            window.trendRenderPicker = trendRenderPicker;

            window.trendAddWidget = function(wid) {
                if (!_state.layout) _state.layout = [];
                var already = _state.layout.some(function(w){return w.wid===wid;});
                if (already) return;
                var def = PT_LIB.find(function(w){return w.wid===wid;});
                _state.layout.push({ id:'tu'+Date.now(), wid:wid, size: def?def.def:'medium' });
                saveLayout();
                window.closeTrendPicker();
                renderTrends();
            };

            window.showTrendHelp = function(helpId, btn) {
                var h = HELP[helpId];
                if (!h) return;
                var pop = document.getElementById('trend-help-popover');
                if (!pop) return;
                // Build content
                var html = '<div class="thp-close-row"><strong class="thp-title">'+h.title+'</strong><button class="thp-close-btn" onclick="hideTrendHelp()">✕</button></div>';
                if (h.what)  html += '<div class="thp-block"><span class="thp-label">What it shows</span><p class="thp-text">'+h.what+'</p></div>';
                if (h.why)   html += '<div class="thp-block"><span class="thp-label">Why it matters</span><p class="thp-text">'+h.why+'</p></div>';
                if (h.how)   html += '<div class="thp-block"><span class="thp-label">How to use it</span><p class="thp-text">'+h.how+'</p></div>';
                if (h.watch) html += '<div class="thp-block"><span class="thp-label">Watch out for</span><p class="thp-text">'+h.watch+'</p></div>';
                pop.innerHTML = html;
                // Position
                var rect = btn.getBoundingClientRect();
                var pw = 290, ph = 40;
                var left = Math.min(rect.right + 8, window.innerWidth - pw - 12);
                if (left < 12) left = rect.left - pw - 8;
                if (left < 12) left = 12;
                var top  = Math.max(rect.top - ph, 12);
                if (top + 300 > window.innerHeight) top = Math.max(window.innerHeight - 310, 12);
                pop.style.left = left + 'px';
                pop.style.top  = top  + 'px';
                pop.style.display = 'block';
                // Close on outside click
                setTimeout(function() {
                    document.addEventListener('click', _hideTrendHelpOutside, { once: true, capture: true });
                }, 30);
            };

            function _hideTrendHelpOutside(e) {
                var pop = document.getElementById('trend-help-popover');
                if (pop && !pop.contains(e.target)) pop.style.display = 'none';
            }

            window.hideTrendHelp = function() {
                var pop = document.getElementById('trend-help-popover');
                if (pop) pop.style.display = 'none';
            };

            window._trendInit = initTrends;

            // Mounted once at load. Fill Style here too: the app's first
            // _populateStyleSelects() may already have run.
            DenariiFilters.mountFilterBar(document.getElementById('trend-filter-bar'), {
                prefix: 'trend',
                onChange: renderTrends
            });
            if (typeof _populateStyleSelect === 'function') _populateStyleSelect('trend-style', true);

        })();
