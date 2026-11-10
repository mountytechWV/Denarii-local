/**
 * @file ai-reports.js
 * Saved Reports — browse, open, delete, and reuse saved AI outputs.
 * Exposes window.AIReports.
 *
 * Depends on:
 *  - Denarii.js globals: journalData, saveToIndexedDB, activateSection
 *  - marked, DOMPurify (CDN) — markdown rendering
 */

(function (global) {

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    var _viewMode      = 'list';   // 'list' | 'viewer'
    var _currentReport = null;

    var _searchQuery      = '';
    var _filterProvider   = 'all';
    var _sortOrder        = 'newest';
    var _barEl            = null;      // kept across list renders and the viewer

    // Run Analysis's old Style labels, as older reports stored them.
    var LEGACY_STYLES = {
        'Day Trade': 'day_trading', 'Swing': 'swing_trading',
        'Position': 'position_trading', 'Investing': 'investing'
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Entry point — called by activateSection('ai-reports')
    // ─────────────────────────────────────────────────────────────────────────

    function render() {
        if (_viewMode === 'viewer' && _currentReport) {
            _showViewer(_currentReport);
        } else {
            _viewMode = 'list';
            _renderList();
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Data access
    // ─────────────────────────────────────────────────────────────────────────

    function _getHistory() {
        try {
            return (typeof journalData !== 'undefined' && Array.isArray(journalData.aiOutputHistory))
                ? journalData.aiOutputHistory : [];
        } catch (e) { return []; }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // List view
    // ─────────────────────────────────────────────────────────────────────────

    function _renderList() {
        _viewMode = 'list';
        var container = document.getElementById('ai-reports');
        if (!container) return;

        var history = _getHistory();

        var html = '<div class="ai-reports-layout">';

        html += '<div id="ai-reports-bar-slot" style="margin-bottom:12px;"></div>';

        // ── Report search and sort ──
        html += '<div class="ai-filter-bar" style="margin-bottom:18px;">';
        html += '<input id="ai-reports-search" class="ai-filter-search" type="search" placeholder="Search reports…"' +
                ' value="' + _esc(_searchQuery) + '" oninput="AIReports.onSearch(this.value)">';
        html += '<select class="ai-filter-select" id="ai-reports-filter-provider"   onchange="AIReports.onFilterChange(\'provider\',this.value)"><option value="all">All Providers</option></select>';
        html += '<select class="ai-filter-select" onchange="AIReports.onSortChange(this.value)">';
        html += '<option value="newest"' + (_sortOrder === 'newest' ? ' selected' : '') + '>Newest First</option>';
        html += '<option value="oldest"' + (_sortOrder === 'oldest' ? ' selected' : '') + '>Oldest First</option>';
        html += '</select>';
        html += '</div>';

        html += '<div id="ai-reports-results"></div>';

        html += '</div>'; // end layout
        container.innerHTML = html;

        _attachBar(document.getElementById('ai-reports-bar-slot'));

        // Populate filter dropdowns after DOM is ready
        _populateFilterOptions(history);

        _renderResults();
    }

    // Only the results redraw on a filter change, so typing keeps focus.
    function _renderResults() {
        var container = document.getElementById('ai-reports-results');
        if (!container) return;

        var history  = _getHistory();
        var filtered = _applyFilters(history);
        var html = '';

        // ── Cards or empty/no-results state ──
        if (history.length === 0) {
            html += _emptyStateHTML();
        } else if (filtered.length === 0) {
            html += '<div class="ai-reports-no-results">' +
                    '<p>No reports match your filters.</p>' +
                    '<button class="btn btn-secondary btn-small" onclick="AIReports.clearFilters()">Clear Filters</button>' +
                    '</div>';
        } else {
            html += '<div class="ai-report-grid">';
            filtered.forEach(function (r) { html += _reportCardHTML(r); });
            html += '</div>';
        }

        container.innerHTML = html;

        // Wire up card click and delete button handlers (avoid inline onclick)
        var cards = container.querySelectorAll('.ai-report-card[data-report-id]');
        cards.forEach(function (card) {
            card.addEventListener('click', function (e) {
                AIReports.openReport(card.getAttribute('data-report-id'));
            });
        });
        var deleteBtns = container.querySelectorAll('.ai-report-delete-btn[data-delete-id]');
        deleteBtns.forEach(function (btn) {
            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                AIReports.deleteReport(btn.getAttribute('data-delete-id'));
            });
        });
    }

    // One bar for the page's life, re-attached after each list render. Reports
    // store no symbol, so its filter is removed.
    function _attachBar(slot) {
        if (!slot) return;
        var isNew = !_barEl;
        if (isNew) {
            _barEl = document.createElement('div');
            _barEl.className = 'snap-filter-bar';
            _barEl.id = 'ai-reports-filter-bar';
        }
        slot.appendChild(_barEl);
        if (isNew) {
            DenariiFilters.mountFilterBar(_barEl, { prefix: 'ai-reports', onChange: _renderResults });
            var symbolGroup = document.getElementById('ai-reports-fg-symbol');
            if (symbolGroup) symbolGroup.remove();
            if (typeof _populateStyleSelect === 'function') _populateStyleSelect('ai-reports-style', true);
        }
    }

    function _reportCardHTML(r) {
        var title   = _esc(r.promptTitle || 'Untitled Report');
        var date    = _formatDate(r.createdAt);
        var model   = [r.provider, r.model].filter(Boolean).join(' · ');
        var snippet = _textSnippet(r.rawText, 200);
        var safeId  = _esc(r.id || '');

        var html = '<div class="ai-report-card" data-report-id="' + safeId + '">';

        html += '<div class="ai-report-card-header">';
        html += '<div class="ai-report-card-title">' + title + '</div>';
        html += '<div class="ai-report-card-date">' + _esc(date) + '</div>';
        html += '</div>';

        var countText = _tradeCountText(r.filters);
        if (model || r.durationMs != null || countText) {
            html += '<div class="ai-report-card-badges">';
            if (model)            html += '<span class="ai-output-badge">' + _esc(model) + '</span>';
            if (r.durationMs != null) html += '<span class="ai-output-badge ai-output-badge-muted">' + r.durationMs + ' ms</span>';
            if (countText)        html += '<span class="ai-output-badge ai-output-badge-muted">' + _esc(countText) + '</span>';
            html += '</div>';
        }

        var pills = _filterPills(r.filters);
        if (pills) html += '<div class="ai-report-filter-pills">' + pills + '</div>';

        var snippetClass = snippet === 'No preview available.'
            ? 'ai-report-snippet ai-report-snippet-empty'
            : 'ai-report-snippet';
        html += '<div class="' + snippetClass + '">' + _esc(snippet) + '</div>';

        html += '<div class="ai-report-card-footer">';
        html += '<button class="btn btn-secondary btn-small ai-report-delete-btn"' +
                ' data-delete-id="' + safeId + '"' +
                ' title="Delete this report">Delete</button>';
        html += '</div>';

        html += '</div>';
        return html;
    }

    // Trade count Run Analysis saved with the report; '' for older reports.
    function _tradeCountText(filters) {
        var n = filters && filters.tradeCount;
        if (typeof n !== 'number') return '';
        return n + ' trade' + (n !== 1 ? 's' : '') + ' analyzed' + (filters.tradesTrimmed ? ' (most recent)' : '');
    }

    function _filterPills(filters) {
        if (!filters) return '';
        var parts = [];
        if (filters.instrumentType) parts.push(filters.instrumentType);
        if (filters.styleFilter)    parts.push(filters.styleFilter.replace(/_/g, ' '));
        if (filters.strategyFilter) parts.push(DenariiFilters.strategyLabel(filters.strategyFilter));
        if (filters.symbol)         parts.push(filters.symbol.toUpperCase());
        if (filters.accountFilter)  parts.push('acct: ' + filters.accountFilter.slice(-6));
        if (filters.dateRange && (filters.dateRange.start || filters.dateRange.end)) {
            parts.push([filters.dateRange.start, filters.dateRange.end].filter(Boolean).join(' – '));
        }
        return parts.map(function (p) {
            return '<span class="ai-report-pill">' + _esc(p) + '</span>';
        }).join('');
    }

    function _emptyStateHTML() {
        return '<div class="ai-output-placeholder" style="min-height:320px;">' +
            '<div class="ai-output-placeholder-icon">📋</div>' +
            '<p class="ai-output-placeholder-text">No saved reports yet.</p>' +
            '<p class="ai-output-placeholder-hint">Run an analysis and click <strong>Save</strong> to store it here.</p>' +
            '<button class="btn btn-primary" style="margin-top:18px;" onclick="activateSection(\'ai-run\')">Go to Run Analysis</button>' +
            '</div>';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Filter select population
    // ─────────────────────────────────────────────────────────────────────────

    function _populateFilterOptions(history) {
        var providers = {};

        history.forEach(function (r) {
            if (r.provider) providers[r.provider] = true;
        });

        _fillSelect('ai-reports-filter-provider', providers, 'All Providers', _filterProvider);
        // Only strategies a report was run with, including since-deleted ones.
        DenariiFilters.populateStrategy(document.getElementById('ai-reports-strategy'),
            history.map(function (r) { return { setupType: r.filters && r.filters.strategyFilter }; }), []);
    }

    function _fillSelect(id, valuesObj, allLabel, currentVal) {
        var el = document.getElementById(id);
        if (!el) return;
        var keys = Object.keys(valuesObj).sort();
        var html = '<option value="all">' + allLabel + '</option>';
        keys.forEach(function (k) {
            html += '<option value="' + _esc(k) + '"' + (k === currentVal ? ' selected' : '') + '>' + _esc(k) + '</option>';
        });
        el.innerHTML = html;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Search / filter / sort
    // ─────────────────────────────────────────────────────────────────────────

    function _applyFilters(history) {
        var q = _searchQuery.toLowerCase().trim();
        var state = DenariiFilters.readState('ai-reports');

        // Period and From/To use the shared date rules, on the report's run date.
        var inRange = DenariiFilters.filterTrades(
            history.map(function (r) { return { exitTime: r.createdAt, report: r }; }),
            { period: state.period, from: state.from, to: state.to }, null, new Date()
        ).map(function (w) { return w.report; });

        var result = inRange.filter(function (r) {
            if (q) {
                var hay = ((r.promptTitle || '') + ' ' + (r.rawText || '') + ' ' + (r.promptText || '')).toLowerCase();
                if (hay.indexOf(q) === -1) return false;
            }
            if (_filterProvider !== 'all' && r.provider !== _filterProvider) return false;
            var f = r.filters || {};
            if (state.assetType !== 'all' && f.instrumentType !== state.assetType) return false;
            if (state.style !== 'all' && (LEGACY_STYLES[f.styleFilter] || f.styleFilter) !== state.style) return false;
            if (state.strategy !== 'all' && f.strategyFilter !== state.strategy) return false;
            return true;
        });

        return result.slice().sort(function (a, b) {
            var ta = new Date(a.createdAt).getTime() || 0;
            var tb = new Date(b.createdAt).getTime() || 0;
            return _sortOrder === 'oldest' ? ta - tb : tb - ta;
        });
    }

    function onSearch(val) {
        _searchQuery = val || '';
        _renderResults();
    }

    function onFilterChange(key, val) {
        if (key === 'provider')   _filterProvider   = val;
        _renderResults();
    }

    function onSortChange(val) {
        _sortOrder = val;
        _renderResults();
    }

    function clearFilters() {
        _searchQuery      = '';
        _filterProvider   = 'all';
        _sortOrder        = 'newest';
        ['period', 'style', 'asset-type', 'strategy'].forEach(function (n) {
            var sel = document.getElementById('ai-reports-' + n);
            if (sel) sel.value = 'all';
        });
        _renderList();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Viewer
    // ─────────────────────────────────────────────────────────────────────────

    function openReport(id) {
        var history = _getHistory();
        var r = null;
        for (var i = 0; i < history.length; i++) {
            if (history[i].id === id) { r = history[i]; break; }
        }
        if (!r) return;
        _currentReport = r;
        _showViewer(r);
    }

    function _showViewer(r) {
        _viewMode = 'viewer';
        var container = document.getElementById('ai-reports');
        if (!container) return;

        var title    = _esc(r.promptTitle || 'Untitled Report');
        var date     = _formatDate(r.createdAt);
        var rId      = r.id || '';
        var hasStruct = !!(r.structuredData && typeof r.structuredData === 'object');

        var html = '<div class="ai-report-viewer">';

        // ── Viewer header ──
        html += '<div class="ai-report-viewer-header">';

        html += '<div class="ai-report-viewer-header-left">';
        html += '<button class="btn btn-secondary btn-small ai-report-back-btn" onclick="AIReports.backToList()">← Back to Reports</button>';
        html += '<h2 class="ai-report-viewer-title">' + title + '</h2>';
        html += '<div class="ai-report-viewer-date">' + _esc(date) + '</div>';
        var viewerCount = _tradeCountText(r.filters);
        if (viewerCount) html += '<div class="ai-report-viewer-date">' + _esc(viewerCount) + '</div>';
        html += '</div>';

        html += '<div class="ai-report-viewer-actions">';
        html += '<button class="btn btn-secondary btn-small" id="ai-rv-copy-btn" onclick="AIReports.copyReport()" title="Copy report to clipboard">Copy</button>';
        html += '<button class="btn btn-secondary btn-small" id="ai-rv-print-btn" onclick="AIReports.printReport()" title="Print this report">Print</button>';
        if (r.promptText) {
            html += '<button class="btn btn-secondary btn-small" onclick="AIReports.reusePrompt()" title="Load this prompt in Run Analysis">Reuse Prompt</button>';
        }
        html += '<button class="btn btn-secondary btn-small ai-report-delete-btn" id="ai-rv-delete-btn"' +
                ' data-report-id="' + _esc(rId) + '" title="Delete this report">Delete</button>';
        html += '</div>';

        html += '</div>'; // end viewer-header

        // Saved from a reply that hit the output limit: same notice as Run Analysis.
        if (r.filters && r.filters.cutOff) {
            html += (global.AIRun && global.AIRun.cutOffNoticeHtml)
                ? global.AIRun.cutOffNoticeHtml()
                : '<div class="ai-cutoff-notice" role="status">This report was cut off before it finished. Try fewer trades or run it again.</div>';
        }

        // ── Content area ──
        html += '<div class="card" style="margin-top:0;">';
        html += '<div id="ai-report-output-body" class="ai-md-output"></div>';
        html += '</div>';

        html += '</div>'; // end viewer

        container.innerHTML = html;

        // Wire up viewer delete button
        var delBtn = document.getElementById('ai-rv-delete-btn');
        if (delBtn) {
            delBtn.addEventListener('click', function () {
                AIReports.deleteReport(delBtn.getAttribute('data-report-id'));
            });
        }

        // Render content after DOM is ready.
        // Use the shared renderer from AIRun when available so live and saved
        // reports always display with the same polished layout.
        var bodyEl = document.getElementById('ai-report-output-body');
        if (bodyEl) {
            if (hasStruct) {
                try {
                    var sharedRender = global.AIRun && global.AIRun.renderReport;
                    bodyEl.innerHTML = sharedRender
                        ? sharedRender(r.structuredData)
                        : _renderStructured(r.structuredData);
                } catch (e) {
                    bodyEl.innerHTML = _renderMarkdown(r.rawText || '');
                }
            } else {
                bodyEl.innerHTML = _renderMarkdown(r.rawText || '');
            }
        }
    }

    function printReport() {
        window.print();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Structured output renderer (mirrors ai-run.js)
    // ─────────────────────────────────────────────────────────────────────────

    function _renderStructured(data) {
        var html = '<div class="ai-struct-output">';

        if (data.summary) {
            html += '<div class="ai-struct-section">';
            html += '<div class="ai-struct-section-label">Summary</div>';
            html += '<p class="ai-struct-summary">' + _esc(String(data.summary)) + '</p>';
            html += '</div>';
        }

        var listSections = [
            { key: 'key_findings',    label: 'Key Findings',    icon: '🔍' },
            { key: 'strengths',       label: 'Strengths',       icon: '✅' },
            { key: 'weaknesses',      label: 'Weaknesses',      icon: '⚠️' },
            { key: 'recommendations', label: 'Recommendations', icon: '🎯' },
        ];

        listSections.forEach(function (s) {
            var items = data[s.key];
            if (!Array.isArray(items) || items.length === 0) return;
            html += '<div class="ai-struct-section">';
            html += '<div class="ai-struct-section-label">' + s.icon + ' ' + s.label + '</div>';
            html += '<ul class="ai-struct-list">';
            items.forEach(function (item) {
                html += '<li>' + _esc(String(item)) + '</li>';
            });
            html += '</ul>';
            html += '</div>';
        });

        if (data.metrics && typeof data.metrics === 'object' && !Array.isArray(data.metrics)) {
            var mKeys = Object.keys(data.metrics);
            if (mKeys.length > 0) {
                html += '<div class="ai-struct-section">';
                html += '<div class="ai-struct-section-label">📊 Metrics</div>';
                html += '<div class="ai-struct-metrics">';
                mKeys.forEach(function (k) {
                    var label = k.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); });
                    html += '<div class="ai-struct-metric-row">';
                    html += '<span class="ai-struct-metric-label">' + _esc(label) + '</span>';
                    html += '<span class="ai-struct-metric-value">' + _esc(String(data.metrics[k])) + '</span>';
                    html += '</div>';
                });
                html += '</div>';
                html += '</div>';
            }
        }

        html += '</div>';
        return html;
    }

    function _metaRow(label, value) {
        return '<div class="ai-report-meta-row">' +
            '<span class="ai-report-meta-label">' + _esc(label) + '</span>' +
            '<span class="ai-report-meta-value">' + _esc(String(value)) + '</span>' +
            '</div>';
    }

    function backToList() {
        _currentReport = null;
        _viewMode = 'list';
        _renderList();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Actions: copy, delete, reuse
    // ─────────────────────────────────────────────────────────────────────────

    // Plain-text version of a parsed report, in the order the viewer shows it
    // (AIRun.renderReport): title, summary, then each section with "- " items.
    function _reportPlainText(data) {
        function list(v) {
            if (!v) return [];
            if (Array.isArray(v)) return v.map(function (x) { return String(x || '').trim(); }).filter(Boolean);
            var one = String(v).trim();
            return one ? [one] : [];
        }
        function bullets(items) { return items.map(function (i) { return '- ' + i; }).join('\n'); }
        var out = [];
        function section(heading, items) {
            if (items.length) out.push(heading + '\n' + bullets(items));
        }
        if (data._error) return String(data._error);
        out.push((data.title && String(data.title).trim()) || 'Analysis Report');
        if (data._prose) { out.push(String(data._prose).trim()); return out.join('\n\n'); }
        if (data.summary) out.push('Executive Summary\n' + String(data.summary).trim());
        if (Array.isArray(data.sections) && data.sections.length) {
            data.sections.forEach(function (sec) {
                if (sec && sec.heading) section(String(sec.heading), list(sec.items));
            });
        } else {
            // Legacy saves: same headings as the viewer
            section('Top Findings', list(data.key_findings));
            var ev = list(data.evidence), st = list(data.strengths), wk = list(data.weaknesses);
            if (ev.length || st.length || wk.length) {
                var parts = ['Evidence From Your Trades'];
                if (ev.length) parts.push(bullets(ev));
                if (st.length) parts.push("What's Working\n" + bullets(st));
                if (wk.length) parts.push('What Needs Work\n' + bullets(wk));
                out.push(parts.join('\n'));
            }
            if (data.metrics && typeof data.metrics === 'object' && !Array.isArray(data.metrics)) {
                section('Metrics Snapshot', Object.keys(data.metrics).filter(function (k) {
                    return data.metrics[k] != null && String(data.metrics[k]).trim();
                }).map(function (k) {
                    return k.replace(/_/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); }) +
                        ': ' + String(data.metrics[k]);
                }));
            }
            section('Action Plan', list(data.recommendations));
        }
        if (data.bottom_line) out.push('Bottom Line\n' + String(data.bottom_line).trim());
        return out.join('\n\n');
    }

    // Plain text of the report as the viewer rendered it: headings on their own
    // line, list items as "- " bullets, metric rows as "- Label: value".
    function _viewerPlainText(root) {
        var lines = [];
        function add(kind, text) {
            text = kind === 'pre' ? String(text || '').trim() : String(text || '').replace(/\s+/g, ' ').trim();
            if (text) lines.push({ kind: kind, text: text });
        }
        function hasElements(n) {
            var k = n.childNodes || [];
            for (var i = 0; i < k.length; i++) if (k[i].nodeType === 1) return true;
            return false;
        }
        function walk(el) {
            var kids = el.childNodes || [];
            for (var i = 0; i < kids.length; i++) {
                var n = kids[i];
                if (n.nodeType === 3) { add('para', n.textContent); continue; }
                if (n.nodeType !== 1) continue;
                var tag = String(n.tagName).toUpperCase();
                var cls = n.classList;
                if (/^H[1-6]$/.test(tag) || (cls && cls.contains('ai-struct-section-label'))) add('head', n.textContent);
                else if (cls && cls.contains('ai-struct-metric-row')) {
                    var spans = Array.prototype.filter.call(n.childNodes || [], function (c) { return c.nodeType === 1; });
                    add('item', spans.map(function (s) { return String(s.textContent || '').trim(); }).join(': '));
                }
                else if (tag === 'LI') add('item', n.textContent);
                else if (tag === 'PRE') add('pre', n.textContent);
                else if (tag === 'P' || tag === 'BLOCKQUOTE') add('para', n.textContent);
                else if (!hasElements(n)) add('head', n.textContent);   // small styled labels
                else walk(n);
            }
        }
        walk(root);
        var out = '';
        lines.forEach(function (l, i) {
            var prev = lines[i - 1];
            if (prev) out += (prev.kind === 'head' && l.kind !== 'head') || (prev.kind === 'item' && l.kind === 'item') ? '\n' : '\n\n';
            out += (l.kind === 'item' ? '- ' : '') + l.text;
        });
        return out;
    }

    async function copyReport() {
        if (!_currentReport) return;
        var r = _currentReport;
        var text = r.rawText;
        if (r.structuredData && typeof r.structuredData === 'object') {
            // Copy exactly what the viewer shows; the data formatter is the fallback.
            var bodyEl = document.getElementById('ai-report-output-body');
            text = (bodyEl && _viewerPlainText(bodyEl)) || _reportPlainText(r.structuredData);
        }
        if (!text) return;
        var countText = _tradeCountText(_currentReport.filters);
        if (countText) text = countText + '\n\n' + text;
        try {
            await navigator.clipboard.writeText(text);
        } catch (e) {
            try {
                var ta = document.createElement('textarea');
                ta.value = text;
                ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none;';
                document.body.appendChild(ta);
                ta.select();
                document.execCommand('copy');
                document.body.removeChild(ta);
            } catch (e2) { return; }
        }
        var btn = document.getElementById('ai-rv-copy-btn');
        if (btn) {
            var orig = btn.textContent;
            btn.textContent = 'Copied ✓';
            btn.disabled = true;
            setTimeout(function () { btn.textContent = orig; btn.disabled = false; }, 1800);
        }
    }

    async function deleteReport(id) {
        var history = _getHistory();
        var idx = -1;
        for (var i = 0; i < history.length; i++) {
            if (history[i].id === id) { idx = i; break; }
        }
        if (idx === -1) return;

        var label = history[idx].promptTitle || 'this report';
        if (!window.confirm('Delete "' + label + '"? This cannot be undone.')) return;

        journalData.aiOutputHistory.splice(idx, 1);

        // Cloud-primary: delete from Supabase so it doesn't reappear on reload
        if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
            try { _deleteAiReportFromSupabase(id); } catch (e) { /* fire-and-forget */ }
        }

        try {
            if (typeof saveToIndexedDB === 'function') await saveToIndexedDB();
        } catch (e) { /* silent */ }

        if (_viewMode === 'viewer') {
            _currentReport = null;
            _viewMode = 'list';
        }
        _renderList();
    }

    function reusePrompt() {
        if (!_currentReport) return;
        var r = _currentReport;

        if (typeof activateSection === 'function') activateSection('ai-run');

        setTimeout(function () {
            var taEl = document.getElementById('ai-run-prompt-text');
            if (taEl && r.promptText) taEl.value = r.promptText;

            // The report's account applies to the next run only; the header selector stays as is.
            if (global.AIRun && global.AIRun.setFilters) global.AIRun.setFilters(r.filters || {});
        }, 50);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Markdown rendering — same pipeline as ai-run.js
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
            return '<pre class="ai-md-fallback">' + _esc(str) + '</pre>';
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────

    function _esc(str) {
        return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function _formatDate(iso) {
        if (!iso) return '';
        try {
            var d = new Date(iso);
            return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) +
                   ' ' + d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
        } catch (e) { return iso; }
    }

    function _textSnippet(text, maxLen) {
        var s = String(text || '')
            // Remove fenced code blocks (multi-line)
            .replace(/```[\s\S]*?```/g, '')
            // Remove inline code
            .replace(/`[^`\n]*`/g, '')
            // Unwrap markdown links — keep display text
            .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
            // Remove heading markers
            .replace(/^#{1,6}\s*/gm, '')
            // Unwrap bold / italic / bold-italic
            .replace(/\*{1,3}([^*\n]*)\*{1,3}/g, '$1')
            .replace(/_{1,3}([^_\n]*)_{1,3}/g, '$1')
            // Remove blockquote markers
            .replace(/^>\s*/gm, '')
            // Remove horizontal rules
            .replace(/^[-*_]{3,}\s*$/gm, '')
            // Remove list bullets (unordered and ordered)
            .replace(/^[ \t]*[-*+]\s+/gm, '')
            .replace(/^[ \t]*\d+\.\s+/gm, '')
            // Remove table pipe characters
            .replace(/\|/g, ' ')
            // Collapse all whitespace to a single space
            .replace(/\s+/g, ' ')
            .trim();

        if (!s) return 'No preview available.';
        return s.length <= maxLen ? s : s.slice(0, maxLen).trimEnd() + '…';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Expose
    // ─────────────────────────────────────────────────────────────────────────

    global.AIReports = {
        render,
        openReport,
        deleteReport,
        backToList,
        copyReport,
        printReport,
        reusePrompt,
        onSearch,
        onFilterChange,
        onSortChange,
        clearFilters,
    };

}(window));
