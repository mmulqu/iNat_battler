# Battle Highlights → Bluesky — Infrastructure Plan

**Status:** Design. Decisions locked 2026-06-18; nothing built yet.
**Goal:** Render finished battles to short MP4 videos and post the best ones to a
dedicated **brand Bluesky account** — first as a user-triggered "Share as video"
button, later as an autonomous highlight bot.

## Decisions (locked)

- **Rollout:** *Both, button first.* Ship the user "Share as video" button on the
  same renderer + post pipeline, then layer the autonomous curator on top.
- **One renderer, canvas + WebCodecs.** A single deterministic replay page renders
  the battle onto a `<canvas>` and encodes **H.264 MP4 in-browser via the WebCodecs
  `VideoEncoder` + an MP4 muxer** (`mp4-muxer`). No ffmpeg, no Containers. The exact
  same page runs in the user's browser (button) and in headless Chrome (bot),
  producing identical MP4s.
- **Two posting targets:**
  - **Button** → posts to the **user's own** Bluesky account via the existing
    per-user OAuth path (`createSessionPost`, `src/atproto.js`).
  - **Bot** → posts to the **brand account `wildmarch.bsky.social`** via app password.
  - **Consent:** a user may opt *out* of posting their own highlight, but may opt
    *in* to letting the **bot post on their behalf** (to their account and/or the
    brand feed). Drives a settings flag — see `docs/settings-plan.md`.
- **@mention battle participants.** Posts mention the Bluesky handles of the players
  in the battle (resolve handle→DID, add `app.bsky.richtext.facet#mention` facets —
  the helper already exists in `buildChallengePostRecord`).
- **Brand account auth = app password** (`wildmarch.bsky.social`, app password stored
  as Worker secret `BSKY_BOT_APP_PASSWORD`), separate from the per-user OAuth path.
  Bot uses `com.atproto.server.createSession` (Bearer JWT, no DPoP).
- **Transient storage.** Bluesky hosts the video after upload, so we **delete our R2
  copy immediately after a successful post** (or never persist it — see Storage). We
  keep only the tiny JSON **replay artifact** long-term.

## Determinism — verified ✓

Crits *are* deterministic on replay. Every random in the engine routes through the
seeded `rng` (`src/game.js`): crit roll `:770`, accuracy `:757`, damage variance
`:766`, multi-hit `:777`, status procs `:855`, NPC choices. **No `Math.random()`**
in `game.js`/`moves.js`. `scripts/verify-replay.mjs` runs 120 battles live, records
only player actions, reconstructs from the artifact, and asserts every state matches
bit-for-bit (506 crits reproduced exactly). Re-run after any engine change.

## Why this fits the $5 budget

Two verified constraints drove the design:

- **Cloudflare Browser Rendering** (Workers Paid): **10 browser-hours/month + 10
  concurrent browsers free**, then $0.09/hr. A ~15s battle renders in well under a
  minute of browser time → ~1,000+ headless renders/month inside the free tier. The
  button path uses the *user's* browser → **$0 server render cost**. Headless is only
  for the bot, and only on curated picks.
- **Bluesky video:** MP4 only, ≤100 MB, ≤3 min; per-account ceiling **25 videos/day
  or 10 GB/day**; **verified email required before the first upload**. Our clips are
  ~10–20s / a few MB, so we're nowhere near limits. The 25/day ceiling is the real
  cap on bot cadence — fine for a highlights feed.

By choosing WebCodecs over ffmpeg we avoid Containers entirely, and by deleting the
MP4 after post we keep R2 storage near zero. The only recurring cost is bot Browser
Rendering time, which stays in the free allotment at sane cadence.

## The hard part: battles render as DOM/CSS, not canvas

The live battle view is HTML + CSS keyframes (sprite sheets via `@keyframes
spriteFrames`, HP bars as DOM nodes, `playTurnEvents` diffing prev/next state — see
`src/index.js`). You **cannot** `MediaRecorder` a DOM tree; you can only capture a
canvas stream or a screen. So the central build task is a **canvas mirror** of the
battle visuals:

- sprite-sheet animation (`drawImage` of the 4×4 frames already used in CSS),
- HP bars, lunge / hit-flash / knockback / faint, floating damage + crit numbers,
  status icons, and the turn log,
- driven frame-by-frame off the replay state sequence.

This is bounded but real work, and it risks visual drift from the live view — keep
the canvas renderer reading the *same* sprite assets and timing constants.

