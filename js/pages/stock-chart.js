(function () {

        // ========== STOCK CHART VIEWER ==========

        let currentChart = null;
        let currentChartSeries = null;
        let currentChartTrade = null;
        let currentChartSymbolOnly = null;

        // The Twelve Data key is the user's own, saved in Settings →
        // Integrations (js/services/market-data-key.js). None is kept in code.

        // More exits than this on one candle merge into a single label.
        const MAX_EXITS_PER_CANDLE = 3;

        function getSelectedChartTimeframe() {
            return document.getElementById('chart-timeframe')?.value || '5m';
        }

        function timeframeToMinutes(timeframe) {
            switch (timeframe) {
                case '1m': return 1;
                case '3m': return 3;
                case '10m': return 10;
                case '15m': return 15;
                case '5m':
                default: return 5;
            }
        }

        function baseFetchInterval(timeframe) {
            // 3m and 10m are aggregated client-side from 1m data.
            if (timeframe === '3m' || timeframe === '10m') return '1min';
            if (timeframe === '15m') return '15min';
            return '5min';
        }

        function formatDateForApi(dateValue) {
            const d = new Date(dateValue);
            const y = d.getFullYear();
            const m = String(d.getMonth() + 1).padStart(2, '0');
            const day = String(d.getDate()).padStart(2, '0');
            return `${y}-${m}-${day}`;
        }

        function toChartTimestampFromApi(datetimeStr) {
            // Parse Twelve Data's local exchange datetime as a wall-clock UTC timestamp
            // so Lightweight Charts displays the same visible market time.
            const [datePart, timePart = '00:00:00'] = datetimeStr.split(' ');
            const [y, m, d] = datePart.split('-').map(Number);
            const [hh, mm, ss = 0] = timePart.split(':').map(Number);
            return Math.floor(Date.UTC(y, m - 1, d, hh, mm, ss) / 1000);
        }

        function toChartTimestamp(dateValue) {
            const d = new Date(dateValue);
            return Math.floor((d.getTime() - d.getTimezoneOffset() * 60000) / 1000);
        }

        function alignTimestampToBarStart(dateValue, timeframe) {
            const ts = toChartTimestamp(dateValue);
            const bucketSeconds = timeframeToMinutes(timeframe) * 60;
            return ts - (ts % bucketSeconds);
        }

        function findMarkerBarTime(dateValue, chartData, timeframe) {
            if (!dateValue) return null;

            const alignedTime = alignTimestampToBarStart(dateValue, timeframe);
            const exactBar = chartData.find(c => c.time === alignedTime);
            if (exactBar) return exactBar.time;

            const ts = toChartTimestamp(dateValue);
            let candidate = null;
            for (const candle of chartData) {
                if (candle.time <= ts) candidate = candle.time;
                else break;
            }

            return candidate ?? (chartData.length ? chartData[0].time : alignedTime);
        }

        function aggregateCandles(candles, bucketMinutes) {
            if (!candles || !candles.length || bucketMinutes <= 1) return candles;

            const bucketSeconds = bucketMinutes * 60;
            const aggregated = [];

            for (const candle of candles) {
                const bucketTime = candle.time - (candle.time % bucketSeconds);

                const last = aggregated[aggregated.length - 1];
                if (!last || last.time !== bucketTime) {
                    aggregated.push({
                        time: bucketTime,
                        open: candle.open,
                        high: candle.high,
                        low: candle.low,
                        close: candle.close,
                    });
                } else {
                    last.high = Math.max(last.high, candle.high);
                    last.low = Math.min(last.low, candle.low);
                    last.close = candle.close;
                }
            }

            return aggregated;
        }

        function parseTwelveDataValues(values) {
            return values.map(v => ({
                time: toChartTimestampFromApi(v.datetime),
                open: Number(v.open),
                high: Number(v.high),
                low: Number(v.low),
                close: Number(v.close),
            })).filter(v =>
                Number.isFinite(v.time) &&
                Number.isFinite(v.open) &&
                Number.isFinite(v.high) &&
                Number.isFinite(v.low) &&
                Number.isFinite(v.close)
            );
        }

        function escapeChartHtml(value) {
            return String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
        }

        // message/detail are escaped; actionHtml is trusted markup from this file.
        function showChartMessage(message, detail = '', actionHtml = '') {
            const chartLoading = document.getElementById('chart-loading');
            chartLoading.style.display = 'block';
            chartLoading.innerHTML = `
                <div style="font-size: 40px; margin-bottom: 12px;">!</div>
                <div style="font-weight: 600; margin-bottom: 8px;">${escapeChartHtml(message)}</div>
                ${detail ? `<div style="font-size: 12px; color: var(--text-secondary); max-width: 420px;">${escapeChartHtml(detail)}</div>` : ''}
                ${actionHtml}
            `;
        }

        // Plain reason for a failed Twelve Data request. Never includes the key.
        function describeTwelveDataError(httpStatus, json, symbol, apiKey) {
            const code = Number((json && json.code) || httpStatus) || 0;
            let raw = String((json && json.message) || '').replace(/\*\*/g, '');
            if (apiKey) raw = raw.split(apiKey).join('***');
            const sym = symbol ? String(symbol).toUpperCase() : 'this symbol';

            if (code === 401 || /api ?key/i.test(raw)) {
                return 'Your Twelve Data API key was rejected. Check it in Settings → Integrations.';
            }
            if (code === 429 || /api credits|rate limit|too many requests/i.test(raw)) {
                return 'Twelve Data rate limit reached (free plan: 8 requests per minute, 800 per day). Wait a minute and try again.';
            }
            if (code === 404 || /symbol.*(not found|invalid)|not found.*symbol/i.test(raw)) {
                return `Twelve Data doesn't recognise symbol ${sym}.`;
            }
            if (code === 403) {
                return 'Your Twelve Data plan does not include this data.' + (raw ? ' ' + raw : '');
            }
            if (raw) return 'Twelve Data: ' + raw;
            return httpStatus ? `HTTP ${httpStatus} while requesting Twelve Data` : 'Twelve Data returned an error';
        }

        // ── Markers ──

        function fmtPrice(value) {
            return `$${Number(value).toFixed(2)}`;
        }

        function fmtQty(value) {
            const n = Number(value);
            return Number.isFinite(n) ? String(Number(n.toFixed(4))) : '?';
        }

        function hasValue(value) {
            return value != null && value !== '' && Number.isFinite(Number(value));
        }

        function tradeChartOptions(trade) {
            // The trade's side lives in type (local) or direction (cloud rows).
            const side = String((trade && (trade.type || trade.direction)) || 'long').toLowerCase();
            return {
                isShort: side === 'short',
                isOption: !!trade && trade.assetType === 'option',
            };
        }

        // Trades without fills: one Entry and one Exit marker.
        function buildSingleMarkers(trade, chartData, timeframe, opt) {
            const markers = [];
            const suffix = opt.isOption ? ' opt' : '';
            const entryMarkerTime = trade.entryTime ? findMarkerBarTime(new Date(trade.entryTime), chartData, timeframe) : null;
            const exitMarkerTime = trade.exitTime ? findMarkerBarTime(new Date(trade.exitTime), chartData, timeframe) : null;

            if (entryMarkerTime != null && trade.entryPrice != null) {
                markers.push({
                    time: entryMarkerTime,
                    position: 'belowBar',
                    color: '#2196F3',
                    shape: 'arrowUp',
                    text: `Entry @ ${fmtPrice(trade.entryPrice)}${suffix}`,
                });
            }

            if (exitMarkerTime != null && trade.exitPrice != null) {
                markers.push({
                    time: exitMarkerTime,
                    position: 'aboveBar',
                    color: (trade.entryPrice != null && Number(trade.entryPrice) < Number(trade.exitPrice)) ? '#4CAF50' : '#f44336',
                    shape: 'arrowDown',
                    text: `Exit @ ${fmtPrice(trade.exitPrice)}${suffix}`,
                });
            }

            return markers;
        }

        // One marker per distinct entry (same time + price combine, qty summed)
        // and one per exit fill, each on its own candle. More than
        // MAX_EXITS_PER_CANDLE exits on one candle merge into one label.
        // Returns null when no fill is usable, so the caller falls back.
        function buildFillMarkers(trade, chartData, timeframe, opt) {
            const fills = Array.isArray(trade.fills) ? trade.fills : [];
            if (!fills.length) return null;

            const isShort = opt.isShort;
            const suffix = opt.isOption ? ' opt' : '';
            const openVerb = isShort ? 'Sell' : 'Buy';
            const closeVerb = isShort ? 'Buy' : 'Sell';
            const dir = isShort ? -1 : 1;

            const entries = new Map();
            const exitsByBar = new Map();

            for (const f of fills) {
                const qty = Number(f.quantity) || 0;

                const entryTime = f.entryTime || trade.entryTime;
                const entryMs = entryTime ? new Date(entryTime).getTime() : NaN;
                if (Number.isFinite(entryMs) && hasValue(f.entryPrice)) {
                    const key = `${entryMs}|${Number(f.entryPrice)}`;
                    const e = entries.get(key);
                    if (e) e.qty += qty;
                    else entries.set(key, { ms: entryMs, price: Number(f.entryPrice), qty });
                }

                const exitMs = f.exitTime ? new Date(f.exitTime).getTime() : NaN;
                if (Number.isFinite(exitMs) && hasValue(f.exitPrice)) {
                    const barTime = findMarkerBarTime(new Date(exitMs), chartData, timeframe);
                    if (barTime == null) continue;
                    const pnl = hasValue(f.entryPrice) ? (Number(f.exitPrice) - Number(f.entryPrice)) * qty * dir : 0;
                    const list = exitsByBar.get(barTime) || [];
                    list.push({ ms: exitMs, price: Number(f.exitPrice), qty, pnl });
                    exitsByBar.set(barTime, list);
                }
            }

            const markers = [];
            for (const e of entries.values()) {
                const barTime = findMarkerBarTime(new Date(e.ms), chartData, timeframe);
                if (barTime == null) continue;
                markers.push({
                    time: barTime,
                    position: isShort ? 'aboveBar' : 'belowBar',
                    color: '#2196F3',
                    shape: isShort ? 'arrowDown' : 'arrowUp',
                    text: `${openVerb} ${fmtQty(e.qty)} @ ${fmtPrice(e.price)}${suffix}`,
                    _order: 0,
                    _ms: e.ms,
                });
            }

            const pnlColor = pnl => pnl >= 0 ? '#4CAF50' : '#f44336';
            const exitMarker = (time, color, text, ms) => ({
                time,
                position: isShort ? 'belowBar' : 'aboveBar',
                color,
                shape: isShort ? 'arrowUp' : 'arrowDown',
                text,
                _order: 1,
                _ms: ms,
            });
            for (const [barTime, list] of exitsByBar) {
                list.sort((a, b) => a.ms - b.ms);
                if (list.length > MAX_EXITS_PER_CANDLE) {
                    const total = list.reduce((sum, x) => sum + x.pnl, 0);
                    const parts = list.map(x => `${fmtQty(x.qty)} @ ${fmtPrice(x.price)}`).join(' · ');
                    markers.push(exitMarker(barTime, pnlColor(total), `${closeVerb} ${parts}${suffix}`, list[0].ms));
                } else {
                    list.forEach(x => markers.push(
                        exitMarker(barTime, pnlColor(x.pnl), `${closeVerb} ${fmtQty(x.qty)} @ ${fmtPrice(x.price)}${suffix}`, x.ms)
                    ));
                }
            }

            if (!markers.length) return null;

            // setMarkers needs ascending time; on a shared candle entries come
            // first, then fills in time order (the chart stacks them).
            markers.sort((a, b) => (a.time - b.time) || (a._order - b._order) || (a._ms - b._ms));
            markers.forEach(m => { delete m._order; delete m._ms; });
            return markers;
        }

        // Reads the trade's saved fills; never changes the trade.
        function buildTradeMarkers(trade, chartData, timeframe) {
            const opt = tradeChartOptions(trade);
            return buildFillMarkers(trade, chartData, timeframe, opt) || buildSingleMarkers(trade, chartData, timeframe, opt);
        }

        function openChartForTrade(tradeId) {
            // Ids can arrive as a number (inline onclick) while stored ids are strings.
            const trade = journalData.trades.find(t => String(t.id) === String(tradeId));
            if (!trade) return;

            currentChartTrade = trade;
            currentChartSymbolOnly = null;

            openStockChart(
                trade.symbol,
                trade.entryTime,
                trade.exitTime,
                trade.entryPrice,
                trade.exitPrice,
                getSelectedChartTimeframe(),
                trade
            );
        }

        async function reloadCurrentChart() {
            if (currentChartTrade) {
                await openStockChart(
                    currentChartTrade.symbol,
                    currentChartTrade.entryTime,
                    currentChartTrade.exitTime,
                    currentChartTrade.entryPrice,
                    currentChartTrade.exitPrice,
                    getSelectedChartTimeframe(),
                    currentChartTrade
                );
                return;
            }

            if (currentChartSymbolOnly) {
                await openStockChart(
                    currentChartSymbolOnly,
                    null,
                    null,
                    null,
                    null,
                    getSelectedChartTimeframe()
                );
            }
        }

        // trade (optional): the saved trade, for per-fill markers and labels.
        async function openStockChart(symbol, entryTime = null, exitTime = null, entryPrice = null, exitPrice = null, timeframe = '5m', trade = null) {
            currentChartSymbolOnly = symbol;
            document.getElementById('chart-ticker-title').textContent = `${symbol} Chart`;

            const entryDate = entryTime ? new Date(entryTime) : new Date();

            const notes = [];
            if (entryTime && entryPrice != null && exitPrice != null) {
                notes.push(`Trade: ${entryDate.toLocaleDateString()} ${entryDate.toLocaleTimeString()} @ $${Number(entryPrice).toFixed(2)} → $${Number(exitPrice).toFixed(2)}`);
            } else if (entryTime && entryPrice != null) {
                notes.push(`Open trade: Entry ${entryDate.toLocaleDateString()} ${entryDate.toLocaleTimeString()} @ $${Number(entryPrice).toFixed(2)}`);
            } else {
                notes.push(`Symbol overview for ${symbol}`);
            }
            const fillCount = trade && Array.isArray(trade.fills) ? trade.fills.length : 0;
            if (fillCount > 1) notes.push(`${fillCount} fills`);
            notes.push(timeframe);
            if (trade && tradeChartOptions(trade).isOption) {
                notes.push('Option trade: chart shows the underlying; markers mark fill times; prices are option premiums');
            }
            document.getElementById('chart-trade-info').textContent = notes.join(' | ');

            openModal('stock-chart-modal');

            const chartLoading = document.getElementById('chart-loading');
            chartLoading.style.display = 'block';
            chartLoading.innerHTML = `
                <div style="font-size: 48px; margin-bottom: 16px;"></div>
                <div>Loading chart data...</div>
            `;
            document.getElementById('tradingview-chart').innerHTML = '';

            let apiKey = null;
            if (typeof TwelveDataKey !== 'undefined') {
                if (!TwelveDataKey.isLoaded()) {
                    try { await TwelveDataKey.loadApiKey(); } catch (e) { /* treated as no key */ }
                }
                apiKey = TwelveDataKey.getKey();
            }
            if (!apiKey) {
                showChartMessage(
                    'Add your Twelve Data API key in Settings → Integrations',
                    'Charts use your own free Twelve Data key, saved encrypted with your account.',
                    `<button type="button" class="btn btn-primary" style="margin-top:12px;" onclick="closeStockChart(); openSettings(); switchSettingsTab('settings-integrations');">Open Settings → Integrations</button>`
                );
                return;
            }

            if (typeof LightweightCharts === 'undefined') {
                showChartMessage('Chart library failed to load', 'Please refresh the page and try again.');
                return;
            }

            try {
                const result = await fetchChartData(symbol, entryDate, timeframe, apiKey);
                const chartData = result.data;
                chartLoading.style.display = 'none';

                const chartContainer = document.getElementById('tradingview-chart');
                if (currentChart) currentChart.remove();

                currentChart = LightweightCharts.createChart(chartContainer, {
                    width: chartContainer.clientWidth || chartContainer.offsetWidth || 1000,
                    height: 500,
                    layout: {
                        background: { color: '#1e222d' },
                        textColor: '#d1d4dc',
                    },
                    grid: {
                        vertLines: { color: '#2b2b43' },
                        horzLines: { color: '#2b2b43' },
                    },
                    crosshair: {
                        mode: LightweightCharts.CrosshairMode.Normal,
                    },
                    rightPriceScale: {
                        borderColor: '#2b2b43',
                    },
                    timeScale: {
                        borderColor: '#2b2b43',
                        timeVisible: true,
                        secondsVisible: false,
                    },
                });

                currentChartSeries = currentChart.addCandlestickSeries({
                    upColor: '#26a69a',
                    downColor: '#ef5350',
                    borderVisible: false,
                    wickUpColor: '#26a69a',
                    wickDownColor: '#ef5350',
                });

                currentChartSeries.setData(chartData);

                const markers = buildTradeMarkers(
                    Object.assign({}, trade || {}, { entryTime, exitTime, entryPrice, exitPrice }),
                    chartData,
                    timeframe
                );

                if (markers.length) currentChartSeries.setMarkers(markers);
                currentChart.timeScale().fitContent();

            } catch (error) {
                showChartMessage('Unable to load chart', error.message || 'Unknown error');
            }
        }

        async function fetchChartData(symbol, tradeDate, timeframe = '5m', apiKey) {
            const dateStr = formatDateForApi(tradeDate);
            const startDate = `${dateStr} 04:00:00`;
            const endDate = `${dateStr} 20:00:00`;
            const fetchInterval = baseFetchInterval(timeframe);

            const params = new URLSearchParams({
                symbol,
                interval: fetchInterval,
                start_date: startDate,
                end_date: endDate,
                timezone: 'America/New_York',
                order: 'ASC',
                outputsize: '5000',
                apikey: apiKey,
            });

            const url = `https://api.twelvedata.com/time_series?${params.toString()}`;
            let response;
            try {
                response = await fetch(url);
            } catch (e) {
                throw new Error("Couldn't reach Twelve Data. Check your connection and try again.");
            }

            let json = null;
            try { json = await response.json(); } catch (e) { /* non-JSON body */ }

            if (!response.ok || !json || json.status === 'error') {
                throw new Error(describeTwelveDataError(response.status, json, symbol, apiKey));
            }

            if (!json.values || !Array.isArray(json.values) || !json.values.length) {
                throw new Error('No chart data returned for this symbol/date');
            }

            let candles = parseTwelveDataValues(json.values);

            if (timeframe === '3m' || timeframe === '10m') {
                candles = aggregateCandles(candles, timeframeToMinutes(timeframe));
            }

            return { data: candles };
        }

        function closeStockChart() {
            closeModal('stock-chart-modal');
            if (currentChart) {
                currentChart.remove();
                currentChart = null;
                currentChartSeries = null;
            }
        }

        window.addEventListener('resize', () => {
            if (currentChart) {
                const chartContainer = document.getElementById('tradingview-chart');
                currentChart.resize(chartContainer.clientWidth, chartContainer.clientHeight || 500);
            }
        });

        // ── Expose public API ──
        window.openStockChart    = openStockChart;
        window.openChartForTrade = openChartForTrade;
        window.closeStockChart   = closeStockChart;
        window.reloadCurrentChart = reloadCurrentChart;
        window.StockChartMarkers  = { buildTradeMarkers, describeTwelveDataError, MAX_EXITS_PER_CANDLE };

})();
