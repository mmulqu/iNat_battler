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

## Configuration

### Secrets

Secrets hold credentials and must **never** be committed. Set each one with
`wrangler secret put <NAME>` (and re-run per environment). Only the name and
purpose live in the repo — the values stay in Cloudflare.

| Secret | Required for | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | Sprite + move generation | OpenAI Images/text API key. Without it the app still runs (placeholders/default photos) but can't generate. |
| `DISCORD_BOT_TOKEN` | Custom-sprite QA | Lets the Worker post upload submissions to the Discord QA channel and read approval reactions. |
| `BSKY_BOT_APP_PASSWORD` | Highlight bot + brand share | App password (not the account password) for the brand Bluesky account that posts battle highlights. Pair with the `BSKY_BOT_IDENTIFIER` var. |

```sh
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put DISCORD_BOT_TOKEN
npx wrangler secret put BSKY_BOT_APP_PASSWORD
npx wrangler secret list   # verify what's set per environment
```

### Admin access

These grant access to the admin/dev endpoints (sprite/move batch tooling, the
global-seed panel, highlight render-test, force-run curator). They are
**identifiers, not secrets** — anyone listed here is an admin — so they live as
plain `vars` in `wrangler.jsonc`. A session is treated as admin if it matches
**any** of them. Set at least one to your own account before relying on the
admin tools; leave them empty on an untrusted deploy to lock the admin surface.

| Var | Matches on |
| --- | --- |
| `ADMIN_DIDS` | Comma-separated Bluesky DIDs (`did:plc:...`). |
| `ADMIN_BSKY_HANDLES` | Comma-separated Bluesky handles (`you.bsky.social`). |
| `ADMIN_INAT_LOGINS` | Comma-separated linked iNaturalist logins. |

### Highlight bot vars

| Var | Purpose |
| --- | --- |
| `BSKY_BOT_IDENTIFIER` | Handle of the brand Bluesky account (e.g. `wildmarch.bsky.social`); used with `BSKY_BOT_APP_PASSWORD`. |
| `HIGHLIGHT_BOT_ENABLED` | `"false"` (default) makes the cron curator a no-op. Set `"true"` to let it autonomously render and post opted-in battle highlights. |

See `docs/battle-highlights-bluesky.md` for the full highlight pipeline.

## Cost Controls

The defaults in `wrangler.jsonc` are intentionally conservative:

- `MAX_INITIAL_SPRITE_JOBS=12`
- `MAX_USER_DAILY_QUEUED_JOBS=24`
- `MAX_GLOBAL_DAILY_GENERATIONS=250`
- `MAX_OPENAI_ATTEMPTS=3`

`DISABLE_GENERATION_LIMITS` defaults to `"false"` so a public deploy can't run the OpenAI bill up — the per-user and global daily caps are enforced. For a large admin seed run you can temporarily set it to `"true"` (it still records generated-count and estimated-cost metadata) or raise the caps above; flip it back to `"false"` before live play.

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

Signed-in players with a linked iNaturalist account can upload their own sprite sheet for a species in their roster (select one ready creature card) or enter an iNaturalist taxon ID for a missing/new roster species, then choose a PNG/JPEG/WebP file in the "Custom sprites" block of the Bluesky panel.

Moderation works through emoji reactions in a private Discord channel:

