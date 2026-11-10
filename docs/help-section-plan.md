# Denarii Help Section Plan — Beta

**Status**: Planning only (not yet implemented)
**Date**: 2026-04-06
**Audience**: Beta testers with trading experience but no Denarii familiarity

---

## 1. Recommended Help Section Architecture

**Approach**: Single Help page (new tab in sidebar) + targeted inline tooltips on complex fields.

No external docs site, no multi-page portal. One scrollable Help page with anchor sections, plus a small number of contextual tooltips on screens where beta testers will have questions.

```
Sidebar
└── Help (new nav item, bottom of sidebar above Settings)
      └── Single page with anchor-linked sections
          ├── Getting Started
          ├── Logging Trades
          ├── Strategies & Rules
          ├── Trade Journal & Filtering
          ├── Reviews (Daily/Weekly/Monthly/Yearly)
          ├── Analytics Overview
          ├── AI Analysis
          ├── Settings & Accounts
          ├── Data & Backup
          └── Known Limitations (Beta)
```

**Why a single page, not a modal or multi-page system:**
- Beta testers need a reference they can scroll/search, not drip-fed tooltips
- Avoids building routing/navigation infrastructure for help content that will change
- Easy to update as features stabilize

---

## 2. Recommended Help Topics for Beta

### Getting Started
- Account creation and login
- Recovery key: what it is, why to save it, what happens if lost
- Sidebar navigation overview (groups, collapsing)
- Command bar (Ctrl+K) quick reference

### Logging Trades
- New Trade form field-by-field guide (symbol, side, qty, entry/exit, options fields)
- Target and stop-loss rows: how to add/remove
- Trade notes editor (formatting toolbar capabilities)
- Note templates: how to use them
- Tags: what they are, how to apply them
- Trade grades: what they mean
- Strategy rule checkboxes and how they connect to your strategies
- Draft auto-save behavior (localStorage, when it clears)

### Editing Trades
- How to open a trade for editing
- Unlock mode: what it protects and why
- What fields can/cannot be changed after initial entry

### Strategies & Rules
- Creating a strategy
- Rule groups: what they are, how scoring works
- Strategy stats (P&L, win rate) — where the numbers come from
- Favorite/hide behavior

### Trade Journal & Filtering
- How the trade list works
- Filter bar: date range, setup, symbol, style
- Sorting and selection

### Reviews (Daily / Weekly / Monthly / Yearly)
- Purpose of each review cadence
- Guided questions: what they're for
- KPI strip and widgets shown per review level
- Pattern labels (best/worst strategy, strongest day, etc.)

### Analytics Overview
- **Snapshot**: customizable widget dashboard, what each widget shows
- **Performance Trends**: equity curve, P&L bars, win rate trends, risk trends
- **Setups**: setup leaderboard, edge vs. leak identification
- **Timing**: day-of-week and time-of-day analysis, session comparison
- **Symbols**: ticker classification (EDGE / NEUTRAL / LEAK / HEMORRHAGE)
- **Risk**: position sizing, blowup days, stop-loss modeling, damage concentration
- **Discipline**: revenge trading, FOMO, premature exits, tilt escalation, behavioral cost

### AI Analysis
- Prompt Library: browsing and creating prompts
- Run Analysis: selecting prompt, applying filters, running
- Saved Reports: viewing and managing reports
- What AI model is used (Gemini) and what data is sent

### Settings & Accounts
- Profile: username, avatar, timezone, currency
- Broker Accounts: adding/editing/deleting, color coding
- Tags Management: creating custom tags
- Security: password change

### Data & Backup
- Export/backup: what's included, encryption
- Broker import: supported brokers (Webull active), CSV format expectations
- What "Coming Soon" brokers mean (Robinhood, tastytrade, Schwab, IBKR)

### Known Limitations (Beta)
- Only Webull import is verified; other brokers are placeholder
- Commission/fees not yet applied to P&L
- Stock chart depends on Twelve Data API availability
- All data is stored locally (IndexedDB + localStorage) — no cloud sync
- AI features require Gemini API connectivity

---

## 3. Recommended Inline Help / Tooltips by Page

Only where the UI label alone is insufficient. Do not tooltip obvious fields.

### New Trade Page
| Element | Tooltip Text |
|---------|-------------|
| Target rows (+ button) | "Add price targets for partial exits" |
| Stop rows (+ button) | "Add stop-loss levels" |
| Trade Grade dropdown | "Rate your execution quality for this trade" |
| Strategy Rules checkboxes | "Check rules you followed from your strategy playbook" |
| Quick Notes field | "Short tag-style note (appears in trade list)" |

### Edit Trade Page
| Element | Tooltip Text |
|---------|-------------|
| Unlock button | "Unlock to edit execution fields. Locked by default to preserve original trade record." |

### Strategies Page
| Element | Tooltip Text |
|---------|-------------|
| Rule Groups | "Group related rules (e.g., Entry Criteria, Risk Management). Each rule can be checked during trade entry." |
| Scoring section | "Define how rule adherence maps to trade grades" |

### Analytics Pages (Existing popovers — keep and standardize)
- Performance Trends: `#trend-help-popover` — already exists, populate with brief metric definitions
- Setups: `#setups-help-popover` — already exists, populate
- Timing: `#timing-help-popover` — already exists, populate

### Analytics Pages (New tooltips needed)
| Page | Element | Tooltip Text |
|------|---------|-------------|
| Symbols | Classification badges | "EDGE = consistent profit. NEUTRAL = break-even. LEAK = small drain. HEMORRHAGE = major loss source." |
| Risk | Blowup days | "Days where losses exceeded $200" |
| Risk | Damage concentration | "What % of total losses came from your worst outlier trades" |
| Discipline | Revenge trading | "Re-entering the same or similar position after a loss" |
| Discipline | FOMO/chasing | "Entering a trade within 30 seconds of the previous exit" |
| Discipline | Tilt escalation | "Increasing position size after consecutive losses" |

