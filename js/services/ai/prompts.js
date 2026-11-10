/**
 * @file prompts.js
 * Global prompt seeds + data-access helpers for the Denarii Prompt Library.
 *
 * Storage:
 *  - Global prompts  → defined here as a constant; never stored in the local database.
 *  - User prompts    → journalData.aiPrompts  (saved with journal via saveToIndexedDB)
 *  - Global favorites → journalData.aiPromptFavorites  (array of global prompt IDs)
 *
 * Exposed as window._DenAriiPrompts.
 */

(function (global) {

    // ─────────────────────────────────────────────────────────────────────────
    // Global prompt seeds
    // ─────────────────────────────────────────────────────────────────────────

    var GLOBAL_PROMPTS = [
        {
            id: 'global-001',
            title: 'Trade Pattern Analysis',
            description: 'Identify what separates your winners from your losers across setups, times, and conditions.',
            promptText: `You are a trading performance analyst.

Analyze these trades to identify the patterns that separate my winning trades from my losing trades.

Focus on:
- setup types
- time of day
- market conditions
- entry and exit behavior

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Core Analysis (what patterns define winners vs losers)
3. Quantified Impact (win rates, P&L differences, frequency)
4. Pattern Context (when and where patterns occur)
5. Ranked Findings (most important edge vs biggest weakness)
6. Actionable Improvements (how to reinforce winning patterns and eliminate losing ones)

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
        {
            id: 'global-002',
            title: 'Emotional Impact Review',
            description: 'See how emotions like Fear, Greed, and FOMO affect your P&L and decision quality.',
            promptText: `You are a trading performance analyst.

Analyze how emotional behavior is affecting my trading performance.

Focus on:
- fear-based exits
- greed-driven holds
- hesitation or missed trades
- emotional decision-making patterns

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Core Analysis
3. Quantified Impact
4. Pattern Context
5. Ranked Findings
6. Actionable Improvements

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
        {
            id: 'global-003',
            title: 'Strategy Execution Audit',
            description: 'Evaluate how consistently you follow your strategies and which ones actually produce results.',
            promptText: `You are a trading performance analyst.

Evaluate how consistently I follow my trading strategies.

Focus on:
- rule adherence
- deviations from strategy
- consistency of entries and exits
- execution discipline

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Core Analysis
3. Quantified Impact
4. Pattern Context
5. Ranked Findings
6. Actionable Improvements

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
        {
            id: 'global-004',
            title: 'Hold Time Optimization',
            description: 'Find out if you\'re cutting winners too early or holding losers too long.',
            promptText: `You are a trading performance analyst.

Analyze whether I am holding trades for the optimal amount of time.

Focus on:
- average hold time for winners vs losers
- cutting winners too early
- holding losers too long
- missed upside vs extended downside

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Core Analysis
3. Quantified Impact
4. Pattern Context
5. Ranked Findings
6. Actionable Improvements

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
        {
            id: 'global-005',
            title: 'Position Sizing Audit',
            description: 'Understand how your sizing decisions correlate with trade outcomes and risk.',
            promptText: `You are a trading performance analyst.

Evaluate how my position sizing impacts my performance.

Focus on:
- size vs outcome relationship
- oversized losing trades
- undersized winning trades
- consistency of risk management

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Core Analysis
3. Quantified Impact
4. Pattern Context
5. Ranked Findings
6. Actionable Improvements

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
        {
            id: 'global-006',
            title: 'Behavioral Flaw Detection',
            description: 'Surface the habits quietly draining your performance — revenge trading, FOMO, overtrading.',
            promptText: `You are a trading performance analyst.

Identify the behavioral patterns costing me the most money.

Focus specifically on:
- revenge trading after losses
- FOMO entries
- overtrading on high-emotion days
- abandoning strategy rules

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Core Analysis
3. Quantified Impact
4. Pattern Context
5. Ranked Findings
6. Actionable Improvements

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
        {
            id: 'global-007',
            title: 'Ticker Performance Rankings',
            description: 'Find which symbols carry your edge and which ones keep pulling you into bad trades.',
            promptText: `You are a trading performance analyst.

Analyze which tickers I perform best and worst on.

Focus on:
- profitability by ticker
- consistency per ticker
- win rate and P&L distribution
- whether certain tickers lead to poor decisions

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Core Analysis
3. Quantified Impact
4. Pattern Context
5. Ranked Findings
6. Actionable Improvements

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
        {
            id: 'global-008',
            title: 'Session Quality by Day of Week',
            description: 'Find your best and worst trading days and understand why the gap exists.',
            promptText: `You are a trading performance analyst.

Analyze my performance by day of the week.

Focus on:
- which days perform best and worst
- consistency by day
- behavior differences across days
- potential external influences such as volatility patterns

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Core Analysis
3. Quantified Impact
4. Pattern Context
5. Ranked Findings
6. Actionable Improvements

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
        {
            id: 'global-009',
            title: 'Risk Management Audit',
            description: 'Evaluate stop loss discipline, loss management, and whether your risk is controlled.',
            promptText: `You are a trading performance analyst.

Evaluate how well I manage risk in my trades.

Focus on:
- stop loss discipline
- risk-to-reward consistency
- average loss vs average gain
- whether losses are controlled

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Core Analysis
3. Quantified Impact
4. Pattern Context
5. Ranked Findings
6. Actionable Improvements

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
        {
            id: 'global-010',
            title: 'Comprehensive Performance Report',
            description: 'Full picture: strengths, weaknesses, and 3 specific improvements to act on now.',
            promptText: `You are a trading performance analyst.

Provide a full breakdown of my trading performance.

Include:
- strengths
- weaknesses
- behavioral patterns
- strategy effectiveness
- risk management

You MUST structure your response as a detailed report with the following sections:
1. Summary
2. Strengths
3. Weaknesses
4. Behavioral Insights
5. Quantified Performance Metrics
6. Ranked Improvement Opportunities
7. Actionable Plan

Rules:
- Use numbers wherever possible
- Avoid generic advice
- Be specific and analytical`,
            category: 'All',
            strategyTags: [],
            style: 'All',
            favorite: false,
            createdAt: '2025-01-01T00:00:00.000Z',
            updatedAt: '2025-01-01T00:00:00.000Z',
            createdBy: 'Denarii',
        },
    ];

    // ─────────────────────────────────────────────────────────────────────────
    // Helpers for accessing journalData safely
    // ─────────────────────────────────────────────────────────────────────────

    function _userPrompts() {
        try {
            if (typeof journalData !== 'undefined') {
                if (!Array.isArray(journalData.aiPrompts)) journalData.aiPrompts = [];
                return journalData.aiPrompts;
            }
        } catch (e) { /* ignore */ }
        return [];
    }

    function _favoritedGlobalIds() {
        try {
            if (typeof journalData !== 'undefined') {
                if (!Array.isArray(journalData.aiPromptFavorites)) journalData.aiPromptFavorites = [];
                return journalData.aiPromptFavorites;
            }
        } catch (e) { /* ignore */ }
        return [];
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Read
    // ─────────────────────────────────────────────────────────────────────────

    function getGlobalPrompts() {
        var favIds = _favoritedGlobalIds();
        return GLOBAL_PROMPTS.map(function (p) {
            return Object.assign({}, p, { favorite: favIds.indexOf(p.id) !== -1 });
        });
    }

    function getUserPrompts() {
        return _userPrompts().slice();
    }

    function getAllPrompts() {
        return getGlobalPrompts().concat(getUserPrompts());
    }

    function getPromptById(id) {
        var all = getAllPrompts();
        for (var i = 0; i < all.length; i++) {
            if (all[i].id === id) return all[i];
        }
        return null;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Write (user prompts only)
    // ─────────────────────────────────────────────────────────────────────────

    function _generateId() {
        return 'usr-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 6);
    }

    /**
     * Create or update a user prompt.
     * Pass an object without an id to create; with an id to update.
     * @param {Object} data
     * @returns {Object} saved prompt
     */
    async function saveUserPrompt(data) {
        var list = _userPrompts();
        var now = new Date().toISOString();

        if (data.id) {
            // Update existing
            var idx = -1;
            for (var i = 0; i < list.length; i++) {
                if (list[i].id === data.id) { idx = i; break; }
            }
            if (idx === -1) throw new Error('Prompt not found: ' + data.id);
            var _originalCreatedBy = list[idx].createdBy;
            list[idx] = Object.assign({}, list[idx], data, { updatedAt: now });
            list[idx].createdBy = _originalCreatedBy; // immutable — never overwritten on edit

            // Cloud-primary: upsert updated prompt to Supabase
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                try { _saveAiPromptToSupabase(list[idx]); } catch (e) { /* fire-and-forget */ }
            }

            if (typeof saveToIndexedDB === 'function') await saveToIndexedDB();
            return list[idx];
        } else {
            // Create new
            var newPrompt = {
                id:           _generateId(),
                title:        data.title        || 'Untitled Prompt',
                description:  data.description  || '',
                promptText:   data.promptText   || '',
                category:     data.category     || 'All',
                strategyTags: data.strategyTags || [],
                style:        data.style        || 'All',
                favorite:     false,
                createdBy:    data.createdBy    || '',
                createdAt:    now,
                updatedAt:    now,
            };
            list.push(newPrompt);

            // Cloud-primary: upsert new prompt to Supabase
            if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                try { _saveAiPromptToSupabase(newPrompt); } catch (e) { /* fire-and-forget */ }
            }

            if (typeof saveToIndexedDB === 'function') await saveToIndexedDB();
            return newPrompt;
        }
    }

    async function deleteUserPrompt(id) {
        var list = _userPrompts();
        var idx = -1;
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) { idx = i; break; }
        }
        if (idx === -1) return;
        list.splice(idx, 1);

        // Cloud-primary: delete from Supabase so it doesn't reappear on reload
        if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
            try { _deleteAiPromptFromSupabase(id); } catch (e) { /* fire-and-forget */ }
        }

        if (typeof saveToIndexedDB === 'function') await saveToIndexedDB();
    }

    /**
     * Duplicate any prompt (global or user) into the user's library.
     * @param {string} id
     * @returns {Object} new user prompt
     */
    async function duplicatePrompt(id, createdBy) {
        var src = getPromptById(id);
        if (!src) throw new Error('Prompt not found: ' + id);
        return saveUserPrompt({
            title:        'Copy of ' + src.title,
            description:  src.description,
            promptText:   src.promptText,
            category:     src.category || 'All',
            strategyTags: src.strategyTags ? src.strategyTags.slice() : [],
            style:        src.style    || 'All',
            createdBy:    createdBy || '',
        });
    }

    /**
     * Toggle favorite on any prompt.
     * User prompts: updates the prompt's favorite field.
     * Global prompts: updates journalData.aiPromptFavorites.
     * @param {string} id
     * @returns {boolean} new favorite state
     */
    async function toggleFavorite(id) {
        // Check if it's a user prompt first
        var list = _userPrompts();
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) {
                list[i].favorite = !list[i].favorite;
                list[i].updatedAt = new Date().toISOString();

                // Cloud-primary: upsert updated prompt to Supabase
                if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
                    try { _saveAiPromptToSupabase(list[i]); } catch (e) { /* fire-and-forget */ }
                }

                if (typeof saveToIndexedDB === 'function') await saveToIndexedDB();
                return list[i].favorite;
            }
        }
        // It's a global prompt — update aiPromptFavorites
        var favIds = _favoritedGlobalIds();
        var pos = favIds.indexOf(id);
        if (pos === -1) {
            favIds.push(id);
        } else {
            favIds.splice(pos, 1);
        }

        // Cloud-primary: save global favorites to user_meta
        if (typeof _isCloudPrimarySave === 'function' && _isCloudPrimarySave()) {
            try { _saveAiPromptFavoritesToSupabase(); } catch (e) { /* fire-and-forget */ }
        }

        if (typeof saveToIndexedDB === 'function') await saveToIndexedDB();
        return pos === -1;
    }

    function isFavorited(id) {
        var list = _userPrompts();
        for (var i = 0; i < list.length; i++) {
            if (list[i].id === id) return !!list[i].favorite;
        }
        return _favoritedGlobalIds().indexOf(id) !== -1;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Migration
    // ─────────────────────────────────────────────────────────────────────────

    /**
     * Back-fill createdBy on existing saved user prompts.
     * Safe to call on every login; no-ops if already migrated.
     * Returns true if any record was changed (caller should saveToIndexedDB).
     * @param {string} username  – the current logged-in username
     */
    function migrateCreatedBy(username) {
        var list = _userPrompts();
        var changed = false;
        for (var i = 0; i < list.length; i++) {
            var p = list[i];
            // back-fill createdBy
            if (!p.createdBy) { p.createdBy = username || ''; changed = true; }
            // enforce category / style = 'All' (fields are no longer prompt-level filters)
            if (p.category !== 'All') { p.category = 'All'; changed = true; }
            if (p.style    !== 'All') { p.style    = 'All'; changed = true; }
            // strip legacy fields so stored objects stay clean
            if ('timeframe' in p) { delete p.timeframe; changed = true; }
            if ('source'    in p) { delete p.source;    changed = true; }
        }
        return changed;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Expose
    // ─────────────────────────────────────────────────────────────────────────

    global._DenAriiPrompts = {
        getGlobalPrompts,
        getUserPrompts,
        getAllPrompts,
        getPromptById,
        saveUserPrompt,
        deleteUserPrompt,
        duplicatePrompt,
        toggleFavorite,
        isFavorited,
        migrateCreatedBy,
        GLOBAL_PROMPTS,
    };

}(window));