1. On upload the Worker stores the image in R2 (`users/<login>/sprites/...`), creates a `user_sprite_submissions` row (`pending`), and posts the image to the QA channel via the Discord bot.
2. React ✅ (or ☑️ ✔️ 🟢) to **approve**, ❌ (or ✖️ 🚫 ⛔ 🔴) to **reject**. A reject reaction wins if both are present.
3. A cron trigger polls pending submissions every 2 minutes (Workers can't hold a Discord Gateway socket, so reactions are read via REST). `POST /api/sprite-submissions/sync` forces a check; `POST /api/sprite-submissions/:id/sync` re-evaluates one submission even after a decision, so changing the reaction overturns it.

Visibility rules:

- The **submitter sees their own custom sprite while it is pending or approved** in their roster and on their side of battles.
- The app's custom-sprite submission list is private to the signed-in submitter; other players cannot list another user's submissions, even after approval.
- **Opponents only see it once approved**; otherwise they see the shared global sprite (or the placeholder if none exists).
- **Rejected sprites are hidden from everyone, including the submitter** — the roster shows the rejected QA badge but falls back to the shared global sprite.
- A pending or approved custom sprite also makes that species battle-eligible for its owner even when no global sprite exists yet.
- If QA approves a custom sprite for a taxon with no ready global sprite, the app also registers that image as the shared global sprite. If a global sprite already exists, the approved upload remains only that user's custom sprite.

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

Username imports use the iNaturalist v2 `observations/species_counts` endpoint with a narrow `fields` list, one page by default, and a six-hour `ttl`/KV cache to avoid bursty API usage. Manual taxon lookup also uses v2 with trimmed taxon fields and a 24-hour `ttl`. The profile-verification call stays uncached so newly added bio codes can be detected. If iNaturalist returns `429 Too Many Requests`, the Worker retries once, then uses cached/D1 roster data when available; otherwise the UI asks the user to wait and retry.

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

## Species Training

Linked players personalize their species in the **Training** tab instead of relying purely on observation-count stats. Points are earned deterministically from iNaturalist observation counts. Research Grade counts are preferred; if iNaturalist rate-limits the RG aggregate, the app can temporarily use existing roster observation counts as a provisional fallback. Earned is recomputed on every sync; spent is stored; available = max(0, earned - spent), so deleted observations never claw back spent points:

- Species base: `floor(2 * sqrt(training obs))`, plus a +5 first-observation bonus.
- Genus spillover: +2 per other distinct observed species in the same genus.
- Family spillover: +1 per 2 other distinct observed species in the same family.
- Mastery bonuses per species in the group when a tier is reached.

Mastery is hybrid: tiers from distinct observed species (genus bronze/silver/gold at 3/7/15, family at 5/12/25) plus true **completion** when iNat publishes an authoritative `complete_species_count` for the group (min 3 species, so monotypic genera don't count). Gold/complete tiers grant permanent stat buffs (genus +10%/+15%, family +5%/+8%, additive) applied at creature build time. Tiers never downgrade once achieved.

Allocation: 1 point = +1 to vigor/strike/guard/tempo/sense, capped at +60% of the bond-scaled base per stat. Vigor allocations raise max HP through the existing formula. One free full respec per species per week. Nicknames (24 chars) and a level badge (level = points spent) show on roster cards and battle plates; opponents see your trained stats and nickname in every battle, including async ghost battles.

`POST /api/training/sync` pulls RG counts from iNaturalist v2 (`observations/species_counts?quality_grade=research`, fresh-cached 6h with stale 429 fallback), resolves genus/family ids from ancestry chains via batched v2 `/taxa` lookups (capped per sync; re-run to continue), and upserts masteries.

```text
GET  /api/training
POST /api/training/sync
POST /api/training/allocate  {taxonId, allocations: {strike: 2, ...}}
POST /api/training/respec    {taxonId}
POST /api/training/nickname  {taxonId, nickname}
```

## Species Signature Moves (LLM dossiers)

Move generation is a two-stage pipeline: a text model researches the organism, then the image model illustrates the result. The image model never invents game data.

1. **Dossier (text)**: `MOVE_MODEL` (default `gpt-5.4-nano`) receives the taxon plus its Wikipedia summary (fetched from the iNat taxa API as grounding) and returns JSON: 3-5 real natural-history facts, idle/movement animation lines, and **two signature moves as pure data** (name, type from the 16-type chart, category, power, accuracy, one effect, flavor line, and a 4-frame animation storyboard).
2. **Validation**: the Worker clamps everything server-side — power 20-60 (26/hit for multihit), accuracy 75-100, status-rider chance <=30% (pure status moves always land), and a power budget (`power x accuracy + effect cost <= 62`) so the LLM cannot emit an overpowered move. Names/flavor are length-capped and sanitized.
3. **Genome v2**: stored in `creature_genomes` (genome_version 2) as 2 signature moves (animation rows 3-4) + 2 common library moves. Battles, rosters, NPC teams, and ghost teams all prefer genome v2 moves and fall back to the procedural set.
4. **Sprite prompt v2**: the stored prompt assigns each sheet row explicitly — row 1 idle and row 2 movement from the dossier, rows 3-4 the signature move storyboards — so new sprite generations animate the actual moves. Existing sheets keep working (signature moves map to the generic attack/special rows until regenerated).

Endpoints (`OPENAI_API_KEY` required for generation; batch uses the 50%-discount Batch API):

```sh
curl -X POST .../api/taxa/13858/moves/dev-generate         # one species, synchronous
curl .../api/taxa/13858/genome                             # inspect genome + image prompt
curl -X POST .../api/move-batches/dev-submit -d '{"limit":25}'
curl .../api/move-batches/<batch_id>
curl -X POST .../api/move-batches/<batch_id>/sync          # validate + write genomes
```

### Status effects

The battle engine now consumes statuses (previously decorative): **stunned** skips the creature's next action, **marked** takes +25% damage on the next hit, **poisoned** loses 8% max HP per turn for 3 turns, **shielded** halves the next hit (self-applied). Move effects also include **drain** (heal % of damage dealt), **recoil**, and **multihit** (2-3 strikes). Active statuses show as chips on the battle plates, and the turn replay animates poison ticks, drains, recoil, stuns, and shield blocks with floats and sounds.

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
