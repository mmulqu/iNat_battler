# Settings Tab — Plan

A dedicated **Settings** view that consolidates account/preferences controls,
most of which currently live scattered in the desktop sidebar (`<aside class="panel">`)
or buried in other screens. Pairs with the mobile sidebar-decluttering work
(the sidebar was made contextual per-view; Settings gives Account a permanent home).

Placement: a ⚙️ **Settings** item in the mobile **More** sheet, and a tab/gear on
desktop.

## Dev-tools relocation / removal — ✅ DONE (2026-06-18)

The shared sidebar's dev sprite tools first moved into Dev Lab, then Dev Lab was removed
from the public frontend entirely:

- ✅ **Dev Batch** (roster sprite generation) → removed from app UI; backend route is
  admin-only.
- ✅ **Global Seed** (shared sprite library generation) → removed from app UI; backend
  route is admin-only.
- ✅ **Manual shared-library upload** → admin-only backend route.
- ✅ **Custom player sprite upload** → **Settings → Sprites**, using the authenticated
  per-user Discord-QA path.
- ✅ Sidebar now holds only Bluesky challenges + team picker, and is hidden on focused
  mobile tabs (Map/Settings/Leaderboard/Training/Sprite Tree).
- ✅ **Queue More removed from the public sidebar** until the missing-sprite fallback gets
  a proper player-safe UX and cost ceiling.

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
- ✅ **Dev Lab access**: no public Dev Lab tab. Private ops routes are server-gated by
  `ADMIN_DIDS` (plus optional handle/iNat-login env fallbacks) and return 404 to
  non-admins. Configure the deployed admin identity before relying on these routes.

## Build order

1. ✅ **Cheap wins — DONE (2026-06-18).** Settings view + ⚙️ nav entry; relocated Log out,
   Account stats, Sound toggle, Custom Sprite, and Re-import roster; removed Dev Batch +
   Global Seed from the public frontend.
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
4. ✅ **Dev Lab access gating / removal — DONE (2026-06-18).** Dev Lab is gone from the
   frontend. Private batch/global-seed/dev endpoints are admin-gated server-side.
   Remaining operational task: set `ADMIN_DIDS` in the deployed Worker vars and verify a
   non-admin account gets 404.
5. Notifications, PWA install, unlink, About — incremental.
