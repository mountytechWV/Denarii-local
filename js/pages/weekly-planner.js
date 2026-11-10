(function () {
    'use strict';

    // ── Week key helpers ─────────────────────────────────────────────────────
    function pad(n) { return n < 10 ? '0' + n : '' + n; }

    function isoWeekNum(d) {
        var date = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        date.setUTCDate(date.getUTCDate() + 4 - (date.getUTCDay() || 7));
        var yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
        return Math.ceil(((date - yearStart) / 86400000 + 1) / 7);
    }

    function weekKey(d) {
        var w = isoWeekNum(d);
        var thu = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()));
        thu.setUTCDate(thu.getUTCDate() + 4 - (thu.getUTCDay() || 7));
        return thu.getUTCFullYear() + '-W' + pad(w);
    }

    // Weeks run Sun–Sat; each is stored under the ISO key of its Monday, so
    // tomorrow's ISO week is always the key for the week containing today.
    function currentWeekKey() {
        var now = new Date();
        return weekKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1));
    }

    function stepWeek(key, dir) {
        var parts = key.split('-W');
        var yr = parseInt(parts[0]);
        var wk = parseInt(parts[1]);
        var jan4 = new Date(Date.UTC(yr, 0, 4));
        var dayOfWeek = jan4.getUTCDay() || 7;
        var mon = new Date(jan4);
        mon.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (wk - 1) * 7);
        mon.setUTCDate(mon.getUTCDate() + dir * 7);
        // weekKey reads local date fields, so rebuild the Monday in local time.
        return weekKey(new Date(mon.getUTCFullYear(), mon.getUTCMonth(), mon.getUTCDate()));
    }

    function weekLabel(key) {
        var parts = key.split('-W');
        var yr = parseInt(parts[0]);
        var wk = parseInt(parts[1]);
        var jan4 = new Date(Date.UTC(yr, 0, 4));
        var dayOfWeek = jan4.getUTCDay() || 7;
        var mon = new Date(jan4);
        mon.setUTCDate(jan4.getUTCDate() - dayOfWeek + 1 + (wk - 1) * 7);
        var sun = new Date(mon);
        sun.setUTCDate(mon.getUTCDate() - 1);
        var sat = new Date(mon);
        sat.setUTCDate(mon.getUTCDate() + 5);
        var opts = { month: 'short', day: 'numeric', timeZone: 'UTC' };
        return sun.toLocaleDateString(undefined, opts) + ' – ' + sat.toLocaleDateString(undefined, opts) + ', ' + yr;
    }

    function esc(s) {
        if (!s) return '';
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
    }

    // ── State ────────────────────────────────────────────────────────────────
    var _wpKey = '';
    var _wpSaveTimer = null;

    // ── Data access ──────────────────────────────────────────────────────────
    function storageKey(wk) { return 'wp|' + wk; }

    function getPlanner(wk) {
        if (!journalData) return null;
        if (!journalData.weeklyPlanners) journalData.weeklyPlanners = {};
        return journalData.weeklyPlanners[storageKey(wk)] || null;
    }

    // Returns false when the save was stale (see Batch 2 below); nothing written.
    function savePlanner(wk, data) {
        if (!journalData) return;
        if (_wpStaleSave(wk, data)) return false;
        if (!journalData.weeklyPlanners) journalData.weeklyPlanners = {};
        journalData.weeklyPlanners[storageKey(wk)] = data;
        if (typeof saveToIndexedDB === 'function') saveToIndexedDB();
    }

    // ── Batch 2: re-sync guard ───────────────────────────────────────────────
    // Same as the daily planner: a re-sync that replaces the open plan
    // reloads a clean form; a save while stale keeps this version as a
    // conflict copy and loads the newer one instead of writing.
    var _WP_GUARD = 'weekly-planner';

    function _wpFormDirty() {
        var d = collectData(), s = getPlanner(_wpKey) || {};
        return d.condition !== (s.condition || '') || d.expectedNext !== (s.expectedNext || '') ||
            d.keyEvents !== (s.keyEvents || '') || d.keyGuides !== (s.keyGuides || '') ||
            d.content !== (s.content || '');
    }

    function _wpReload(wk) {
        // A pending autosave would flush on navigateToWeek and write the old form.
        clearTimeout(_wpSaveTimer);
        _wpSaveTimer = null;
        if (_wpKey === wk) navigateToWeek(wk);
    }

    function _wpStaleSave(wk, data) {
        if (typeof _editorGuardStale !== 'function' || _editorGuardStale(_WP_GUARD, storageKey(wk)) !== true) return false;
        var mine = collectData();
        if (data && data.behavioral) mine.behavioral = data.behavioral;
        if (data && data.aiAnalysis) mine.aiAnalysis = data.aiAnalysis;
        _editorGuardConflict(_WP_GUARD, mine);
        _wpReload(wk);
        return true;
    }

    function _wpGuardOpen(wk) {
        if (typeof _editorGuardOpen !== 'function') return;
        _editorGuardOpen(_WP_GUARD, 'weeklyPlanners', storageKey(wk), {
            isDirty: _wpFormDirty,
            reload:  function() { _wpReload(wk); },
            resolve: function() { _wpStaleSave(wk, null); }
        });
    }

    // ── Toolbar (uses shared EditorToolbar) ─────────────────────────────────
    function buildToolbar() {
        return EditorToolbar.build('wp-editor');
    }

    // ── Behavioral focus (Continue / Stop / Focus) ───────────────────────────
    function buildBfCol(cat) {
        var labels = { cont:'Continue', stop:'Stop', focus:'Focus' };
        var colors = { cont:'rv-nf-continue', stop:'rv-nf-stop', focus:'rv-nf-start' };
        return '<div class="rv-nf-col ' + colors[cat] + '">' +
            '<div class="rv-nf-col-hdr">' +
                '<span class="rv-nf-col-label">' + labels[cat] + '</span>' +
                '<button class="rv-nf-add" onclick="wpBfAdd(\'' + cat + '\')" title="Add item">+</button>' +
            '</div>' +
            '<div class="rv-nf-items" id="wp-bf-' + cat + '"></div>' +
        '</div>';
    }

    function renderBfItems(cat, items) {
        var c = document.getElementById('wp-bf-' + cat);
        if (!c) return;
        c.innerHTML = '';
        (items || []).forEach(function(item, i) {
            c.insertAdjacentHTML('beforeend',
                '<div class="rv-nf-item" data-cat="' + cat + '" data-i="' + i + '">' +
                    '<input type="checkbox"' + (item.done ? ' checked' : '') + ' onchange="wpBfToggle(\'' + cat + '\',' + i + ',this.checked)">' +
                    '<span class="rv-nf-label' + (item.done ? ' rv-done' : '') + '">' + esc(item.text) + '</span>' +
                    '<button class="review-action-del" onclick="wpBfRemove(\'' + cat + '\',' + i + ')" title="Remove">✕</button>' +
                '</div>'
            );
        });
    }

    async function wpBfAdd(cat) {
        var text = await window.showPromptModal({ message: 'New item:' });
        if (!text || !text.trim()) return;
        var data = collectData();
        if (!data.behavioral) data.behavioral = {};
        if (!data.behavioral[cat]) data.behavioral[cat] = [];
        data.behavioral[cat].push({ text: text.trim(), done: false });
        if (savePlanner(_wpKey, data) === false) return;
        renderBfItems(cat, data.behavioral[cat]);
    }

    function wpBfToggle(cat, idx, done) {
        var data = collectData();
        if (data.behavioral && data.behavioral[cat] && data.behavioral[cat][idx]) {
            data.behavioral[cat][idx].done = done;
            if (savePlanner(_wpKey, data) === false) return;
            var label = document.querySelector('#wp-bf-' + cat + ' .rv-nf-item[data-i="' + idx + '"] .rv-nf-label');
            if (label) label.className = 'rv-nf-label' + (done ? ' rv-done' : '');
        }
    }

    function wpBfRemove(cat, idx) {
        var data = collectData();
        if (data.behavioral && data.behavioral[cat]) {
            data.behavioral[cat].splice(idx, 1);
            if (savePlanner(_wpKey, data) === false) return;
            renderBfItems(cat, data.behavioral[cat]);
        }
    }

    // ── Collect / Populate ───────────────────────────────────────────────────
    function collectData() {
        var ed = document.getElementById('wp-editor');
        var existing = getPlanner(_wpKey);
        var data = {
            condition:      (document.getElementById('wp-condition') || {}).value || '',
            expectedNext:   (document.getElementById('wp-expected') || {}).value || '',
            keyEvents:      (document.getElementById('wp-events') || {}).value || '',
            keyGuides:      (document.getElementById('wp-guides') || {}).value || '',
            content:        ed ? ed.innerHTML : '',
            behavioral:     existing ? existing.behavioral || {} : {},
            updatedAt:      new Date().toISOString()
        };
        if (existing && existing.aiAnalysis) data.aiAnalysis = existing.aiAnalysis;
        return data;
    }

    function populateForm(data) {
        if (!data) return;

        var cond = document.getElementById('wp-condition');
        if (cond) cond.value = data.condition || '';

        var exp = document.getElementById('wp-expected');
        if (exp) exp.value = data.expectedNext || '';

        var events = document.getElementById('wp-events');
        if (events) events.value = data.keyEvents || '';

        var guides = document.getElementById('wp-guides');
        if (guides) guides.value = data.keyGuides || '';

        var ed = document.getElementById('wp-editor');
        if (ed) ed.innerHTML = data.content || '';

        var bf = data.behavioral || {};
        renderBfItems('cont',  bf.cont);
        renderBfItems('stop',  bf.stop);
        renderBfItems('focus', bf.focus);

        renderSavedAi(data);
    }

    function renderSavedAi(data) {
        // Restore persisted AI analysis
        var aiBody = document.getElementById('wp-ai-body');
        var aiFooter = document.getElementById('wp-ai-footer');
        var aiMeta = document.getElementById('wp-ai-meta');
        var aiAppend = document.getElementById('wp-ai-append');
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

    // ── Auto-save ────────────────────────────────────────────────────────────
    function scheduleSave() {
        showStatus('Saving...');
        clearTimeout(_wpSaveTimer);
        _wpSaveTimer = setTimeout(function() { doSave(); }, 1200);
    }

    function doSave() {
        if (!_wpKey) return;
        clearTimeout(_wpSaveTimer);
        _wpSaveTimer = null;
        if (savePlanner(_wpKey, collectData()) === false) return;
        showStatus('Saved');
        setTimeout(function() { showStatus(''); }, 2500);
    }

    function flushSave() {
        if (_wpSaveTimer) {
            clearTimeout(_wpSaveTimer);
            _wpSaveTimer = null;
            doSave();
        }
    }

    function showStatus(msg) {
        var el = document.getElementById('wp-save-status');
        if (!el) return;
        el.textContent = msg ? '✓ ' + msg : '';
        el.style.display = msg ? '' : 'none';
    }

    // ── Navigation ───────────────────────────────────────────────────────────
    function navigateToWeek(key) {
        flushSave();
        _wpKey = key;
        var data = getPlanner(key);

        var lbl = document.getElementById('wp-period-label');
        if (lbl) lbl.textContent = weekLabel(key);
        var picker = document.getElementById('wp-week-picker');
        if (picker) picker.value = key;

        // Reset all fields
        ['wp-condition','wp-expected','wp-events','wp-guides'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.value = '';
        });
        var ed = document.getElementById('wp-editor');
        if (ed) ed.innerHTML = '';
        renderBfItems('cont', []);
        renderBfItems('stop', []);
        renderBfItems('focus', []);

        // Reset AI card
        var aiBody = document.getElementById('wp-ai-body');
        var aiFooter = document.getElementById('wp-ai-footer');
        if (aiBody) aiBody.innerHTML = '<span style="color:var(--text-secondary);font-size:11px;">Click Run AI to analyze your plan.</span>';
        if (aiFooter) aiFooter.style.display = 'none';

        if (data) populateForm(data);
        showStatus('');
        _wpGuardOpen(key);
        cleanupMsg('');
    }

    function wpPrev()  { navigateToWeek(stepWeek(_wpKey, -1)); }
    function wpNext()  { navigateToWeek(stepWeek(_wpKey, +1)); }
    function wpToday() { navigateToWeek(currentWeekKey()); }
    function wpPickWeek(val) { if (val) navigateToWeek(val); }

    // ── Left column field helper ─────────────────────────────────────────────
    function wpField(label, id, type, placeholder, rows) {
        var html = '<div class="wp-field">' +
            '<label for="' + id + '">' + label + '</label>';
        if (type === 'select') {
            html += '<select id="' + id + '">' +
                '<option value="">—</option>' +
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

    // ── Page render ──────────────────────────────────────────────────────────
    function renderPage() {
        var container = document.getElementById('weekly-planner');
        if (!container) return;

        container.innerHTML =
        // Navigation bar
        '<div class="wp-nav-bar">' +
            '<button class="btn btn-small btn-secondary" onclick="wpPrev()" title="Previous week">‹</button>' +
            '<span class="wp-period-label" id="wp-period-label"></span>' +
            '<input type="week" id="wp-week-picker" class="wp-week-input" onchange="wpPickWeek(this.value)">' +
            '<button class="btn btn-small btn-secondary" onclick="wpNext()" title="Next week">›</button>' +
            '<button class="btn btn-small btn-secondary" onclick="wpToday()">This Week</button>' +
            '<span class="wp-save-status" id="wp-save-status" style="display:none;"></span>' +
        '</div>' +

        // Two-column body
        '<div class="wp-body">' +

            // Left column — compact structured fields
            '<div class="wp-sidebar">' +
                wpField('Current Market Condition', 'wp-condition', 'select') +
                wpField('Expected Condition Next Week', 'wp-expected', 'text', 'e.g. Continuation, reversal, range-bound') +
                wpField('Key Events / News Catalysts', 'wp-events', 'textarea', 'CPI, FOMC, earnings, macro news...', 3) +
                wpField('Key Market Guides', 'wp-guides', 'textarea', 'SPY, QQQ, VIX, BTC, sector ETFs, yields...', 3) +

                // AI Analysis — live card
                '<div class="planner-ai-card">' +
                    '<div class="planner-ai-hdr">' +
                        '<span class="planner-ai-title">AI Analysis</span>' +
                        '<button class="btn btn-primary btn-small" style="font-size:10px;padding:3px 10px;" onclick="wpRunAI()">Run AI</button>' +
                    '</div>' +
                    '<div class="planner-ai-body" id="wp-ai-body"><span style="color:var(--text-secondary);font-size:11px;">Click Run AI to analyze your plan.</span></div>' +
                    '<div class="planner-ai-footer" id="wp-ai-footer" style="display:none;">' +
                        '<span id="wp-ai-meta"></span>' +
                        '<button class="btn btn-secondary btn-small planner-ai-append-btn" id="wp-ai-append" onclick="wpAppendAI()" style="display:none;">Append to Plan</button>' +
                    '</div>' +
                '</div>' +
            '</div>' +

            // Right column — main planning editor
            '<div class="wp-main">' +
                '<div class="wp-editor-card">' +
                    '<div class="wp-editor-header" style="display:flex;align-items:center;gap:10px;flex-wrap:wrap;">' +
                        '<h3 class="card-title" style="margin:0;">Weekly Plan</h3>' +
                        '<span id="wp-cleanup-msg" style="margin-left:auto;font-size:12px;color:var(--text-secondary);"></span>' +
                        '<select class="btn btn-secondary btn-small" id="wp-cleanup-format" title="Clean-up format" aria-label="Clean-up format" style="padding:8px 10px;" onchange="wpCleanupFormatChange(this.value)">' +
                            '<option value="bullets"' + (savedCleanupFormat() === 'bullets' ? ' selected' : '') + '>Bullets</option>' +
                            '<option value="paragraphs"' + (savedCleanupFormat() === 'paragraphs' ? ' selected' : '') + '>Paragraphs</option>' +
                        '</select>' +
                        '<button class="btn btn-secondary btn-small" id="wp-cleanup-btn" onclick="wpCleanUpAI()">Clean Up with AI</button>' +
                    '</div>' +
                    buildToolbar() +
                    '<div class="rv-editor" id="wp-editor" contenteditable="true" spellcheck="true"></div>' +
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
        '</div>';

        // Wire autosave on left-column fields
        ['wp-condition','wp-expected','wp-events','wp-guides'].forEach(function(id) {
            var el = document.getElementById(id);
            if (el) {
                el.addEventListener('input', scheduleSave);
                el.addEventListener('change', scheduleSave);
            }
        });

        // Wire autosave on editor
        var ed = document.getElementById('wp-editor');
        if (ed) ed.addEventListener('input', scheduleSave);
        EditorToolbar.bindPasteResize('wp-editor');
        EditorToolbar.bindImagePopout('wp-editor');

        // Navigate
        navigateToWeek(_wpKey || currentWeekKey());
    }

    // ── AI Analysis ─────────────────────────────────────────────────────────
    function wpRunAI() {
        flushSave();
        var data = collectData();
        var bodyEl = document.getElementById('wp-ai-body');
        var footerEl = document.getElementById('wp-ai-footer');
        if (!bodyEl) return;
        var key = _wpKey, acct = cleanupAccount();

        var onComplete = function(aiData) {
            // The user moved on during the call: never save into another plan.
            if (_wpKey !== key || cleanupAccount() !== acct) {
                discardStaleAi();
                return;
            }
            var current = getPlanner(_wpKey) || collectData();
            current.aiAnalysis = aiData; // fresh result — no appendedAt
            savePlanner(_wpKey, current);
            var meta = document.getElementById('wp-ai-meta');
            if (meta) meta.textContent = (aiData.model || '') + ' \xb7 ' + ((aiData.durationMs || 0) / 1000).toFixed(1) + 's';
            var appendBtn = document.getElementById('wp-ai-append');
            if (appendBtn) {
                appendBtn.style.display = '';
                appendBtn.textContent = 'Append to Plan';
                appendBtn.disabled = false;
            }
        };

        if (typeof _plannerAiRun === 'function') {
            _plannerAiRun('weekly', data, _wpKey, bodyEl, footerEl);
            // A click blocked by a request still in flight must not replace that
            // request's callback. Only a started request (or the same plan's) shows the spinner.
            if (bodyEl.querySelector('.ai-insight-spinner')) bodyEl._onAiComplete = onComplete;
        }
    }

    // The AI widget writes the reply into the card before the callback runs,
    // so put back what the plan now on screen actually has saved.
    function discardStaleAi() {
        var aiBody = document.getElementById('wp-ai-body');
        var aiFooter = document.getElementById('wp-ai-footer');
        if (aiBody) aiBody.innerHTML = '<span style="color:var(--text-secondary);font-size:11px;">Click Run AI to analyze your plan.</span>';
        if (aiFooter) aiFooter.style.display = 'none';
        var data = getPlanner(_wpKey);
        if (data) renderSavedAi(data);
        cleanupMsg('AI analysis discarded because the plan changed. Try again.', true);
    }

    function wpAppendAI() {
        var existing = getPlanner(_wpKey);
        if (!existing || !existing.aiAnalysis || !existing.aiAnalysis.text) return;
        if (existing.aiAnalysis.appendedAt) return;
        var ed = document.getElementById('wp-editor');
        if (!ed) return;

        var label = weekLabel(_wpKey);
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
        if (savePlanner(_wpKey, data) === false) return;

        var btn = document.getElementById('wp-ai-append');
        if (btn) { btn.textContent = 'Appended \u2713'; btn.disabled = true; }

        scheduleSave();
    }

    // ── Clean Up with AI ─────────────────────────────────────────────────────
    var _wpCleanupBusy = false;

    function cleanupMsg(text, isError) {
        var el = document.getElementById('wp-cleanup-msg');
        if (!el) return;
        el.textContent = text;
        el.style.color = isError ? 'var(--danger)' : 'var(--text-secondary)';
    }

    function cleanupBtn(busy) {
        var btn = document.getElementById('wp-cleanup-btn');
        if (btn) btn.disabled = busy;
    }

    function cleanupAccount() {
        return typeof currentAccountId !== 'undefined' ? currentAccountId : null;
    }

    // Bullets or Paragraphs; shared with the Daily Plan. Defaults to Bullets.
    var CLEANUP_FORMAT_KEY = 'denarii_plan_cleanup_format';

    function savedCleanupFormat() {
        try { return localStorage.getItem(CLEANUP_FORMAT_KEY) === 'paragraphs' ? 'paragraphs' : 'bullets'; }
        catch (e) { return 'bullets'; }
    }

    function wpCleanupFormatChange(val) {
        try { localStorage.setItem(CLEANUP_FORMAT_KEY, val === 'paragraphs' ? 'paragraphs' : 'bullets'); } catch (e) {}
    }

    function cleanupFormat() {
        var sel = document.getElementById('wp-cleanup-format');
        return sel && sel.value === 'paragraphs' ? 'paragraphs' : 'bullets';
    }

    // Appends below the plan; the original text is never replaced.
    function wpCleanUpAI() {
        if (_wpCleanupBusy || typeof _plannerCleanup !== 'function') return;
        flushSave();
        var ed = document.getElementById('wp-editor');
        if (!ed) return;
        var key = _wpKey, acct = cleanupAccount();
        _wpCleanupBusy = true;
        cleanupBtn(true);
        cleanupMsg('Cleaning up…');
        return _plannerCleanup('weekly', ed, cleanupFormat()).then(function(res) {
            _wpCleanupBusy = false;
            cleanupBtn(false);
            if (!res.ok) { cleanupMsg(res.message, true); return; }
            // The user moved on during the call: never write into another plan.
            if (_wpKey !== key || cleanupAccount() !== acct) {
                cleanupMsg('Cleanup discarded because the plan changed. Try again.', true);
                return;
            }
            var cur = document.getElementById('wp-editor');
            if (!cur) return;
            cur.insertAdjacentHTML('beforeend', res.block);
            clearTimeout(_wpSaveTimer);
            _wpSaveTimer = null;
            if (savePlanner(_wpKey, collectData()) === false) {
                cleanupMsg('Updated on another device; your version was kept as a conflict copy.', true);
                return;
            }
            showStatus('');
            cleanupMsg('Cleaned-up version added below your plan.' + (res.note ? ' ' + res.note : ''));
        });
    }

    // ── Init ─────────────────────────────────────────────────────────────────
    function initWeeklyPlanner() {
        if (!_wpKey) _wpKey = currentWeekKey();
        renderPage();
    }

    // ── Expose ───────────────────────────────────────────────────────────────
    window.initWeeklyPlanner = initWeeklyPlanner;
    window.wpPrev            = wpPrev;
    window.wpNext            = wpNext;
    window.wpToday           = wpToday;
    window.wpPickWeek        = wpPickWeek;
    window.wpBfAdd           = wpBfAdd;
    window.wpBfToggle        = wpBfToggle;
    window.wpBfRemove        = wpBfRemove;
    window._wpFlushSave      = flushSave;
    window.wpRunAI           = wpRunAI;
    window.wpAppendAI        = wpAppendAI;
    window.wpCleanUpAI       = wpCleanUpAI;
    window.wpCleanupFormatChange = wpCleanupFormatChange;

})();
