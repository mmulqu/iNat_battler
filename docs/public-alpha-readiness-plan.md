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

Development controls should remain available, but they should live in a clearly marked Dev Lab and be hidden or gated away from normal users.

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
- Dev Lab: internal batch, seed, QA, manual upload, and sync tools.

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
- Keep test battle controls available only in Dev Lab or dev mode.

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

- Keep Dev Lab as the home for batch tools, global seed status, manual uploads, sync buttons, and debug actions.
- Add a visible dev/admin badge when internal tools are available.
- Hide or disable Dev Lab for users who are not allowed to access it.
- Keep direct APIs available for trusted use.

## Public Alpha Checklist

Before inviting broader testers:

- Landing page exists and works for logged-out visitors.
- Bluesky sign-in CTA is clear.
- iNaturalist verification flow is guided and understandable.
- Roster can handle hundreds of taxa without endless scrolling.
- Battle tab has a useful empty state and team readiness flow.
- Dev tools are separated from normal player workflows.
- Privacy/data explanation is visible.
- The app clearly labels itself as pre-alpha or alpha.
- Error states are understandable for auth, iNaturalist import, sprite generation, and challenge creation.

## Implementation Order

1. Add a public landing page and logged-out hero.
2. Generate or add a fantasy battle hero image asset.
3. Create a Home dashboard for logged-in users.
4. Convert the existing default logged-in view from Roster to Home.
5. Improve iNaturalist linking into a guided setup panel.
6. Add roster quick filters and reduce long scrolling.
7. Add compact roster mode or pagination improvements.
8. Improve Battle empty state and team readiness display.
9. Move test battle and internal generation controls fully into Dev Lab.
10. Add dev/admin gating for internal controls.
11. Polish visual hierarchy and status messaging.

## Open Decisions

- Whether public visitors should be able to browse example sprites before signing in.
- Whether alpha access should be allowlisted by Bluesky DID, iNaturalist username, or a simple environment flag.
- Whether Dev Lab should be hidden entirely or visible but locked for non-dev users.
- Whether the first public battle experience should use real async Bluesky challenges only or also support a safe NPC/demo battle.
- Whether custom sprite QA belongs in the sidebar, Home dashboard, or a separate account/sprites view.
