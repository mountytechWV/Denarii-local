# Denarii Theme Token Specification

> Compact reference for all approved themes. Use this spec — not ad hoc color guesses — when building or editing theme styles.

---

## Token Map

Each theme must define values for these tokens. Tokens marked with `*` are **sidebar-specific** and currently implemented as hardcoded overrides rather than CSS custom properties.

| Token | Purpose |
|---|---|
| `--bg-primary` | App background / workspace fill |
| `--bg-secondary` | Secondary panels, table headers, form backgrounds |
| `--bg-card` | Card surfaces, stat cards, hero card base |
| `--bg-tertiary` | Tertiary/deeper surfaces |
| `--text-primary` | Primary readable text on content surfaces |
| `--text-secondary` | Secondary/muted text on content surfaces |
| `--border` | Default border color |
| `--primary` | Theme accent (buttons, active states, links) |
| `--success` | Positive/profit color |
| `--danger` | Negative/loss color |
| `--warning` | Warning/caution color |
| `*bg-sidebar` | Sidebar gradient or fill |
| `*bg-sidebar-active` | Active nav item background |
| `*text-sidebar` | Default nav item + icon color in sidebar |
| `*text-sidebar-muted` | Section labels, group headers in sidebar |
| `*icon-sidebar` | Sidebar icon color (currently inherits from text-sidebar) |

---

## Theme Definitions

### Denarii Forged (dark, default)
| Token | Value | Notes |
|---|---|---|
| `--bg-primary` | `#0B0B0C` | Near-black |
| `--bg-secondary` | `#121212` | |
| `--bg-card` | `#171719` | |
| `--bg-tertiary` | `#232326` | |
| `--text-primary` | `#F5F5F5` | |
| `--text-secondary` | `#A1A1AA` | |
| `--border` | `#2E2A26` | Warm-tinted dark border |
| `--primary` | `#E67E22` | Orange |
| `--success` | `#22C55E` | |
| `--danger` | `#EF4444` | |
| `--warning` | `#FFD27A` | Gold |
| `*bg-sidebar` | `linear-gradient(180deg, #121212, #0F0F10)` with gold glow overlay | |
| `*bg-sidebar-active` | `linear-gradient(135deg, rgba(255,106,0,0.18), rgba(255,210,122,0.06))` | Orange glow |
| `*text-sidebar` | `#B7AEA6` | Warm gray, hover → `#F5F5F5` |
| `*text-sidebar-muted` | `rgba(255,210,122,0.42)` | Gold-tinted section labels |
| `*icon-sidebar` | Inherits `*text-sidebar` | |

### Soft Dark (dark)
| Token | Value | Notes |
|---|---|---|
| `--bg-primary` | `#0F1624` | Deep navy |
| `--bg-secondary` | `#141B2D` | |
| `--bg-card` | `#1C2A3A` | |
| `--bg-tertiary` | `#223347` | |
| `--text-primary` | `#E8EDF5` | |
| `--text-secondary` | `#7A8BA0` | |
| `--border` | `#2E4A63` | |
| `--primary` | `#6C63FF` | Indigo-violet |
| `--success` | `#38BFA1` | Teal |
| `--danger` | `#E07070` | |
| `--warning` | `#F0C060` | |
| `*bg-sidebar` | Uses base styles (`var(--bg-card)` region) | No sidebar override |
| `*bg-sidebar-active` | Base active: `linear-gradient(135deg, rgba(108,99,255,0.18), rgba(108,99,255,0.08))` | |
| `*text-sidebar` | `var(--text-secondary)` → `#7A8BA0` | |
| `*text-sidebar-muted` | `var(--text-secondary)` | |
| `*icon-sidebar` | Inherits `*text-sidebar` | |

