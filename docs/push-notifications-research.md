# Push Notifications Research

**Question:** Can iNat Battler push notifications to players — e.g. "you can
claim/attack a new tile," "a species you've observed got a new sprite," "a
challenge arrived" — using the current Progressive Web App? Can we read each
user's new iNaturalist observations every few hours to drive those triggers?

**Short answer:** Yes for push notifications — the PWA foundation is already in
place and Cloudflare Workers can send Web Push. The *sprite-ready* and
*tile-claimable* triggers are very achievable. The "read new iNat observations
every few hours" piece is the hard part, because **iNaturalist has no webhooks**
— it must be done by **polling**, and the app's current design deliberately
avoids centralized polling to stay under iNat's rate limits.

This is research only. No code was written.

---

## 1. What we already have

The PWA shell that Web Push requires already exists:

| Piece | Where | Status |
| --- | --- | --- |
| Web App Manifest | `manifestResponse()` → `/manifest.webmanifest` (`src/index.js`) | ✅ `display: "standalone"`, icons, theme color |
| Service worker | `serviceWorkerResponse()` → `/sw.js` (`src/index.js`) | ✅ registered in `renderAppHtml()` on `load` |
| Apple PWA meta tags | `renderAppHtml()` head | ✅ `apple-mobile-web-app-capable` etc. |
| Cron scheduler | `scheduled()` (`src/index.js`), `triggers.crons: ["*/2 * * * *"]` | ✅ runs every 2 min |
| D1 database | `DB` binding | ✅ available for subscription storage |
| ES256 WebCrypto signing | atproto DPoP (`src/atproto.js`) | ✅ same primitive Web Push VAPID needs |

**The gap:** the current service worker only handles `install` / `activate` /
`fetch` (offline caching). It has **no `push` or `notificationclick` handler**,
and the client **never calls `pushManager.subscribe`**. There are no VAPID keys
and no table for push subscriptions. So nothing about push exists yet — but the
surrounding shell (installable PWA + cron + D1 + ES256 crypto) is all present,
which is most of the battle.

---

## 2. How Web Push works (and what it would take here)

Web Push is a W3C/IETF standard, independent of any vendor:

1. **Client** asks for notification permission (must be a user gesture), then
   calls `registration.pushManager.subscribe({ userVisibleOnly: true,
   applicationServerKey: <VAPID public key> })`. This returns a `PushSubscription`
   = an endpoint URL (on the browser vendor's push service: FCM for Chrome,
   Mozilla autopush for Firefox, Apple for Safari) plus two keys (`p256dh`,
   `auth`).
2. **Client** POSTs that subscription to our Worker; we store it in D1, keyed to
   the player's DID / `inat:<login>`.
3. **Server** (the Worker, from cron or an event) signs a **VAPID JWT (ES256)**,
   encrypts the payload (`aes128gcm`), and `fetch()`es the subscription's
   endpoint. The browser vendor delivers it to the device.
4. **Service worker** receives a `push` event → `showNotification(...)`; a
   `notificationclick` event focuses/opens the app at the right deep link
   (e.g. `/?challenge=<id>` or the territory tab).

### Cloudflare Workers specifics
- There is **no native Web Push binding**. We send it ourselves: build the VAPID
  JWT with WebCrypto (we already do ES256 for DPoP), encrypt with HKDF/AES-GCM,
  and `fetch` the endpoint. A small Workers-compatible library
  (e.g. `@block65/webcrypto-web-push`) can do the encryption instead of
  hand-rolling RFC 8291.
- **VAPID keys** are a new secret pair: public key ships to the client, private
  key is a `wrangler secret`. One pair for the whole app.
- Sending fits the existing cron and queue-consumer code paths.

### Cost
- Web Push itself is free (vendor push services are free).
- The marginal Cloudflare cost is cron CPU + a `fetch` per recipient — trivial at
  alpha scale, and well within the free/$5 tier already in use.

---

## 3. Platform support & caveats (flag before building)

- ✅ **Android Chrome/Firefox, desktop Chrome/Edge/Firefox**: full support, even
  when the tab/app is closed.
- ⚠️ **iOS / iPadOS**: Web Push works **only for an *installed* PWA** (Add to
  Home Screen) on **iOS 16.4+**, and permission must be requested from a user
  gesture. Our manifest already declares `display: standalone` + apple meta
  tags, so we satisfy the install requirement — but iOS users must install the
  app first, and we should detect/guide that. There's **no web push for iOS
  Safari in a regular browser tab**.
- ⚠️ **Permission UX**: browsers penalize sites that prompt on load. Prompt only
  after a relevant user action (e.g. a "Notify me" toggle in Settings — already
  stubbed at `docs/settings-plan.md` "Notifications (placeholder until web push
  lands)").
- ⚠️ **No delivery guarantee / ~4KB payload limit**: treat pushes as best-effort
  hints; the source of truth stays in D1. Keep payloads to an id + short text and
  let the app fetch details on open.
- ⚠️ **Subscriptions expire / rotate**: handle `410 Gone` / `404` from the push
  endpoint by deleting the dead subscription.

---

