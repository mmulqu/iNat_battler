# iNat Battler

Cloudflare Worker app for importing public iNaturalist species counts, showing a creature roster immediately, and generating shared global sprite assets through a capped queue.

## Pipeline

1. Public iNaturalist username import calls `observations/species_counts`.
2. D1 stores users, taxa, user roster rows, prompt specs, sprite jobs, sprite metadata, teams, battles, and generation budgets.
3. The roster API returns placeholders or iNaturalist default photos without waiting for sprites.
4. Missing top species enqueue global sprite jobs.
5. The queue consumer dedupes again, checks the daily generation budget, calls OpenAI Images, saves WebP output to R2, and writes `sprite_assets`.

## R2 Naming

Generated global sprite keys include both the stable iNaturalist taxon id and a readable scientific-name slug:

```text
species/v1/<taxon_id>-<scientific-name-slug>/<prompt_hash>/sprite_sheet.webp
```

Example:

```text
species/v1/13858-passer-domesticus/4d2a1c89e4b7a311/sprite_sheet.webp
```

The taxon id stays first because scientific names can change, while D1 stores the final `sprite_assets.r2_key` used by the app.

## D1 vs R2

Generated sprite image bytes belong in R2.

D1 should store only the metadata needed to find and audit those assets:

- `sprite_assets.r2_key`
- `taxon_id`
- `asset_kind`
- `asset_version`
- `prompt_hash`
- `model`
- `status`
- `usage_json`
- `cost_estimate_usd`

That split keeps D1 fast and cheap for queries while R2 handles binary object storage.

## Setup

Install dependencies:

```sh
npm install
```

Create Cloudflare resources:

```sh
npx wrangler d1 create inat_battler
npx wrangler r2 bucket create inat-battler-assets
npx wrangler kv namespace create CACHE
npx wrangler queues create sprite-generation
```

Put the returned IDs into `wrangler.jsonc`, then apply the migration:

```sh
npm run db:migrate:local
npm run db:migrate:remote
```

Set the OpenAI secret:

```sh
npx wrangler secret put OPENAI_API_KEY
```

Run locally:

```sh
npm run dev
```

Deploy:

```sh
npm run deploy
```

## Cost Controls

The defaults in `wrangler.jsonc` are intentionally conservative:

- `MAX_INITIAL_SPRITE_JOBS=12`
- `MAX_USER_DAILY_QUEUED_JOBS=24`
- `MAX_GLOBAL_DAILY_GENERATIONS=250`
- `MAX_OPENAI_ATTEMPTS=3`

During development, `DISABLE_GENERATION_LIMITS=true` bypasses the per-user and global daily caps while still recording generated-count and estimated-cost metadata. Turn it off before live play.

Sprite assets are global by `taxon_id + asset_kind + asset_version + prompt_hash`, so once a species sprite exists every user reuses it.

## OpenAI Sprite Generation

Sprite prompts are created deterministically from taxon metadata in `src/game.js`, stored in D1 `creature_genomes.prompt_json`, and hashed for sprite job dedupe.

The production generator uses `gpt-image-2` by default. When references are enabled, the Worker calls the Images edit endpoint with:

- the iNaturalist default photo, when available, as the species identity reference
- `species/v1/13858/manual/sprite_sheet.png` from R2 as the House Sparrow style/layout reference

`gpt-image-2` currently does not support transparent backgrounds, so generated sheets request an opaque plain/auto background and the UI treats each sheet as a 4x4 grid.

For development/backfill, `SPRITE_GENERATION_MODE=batch` leaves Cloudflare Queue messages acknowledged but keeps D1 `sprite_jobs` queued for OpenAI Batch submission. This uses `/v1/images/edits` with `gpt-image-2`, the iNaturalist default photo URL when available, and the House Sparrow style sheet served from R2.

The dev Global Seed panel imports the top 1,000 plants and top 1,000 animals across North America (`place_id=97394`) and Europe (`place_id=67952`), stores them in `global_seed_taxa`, skips sprites that are already ready or active, and submits missing sprites in 200-item OpenAI batches.

Global seed endpoints:

```sh
curl -X POST https://inat-battler.intrinsic3141.workers.dev/api/global-seed/dev-import \
  -H "content-type: application/json" \
  -d '{"limitPerGroup":1000}'

curl -X POST https://inat-battler.intrinsic3141.workers.dev/api/global-seed/dev-queue \
  -H "content-type: application/json" \
  -d '{"limit":200}'

curl -X POST https://inat-battler.intrinsic3141.workers.dev/api/global-seed/dev-submit \
  -H "content-type: application/json" \
  -d '{"limit":200}'
```

Submit a small batch:

```sh
curl -X POST https://inat-battler.intrinsic3141.workers.dev/api/sprite-batches/dev-submit \
  -H "content-type: application/json" \
  -d '{"userId":"inat:mycolocore","limit":2}'
```

