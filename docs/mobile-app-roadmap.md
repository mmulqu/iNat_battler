# iNat Battler — Mobile-First Full-App Roadmap

## Goal

Take iNat Battler from a working desktop-first tool to a full, mobile-first app that
iNaturalist and Bluesky users can pick up, install, and return to. Mobile is the
priority surface, not an afterthought.

## Where the app stands today

A single Cloudflare Worker (`src/index.js`, ~15k lines) server-renders an HTML shell
and runs a vanilla-JS SPA on top of it. The hard parts already work:

- **Auth**: Bluesky atproto OAuth with a proper session cookie
  (`HttpOnly; Secure; SameSite=Lax`).
- **iNaturalist linking**: verification-code-in-profile flow. Per-user reads (roster
  import, training sync, territory obs sync) now fetch in the **user's own browser**
  (iNat v2 CORS GET) and POST rows to the Worker just to persist, so the iNat rate limit
  lands per-user (Worker fetch kept as fallback). Roster import is capped at 10k species.
- **Core loop**: roster import, training/stat allocation, sprite generation pipeline
  (D1 + R2 + KV + Queues + OpenAI batch), challenges (async via Bluesky) plus NPC/demo
  battles, leaderboard with Bluesky sharing.
- **Views**: home, roster, battle, training, tree, recent, leaderboard, dev — switched
  client-side.

### Mobile reality check

Passable on a phone, but built desktop-first:

- Viewport meta tag is present; layout collapses at only **2 breakpoints**
  (880px, 520px).
- **Zero touch/pointer handling** anywhere in the client.
- **No PWA**: no manifest, no service worker, no install / home-screen affordance, no
  `theme-color` / apple-mobile-web-app meta tags.
- Top-tab navigation with **8 tabs** — too many for a phone.
- Battle arena uses fixed min-heights that need real small-screen testing.
- You rate-limit *iNaturalist's* API but not *your own* — and sprite generation costs
  real money.

The existing `docs/public-alpha-readiness-plan.md` covers landing / onboarding / roster
/ battle / dev-gating / visual. The itinerary below folds that in and extends it with
the mobile-first lens plus the production gaps that plan doesn't cover.

---

## Progress log (updated 2026-06-13)

**Phase 1 — Mobile foundation: substantially shipped.**

- ✅ **Bottom tab nav** (Home / Roster / Battle / Buddies / More sheet); top tabs hidden
  on phones; only shows inside the app.
- ✅ **Touch + viewport hygiene**: `viewport-fit=cover` + safe-area insets, 44–56px
  targets, iOS text-auto-zoom off, `overflow-x` guard, tap-highlight/`touch-action`.
- ✅ **PWA installability**: manifest, service worker (network-first nav, cache-first
  assets), brand icons (192/512/maskable + apple-touch-icon), `theme-color`. Verified
  installable via Playwright.
- ✅ **Responsive bug fixes (Playwright QA at 360–390px)**: fixed a `[hidden]` leak that
  showed the empty app + import form on the logged-out landing; fixed Home battle-team
  slots rendering 360px tall each.
- ✅ **Payload**: landing hero re-encoded PNG→WebP, **2.6MB → 168KB (−93.6%)** on the
  critical path; status sprite sheets resized from 7.37MB to 792KB for battle-only load.
- ✅ **Mobile battle layout**: active battle is a fixed one-screen surface (nav hidden) —
  stage + both HP bars + status chips + 2×2 moves fit without scrolling; log below.
- ✅ **Swap species dialog**: replaced unreadable bench boxes with a "Swap!" button →
  picker dialog (sprite thumbnail + name + HP bar per teammate).
- ◑ **Real-device QA**: done headless via Playwright (390px + desktop). Real iOS
  Safari / Android Chrome pass (incl. the Bluesky OAuth redirect) still pending.

**Add-on shipped early:** ✅ the AIM-style Bluesky presence **Buddy list** (see bottom).

**Tooling:** ✅ project-scoped Playwright MCP added for browser-driven QA.

**Progress (updated 2026-06-17):**

