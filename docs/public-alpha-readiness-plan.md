# iNat Battler Public Alpha Readiness Plan

## Goal

Move iNat Battler from a developer-facing control panel toward a public-facing app for iNaturalist users, especially Bluesky users, while keeping the current development and batch-generation tools available to the project owner.

The app already has the core game machinery: iNaturalist imports, Bluesky auth, roster cards, sprites, training, challenges, QA, sprite batches, and global seed tooling. The next phase is to improve first impressions, onboarding, navigation, and large-roster usability.

## Audience

- iNaturalist users who are curious about turning their observations into a creature-battler roster.
- Bluesky users who may discover the app through challenge posts.
- Early alpha testers who need a guided path rather than a full developer console.
- The project owner, who still needs access to batch tools, sprite QA, seed status, and other internal controls.

## Product Direction

The site should have two clear modes:

1. Public/logged-out mode: a landing page that explains the game, shows a fantasy battle hero image, and prompts Bluesky sign-in.
2. Player/logged-in mode: a compact app dashboard for importing observations, managing a roster, training species, and battling.

Development controls should remain available only as private ops endpoints or owner-only
scripts. They should not appear in the player-facing frontend.

## Landing Page

Create a public landing page for logged-out visitors.

Key elements:

- Hero image showing a fantasy nature-spirit battle, not a screenshot of current gameplay.
- Clear product name: iNat Battler.
- One-sentence pitch: turn iNaturalist observations into a creature-battler roster.
- Primary call to action: Sign in with Bluesky.
- Secondary call to action: See how it works.
- Short four-step explanation:
  - Sign in with Bluesky.
  - Verify your iNaturalist username.
  - Import observed species.
  - Build a team and battle.
- Small privacy/trust section:
  - Uses public iNaturalist observation summaries.
  - Does not require an iNaturalist password.
  - Bluesky is used for identity and challenges.
  - Public alpha is not fully open yet.

## Onboarding Flow

After Bluesky sign-in, avoid dropping new users directly into the full app.

Recommended setup sequence:

1. Confirm Bluesky identity.
2. Ask for iNaturalist username.
3. Generate and display the verification code.
4. Explain where to paste the code in the iNaturalist profile.
5. Verify the profile.
6. Import observations.
7. Show a first roster summary:
   - Total taxa imported.
   - Ready sprites.
   - Queued sprites.
   - Battle-ready species.

The user should end setup on the Home dashboard, not deep inside the roster grid.

## Logged-In App Structure

Add or reshape the main logged-in navigation around these views:

- Home: player summary, current team, next action, recent sprites, challenge status.
- Roster: searchable collection and team picking.
- Battle: active arena, incoming/outgoing challenges, team readiness.
- Training: existing stat allocation and mastery work.
- Sprite Tree: collection/progress exploration.
- Recently Added: new global sprites.
Dev Lab is no longer a player-facing view. Internal batch, seed, manual shared-library
upload, and sync tools stay in the Worker as private ops endpoints, guarded by admin
identity env vars and intended for CLI/script use or a future owner-only surface.

The current left sidebar is useful, but it mixes too many workflows. Over time, move context-specific actions closer to the tab where they are used.

## Roster Usability

The roster should not require scrolling through very long pages of sprite cards.

Improvements:

- Keep search, sort, filters, and view controls sticky.
- Show roster in pages or virtualized chunks.
- Add quick filters:
  - Ready
  - Queued
  - Missing
  - Favorites
  - Battle Team
- Keep Sprite Grid as an optional visual mode.
- Add a compact list/table mode for large rosters.
- Reduce card height or increase information density.
- Keep taxon group chips, but make them secondary to readiness and team-building filters.

Target behavior:

- A player with hundreds of taxa can find, filter, and select species without scrolling through the entire collection.
- The default view should help the next player action, not simply display everything.

## Battle Page

The empty Battle tab should feel like a real arena entry point.

Improvements:

- Show selected team slots.
- Show challenge controls and incoming challenge state.
- Display a battle-ready checklist when no battle is active.
- Use a battle-themed visual preview or backdrop.
- Keep test battle controls out of normal player workflows unless explicitly exposed as a
  safe demo/NPC mode.

## Visual Design

