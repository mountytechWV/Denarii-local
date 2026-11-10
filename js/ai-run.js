/**
 * @file ai-run.js
 * Run Analysis page — prompt selection, filter configuration, execution, and output display.
 * Exposes window.AIRun.
 *
 * Depends on:
 *  - window.DenAriiAI        (js/services/ai/index.js)
 *  - window._DenAriiPrompts  (js/services/ai/prompts.js)
 *  - Denarii.js globals: journalData, activateSection
 */

(function (global) {

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    var _selectedPromptId       = null;
    var _isRunning              = false;
    var _lastResponse           = null;
    var _lastParsedStructured   = null;  // parsed JSON from structured prompt (internal only)
    var _lastRenderedReportData = null;  // actual reportData passed to _renderReport (includes fallback)
    var _lastAnalysisMeta       = null;  // filter/count summary shown in output header
    var _lastCutOff             = false; // reply hit the output limit (shown, and saved with the report)
    var _elapsedTimer           = null;  // setInterval handle for loading elapsed-time display
    var _runStartTime           = null;  // timestamp when current run started
    var _rerunAccount           = null;  // saved report's account ('all' or id) for the next run; null = header selector

    var _ACCOUNT_GONE_MSG = 'This report\'s account no longer exists. Choose an account in the header to run it.';
    var _STRATEGY_GONE_MSG = 'This report\'s strategy no longer exists, so this run will use All Strategies.';

    // ─────────────────────────────────────────────────────────────────────────
    // Report prompt wrapper — always applied before sending to Gemini.
    // Returns structured JSON that is rendered into the polished report layout.
    // The base AI service (DenAriiAI.query) is NOT modified.
    // ─────────────────────────────────────────────────────────────────────────

    // System wrapper applied to every prompt.
    // Uses a flexible "sections" schema so the model can tailor section names
    // and content to what each specific prompt is asking for — rather than
    // forcing a fixed strengths/weaknesses/action-plan structure every time.
    var _REPORT_SYSTEM = [
        'You are a trading analysis assistant. Provide objective, data-backed insights.',
        'Respond ONLY with a valid JSON object.',
        'No markdown fences, no explanatory text, no code blocks — just the raw JSON.',
        '',
        'Required JSON schema:',
        '{',
        '  "title": "Short descriptive title for this analysis",',
        '  "summary": "2–3 sentence executive overview of the most important finding",',
        '  "sections": [',
        '    {',
        '      "heading": "A section heading that fits what the prompt is asking for",',
        '      "items": [',
        '        "Specific finding referencing actual data (numbers, symbols, dates, patterns)",',
        '        "Another specific finding"',
        '      ]',
        '    }',
        '  ],',
        '  "bottom_line": "One sentence — the single most important takeaway"',
        '}',
        '',
        'Rules:',
        '- title, summary, sections, and bottom_line are all required.',
        '- sections must have at least 2 entries, each with at least 2 items.',
        '- Choose section headings that directly answer what the user is asking for.',
        '- Every item must be specific and reference real data from the trades provided.',
        '- Do not include empty sections or placeholder text.',
        '',
        'User prompt:',
    ].join('\n');

    function _wrapReportPrompt(userPrompt) {
        return _REPORT_SYSTEM + '\n' + userPrompt;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Init / render (called each time the tab becomes visible)
    // ─────────────────────────────────────────────────────────────────────────

    function init() {
        _populatePromptSelector();
        _populateStrategyFilter();
        _restoreDateRange();

        // Wire the live count listener (idempotent — safe to call on every tab visit)
        // The account comes from the global header selector; its inline
        // onchange (applyGlobalFilters) runs first and sets filterBrokerAccountId.
        var acctSel = document.getElementById('filter-broker-account');
        if (acctSel && !acctSel._aiRunCountBound) {
            acctSel.addEventListener('change', function () {
                // Choosing an account replaces a saved report's account.
                if (_rerunAccountGone()) _setRunStatus('', '');
                _rerunAccount = null;
                var tab = document.getElementById('ai-run');
                if (tab && tab.classList.contains('active')) _updateTradeCount();
            });
            acctSel._aiRunCountBound = true;
        }
        _updateTradeCount();

        // Re-applying the remembered prompt on a revisit keeps the last
        // result, which is restored below with its header.
        if (_selectedPromptId) {
            _applyPromptToForm(_selectedPromptId, true);
        }

        if (_lastResponse) {
            _renderOutput(_lastResponse);
        }

        var warn = document.getElementById('ai-run-key-warn');
        if (warn && global.DenAriiAI) {
            warn.style.display = DenAriiAI.isConfigured('gemini') ? 'none' : 'block';
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Prompt selector
    // ─────────────────────────────────────────────────────────────────────────

    function _populatePromptSelector() {
        var sel = document.getElementById('ai-run-prompt-select');
        if (!sel) return;

        var p = global._DenAriiPrompts;
        if (!p) return;

        var prompts = p.getAllPrompts();
        var currentVal = sel.value || _selectedPromptId || '';

        var opts = '<option value="">— Choose a prompt —</option>';

        var globals = prompts.filter(function (pr) { return pr.createdBy === 'Denarii'; });
        if (globals.length) {
            opts += '<optgroup label="Global Prompts">';
            globals.forEach(function (pr) {
                opts += '<option value="' + pr.id + '"' + (pr.id === currentVal ? ' selected' : '') + '>' +
                    _esc(pr.title) + '</option>';
            });
            opts += '</optgroup>';
        }

        var user = prompts.filter(function (pr) { return pr.createdBy !== 'Denarii'; });
        if (user.length) {
            opts += '<optgroup label="My Prompts">';
            user.forEach(function (pr) {
                opts += '<option value="' + pr.id + '"' + (pr.id === currentVal ? ' selected' : '') + '>' +
                    _esc(pr.title) + '</option>';
            });
            opts += '</optgroup>';
        }

        sel.innerHTML = opts;
    }

    function _populateStrategyFilter() {
        if (typeof journalData === 'undefined') return;
        DenariiFilters.populateStrategy(document.getElementById('ai-run-strategy'), journalData.trades, journalData.strategies);
    }

    function _restoreDateRange() {
        // Nothing to restore by default — leave blank (means "all dates")
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Live trade count
    // ─────────────────────────────────────────────────────────────────────────

    function _brokerAccounts() {
        return (typeof journalData !== 'undefined' && journalData.brokerAccounts) || [];
    }

    function _findAccount(id) {
        return _brokerAccounts().find(function (a) { return a.id === id; }) || null;
    }

    function _rerunAccountGone() {
        return !!_rerunAccount && _rerunAccount !== 'all' && !_findAccount(_rerunAccount);
    }

    /** The run's account's trades that the shared filter bar selects. */
    function _selectedTrades(allTrades) {
        var accountTrades = typeof getSelectedAccountTrades === 'function'
            ? getSelectedAccountTrades(allTrades, _rerunAccount || undefined) : allTrades;
        return DenariiFilters.filterTrades(accountTrades, DenariiFilters.readState('ai-run'), _brokerAccounts(), new Date());
    }

    /** The bar's values as the request and the saved report name them. */
    function _readFilters() {
        var state     = DenariiFilters.readState('ai-run');
        var accountId = _rerunAccount || window.filterBrokerAccountId;
        var account   = (typeof accountId !== 'undefined' && accountId !== 'all') ? accountId : null;
        return {
            accountFilter:  account,
            strategyFilter: state.strategy  !== 'all' ? state.strategy  : null,
            instrumentType: state.assetType !== 'all' ? state.assetType : null,
            styleFilter:    state.style     !== 'all' ? state.style     : null,
            symbol:         state.symbol || null,
            dateRange:      (state.from || state.to)
                                ? { start: state.from || null, end: state.to || null }
                                : null,
        };
    }

    /** All trades outside hidden accounts, plus the run's own account if it is hidden. */
    function _totalTradeCount(allTrades) {
        if (typeof getSelectedAccountTrades !== 'function') return allTrades.length;
        var total = getSelectedAccountTrades(allTrades, 'all').length;
        var runAccount = _findAccount(_rerunAccount || window.filterBrokerAccountId);
        if (runAccount && runAccount.visible === false) {
            total += getSelectedAccountTrades(allTrades, runAccount.id).length;
        }
        return total;
    }

    /** Read current filter values and return { filtered, total }. */
    function _computeFilteredCount() {
        var allTrades = [];
        try {
            allTrades = (typeof journalData !== 'undefined' && journalData.trades)
                ? journalData.trades : [];
        } catch (e) { allTrades = []; }

        var total = _totalTradeCount(allTrades);

        var filtered = total;
        if (global._DenAriiAIFormatter) {
            try {
                var payload = global._DenAriiAIFormatter.buildPayload(
                    Object.assign({ tradeData: _selectedTrades(allTrades) }, _readFilters())
                );
                filtered = payload.trades.length;
            } catch (e) { /* leave as total */ }
        }

        return { filtered: filtered, total: total };
    }

    /** Refresh the Trades Selected indicator in the config panel. */
    function _updateTradeCount() {
        var el    = document.getElementById('ai-run-trade-count');
        var valEl = document.getElementById('ai-run-trade-count-val');
        if (!el || !valEl) return;

        var counts = _computeFilteredCount();
        valEl.textContent = counts.filtered + ' of ' + counts.total;

        // The header selector does not show a saved report's account, so name it here.
        var acctEl = document.getElementById('ai-run-trade-count-account');
        if (acctEl) {
            var acct = _rerunAccount ? _findAccount(_rerunAccount) : null;
            acctEl.textContent = !_rerunAccount ? ''
                : _rerunAccount === 'all' ? ' · All Accounts'
                : acct ? ' · ' + (acct.displayName || acct.broker)
                : ' · Account removed';
        }

        if (counts.filtered === 0) {
            valEl.style.color = 'var(--danger)';
        } else {
            valEl.style.color = 'var(--text-primary)';
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Apply trade-analysis filters forwarded from Prompt Library
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Pre-set Run Analysis filter controls from the Prompt Library trade-analysis filters.
     * Called by AILibrary.runPrompt() before navigating to this tab.
     * @param {{ category, style, timeframe }} filters
     */
    function applyTradeFilters(filters) {
        if (!filters) return;
        // Category → Asset Type. Style is not preset: the old Style control never
        // narrowed the trades, and the bar's Style would.
        if (filters.category && filters.category !== 'All') {
            _setBarValue('asset-type', filters.category.toLowerCase());
        }
        // Timeframe → date range preset
        if (filters.timeframe && filters.timeframe !== 'All') {
            _applyTimeframePreset(filters.timeframe);
        }
        _updateTradeCount();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Select a prompt and pre-fill the form
    // ─────────────────────────────────────────────────────────────────────────

    function selectPrompt(id) {
        _selectedPromptId = id;
        _rerunAccount = null;
        var runTab = document.getElementById('ai-run');
        if (runTab && runTab.classList.contains('active')) {
            _applyPromptToForm(id);
            _populatePromptSelector();
        }
    }

    function _applyPromptToForm(id, keepOutput) {
        var p = global._DenAriiPrompts;
        if (!p) return;

        var prompt = p.getPromptById(id);
        if (!prompt) return;

        var sel = document.getElementById('ai-run-prompt-select');
        if (sel) sel.value = id;

        var ta = document.getElementById('ai-run-prompt-text');
        if (ta) ta.value = prompt.promptText || '';

        if (prompt.category && prompt.category !== 'All') {
            _setBarValue('asset-type', prompt.category.toLowerCase());
        }
        if (prompt.timeframe && prompt.timeframe !== 'All') {
            _applyTimeframePreset(prompt.timeframe);
        }

        _updateTradeCount();
        // A new prompt clears the whole result (body, header and the
        // response a revisit would restore) together.
        if (!keepOutput) {
            _lastResponse = null;
            _clearOutput();
        }
    }

    function onPromptSelectChange(val) {
        if (!val) return;
        _selectedPromptId = val;
        _rerunAccount = null;
        _applyPromptToForm(val);
    }

    // Sets a bar control; a value it does not offer falls back to All.
    function _setBarValue(name, val) {
        var el = document.getElementById('ai-run-' + name);
        if (!el) return;
        el.value = val;
        if (el.value !== val) el.value = 'all';
    }

    function _setBarDates(from, to) {
        _setBarValue('period', 'custom');
        var fromEl = document.getElementById('ai-run-from');
        var toEl   = document.getElementById('ai-run-to');
        if (fromEl) fromEl.value = from || '';
        if (toEl)   toEl.value   = to   || '';
    }

    /** Loads a saved report's filters into the bar (Reuse Prompt). */
    function setFilters(f) {
        _rerunAccount = f.accountFilter || 'all';
        _setBarValue('asset-type', f.instrumentType || 'all');
        _setBarValue('style',      f.styleFilter    || 'all');
        _setBarValue('strategy',   f.strategyFilter || 'all');
        if (f.dateRange && (f.dateRange.start || f.dateRange.end)) {
            _setBarDates(f.dateRange.start, f.dateRange.end);
        } else {
            _setBarValue('period', 'all');
            _setBarValue('from', '');
            _setBarValue('to', '');
        }
        // Reports saved before Symbol was stored have none: treated as blank.
        var symbolEl = document.getElementById('ai-run-symbol');
        if (symbolEl) symbolEl.value = f.symbol || '';
        _updateTradeCount();
        var strategyEl = document.getElementById('ai-run-strategy');
        if (_rerunAccountGone()) _setRunStatus(_ACCOUNT_GONE_MSG, 'error');
        else if (f.strategyFilter && strategyEl && strategyEl.value !== f.strategyFilter) _setRunStatus(_STRATEGY_GONE_MSG, 'error');
        else _setRunStatus('', '');
    }

    function _applyTimeframePreset(timeframe) {
        var today = new Date();
        var start = new Date();
        if (timeframe === 'Today') {
            // same day — no change to start
        } else if (timeframe === 'Week') {
            start.setDate(today.getDate() - 7);
        } else if (timeframe === 'Month') {
            start.setMonth(today.getMonth() - 1);
        } else if (timeframe === 'Year') {
            start.setFullYear(today.getFullYear() - 1);
        } else {
            _setBarValue('period', 'all');
            return;
        }
        _setBarDates(DenariiFilters.localDateStr(start), DenariiFilters.localDateStr(today));
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Execute
    // ─────────────────────────────────────────────────────────────────────────

    async function execute() {
        if (_isRunning) return;

        var promptText = (document.getElementById('ai-run-prompt-text') || {}).value;
        if (!promptText || !promptText.trim()) {
            _setRunStatus('Choose a prompt or type a prompt first.', 'error');
            return;
        }

        if (_rerunAccountGone()) {
            _setRunStatus(_ACCOUNT_GONE_MSG, 'error');
            return;
        }

        var rawUserPrompt = promptText.trim();

        // Build filters object (reused for pre-flight and the actual request)
        var filtersObj = _readFilters();
        var account        = filtersObj.accountFilter;
        var accountDisplay = 'All Accounts';
        if (account) {
            try {
                var _acct = journalData.brokerAccounts.find(function(a) { return a.id === account; });
                if (_acct) accountDisplay = _acct.displayName || _acct.broker;
            } catch (e) {}
        }

        // Always include trade data: what the shared filter bar selects
        var allTrades = [];
        try {
            allTrades = (typeof journalData !== 'undefined' && journalData.trades)
                ? journalData.trades : [];
        } catch (e) { allTrades = []; }
        var selectedTrades = _selectedTrades(allTrades);

        // Pre-flight: abort if no trades match the current filters
        var filteredCount = selectedTrades.length;
        if (global._DenAriiAIFormatter) {
            var testPayload = global._DenAriiAIFormatter.buildPayload(
                Object.assign({ tradeData: selectedTrades }, filtersObj)
            );
            filteredCount = testPayload.trades.length;
        }

        if (filteredCount === 0) {
            _setRunStatus('No trades match the current filters. Adjust filters to run analysis.', 'error');
            return;
        }

        // Build full request — always use the report prompt wrapper
        var request = {
            promptText: _wrapReportPrompt(rawUserPrompt),
            tradeData: selectedTrades,
        };
        if (filtersObj.accountFilter)  request.accountFilter  = filtersObj.accountFilter;
        if (filtersObj.strategyFilter) request.strategyFilter = filtersObj.strategyFilter;
        if (filtersObj.instrumentType) request.instrumentType = filtersObj.instrumentType;
        if (filtersObj.styleFilter)    request.styleFilter    = filtersObj.styleFilter;
        if (filtersObj.symbol)         request.symbol         = filtersObj.symbol;
        if (filtersObj.dateRange)      request.dateRange      = filtersObj.dateRange;

        // Store analysis meta for the output header
        _lastAnalysisMeta = {
            tradeCount:     filteredCount,
            filters:        filtersObj,
            accountDisplay: filtersObj.accountFilter ? accountDisplay : null,
            strategy:       filtersObj.strategyFilter || null,
            instrument:     filtersObj.instrumentType || null,
            style:          filtersObj.styleFilter    || null,
            symbol:         filtersObj.symbol,
            dateFrom:       filtersObj.dateRange ? filtersObj.dateRange.start : null,
            dateTo:         filtersObj.dateRange ? filtersObj.dateRange.end   : null,
        };

        // UI: loading
        _isRunning = true;
        _lastParsedStructured = null;
        _lastCutOff = false;
        _showState('loading');
        _setRunStatus('Sending to Gemini…', 'loading');
        var btn = document.getElementById('ai-run-btn');
        if (btn) { btn.disabled = true; btn.textContent = 'Running…'; }

        try {
            var ai = global.DenAriiAI;
            if (!ai) throw new Error('AI service not loaded.');

            var resp = await ai.query(request, {
                providerConfig: { feature: 'run-analysis', timeoutMs: 180000, thinkingLevel: 'low' }
            });
            _lastResponse = resp;

            // Show the trades actually sent; the provider trims large payloads
            // to the most recent ones.
            if (typeof resp.tradesSent === 'number') {
                _lastAnalysisMeta.tradeCount    = resp.tradesSent;
                _lastAnalysisMeta.tradesTrimmed = !!resp.tradesTrimmedFrom;
            }

            console.log('[DenAriiAI] Response received:',
                'success=' + resp.success,
                'fingerprint=' + (resp.fingerprint || 'n/a'),
                'rawText.length=' + (resp.rawText ? resp.rawText.length : 0),
                'preview=' + (resp.rawText ? JSON.stringify(resp.rawText.slice(0, 300)) : '(none)')
            );

            // Always attempt structured parse; fall back to markdown if it fails
            if (resp.success) {
                // The saved report's account was for this run; a failed run can retry on it.
                _rerunAccount = null;
                _updateTradeCount();
                _lastParsedStructured = _tryParseStructured(resp.rawText);
                if (!_lastParsedStructured) {
                    console.warn('[DenAriiAI] Structured parse failed — rendering as markdown.');
                }
            }

            _renderOutput(resp);
        } catch (e) {
            _setRunStatus('Unexpected error: ' + e.message, 'error');
        } finally {
            _isRunning = false;
            if (btn) { btn.disabled = false; btn.textContent = 'Run Analysis'; }
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Response parsing — layered pipeline:
    //   1. Normalize (strip fences, trim)
    //   2. Sanitize (escape literal control chars inside JSON strings)
    //   3. JSON.parse attempts (direct, extracted block, trailing-comma fix)
    //   4. Regex field extraction if JSON.parse still fails
    //   5. Prose fallback if content is not JSON at all
    //   6. True error only when response is genuinely empty/unusable
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Walk the string character-by-character and escape literal control
     * characters that appear inside JSON string values.  This is the most
     * common reason Gemini-generated JSON fails JSON.parse — the model emits
     * real newlines (\n) inside strings instead of the two-char escape \\n.
     */
    function _sanitizeJsonStrings(str) {
        var out  = [];
        var inStr = false;
        var esc   = false;
        for (var i = 0; i < str.length; i++) {
            var c = str[i];
            if (esc)                     { out.push(c); esc = false; continue; }
            if (c === '\\' && inStr)     { out.push(c); esc = true;  continue; }
            if (c === '"')               { inStr = !inStr; out.push(c); continue; }
            if (inStr) {
                if      (c === '\n') { out.push('\\n'); continue; }
                else if (c === '\r') { continue; }           // bare CR — discard
                else if (c === '\t') { out.push('\\t'); continue; }
            }
            out.push(c);
        }
        return out.join('');
    }

    /** Strip code fences and leading/trailing whitespace. */
    function _stripFences(str) {
        return str
            .replace(/^```(?:json)?\s*\n?/i, '')
            .replace(/\n?```\s*$/i, '')
            .trim();
    }

    /** Remove trailing commas before } or ] — common LLM JSON mistake. */
    function _fixTrailingCommas(str) {
        return str.replace(/,(\s*[}\]])/g, '$1');
    }

    /**
     * Walk balanced braces to extract the outermost {...} block.
     * Handles surrounding prose before/after the JSON object.
     */
    function _extractJsonBlock(str) {
        var start = str.indexOf('{');
        if (start === -1) return null;
        var depth = 0;
        for (var i = start; i < str.length; i++) {
            if      (str[i] === '{') depth++;
            else if (str[i] === '}') { depth--; if (depth === 0) return str.slice(start, i + 1); }
        }
        return null;  // unbalanced — truncated response
    }

    /**
     * Attempt JSON.parse on a single candidate string.
     * Returns the parsed object if it looks like report data, otherwise null.
     */
    function _jsonParse(str) {
        try {
            var data = JSON.parse(str);
            if (data && typeof data === 'object' && !Array.isArray(data)) {
                // New schema: sections array (flexible headings)
                if (Array.isArray(data.sections) && data.sections.length) return data;
                // Legacy schema: flat named fields
                if (data.summary || data.key_findings || data.strengths || data.weaknesses ||
                    data.recommendations || data.metrics || data.title || data.bottom_line || data.evidence) {
                    return data;
                }
            }
        } catch (e) { /* silent */ }
        return null;
    }

    /**
     * Multi-stage JSON parser.  Tries increasingly aggressive normalizations
     * so a well-intentioned but slightly malformed response still renders.
     */
    function _tryParseStructured(rawText) {
        var raw = String(rawText || '').trim();
        console.log('[DenAriiAI] Parsing response (' + raw.length + ' chars)…');

        // Stage 1 — fence-stripped direct parse
        var s1 = _stripFences(raw);
        var r = _jsonParse(s1);
        if (r) { console.log('[DenAriiAI] Parse ok: stage 1 (direct)'); return r; }

        // Stage 2 — sanitize literal control chars inside strings, then parse
        var s2 = _sanitizeJsonStrings(s1);
        r = _jsonParse(s2);
        if (r) { console.log('[DenAriiAI] Parse ok: stage 2 (sanitized)'); return r; }

        // Stage 3 — extract balanced JSON block (handles surrounding prose)
        var block = _extractJsonBlock(raw);
        if (block) {
            r = _jsonParse(block);
            if (r) { console.log('[DenAriiAI] Parse ok: stage 3 (extracted block)'); return r; }

            var blockSan = _sanitizeJsonStrings(block);
            r = _jsonParse(blockSan);
            if (r) { console.log('[DenAriiAI] Parse ok: stage 4 (sanitized block)'); return r; }

            // Stage 5 — trailing commas + sanitized block
            r = _jsonParse(_fixTrailingCommas(blockSan));
            if (r) { console.log('[DenAriiAI] Parse ok: stage 5 (fixed+sanitized block)'); return r; }
        }

        // Stage 6 — trailing commas in full sanitized string
        r = _jsonParse(_fixTrailingCommas(s2));
        if (r) { console.log('[DenAriiAI] Parse ok: stage 6 (fixed sanitized)'); return r; }

        console.warn('[DenAriiAI] All JSON parse stages failed. Handing off to field extractor. len=' + raw.length);
        return null;
    }

    /**
     * Regex-based field extractor.  Used when JSON.parse fails entirely but
     * the response still contains recognisable key/value pairs.
     * Returns a partial data object (good enough to render a report) or null.
     */
    function _extractFieldsByRegex(str) {
        var data = {};

        // ── Scalar string fields ────────────────────────────────────────────
        ['title', 'summary', 'bottom_line'].forEach(function (field) {
            var re = new RegExp('"' + field + '"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"');
            var m  = str.match(re);
            if (m) {
                data[field] = m[1]
                    .replace(/\\n/g, '\n').replace(/\\t/g, '\t')
                    .replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            }
        });

        // ── New schema: sections array ──────────────────────────────────────
        // Walk all occurrences of {"heading":"...","items":[...]} in the string.
        // Used when the model responded with the new flexible schema but JSON.parse failed.
        var sectionsIdx = str.indexOf('"sections"');
        if (sectionsIdx !== -1) {
            var sections = [];
            // Scan for heading+items pairs
            var pos = sectionsIdx;
            while (pos < str.length) {
                var hIdx = str.indexOf('"heading"', pos);
                if (hIdx === -1) break;
                var hValStart = str.indexOf('"', hIdx + 9);
                if (hValStart === -1) break;
                hValStart++; // skip opening quote
                var hValEnd = -1;
                for (var hi = hValStart; hi < str.length; hi++) {
                    if (str[hi] === '\\') { hi++; continue; }
                    if (str[hi] === '"') { hValEnd = hi; break; }
                }
                if (hValEnd === -1) break;
                var heading = str.slice(hValStart, hValEnd)
                    .replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');

                // Find the items array that follows
                var iIdx = str.indexOf('"items"', hIdx);
                if (iIdx === -1 || iIdx > hIdx + 300) { pos = hValEnd + 1; continue; }
                var arrStart = str.indexOf('[', iIdx + 7);
                if (arrStart === -1) { pos = hValEnd + 1; continue; }
                var depth = 0, arrEnd = -1;
                for (var ai = arrStart; ai < str.length; ai++) {
                    if      (str[ai] === '[') depth++;
                    else if (str[ai] === ']') { depth--; if (depth === 0) { arrEnd = ai; break; } }
                }
                var items = [];
                if (arrEnd !== -1) {
                    var content = str.slice(arrStart + 1, arrEnd);
                    var itemRe = /"((?:[^"\\]|\\.)*)"/g, im;
                    while ((im = itemRe.exec(content)) !== null) {
                        var v = im[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
                        if (v.trim()) items.push(v);
                    }
                }
                if (heading && items.length) sections.push({ heading: heading, items: items });
                pos = (arrEnd !== -1 ? arrEnd : hValEnd) + 1;
            }
            if (sections.length) data.sections = sections;
        }

        // ── Legacy schema: named array fields ──────────────────────────────
        ['key_findings', 'strengths', 'weaknesses', 'recommendations', 'evidence'].forEach(function (field) {
            var keyIdx = str.indexOf('"' + field + '"');
            if (keyIdx === -1) return;
            var arrStart = str.indexOf('[', keyIdx);
            if (arrStart === -1) return;
            var depth = 0, arrEnd = -1;
            for (var i = arrStart; i < str.length; i++) {
                if      (str[i] === '[') depth++;
                else if (str[i] === ']') { depth--; if (depth === 0) { arrEnd = i; break; } }
            }
            if (arrEnd === -1) return;
            var content = str.slice(arrStart + 1, arrEnd);
            var items = [], itemRe = /"((?:[^"\\]|\\.)*)"/g, m;
            while ((m = itemRe.exec(content)) !== null) {
                var v = m[1].replace(/\\n/g, '\n').replace(/\\t/g, '\t').replace(/\\"/g, '"');
                if (v.trim()) items.push(v);
            }
            if (items.length) data[field] = items;
        });

        // ── Legacy schema: metrics object ──────────────────────────────────
        var mIdx = str.indexOf('"metrics"');
        if (mIdx !== -1) {
            var mStart = str.indexOf('{', mIdx + 9);
            if (mStart !== -1) {
                var mEnd = str.indexOf('}', mStart);
                if (mEnd !== -1) {
                    var mContent = str.slice(mStart + 1, mEnd);
                    var metrics  = {}, mRe = /"([^"]+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g, mm;
                    while ((mm = mRe.exec(mContent)) !== null) metrics[mm[1]] = mm[2];
                    if (Object.keys(metrics).length) data.metrics = metrics;
                }
            }
        }

        var hasContent = data.sections || data.summary || data.key_findings ||
                         data.title    || data.bottom_line;
        if (hasContent) {
            console.log('[DenAriiAI] Regex extraction succeeded');
            return data;
        }
        console.warn('[DenAriiAI] Regex extraction found no usable fields');
        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Fallback report builder
    // Called only when all JSON.parse stages fail.
    // Tries regex extraction first; falls back to prose; uses error-state
    // only when the response is genuinely empty or completely unusable.
    // ─────────────────────────────────────────────────────────────────────────

    function _buildFallbackReport(rawText) {
        var str = String(rawText || '').trim();
        str = _stripFences(str);

        console.log('[DenAriiAI] Building fallback report (' + str.length + ' chars)');

        if (!str) {
            console.warn('[DenAriiAI] Fallback: empty response');
            return { _error: 'The model returned an empty response. Please try again.' };
        }

        // Looks like JSON that failed to parse → try regex extraction
        if (str.charAt(0) === '{') {
            var extracted = _extractFieldsByRegex(str);
            if (extracted) {
                // Only return structured data if there's real body content beyond a title.
                // A title-only result means the JSON was truncated — fall through to prose.
                var hasBody = extracted.summary || extracted.bottom_line ||
                    (extracted.key_findings && extracted.key_findings.length) ||
                    (extracted.strengths && extracted.strengths.length) ||
                    (extracted.weaknesses && extracted.weaknesses.length) ||
                    (extracted.recommendations && extracted.recommendations.length) ||
                    (extracted.evidence && extracted.evidence.length);
                if (hasBody) return extracted;
                console.warn('[DenAriiAI] Fallback: regex found only title — JSON likely truncated, stripping to prose');
            }
            // Truly unparseable JSON — last resort: strip JSON syntax and render whatever text survives
            var prose = str
                .replace(/"[a-z_]+":/g, '')         // remove "key":
                .replace(/[{}[\]]/g, '')              // remove braces/brackets
                .replace(/"((?:[^"\\]|\\.)*)"/g, '$1') // unwrap quoted strings
                .replace(/,\s*\n/g, '\n')             // remove trailing commas
                .replace(/\n{3,}/g, '\n\n')           // collapse blank lines
                .trim();
            if (prose.length > 20) {
                console.log('[DenAriiAI] Fallback: JSON stripped to prose');
                return { title: 'Analysis Report', _prose: prose };
            }
            console.warn('[DenAriiAI] Fallback: response unusable after stripping');
            return { _error: 'The analysis completed but the response format could not be read. Please try again.' };
        }

        // Plain prose or markdown → render directly
        console.log('[DenAriiAI] Fallback: treating response as prose/markdown');
        return { title: 'Analysis Report', _prose: str };
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Report renderer — polished, user-facing output.
    // Never exposes JSON syntax, field names, or developer details.
    // ─────────────────────────────────────────────────────────────────────────

    function _renderReport(data) {
        var html = '<div class="ai-struct-output">';

        // ── Error state — genuinely unusable response ──────────────────────
        if (data._error) {
            html += '<div class="ai-struct-section">';
            html += '<p style="font-size:14px;color:var(--text-secondary);line-height:1.6;margin:0;">' +
                    _esc(String(data._error)) + '</p>';
            html += '</div></div>';
            return html;
        }

        // ── Report Title ───────────────────────────────────────────────────
        var title = (data.title && String(data.title).trim()) || 'Analysis Report';
        html += '<div style="padding-bottom:14px;border-bottom:1px solid var(--border);margin-bottom:4px;">';
        html += '<h2 style="font-size:18px;font-weight:700;color:var(--text-primary);margin:0;">' + _esc(title) + '</h2>';
        html += '</div>';

        // ── Prose fallback ─────────────────────────────────────────────────
        if (data._prose) {
            html += '<div class="ai-struct-section ai-md-output">' + _renderMarkdown(data._prose) + '</div>';
            html += '</div>';
            return html;
        }

        // ── Executive Summary ──────────────────────────────────────────────
        if (data.summary) {
            html += '<div class="ai-struct-section">';
            html += '<div class="ai-struct-section-label">Executive Summary</div>';
            html += '<p class="ai-struct-summary">' + _esc(String(data.summary)) + '</p>';
            html += '</div>';
        }

        // ── New flexible schema: sections array ────────────────────────────
        if (Array.isArray(data.sections) && data.sections.length) {
            data.sections.forEach(function (section) {
                if (!section || !section.heading) return;
                var items = _toList(section.items);
                if (!items.length) return;
                html += '<div class="ai-struct-section">';
                html += '<div class="ai-struct-section-label">' + _esc(String(section.heading)) + '</div>';
                html += '<ul class="ai-struct-list">';
                items.forEach(function (item) { html += '<li>' + _esc(item) + '</li>'; });
                html += '</ul></div>';
            });
        } else {
            // ── Legacy schema: flat named fields (backwards compat for old saves) ──

            // Top Findings
            var findings = _toList(data.key_findings);
            if (findings.length) {
                html += '<div class="ai-struct-section">';
                html += '<div class="ai-struct-section-label">Top Findings</div>';
                html += '<ul class="ai-struct-list">';
                findings.forEach(function (item) { html += '<li>' + _esc(item) + '</li>'; });
                html += '</ul></div>';
            }

            // Evidence / Strengths / Weaknesses
            var evidence   = _toList(data.evidence);
            var strengths  = _toList(data.strengths);
            var weaknesses = _toList(data.weaknesses);
            if (evidence.length || strengths.length || weaknesses.length) {
                html += '<div class="ai-struct-section">';
                html += '<div class="ai-struct-section-label">Evidence From Your Trades</div>';
                if (evidence.length) {
                    html += '<ul class="ai-struct-list">';
                    evidence.forEach(function (item) { html += '<li>' + _esc(item) + '</li>'; });
                    html += '</ul>';
                }
                if (strengths.length) {
                    html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--success);margin:10px 0 6px;">What\'s Working</div>';
                    html += '<ul class="ai-struct-list">';
                    strengths.forEach(function (item) { html += '<li>' + _esc(item) + '</li>'; });
                    html += '</ul>';
                }
                if (weaknesses.length) {
                    html += '<div style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:0.07em;color:var(--danger);margin:10px 0 6px;">What Needs Work</div>';
                    html += '<ul class="ai-struct-list">';
                    weaknesses.forEach(function (item) { html += '<li>' + _esc(item) + '</li>'; });
                    html += '</ul>';
                }
                html += '</div>';
            }

            // Metrics Snapshot
            if (data.metrics && typeof data.metrics === 'object' && !Array.isArray(data.metrics)) {
                var mKeys = Object.keys(data.metrics).filter(function (k) {
                    return data.metrics[k] != null && String(data.metrics[k]).trim();
                });
                if (mKeys.length) {
                    html += '<div class="ai-struct-section">';
                    html += '<div class="ai-struct-section-label">Metrics Snapshot</div>';
                    html += '<div class="ai-struct-metrics">';
                    mKeys.forEach(function (k) {
                        var label = k.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
                        html += '<div class="ai-struct-metric-row">';
                        html += '<span class="ai-struct-metric-label">' + _esc(label) + '</span>';
                        html += '<span class="ai-struct-metric-value">' + _esc(String(data.metrics[k])) + '</span>';
                        html += '</div>';
                    });
                    html += '</div></div>';
                }
            }

            // Action Plan
            var recs = _toList(data.recommendations);
            if (recs.length) {
                html += '<div class="ai-struct-section">';
                html += '<div class="ai-struct-section-label">Action Plan</div>';
                html += '<ol class="ai-struct-list" style="list-style:decimal;padding-left:20px;">';
                recs.forEach(function (item) { html += '<li>' + _esc(item) + '</li>'; });
                html += '</ol></div>';
            }
        }

        // ── Bottom Line (both schemas) ─────────────────────────────────────
        if (data.bottom_line) {
            html += '<div class="ai-struct-section">';
            html += '<div class="ai-struct-section-label">Bottom Line</div>';
            html += '<p style="font-size:14px;line-height:1.65;color:var(--text-primary);font-weight:600;margin:0;">' +
                    _esc(String(data.bottom_line)) + '</p>';
            html += '</div>';
        }

        html += '</div>';
        return html;
    }

    function _toList(val) {
        if (!val) return [];
        if (Array.isArray(val)) return val.map(function (v) { return String(v || '').trim(); }).filter(Boolean);
        var s = String(val).trim();
        return s ? [s] : [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Markdown rendering
    // ─────────────────────────────────────────────────────────────────────────

    function _renderMarkdown(text) {
        var str = String(text || '');
        try {
            if (typeof marked === 'undefined') throw new Error('marked not loaded');
            var html = marked.parse(str, { breaks: true, gfm: true });
            if (typeof DOMPurify === 'undefined') throw new Error('DOMPurify not loaded');
            return DOMPurify.sanitize(html, {
                USE_PROFILES: { html: true },
                FORBID_TAGS: ['script', 'style', 'iframe', 'form', 'input', 'button', 'textarea'],
                FORBID_ATTR: ['onerror', 'onload', 'onclick', 'onmouseover'],
            });
        } catch (e) {
            console.warn('[DenAriiAI] Markdown render fallback:', e.message);
            return '<pre class="ai-md-fallback">' + _esc(str) + '</pre>';
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Output panel state machine
    // States: 'empty' | 'loading' | 'error' | 'output'
    // ─────────────────────────────────────────────────────────────────────────

    function _showState(state, errorMsg) {
        var placeholder  = document.getElementById('ai-run-output-placeholder');
        var loading      = document.getElementById('ai-run-output-loading');
        var errorBlock   = document.getElementById('ai-run-output-error');
        var outputEl     = document.getElementById('ai-run-output');
        var badges       = document.getElementById('ai-output-badges');
        var dataSummary  = document.getElementById('ai-run-data-summary');

        if (placeholder)  placeholder.style.display  = 'none';
        if (loading)      loading.style.display      = 'none';
        if (errorBlock)   errorBlock.style.display   = 'none';
        if (outputEl)     outputEl.style.display     = 'none';
        if (badges)       badges.style.display       = 'none';
        if (dataSummary)  dataSummary.style.display  = 'none';

        // Stop any running elapsed timer when leaving loading state
        if (state !== 'loading') {
            if (_elapsedTimer) { clearInterval(_elapsedTimer); _elapsedTimer = null; }
            var elEl = document.getElementById('ai-run-elapsed');
            if (elEl) elEl.textContent = '';
        }

        if (state === 'empty') {
            if (placeholder) placeholder.style.display = '';
        } else if (state === 'loading') {
            if (loading) loading.style.display = '';
            // Start elapsed counter so the user knows the request is still in progress
            _runStartTime = Date.now();
            if (_elapsedTimer) clearInterval(_elapsedTimer);
            _elapsedTimer = setInterval(function () {
                var el = document.getElementById('ai-run-elapsed');
                if (el && _runStartTime) {
                    var secs = Math.floor((Date.now() - _runStartTime) / 1000);
                    el.textContent = '(' + secs + 's…)';
                }
            }, 1000);
        } else if (state === 'error') {
            if (errorBlock) {
                errorBlock.innerHTML =
                    '<span class="ai-error-icon">⚠</span>' +
                    '<span>' + _esc(errorMsg || 'Request failed. Please try again.') + '</span>';
                errorBlock.style.display = 'flex';
            }
        } else if (state === 'output') {
            if (outputEl)    outputEl.style.display    = 'block';
            if (badges)      badges.style.display      = 'flex';
            if (dataSummary) dataSummary.style.display = 'block';
        }
    }

    function _updateMetaBadges(resp) {
        var modelBadge = document.getElementById('ai-output-model-badge');
        if (modelBadge) modelBadge.textContent = (resp.provider || '') + ' · ' + (resp.model || '');

        // Flash-Lite answered because the chosen model was busy or slow.
        var ai = global.DenAriiAI;
        var note = (ai && typeof ai.fallbackNote === 'function') ? ai.fallbackNote(resp) : '';
        var noteEl = document.getElementById('ai-output-fallback-note');
        if (!noteEl && note && modelBadge && modelBadge.parentNode) {
            noteEl = document.createElement('span');
            noteEl.id = 'ai-output-fallback-note';
            noteEl.style.cssText = 'color:var(--text-secondary);font-size:11px;align-self:center;';
            modelBadge.parentNode.insertBefore(noteEl, modelBadge.nextSibling);
        }
        if (noteEl) {
            noteEl.textContent = note;
            noteEl.style.display = note ? '' : 'none';
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Output rendering
    // ─────────────────────────────────────────────────────────────────────────

    // Returns true only if the parsed data has real body sections (not just a title).
    function _hasBodyContent(data) {
        if (!data || data._error) return false;
        if (data._prose) return true;
        // New schema: sections array with at least one non-empty section
        if (Array.isArray(data.sections)) {
            for (var i = 0; i < data.sections.length; i++) {
                if (_toList((data.sections[i] || {}).items).length > 0) return true;
            }
        }
        // Legacy schema: any of the flat named fields
        return !!(data.summary || data.bottom_line ||
            (data.key_findings    && data.key_findings.length)    ||
            (data.strengths       && data.strengths.length)       ||
            (data.weaknesses      && data.weaknesses.length)      ||
            (data.recommendations && data.recommendations.length) ||
            (data.evidence        && data.evidence.length));
    }

    function _renderOutput(resp) {
        if (resp.success) {
            _setRunStatus('', '');
            var outputEl = document.getElementById('ai-run-output');
            if (outputEl) {
                var reportData = _lastParsedStructured;
                // If structured parse yielded no body (title-only or null), force prose fallback
                if (!reportData || !_hasBodyContent(reportData)) {
                    if (reportData) {
                        console.warn('[DenAriiAI] Structured data has no body content — forcing prose fallback');
                    }
                    reportData = _buildFallbackReport(resp.rawText);
                }
                // Track what was actually rendered so saveOutput can persist it correctly
                _lastRenderedReportData = reportData;
                _lastCutOff = _isCutOff(resp);
                outputEl.innerHTML = (_lastCutOff ? _cutOffNoticeHtml() : '') + _renderReport(reportData);
                console.log('[DenAriiAI] Rendered body length:', outputEl.innerHTML.length);
            }
            _updateMetaBadges(resp);
            _renderDataSummary();
            _showState('output');
            // Gate Save button: disable when the report is an error state with no real content
            var saveBtn = document.getElementById('ai-save-btn');
            if (saveBtn) {
                var canSave = reportData && !reportData._error;
                saveBtn.disabled = !canSave;
                saveBtn.style.opacity = canSave ? '' : '0.45';
                saveBtn.title = canSave ? '' : 'Report could not be rendered — nothing to save';
            }
        } else {
            _setRunStatus('', '');
            var errMsg = resp.error || 'Request failed.';
            // Normalize provider-specific errors to user-friendly messages
            if (/429|rate.?limit|quota/i.test(errMsg)) errMsg = 'AI requests are temporarily limited by the provider. Wait a minute or two and try again. If this persists, you can add your own Gemini key in Settings \u2192 Integrations.';
            else if (/503|service.*unavailable|overloaded/i.test(errMsg)) errMsg = 'Gemini is temporarily unavailable \u2014 this usually resolves within a few minutes. Try again shortly.';
            else if (/timeout|timed?.?out|abort/i.test(errMsg)) errMsg = 'The request took too long. Try narrowing your filters to send less data, or try again in a moment. You can also choose a faster model (e.g. a Flash-Lite model) in Settings > Integrations.';
            else if (/401|403|unauthorized|forbidden/i.test(errMsg)) errMsg = 'API key issue. If you added a personal key in Settings \u2192 Integrations, double-check that it\u2019s valid.';
            _showState('error', errMsg);
        }
    }

    // The reply stopped early: Gemini says it hit the output limit, or the
    // JSON it started never closes.
    function _isCutOff(resp) {
        if (!resp) return false;
        if (resp.truncated || resp.finishReason === 'MAX_TOKENS') return true;
        var str = _stripFences(String(resp.rawText || '').trim());
        return str.charAt(0) === '{' && !_extractJsonBlock(str);
    }

    var _CUT_OFF_MSG = 'This report was cut off before it finished. Try fewer trades or run it again.';

    function _cutOffNoticeHtml() {
        return '<div class="ai-cutoff-notice" role="status" style="margin-bottom:12px;padding:10px 12px;' +
            'border:1px solid var(--warning);border-left-width:3px;border-radius:8px;background:var(--bg-tertiary);' +
            'color:var(--text-primary);font-size:13px;line-height:1.5;">' + _esc(_CUT_OFF_MSG) + '</div>';
    }

    function _renderDataSummary() {
        var el = document.getElementById('ai-run-data-summary');
        if (!el || !_lastAnalysisMeta) return;
        var m = _lastAnalysisMeta;

        var items = [];
        items.push('<strong>' + _tradeCountLabel(m.tradeCount, m.tradesTrimmed) + '</strong>');
        if (m.accountDisplay) items.push('Account: ' + _esc(m.accountDisplay));
        if (m.strategy)       items.push('Strategy: ' + _esc(DenariiFilters.strategyLabel(m.strategy)));
        if (m.instrument) {
            var instrLabel = m.instrument.charAt(0).toUpperCase() + m.instrument.slice(1);
            items.push('Instrument: ' + _esc(instrLabel));
        }
        if (m.style)    items.push('Style: ' + _esc(m.style.replace(/_/g, ' ')));
        if (m.symbol)   items.push('Symbol: ' + _esc(m.symbol));
        if (m.dateFrom || m.dateTo) {
            items.push('Date: ' + _esc((m.dateFrom || '…') + ' → ' + (m.dateTo || '…')));
        }

        el.innerHTML =
            '<div style="font-size:12px;color:var(--text-secondary);line-height:1.7;">' +
            items.join('&nbsp; <span style="opacity:0.4">·</span> &nbsp;') +
            '</div>' +
            '<div style="font-size:11px;color:var(--text-secondary);opacity:0.65;margin-top:3px;">' +
            'This report is based on your filtered trade data.' +
            '</div>';
    }

    // "300 trades analyzed (most recent)" when trimmed, else "12 trades analyzed".
    function _tradeCountLabel(count, trimmed) {
        return count + ' trade' + (count !== 1 ? 's' : '') + ' analyzed' + (trimmed ? ' (most recent)' : '');
    }

    function _clearOutput() {
        _lastParsedStructured   = null;
        _lastRenderedReportData = null;
        _lastAnalysisMeta       = null;
        _lastCutOff             = false;
        var outputEl    = document.getElementById('ai-run-output');
        var summaryEl   = document.getElementById('ai-run-data-summary');
        if (outputEl)  outputEl.innerHTML  = '';
        if (summaryEl) summaryEl.innerHTML = '';
        _showState('empty');
        _setRunStatus('', '');
    }

    function _setRunStatus(msg, type) {
        var el = document.getElementById('ai-run-status');
        if (!el) return;
        if (!msg) { el.textContent = ''; el.style.display = 'none'; return; }
        el.textContent = msg;
        el.style.color = type === 'error'   ? 'var(--danger)'
                       : type === 'loading' ? 'var(--text-secondary)'
                       : 'var(--success)';
        el.style.display = 'block';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Copy, Save, Clear — public panel actions
    // ─────────────────────────────────────────────────────────────────────────

    async function copyOutput() {
        if (!_lastResponse || !_lastResponse.rawText) {
            _showOutputToast('Nothing to copy.', true);
            return;
        }
        var text = _lastResponse.rawText;
        try {
            await navigator.clipboard.writeText(text);
            _showCopyConfirm();
        } catch (e) {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
                _showCopyConfirm();
            } catch (e2) {
                _showOutputToast('Copy failed — try selecting the text manually.', true);
            }
        }
    }

    function _showCopyConfirm() {
        var btn = document.getElementById('ai-copy-btn');
        if (btn) {
            var orig = btn.textContent;
            btn.textContent = 'Copied ✓';
            btn.disabled = true;
            setTimeout(function () { btn.textContent = orig; btn.disabled = false; }, 1800);
        }
        _showOutputToast('Copied to clipboard.');
    }

    async function saveOutput() {
        if (!_lastResponse || !_lastResponse.rawText ||
                _lastResponse.rawText === 'No response returned.') {
            _showOutputToast('Nothing to save.', true);
            return;
        }
        try {
            if (typeof journalData === 'undefined') throw new Error('App not ready.');
            if (!Array.isArray(journalData.aiOutputHistory)) journalData.aiOutputHistory = [];

            var promptTitle = null;
            if (_selectedPromptId && global._DenAriiPrompts) {
                var pr = global._DenAriiPrompts.getPromptById(_selectedPromptId);
                if (pr) promptTitle = pr.title;
            }

            // Save original user prompt (not the structured wrapper)
            var promptTextEl = document.getElementById('ai-run-prompt-text');
            var promptText   = promptTextEl ? String(promptTextEl.value || '').trim() : null;

            // The filters the report ran with, not what the bar and header show now.
            var filters = Object.assign({}, (_lastAnalysisMeta && _lastAnalysisMeta.filters) || _readFilters());
            // Trades actually sent, shown in Saved Reports.
            if (_lastAnalysisMeta && typeof _lastAnalysisMeta.tradeCount === 'number') {
                filters.tradeCount    = _lastAnalysisMeta.tradeCount;
                filters.tradesTrimmed = !!_lastAnalysisMeta.tradesTrimmed;
            }
            // Cut off at the output limit: Saved Reports shows the same notice.
            if (_lastCutOff) filters.cutOff = true;

            var entry = {
                id:             _lastResponse.requestId
                                    ? 'out-' + _lastResponse.requestId
                                    : 'out-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6),
                createdAt:      new Date().toISOString(),
                promptTitle:    promptTitle   || null,
                promptText:     promptText    || null,
                rawText:        String(_lastResponse.rawText || '').trim(),
                provider:       _lastResponse.provider   || null,
                model:          _lastResponse.model      || null,
                durationMs:     _lastResponse.durationMs != null ? _lastResponse.durationMs : null,
                filters:        filters,
                // Prefer the full rendered report data (includes fallback/prose shapes);
                // fall back to the raw structured parse, then null for very old saves.
                structuredData: _lastRenderedReportData || _lastParsedStructured || null,
                fingerprint:    _lastResponse.fingerprint || null,
            };

            journalData.aiOutputHistory.unshift(entry);

            // Cloud-primary: upsert report to Supabase. Wait for it (capped) so
            // the save below sees the row as sent and does not insert it again.
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                try {
                    await Promise.race([
                        _saveAiReportToSupabase(entry),
                        new Promise(function (r) { setTimeout(r, 5000); })
                    ]);
                } catch (e) { /* the save below sends it */ }
            }

            if (typeof saveToIndexedDB === 'function') await saveToIndexedDB();

            _showOutputToast('Output saved to history.');
            var btn = document.getElementById('ai-save-btn');
            if (btn) {
                var orig = btn.textContent;
                btn.textContent = 'Saved ✓';
                btn.disabled = true;
                setTimeout(function () { btn.textContent = orig; btn.disabled = false; }, 1800);
            }
        } catch (e) {
            _showOutputToast('Could not save: ' + e.message, true);
        }
    }

    function clearOutputPanel() {
        _lastResponse = null;
        _clearOutput();
    }

    function _showOutputToast(msg, isError) {
        var toast = document.getElementById('ai-toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.style.background = isError ? 'var(--danger)' : 'var(--success)';
        toast.style.color = isError ? 'var(--on-danger)' : '';
        toast.classList.add('active');
        setTimeout(function () { toast.classList.remove('active'); }, 2500);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────

    function _esc(str) {
        return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Expose
    // ─────────────────────────────────────────────────────────────────────────

    global.AIRun = {
        init,
        selectPrompt,
        applyTradeFilters,
        setFilters,
        execute,
        onPromptSelectChange,
        copyOutput,
        saveOutput,
        clearOutputPanel,
        // Shared renderer — used by Saved Reports for a consistent display
        renderReport: _renderReport,
        cutOffNoticeHtml: _cutOffNoticeHtml,
    };

    // Mounted once at load, so the Prompt Library can preset it before the first visit.
    DenariiFilters.mountFilterBar(document.getElementById('ai-run-filter-bar'), {
        prefix: 'ai-run',
        onChange: _updateTradeCount
    });
    if (typeof _populateStyleSelect === 'function') _populateStyleSelect('ai-run-style', true);

}(window));