- ✅ **iNat per-user rate-limit funnel SOLVED** (2026-06-15): roster import, training
  sync, and territory obs sync now fetch in the user's own browser and POST rows to the
  Worker just to persist — so the iNat budget lands per-user, **no OAuth needed**. Only
  shared/cacheable data and the admin global-seed import still funnel through the Worker
  (not user-proportional). **No longer a scaling blocker; iNat OAuth stays deferred** (it
  would only add unobscured coords for a user's own threatened-taxa observations).
- ✅ **Species roster re-derived correctly**: fixed the global-seed query to filter by
  kingdom `taxon_id` (Animalia=1 / Plantae=47126), not `iconic_taxa=Animalia` — which is
  iNat's invertebrate catch-all and had excluded birds/mammals/insects (so the old roster
  was woodlice/anemones and missed gray squirrel, mallard, etc.). Rebuilt the
  most-observed roster and backfilling the gaps via OpenAI batches (ready sprites ~1,560+
  and climbing).
- ✅ **Sprite Tree is now a real mobile taxonomic navigator** (not the old indented
  outline): backfilled ancestor taxa give `Life › kingdom › … › genus › species`
  normalized to the major Linnaean rungs; breadcrumb trunk + 2-column clade card grid +
  animated species gallery + per-group color theming. Verified at 390px.

**Progress (updated 2026-06-18):**

- ✅ **Mobile tabs decluttered.** The desktop control sidebar stacked below every mobile
  view; made it contextual via `body[data-view]` — hidden on Map/Settings/Leaderboard/
  Training/Sprite Tree, Battle keeps only Bluesky challenges + team picker, Home/Roster
  keep it.
- ✅ **Settings tab** (⚙️ in the More sheet + desktop tab): relocated Account stats,
  Sound toggle, Re-import roster, Sign out, and the custom sprite uploader. **Dev Batch +
  Global Seed are now private ops only, not app tabs.** See `settings-plan.md`.
- ✅ **Dark / Light / System theme** (first pass): tokenized surfaces + `[data-theme]`
  override, no-flash init, Settings toggle persisted + OS-following. Plus contrast fixes
  (battle empty state, roster chips, card-back stats). _Polish remaining: colored tier/
  status chips, battle-arena gradients, map dark-tuning, reduce-motion toggle._
- ✅ Fixed the **More sheet opening behind the Leaflet map** (z-index).
- ✅ **Dev Lab removed from the public frontend** (2026-06-18): desktop/mobile nav no
  longer expose Dev Lab, Dev Batch, Global Seed, batch trackers, or Queue More. Private
  ops endpoints remain in the Worker but are guarded by an admin session check
  (`ADMIN_DIDS`, optional `ADMIN_BSKY_HANDLES` / `ADMIN_INAT_LOGINS`) and return 404 to
  non-admins. This keeps the controls out of the app UI; true protection is the
  server-side gate, not obscurity.
- ⏳ **Sprite gap backfill** ongoing: total ready sprite assets are now **2,003**. The two
  134-item image batches submitted 2026-06-18 both completed and synced successfully.
  Global seed status currently reports **1,346 / 2,000** seed taxa ready, with **654**
  still queued/submitted. There is also cleanup/requeue work for **650 submitted items**
  attached to earlier failed batch rows. Fixed expired/cancelled batch sync so partial
  OpenAI results are recovered.

### What's next (recommended order)

1. **Finish private-ops hardening** — configure the deployed admin identity vars
   (`ADMIN_DIDS` at minimum), verify non-admins get 404 on batch/global-seed/dev routes,
   and keep admin tooling out of the public HTML. Endpoint names can still be known if
   someone reads the source or guesses them; the server-side admin gate is the control.
2. **Phase 5 cost gating** (non-negotiable before opening up) — rate-limit **your own**
   API, especially sprite generation; per-user + global ceilings with clear 429 UX.
   _(The iNat funnel is already handled — this is about your own OpenAI/generation cost.)_
3. **Real-device QA** — the OAuth round-trip on actual iOS/Android.
4. **Phase 2 onboarding** — the guided mobile setup flow + missing-sprite fallback state.
5. **Phase 4 retention** — wire the Buddy list into challenges ("challenge who's online").
6. **Sprite Tree polish (optional)** — SVG "vine" connectors + grow/idle animation, and a
   sunburst coverage minimap (doubles as a "which branches still need sprites" view).

