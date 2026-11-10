/**
 * @file ai-library.js
 * Prompt Library UI — rendering, filtering, sorting, and CRUD interactions.
 * Exposes window.AILibrary.
 *
 * Depends on:
 *  - window._DenAriiPrompts  (js/services/ai/prompts.js)
 *  - window.DenAriiAI        (js/services/ai/index.js)
 *  - Denarii.js globals: journalData, activateSection
 */

(function (global) {

    // ─────────────────────────────────────────────────────────────────────────
    // State
    // ─────────────────────────────────────────────────────────────────────────

    var _filters = {
        search:        '',
        createdBy:     'all',      // 'all' | 'denarii' | 'mine'
        favoritesOnly: false,
    };
    var _sort = 'global-first';   // 'global-first' | 'my-first' | 'favorites' | 'newest'
    var _editingId = null;         // null = new prompt, string = editing existing

    // Trade-analysis filters — these control which trades are passed into AI, not which prompts are shown
    var _tradeFilters = {
        category:  'All',   // 'All' | 'Stock' | 'Option' | 'Crypto' | 'Future' | 'Bond' | 'IPO'
        style:     'All',   // 'All' | 'Day Trade' | 'Swing' | 'Investing' | 'Position'
        timeframe: 'All',   // 'All' | 'Today' | 'Week' | 'Month' | 'Year'
    };

    // ─────────────────────────────────────────────────────────────────────────
    // Main render
    // ─────────────────────────────────────────────────────────────────────────

    function render() {
        var container = document.getElementById('ai-prompt-grid');
        if (!container) return;

        var p = global._DenAriiPrompts;
        if (!p) {
            container.innerHTML = '<p style="color:var(--text-secondary);padding:20px;">Prompt service not loaded.</p>';
            return;
        }

        _updateTradeCount();

        var prompts = _applyFiltersAndSort(p.getAllPrompts());
        container.innerHTML = prompts.length
            ? _buildGrid(prompts)
            : _buildEmptyState();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Filtering & sorting
    // ─────────────────────────────────────────────────────────────────────────

    function _applyFiltersAndSort(prompts) {
        var f = _filters;

        var myName = window.currentUsername || '';

        var result = prompts.filter(function (p) {
            if (f.favoritesOnly && !p.favorite) return false;
            if (f.createdBy === 'denarii' && p.createdBy !== 'Denarii') return false;
            if (f.createdBy === 'mine'    && p.createdBy === 'Denarii') return false;
            if (f.search) {
                var q = f.search.toLowerCase();
                var inTitle = p.title.toLowerCase().indexOf(q) !== -1;
                var inDesc  = (p.description || '').toLowerCase().indexOf(q) !== -1;
                if (!inTitle && !inDesc) return false;
            }
            return true;
        });

        result.sort(function (a, b) {
            var aIsDenarii = a.createdBy === 'Denarii';
            var bIsDenarii = b.createdBy === 'Denarii';
            if (_sort === 'favorites') {
                if (b.favorite !== a.favorite) return b.favorite ? 1 : -1;
            }
            if (_sort === 'my-first') {
                if (aIsDenarii !== bIsDenarii) return aIsDenarii ? 1 : -1;
            }
            if (_sort === 'global-first' || _sort === 'newest') {
                if (aIsDenarii !== bIsDenarii) return aIsDenarii ? -1 : 1;
            }
            if (_sort === 'newest') {
                return new Date(b.createdAt) - new Date(a.createdAt);
            }
            // Default: Denarii prompts first, then by title
            return a.title.localeCompare(b.title);
        });

        return result;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // HTML builders
    // ─────────────────────────────────────────────────────────────────────────

    function _buildGrid(prompts) {
        var cards = prompts.map(_buildCard).join('');
        return '<div class="prompt-grid">' + cards + '</div>';
    }

    function _buildCard(p) {
        var isGlobal = p.createdBy === 'Denarii';
        var favIcon  = p.favorite ? '★' : '☆';
        var favTitle = p.favorite ? 'Remove from favorites' : 'Add to favorites';

        var sourceBadge = isGlobal
            ? '<span class="prompt-source-badge prompt-source-global">Global</span>'
            : '<span class="prompt-source-badge prompt-source-user">My Prompt</span>';

        var createdByLine = p.createdBy
            ? '<span class="prompt-created-by">Created by: ' + _esc(p.createdBy) + '</span>'
            : '';

        var editDeleteBtns = !isGlobal
            ? '<button class="btn btn-secondary btn-small" onclick="AILibrary.openEditor(\'' + p.id + '\')">Edit</button>' +
              '<button class="btn btn-secondary btn-small prompt-delete-btn" onclick="AILibrary.deleteConfirm(\'' + p.id + '\')">Delete</button>'
            : '';

        return [
            '<div class="prompt-card" data-prompt-id="' + p.id + '">',
            '  <div class="prompt-card-header">',
            '    <div class="prompt-card-title-row">',
            '      <button class="prompt-fav-btn" onclick="AILibrary.toggleFav(\'' + p.id + '\')" title="' + favTitle + '">' + favIcon + '</button>',
            '      <span class="prompt-card-title">' + _esc(p.title) + '</span>',
            '    </div>',
            '    ' + sourceBadge,
            '  </div>',
            '  <p class="prompt-card-desc">' + _esc(p.description || '') + '</p>',
            createdByLine ? '  <div class="prompt-card-meta">' + createdByLine + '</div>' : '',
            '  <div class="prompt-card-footer">',
            '    <button class="btn btn-primary btn-small" onclick="AILibrary.runPrompt(\'' + p.id + '\')">Run →</button>',
            '    <button class="btn btn-secondary btn-small" onclick="AILibrary.duplicate(\'' + p.id + '\')">Duplicate</button>',
            '    ' + editDeleteBtns,
            '  </div>',
            '</div>',
        ].join('\n');
    }

    function _buildEmptyState() {
        var hasFilters = _filters.search || _filters.createdBy !== 'all' || _filters.favoritesOnly;

        if (hasFilters) {
            return '<div class="prompt-empty-state">' +
                '<div style="font-size:32px;margin-bottom:12px;">🔍</div>' +
                '<p style="font-weight:600;margin-bottom:6px;">No prompts match your filters.</p>' +
                '<p style="font-size:13px;color:var(--text-secondary);">Try clearing some filters or create a new prompt.</p>' +
                '<button class="btn btn-secondary btn-small" style="margin-top:14px;" onclick="AILibrary.clearFilters()">Clear Filters</button>' +
                '</div>';
        }
        return '<div class="prompt-empty-state">' +
            '<div style="font-size:32px;margin-bottom:12px;">✨</div>' +
            '<p style="font-weight:600;margin-bottom:6px;">No prompts yet.</p>' +
            '<p style="font-size:13px;color:var(--text-secondary);">Create your first prompt or duplicate one from the Global library.</p>' +
            '</div>';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Filter bar interactions
    // ─────────────────────────────────────────────────────────────────────────

    function onSearch(val) {
        _filters.search = val || '';
        render();
    }

    function onFilterChange(key, val) {
        _filters[key] = val;
        render();
    }

    // Updates trade-analysis filters only — does NOT affect which prompts are shown
    function onTradeFilterChange(key, val) {
        _tradeFilters[key] = val;
        _updateTradeCount();
    }

    function _updateTradeCount() {
        var el = document.getElementById('ai-lib-trade-count');
        if (!el) return;
        var trades = (typeof journalData !== 'undefined' && Array.isArray(journalData.trades))
            ? journalData.trades : [];

        var totalCount = trades.length;

        var now = new Date();
        var filtered = trades.filter(function (t) {
            // Category → assetType (formatter.js uses lowercase assetType)
            if (_tradeFilters.category !== 'All') {
                if ((t.assetType || 'stock') !== _tradeFilters.category.toLowerCase()) return false;
            }
            // Timeframe → exitTime date range (mirrors formatter.js _applyFilters logic)
            if (_tradeFilters.timeframe !== 'All') {
                var exit = new Date(t.exitTime);
                if (isNaN(exit.getTime())) return false;
                var start;
                if (_tradeFilters.timeframe === 'Today') {
                    start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
                } else if (_tradeFilters.timeframe === 'Week') {
                    start = new Date(now); start.setDate(now.getDate() - 7);
                } else if (_tradeFilters.timeframe === 'Month') {
                    start = new Date(now); start.setMonth(now.getMonth() - 1);
                } else if (_tradeFilters.timeframe === 'Year') {
                    start = new Date(now); start.setFullYear(now.getFullYear() - 1);
                }
                if (start && exit < start) return false;
            }
            return true;
        });

        el.textContent = filtered.length + ' of ' + totalCount + ' trades selected';
    }

    function onSortChange(val) {
        _sort = val;
        render();
    }

    function toggleFavoritesFilter() {
        _filters.favoritesOnly = !_filters.favoritesOnly;
        var btn = document.getElementById('ai-lib-fav-toggle');
        if (btn) btn.classList.toggle('active', _filters.favoritesOnly);
        render();
    }

    function clearFilters() {
        _filters = { search: '', createdBy: 'all', favoritesOnly: false };
        _sort = 'global-first';
        // Reset UI controls
        var s  = document.getElementById('ai-lib-search');     if (s)  s.value  = '';
        var cb = document.getElementById('ai-lib-createdby');  if (cb) cb.value = 'all';
        var sr = document.getElementById('ai-lib-sort');       if (sr) sr.value = 'global-first';
        var fb = document.getElementById('ai-lib-fav-toggle'); if (fb) fb.classList.remove('active');
        render();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Actions
    // ─────────────────────────────────────────────────────────────────────────

    function runPrompt(id) {
        if (typeof AIRun !== 'undefined') {
            AIRun.selectPrompt(id);
            AIRun.applyTradeFilters(_tradeFilters);
        }
        if (typeof activateSection === 'function') activateSection('ai-run');
    }

    async function toggleFav(id) {
        var p = global._DenAriiPrompts;
        if (!p) return;
        var newState = await p.toggleFavorite(id);
        // Update just the star on the card without full re-render
        var card = document.querySelector('.prompt-card[data-prompt-id="' + id + '"]');
        if (card) {
            var btn = card.querySelector('.prompt-fav-btn');
            if (btn) {
                btn.textContent = newState ? '★' : '☆';
                btn.title = newState ? 'Remove from favorites' : 'Add to favorites';
            }
        }
    }

    async function duplicate(id) {
        var p = global._DenAriiPrompts;
        if (!p) return;
        try {
            var newPrompt = await p.duplicatePrompt(id, window.currentUsername || '');
            render();
            _showToast('Prompt duplicated. You can now edit your copy.');
        } catch (e) {
            _showToast('Could not duplicate: ' + e.message, true);
        }
    }

    function deleteConfirm(id) {
        var pr = global._DenAriiPrompts ? global._DenAriiPrompts.getPromptById(id) : null;
        var title = pr ? pr.title : 'this prompt';
        if (!confirm('Delete "' + title + '"?\n\nThis cannot be undone.')) return;
        _doDelete(id);
    }

    async function _doDelete(id) {
        var p = global._DenAriiPrompts;
        if (!p) return;
        try {
            await p.deleteUserPrompt(id);
            render();
            _showToast('Prompt deleted.');
        } catch (e) {
            _showToast('Could not delete: ' + e.message, true);
        }
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Prompt Editor Modal
    // ─────────────────────────────────────────────────────────────────────────

    function openEditor(id) {
        _editingId = id || null;
        var modal = document.getElementById('prompt-editor-modal');
        if (!modal) return;

        var pr = (id && global._DenAriiPrompts) ? global._DenAriiPrompts.getPromptById(id) : null;

        // Populate form
        _setVal('pe-title',       pr ? pr.title       : '');
        _setVal('pe-description', pr ? pr.description : '');
        _setVal('pe-category',    pr ? (pr.category || 'All') : 'All');
        _setVal('pe-style',       pr ? (pr.style    || 'All') : 'All');
        _setVal('pe-prompttext',  pr ? pr.promptText  : '');
        var titleEl = document.getElementById('prompt-editor-title');
        if (titleEl) titleEl.textContent = id ? 'Edit Prompt' : 'New Prompt';

        var msgEl = document.getElementById('pe-msg');
        if (msgEl) { msgEl.textContent = ''; msgEl.style.display = 'none'; }

        modal.classList.add('active');
        if (pr && id) _guardOpen(id);
        else if (typeof global._editorGuardClose === 'function') global._editorGuardClose('prompt-editor');
    }

    function closeEditor() {
        var modal = document.getElementById('prompt-editor-modal');
        if (modal) modal.classList.remove('active');
        _editingId = null;
        if (typeof global._editorGuardClose === 'function') global._editorGuardClose('prompt-editor');
    }

    // Batch 2: re-sync guard for the open prompt. A re-sync that replaces it
    // reloads a clean form; Save while it is stale keeps this version as a
    // conflict copy and loads the newer one instead.
    var _PE_FIELDS = ['pe-title', 'pe-description', 'pe-category', 'pe-style', 'pe-prompttext'];

    function _formSig() {
        return JSON.stringify(_PE_FIELDS.map(_getVal));
    }

    function _staleSave(id) {
        var p = global._DenAriiPrompts;
        var stored = (p && p.getPromptById(id)) || { id: id };
        global._editorGuardConflict('prompt-editor', Object.assign({}, stored, {
            title:       (_getVal('pe-title') || '').trim(),
            description: (_getVal('pe-description') || '').trim(),
            promptText:  (_getVal('pe-prompttext') || '').trim(),
            category:    _getVal('pe-category') || 'All',
            style:       _getVal('pe-style')    || 'All'
        }));
        openEditor(id);
    }

    function _guardOpen(id) {
        if (typeof global._editorGuardOpen !== 'function') return;
        var openSig = _formSig();
        global._editorGuardOpen('prompt-editor', 'aiPrompts', String(id), {
            isOpen: function () {
                var modal = document.getElementById('prompt-editor-modal');
                return _editingId === id && !!modal && modal.classList.contains('active');
            },
            isDirty: function () { return _formSig() !== openSig; },
            reload:  function () { openEditor(id); },
            resolve: function () { _staleSave(id); }
        });
    }


    async function saveFromEditor() {
        var p = global._DenAriiPrompts;
        if (!p) return;

        // Batch 2: changed on another device while open → conflict copy, reload.
        if (_editingId && typeof global._editorGuardStale === 'function' && global._editorGuardStale('prompt-editor', String(_editingId)) === true) {
            _staleSave(_editingId);
            return;
        }

        var title = (_getVal('pe-title') || '').trim();
        var promptText = (_getVal('pe-prompttext') || '').trim();

        if (!title) { _editorMsg('Title is required.', false); return; }
        if (!promptText) { _editorMsg('Prompt text is required.', false); return; }

        var data = {
            title:        title,
            description:  (_getVal('pe-description') || '').trim(),
            promptText:   promptText,
            category:     _getVal('pe-category') || 'All',
            style:        _getVal('pe-style')    || 'All',
            createdBy:    window.currentUsername || '',
        };
        if (_editingId) data.id = _editingId;

        try {
            await p.saveUserPrompt(data);
            closeEditor();
            render();
            _showToast(_editingId ? 'Prompt updated.' : 'Prompt created.');
        } catch (e) {
            _editorMsg('Could not save: ' + e.message, false);
        }
    }

    function _editorMsg(text, ok) {
        var el = document.getElementById('pe-msg');
        if (!el) return;
        el.textContent = text;
        el.style.color = ok ? 'var(--success)' : 'var(--danger)';
        el.style.display = 'block';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Toast notification
    // ─────────────────────────────────────────────────────────────────────────

    function _showToast(msg, isError) {
        var toast = document.getElementById('ai-toast');
        if (!toast) return;
        toast.textContent = msg;
        toast.style.background = isError ? 'var(--danger)' : 'var(--success)';
        toast.style.color = isError ? 'var(--on-danger)' : '';
        toast.classList.add('active');
        setTimeout(function () { toast.classList.remove('active'); }, 3000);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Utilities
    // ─────────────────────────────────────────────────────────────────────────

    function _esc(str) {
        return String(str || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    function _setVal(id, val) {
        var el = document.getElementById(id);
        if (el) el.value = val;
    }

    function _getVal(id) {
        var el = document.getElementById(id);
        return el ? el.value : '';
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Expose
    // ─────────────────────────────────────────────────────────────────────────

    global.AILibrary = {
        render,
        runPrompt,
        toggleFav,
        duplicate,
        deleteConfirm,
        openEditor,
        closeEditor,
        saveFromEditor,
        onSearch,
        onFilterChange,
        onTradeFilterChange,
        onSortChange,
        toggleFavoritesFilter,
        clearFilters,
    };

}(window));

// ── Prompt Text info-tip popover ──────────────────────────────────────────────
function peTipToggle(e) {
    e.stopPropagation();
    var btn = document.getElementById('pe-info-btn');
    var pop = document.getElementById('pe-tip-popover');
    if (!pop || !btn) return;

    // Close if already open
    if (pop.classList.contains('open')) {
        pop.classList.remove('open');
        pop.setAttribute('aria-hidden', 'true');
        return;
    }

    var GAP    = 8;   // px gap between icon and popover edge
    var PAD    = 12;  // min distance from viewport edge
    var POP_W  = 320;
    var rect   = btn.getBoundingClientRect();
    var vpW    = window.innerWidth;
    var vpH    = window.innerHeight;

    // Horizontal: align left edge with button, clamp so popover stays on screen
    var left = rect.left;
    if (left + POP_W > vpW - PAD) { left = vpW - PAD - POP_W; }
    if (left < PAD)               { left = PAD; }

    // Vertical: prefer below; flip above when below has less room
    var spaceBelow = vpH - rect.bottom - GAP - PAD;
    var spaceAbove = rect.top  - GAP - PAD;
    var openBelow  = spaceBelow >= 180 || spaceBelow >= spaceAbove;
    var maxH       = Math.min(Math.round(vpH * 0.65), openBelow ? spaceBelow : spaceAbove);
    maxH           = Math.max(maxH, 120); // floor so it's always usable
    var top        = openBelow ? rect.bottom + GAP : rect.top - GAP - maxH;

    pop.style.top       = top  + 'px';
    pop.style.left      = left + 'px';
    pop.style.maxHeight = maxH + 'px';
    pop.scrollTop       = 0;  // reset scroll position on each open

    pop.classList.add('open');
    pop.setAttribute('aria-hidden', 'false');
}

document.addEventListener('click', function (e) {
    var pop = document.getElementById('pe-tip-popover');
    var btn = document.getElementById('pe-info-btn');
    if (!pop || !pop.classList.contains('open')) return;
    if (!pop.contains(e.target) && e.target !== btn) {
        pop.classList.remove('open');
        pop.setAttribute('aria-hidden', 'true');
    }
});

document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    var pop = document.getElementById('pe-tip-popover');
    if (pop && pop.classList.contains('open')) {
        pop.classList.remove('open');
        pop.setAttribute('aria-hidden', 'true');
    }
});
