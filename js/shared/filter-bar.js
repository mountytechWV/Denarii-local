// ── Shared filter bar ────────────────────────────────────────────────────────
// One set of filter rules and one bar for every page that filters trades.
// Filters are view state only: nothing here reads or writes saved data.
// Period rules are the Dashboard's: local time, weeks run Sunday-Saturday.

(function () {

    var PERIODS = [
        { value: 'all',    label: 'All' },
        { value: 'ytd',    label: 'YTD' },
        { value: 'month',  label: 'Month' },
        { value: 'week',   label: 'Week' },
        { value: 'today',  label: 'Today' },
        { value: 'custom', label: 'Custom' }
    ];

    var ASSET_TYPES = [
        { value: 'all',    label: 'All Types' },
        { value: 'stock',  label: 'Stock' },
        { value: 'option', label: 'Option' },
        { value: 'future', label: 'Future' },
        { value: 'crypto', label: 'Crypto' },
        { value: 'bond',   label: 'Bond' },
        { value: 'forex',  label: 'Forex' },
        { value: 'other',  label: 'Other' }
    ];

    // Filter value for trades with no strategy. The strategy editor refuses this name.
    var NO_STRATEGY = '__no_strategy__';

    function esc(s) {
        return String(s == null ? '' : s)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    // Local YYYY-MM-DD string for a Date (avoids UTC shift from toISOString)
    function localDateStr(d) {
        var m = d.getMonth() + 1;
        var day = d.getDate();
        return d.getFullYear() + '-' + (m < 10 ? '0' : '') + m + '-' + (day < 10 ? '0' : '') + day;
    }

    var DATE_ONLY = /^(\d{4})-(\d{2})-(\d{2})$/;

    // First instant of a local day. setFullYear keeps years below 100 literal,
    // which new Date(y, m, d) would read as 19xx.
    function localMidnight(y, mo, da) {
        var d = new Date(2000, 0, 1);
        d.setFullYear(y, mo, da);
        return d;
    }

    // Date for a stored time or a date-only string (which means that local day,
    // not UTC midnight), or null when missing or invalid.
    function parseTradeDate(value) {
        if (!value) return null;
        var m = typeof value === 'string' && DATE_ONLY.exec(value);
        if (m) {
            var mo = +m[2] - 1, da = +m[3];
            var day = localMidnight(+m[1], mo, da);
            return day.getMonth() === mo && day.getDate() === da ? day : null;
        }
        var d = new Date(value);
        return isNaN(d.getTime()) ? null : d;
    }

    // Local YYYY-MM-DD of a stored time or date-only string, or ''.
    function localDayKey(value) {
        var d = parseTradeDate(value);
        return d ? localDateStr(d) : '';
    }

    // The Sunday starting the local week of a stored time or date-only string, or ''.
    function localWeekKey(value) {
        var d = parseTradeDate(value);
        return d ? localDateStr(localMidnight(d.getFullYear(), d.getMonth(), d.getDate() - d.getDay())) : '';
    }

    // UTC instant, as stored on trades, where a local YYYY-MM-DD day starts. Null if malformed.
    function localDayStartUtc(ds) {
        var d = DATE_ONLY.test(ds) ? parseTradeDate(ds) : null;
        return d ? d.toISOString() : null;
    }

    // UTC instant where the local day after a YYYY-MM-DD starts. Null if malformed.
    function nextLocalDayStartUtc(ds) {
        var d = DATE_ONLY.test(ds) ? parseTradeDate(ds) : null;
        return d ? localMidnight(d.getFullYear(), d.getMonth(), d.getDate() + 1).toISOString() : null;
    }

    // Inclusive local date range for a period, or null when it has no limits.
    function periodRange(period, from, to, now) {
        now = now || new Date();
        var y = now.getFullYear(), mo = now.getMonth(), da = now.getDate();
        if (period === 'today') {
            return { from: localDateStr(now), to: localDateStr(now) };
        }
        if (period === 'week') {
            return {
                from: localDateStr(new Date(y, mo, da - now.getDay())),
                to:   localDateStr(new Date(y, mo, da - now.getDay() + 6))
            };
        }
        if (period === 'month') {
            return { from: localDateStr(new Date(y, mo, 1)), to: localDateStr(new Date(y, mo + 1, 0)) };
        }
        if (period === 'ytd') {
            return { from: y + '-01-01', to: localDateStr(now) };
        }
        if (period === 'custom') {
            return { from: from || null, to: to || null };
        }
        return null;
    }

    // Renames made this session (old name -> new name), so a filter still
    // holding the old name follows the rename. Never saved.
    var renamedStrategies = Object.create(null);

    function noteStrategyRename(oldName, newName) {
        Object.keys(renamedStrategies).forEach(function (k) {
            if (renamedStrategies[k] === oldName) renamedStrategies[k] = newName;
        });
        delete renamedStrategies[newName];
        renamedStrategies[oldName] = newName;
    }

    // A filter still holding a deleted strategy returns to All.
    function noteStrategyDeleted(name) {
        noteStrategyRename(name, 'all');
    }

    // A strategy created under an old name is a new strategy, not the renamed one.
    function forgetStrategyRename(name) {
        delete renamedStrategies[name];
    }

    function currentStrategyName(name) {
        return renamedStrategies[name] !== undefined ? renamedStrategies[name] : name;
    }

    // Moves a page's saved filter state, and its select, to the new name.
    function followStrategyRename(sel, state) {
        if (!state) return;
        var next = currentStrategyName(state.strategy);
        if (next === state.strategy) return;
        state.strategy = next;
        if (sel) {
            sel.value = next;
            if (sel.value !== next) sel.value = 'all';
        }
    }

    // state: { period, from, to, style, assetType, strategy, symbol }
    // Missing values mean no filter. The Strategy match is exact so it agrees
    // with the cloud query's .eq('setup_type', value).
    function filterTrades(trades, state, brokerAccounts, now) {
        state = state || {};
        var period = state.period || 'all';
        var range = periodRange(period, state.from, state.to, now);

        var out = (trades || []).filter(function (t) {
            var d = parseTradeDate(t.exitTime || t.entryTime);
            if (!d) return period === 'all';
            if (!range) return true;
            var ds = localDateStr(d);
            if (range.from && ds < range.from) return false;
            if (range.to   && ds > range.to)   return false;
            return true;
        });

        var style = state.style || 'all';
        if (style !== 'all') {
            var styledIds = (brokerAccounts || [])
                .filter(function (a) { return a.tradingStyle === style; })
                .map(function (a) { return String(a.id); });
            out = out.filter(function (t) { return styledIds.indexOf(String(t.brokerAccountId)) !== -1; });
        }
        var assetType = state.assetType || 'all';
        if (assetType !== 'all') {
            out = out.filter(function (t) { return (t.assetType || 'stock') === assetType; });
        }
        var strategy = currentStrategyName(state.strategy || 'all');
        if (strategy === NO_STRATEGY) {
            out = out.filter(function (t) { return !String(t.setupType || '').trim(); });
        } else if (strategy !== 'all') {
            out = out.filter(function (t) { return (t.setupType || '') === strategy; });
        }
        var symbol = (state.symbol || '').toUpperCase();
        if (symbol) {
            out = out.filter(function (t) { return (t.symbol || '').toUpperCase().indexOf(symbol) !== -1; });
        }
        return out;
    }

    // A to Z ignoring case and surrounding spaces, for every strategy dropdown.
    // Names that still tie keep a fixed order.
    function compareStrategyNames(a, b) {
        return a.trim().localeCompare(b.trim(), undefined, { sensitivity: 'base' }) ||
            (a < b ? -1 : a > b ? 1 : 0);
    }

    // Every saved strategy (favorite or not) plus every name found on a trade,
    // so a trade using a deleted or renamed strategy can still be filtered.
    // Values stay raw because matching is exact; labels are trimmed.
    function strategyOptions(trades, strategies) {
        var seen = {};
        var opts = [];
        function add(name) {
            if (typeof name !== 'string' || !name.trim() || name === NO_STRATEGY) return;
            var key = '$' + name;
            if (seen[key]) return;
            seen[key] = true;
            opts.push({ value: name, label: name.trim() });
        }
        (strategies || []).forEach(function (s) { add(s && s.name); });
        (trades || []).forEach(function (t) { add(t && t.setupType); });
        return opts.sort(function (a, b) {
            return compareStrategyNames(a.value, b.value);
        });
    }

    // What a strategy filter value reads as in on-screen and report text.
    function strategyLabel(value) {
        return value === NO_STRATEGY ? 'No Strategy' : value;
    }

    // Keeps the current choice when it is still offered, else returns to All.
    function populateStrategy(sel, trades, strategies, allValue) {
        if (!sel) return;
        var all = allValue === undefined ? 'all' : allValue;
        var cur = currentStrategyName(sel.value);
        var opts = strategyOptions(trades, strategies);
        sel.innerHTML = '<option value="' + esc(all) + '">All Strategies</option>' +
            '<option value="' + NO_STRATEGY + '">No Strategy</option>' +
            opts.map(function (o) {
                return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>';
            }).join('');
        var stillThere = cur === NO_STRATEGY || opts.some(function (o) { return o.value === cur; });
        sel.value = stillThere ? cur : all;
    }

    // From and To always show the Period's range. Custom keeps what is there.
    function syncDates(prefix, now) {
        var sel = document.getElementById(prefix + '-period');
        var fromEl = document.getElementById(prefix + '-from');
        var toEl = document.getElementById(prefix + '-to');
        if (!sel || !fromEl || !toEl || sel.value === 'custom') return;
        var range = periodRange(sel.value, '', '', now);
        fromEl.value = range ? range.from : '';
        toEl.value = range ? range.to : '';
    }

    function readState(prefix) {
        syncDates(prefix);
        var val = function (name) {
            var el = document.getElementById(prefix + '-' + name);
            return el ? el.value : '';
        };
        return {
            period:    val('period')     || 'all',
            from:      val('from'),
            to:        val('to'),
            style:     val('style')      || 'all',
            assetType: val('asset-type') || 'all',
            strategy:  val('strategy')   || 'all',
            symbol:    val('symbol')
        };
    }

    function _optionsHtml(list) {
        return list.map(function (o) {
            return '<option value="' + esc(o.value) + '">' + esc(o.label) + '</option>';
        }).join('');
    }

    // The Dashboard's bar. The Style select is filled by _populateStyleSelects()
    // and Strategy by populateStrategy().
    function barHtml(prefix) {
        var p = esc(prefix);
        return '' +
            '<div class="snap-filter-group" id="' + p + '-fg-period">' +
                '<span class="snap-filter-label">Period</span>' +
                '<select id="' + p + '-period" class="snap-sel">' + _optionsHtml(PERIODS) + '</select>' +
            '</div>' +
            '<div class="snap-filter-group" id="' + p + '-fg-daterange">' +
                '<span class="snap-filter-label">From</span>' +
                '<input type="date" id="' + p + '-from">' +
                '<span class="snap-filter-label">To</span>' +
                '<input type="date" id="' + p + '-to">' +
            '</div>' +
            '<div class="snap-filter-group snap-fg-sep" id="' + p + '-fg-style">' +
                '<span class="snap-filter-label">Style</span>' +
                '<select id="' + p + '-style" class="snap-sel"></select>' +
            '</div>' +
            '<div class="snap-filter-group snap-fg-sep" id="' + p + '-fg-asset-type">' +
                '<span class="snap-filter-label">Asset Type</span>' +
                '<select id="' + p + '-asset-type" class="snap-sel">' + _optionsHtml(ASSET_TYPES) + '</select>' +
            '</div>' +
            '<div class="snap-filter-group snap-fg-sep" id="' + p + '-fg-strategy">' +
                '<span class="snap-filter-label">Strategy</span>' +
                '<select id="' + p + '-strategy" class="snap-sel"><option value="all">All Strategies</option><option value="' + NO_STRATEGY + '">No Strategy</option></select>' +
            '</div>' +
            '<div class="snap-filter-group snap-fg-sep" id="' + p + '-fg-symbol">' +
                '<span class="snap-filter-label">Symbol</span>' +
                '<input type="text" id="' + p + '-symbol" class="snap-sym-input" placeholder="e.g. AAPL">' +
            '</div>';
    }

    // Puts the bar ahead of any page actions already inside el. Safe to call
    // twice: a second mount would wipe a period the Calendar tabs have saved.
    function mountFilterBar(el, opts) {
        if (!el || el.dataset.filterBarMounted) return;
        el.dataset.filterBarMounted = '1';
        var prefix = opts.prefix;
        el.insertAdjacentHTML('afterbegin', barHtml(prefix));

        el.addEventListener('change', function (e) {
            var id = e.target && e.target.id;
            // Page actions can share the prefix (snap-edit-btn), so name the controls.
            var isFilter = ['period', 'from', 'to', 'style', 'asset-type', 'strategy'].some(function (n) {
                return id === prefix + '-' + n;
            });
            if (!isFilter) return;
            if (id === prefix + '-period') syncDates(prefix);
            if (id === prefix + '-from' || id === prefix + '-to') {
                var sel = document.getElementById(prefix + '-period');
                if (sel) sel.value = 'custom';
            }
            opts.onChange();
        });
        el.addEventListener('input', function (e) {
            if (e.target && e.target.id === prefix + '-symbol') opts.onChange();
        });
    }

    window.DenariiFilters = {
        esc: esc,
        localDateStr: localDateStr,
        parseTradeDate: parseTradeDate,
        localDayKey: localDayKey,
        localWeekKey: localWeekKey,
        localDayStartUtc: localDayStartUtc,
        nextLocalDayStartUtc: nextLocalDayStartUtc,
        periodRange: periodRange,
        filterTrades: filterTrades,
        NO_STRATEGY: NO_STRATEGY,
        compareStrategyNames: compareStrategyNames,
        strategyOptions: strategyOptions,
        strategyLabel: strategyLabel,
        populateStrategy: populateStrategy,
        noteStrategyRename: noteStrategyRename,
        noteStrategyDeleted: noteStrategyDeleted,
        forgetStrategyRename: forgetStrategyRename,
        currentStrategyName: currentStrategyName,
        followStrategyRename: followStrategyRename,
        syncDates: syncDates,
        readState: readState,
        barHtml: barHtml,
        mountFilterBar: mountFilterBar
    };

})();