---

## Itinerary

### Phase 1 — Mobile foundation (the "first and foremost")

1. ~~**Responsive overhaul.** Audit every view at 360/390/430px widths.~~ ✅ Mostly done
   — audited Home/Roster/Battle/Dev/Buddies at 360–390px via Playwright; fixed the
   `[hidden]` leak + tall team slots. Battle fully reworked. _Remaining: deeper polish of
   a couple dense panels (training allocation, some dev forms)._
2. ~~**Bottom tab nav for mobile.**~~ ✅ Done — Home / Roster / Battle / Buddies / More
   sheet; top tabs hidden on phones.
3. ~~**Touch targets & interactions.** 44px minimum hit areas.~~ ✅ Done (base) — 44–56px
   targets, tap-highlight/`touch-action`, no hover-only affordances.
4. ~~**PWA installability.** Manifest + icons + `theme-color` + apple tags + service
   worker.~~ ✅ Done — verified installable.
5. ◑ **Payload weight.** ✅ Landing hero PNG→WebP (2.6MB → 168KB). _Pending: the 5 status
   sprite sheets (~7.5MB, battle-only) — lossless/sprite-aware path needed._
6. ◑ **Real-device QA.** ✅ Headless Playwright (390px + desktop). _Pending: real iOS
   Safari / Android Chrome, especially the Bluesky OAuth redirect round-trip._

### Phase 2 — Onboarding & first-run (mobile-native)

7. Guided setup flow from the readiness plan (confirm Bluesky → enter iNat username →
   show/paste verification code → verify → import → first roster summary), designed as a
   stepped mobile flow, not a desktop form.
8. Default logged-in landing on **Home**, not the raw roster grid.
9. Graceful "your species has no sprite yet" state — the ready set is ~1,560+ of the
   ~2,000 most-observed roster (gaps still backfilling), and a user's long-tail species
   may have none; show a placeholder + on-demand queue rather than a blank.

### Phase 3 — Roster at scale (mobile-critical)

10. Virtualized/paginated roster (hundreds of taxa must not be one long scroll on a
    phone).
11. Sticky search + quick filters (Ready / Queued / Missing / Favorites / Battle Team)
    and a compact list mode alongside the sprite grid.

### Phase 4 — The battle loop people return for

12. Solid NPC/solo battles so the app is fun with zero opponents online (async-only
    would feel dead at alpha scale).
13. ◑ Battle tab empty state + team-readiness checklist; challenge send/accept/decline
    flows polished for mobile. ✅ Mobile battle is one-screen with a Swap dialog;
    _remaining: the challenge send/accept/decline flows themselves on mobile._
14. **Notifications** for "challenge received/accepted" — once the PWA exists, web push;
    interim, lean on Bluesky notifications or email. This is the main retention lever.

### Phase 5 — Production hardening (before inviting anyone)

15. **Rate-limit and gate your own API**, especially sprite generation — per-user and
    global cost ceilings, abuse protection. You have the env knobs (`MAX_*`); wire
    enforcement + clear 429 UX.
16. Comprehensive **error states** for auth failure, iNat import failure/rate-limit,
    sprite generation failure, challenge creation failure.
17. **Alpha access control** — decide allowlist (Bluesky DID / iNat username / env flag)
    vs. open. Dev Lab is no longer a public tab; private ops routes are admin-gated and
    should be driven from CLI/scripts or a separate owner-only surface.
18. **Legal/trust**: privacy policy, terms, data-deletion path (Bluesky DID + imported
    iNat data), "what we store" disclosure, visible alpha labeling. Required before
    public, and Bluesky/iNat users will expect it.
19. **Observability**: lightweight analytics + error tracking so you can see what mobile
    users actually hit.

### Phase 6 — Polish & growth

