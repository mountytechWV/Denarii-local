/**
 * nav.js — Denarii Navigation Overhaul
 * Collapsible sidebar, collapsible groups, command bar, mobile drawer.
 * Loaded deferred after all other scripts.
 */

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────
    // STORAGE KEYS
    // ────────────────────────────────────────────────────────────
    var SIDEBAR_KEY = 'denarii_sidebar_collapsed';
    var GROUP_KEY   = 'denarii_group_states';

    // ────────────────────────────────────────────────────────────
    // REFS
    // ────────────────────────────────────────────────────────────
    var sidebar       = document.getElementById('main-sidebar');
    var shell         = document.querySelector('.app-shell');
    var toggleBtn     = document.getElementById('sidebar-toggle');
    var flyout        = document.getElementById('sidebar-flyout');
    var mobileOverlay = document.getElementById('sidebar-mobile-overlay');

    if (!sidebar || !shell) return; // guard: only run when logged-in DOM exists

    // ────────────────────────────────────────────────────────────
    // A) COLLAPSIBLE SIDEBAR
    // ────────────────────────────────────────────────────────────
    var sidebarCollapsed = localStorage.getItem(SIDEBAR_KEY) === '1';
    var railOpen = false; // 769-900px only, not saved

    function isMobile() {
        return window.innerWidth <= 768;
    }

    function isRail() {
        return window.innerWidth > 768 && window.innerWidth <= 900;
    }

    function updateToggleLabel() {
        if (!toggleBtn) return;
        var expand = isMobile() ? false : (isRail() ? !railOpen : sidebarCollapsed);
        toggleBtn.title = expand ? 'Expand sidebar' : 'Collapse sidebar';
        toggleBtn.setAttribute('aria-label', expand ? 'Expand sidebar navigation' : 'Collapse sidebar navigation');
    }

    function setRailOpen(open) {
        railOpen = open;
        sidebar.classList.toggle('rail-open', open);
        shell.classList.toggle('rail-open', open);
        if (open) {
            sidebar.classList.remove('collapsed');
            shell.classList.remove('sidebar-collapsed');
        } else {
            applySidebarState(sidebarCollapsed, true);
        }
        updateToggleLabel();
    }

    function applySidebarState(collapsed, animate) {
        if (!animate) {
            sidebar.style.transition = 'none';
            shell.style.transition   = 'none';
        }
        sidebar.classList.toggle('collapsed', collapsed);
        shell.classList.toggle('sidebar-collapsed', collapsed);

        // Update profile popup offset via CSS variable
        var offset = collapsed ? '76px' : '290px';
        document.documentElement.style.setProperty('--profile-popup-left', offset);

        if (!animate) {
            requestAnimationFrame(function () {
                sidebar.style.transition = '';
                shell.style.transition   = '';
            });
        }

        localStorage.setItem(SIDEBAR_KEY, collapsed ? '1' : '0');
        sidebarCollapsed = collapsed;

        // Update toggle button title/aria
        updateToggleLabel();
    }

    // Apply persisted state immediately (no animation)
    if (!isMobile()) {
        applySidebarState(sidebarCollapsed, false);
    }

    if (toggleBtn) {
        toggleBtn.addEventListener('click', function () {
            if (isMobile()) {
                window.closeMobileSidebar();
                return;
            }
            if (isRail()) {
                setRailOpen(!railOpen);
                closeSidebarFlyout();
                return;
            }
            applySidebarState(!sidebarCollapsed, true);
            closeSidebarFlyout();
        });
    }

    // Re-evaluate on resize
    window.addEventListener('resize', function () {
        if (railOpen && !isRail()) setRailOpen(false);
        if (isMobile()) {
            // On mobile, reset collapsed CSS visuals
            shell.classList.remove('sidebar-collapsed');
            updateToggleLabel();
        } else if (!railOpen) {
            // Reapply persisted state on desktop
            applySidebarState(sidebarCollapsed, false);
        }
    });

    // ────────────────────────────────────────────────────────────
    // B) COLLAPSIBLE SIDEBAR GROUPS
    // ────────────────────────────────────────────────────────────
    var groupStates = {};
    // Always start with all groups collapsed — clear any persisted open state
    try { localStorage.removeItem(GROUP_KEY); } catch(e) {}

    function saveGroupStates() {
        localStorage.setItem(GROUP_KEY, JSON.stringify(groupStates));
    }

    function openGroup(groupId) {
        var header   = document.querySelector('.nav-group-header[data-group="' + groupId + '"]');
        var children = document.querySelector('.nav-group-children[data-group-children="' + groupId + '"]');
        if (!header || !children) return;
        header.classList.add('open');
        header.setAttribute('aria-expanded', 'true');
        children.classList.add('open');
        groupStates[groupId] = true;
        saveGroupStates();
    }

    function closeGroup(groupId) {
        var header   = document.querySelector('.nav-group-header[data-group="' + groupId + '"]');
        var children = document.querySelector('.nav-group-children[data-group-children="' + groupId + '"]');
        if (!header || !children) return;
        header.classList.remove('open');
        header.setAttribute('aria-expanded', 'false');
        children.classList.remove('open');
        groupStates[groupId] = false;
        saveGroupStates();
    }

    function toggleGroup(groupId) {
        if (groupStates[groupId]) {
            closeGroup(groupId);
        } else {
            openGroup(groupId);
        }
    }

    // Bind group header clicks
    document.querySelectorAll('.nav-group-header').forEach(function (header) {
        var groupId = header.dataset.group;

        // Restore persisted open state
        if (groupStates[groupId] === true) {
            openGroup(groupId);
        }

        header.addEventListener('click', function () {
            if (sidebarCollapsed && !isMobile() && !railOpen) {
                showSidebarFlyout(header, groupId);
            } else {
                toggleGroup(groupId);
            }
        });
    });

    // ────────────────────────────────────────────────────────────
    // D) ACTIVE STATE — auto-open parent group + mark has-active-child
    // ────────────────────────────────────────────────────────────
    function refreshGroupActiveStates() {
        document.querySelectorAll('.nav-group-header').forEach(function (h) {
            var gId      = h.dataset.group;
            var hasActive = !!document.querySelector('.nav-item.active[data-parent-group="' + gId + '"]');
            h.classList.toggle('has-active-child', hasActive);
        });
    }

    function autoOpenParentGroup(tabId) {
        var item = document.querySelector('.nav-item[data-tab="' + tabId + '"]');
        if (item && item.dataset.parentGroup) {
            var group = item.dataset.parentGroup;
            if (!groupStates[group]) {
                openGroup(group);
            }
        }
    }

    // Patch nav item clicks (additive — original activateSection listener still fires)
    document.querySelectorAll('.nav-item').forEach(function (item) {
        item.addEventListener('click', function () {
            var tabId = item.dataset.tab;
            if (!tabId) return;
            // Slight delay so activateSection has run first
            setTimeout(function () {
                refreshGroupActiveStates();
            }, 30);
            if (item.dataset.parentGroup && !groupStates[item.dataset.parentGroup]) {
                openGroup(item.dataset.parentGroup);
            }
            closeSidebarFlyout();
            closeMobileSidebar();
        });
    });

    // On load: open the parent group of the active item if not already persisted
    (function initActiveGroup() {
        var activeItem = document.querySelector('.nav-item.active[data-parent-group]');
        if (activeItem) {
            var group = activeItem.dataset.parentGroup;
            if (!Object.prototype.hasOwnProperty.call(groupStates, group)) {
                openGroup(group);
            }
        }
        refreshGroupActiveStates();
    }());

    // ────────────────────────────────────────────────────────────
    // SIDEBAR FLYOUT (collapsed icon-rail mode)
    // ────────────────────────────────────────────────────────────
    var _flyoutCloseListener = null;

    function showSidebarFlyout(triggerEl, groupId) {
        if (!flyout) return;

        var children = document.querySelectorAll('.nav-item[data-parent-group="' + groupId + '"]');
        if (!children.length) return;

        // Build title from group header label
        var header    = document.querySelector('.nav-group-header[data-group="' + groupId + '"]');
        var labelSpan = header ? header.querySelector('.nav-group-label') : null;
        var title     = labelSpan ? labelSpan.textContent : groupId;

        var html = '<div class="sidebar-flyout-title">' + title + '</div>';
        children.forEach(function (item) {
            var tab    = item.dataset.tab || '';
            var icon   = item.querySelector('.nav-item-icon') ? item.querySelector('.nav-item-icon').innerHTML : '';
            var label  = '';
            var spans  = item.querySelectorAll('span');
            if (spans.length > 1) label = spans[spans.length - 1].textContent;
            var active = item.classList.contains('active') ? ' active' : '';
            html += '<button class="sidebar-flyout-item' + active + '" data-flyout-tab="' + tab + '">' +
                    '<span style="display:flex;align-items:center;flex-shrink:0;width:16px;height:16px;">' + icon + '</span>' +
                    '<span>' + label + '</span>' +
                    '</button>';
        });
        flyout.innerHTML = html;

        // Position flush with trigger element
        var rect = triggerEl.getBoundingClientRect();
        var top  = Math.min(rect.top, window.innerHeight - 320);
        flyout.style.top  = Math.max(8, top) + 'px';
        flyout.style.left = (rect.right + 8) + 'px';
        flyout.classList.add('visible');

        // Bind clicks on flyout items
        flyout.querySelectorAll('.sidebar-flyout-item').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var tab = btn.dataset.flyoutTab;
                if (tab && typeof activateSection === 'function') {
                    activateSection(tab);
                    setTimeout(refreshGroupActiveStates, 30);
                }
                closeSidebarFlyout();
            });
        });

        // Outside-click to close
        if (_flyoutCloseListener) {
            document.removeEventListener('click', _flyoutCloseListener, true);
        }
        _flyoutCloseListener = function (e) {
            if (flyout && !flyout.contains(e.target) && !e.target.closest('.nav-group-header')) {
                closeSidebarFlyout();
            }
        };
        setTimeout(function () {
            document.addEventListener('click', _flyoutCloseListener, { once: true, capture: true });
        }, 30);
    }

    function closeSidebarFlyout() {
        if (flyout) flyout.classList.remove('visible');
    }

    // Escape closes flyout
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && flyout && flyout.classList.contains('visible')) {
            closeSidebarFlyout();
        }
    });

    // ────────────────────────────────────────────────────────────
    // E) MOBILE DRAWER
    // ────────────────────────────────────────────────────────────
    window.openMobileSidebar = function () {
        if (!sidebar) return;
        sidebar.classList.add('mobile-open');
        if (mobileOverlay) mobileOverlay.classList.add('active');
        document.body.style.overflow = 'hidden';
    };

    window.closeMobileSidebar = function () {
        if (!sidebar) return;
        sidebar.classList.remove('mobile-open');
        if (mobileOverlay) mobileOverlay.classList.remove('active');
        document.body.style.overflow = '';
    };

    if (mobileOverlay) {
        mobileOverlay.addEventListener('click', window.closeMobileSidebar);
    }

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && sidebar && sidebar.classList.contains('mobile-open')) {
            window.closeMobileSidebar();
        }
    });

    // ────────────────────────────────────────────────────────────
    // C) COMMAND BAR
    // ────────────────────────────────────────────────────────────

    /** Master command list. Add entries here to extend the command bar. */
    var CMD_ITEMS = [
        // ── Navigate
        { label: 'Dashboard',          icon: '📊', tab: 'dashboard',      group: 'Navigate' },
        { label: 'New Trade',          icon: '✍️',  tab: 'journal',       group: 'Navigate' },
        { label: 'Journal',            icon: '📓', tab: 'trade-journal',  group: 'Navigate' },
        { label: 'Strategy Management', icon: '🧠', tab: 'strategies',    group: 'Navigate' },
        // ── Analytics
        { label: 'Snapshot',           icon: '📸', tab: 'snapshot',      group: 'Analytics' },
        { label: 'Performance Trends', icon: '📉', tab: 'perf-trends',   group: 'Analytics' },
        { label: 'Strategy',           icon: '🔬', tab: 'setups',        group: 'Analytics' },
        { label: 'Timing',             icon: '⏰', tab: 'timing',         group: 'Analytics' },
        { label: 'Symbols',            icon: '🔣', tab: 'symbols',       group: 'Analytics' },
        { label: 'Risk',               icon: '⚠️', tab: 'risk',          group: 'Analytics' },
        { label: 'Discipline',         icon: '⭐', tab: 'discipline',    group: 'Analytics' },
        // ── AI Analysis
        { label: 'Prompt Library',     icon: '💡', tab: 'ai-library',    group: 'AI Analysis' },
        { label: 'Run Analysis',       icon: '✨', tab: 'ai-run',         group: 'AI Analysis' },
        { label: 'Saved Reports',      icon: '📋', tab: 'ai-reports',    group: 'AI Analysis' },
        // ── Actions
        { label: 'Settings',           icon: '⚙️', action: 'openSettings', group: 'Actions' },
        { label: 'Import Trades',      icon: '📥', action: 'openImportModal', group: 'Actions' },
        { label: 'Export journal (JSON)', icon: '💾', action: 'exportBackup',  group: 'Actions' },
        { label: 'Lock Journal',       icon: '🔒', action: 'lockJournal',   group: 'Actions' },
    ];

    var cmdOverlay = document.getElementById('cmd-bar-overlay');
    var cmdBar     = document.getElementById('cmd-bar');
    var cmdInput   = document.getElementById('cmd-bar-input');
    var cmdResults = document.getElementById('cmd-bar-results');

    var cmdOpen         = false;
    var cmdFocusIndex   = -1;
    var cmdFilteredItems = [];

    window.openCmdBar = function () {
        if (!cmdBar || !cmdInput) return;
        // Locked (sign-in screen): #app-container is active only after unlock.
        var appEl = document.getElementById('app-container');
        if (!appEl || !appEl.classList.contains('active')) return;
        if (cmdOverlay)  cmdOverlay.classList.add('active');
        cmdBar.classList.add('active');
        cmdBar.setAttribute('aria-hidden', 'false');
        cmdOpen = true;
        cmdInput.value = '';
        cmdFocusIndex  = -1;
        renderCmdResults('');
        setTimeout(function () { cmdInput.focus(); }, 50);
    };

    window.closeCmdBar = function () {
        if (!cmdBar) return;
        if (cmdOverlay) cmdOverlay.classList.remove('active');
        cmdBar.classList.remove('active');
        cmdBar.setAttribute('aria-hidden', 'true');
        cmdOpen = false;
    };

    function renderCmdResults(query) {
        if (!cmdResults) return;
        var q = query.trim().toLowerCase();

        cmdFilteredItems = q
            ? CMD_ITEMS.filter(function (it) {
                return it.label.toLowerCase().indexOf(q) !== -1 ||
                       it.group.toLowerCase().indexOf(q) !== -1;
              })
            : CMD_ITEMS;

        cmdFocusIndex = (q && cmdFilteredItems.length) ? 0 : -1;

        if (!cmdFilteredItems.length) {
            cmdResults.innerHTML = '<div class="cmd-bar-empty">No results for &ldquo;' + escHtml(query) + '&rdquo;</div>';
            return;
        }

        // Group items
        var grouped = {};
        var groupOrder = [];
        cmdFilteredItems.forEach(function (item) {
            if (!grouped[item.group]) {
                grouped[item.group] = [];
                groupOrder.push(item.group);
            }
            grouped[item.group].push(item);
        });

        var html = '';
        var idx  = 0;
        groupOrder.forEach(function (group) {
            html += '<div class="cmd-bar-group-label">' + escHtml(group) + '</div>';
            grouped[group].forEach(function (item) {
                var focused = idx === cmdFocusIndex ? ' focused' : '';
                html += '<button class="cmd-bar-item' + focused + '" data-cmd-idx="' + idx + '" role="option">' +
                        '<span class="cmd-icon">' + item.icon + '</span>' +
                        '<span class="cmd-label">' + escHtml(item.label) + '</span>' +
                        '<span class="cmd-hint">' + escHtml(item.group) + '</span>' +
                        '</button>';
                idx++;
            });
        });
        cmdResults.innerHTML = html;

        // Bind item clicks
        cmdResults.querySelectorAll('.cmd-bar-item').forEach(function (btn) {
            btn.addEventListener('click', function () {
                var i = parseInt(btn.dataset.cmdIdx, 10);
                executeCmdItem(cmdFilteredItems[i]);
            });
        });
    }

    function updateCmdFocus() {
        if (!cmdResults) return;
        var btns = cmdResults.querySelectorAll('.cmd-bar-item');
        btns.forEach(function (btn, i) {
            btn.classList.toggle('focused', i === cmdFocusIndex);
        });
        if (btns[cmdFocusIndex]) {
            btns[cmdFocusIndex].scrollIntoView({ block: 'nearest' });
        }
    }

    function executeCmdItem(item) {
        if (!item) return;
        window.closeCmdBar();

        if (item.tab) {
            if (typeof activateSection === 'function') {
                activateSection(item.tab);
                autoOpenParentGroup(item.tab);
                setTimeout(refreshGroupActiveStates, 30);
            }
        } else if (item.action) {
            if (typeof window[item.action] === 'function') {
                window[item.action]();
            }
        }
    }

    if (cmdInput) {
        cmdInput.addEventListener('input', function () {
            cmdFocusIndex = 0;
            renderCmdResults(cmdInput.value);
        });

        cmdInput.addEventListener('keydown', function (e) {
            var total = cmdFilteredItems.length;
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                cmdFocusIndex = Math.min(cmdFocusIndex + 1, total - 1);
                updateCmdFocus();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                cmdFocusIndex = Math.max(cmdFocusIndex - 1, 0);
                updateCmdFocus();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                var target = cmdFocusIndex >= 0 ? cmdFilteredItems[cmdFocusIndex] : cmdFilteredItems[0];
                executeCmdItem(target);
            } else if (e.key === 'Escape') {
                window.closeCmdBar();
            }
        });
    }

    // Keyboard shortcut: Ctrl+K / Cmd+K
    document.addEventListener('keydown', function (e) {
        var tag        = e.target.tagName;
        var isEditable = tag === 'INPUT' || tag === 'TEXTAREA' || e.target.contentEditable === 'true';
        // Allow Ctrl+K inside the command bar input itself; block elsewhere
        if (isEditable && e.target !== cmdInput) return;

        if ((e.ctrlKey || e.metaKey) && (e.key === 'k' || e.key === 'K')) {
            e.preventDefault();
            if (cmdOpen) {
                window.closeCmdBar();
            } else {
                window.openCmdBar();
            }
            return;
        }

        if (e.key === 'Escape' && cmdOpen) {
            window.closeCmdBar();
        }
    });

    // ────────────────────────────────────────────────────────────
    // HELPERS
    // ────────────────────────────────────────────────────────────
    function escHtml(str) {
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;');
    }

}());