## 4. The three triggers, ranked by feasibility

### A. "A species you've observed got a new sprite" — EASIEST, build first
This is **purely internal app state** — no external dependency.

Sprites/genomes becoming `ready` already happens *inside our Worker*:
- queue consumer `processSpriteJob`
- cron: `syncPendingSpriteBatches`, `syncAutoMoveBatchImageSubmissions`,
  `syncSpriteSubmissions` (custom-sprite QA approvals)

When a sprite for a `taxon_id` flips to ready, we already can find which users
have that taxon in their roster (the roster tables), look up their push
subscriptions, and send. **Fully reliable, no iNat call, no polling.** This is
the cleanest first notification to ship and proves the whole pipeline.

### B. "You can claim/attack a new tile" — MEDIUM, depends on (C)
Claimable/contestable tiles are **derived** from research-grade geo
observations. The logic already exists: `countTerritoryCandidates` and the
`candidates` ranking (`src/index.js`, territory section), plus
`revertExpiredTiles` in the cron for the "your undefended tile is about to
revert — garrison it" angle.

Two sub-cases:
- **"Your tile is about to revert / was contested"** — internal state, like (A).
  Achievable now: the cron already calls `revertExpiredTiles`; we could notify
  *before* the grace window closes (`garrison_deadline`).
- **"You have new claimable tiles"** — requires knowing about new observations,
  i.e. trigger (C).

### C. "Read each user's new iNat observations every few hours" — HARDEST
**iNaturalist offers no webhooks / no push API.** There is nothing to subscribe
to. The only mechanism is **polling** the REST API.

This collides with a deliberate design choice already documented in the code.
`syncTerritoryObservations` (`src/index.js`) notes:

> This is the FALLBACK — the preferred path is the browser fetching its own
> observations (see `/api/territory/ingest`), so the iNat rate limit falls on
> each user's IP instead of funneling every user through the Worker's single
> shared egress.

A cron that polls **all** users every few hours re-centralizes egress onto the
Worker's single IP and risks:
- **iNat 429 rate limiting** — the app already tracks per-user cooldown keys
  (`inat:observations_geo:<login>:cooldown`) and backs off; a fleet-wide poll
  multiplies that pressure.
- **Worker subrequest / CPU limits** per cron invocation (each user = up to
  `MAX_TERRITORY_SYNC_PAGES` paginated fetches with a 1.1s sleep between pages).

It's still doable, but it needs to be *scoped*, not "poll everyone":

- Poll only **opted-in** users (notifications toggle) who have been **active
  recently**.
- **Stagger** across cron ticks — e.g. a rolling cursor so each 2-min tick polls
  a small slice, giving every opted-in user a sweep every few hours without a
  thundering herd.
- Respect the existing cooldown keys; never poll a user inside their cooldown.
- Fetch **only new** observations using the observations API date filters
  (`updated_since` / `d1` /`created_d1`) plus a stored per-user "last seen
  observation id/date," instead of re-paging the whole history.
- Consider keeping the **browser-driven ingest** as the primary path and using
  push mainly for the *internally derived* events (A, B-revert), so the
  expensive iNat polling stays opt-in and bounded.

---

## 5. Recommended build order

1. **Push infrastructure (one-time):** generate VAPID keys (`wrangler secret`),
   add a `push_subscriptions` D1 table, add `pushManager.subscribe` + a
   "Notify me" toggle in Settings, add `push` / `notificationclick` handlers to
   `/sw.js`, add a `sendWebPush()` helper (ES256 VAPID JWT + RFC 8291
   encryption), and a `410/404` → delete-subscription cleanup path.
2. **Trigger A — sprite ready** (internal event; highest reliability, lowest
   risk). Validates the whole pipeline end to end.
3. **Trigger B-revert — tile about to revert / contested** (internal event,
   piggybacks on `revertExpiredTiles` in the existing cron).
4. **Challenge received/accepted** (internal event; today this leans on Bluesky
   notifications per the challenge flow — web push would be additive and is
   listed as the main retention lever in `docs/mobile-app-roadmap.md`).
5. **Trigger C — new-observation polling** (the hard one). Build the
   *staggered, opt-in, bounded* poller last, reusing cooldown keys and
   `updated_since` filtering, then layer "new claimable tiles" (Trigger B-claim)
   on top of it.

## 6. Bottom line

- **Push notifications: feasible now.** The installable PWA, cron, D1, and ES256
  crypto are already in the codebase. What's missing is purely additive: VAPID
  keys, a subscriptions table, client subscribe + Settings toggle, two service
  worker event handlers, and a Worker-side send helper.
- **Best first notifications** are the **internally-derived** events (sprite
  ready, tile reverting, challenge received) — reliable and cheap, no external
  dependency.
- **"Every few hours, read new iNat observations" has no webhook option** — it's
  polling, and it must be deliberately scoped (opt-in, staggered, cooldown-aware,
  delta-only) to respect iNaturalist's rate limits and the app's existing
  decision to push observation fetching to each user's own IP.
- **iOS** users get push only after installing the PWA (iOS 16.4+); plan the
  install nudge and permission UX accordingly.