### Warm Midnight (dark)
| Token | Value | Notes |
|---|---|---|
| `--bg-primary` | `#1A1625` | Deep purple-black |
| `--bg-secondary` | `#1E1730` | |
| `--bg-card` | `#241D35` | |
| `--bg-tertiary` | `#2C2445` | |
| `--text-primary` | `#F0EBF8` | Lavender white |
| `--text-secondary` | `#8878A8` | Muted purple |
| `--border` | `#3D3260` | |
| `--primary` | `#FF6B9D` | Hot pink |
| `--success` | `#72EFDD` | Mint |
| `--danger` | `#FF7B7B` | |
| `--warning` | `#FFD166` | |
| `*bg-sidebar` | Uses base styles (no sidebar override) | |
| `*bg-sidebar-active` | Base active uses `--primary` via gradient | |
| `*text-sidebar` | `var(--text-secondary)` → `#8878A8` | |
| `*text-sidebar-muted` | `var(--text-secondary)` | |
| `*icon-sidebar` | Inherits `*text-sidebar` | |

### Harbor Light (light, cool)
| Token | Value | Notes |
|---|---|---|
| `--bg-primary` | `#E8ECF1` | Cool blue-gray |
| `--bg-secondary` | `#D9DFE8` | |
| `--bg-card` | `#EFF2F6` | |
| `--bg-tertiary` | `#CDD5DF` | |
| `--text-primary` | `#2C3E50` | Dark slate |
| `--text-secondary` | `#6B7D8E` | |
| `--border` | `#B5C1CC` | |
| `--primary` | `#4A8B9F` | Teal-steel |
| `--success` | `#3B9E7C` | |
| `--danger` | `#C9605A` | |
| `--warning` | `#D4976A` | |
| `*bg-sidebar` | `linear-gradient(180deg, #8FA6B5, #97AEBB)` | Steel blue |
| `*bg-sidebar-active` | `rgba(30,51,68,0.35)` | Dark teal overlay |
| `*text-sidebar` | `#2C3E50` | Dark slate-blue (not white) |
| `*text-sidebar-muted` | `#4A6275` | Mid slate-blue, section labels |
| `*text-sidebar-group` | `#4A6275` | Nav group headers |
| `*icon-sidebar` | `#3A5468` | Slightly deeper than text for weight |

### Sage Journal (light, warm-neutral)
| Token | Value | Notes |
|---|---|---|
| `--bg-primary` | `#E8E3D8` | Warm parchment |
| `--bg-secondary` | `#DDD7CA` | |
| `--bg-card` | `#EDE9DF` | |
| `--bg-tertiary` | `#D0C9BA` | |
| `--text-primary` | `#3A3D2F` | Olive-charcoal |
| `--text-secondary` | `#7A7D6A` | |
| `--border` | `#BDB8A6` | |
| `--primary` | `#6B8F5E` | Sage green |
| `--success` | `#5A9A6E` | |
| `--danger` | `#B95E50` | |
| `--warning` | `#C4944F` | |
| `*bg-sidebar` | `linear-gradient(180deg, #8A8E76, #939882)` | Olive-sage |
| `*bg-sidebar-active` | `rgba(42,45,30,0.40)` | Dark olive overlay |
| `*text-sidebar` | `rgba(255,255,255,0.92)` | |
| `*text-sidebar-muted` | `rgba(255,255,255,0.72)` | Section labels |
| `*text-sidebar-group` | `rgba(255,255,255,0.70)` | Nav group headers |
| `*icon-sidebar` | Inherits `*text-sidebar` | |

### Dawn Ember (light, warm)
| Token | Value | Notes |
|---|---|---|
| `--bg-primary` | `#F0E5D8` | Warm peach-cream |
| `--bg-secondary` | `#E8D9CA` | |
| `--bg-card` | `#F5EDE4` | |
| `--bg-tertiary` | `#DBC9B6` | |
| `--text-primary` | `#3A2E28` | Warm charcoal |
| `--text-secondary` | `#7A6558` | Warm espresso |
| `--border` | `#CBB8A4` | |
| `--primary` | `#C07840` | Burnt orange / ember |
| `--success` | `#5E9E6F` | |
| `--danger` | `#C25A4A` | |
| `--warning` | `#D4944A` | |
| `*bg-sidebar` | `linear-gradient(180deg, #B8835E, #C09070)` | Terracotta |
| `*bg-sidebar-active` | `rgba(90,48,22,0.45)` | Deep terracotta overlay |
| `*text-sidebar` | `rgba(255,255,255,0.90)` | |
| `*text-sidebar-muted` | `rgba(255,255,255,0.62)` | Section labels |
| `*text-sidebar-group` | `rgba(255,255,255,0.60)` | Nav group headers |
| `*icon-sidebar` | Inherits `*text-sidebar` | |