*Alternative considered & rejected:* CDP `Page.startScreencast` of the existing DOM
(no canvas rewrite). Rejected because screencast only works headless (breaks the
client-side button), has uneven frame timing, and still needs an encode step.

## Deterministic replay artifact

The engine is already pure + seeded: each turn does
`rng = createSeededRng('${seed}:${turn}')` → `chooseNpcAction(state, difficulty,
rng)` → `resolveTurn(state, playerAction, npcAction, rng)` (`src/index.js:4960`).
So a battle is **fully reconstructible** from *initial teams + seed + difficulty +
the player's action each turn*. NPC actions and RNG derive deterministically.

Two gaps to close (neither exists today):

1. **Initial snapshot.** `battle_instances.state_json` is mutated in place, so the
   *starting* teams are lost. Write a compact `replay` artifact once at battle
   creation: `{ seed, difficulty, player.creatures, opponent, terrain }`.
2. **Action log.** Append each `playerAction` (`{ kind, moveId | index }`) per turn.
   Cleanest: add `state.actions = []` and push in `submitBattleMove`; it rides along
   in `state_json`. (For the *button*, the client already holds the played-out states
   in memory and could capture directly — but feeding the renderer from the artifact
   keeps **one** code path for button and bot.)

Store the artifact as a JSON column on `battle_instances` (a few KB) or an R2 object
keyed by `battleId`. This is the only thing we retain long-term.

## Architecture

```
                    ┌───────────────────────────────────────────┐
  finished battle → │ replay artifact (D1/R2): seed, teams,       │
  (button or bot)   │ difficulty, actions[]  ~few KB, kept long   │
                    └───────────────┬─────────────────────────────┘
                                    │  /replay/:id  (canvas + WebCodecs → MP4 blob)
              ┌─────────────────────┴───────────────────────┐
   BUTTON ───►│ user's browser renders → uploads MP4         │ (no server render cost)
   BOT ──────►│ Browser Rendering headless Chrome renders    │ (free 10 hr/mo)
              └─────────────────────┬───────────────────────┘
                                    ▼
                    Worker: post to brand account (app password)
                    uploadVideo → poll getJobStatus → createRecord
                    (app.bsky.embed.video)
                                    │ on success
                                    ▼
                       delete transient MP4 (R2/memory)
```

## Brand account posting (app password)

New module `src/bsky-bot.js`, independent of the OAuth code:

1. `com.atproto.server.createSession` with `BSKY_BOT_HANDLE` + `BSKY_BOT_APP_PASSWORD`
   (Worker secrets) → `{ accessJwt, refreshJwt, did }`. Cache the session in KV;
   refresh with `com.atproto.server.refreshSession`. Plain Bearer JWT — **no DPoP**.
2. Upload the MP4: POST to `https://video.bsky.app/xrpc/app.bsky.video.uploadVideo`
   (`Content-Type: video/mp4`, `Authorization: Bearer <serviceAuth>`). This returns a
   **jobId**; the video service transcodes async.
3. Poll `app.bsky.video.getJobStatus` until `JOB_STATE_COMPLETED`, which yields the
   `blob` ref.
4. `com.atproto.repo.createRecord` on `app.bsky.feed.post` with an
   `app.bsky.embed.video` embed (the blob), plus caption text + alt text.

Reuse `buildShareTextPostRecord`'s facet logic for any link/caption; add a
`buildVideoPostRecord({ text, videoBlob, aspectRatio, alt })` helper. **Prereq:**
create the account, verify its email (required before first upload), mint the app
password.

## Highlight scoring (bot, phase 2)

A cron (the existing `*/2` trigger or a slower dedicated one) scans recent
`battle_results` + `battle_instances` and scores candidates, e.g.:

- **Upset** — large ELO gap where the underdog won.
- **Comeback** — winner was down to their last creature / low total HP.
- **Domination** — clean sweep, few turns, no faints.
- **Crit drama / clutch** — flagged from the turn log.

Pick the top 1–N/day (well under the 25/day Bluesky ceiling), enqueue a render+post
job, mark the battle `highlight_posted` so it isn't reposted. Gate concurrency to
stay inside the 10 browser-hour budget. **Consent:** only auto-post battles whose
participants opted in (a profile/settings flag) — see `docs/settings-plan.md`.

## Storage & cleanup

- **Replay artifact:** kept (tiny).
- **MP4:** prefer **stream-through** (browser/headless → Worker → Bluesky, held in
  Worker memory; a 15s 720p clip is a few MB, well under the 128 MB limit) so it never
  hits R2. If a retry buffer is wanted, write to an R2 prefix (`highlights/tmp/`) with
  an object-lifecycle rule + explicit delete-after-post. Either way, **no permanent
  video storage.**

