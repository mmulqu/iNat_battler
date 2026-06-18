# Settings Tab — Plan

A dedicated **Settings** view that consolidates account/preferences controls,
most of which currently live scattered in the desktop sidebar (`<aside class="panel">`)
or buried in other screens. Pairs with the mobile sidebar-decluttering work
(the sidebar was made contextual per-view; Settings gives Account a permanent home).

Placement: a ⚙️ **Settings** item in the mobile **More** sheet, and a tab/gear on
desktop.

## Dev-tools relocation (do alongside / first)

The shared sidebar's dev sprite tools belong in **Dev Lab only**, not stacked on
every tab:

- **Dev Batch** (roster sprite generation) → move into `devView`.
- **Global Seed** (shared sprite library generation) → move into `devView`.
- **Manual Sprite** (upload your own custom sprite) → move into **Settings → Sprites**
  (it's a user feature, not a dev/admin tool).

## What goes in Settings

Legend: ✅ already exists (relocate) · 🆕 new build.

### Account & identity
- ✅ Signed in as `@handle` → **Log out** (`/api/auth/logout`; today a "Sign out"
  button inside the Bluesky panel).
- ✅ Linked iNaturalist account (e.g. `mmulqueen`) → **Re-import / refresh roster**
  (existing import flow). 🆕 **Unlink / re-link**.
- ✅ Account stats (Taxa / Sprites / Queued / Affinity) — move out of the sidebar.

### Appearance
- ✅ **Theme: Light / Dark / System** — SHIPPED (first pass). `:root` light tokens +
  `[data-theme="dark"]` override (added `--surface-2/-3`, `--surface-translucent`,
  `--line-soft`, `--teal-soft`); early `<head>` script sets the theme pre-paint (no
  flash); Settings segmented toggle persists to `localStorage["inatBattler:theme"]` and
  follows the OS via `matchMedia` when set to System; updates the PWA `theme-color` meta.
  Surfaces (cards, panels, buttons, striped rows) were tokenized. _Follow-up: a few
  semantic-tinted chips remain hardcoded (type chips, tier chips, some blue/coral status
  tints) and read a bit light in dark mode — tokenize on a polish pass; also the battle
  arena gradients + map could use dark-tuned values._
- 🆕 **Reduce motion** toggle (CSS already honors the OS `prefers-reduced-motion`;
  add a manual override).
- ✅ Default sprite/tile size (per-view zoom sliders exist — promote one global default).

### Gameplay
- ✅ **Sound effects** on/off (`state.soundOn`; today buried in the battle screen).
- ✅ Default **NPC difficulty** (today in the sidebar team picker). _Optional — keep it
  next to the Battle NPC button for now; revisit._

### Sprites
- ✅ **Custom/manual sprite upload** + submission status (pending QA / approved /
  rejected).
- ✅ Default sprite source (AI vs your uploads) — per-taxon preference API exists; a
  global default is small.

### Notifications (placeholder until web push lands)
- 🆕 Challenge received / accepted → email / Bluesky / web-push toggles.

### Privacy & data — required before public alpha (see public-alpha-readiness-plan.md)
- 🆕 **Delete account + imported data** (Bluesky DID + iNat data).
- 🆕 "What we store" disclosure + privacy / terms links.
- 🆕 Export my data (optional).

### About / app
- 🆕 **Install app** (PWA `beforeinstallprompt` — not currently wired).
- 🆕 Version / build, "Alpha" label, links (GitHub, feedback).
- 🆕 **Dev Lab access** toggle (ties into roadmap dev-gating).

## Build order

1. **Cheap wins (this pass):** create the Settings view + nav entry; relocate
   **Log out, Account stats, Sound toggle, Manual Sprite, Re-import roster** into it;
   move **Dev Batch + Global Seed** into Dev Lab. Pure relocation/consolidation — no
   new features, low risk.
2. **Dark mode** as a focused follow-up (whole-stylesheet theming).
3. **Privacy & data** (delete account + disclosures) — a hard gate for public alpha.
4. Notifications, PWA install, unlink, About — incremental.