Keep the natural green base, but make the app feel less like a flat admin panel.

Design goals:

- Stronger first impression with fantasy battle art.
- More contrast between primary actions, secondary controls, and status badges.
- Broader natural palette: moss green, amber, berry red, sky blue, neutral stone.
- Less reliance on similar pale cards.
- Sprite art should feel collectible and valuable.
- The interface should still be practical and dense once a user is inside the app.

Avoid:

- A long marketing-only site with no direct path to the app.
- Overly decorative UI that makes roster management slower.
- Exposing internal batch tooling to ordinary visitors.

## Dev And Admin Tools

Keep existing development workflows.

Changes:

- Keep batch tools, global seed status, manual shared-library uploads, sync buttons, and
  debug actions out of the public frontend.
- Guard private ops endpoints server-side with admin identity checks; hiding frontend
  links is not sufficient security.
- Return not-found responses to non-admins on private ops routes to avoid advertising
  them to probes.
- Keep direct APIs available for trusted use.

## Growth & Community

Features that help the app reach and retain players once the public alpha is live.
Most of these are post-readiness (not blockers for inviting testers), but they shape
the social loop that brings iNaturalist/Bluesky users in.

### Battle highlight clips — ✅ SHIPPED (2026-06-19)

Render short MP4 highlights of battles and share them. Full design + per-phase
status in `docs/battle-highlights-bluesky.md`.

- Deterministic seeded replay → canvas redraw → in-browser **WebCodecs H.264 MP4**
  (`src/replay-page.js`), one renderer that runs in the user's browser (Share button,
  $0 server cost) and in headless Chrome for the bot (`src/highlight-bot.js`).
- A user "Share as video 🎥" button on the result overlay posts to the brand feed;
  bytes stream straight to Bluesky (R2 bypassed) and the MP4 is discarded after.
- Crits/KOs are reproduced exactly because the engine RNG is fully seeded — no
  separate "highlight trigger" capture is needed; the whole battle replays.

### Bluesky auto-posting — ✅ SHIPPED (2026-06-19)

An autonomous curator (`runHighlightCurator`, cron) renders and posts notable battles
to the brand feed.

- Scores recent opted-in **wins** (≤72h), renders the best, posts crediting the player
  via @mention; KV-throttled with a daily cap and a `battle_highlights` dedupe ledger.
- Per-user opt-in (`users.allow_highlight_bot` + Settings "Highlight videos" toggle);
  reuses the atproto plumbing. Gated behind `HIGHLIGHT_BOT_ENABLED` (currently "false").
- Per-user posting to a player's **own** account is deferred (needs broader OAuth
  scope); button + bot post to the brand feed for now.

### Brand Bluesky account — ✅ DONE (@wildmarch)

The public account the auto-posts publish to is live: **@wildmarch.bsky.social**
(email verified). Its app password lives only as the Worker secret
`BSKY_BOT_APP_PASSWORD` with the `BSKY_BOT_IDENTIFIER` var — never committed.
_Remaining: profile/avatar/banner polish + a pinned "what is this" post linking to the
app, and alpha announcements once testing opens._

### Custom sprite creation repo

A separate public repository that teaches players how to create and upload their own
species sprites.

- Standalone repo (keeps the main app repo focused) with a clear, friendly guide.
- Contents:
  - Step-by-step instructions for creating a sprite and uploading it through
    **Settings → Sprites** (the per-user Discord-QA path).
  - Recommended prompts / prompt templates for generating sprites in the app's art
    style.
  - Suggested image models/tools (and any settings that match our look — transparent
    background, consistent framing, size).
  - Style/spec guidance: dimensions, transparency, framing, file format, do/don't
    examples.
  - QA/approval expectations so contributors know what gets accepted.
- Link it from the app (Settings → About, and the landing "how it works") once it
  exists.

## Recent Progress (2026-06-19)

- Dev Lab is no longer exposed in the public app frontend. Dev Batch, Global Seed,
  manual shared-library upload, batch sync/status, and related private operations are
  available only through server-side admin-gated endpoints.
- Authenticated public custom sprite uploads remain open through **Settings → Sprites**
  and the Discord QA flow. The approval/submission list is private to the signed-in
  submitter: players cannot list another user's submissions, even after approval.
  Approved sprites can still appear as actual in-game art for other players once QA
  approves them; pending sprites remain owner-only.