## Build phases

1. **Replay foundation — ✅ DONE (2026-06-18).** Pristine team snapshot + `actions[]`
   logging in `startNpcBattle` / `submitBattleMove` (`state.replay` / `state.actions`,
   carried in `state_json`); `GET /api/battles/:id/replay` returns the artifact;
   `reconstructBattleStates(replay, actions)` in `src/game.js` rebuilds every state;
   determinism proven by `scripts/verify-replay.mjs`. Older battles (pre-change) lack
   `replay` and return `{ available: false, reason: "no_replay" }`.
2. **Canvas replay renderer — ✅ DONE (2026-06-18).** `src/replay-page.js`
   (`REPLAY_PAGE_HTML`), served at `/replay/<battleId>`. Fetches reconstructed
   states (`GET /api/battles/:id/replay?states=1`), redraws the battle on a
   720×900 canvas (terrain bg, mirrored sprite-sheet frames, HP plates, lunge /
   knockback / hit-flash / shake / hurt-vignette / floating damage + crit / faint,
   per-turn caption, intro + outro/result cards), and encodes H.264 MP4 in-browser
   via WebCodecs `VideoEncoder` + `mp4-muxer` (CDN). Exposes `window.__replayResult`
   (base64, for headless) and `window.__replayBlob` (+ Download button). **Verified
   with Playwright** against the `/replay/__selftest` synthetic battle: produced a
   valid 13.9 MB MP4 (`ftyp`/`isom` + `moov`, fastStart), 56.5s, 720×900, encoded
   in ~14s. R2 untouched.
   - *Notes / follow-ups:* `mp4-muxer` is loaded from jsdelivr CDN — vendor it
     before the bot relies on it (Browser Rendering needs network too, but a
     pinned local copy is safer). Confirm headless Chrome in Cloudflare Browser
     Rendering supports H.264 `VideoEncoder` (Phase 5). Whole-battle clips can run
     ~1s/turn-pair + intro/outro; add highlight trimming if duration grows.
3. **Brand account + post pipeline — ✅ DONE (2026-06-18).** `src/bsky-bot.js`:
   app-password `createSession` → resolve PDS from didDoc → `getServiceAuth`
   (**aud = `did:web:<PDS host>`, lxm = `com.atproto.repo.uploadBlob`** — verified
   against the live API; other combos are explicitly rejected) → POST bytes to
   `video.bsky.app/xrpc/app.bsky.video.uploadVideo` → poll `getJobStatus` for the
   blob → `createRecord` `app.bsky.feed.post` with `app.bsky.embed.video`
   (aspectRatio + alt) + `buildMentionFacets`. **Live-tested:** posted a real
   12 MB rendered battle to `wildmarch.bsky.social`
   (`bsky.app/profile/wildmarch.bsky.social/post/3molo7a5mux2b`), confirmed as a
   playable `app.bsky.embed.video#view` (720×900 HLS). `scripts/post-highlight-test.mjs`
   drives the flow from a rendered `hl.mp4` using `BSKY_BOT_*` env vars.
   - **Account `wildmarch.bsky.social` email is verified** (required before the
     first upload — the only thing that blocked us initially). `canUpload: true`,
     limits ~100 videos/40 GB per day.
   - **TODO before going live:** set the production secret
     `wrangler secret put BSKY_BOT_APP_PASSWORD` and var `BSKY_BOT_IDENTIFIER`;
     wire the HTTP trigger in Phase 4/5 (the module is callable from the Worker as-is).
4. **"Share as video" button** — on the battle-result overlay: render in-browser,
   upload MP4 to a Worker endpoint, post to the brand account, confirm + link.
5. **Autonomous curator** — scoring cron + render-via-Browser-Rendering job + opt-in
   gating + dedupe + daily cap.

## Open decisions (when we build)

- **Clip scope:** whole battle vs. a trimmed "highlight" window (last N turns / the
  swing). Whole battle is simplest; trimming needs scoring of the turn log.
- **Caption/branding:** species names, result, ELO delta, a watermark/logo frame,
  a link back to the app.
- **Who posts on the button:** always the brand account (consistent feed) vs. let a
  logged-in user post to *their own* account via the existing OAuth path. Recommend
  brand account for v1.
- **Aspect ratio / resolution:** 1:1 or 9:16 for mobile feeds; 720p to keep encode
  fast and files small.
- **Verify free-tier headroom** on the dashboard once the bot is live (Browser Run
  hours, R2 ops).