### Blush Power (light, vibrant)
| Token | Value | Notes |
|---|---|---|
| `--bg-primary` | `#FF80B3` | Hot pink (app bg) |
| `--bg-secondary` | `#F5C4DC` | Warm blush-pink (panels, editors, nested surfaces) |
| `--bg-card` | `#FFD6E8` | Soft pink |
| `--bg-tertiary` | `#F0AFCC` | Desaturated rose (toolbars, column headers) |
| `--text-primary` | `#3D0020` | Deep wine |
| `--text-secondary` | `#7A3055` | Warm plum |
| `--border` | `#D4609A` | |
| `--primary` | `#AE1375` | Magenta |
| `--success` | `#00C896` | |
| `--danger` | `#CC0044` | |
| `--warning` | `#F4A261` | |
| `*bg-sidebar` | `linear-gradient(180deg, #AE1375, #B25199)` | Magenta gradient |
| `*bg-sidebar-active` | `#7F2365` | Darker magenta |
| `*text-sidebar` | `rgba(255,255,255,0.94)` | |
| `*text-sidebar-muted` | `rgba(255,255,255,0.75)` | Section labels |
| `*text-sidebar-group` | `rgba(255,255,255,0.72)` | Nav group headers |
| `*icon-sidebar` | Inherits `*text-sidebar` | |

---

## Global Usage Rules

### Sidebar text
1. **Only these tokens may color sidebar text:** `*text-sidebar`, `*text-sidebar-muted`, `*text-sidebar-group`, and `#fff` (hover/active only).
2. **Never use `var(--text-primary)` or `var(--text-secondary)` for sidebar text** in themes with colored sidebars — those are content-surface colors and will be unreadable on a tinted sidebar.
3. **Icons inherit `*text-sidebar`** unless explicitly overridden. Do not set separate icon colors without a clear contrast reason.

### White text on colored sidebars
- **Allowed in all themes except Harbor Light.** Dark themes use white/light text on dark sidebars. Light themes with mid-tone colored sidebars (Sage Journal, Dawn Ember, Blush Power) use white/near-white text for contrast.
- **Harbor Light is the exception:** its steel-blue sidebar (`#8FA6B5`–`#97AEBB`) is light enough to support dark slate-blue text instead of white. Harbor Light sidebar text uses `#2C3E50` (dark slate) for a calmer, more cohesive look. See Harbor Light guardrails.
- **Minimum opacity for white sidebar text** (themes that use it): `0.78` for nav items, `0.48` for muted labels. Prefer `≥0.85` for nav items and `≥0.60` for labels.

### Active nav emphasis
- Active state emphasis **must come from background + border styling**, not heavier font weight.
- All nav items share `font-weight: 600` and `font-size: 13px` — active items differ only in background, border, color (full white or theme-appropriate emphasis), and optional box-shadow.
- **Do not increase font-weight or font-size on active items.**

### Sidebar text color limits (light themes)
- Light themes should use **at most 3 sidebar text tiers.**
- **Sage Journal, Dawn Ember, Blush Power** (white-text sidebars):
  1. Full white (`#fff`) — active + hover only
  2. High-opacity white (`≥0.85`) — default nav items
  3. Mid-opacity white (`0.50–0.75`) — section labels and group headers
- **Harbor Light** (dark-text sidebar):
  1. Dark slate (`#2C3E50`) — active + hover emphasis
  2. Default slate (`#2C3E50` at base, darkening on hover) — default nav items
  3. Mid slate (`#4A6275`) — section labels and group headers
- **Do not introduce additional sidebar text colors** (e.g., theme accent for labels) in any light theme.

### Section headers
- Section headers (`.nav-section-label`, `.nav-group-header`) **may not use accent/primary colors** in light themes — use muted white (or muted slate-blue for Harbor Light) instead.
- In Denarii Forged, gold-tinted section labels (`rgba(255,210,122,0.42)`) are approved as a brand exception.
- Section headers must always be visually quieter than clickable nav items.

