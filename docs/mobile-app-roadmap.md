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
- **iNaturalist linking**: verification-code-in-profile flow, with iNat rate-limit
  handling.
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

## Itinerary

### Phase 1 — Mobile foundation (the "first and foremost")

1. **Responsive overhaul.** Audit every view at 360/390/430px widths. Two breakpoints
   isn't enough for 8 views; move to a consistent mobile-first system. Battle arena,
   roster grid, training allocation, and dev panels are the likely breakers.
2. **Bottom tab nav for mobile.** Replace the 8 top tabs on small screens with a 4–5
   item bottom bar (Home, Roster, Battle, Train, More). Dev + tree + recent +
   leaderboard go under "More." Thumb-reachable, native-feeling.
3. **Touch targets & interactions.** 44px minimum hit areas; verify team-picking / card
   selection works by tap (no hover-dependent affordances — there's currently no touch
   handling at all).
4. **PWA installability.** Web app manifest + icon set + `theme-color` +
   apple-mobile-web-app tags + a minimal service worker (offline shell + cached static
   assets). This is what makes it feel like "an app" people add to their home screen,
   and it's the prerequisite for push notifications later.
5. **Payload weight.** The HTML/CSS/JS is inlined in one large document. Measure what a
   phone on cellular actually downloads; split/cache static CSS+JS and the hero image so
   repeat loads are cheap.
6. **Real-device QA.** Test the Bluesky OAuth redirect round-trip in iOS Safari and
   Android Chrome specifically — third-party-redirect auth is where mobile browsers
   misbehave.

### Phase 2 — Onboarding & first-run (mobile-native)

7. Guided setup flow from the readiness plan (confirm Bluesky → enter iNat username →
   show/paste verification code → verify → import → first roster summary), designed as a
   stepped mobile flow, not a desktop form.
8. Default logged-in landing on **Home**, not the raw roster grid.
9. Graceful "your species has no sprite yet" state — many imported species will be among
   the ~1378 missing; show a placeholder + on-demand queue rather than a blank.

### Phase 3 — Roster at scale (mobile-critical)

10. Virtualized/paginated roster (hundreds of taxa must not be one long scroll on a
    phone).
11. Sticky search + quick filters (Ready / Queued / Missing / Favorites / Battle Team)
    and a compact list mode alongside the sprite grid.

### Phase 4 — The battle loop people return for

12. Solid NPC/solo battles so the app is fun with zero opponents online (async-only
    would feel dead at alpha scale).
13. Battle tab empty state + team-readiness checklist; challenge send/accept/decline
    flows polished for mobile.
14. **Notifications** for "challenge received/accepted" — once the PWA exists, web push;
    interim, lean on Bluesky notifications or email. This is the main retention lever.

### Phase 5 — Production hardening (before inviting anyone)

15. **Rate-limit and gate your own API**, especially sprite generation — per-user and
    global cost ceilings, abuse protection. You have the env knobs (`MAX_*`); wire
    enforcement + clear 429 UX.
16. Comprehensive **error states** for auth failure, iNat import failure/rate-limit,
    sprite generation failure, challenge creation failure.
17. **Alpha access control** — decide allowlist (Bluesky DID / iNat username / env flag)
    vs. open, and gate Dev Lab behind admin.
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

## Add-on feature: AIM-style "who's active" buddy list (Bluesky presence)

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