- Sprite Tree now shows an in-tab loading spinner with rotating `iNat_trees`-style
  taxonomy messages so users know the tab is working. The tree API was also optimized
  with a ranked ready-asset query plus short client/server caches.
- Battle balance was rechecked with a 153,000-duel body-plan simulation
  (`npm run simulate -- 1000`). This validates the core 1v1 engine/mana/type rules, not
  full 5v5 production battles with generated species moves, training, terrain, or
  switching. The system is much closer than the original baseline, but body-plan win
  rates still need tuning before public alpha.
- **Public landing page is live** (`#publicLanding`): fantasy hero art
  (`landing-hero-battle.webp`), product name + one-line pitch, "Sign in with Bluesky"
  CTA + "See how it works", a 4-step How It Works, and an Alpha Notes/trust section.
  Logged-out visitors see the landing; signing in swaps to the app layout. Verified
  responsive on desktop + mobile.
- **Guided onboarding is live** (`renderOnboardingHome`): a signed-in but unlinked user
  lands on a Home setup card with a 3-step flow (Bluesky connected → choose iNaturalist
  username → paste verification code & verify+import), an "Open iNaturalist settings"
  link, and the no-password explanation. After verify+import they land on the Home
  dashboard.
- **Home dashboard is live** (`renderHome`): default logged-in view with player summary,
  next-action card, team/roster shortcuts, and recently-added sprites — Roster is no
  longer the first thing a player sees.

### Security & hardening (2026-06-19)

- Closed 4 unauthenticated mutation routes (IDOR): team save, NPC battle start, battle
  action, sprite preference — identity now derives from the session cookie, not the
  path/body; battle action verifies ownership.
- Replaced wildcard CORS with an allowlist; spend-cap default flipped
  (`DISABLE_GENERATION_LIMITS="false"`); KV per-IP rate limiting on auth/account/link/
  share endpoints; `AbortSignal.timeout` on all server-side external calls; hot-path DB
  indexes (migration 0019).
- Maintainability refactors: extracted the embedded client CSS/JS to `src/app.css` +
  `src/app-client.js` (Text modules) and converted the router to a route table.

## Public Alpha Checklist

Before inviting broader testers:

- ✅ Landing page exists and works for logged-out visitors.
- ✅ Bluesky sign-in CTA is clear.
- ✅ iNaturalist verification flow is guided and understandable.
- ◻ Roster can handle hundreds of taxa without endless scrolling. _(pagination shipped;
  quick filters / compact mode still to do — see Roster Usability.)_
- ◻ Battle tab has a useful empty state and team readiness flow.
- ✅ Dev tools are absent from normal player workflows and private ops routes are admin-gated.
- ✅ Privacy/data explanation is visible.
- ✅ The app clearly labels itself as pre-alpha or alpha.
- ◻ Error states are understandable for auth, iNaturalist import, sprite generation, and challenge creation.

## Implementation Order

1. ✅ Add a public landing page and logged-out hero.
2. ✅ Generate or add a fantasy battle hero image asset.
3. ✅ Create a Home dashboard for logged-in users.
4. ✅ Convert the existing default logged-in view from Roster to Home.
5. ✅ Improve iNaturalist linking into a guided setup panel.
6. ◻ Add roster quick filters and reduce long scrolling.
7. ◻ Add compact roster mode or pagination improvements. _(pagination shipped.)_
8. ◻ Improve Battle empty state and team readiness display.
9. ✅ Remove internal generation controls from the public frontend.
10. ✅ Add dev/admin gating for internal controls.
11. ◻ Polish visual hierarchy and status messaging.

## Open Decisions

- Whether public visitors should be able to browse example sprites before signing in.
- Whether alpha access should be allowlisted by Bluesky DID, iNaturalist username, or a simple environment flag.
- Dev Lab decision is made: no public Dev Lab tab; private ops routes are admin-gated.
- Whether the first public battle experience should use real async Bluesky challenges only or also support a safe NPC/demo battle.
- Whether custom sprite QA belongs in the sidebar, Home dashboard, or a separate account/sprites view.
