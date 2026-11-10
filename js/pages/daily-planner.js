(function () {
    'use strict';

    // ── Date key helpers ────────────────────────────────────────────────────
    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function dateKey(d) {
        return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
    }

    function currentDateKey() { return dateKey(new Date()); }

    function stepDate(key, dir) {
        var parts = key.split('-');
        var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        d.setDate(d.getDate() + dir);
        return dateKey(d);
    }

    function dateLabel(key) {
        var parts = key.split('-');
        var d = new Date(parseInt(parts[0]), parseInt(parts[1]) - 1, parseInt(parts[2]));
        return d.toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric', year: 'numeric' });
    }

    function esc(s) {
        if (!s) return '';
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── State ─────────────────────────────────────────────────────────────
    var _dpKey = '';
    var _dpSaveTimer = null;

    // ── Data access ───────────────────────────────────────────────────────
    function storageKey(dk) { return 'dp|' + dk; }

    function getPlanner(dk) {
        if (!journalData) return null;
        if (!journalData.dailyPlanners) journalData.dailyPlanners = {};
        return journalData.dailyPlanners[storageKey(dk)] || null;
    }

    // Returns false when the save was stale (see Batch 2 below); nothing written.
    function savePlanner(dk, data) {
        if (!journalData) return;
        if (_dpStaleSave(dk, data)) return false;
        if (!journalData.dailyPlanners) journalData.dailyPlanners = {};
        journalData.dailyPlanners[storageKey(dk)] = data;
        if (typeof saveToIndexedDB === 'function') saveToIndexedDB();
    }

    // ── Batch 2: re-sync guard ────────────────────────────────────────────
    // The open plan is registered with auth.js. A re-sync that replaces it
    // reloads a clean form; a save while it is stale keeps this version as a
    // conflict copy and loads the newer one instead of writing.
    var _DP_GUARD = 'daily-planner';

    function _dpFormDirty() {
        var d = collectData(), s = getPlanner(_dpKey) || {};
        return d.bias !== (s.bias || '') || d.keyEvents !== (s.keyEvents || '') ||
            d.watchlist !== (s.watchlist || '') || d.content !== (s.content || '');
    }

    function _dpReload(dk) {
        // A pending autosave would flush on navigateToDate and write the old form.
        clearTimeout(_dpSaveTimer);
        _dpSaveTimer = null;
        if (_dpKey === dk) navigateToDate(dk);
    }

    function _dpStaleSave(dk, data) {
        if (typeof _editorGuardStale !== 'function' || _editorGuardStale(_DP_GUARD, storageKey(dk)) !== true) return false;
        var mine = collectData();
        if (data && data.behavioral) mine.behavioral = data.behavioral;
        if (data && data.aiAnalysis) mine.aiAnalysis = data.aiAnalysis;
        _editorGuardConflict(_DP_GUARD, mine);
        _dpReload(dk);
        return true;
    }

    function _dpGuardOpen(dk) {
        if (typeof _editorGuardOpen !== 'function') return;
        _editorGuardOpen(_DP_GUARD, 'dailyPlanners', storageKey(dk), {
            isDirty: _dpFormDirty,
            reload:  function() { _dpReload(dk); },
            resolve: function() { _dpStaleSave(dk, null); }
        });
    }

    // ── Toolbar (uses shared EditorToolbar) ───────────────────────────────
    function buildToolbar() {
        return EditorToolbar.build('dp-editor');
    }

    // ── Behavioral focus (Continue / Stop / Focus) ────────────────────────
    function buildBfCol(cat) {
        var labels = { cont:'Continue', stop:'Stop', focus:'Focus' };
        var colors = { cont:'rv-nf-continue', stop:'rv-nf-stop', focus:'rv-nf-start' };
        return '<div class="rv-nf-col ' + colors[cat] + '">' +
            '<div class="rv-nf-col-hdr">' +
                '<span class="rv-nf-col-label">' + labels[cat] + '</span>' +
                '<button class="rv-nf-add" onclick="dpBfAdd(\'' + cat + '\')" title="Add item">+</button>' +
            '</div>' +
            '<div class="rv-nf-items" id="dp-bf-' + cat + '"></div>' +
        '</div>';
    }

    function renderBfItems(cat, items) {
        var c = document.getElementById('dp-bf-' + cat);
        if (!c) return;
        c.innerHTML = '';
        (items || []).forEach(function(item, i) {
            c.insertAdjacentHTML('beforeend',
                '<div class="rv-nf-item" data-cat="' + cat + '" data-i="' + i + '">' +
                    '<input type="checkbox"' + (item.done ? ' checked' : '') + ' onchange="dpBfToggle(\'' + cat + '\',' + i + ',this.checked)">' +
                    '<span class="rv-nf-label' + (item.done ? ' rv-done' : '') + '">' + esc(item.text) + '</span>' +
                    '<button class="review-action-del" onclick="dpBfRemove(\'' + cat + '\',' + i + ')" title="Remove">&#10005;</button>' +
                '</div>'
            );
        });
    }

    async function dpBfAdd(cat) {
        var text = await window.showPromptModal({ message: 'New item:' });
        if (!text || !text.trim()) return;
        var data = collectData();
        if (!data.behavioral) data.behavioral = {};
        if (!data.behavioral[cat]) data.behavioral[cat] = [];
        data.behavioral[cat].push({ text: text.trim(), done: false });
        if (savePlanner(_dpKey, data) === false) return;
        renderBfItems(cat, data.behavioral[cat]);
    }

    function dpBfToggle(cat, idx, done) {
        var data = collectData();
        if (data.behavioral && data.behavioral[cat] && data.behavioral[cat][idx]) {
            data.behavioral[cat][idx].done = done;
            if (savePlanner(_dpKey, data) === false) return;
            var label = document.querySelector('#dp-bf-' + cat + ' .rv-nf-item[data-i="' + idx + '"] .rv-nf-label');
            if (label) label.className = 'rv-nf-label' + (done ? ' rv-done' : '');
        }
    }

    function dpBfRemove(cat, idx) {
        var data = collectData();
        if (data.behavioral && data.behavioral[cat]) {
            data.behavioral[cat].splice(idx, 1);
            if (savePlanner(_dpKey, data) === false) return;
            renderBfItems(cat, data.behavioral[cat]);
        }
    }

    // ── Collect / Populate ────────────────────────────────────────────────
    function collectData() {
        var ed = document.getElementById('dp-editor');
        var existing = getPlanner(_dpKey);
        var data = {
            bias:           (document.getElementById('dp-bias') || {}).value || '',
            keyEvents:      (document.getElementById('dp-events') || {}).value || '',
            watchlist:      (document.getElementById('dp-watchlist') || {}).value || '',
            content:        ed ? ed.innerHTML : '',
            behavioral:     existing ? existing.behavioral || {} : {},
            updatedAt:      new Date().toISOString()
        };
        // Preserve AI analysis from stored record
        if (existing && existing.aiAnalysis) data.aiAnalysis = existing.aiAnalysis;
        return data;
    }

    function populateForm(data) {
        if (!data) return;

        var bias = document.getElementById('dp-bias');
        if (bias) bias.value = data.bias || '';

        var events = document.getElementById('dp-events');
        if (events) events.value = data.keyEvents || '';

        var watchlist = document.getElementById('dp-watchlist');
        if (watchlist) watchlist.value = data.watchlist || '';

        var ed = document.getElementById('dp-editor');
        if (ed) ed.innerHTML = data.content || '';

        var bf = data.behavioral || {};
        renderBfItems('cont',  bf.cont);
        renderBfItems('stop',  bf.stop);
        renderBfItems('focus', bf.focus);

        renderSavedAi(data);
    }

    function renderSavedAi(data) {
        // Restore persisted AI analysis
        var aiBody = document.getElementById('dp-ai-body');
        var aiFooter = document.getElementById('dp-ai-footer');
        var aiMeta = document.getElementById('dp-ai-meta');
        var aiAppend = document.getElementById('dp-ai-append');
        if (data.aiAnalysis && data.aiAnalysis.text) {
            if (aiBody) aiBody.textContent = data.aiAnalysis.text;
            if (aiMeta) {
                aiMeta.textContent = (data.aiAnalysis.model || '') + ' \xb7 ' +
                    ((data.aiAnalysis.durationMs || 0) / 1000).toFixed(1) + 's';
            }
            if (aiFooter) aiFooter.style.display = '';
            if (aiAppend) {
                aiAppend.style.display = '';
                if (data.aiAnalysis.appendedAt) {
                    aiAppend.textContent = 'Appended \u2713';
                    aiAppend.disabled = true;
                } else {
                    aiAppend.textContent = 'Append to Plan';
                    aiAppend.disabled = false;
                }
            }
        }
    }

    // ── Auto-save ─────────────────────────────────────────────────────────
    function scheduleSave() {
        showStatus('Saving...');
        clearTimeout(_dpSaveTimer);
        _dpSaveTimer = setTimeout(function() { doSave(); }, 1200);
    }

    function doSave() {
        if (!_dpKey) return;
        clearTimeout(_dpSaveTimer);
        _dpSaveTimer = null;
        if (savePlanner(_dpKey, collectData()) === false) return;
        showStatus('Saved');
        setTimeout(function() { showStatus(''); }, 2500);
    }

    function flushSave() {
        if (_dpSaveTimer) {
            clearTimeout(_dpSaveTimer);
            _dpSaveTimer = null;
            doSave();
        }
    }

    function showStatus(msg) {
        var el = document.getElementById('dp-save-status');
        if (!el) return;
        el.textContent = msg ? '\u2713 ' + msg : '';
        el.style.display = msg ? '' : 'none';
    }

    // ── Navigation ────────────────────────────────────────────────────────
    function navigateToDate(key) {
        flushSave();
        _dpKey = key;
        var data = getPlanner(key);

        var lbl = document.getElementById('dp-period-label');
        if (lbl) lbl.textContent = dateLabel(key);
        var picker = document.getElementById('dp-date-picker');
        if (picker) picker.value = key;

        // Reset all fields
        ['dp-bias','dp-events','dp-watchlist'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        var ed = document.getElementById('dp-editor');
        if (ed) ed.innerHTML = '';
        renderBfItems('cont', []);
        renderBfItems('stop', []);
        renderBfItems('focus', []);

        // Reset AI card
        var aiBody = document.getElementById('dp-ai-body');
        var aiFooter = document.getElementById('dp-ai-footer');
        if (aiBody) aiBody.innerHTML = '<span style="color:var(--text-secondary);font-size:11px;">Click Run AI to analyze your plan.</span>';
        if (aiFooter) aiFooter.style.display = 'none';

        if (data) populateForm(data);
        showStatus('');
        _dpGuardOpen(key);
        cleanupMsg('');
    }

    function dpPrev()  { navigateToDate(stepDate(_dpKey, -1)); }
    function dpNext()  { navigateToDate(stepDate(_dpKey, +1)); }
    function dpToday() { navigateToDate(currentDateKey()); }
    function dpPickDate(val) { if (val) navigateToDate(val); }

    // ── Left column field helper ──────────────────────────────────────────
    function dpField(label, id, type, placeholder, rows) {
        var html = '<div class="wp-field">' +
            '<label for="' + id + '">' + label + '</label>';
        if (type === 'select') {
            html += '<select id="' + id + '">' +
                '<option value="">\u2014</option>' +
                '<option value="Long">Long</option>' +
                '<option value="Short">Short</option>' +
                '<option value="Neutral">Neutral</option>' +
                '<option value="Chop">Chop</option>' +
            '</select>';
        } else if (type === 'textarea') {
            html += '<textarea id="' + id + '" rows="' + (rows || 3) + '" placeholder="' + esc(placeholder || '') + '"></textarea>';
        } else {
            html += '<input type="text" id="' + id + '" placeholder="' + esc(placeholder || '') + '">';
        }
        html += '</div>';
        return html;
    }

    // ── Page render ───────────────────────────────────────────────────────
    function renderPage() {
        var container = document.getElementById('daily-planner');
        if (!container) return;

        container.innerHTML =
        // Navigation bar
        '<div class="wp-nav-bar">' +
            '<button class="btn btn-small btn-secondary" onclick="dpPrev()" title="Previous day">\u2039</button>' +
            '<span class="wp-period-label" id="dp-period-label"></span>' +
            '<input type="date" id="dp-date-picker" class="wp-week-input" onchange="dpPickDate(this.value)">' +
            '<button class="btn btn-small btn-secondary" onclick="dpNext()" title="Next day">\u203A</button>' +
            '<button class="btn btn-small btn-secondary" onclick="dpToday()">Today</button>' +
            '<span class="wp-save-status" id="dp-save-status" style="display:none;"></span>' +
        '</div>' +

        // Two-column body
        '<div class="wp-body">' +

            // Left column — compact structured fields
            '<div class="wp-sidebar">' +
                dpField('Market Bias / Expected Condition', 'dp-bias', 'select') +
                dpField('Key Events / Catalysts', 'dp-events', 'textarea', 'Earnings, FOMC, CPI, macro news...', 3) +
                dpField('Watchlist / Focus Symbols', 'dp-watchlist', 'textarea', 'SPY, AAPL, TSLA...', 3) +

                // AI Analysis — live card
                '<div class="planner-ai-card">' +
                    '<div class="planner-ai-hdr">' +
                        '<span class="planner-ai-title">AI Analysis</span>' +
                        '<button class="btn btn-primary btn-small" style="font-size:10px;padding:3px 10px;" onclick="dpRunAI()">Run AI</button>' +
                    '</div>' +
                    '<div class="planner-ai-body" id="dp-ai-body"><span style="color:var(--text-secondary);font-size:11px;">Click Run AI to analyze your plan.</span></div>' +
                    '<div class="planner-ai-footer" id="dp-ai-footer" style="display:none;">' +
                        '<span id="dp-ai-meta"></span>' +
                        '<button class="btn btn-secondary btn-small planner-ai-append-btn" id="dp-ai-append" onclick="dpAppendAI()" style="display:none;">Append to Plan</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            // Right column — main planning editor
            '<div class="wp-main">' +
                '<div class="wp-editor-card dp-editor-card">' +
                    '<div class="wp-editor-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                        '<h3 class="card-title" style="margin:0;">Daily Plan</h3>' +
                        '<span id="dp-cleanup-msg" style="margin-left:auto;font-size:12px;color:var(--text-secondary);"></span>' +
                        '<select class="btn btn-secondary btn-small" id="dp-cleanup-format" title="Clean-up format" aria-label="Clean-up format" style="padding:8px 10px;" onchange="dpCleanupFormatChange(this.value)">' +
                            '<option value="bullets"' + (savedCleanupFormat() === 'bullets' ? ' selected' : '') + '>Bullets</option>' +
                            '<option value="paragraphs"' + (savedCleanupFormat() === 'paragraphs' ? ' selected' : '') + '>Paragraphs</option>' +
                        '</select>' +
                        '<button class="btn btn-secondary btn-small" id="dp-cleanup-btn" onclick="dpCleanUpAI()">Clean Up with AI</button>' +
                    '</div>' +
                    buildToolbar() +
                    '<div class="rv-editor" id="dp-editor" contenteditable="true" spellcheck="true"></div>' +
                '</div>' +
            '</div>' +

        '</div>' +

        // Behavioral Focus — full width below
        '<div class="wp-behavioral">' +
            '<h3 class="card-title" style="margin-bottom:12px;">Behavioral Focus</h3>' +
            '<div class="rv-nf-grid">' +
                buildBfCol('cont') +
                buildBfCol('stop') +
                buildBfCol('focus') +
            '</div>' +
        '</div>' +

        '';

        // Wire autosave on left-column fields
        ['dp-bias','dp-events','dp-watchlist'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', scheduleSave);
                el.addEventListener('change', scheduleSave);
            }
        });

        // Wire autosave on editor
        var ed = document.getElementById('dp-editor');
        if (ed) ed.addEventListener('input', scheduleSave);
        EditorToolbar.bindPasteResize('dp-editor');
        EditorToolbar.bindImagePopout('dp-editor');

        // Navigate
        navigateToDate(_dpKey || currentDateKey());
    }

    // ── AI Analysis ─────────────────────────────────────────────────────
    function dpRunAI() {
        flushSave();
        var data = collectData();
        var bodyEl = document.getElementById('dp-ai-body');
        var footerEl = document.getElementById('dp-ai-footer');
        if (!bodyEl) return;
        var key = _dpKey, acct = cleanupAccount();

        // Callback to persist AI result and show append button
        var onComplete = function(aiData) {
            // The user moved on during the call: never save into another plan.
            if (_dpKey !== key || cleanupAccount() !== acct) {
                discardStaleAi();
                return;
            }
            var current = getPlanner(_dpKey) || collectData();
            current.aiAnalysis = aiData; // fresh result — no appendedAt
            savePlanner(_dpKey, current);
            var meta = document.getElementById('dp-ai-meta');
            if (meta) meta.textContent = (aiData.model || '') + ' \xb7 ' + ((aiData.durationMs || 0) / 1000).toFixed(1) + 's';
            var appendBtn = document.getElementById('dp-ai-append');
            if (appendBtn) {
                appendBtn.style.display = '';
                appendBtn.textContent = 'Append to Plan';
                appendBtn.disabled = false;
            }
        };

        if (typeof _plannerAiRun === 'function') {
            _plannerAiRun('daily', data, _dpKey, bodyEl, footerEl);
            // A click blocked by a request still in flight must not replace that
            // request's callback. Only a started request (or the same plan's) shows the spinner.
            if (bodyEl.querySelector('.ai-insight-spinner')) bodyEl._onAiComplete = onComplete;
        }
    }

    // The AI widget writes the reply into the card before the callback runs,
    // so put back what the plan now on screen actually has saved.
    function discardStaleAi() {
        var aiBody = document.getElementById('dp-ai-body');
        var aiFooter = document.getElementById('dp-ai-footer');
        if (aiBody) aiBody.innerHTML = '<span style="color:var(--text-secondary);font-size:11px;">Click Run AI to analyze your plan.</span>';
        if (aiFooter) aiFooter.style.display = 'none';
        var data = getPlanner(_dpKey);
        if (data) renderSavedAi(data);
        cleanupMsg('AI analysis discarded because the plan changed. Try again.', true);
    }

    function dpAppendAI() {
        var existing = getPlanner(_dpKey);
        if (!existing || !existing.aiAnalysis || !existing.aiAnalysis.text) return;
        // Duplicate guard: skip if this AI result was already appended
        if (existing.aiAnalysis.appendedAt) return;
        var ed = document.getElementById('dp-editor');
        if (!ed) return;

        var label = dateLabel(_dpKey);
        var block = '<p><br></p>' +
            '<p style="color:var(--text-secondary);">\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500</p>' +
            '<p style="color:var(--text-secondary);"><strong>' + esc(label) + ' \u2014 AI Analysis</strong></p>' +
            '<p style="color:var(--text-secondary);white-space:pre-wrap;">' +
            esc(existing.aiAnalysis.text) + '</p>';

        ed.innerHTML += block;

        // Mark as appended and persist. Built as a copy so a stale save (Batch 2)
        // leaves the stored record without appendedAt, matching the cloud.
        var data = Object.assign({}, existing, {
            aiAnalysis: Object.assign({}, existing.aiAnalysis, { appendedAt: Date.now() })
        });
        if (savePlanner(_dpKey, data) === false) return;

        // Update button to show appended state
        var btn = document.getElementById('dp-ai-append');
        if (btn) { btn.textContent = 'Appended \u2713'; btn.disabled = true; }

        scheduleSave();
    }

    // ── Clean Up with AI ──────────────────────────────────────────────────
    var _dpCleanupBusy = false;

    function cleanupMsg(text, isError) {
        var el = document.getElementById('dp-cleanup-msg');
        if (!el) return;
        el.textContent = text;
        el.style.color = isError ? 'var(--danger)' : 'var(--text-secondary)';
    }

    function cleanupBtn(busy) {
        var btn = document.getElementById('dp-cleanup-btn');
        if (btn) btn.disabled = busy;
    }

    function cleanupAccount() {
        return typeof currentAccountId !== 'undefined' ? currentAccountId : null;
    }

    // Bullets or Paragraphs; shared with the Weekly Plan. Defaults to Bullets.
    var CLEANUP_FORMAT_KEY = 'denarii_plan_cleanup_format';

    function savedCleanupFormat() {
        try { return localStorage.getItem(CLEANUP_FORMAT_KEY) === 'paragraphs' ? 'paragraphs' : 'bullets'; }
        catch (e) { return 'bullets'; }
    }

    function dpCleanupFormatChange(val) {
        try { localStorage.setItem(CLEANUP_FORMAT_KEY, val === 'paragraphs' ? 'paragraphs' : 'bullets'); } catch (e) {}
    }

    function cleanupFormat() {
        var sel = document.getElementById('dp-cleanup-format');
        return sel && sel.value === 'paragraphs' ? 'paragraphs' : 'bullets';
    }

    // Appends below the plan; the original text is never replaced.
    function dpCleanUpAI() {
        if (_dpCleanupBusy || typeof _plannerCleanup !== 'function') return;
        flushSave();
        var ed = document.getElementById('dp-editor');
        if (!ed) return;
        var key = _dpKey, acct = cleanupAccount();
        _dpCleanupBusy = true;
        cleanupBtn(true);
        cleanupMsg('Cleaning up…');
        return _plannerCleanup('daily', ed, cleanupFormat()).then(function(res) {
            _dpCleanupBusy = false;
            cleanupBtn(false);
            if (!res.ok) { cleanupMsg(res.message, true); return; }
            // The user moved on during the call: never write into another plan.
            if (_dpKey !== key || cleanupAccount() !== acct) {
                cleanupMsg('Cleanup discarded because the plan changed. Try again.', true);
                return;
            }
            var cur = document.getElementById('dp-editor');
            if (!cur) return;
            cur.insertAdjacentHTML('beforeend', res.block);
            clearTimeout(_dpSaveTimer);
            _dpSaveTimer = null;
            if (savePlanner(_dpKey, collectData()) === false) {
                cleanupMsg('Updated on another device; your version was kept as a conflict copy.', true);
                return;
            }
            showStatus('');
            cleanupMsg('Cleaned-up version added below your plan.' + (res.note ? ' ' + res.note : ''));
        });
    }

    // ── Init ──────────────────────────────────────────────────────────────
    function initDailyPlanner() {
        if (!_dpKey) _dpKey = currentDateKey();
        renderPage();
    }

    // ── Expose ────────────────────────────────────────────────────────────
    window.initDailyPlanner = initDailyPlanner;
    window.dpPrev            = dpPrev;
    window.dpNext            = dpNext;
    window.dpToday           = dpToday;
    window.dpPickDate        = dpPickDate;
    window.dpBfAdd           = dpBfAdd;
    window.dpBfToggle        = dpBfToggle;
    window.dpBfRemove        = dpBfRemove;
    window._dpFlushSave      = flushSave;
    window.dpRunAI           = dpRunAI;
    window.dpAppendAI        = dpAppendAI;
    window.dpCleanUpAI       = dpCleanUpAI;
    window.dpCleanupFormatChange = dpCleanupFormatChange;

})();