Check and sync it:

```sh
curl https://inat-battler.intrinsic3141.workers.dev/api/sprite-batches/<batch_id>
curl -X POST https://inat-battler.intrinsic3141.workers.dev/api/sprite-batches/<batch_id>/sync
```

## Bluesky Login & Challenges

Players sign in with their Bluesky account via atproto OAuth, implemented directly in the Worker with WebCrypto (no atproto SDK dependency): handle -> DID -> PDS resolution, authorization server discovery, PAR + PKCE, and DPoP-bound tokens (ES256) with automatic nonce retries and refresh.

The app requests only the granular auth scope it needs:

```text
atproto repo:app.bsky.feed.post?action=create
```

so the OAuth consent screen grants nothing beyond creating posts. If a player's PDS predates granular auth scopes, set `OAUTH_SCOPE="atproto transition:generic"` in `wrangler.jsonc` (broad, app-password-equivalent access — avoid unless needed).

Client metadata is served from `/oauth/client-metadata.json` and derived from the request origin. On `localhost`/`127.0.0.1` the Worker automatically switches to the atproto loopback client (`client_id=http://localhost?...`), so `npm run dev` works against real Bluesky accounts with no extra setup.

Sessions are HttpOnly cookies; only a SHA-256 hash of the session token is stored in D1, along with the DPoP key pair and access/refresh tokens.

### Challenge flow

1. A signed-in, iNat-linked player selects 5 ready sprites, enters an opponent's Bluesky handle, and sends a challenge.
2. The Worker stores the challenge in D1 and writes an `app.bsky.feed.post` record in the challenger's repo with a mention facet (the opponent gets a real Bluesky notification) and a link facet pointing at `/?challenge=<id>`.
3. The opponent follows the link, signs in with Bluesky, links their iNaturalist account if they haven't, selects 5 ready sprites, and accepts.
4. The battle starts immediately as an async PvP match: the accepter plays live while the challenger's snapshotted team is piloted by the battle AI. Results land in `battle_results` and the challenge is marked `completed`.

If the Bluesky post fails (e.g. scope rejected), the challenge is still created and the API returns `postError` so the link can be shared manually.

### Linking iNaturalist without iNaturalist OAuth

iNaturalist OAuth is globally scoped, which is far more permission than this app needs — it only ever reads public data. Instead, ownership is proven with a verification code:

1. `POST /api/inat/link/start` returns a one-time code like `inat-battler-x7k2m9pq`.
2. The player pastes it anywhere in their iNaturalist profile bio and saves.
3. `POST /api/inat/link/confirm` reads the bio through the public API (`/v2/users/<login>?fields=description`), and on match links the account, imports the roster, and the code can be removed.

No iNat tokens are ever issued or stored.

### Custom sprites with Discord QA

Signed-in players with a linked iNaturalist account can upload their own sprite sheet for any species in their roster (select one creature card, choose a PNG/JPEG/WebP file in the "Custom sprites" block of the Bluesky panel).

Moderation works through emoji reactions in a private Discord channel:

