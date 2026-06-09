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

Sprite assets are global by `taxon_id + asset_kind + asset_version + prompt_hash`, so once a species sprite exists every user reuses it.

## OpenAI Sprite Generation

Sprite prompts are created deterministically from taxon metadata in `src/game.js`, stored in D1 `creature_genomes.prompt_json`, and hashed for sprite job dedupe.

The production generator uses `gpt-image-2` by default. When references are enabled, the Worker calls the Images edit endpoint with:

- the iNaturalist default photo, when available, as the species identity reference
- `species/v1/13858/manual/sprite_sheet.png` from R2 as the House Sparrow style/layout reference

`gpt-image-2` currently does not support transparent backgrounds, so generated sheets request an opaque plain/auto background and the UI treats each sheet as a 4x4 grid.

For development/backfill, `SPRITE_GENERATION_MODE=batch` leaves Cloudflare Queue messages acknowledged but keeps D1 `sprite_jobs` queued for OpenAI Batch submission. This uses `/v1/images/edits` with `gpt-image-2`, the iNaturalist default photo URL when available, and the House Sparrow style sheet served from R2.

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
