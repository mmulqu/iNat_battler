# Settings Tab — Plan

A dedicated **Settings** view that consolidates account/preferences controls,
most of which currently live scattered in the desktop sidebar (`<aside class="panel">`)
or buried in other screens. Pairs with the mobile sidebar-decluttering work
(the sidebar was made contextual per-view; Settings gives Account a permanent home).

Placement: a ⚙️ **Settings** item in the mobile **More** sheet, and a tab/gear on
desktop.

## Dev-tools relocation — ✅ DONE (2026-06-18)

The shared sidebar's dev sprite tools now live where they belong:

- ✅ **Dev Batch** (roster sprite generation) → moved into `devView`.
- ✅ **Global Seed** (shared sprite library generation) → moved into `devView`.
- ✅ **Manual Sprite** (upload your own custom sprite) → moved into **Settings → Sprites**.
- ✅ Sidebar now holds only Bluesky challenges + team picker + Queue More, and is hidden
  on focused mobile tabs (Map/Settings/Leaderboard/Training/Sprite Tree; Queue More
  hidden on Battle).

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
- ✅ **Delete account + imported data — DONE (2026-06-18).** Settings → Privacy & data:
  "what we store" disclosure + a two-step **Delete account** flow → `POST
  /api/account/delete`. Wipes everything keyed to the player's DID and `inat:<login>`
  (account/auth, roster, teams, training, masteries, sprite prefs, ratings, gen budget,
  territory players/observations/actions/garrison, battle instances/results, challenges);
  releases owned tiles to neutral; preserves shared/global data. Player chooses whether to
  also remove sprites they contributed to the shared library (with an effect note);
  best-effort R2 blob cleanup; logs out + returns to landing. _Caveat: the deletion path
  itself wasn't run end-to-end (can't without deleting a real account) — SQL reviewed
  against the schema; test with a throwaway Bluesky account before relying on it._
- 🆕 "What we store" disclosure ✅ (in the section). Privacy / terms **links** still TODO.
- 🆕 Export my data (optional) — not started.

### About / app
- 🆕 **Install app** (PWA `beforeinstallprompt` — not currently wired).
- 🆕 Version / build, "Alpha" label, links (GitHub, feedback).
- 🆕 **Dev Lab access** toggle (ties into roadmap dev-gating).

## Build order

1. ✅ **Cheap wins — DONE (2026-06-18).** Settings view + ⚙️ nav entry; relocated Log out,
   Account stats, Sound toggle, Manual Sprite, Re-import roster; moved Dev Batch + Global
   Seed into Dev Lab.
2. ✅ **Dark mode — DONE (first pass, 2026-06-18).** Light/Dark/System toggle, tokenized
   surfaces, no-flash init. Plus contrast fixes (battle empty state, roster chips,
   card-back stats). _Remaining polish: tier/status colored chips + battle-arena gradients
   + map dark-tuning, and a Reduce-motion toggle._
3. ✅ **Privacy & data — DONE (2026-06-18).** Delete-account flow + "what we store"
   disclosure. **TODO before relying on it:** the wipe path was never executed
   end-to-end (couldn't, without deleting a real account). Test once with a throwaway
   Bluesky account — sign in, link any iNat name, import, then delete — and confirm the
   rows are actually gone across the user-scoped tables. (Privacy/terms links + data
   export still pending.)
4. **Dev Lab access gating** — Dev Lab is consolidated but still visible to all users;
   gate behind admin (ties into Phase 5). NOT started.
5. Notifications, PWA install, unlink, About — incremental.