### Settings
| Element | Tooltip Text |
|---------|-------------|
| Recovery key | "Save this key somewhere safe. It's the only way to reset your password if you forget it." |
| Broker import dropdown | "Choose the broker that exported this CSV file" |

---

## 4. What Claude Can Safely Draft from the Codebase

These topics can be written accurately by reading current code:

- **Full Help page content** for: Getting Started, Logging Trades, Editing Trades, Trade Journal & Filtering, Settings & Accounts
- **Analytics section descriptions** — each analytics page has well-defined widgets and metrics in the JS files
- **All inline tooltip text** listed above
- **Review page descriptions** — guided questions and widgets are hardcoded in `reviews.js`
- **Strategy editor walkthrough** — field names and rule group mechanics are in `Denarii.js`
- **Known Limitations section** — derived from code comments and placeholder broker profiles
- **Data & Backup section** — export flow is in `Denarii.js`
- **Keyboard shortcuts / Command bar** — keybindings are in the HTML/JS

---

## 5. What Jeff Should Review or Write

| Topic | Why |
|-------|-----|
| Recovery key guidance | Security-critical; Jeff should confirm the exact recovery flow and risks |
| AI Analysis privacy/data section | What data goes to Gemini, any retention policy, user expectations |
| Trade grade definitions | Are grades purely user-defined or do they have prescribed meanings? |
| Strategy scoring interpretation | How should beta testers think about scores? What's a "good" score? |
| Known Limitations wording | Jeff should set beta tester expectations about what's stable vs. experimental |
| Welcome / Getting Started tone | First impression for beta testers — Jeff may want a personal voice here |
| Any planned features not to mention | Avoid documenting features that may be cut or significantly changed |

---

## 6. Phased Implementation Order

### Phase 1 — Minimum Viable Help (before beta release)
1. Add "Help" nav item to sidebar
2. Create Help page with Getting Started, Logging Trades, Known Limitations sections
3. Add recovery key tooltip on login/registration
4. Populate the 3 existing analytics help popovers (Trends, Setups, Timing)

### Phase 2 — Core Reference (first week of beta)
5. Add remaining Help page sections: Editing Trades, Strategies, Trade Journal, Reviews
6. Add New Trade page tooltips (targets, stops, grade, rules)
7. Add Edit Trade unlock tooltip

### Phase 3 — Analytics & AI Help (as beta feedback arrives)
8. Add Analytics Overview section to Help page
9. Add Discipline/Risk/Symbols inline tooltips
10. Add AI Analysis section to Help page
11. Add Settings & Data/Backup sections

### Phase 4 — Refinement (ongoing during beta)
12. Add FAQ based on actual beta tester questions
13. Revise any content that became inaccurate due to feature changes
14. Add contextual "?" icon links from each page header to the relevant Help anchor

---

## 7. Risks Where Help Content Could Become Inaccurate

| Risk | Area | Details |
|------|------|---------|
| Broker import changes | Data & Backup | Robinhood/tastytrade/Schwab/IBKR are placeholders with provisional parsing. Help text will need updating when each is verified. |
| Commission/fee handling | Logging Trades, Analytics | Code comment notes fees are "not yet applied to PnL (Phase 5)". Help should not claim P&L includes fees. |
| AI model changes | AI Analysis | Currently Gemini-powered. If the model or API changes, help text referencing Gemini becomes wrong. |
| Strategy scoring | Strategies | Scoring/grading mechanics may evolve. Help should describe current behavior, not aspirational. |
| Widget layout changes | Analytics | Snapshot and Perf Trends have customizable/rearrangeable widgets. If defaults change, screenshots or descriptions may drift. |
| Edit Trade unlock behavior | Edit Trade | The unlock flow may change based on beta feedback. Keep help text generic about "protecting original record." |
| Discipline thresholds | Discipline | Hardcoded thresholds (30s for FOMO, $200 for blowup) may be adjusted. Avoid hardcoding numbers in help unless they match code. |
| Local-only storage | Data & Backup | If cloud sync is added, the "all data is local" statement becomes wrong. |

---

## Files Inspected

| File | Purpose |
|------|---------|
| `Denarii.html` | Navigation structure, modals, existing help popovers, form fields |
| `Denarii.css` | Help popover styles (`.trd-help-popover`, `.pe-tip-popover`) |
| `Denarii.js` | Dashboard, New/Edit Trade, Strategies, AI pages, broker import, export |
| `js/pages/journal.js` | Trade entry form, tags, strategy rules, auto-save |
| `js/pages/settings.js` | Profile, timezone, currency, avatar |
| `js/pages/broker-accounts.js` | Broker account CRUD |
| `js/pages/analytics-helpers.js` | Shared analysis functions |
| `js/pages/snapshot.js` | Snapshot dashboard widgets |
| `js/pages/perf-trends.js` | Performance trends widgets |
| `js/pages/setups.js` | Setup analysis |
| `js/pages/timing.js` | Timing analysis |
| `js/pages/symbols.js` | Symbol classification |
| `js/pages/risk.js` | Risk analysis |
| `js/pages/discipline.js` | Behavioral pattern tracking |
| `js/pages/reviews.js` | Daily/weekly/monthly/yearly reviews |
| `js/pages/stock-chart.js` | Chart viewer |
| `js/services/autosave.js` | Draft auto-save |