20. Visual hierarchy pass (the readiness plan's palette/contrast work),
    collectible-feeling sprite presentation, shareable battle/rank cards optimized for
    Bluesky embeds.

---

## Ordering rationale

Phases 1–3 are the mobile-first core — without them the app is a desktop tool that
technically loads on a phone. Phase 4 is what makes it worth returning to. Phase 5 is
the gate before real users come in (cost abuse and legal are the two that can actually
hurt you). Treat **Phase 1**, **Phase 5 cost gating**, and the **missing-sprite
fallback** as the non-negotiables for a public mobile alpha.

## Open decisions

- How to gate alpha access (Bluesky DID allowlist / iNat username / env flag / open).
- Whether the first battle experience leans on NPC/solo play or stays async-Bluesky-only
  — shapes Phases 2 and 4.

---

## Add-on feature: AIM-style "who's active" buddy list (Bluesky presence) — ✅ SHIPPED

**Status:** Built and live as the **Buddies** tab. Resolves mutuals via the public
AppView, opens one filtered Jetstream socket (regional host + `requireHello` +
`options_update` hello with `wantedDids` + replay cursor), classifies online/idle/offline
from the firehose, chimes on come-online, and offers a Challenge hand-off. The brief below
is kept for reference. _Next: wire it into the challenge loop (Phase 4) and on-device QA._

The good news is the linked repo is the answer. **cee.wtf/aim** is a (at time of
writing) 17-hour-old AIM-style buddy list that solves exactly this, and it's worth
copying its architecture wholesale.

The trick: **presence is inferred behaviorally by watching the Jetstream firehose
filtered to only your mutuals' events, rather than queried.** The taxonomy is:

- 🟢 **online** — posted / replied / reposted within a window.
- 🟡 **idle** — only liked or followed (lurking).
- ⚪ **offline** — quiet.

### Implementation brief

1. **Resolve + build the mutuals set.** Hit `public.api.bsky.app` (the AppView,
   CORS-enabled, no auth) to turn the handle into a DID, then pull follows and followers
   and intersect them to get mutuals. Handle→DID, profiles, and follows/followers all
   come from the public AppView XRPC.
2. **Open one filtered Jetstream socket** to `jetstream*.bsky.network` subscribed only
   to those DIDs. Optionally also filter `wantedCollections` to `app.bsky.feed.post`,
   `.like`, `.repost`, `app.bsky.graph.follow` to cut noise.
3. **Classify each buddy** from the events streaming in, using the online/idle/offline
   window logic above. A post/reply/repost flips them green (and is your cue to play the
   chime); a like/follow only → yellow.
4. **Backfill "last seen"** for dormant buddies via `com.atproto.sync.getLatestCommit`,
   decoding the `rev` TID into a timestamp — it marks their last write of any kind.
5. **Side panel = the mutuals list rows**, each hydrated via
   `app.bsky.actor.getProfiles` (batches of 25 max), sorted by presence state,
   re-rendered in place as firehose events update status.

You can **skip the CAR/repo-decoding machinery** (`com.atproto.sync.getRepo`,
`deep-history.js`) for a side panel — that exists only to reconstruct the per-buddy IM
conversation history including likes, which no public API otherwise exposes. Not needed
just to show who's active.

### The one gotcha (the repo flags it explicitly)

How to pass the DID filter. **`wantedDids` goes in a hello message, not the URL** —
hundreds of DIDs as query params exceed the WS handshake URL-length limit and the server
refuses the connection.

```js
// WRONG: wantedDids in the URL → blows past the WS handshake URL-length limit, connection refused
// RIGHT: connect with requireHello, then send the filter as a message on open
const ws = new WebSocket('wss://jetstream2.bsky.network/subscribe?requireHello=true');
ws.onopen = () => ws.send(JSON.stringify({
  type: 'options_update',
  payload: { wantedDids: mutualDids }   // hundreds of DIDs is fine here
}));
```

Reference is `jetstream.js` in the repo.

### Notes

- That repo was co-authored by Claude Opus 4.8, so it's already fairly agent-legible —
  pointing an agent at `main.js` (orchestrator) and `jetstream.js` (the firehose client)
  gives it most of what it needs.
- Source: https://tangled.org/cee.wtf/aim

### How this fits iNat Battler

This pairs naturally with the async-challenge loop (Phase 4): a live buddy list of
active mutuals turns "send a challenge into the void" into "challenge someone who's
online right now," which is the difference between a dead async feature and a real-time
hook. It also reuses the Bluesky identity the app already has, and the presence socket
is client-side and auth-free, so it adds little server cost.
