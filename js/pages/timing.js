// ═══════════════════════════════════════════════════════════════════════
// TIMING PAGE
// ═══════════════════════════════════════════════════════════════════════
(function() {
    'use strict';

    // ── State ──────────────────────────────────────────────────────────
    var _state = {
        period: 'all', from: '', to: '',
        style: 'all', assetType: 'all', strategy: 'all', symbol: '',
        metric: 'net-pnl', sessionView: 'buckets', minSample: 1,
        editMode: false, layout: null
    };

    // ── Session bucket model ───────────────────────────────────────────
    var SESSIONS = [
        { label: 'Pre-Market',  h0: 0,    h1: 9.5  },
        { label: 'Open',        h0: 9.5,  h1: 10.5 },
        { label: 'Mid-Morning', h0: 10.5, h1: 12   },
        { label: 'Lunch',       h0: 12,   h1: 14   },
        { label: 'Afternoon',   h0: 14,   h1: 16   },
        { label: 'After-Hours', h0: 16,   h1: 24   }
    ];
    var DOW_LABELS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

    // ── Default layout ─────────────────────────────────────────────────
    var TM_DEFAULT = [
        { id: 'tm17', wid: 'tm-session-recommendation', size: 'large' },
        { id: 'tm1',  wid: 'best-dow',          size: 'small'  },
        { id: 'tm2',  wid: 'worst-dow',          size: 'small'  },
        { id: 'tm3',  wid: 'best-tod',           size: 'small'  },
        { id: 'tm4',  wid: 'worst-tod',          size: 'small'  },
        { id: 'tm5',  wid: 'dow-performance',    size: 'medium' },
        { id: 'tm6',  wid: 'tod-performance',    size: 'medium' },
        { id: 'tm7',  wid: 'win-rate-dow',       size: 'medium' },
        { id: 'tm8',  wid: 'win-rate-tod',       size: 'medium' },
        { id: 'tm9',  wid: 'trade-count-dow',    size: 'medium' },
        { id: 'tm10', wid: 'trade-count-tod',    size: 'medium' },
        { id: 'tm11', wid: 'morning-vs-afternoon', size: 'medium' },
        { id: 'tm12', wid: 'open-vs-rest',       size: 'medium' },
        { id: 'tm13', wid: 'dow-leaderboard',    size: 'medium' },
        { id: 'tm14', wid: 'tod-leaderboard',    size: 'medium' },
        { id: 'tm15', wid: 'timing-perf-time',   size: 'large'  },
        { id: 'tm16', wid: 'hold-time-analysis', size: 'large'  }
    ];

    // ── Widget library ─────────────────────────────────────────────────
    var TM_LIB = [
        // Insight
        { wid: 'tm-session-recommendation', name: 'Session Recommendation', desc: 'Plain-language timing recommendation based on session performance', cat: 'Insight', def: 'large' },
        // Summary
        { wid: 'best-dow',           name: 'Best Day of Week',         desc: 'Strongest weekday by selected metric',                    cat: 'Summary',     def: 'small'  },
        { wid: 'worst-dow',          name: 'Worst Day of Week',        desc: 'Weakest weekday by selected metric',                      cat: 'Summary',     def: 'small'  },
        { wid: 'best-tod',           name: 'Best Time of Day',         desc: 'Strongest session bucket by selected metric',             cat: 'Summary',     def: 'small'  },
        { wid: 'worst-tod',          name: 'Worst Time of Day',        desc: 'Weakest session bucket by selected metric',               cat: 'Summary',     def: 'small'  },
        { wid: 'best-session-window',name: 'Best Session Window',      desc: 'Strongest broader session window overall',                cat: 'Summary',     def: 'small'  },
        { wid: 'timing-coverage',    name: 'Timing Coverage',          desc: 'Number of unique day/time buckets in current view',       cat: 'Summary',     def: 'small'  },
        // Day of Week
        { wid: 'dow-performance',    name: 'Day-of-Week Performance',  desc: 'Selected metric by weekday',                              cat: 'Day of Week', def: 'medium' },
        { wid: 'dow-leaderboard',    name: 'Day-of-Week Leaderboard',  desc: 'Weekdays ranked by selected metric with trade count',     cat: 'Day of Week', def: 'medium' },
        { wid: 'win-rate-dow',       name: 'Win Rate by Day of Week',  desc: 'Win percentage for each weekday',                         cat: 'Day of Week', def: 'medium' },
        { wid: 'trade-count-dow',    name: 'Trade Count by Day',       desc: 'Number of trades taken on each weekday',                  cat: 'Day of Week', def: 'medium' },
        { wid: 'expectancy-dow',     name: 'Expectancy by Day',        desc: 'Expected value per trade for each weekday',               cat: 'Day of Week', def: 'medium' },
        // Time of Day
        { wid: 'tod-performance',    name: 'Time-of-Day Performance',  desc: 'Selected metric by session bucket or hour',               cat: 'Time of Day', def: 'medium' },
        { wid: 'tod-leaderboard',    name: 'Time-of-Day Leaderboard',  desc: 'Session buckets ranked by selected metric',               cat: 'Time of Day', def: 'medium' },
        { wid: 'win-rate-tod',       name: 'Win Rate by Time of Day',  desc: 'Win percentage for each session bucket',                  cat: 'Time of Day', def: 'medium' },
        { wid: 'trade-count-tod',    name: 'Trade Count by Time',      desc: 'Number of trades taken in each session window',           cat: 'Time of Day', def: 'medium' },
        { wid: 'expectancy-tod',     name: 'Expectancy by Time',       desc: 'Expected value per trade for each session window',        cat: 'Time of Day', def: 'medium' },
        { wid: 'avg-pnl-tod',        name: 'Avg Trade P&L by Time',    desc: 'Average profit or loss per trade per session window',     cat: 'Time of Day', def: 'medium' },
        // Comparisons
        { wid: 'morning-vs-afternoon', name: 'Morning vs Afternoon',   desc: 'Compare first half vs second half of the trading day',    cat: 'Comparisons', def: 'medium' },
        { wid: 'open-vs-rest',       name: 'Open vs Rest of Day',      desc: 'Compare opening session against later periods',           cat: 'Comparisons', def: 'medium' },
        { wid: 'early-vs-late',      name: 'Early vs Late Session',    desc: 'First two buckets vs final two buckets of the day',       cat: 'Comparisons', def: 'medium' },
        // Trend / Pattern
        { wid: 'timing-perf-time',   name: 'Timing Performance Over Time', desc: 'How session buckets perform month by month',          cat: 'Trends',      def: 'large'  },
        { wid: 'session-mix-time',   name: 'Session Mix Over Time',    desc: 'Trade count distribution across session buckets over time', cat: 'Trends',    def: 'large'  },
        // Risk / Leaks
        { wid: 'worst-session-leak', name: 'Worst Session Leak',       desc: 'The session window causing the most damage',              cat: 'Risk',        def: 'small'  },
        { wid: 'largest-loss-tod',   name: 'Largest Loss by Time',     desc: 'Biggest single losing trade per session window',          cat: 'Risk',        def: 'medium' },
        { wid: 'red-rate-dow',       name: 'Red Trade Rate by Day',    desc: 'Percentage of losing trades per weekday',                 cat: 'Risk',        def: 'medium' },
        { wid: 'red-rate-tod',       name: 'Red Trade Rate by Time',   desc: 'Percentage of losing trades per session window',          cat: 'Risk',        def: 'medium' },
        // Hold Time
        { wid: 'hold-time-analysis', name: 'Hold Time Analysis',       desc: 'P&L, win rate, and avg P&L broken down by trade hold duration', cat: 'Hold Time', def: 'large' }
    ];

    // ── Help content ────────────────────────────────────────────────────
    var HELP = {
        'best-dow': {
            title: 'Best Day of Week',
            what:  'The weekday where your selected metric is strongest in the current filtered view.',
            why:   'Knowing your best day helps you understand where your edge concentrates and which sessions tend to go well.',
            how:   'Use this alongside trade count. A great result on 2 trades on a Thursday is not the same as a great result on 40 trades.',
            watch: 'Small samples can make any day look exceptional. Check trade count before drawing conclusions.'
        },
        'worst-dow': {
            title: 'Worst Day of Week',
            what:  'The weekday where your selected metric is weakest in the current filtered view.',
            why:   'Your worst day is often where process breaks down, not just where markets were difficult.',
            how:   'Review whether the problem is consistent behavior on that day — poor setups, late entries, revenge trading — or just a few big outliers.',
            watch: 'One bad day with a large loss can skew the entire weekday ranking. Look at trade count and frequency.'
        },
        'best-tod': {
            title: 'Best Time of Day',
            what:  'The session window where your selected metric is strongest.',
            why:   'This shows where your edge may be sharpest and where you may deserve more aggression.',
            how:   'Compare this with trade count. If your best session has very few trades, consider whether you are underusing that window.',
            watch: 'Session results can shift significantly as market conditions change. Check across multiple time frames.'
        },
        'worst-tod': {
            title: 'Worst Time of Day',
            what:  'The session window where your selected metric is weakest.',
            why:   'This is often where fatigue, FOMO, or poor discipline show up in the data.',
            how:   'Decide whether to reduce size, reduce activity, or avoid that window altogether based on how consistently bad the results are.',
            watch: 'A high trade count in a bad session is a warning sign worth investigating.'
        },
        'dow-performance': {
            title: 'Day-of-Week Performance',
            what:  'Your selected metric charted for each weekday.',
            why:   'This gives a clear picture of where your results are concentrating across the trading week.',
            how:   'Use the Metric control at the top to switch between Net P&L, Win Rate, Expectancy, and more.',
            watch: 'A single large trade can dominate a weekday\'s result. Always check trade count in context.'
        },
        'tod-performance': {
            title: 'Time-of-Day Performance',
            what:  'Your selected metric charted for each session window or hour of the trading day.',
            why:   'This reveals whether your edge is concentrated at specific times, or spread more evenly.',
            how:   'Switch between Standard Buckets and Hourly view using the Session View control to zoom in or out.',
            watch: 'Hourly view can look noisy with small data sets. Standard Buckets is often the cleaner starting point.'
        },
        'win-rate-dow': {
            title: 'Win Rate by Day of Week',
            what:  'What percentage of your trades were winners on each weekday.',
            why:   'Win rate by day can reveal whether certain days produce better setups or more disciplined execution.',
            how:   'Pair this with average trade P&L. A high win rate on a day with small average winners is not necessarily better than a lower win rate with larger average winners.',
            watch: 'Win rate alone does not tell you if a session is actually profitable.'
        },
        'win-rate-tod': {
            title: 'Win Rate by Time of Day',
            what:  'What percentage of your trades were winners in each session window.',
            why:   'This helps isolate whether certain parts of the day produce more reliable outcomes.',
            how:   'Use this with session P&L to see whether higher win rates actually translate to better profitability.',
            watch: 'High win rate windows with small average wins may still underperform lower win rate windows with larger average wins.'
        },
        'trade-count-dow': {
            title: 'Trade Count by Day of Week',
            what:  'How many trades you took on each weekday in the current filtered view.',
            why:   'Activity distribution by day gives context to every other weekday metric.',
            how:   'Use this to understand whether high or low counts are driving results. Heavy days with poor returns are a signal worth reviewing.',
            watch: 'A day with very few trades may look exceptional simply because the sample is small.'
        },
        'trade-count-tod': {
            title: 'Trade Count by Time of Day',
            what:  'How many trades you took in each session window.',
            why:   'This shows where you are most active and gives context to performance metrics by session.',
            how:   'Compare activity level with results. A busy session with poor results is often a sign of overtrading or low-quality entry timing.',
            watch: 'High activity in a weak session window is often a behavioral flag worth investigating.'
        },
        'morning-vs-afternoon': {
            title: 'Morning vs Afternoon',
            what:  'A direct comparison of your results in the morning session (Pre-Market through Mid-Morning) versus the afternoon (Lunch through Close).',
            why:   'Many traders perform very differently in the morning vs the afternoon. Knowing which half of the day serves you better is actionable.',
            how:   'If one half is clearly stronger, consider whether reducing afternoon activity or shifting focus could improve overall results.',
            watch: 'Make sure sample sizes on both sides are large enough before making structural changes to your schedule.'
        },
        'open-vs-rest': {
            title: 'Open vs Rest of Day',
            what:  'A direct comparison of your results during the Open session (9:30–10:30) versus everything that follows.',
            why:   'The open is often the most volatile and highest-opportunity window of the day. Knowing whether you perform well there is critical.',
            how:   'If the Open is consistently your strongest window, consider sizing strategy. If it is your weakest, review whether open trades are a source of leakage.',
            watch: 'The Open tends to have fewer total trades but higher variance. Check both metrics carefully.'
        },
        'dow-leaderboard': {
            title: 'Day-of-Week Leaderboard',
            what:  'All weekdays ranked by your selected metric, with trade count shown alongside.',
            why:   'This lets you compare weekdays quickly and see where your best and worst patterns live.',
            how:   'Use the Metric control to switch what the ranking is based on. Always read trade count next to every rank.',
            watch: 'A top-ranked day with very few trades is not proven yet.'
        },
        'tod-leaderboard': {
            title: 'Time-of-Day Leaderboard',
            what:  'All session windows ranked by your selected metric, with trade count shown alongside.',
            why:   'This gives a direct view of which parts of the day are working hardest for you and which are the weakest links.',
            how:   'Use the Metric control to switch ranking method. Check trade count next to each rank before acting on the data.',
            watch: 'Sessions with very few trades can rank artificially high or low.'
        },
        'timing-perf-time': {
            title: 'Timing Performance Over Time',
            what:  'How your key session windows have performed month by month.',
            why:   'This helps you see whether your timing patterns are stable, improving, or shifting over time.',
            how:   'Look for sessions that were consistently strong or weak across multiple months. One exceptional month does not establish a pattern.',
            watch: 'Too many sessions on one chart creates noise. The chart focuses on the most active buckets.'
        },
        'hold-time-analysis': {
            title: 'Hold Time Analysis',
            what:  'Your P&L, win rate, and average P&L broken down by how long you held each trade.',
            why:   'Hold time reveals whether you are cutting winners too early, holding losers too long, or performing best in a specific duration range.',
            how:   'Focus on the green-highlighted rows — these are hold time buckets where you have a win rate of 60%+ and positive P&L. Build your playbook around those durations.',
            watch: 'Buckets with very few trades may look exceptional but are not yet reliable. Check trade count before acting on small samples.'
        },
    };

    // ── Utilities ──────────────────────────────────────────────────────
    function fmt$(n) {
        if (n == null || isNaN(n)) return '—';
        var abs = Math.abs(n);
        var s = abs >= 1000 ? '$' + Math.round(abs).toLocaleString() : '$' + abs.toFixed(2);
        return (n < 0 ? '-' : '') + s;
    }
    function fmtPct(n) { return (n == null || isNaN(n)) ? '—' : n.toFixed(1) + '%'; }
    function pnlCls(n) {
        if (!n || n === 0) return 'snap-kpi-neutral';
        return n > 0 ? 'snap-kpi-positive' : 'snap-kpi-negative';
    }
    function tmCls(n) {
        if (!n || n === 0) return 'tm-neu';
        return n > 0 ? 'tm-pos' : 'tm-neg';
    }
    function esc(s) {
        return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }
    function parseDateSafe(iso) {
        if (!iso) return null;
        var d = new Date(iso);
        return isNaN(d.getTime()) ? null : d;
    }
    function pnlOf(t) { return parseFloat(t.pnl) || 0; }

    // ── Trade filter ───────────────────────────────────────────────────
    function getTimingTrades() {
        return DenariiFilters.filterTrades(getSelectedAccountTrades(journalData.trades), _state, journalData.brokerAccounts, new Date());
    }

    // ── Session bucketing ──────────────────────────────────────────────
    function getSessionLabel(d) {
        if (!d) return null;
        var hr = d.getHours() + d.getMinutes()/60;
        if (_state.sessionView === 'hourly') {
            var h = d.getHours();
            var suffix = h < 12 ? 'am' : 'pm';
            var h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
            return h12 + suffix;
        }
        for (var i = 0; i < SESSIONS.length; i++) {
            if (hr >= SESSIONS[i].h0 && hr < SESSIONS[i].h1) return SESSIONS[i].label;
        }
        return null;
    }

    function getSessionOrder() {
        if (_state.sessionView === 'hourly') {
            var labels = [];
            for (var h = 4; h < 20; h++) {
                var suffix = h < 12 ? 'am' : 'pm';
                var h12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
                labels.push(h12 + suffix);
            }
            return labels;
        }
        return SESSIONS.map(function(s){ return s.label; });
    }

    // ── Build DOW stats ────────────────────────────────────────────────
    function buildDowStats(trades) {
        var map = { Mon:{}, Tue:{}, Wed:{}, Thu:{}, Fri:{} };
        DOW_LABELS.forEach(function(d){ map[d] = {label:d, count:0, pnl:0, wins:0, losses:0, sumWins:0, sumLosses:0, largestLoss:0}; });
        trades.forEach(function(t) {
            var d = parseDateSafe(t.exitTime || t.entryTime);
            if (!d) return;
            var dow = d.getDay();
            if (dow < 1 || dow > 5) return;
            var lbl = DOW_LABELS[dow - 1];
            var p = pnlOf(t);
            map[lbl].count++;
            map[lbl].pnl += p;
            if (p > 0) { map[lbl].wins++; map[lbl].sumWins += p; }
            else if (p < 0) { map[lbl].losses++; map[lbl].sumLosses += p; if (p < map[lbl].largestLoss) map[lbl].largestLoss = p; }
        });
        return DOW_LABELS.map(function(d) {
            var m = map[d];
            m.winRate   = m.count ? m.wins / m.count * 100 : 0;
            m.avgPnl    = m.count ? m.pnl / m.count : 0;
            m.avgWin    = m.wins  ? m.sumWins / m.wins : 0;
            m.avgLoss   = m.losses ? m.sumLosses / m.losses : 0;
            m.expectancy = m.count ? (m.winRate/100 * m.avgWin + (1 - m.winRate/100) * m.avgLoss) : 0;
            return m;
        });
    }

    // ── Build TOD stats ────────────────────────────────────────────────
    function buildTodStats(trades) {
        var order = getSessionOrder();
        var map = {};
        order.forEach(function(s){ map[s] = {label:s, count:0, pnl:0, wins:0, losses:0, sumWins:0, sumLosses:0, largestLoss:0}; });
        trades.forEach(function(t) {
            var d = parseDateSafe(t.entryTime || t.exitTime);
            if (!d) return;
            var lbl = getSessionLabel(d);
            if (!lbl || !map[lbl]) return;
            var p = pnlOf(t);
            map[lbl].count++;
            map[lbl].pnl += p;
            if (p > 0) { map[lbl].wins++; map[lbl].sumWins += p; }
            else if (p < 0) { map[lbl].losses++; map[lbl].sumLosses += p; if (p < map[lbl].largestLoss) map[lbl].largestLoss = p; }
        });
        return order.map(function(s) {
            var m = map[s];
            m.winRate   = m.count ? m.wins / m.count * 100 : 0;
            m.avgPnl    = m.count ? m.pnl / m.count : 0;
            m.avgWin    = m.wins  ? m.sumWins / m.wins : 0;
            m.avgLoss   = m.losses ? m.sumLosses / m.losses : 0;
            m.expectancy = m.count ? (m.winRate/100 * m.avgWin + (1 - m.winRate/100) * m.avgLoss) : 0;
            return m;
        }).filter(function(s){ return _state.sessionView === 'hourly' ? s.count >= 1 : true; });
    }

    // ── Get metric value ───────────────────────────────────────────────
    function getMetricVal(s) {
        switch (_state.metric) {
            case 'win-rate':    return s.winRate;
            case 'expectancy':  return s.expectancy;
            case 'avg-pnl':     return s.avgPnl;
            case 'trade-count': return s.count;
            default:            return s.pnl;
        }
    }
    function fmtMetricVal(s) {
        switch (_state.metric) {
            case 'win-rate':    return fmtPct(s.winRate);
            case 'expectancy':  return fmt$(s.expectancy);
            case 'avg-pnl':     return fmt$(s.avgPnl);
            case 'trade-count': return s.count + ' trades';
            default:            return fmt$(s.pnl);
        }
    }
    function metricColorClass(s) {
        switch (_state.metric) {
            case 'win-rate':    return s.winRate >= 50 ? 'snap-kpi-positive' : 'snap-kpi-negative';
            case 'trade-count': return 'snap-kpi-neutral';
            default:            return pnlCls(getMetricVal(s));
        }
    }

    // ── Widget shell ───────────────────────────────────────────────────
    function widgetHtml(id, title, bodyHtml, sz, helpId) {
        var dragAttr = _state.editMode ? ' draggable="true"' : '';
        var handle   = _state.editMode ? '<span class="snap-drag-handle" title="Drag to reorder">⠿</span>' : '';
        var controls = _state.editMode
            ? '<div class="snap-widget-controls">' +
                  '<button class="snap-ctrl-btn snap-ctrl-sz'+(sz==='small'?' snap-ctrl-sz-active':'')+'" onclick="timingResizeWidget(\''+id+'\',\'small\')" title="Small">S</button>' +
                  '<button class="snap-ctrl-btn snap-ctrl-sz'+(sz==='medium'?' snap-ctrl-sz-active':'')+'" onclick="timingResizeWidget(\''+id+'\',\'medium\')" title="Medium">M</button>' +
                  '<button class="snap-ctrl-btn snap-ctrl-sz'+(sz==='large'?' snap-ctrl-sz-active':'')+'" onclick="timingResizeWidget(\''+id+'\',\'large\')" title="Large">L</button>' +
                  '<span class="snap-ctrl-sep"></span>' +
                  '<button class="snap-ctrl-btn snap-ctrl-remove" onclick="timingRemoveWidget(\''+id+'\')" title="Remove">✕</button>' +
              '</div>'
            : '';
        var helpBtn = helpId
            ? '<button class="trd-help-btn" onclick="showTimingHelp(\''+helpId+'\',this)" title="Learn about this widget">?</button>'
            : '';
        return '<div class="snap-widget snap-widget--'+sz+'"'+dragAttr+' data-instance-id="'+id+'">' +
            '<div class="snap-widget-header">' +
                handle +
                '<span class="snap-widget-title">'+title+'</span>' +
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
        return '<div id="tm-chart-'+id+'" class="snap-chart-wrap" style="height:'+(h||220)+'px;"></div>';
    }
    function emptyState(msg) {
        return '<div class="snap-empty">'+(msg||'No timing data matches current filters.')+'</div>';
    }

    // ── Summary card helper ────────────────────────────────────────────
    function timingCard(label, name, metricStr, metricCls, count) {
        return '<div class="su-setup-card">' +
            '<div class="su-setup-card-label">'+esc(label)+'</div>' +
            '<div class="su-setup-card-name" title="'+esc(name)+'">'+esc(name)+'</div>' +
            '<div class="su-setup-card-metric '+(metricCls||'snap-kpi-neutral')+'">'+metricStr+'</div>' +
            '<div class="su-setup-card-meta">'+count+' trades</div>' +
        '</div>';
    }

    // ── Comparison card helper ─────────────────────────────────────────
    function comparisonHtml(items) {
        // items: [{label, pnl, winRate, count, trades}]
        if (!items.length) return emptyState();
        return '<div class="tm-comparison">' +
            items.map(function(item) {
                var cls = pnlCls(item.pnl);
                return '<div class="tm-cmp-col">' +
                    '<div class="tm-cmp-label">'+esc(item.label)+'</div>' +
                    '<div class="tm-cmp-value '+cls+'">'+fmt$(item.pnl)+'</div>' +
                    '<div class="tm-cmp-meta">'+item.count+' trades &middot; '+fmtPct(item.winRate)+' WR</div>' +
                '</div>';
            }).join('<div class="tm-cmp-sep">vs</div>') +
        '</div>';
    }

    // ── Leaderboard helper ─────────────────────────────────────────────
    function leaderboardHtml(items) {
        if (!items.length) return emptyState();
        return '<div class="su-rank-list">' +
            items.map(function(s, i) {
                var numCls = i===0 ? 'su-rank-num su-rank-num-1' : i===1 ? 'su-rank-num su-rank-num-2' : i===2 ? 'su-rank-num su-rank-num-3' : 'su-rank-num';
                var badge = s.count < _state.minSample && _state.minSample > 1 ? '<span class="su-rank-badge">low</span>' : '';
                return '<div class="su-rank-item">' +
                    '<span class="'+numCls+'">'+(i+1)+'</span>' +
                    '<span class="su-rank-name" title="'+esc(s.label)+'">'+esc(s.label)+'</span>' +
                    badge +
                    '<span class="su-rank-meta">'+s.count+' trades</span>' +
                    '<span class="su-rank-value '+metricColorClass(s)+'">'+fmtMetricVal(s)+'</span>' +
                '</div>';
            }).join('') +
        '</div>';
    }

    // ── RENDERERS ──────────────────────────────────────────────────────
    var RENDERERS = {

        'tm-session-recommendation': function(id, dowStats, todStats, trades, sz) {
            // Need at least 2 session buckets with meaningful trades
            var eligible = todStats.filter(function(s) { return s.count >= 5; });
            if (eligible.length < 2) {
                return widgetHtml(id, 'Session Recommendation',
                    '<div class="tm-insight-text">Not enough timing data to make a session recommendation. Need at least 5 trades in 2+ sessions.</div>', sz);
            }

            var sorted = eligible.slice().sort(function(a, b) { return b.avgPnl - a.avgPnl; });
            var best  = sorted[0];
            var worst = sorted[sorted.length - 1];

            // Check if the gap is meaningful: best must be positive and worst meaningfully worse
            var gap = best.avgPnl - worst.avgPnl;
            if (gap < 5 || best.avgPnl <= 0) {
                return widgetHtml(id, 'Session Recommendation',
                    '<div class="tm-insight-text">Timing performance is relatively balanced in the current view. No clear session cut-off stands out.</div>', sz);
            }

            var text = '';
            if (worst.pnl < 0 && worst.avgPnl < -5) {
                // Worst session is meaningfully negative — recommend avoidance
                text = 'Consider reducing activity during ' + worst.label + '. ' +
                       'Your ' + worst.label + ' trades: ' + fmt$(worst.pnl) + ' total, ' +
                       fmtPct(worst.winRate) + ' win rate across ' + worst.count + ' trades. ' +
                       'Your strongest window is ' + best.label + ': ' + fmtPct(best.winRate) + ' win rate, ' +
                       (best.avgPnl >= 0 ? '+' : '') + fmt$(best.avgPnl) + ' avg/trade.';
            } else {
                // No clearly bad session, just highlight the best
                text = 'Your strongest window is ' + best.label + ': ' +
                       fmtPct(best.winRate) + ' win rate, ' +
                       (best.avgPnl >= 0 ? '+' : '') + fmt$(best.avgPnl) + ' avg/trade across ' + best.count + ' trades.';
            }

            return widgetHtml(id, 'Session Recommendation',
                '<div class="tm-insight-text">' + text + '</div>', sz);
        },

        'best-dow': function(id, dowStats, todStats, trades, sz) {
            var eligible = dowStats.filter(function(s){ return s.count >= _state.minSample; });
            var best = eligible.length ? eligible.slice().sort(function(a,b){ return getMetricVal(b)-getMetricVal(a); })[0] : null;
            var body = best ? timingCard('Best Day \xb7 '+_state.metric.replace(/-/g,' '), best.label, fmtMetricVal(best), metricColorClass(best), best.count) : emptyState('Not enough data');
            return widgetHtml(id, 'Best Day of Week', body, sz, 'best-dow');
        },
        'worst-dow': function(id, dowStats, todStats, trades, sz) {
            var eligible = dowStats.filter(function(s){ return s.count >= _state.minSample; });
            var worst = eligible.length ? eligible.slice().sort(function(a,b){ return getMetricVal(a)-getMetricVal(b); })[0] : null;
            var body = worst ? timingCard('Worst Day \xb7 '+_state.metric.replace(/-/g,' '), worst.label, fmtMetricVal(worst), metricColorClass(worst), worst.count) : emptyState('Not enough data');
            return widgetHtml(id, 'Worst Day of Week', body, sz, 'worst-dow');
        },
        'best-tod': function(id, dowStats, todStats, trades, sz) {
            var eligible = todStats.filter(function(s){ return s.count >= _state.minSample; });
            var best = eligible.length ? eligible.slice().sort(function(a,b){ return getMetricVal(b)-getMetricVal(a); })[0] : null;
            var body = best ? timingCard('Best Time \xb7 '+_state.metric.replace(/-/g,' '), best.label, fmtMetricVal(best), metricColorClass(best), best.count) : emptyState('Not enough data');
            return widgetHtml(id, 'Best Time of Day', body, sz, 'best-tod');
        },
        'worst-tod': function(id, dowStats, todStats, trades, sz) {
            var eligible = todStats.filter(function(s){ return s.count >= _state.minSample; });
            var worst = eligible.length ? eligible.slice().sort(function(a,b){ return getMetricVal(a)-getMetricVal(b); })[0] : null;
            var body = worst ? timingCard('Worst Time \xb7 '+_state.metric.replace(/-/g,' '), worst.label, fmtMetricVal(worst), metricColorClass(worst), worst.count) : emptyState('Not enough data');
            return widgetHtml(id, 'Worst Time of Day', body, sz, 'worst-tod');
        },
        'best-session-window': function(id, dowStats, todStats, trades, sz) {
            // Simplified: best standard bucket by pnl regardless of sessionView
            var eligible = todStats.filter(function(s){ return s.count >= _state.minSample; });
            var best = eligible.length ? eligible.slice().sort(function(a,b){ return b.pnl-a.pnl; })[0] : null;
            var body = best ? timingCard('Best Session Window', best.label, fmt$(best.pnl), pnlCls(best.pnl), best.count) : emptyState('Not enough data');
            return widgetHtml(id, 'Best Session Window', body, sz, null);
        },
        'timing-coverage': function(id, dowStats, todStats, trades, sz) {
            var dowActive = dowStats.filter(function(s){ return s.count > 0; }).length;
            var todActive = todStats.filter(function(s){ return s.count > 0; }).length;
            var body = kpiHtml(dowActive + todActive, dowActive+' days \xb7 '+todActive+' sessions', 'snap-kpi-neutral');
            return widgetHtml(id, 'Timing Coverage', body, sz, null);
        },

        'dow-performance': function(id, dowStats, todStats, trades, sz) {
            var body = dowStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Day-of-Week Performance', body, sz, 'dow-performance');
        },
        'dow-leaderboard': function(id, dowStats, todStats, trades, sz) {
            var eligible = dowStats.filter(function(s){ return s.count >= _state.minSample; })
                .slice().sort(function(a,b){ return getMetricVal(b)-getMetricVal(a); });
            var body = leaderboardHtml(eligible);
            return widgetHtml(id, 'Day-of-Week Leaderboard', body, sz, 'dow-leaderboard');
        },
        'win-rate-dow': function(id, dowStats, todStats, trades, sz) {
            var body = dowStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Win Rate by Day of Week', body, sz, 'win-rate-dow');
        },
        'trade-count-dow': function(id, dowStats, todStats, trades, sz) {
            var body = dowStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Trade Count by Day of Week', body, sz, 'trade-count-dow');
        },
        'expectancy-dow': function(id, dowStats, todStats, trades, sz) {
            var body = dowStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Expectancy by Day of Week', body, sz, null);
        },

        'tod-performance': function(id, dowStats, todStats, trades, sz) {
            var body = todStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Time-of-Day Performance', body, sz, 'tod-performance');
        },
        'tod-leaderboard': function(id, dowStats, todStats, trades, sz) {
            var eligible = todStats.filter(function(s){ return s.count >= _state.minSample; })
                .slice().sort(function(a,b){ return getMetricVal(b)-getMetricVal(a); });
            var body = leaderboardHtml(eligible);
            return widgetHtml(id, 'Time-of-Day Leaderboard', body, sz, 'tod-leaderboard');
        },
        'win-rate-tod': function(id, dowStats, todStats, trades, sz) {
            var body = todStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Win Rate by Time of Day', body, sz, 'win-rate-tod');
        },
        'trade-count-tod': function(id, dowStats, todStats, trades, sz) {
            var body = todStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Trade Count by Time of Day', body, sz, 'trade-count-tod');
        },
        'expectancy-tod': function(id, dowStats, todStats, trades, sz) {
            var body = todStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Expectancy by Time of Day', body, sz, null);
        },
        'avg-pnl-tod': function(id, dowStats, todStats, trades, sz) {
            var body = todStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Avg Trade P&L by Time of Day', body, sz, null);
        },

        'morning-vs-afternoon': function(id, dowStats, todStats, trades, sz) {
            var morn = {label:'Morning', pnl:0, wins:0, count:0};
            var aftn = {label:'Afternoon', pnl:0, wins:0, count:0};
            trades.forEach(function(t) {
                var d = parseDateSafe(t.entryTime || t.exitTime);
                if (!d) return;
                var hr = d.getHours() + d.getMinutes()/60;
                var p = pnlOf(t);
                if (hr < 12) { morn.count++; morn.pnl += p; if (p>0) morn.wins++; }
                else         { aftn.count++; aftn.pnl += p; if (p>0) aftn.wins++; }
            });
            morn.winRate = morn.count ? morn.wins/morn.count*100 : 0;
            aftn.winRate = aftn.count ? aftn.wins/aftn.count*100 : 0;
            var body = (morn.count + aftn.count) ? comparisonHtml([morn, aftn]) : emptyState();
            return widgetHtml(id, 'Morning vs Afternoon', body, sz, 'morning-vs-afternoon');
        },
        'open-vs-rest': function(id, dowStats, todStats, trades, sz) {
            var open = {label:'Open (9:30–10:30)', pnl:0, wins:0, count:0};
            var rest = {label:'Rest of Day', pnl:0, wins:0, count:0};
            trades.forEach(function(t) {
                var d = parseDateSafe(t.entryTime || t.exitTime);
                if (!d) return;
                var hr = d.getHours() + d.getMinutes()/60;
                var p = pnlOf(t);
                if (hr >= 9.5 && hr < 10.5) { open.count++; open.pnl += p; if (p>0) open.wins++; }
                else                          { rest.count++; rest.pnl += p; if (p>0) rest.wins++; }
            });
            open.winRate = open.count ? open.wins/open.count*100 : 0;
            rest.winRate = rest.count ? rest.wins/rest.count*100 : 0;
            var body = (open.count + rest.count) ? comparisonHtml([open, rest]) : emptyState();
            return widgetHtml(id, 'Open vs Rest of Day', body, sz, 'open-vs-rest');
        },
        'early-vs-late': function(id, dowStats, todStats, trades, sz) {
            var early = {label:'Early (Pre-Mkt–Open)', pnl:0, wins:0, count:0};
            var late  = {label:'Late (Afternoon+)', pnl:0, wins:0, count:0};
            trades.forEach(function(t) {
                var d = parseDateSafe(t.entryTime || t.exitTime);
                if (!d) return;
                var hr = d.getHours() + d.getMinutes()/60;
                var p = pnlOf(t);
                if (hr < 10.5) { early.count++; early.pnl += p; if (p>0) early.wins++; }
                else if (hr >= 14) { late.count++; late.pnl += p; if (p>0) late.wins++; }
            });
            early.winRate = early.count ? early.wins/early.count*100 : 0;
            late.winRate  = late.count  ? late.wins/late.count*100   : 0;
            var body = (early.count + late.count) ? comparisonHtml([early, late]) : emptyState();
            return widgetHtml(id, 'Early vs Late Session', body, sz, null);
        },

        'timing-perf-time': function(id, dowStats, todStats, trades, sz) {
            var body = trades.length ? chartPlaceholder(id, sz==='large'?300:220) : emptyState();
            return widgetHtml(id, 'Timing Performance Over Time', body, sz, 'timing-perf-time');
        },
        'session-mix-time': function(id, dowStats, todStats, trades, sz) {
            var body = trades.length ? chartPlaceholder(id, sz==='large'?300:220) : emptyState();
            return widgetHtml(id, 'Session Mix Over Time', body, sz, null);
        },

        'worst-session-leak': function(id, dowStats, todStats, trades, sz) {
            var active = todStats.filter(function(s){ return s.pnl < 0 && s.count >= _state.minSample; })
                .sort(function(a,b){ return a.pnl - b.pnl; });
            var worst = active[0];
            var body = worst
                ? timingCard('Worst Session Leak', worst.label, fmt$(worst.pnl), 'snap-kpi-negative', worst.count)
                : '<div class="snap-empty">No losing sessions in current view.</div>';
            return widgetHtml(id, 'Worst Session Leak', body, sz, null);
        },
        'largest-loss-tod': function(id, dowStats, todStats, trades, sz) {
            var body = todStats.some(function(s){return s.largestLoss < 0;}) ? chartPlaceholder(id) : emptyState('No losing trades in current view.');
            return widgetHtml(id, 'Largest Loss by Time Bucket', body, sz, null);
        },
        'red-rate-dow': function(id, dowStats, todStats, trades, sz) {
            var body = dowStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Red Trade Rate by Day', body, sz, null);
        },
        'red-rate-tod': function(id, dowStats, todStats, trades, sz) {
            var body = todStats.some(function(s){return s.count>0;}) ? chartPlaceholder(id) : emptyState();
            return widgetHtml(id, 'Red Trade Rate by Time Bucket', body, sz, null);
        },

        'hold-time-analysis': function(id, dowStats, todStats, trades, sz) {
            if (!trades.length || typeof window.analyzeHoldTime !== 'function') return widgetHtml(id, 'Hold Time Analysis', emptyState('No trade data available.'), sz, 'hold-time-analysis');
            var buckets = window.analyzeHoldTime(trades);
            var hasData = buckets.some(function(b){ return b.count > 0; });
            if (!hasData) return widgetHtml(id, 'Hold Time Analysis', emptyState('No hold time data in current view.'), sz, 'hold-time-analysis');
            var html = '';
            html += '<table style="width:100%;border-collapse:collapse;"><thead><tr>' +
                '<th style="text-align:left;padding:8px 12px;">Hold Time</th>' +
                '<th style="text-align:right;padding:8px 12px;">Trades</th>' +
                '<th style="text-align:right;padding:8px 12px;">P&L</th>' +
                '<th style="text-align:right;padding:8px 12px;">Win Rate</th>' +
                '<th style="text-align:right;padding:8px 12px;">Avg P&L</th>' +
                '</tr></thead><tbody>';
            buckets.forEach(function(b) {
                if (b.count === 0) return;
                var highlight = (b.pnl > 0 && b.winRate >= 60) ? 'background:rgba(16,185,129,0.1);' : '';
                html += '<tr style="' + highlight + '">' +
                    '<td style="padding:8px 12px;font-weight:600;">' + esc(b.name) + '</td>' +
                    '<td style="text-align:right;padding:8px 12px;">' + b.count + '</td>' +
                    '<td style="text-align:right;padding:8px 12px;color:' + (b.pnl >= 0 ? 'var(--success)' : 'var(--danger)') + ';font-weight:600;">$' + b.pnl.toFixed(2) + '</td>' +
                    '<td style="text-align:right;padding:8px 12px;">' + b.winRate + '%</td>' +
                    '<td style="text-align:right;padding:8px 12px;color:' + (b.avgPnL >= 0 ? 'var(--success)' : 'var(--danger)') + ';font-weight:600;">$' + b.avgPnL.toFixed(2) + '</td>' +
                    '</tr>';
            });
            html += '</tbody></table>';
            return widgetHtml(id, 'Hold Time Analysis', html, sz, 'hold-time-analysis');
        }
    };

    // ── Chart rendering ────────────────────────────────────────────────
    function renderTimingCharts(dowStats, todStats, trades, layout) {
        var tc = '#8b9aae', gc = 'rgba(255,255,255,0.07)';
        var GREEN = 'rgba(34,197,94,0.75)', RED = 'rgba(239,68,68,0.75)', BLUE = 'rgba(96,165,250,0.75)';
        var SERIES_COLORS = ['#60a5fa','#34d399','#f472b6','#fbbf24','#a78bfa','#f97316','#38bdf8','#4ade80'];

        function mkAx(extra) {
            return Object.assign(
                { gridcolor:gc, tickfont:{size:10,color:tc}, linecolor:gc, zeroline:false, automargin:true },
                extra||{}
            );
        }
        function mkBase(m) {
            return {
                paper_bgcolor:'transparent', plot_bgcolor:'transparent',
                margin: m || {t:10,r:10,b:36,l:52},
                font:{family:'Inter,sans-serif',color:tc},
                showlegend:false
            };
        }
        function tryPlot(el, traces, lay, cfg) {
            try {
                Plotly.purge(el);
                Plotly.newPlot(el, traces, lay, cfg || {responsive:true,displayModeBar:false});
            } catch(e) {}
        }

        // Helper: get bar colors based on value
        function barColors(vals, threshold) {
            threshold = threshold || 0;
            return vals.map(function(v){ return v >= threshold ? GREEN : RED; });
        }

        // Get the active metric values for DOW
        function dowMetricVals(key) {
            return dowStats.map(function(s) {
                switch (key||_state.metric) {
                    case 'win-rate':    return s.winRate;
                    case 'expectancy':  return s.expectancy;
                    case 'avg-pnl':     return s.avgPnl;
                    case 'trade-count': return s.count;
                    default:            return s.pnl;
                }
            });
        }
        function todMetricVals(todArr, key) {
            return todArr.map(function(s) {
                switch (key||_state.metric) {
                    case 'win-rate':    return s.winRate;
                    case 'expectancy':  return s.expectancy;
                    case 'avg-pnl':     return s.avgPnl;
                    case 'trade-count': return s.count;
                    default:            return s.pnl;
                }
            });
        }
        function metricTickFmt() {
            switch (_state.metric) {
                case 'win-rate':    return {ticksuffix:'%', range:[0,100]};
                case 'trade-count': return {};
                default:            return {tickprefix:'$'};
            }
        }
        function metricThreshold() {
            return _state.metric === 'win-rate' ? 50 : 0;
        }

        var dowLabels = dowStats.map(function(s){ return s.label; });
        var todLabels = todStats.map(function(s){ return s.label; });

        layout.forEach(function(item) {
            var el = document.getElementById('tm-chart-'+item.id);
            if (!el) return;
            var wid = item.wid;

            // ── Day-of-Week Performance ──────────────────────────
            if (wid === 'dow-performance') {
                var dvals = dowMetricVals();
                if (!dowStats.some(function(s){return s.count>0;})) return;
                var b = mkBase();
                b.xaxis = mkAx({type:'category'});
                b.yaxis = mkAx(metricTickFmt());
                var thr = metricThreshold();
                if (thr) b.shapes = [{type:'line',x0:-0.5,x1:4.5,y0:thr,y1:thr,xref:'x',yref:'y',line:{color:'rgba(255,255,255,0.2)',width:1,dash:'dot'}}];
                tryPlot(el, [{x:dowLabels, y:dvals, type:'bar', marker:{color:barColors(dvals, thr)}}], b);
            }

            // ── Win Rate by DOW ──────────────────────────────────
            if (wid === 'win-rate-dow') {
                if (!dowStats.some(function(s){return s.count>0;})) return;
                var wrv = dowStats.map(function(s){return s.winRate;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category'});
                b.yaxis = mkAx({ticksuffix:'%', range:[0,100]});
                b.shapes = [{type:'line',x0:-0.5,x1:4.5,y0:50,y1:50,xref:'x',yref:'y',line:{color:'rgba(255,255,255,0.2)',width:1,dash:'dot'}}];
                tryPlot(el, [{x:dowLabels, y:wrv, type:'bar', marker:{color:barColors(wrv, 50)}}], b);
            }

            // ── Trade Count by DOW ───────────────────────────────
            if (wid === 'trade-count-dow') {
                if (!dowStats.some(function(s){return s.count>0;})) return;
                var tcv = dowStats.map(function(s){return s.count;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category'});
                b.yaxis = mkAx();
                tryPlot(el, [{x:dowLabels, y:tcv, type:'bar', marker:{color:BLUE}}], b);
            }

            // ── Expectancy by DOW ────────────────────────────────
            if (wid === 'expectancy-dow') {
                if (!dowStats.some(function(s){return s.count>0;})) return;
                var exv = dowStats.map(function(s){return s.expectancy;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category'});
                b.yaxis = mkAx({tickprefix:'$'});
                tryPlot(el, [{x:dowLabels, y:exv, type:'bar', marker:{color:barColors(exv)}}], b);
            }

            // ── TOD Performance ──────────────────────────────────
            if (wid === 'tod-performance') {
                var active = todStats.filter(function(s){return s.count>0;});
                if (!active.length) return;
                var tvals = todMetricVals(active);
                var tlbls = active.map(function(s){return s.label;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category', tickangle: active.length > 6 ? -30 : 0});
                b.yaxis = mkAx(metricTickFmt());
                var thr2 = metricThreshold();
                if (thr2) b.shapes = [{type:'line',x0:-0.5,x1:tlbls.length-0.5,y0:thr2,y1:thr2,xref:'x',yref:'y',line:{color:'rgba(255,255,255,0.2)',width:1,dash:'dot'}}];
                tryPlot(el, [{x:tlbls, y:tvals, type:'bar', marker:{color:barColors(tvals, thr2)}}], b);
            }

            // ── Win Rate by TOD ──────────────────────────────────
            if (wid === 'win-rate-tod') {
                var actw = todStats.filter(function(s){return s.count>0;});
                if (!actw.length) return;
                var wrtvl = actw.map(function(s){return s.winRate;});
                var wrtl  = actw.map(function(s){return s.label;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category', tickangle: actw.length > 6 ? -30 : 0});
                b.yaxis = mkAx({ticksuffix:'%', range:[0,100]});
                b.shapes = [{type:'line',x0:-0.5,x1:wrtl.length-0.5,y0:50,y1:50,xref:'x',yref:'y',line:{color:'rgba(255,255,255,0.2)',width:1,dash:'dot'}}];
                tryPlot(el, [{x:wrtl, y:wrtvl, type:'bar', marker:{color:barColors(wrtvl, 50)}}], b);
            }

            // ── Trade Count by TOD ───────────────────────────────
            if (wid === 'trade-count-tod') {
                var actt = todStats.filter(function(s){return s.count>0;});
                if (!actt.length) return;
                var tctvl = actt.map(function(s){return s.count;});
                var tctl  = actt.map(function(s){return s.label;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category', tickangle: actt.length > 6 ? -30 : 0});
                b.yaxis = mkAx();
                tryPlot(el, [{x:tctl, y:tctvl, type:'bar', marker:{color:BLUE}}], b);
            }

            // ── Expectancy by TOD ────────────────────────────────
            if (wid === 'expectancy-tod') {
                var acte = todStats.filter(function(s){return s.count>0;});
                if (!acte.length) return;
                var extvl = acte.map(function(s){return s.expectancy;});
                var extl  = acte.map(function(s){return s.label;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category', tickangle: acte.length > 6 ? -30 : 0});
                b.yaxis = mkAx({tickprefix:'$'});
                tryPlot(el, [{x:extl, y:extvl, type:'bar', marker:{color:barColors(extvl)}}], b);
            }

            // ── Avg P&L by TOD ───────────────────────────────────
            if (wid === 'avg-pnl-tod') {
                var acta = todStats.filter(function(s){return s.count>0;});
                if (!acta.length) return;
                var apvl = acta.map(function(s){return s.avgPnl;});
                var apl  = acta.map(function(s){return s.label;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category', tickangle: acta.length > 6 ? -30 : 0});
                b.yaxis = mkAx({tickprefix:'$'});
                tryPlot(el, [{x:apl, y:apvl, type:'bar', marker:{color:barColors(apvl)}}], b);
            }

            // ── Largest Loss by TOD ──────────────────────────────
            if (wid === 'largest-loss-tod') {
                var actll = todStats.filter(function(s){return s.largestLoss < 0;});
                if (!actll.length) return;
                var lll  = actll.map(function(s){return s.label;});
                var llv  = actll.map(function(s){return s.largestLoss;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category', tickangle: actll.length > 6 ? -30 : 0});
                b.yaxis = mkAx({tickprefix:'$'});
                tryPlot(el, [{x:lll, y:llv, type:'bar', marker:{color:RED}}], b);
            }

            // ── Red Trade Rate by DOW ────────────────────────────
            if (wid === 'red-rate-dow') {
                if (!dowStats.some(function(s){return s.count>0;})) return;
                var rrv = dowStats.map(function(s){ return s.count ? s.losses/s.count*100 : 0; });
                var b = mkBase();
                b.xaxis = mkAx({type:'category'});
                b.yaxis = mkAx({ticksuffix:'%', range:[0,100]});
                tryPlot(el, [{x:dowLabels, y:rrv, type:'bar', marker:{color:RED}}], b);
            }

            // ── Red Trade Rate by TOD ────────────────────────────
            if (wid === 'red-rate-tod') {
                var actr = todStats.filter(function(s){return s.count>0;});
                if (!actr.length) return;
                var rrtvl = actr.map(function(s){ return s.count ? s.losses/s.count*100 : 0; });
                var rrtl  = actr.map(function(s){return s.label;});
                var b = mkBase();
                b.xaxis = mkAx({type:'category', tickangle: actr.length > 6 ? -30 : 0});
                b.yaxis = mkAx({ticksuffix:'%', range:[0,100]});
                tryPlot(el, [{x:rrtl, y:rrtvl, type:'bar', marker:{color:RED}}], b);
            }

            // ── Timing Performance Over Time ─────────────────────
            if (wid === 'timing-perf-time') {
                // Top sessions by total pnl, monthly breakdown
                var topSess = SESSIONS.slice().map(function(s){ return s.label; });
                var MO_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                var monthSet = {}, monthSess = {};
                trades.forEach(function(t) {
                    var d = parseDateSafe(t.entryTime || t.exitTime);
                    if (!d) return;
                    var lbl = getSessionLabel(d);
                    if (!lbl) return;
                    var yr = d.getFullYear(), mo = d.getMonth();
                    var key = yr + '-' + String(mo+1).padStart(2,'0');
                    monthSet[key] = true;
                    if (!monthSess[key]) monthSess[key] = {};
                    monthSess[key][lbl] = (monthSess[key][lbl]||0) + pnlOf(t);
                });
                var months = Object.keys(monthSet).sort();
                if (!months.length) return;
                var moLabels = months.map(function(k){
                    var p = k.split('-');
                    return MO_ABBR[parseInt(p[1],10)-1] + " '" + p[0].slice(2);
                });
                // Only show sessions with any activity
                var activeSess = topSess.filter(function(s){
                    return months.some(function(m){ return monthSess[m] && monthSess[m][s]; });
                });
                if (!activeSess.length) return;
                var traces = activeSess.map(function(s, i) {
                    return {
                        x: moLabels,
                        y: months.map(function(m){ return (monthSess[m]&&monthSess[m][s])||0; }),
                        name: s, type: 'bar',
                        marker: { color: SERIES_COLORS[i % SERIES_COLORS.length] }
                    };
                });
                var b = mkBase({t:10,r:10,b:60,l:52});
                b.xaxis = mkAx({type:'category', tickangle:-30, nticks:12});
                b.yaxis = mkAx({tickprefix:'$'});
                b.barmode = 'group';
                b.showlegend = true;
                b.legend = {orientation:'h', y:1.06, x:0, font:{size:10,color:tc}};
                tryPlot(el, traces, b);
            }

            // ── Session Mix Over Time ────────────────────────────
            if (wid === 'session-mix-time') {
                var smSessions = SESSIONS.map(function(s){return s.label;});
                var smMoSet = {}, smMoSess = {};
                trades.forEach(function(t) {
                    var d = parseDateSafe(t.entryTime || t.exitTime);
                    if (!d) return;
                    var lbl = getSessionLabel(d);
                    if (!lbl) return;
                    var key = d.getFullYear() + '-' + String(d.getMonth()+1).padStart(2,'0');
                    smMoSet[key] = true;
                    if (!smMoSess[key]) smMoSess[key] = {};
                    smMoSess[key][lbl] = (smMoSess[key][lbl]||0) + 1;
                });
                var smMonths = Object.keys(smMoSet).sort();
                if (!smMonths.length) return;
                var MO2 = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
                var smLabels = smMonths.map(function(k){
                    var p = k.split('-');
                    return MO2[parseInt(p[1],10)-1] + " '" + p[0].slice(2);
                });
                var smTraces = smSessions.map(function(s, i) {
                    return {
                        x: smLabels,
                        y: smMonths.map(function(m){ return (smMoSess[m]&&smMoSess[m][s])||0; }),
                        name: s, type: 'bar',
                        marker: { color: SERIES_COLORS[i % SERIES_COLORS.length] }
                    };
                });
                var b = mkBase({t:10,r:10,b:60,l:52});
                b.xaxis = mkAx({type:'category', tickangle:-30});
                b.yaxis = mkAx();
                b.barmode = 'stack';
                b.showlegend = true;
                b.legend = {orientation:'h', y:1.06, x:0, font:{size:10,color:tc}};
                tryPlot(el, smTraces, b);
            }
        });
    }

    // ── Drag-and-drop ──────────────────────────────────────────────────
    var _drag = { srcId: null, overId: null };

    function timingDragInit() {
        var grid = document.getElementById('timing-grid');
        if (!grid || grid._tmDragBound) return;
        grid._tmDragBound = true;

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
            saveLayout(); renderTiming();
        });
    }

    // ── Main render ────────────────────────────────────────────────────
    function renderTiming() {
        Object.assign(_state, DenariiFilters.readState('timing'));

        var trades   = getTimingTrades();
        var dowStats = buildDowStats(trades);
        var todStats = buildTodStats(trades);
        var layout   = _state.layout || TM_DEFAULT.map(function(w){return Object.assign({},w);});

        var grid = document.getElementById('timing-grid');
        if (!grid) return;
        grid.className = 'snap-grid'+(_state.editMode?' snap-edit-mode':'');
        grid.innerHTML = layout.map(function(item){
            return RENDERERS[item.wid] ? RENDERERS[item.wid](item.id, dowStats, todStats, trades, item.size||'medium') : '';
        }).join('');

        setTimeout(function(){ renderTimingCharts(dowStats, todStats, trades, layout); }, 60);
    }

    // ── Filter population ──────────────────────────────────────────────
    function populateTimingFilters() {
        var stlSel   = document.getElementById('timing-style');
        var perSel   = document.getElementById('timing-period');
        var astSel   = document.getElementById('timing-asset-type');
        var stratSel = document.getElementById('timing-strategy');
        var symEl    = document.getElementById('timing-symbol');
        var fromEl   = document.getElementById('timing-from');
        var toEl     = document.getElementById('timing-to');
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

    // ── Picker ─────────────────────────────────────────────────────────
    function timingRenderPicker() {
        var q    = (document.getElementById('timing-picker-q')||{}).value || '';
        var body = document.getElementById('timing-picker-body');
        if (!body) return;
        var activeWids = {};
        (_state.layout||[]).forEach(function(w){ activeWids[w.wid] = true; });
        var filtered = TM_LIB.filter(function(w){
            return !q || w.name.toLowerCase().indexOf(q.toLowerCase()) !== -1 ||
                         w.desc.toLowerCase().indexOf(q.toLowerCase()) !== -1;
        });
        if (!filtered.length) {
            body.innerHTML = '<div class="snap-empty" style="padding-top:24px;">No widgets match.</div>'; return;
        }
        var cats = [], bycat = {};
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
                            : '<button class="snap-picker-item-add" onclick="timingAddWidget(\''+w.wid+'\')">+ Add</button>') +
                    '</div>';
                }).join('');
        }).join('');
    }

    // ── Persistence ────────────────────────────────────────────────────
    function saveLayout() {
        journalData.timingLayout = JSON.parse(JSON.stringify(_state.layout));
        if (typeof saveToIndexedDB === 'function') saveToIndexedDB();
    }

    // ── Init ───────────────────────────────────────────────────────────
    function initTiming() {
        _state.layout = journalData.timingLayout
            ? JSON.parse(JSON.stringify(journalData.timingLayout))
            : TM_DEFAULT.map(function(w){return Object.assign({},w);});
        populateTimingFilters();
        // Sync metric pills
        document.querySelectorAll('.snap-pill[data-timingmetric]').forEach(function(b){
            b.classList.toggle('active', b.dataset.timingmetric === _state.metric);
        });
        // Sync session pills
        document.querySelectorAll('.snap-pill[data-timingsession]').forEach(function(b){
            b.classList.toggle('active', b.dataset.timingsession === _state.sessionView);
        });
        // Sync min sample pills
        document.querySelectorAll('.snap-pill[data-timingsample]').forEach(function(b){
            b.classList.toggle('active', parseInt(b.dataset.timingsample,10) === _state.minSample);
        });
        renderTiming();
        timingDragInit();
    }

    // ═══ Window-exposed API ════════════════════════════════════════════

    window.renderTiming = renderTiming;

    window.setTimingMetric = function(metric, btn) {
        _state.metric = metric;
        document.querySelectorAll('.snap-pill[data-timingmetric]').forEach(function(b){
            b.classList.toggle('active', b.dataset.timingmetric === metric);
        });
        renderTiming();
    };

    window.setTimingSession = function(view, btn) {
        _state.sessionView = view;
        document.querySelectorAll('.snap-pill[data-timingsession]').forEach(function(b){
            b.classList.toggle('active', b.dataset.timingsession === view);
        });
        renderTiming();
    };

    window.setTimingMinSample = function(n, btn) {
        _state.minSample = n;
        document.querySelectorAll('.snap-pill[data-timingsample]').forEach(function(b){
            b.classList.toggle('active', parseInt(b.dataset.timingsample,10) === n);
        });
        renderTiming();
    };

    window.toggleTimingEdit = function() {
        _state.editMode = !_state.editMode;
        var banner = document.getElementById('timing-edit-banner');
        var btn    = document.getElementById('timing-edit-btn');
        if (banner) banner.style.display = _state.editMode ? 'flex' : 'none';
        if (btn)    btn.textContent = _state.editMode ? '\u2713 Done Editing' : 'Edit Layout';
        renderTiming();
    };

    window.timingResizeWidget = function(id, sz) {
        if (!_state.layout) return;
        var item = _state.layout.find(function(x){return x.id===id;});
        if (item) { item.size = sz; saveLayout(); renderTiming(); }
    };

    window.timingRemoveWidget = function(id) {
        if (!_state.layout) return;
        _state.layout = _state.layout.filter(function(x){return x.id!==id;});
        saveLayout(); renderTiming();
    };

    window.timingAddWidget = function(wid) {
        if (!_state.layout) _state.layout = [];
        var already = _state.layout.some(function(w){return w.wid===wid;});
        if (already) return;
        var def = TM_LIB.find(function(w){return w.wid===wid;});
        _state.layout.push({ id: 'tm'+Date.now(), wid: wid, size: def?def.def:'medium' });
        saveLayout();
        window.closeTimingPicker();
        renderTiming();
    };

    window.timingResetLayout = function() {
        if (!confirm('Reset Timing layout to default?')) return;
        _state.layout = TM_DEFAULT.map(function(w){return Object.assign({},w);});
        saveLayout(); renderTiming();
    };

    window.openTimingPicker = function() {
        document.getElementById('timing-picker-panel').classList.add('open');
        document.getElementById('timing-picker-overlay').classList.add('open');
        timingRenderPicker();
    };

    window.closeTimingPicker = function() {
        document.getElementById('timing-picker-panel').classList.remove('open');
        document.getElementById('timing-picker-overlay').classList.remove('open');
    };

    window.timingRenderPicker = timingRenderPicker;

    window.showTimingHelp = function(helpId, btn) {
        var pop = document.getElementById('timing-help-popover');
        if (!pop) return;
        var h = HELP[helpId];
        if (!h) { pop.style.display='none'; return; }
        var html = '<div class="thp-close-row">' +
            '<span class="thp-title">'+h.title+'</span>' +
            '<button class="thp-close-btn" onclick="hideTimingHelp()">✕</button>' +
        '</div>';
        if (h.what)  html += '<div class="thp-block"><span class="thp-label">What it shows</span><p class="thp-text">'+h.what+'</p></div>';
        if (h.why)   html += '<div class="thp-block"><span class="thp-label">Why it matters</span><p class="thp-text">'+h.why+'</p></div>';
        if (h.how)   html += '<div class="thp-block"><span class="thp-label">How to use it</span><p class="thp-text">'+h.how+'</p></div>';
        if (h.watch) html += '<div class="thp-block"><span class="thp-label">Watch out for</span><p class="thp-text">'+h.watch+'</p></div>';
        pop.innerHTML = html;
        var rect = btn.getBoundingClientRect();
        var left = Math.min(rect.left, window.innerWidth - 310);
        var top  = rect.bottom + 8;
        if (top + 300 > window.innerHeight) top = rect.top - 8 - Math.min(300, pop.offsetHeight||280);
        pop.style.left = Math.max(8, left) + 'px';
        pop.style.top  = Math.max(8, top)  + 'px';
        pop.style.display = 'block';
        setTimeout(function() {
            document.addEventListener('click', _hideTimingHelpOutside, { once: true, capture: true });
        }, 30);
    };

    function _hideTimingHelpOutside(e) {
        var pop = document.getElementById('timing-help-popover');
        if (pop && !pop.contains(e.target)) pop.style.display = 'none';
    }

    window.hideTimingHelp = function() {
        var pop = document.getElementById('timing-help-popover');
        if (pop) pop.style.display = 'none';
    };

    window._timingInit = initTiming;

    // Mounted once at load. Fill Style here too: the app's first
    // _populateStyleSelects() may already have run.
    DenariiFilters.mountFilterBar(document.getElementById('timing-filter-bar'), {
        prefix: 'timing',
        onChange: renderTiming
    });
    if (typeof _populateStyleSelect === 'function') _populateStyleSelect('timing-style', true);

})();