1. On upload the Worker stores the image in R2 (`users/<login>/sprites/...`), creates a `user_sprite_submissions` row (`pending`), and posts the image to the QA channel via the Discord bot.
2. React ✅ (or ☑️ ✔️ 🟢) to **approve**, ❌ (or ✖️ 🚫 ⛔ 🔴) to **reject**. A reject reaction wins if both are present.
3. A cron trigger polls pending submissions every 2 minutes (Workers can't hold a Discord Gateway socket, so reactions are read via REST). `POST /api/sprite-submissions/sync` forces a check; `POST /api/sprite-submissions/:id/sync` re-evaluates one submission even after a decision, so changing the reaction overturns it.

Visibility rules:

- The **submitter sees their own custom sprite while it is pending or approved** in their roster and on their side of battles.
- **Opponents only see it once approved**; otherwise they see the shared global sprite (or the placeholder if none exists).
- **Rejected sprites are hidden from everyone, including the submitter** — the roster shows the rejected QA badge but falls back to the shared global sprite.
- A pending or approved custom sprite also makes that species battle-eligible for its owner even when no global sprite exists yet.

Setup: create a Discord application with a bot, invite it to the server with View Channel, Send Messages, Attach Files, and Read Message History permissions on the QA channel, set `DISCORD_QA_CHANNEL_ID` in `wrangler.jsonc` (already pointed at the QA channel), and run:

```sh
npx wrangler secret put DISCORD_BOT_TOKEN
```

If the Discord post fails (missing token, outage), the submission stays pending with the error recorded and the cron retries the post automatically.

```text
POST /api/my-sprites/upload          multipart: sprite, taxonId
GET  /api/my-sprites
POST /api/sprite-submissions/sync
POST /api/sprite-submissions/:id/sync
```

### Auth & challenge endpoints

```text
GET  /oauth/client-metadata.json
GET  /oauth/callback
POST /api/auth/login            {handle, returnTo?}
POST /api/auth/logout
GET  /api/me
GET  /api/bsky/typeahead?q=<partial-handle>
POST /api/inat/link/start       {inatLogin}
POST /api/inat/link/confirm
POST /api/challenges            {opponentHandle, taxonIds[5], message?}
GET  /api/challenges
GET  /api/challenges/:id
POST /api/challenges/:id/accept {taxonIds[5]}
POST /api/challenges/:id/decline
```

## iNaturalist Rate Limits

Username imports use one `species_counts` page by default to avoid bursty API usage. Successful responses are cached in KV for six hours. If iNaturalist returns `429 Too Many Requests`, the Worker retries once, then uses cached/D1 roster data when available; otherwise the UI asks the user to wait and retry.

## Development Sprites

The app includes a no-cost SVG sprite generator adapted from the scaffold in `Downloads/taxa-battler-scaffold`. It lets you test the D1-to-R2 asset flow before setting `OPENAI_API_KEY`.

After importing a roster and queueing sprite jobs:

```sh
curl -X POST http://127.0.0.1:8787/api/sprite-jobs/dev-generate-next
```

This writes an SVG sprite sheet to R2 at a key like:

```text
species/v1/<taxon_id>-<scientific-name-slug>/<prompt_hash>/sprite_sheet.svg
```

and marks the matching `sprite_assets` row as ready in D1.

## Manual Sprite Sheets

The named PNG sprite sheets in `images/` are uploaded to R2 and seeded in D1 by `migrations/0003_demo_sprite_assets.sql`.

Current manual assets:

```text
House_sparrow.png        -> species/v1/13858/manual/sprite_sheet.png
American_robin.png       -> species/v1/12727/manual/sprite_sheet.png
Blue_jay.png             -> species/v1/8229/manual/sprite_sheet.png
Bohemian_waxwing.png     -> species/v1/7429/manual/sprite_sheet.png
Cedar_waxwing.png        -> species/v1/7428/manual/sprite_sheet.png
Scarlet_tanager.png      -> species/v1/9921/manual/sprite_sheet.png
Summer_tanager.png       -> species/v1/9915/manual/sprite_sheet.png
Yellow-billed_cuckoo.png -> species/v1/1965/manual/sprite_sheet.png
```

Each sheet is treated as a 4x4 grid. The web UI cuts frames with CSS `background-position`:

```text
row 1 idle
row 2 movement
row 3 attack
row 4 special
```

Run the deployed 5v5 test battle from the page button or API:

```sh
curl -X POST https://inat-battler.intrinsic3141.workers.dev/api/battles/demo/start
```

The player side uses five uploaded bird sheets. The opponent side uses five gray-box dummy placeholders.

## Battle Arena

Battles run in their own **Battle** tab with two explicit phases: team picking happens in the Roster tab (select exactly 5 ready sprites), then the arena opens on Battle NPC / challenge accept with a "Battle Start!" intro.

The arena experience is fully client-side, no assets required:

- **Procedural pixel backdrops**: a deterministic 64x36 SVG scene (sky bands, sun, clouds, hill skyline, dithered ground, tufts) generated from the battle id, with the biome palette (meadow / wetland / forest / urban / night) picked from the combatants' ecological types. Sprites render in the foreground on shadow platforms.
- **Turn replay**: after a move resolves server-side, the new battle log entries are replayed as timed effects — attack animations, red hit-flashes on the struck sprite, screen shake, floating damage/heal numbers, HP bars draining per hit, a red vignette when *your* creature takes the hit, and faint drop animations.
- **Synthesized retro sound**: WebAudio square/saw/noise effects for hits (scaled by damage), specials, misses, buffs/debuffs, faints, battle start, and win/lose jingles. Toggle persists in `localStorage`.

The opponent does **not** need to be online: PvP challenge battles are asynchronous "ghost battles" where the challenger's snapshotted team is piloted by the battle AI. Real-time PvP would need a Durable Object per battle relaying both players' moves over WebSockets — not implemented yet.

## Gameplay API

The scaffold's lightweight battler rules have been ported into `src/game.js`. Roster rows now include derived body plan, ecological types, role, stats, and moves.

Useful endpoints:

```text
GET  /api/health
POST /api/import
GET  /api/roster?userId=<id>&q=<search>
GET  /api/users/:userId/roster?q=<search>
POST /api/sprite-jobs/dev-generate-next
GET  /api/sprite-jobs?status=queued
GET  /api/users/:userId/teams
POST /api/users/:userId/teams
POST /api/battles/npc/start
GET  /api/battles/:battleId
POST /api/battles/:battleId/action
```