### Ad hoc color mixing
- **Do not use inline `rgba()` values that aren't derived from a theme token.** If you need a new tint, define it relative to an existing token.
- When creating hover/active backgrounds on the sidebar, use `rgba(255,255,255,α)` or `rgba(dark-base,α)` — not arbitrary colors.
- **Exception:** Denarii Forged uses brand-specific gradient overlays (`rgba(255,106,0,...)`, `rgba(255,210,122,...)`) which are approved brand tokens.

### Dashboard header / workspace-topbar
- Light themes **must override `.workspace-topbar`** — the base style is dark-mode optimized (`rgba(20,27,45,0.72)`) and reads as cool gray on light backgrounds.
- Light themes **must override `.hero-card`** — the base uses a purple-tinted gradient that clashes with warm/neutral light palettes.
- Override colors should use the theme's warm/cool character: warm cream for Dawn Ember, steel-cool for Harbor Light, etc.

### P&L / semantic colors
- `--success` and `--danger` are the **only approved colors for profit/loss display**.
- These must maintain ≥4.5:1 contrast against `--bg-card`.
- Do not theme-tint P&L values — they must be instantly recognizable across all themes.

---

## Theme-Specific Guardrails

### Harbor Light
- **Cool-only palette.** Do not introduce warm tones (orange, amber, terracotta) into Harbor Light surfaces.
- Sidebar is steel-blue (`#8FA6B5`–`#97AEBB`). Active nav uses dark-teal overlay, not a bright accent.
- **Dark slate-blue sidebar text, not white.** Harbor Light is the only light theme that uses dark text on its sidebar. The sidebar background is light enough that white text creates unnecessary contrast harshness. Use `#2C3E50` for nav items, `#4A6275` for muted labels, `#3A5468` for icons. Active/hover emphasis comes from darkening text toward `#1E3344` plus background changes — not from switching to white.
- **Do not drift back to white sidebar text.** If a future contrast check seems to warrant white, revisit the sidebar background lightness first.
- Content surfaces are cool gray (`#E8ECF1`, `#EFF2F6`). Do not warm these.
- Primary accent is teal-steel (`#4A8B9F`) — buttons and active indicators only.

### Sage Journal
- **Warm-neutral, not green-heavy.** The sage character comes from muted olive-green tints, not saturated greens.
- Sidebar is olive-sage (`#8A8E76`–`#939882`). Do not shift this toward pure green or brown.
- Content surfaces are warm parchment. Card backgrounds should feel like aged paper, not white.
- Primary accent `#6B8F5E` is used sparingly — buttons and active states, not large surfaces.

### Dawn Ember
- **Warm terracotta/burnt-orange, not brown.** The sidebar must read as muted burnt orange, never as generic brown.
- Sidebar gradient (`#B8835E`–`#C09070`) was specifically tuned away from brown. Do not darken or desaturate back toward taupe.
- Content surfaces use peach-cream (`#F0E5D8`, `#F5EDE4`). Do not cool these toward gray.
- Dashboard header uses warm apricot glass (`rgba(255,248,240,0.88)`). Do not remove this override or let it fall back to the dark-mode base.
- Primary accent `#C07840` — ember orange, not chocolate brown.

---

## Current Architecture Notes

- Sidebar tokens (`*bg-sidebar`, etc.) are **not CSS custom properties** — they are hardcoded in per-theme override blocks. A future refactor could promote these to `--` variables for cleaner maintenance.
- Soft Dark and Warm Midnight have **no sidebar overrides** — they inherit base dark-mode styles. This works because the base sidebar uses `var()` tokens that resolve correctly for dark themes.
- `.nav-child` still carries `font-size: 13px !important` which is now redundant (base `.nav-item` is `13px`). Harmless but could be cleaned up.
- `.nav-group-header` uses `var(--text-secondary)` as its base color, which works for dark themes but required explicit overrides for light themes (Sage Journal, Dawn Ember, Blush Power). Harbor Light is missing this override and needs one using `#4A6275` (not white) per the spec.
