# iNat Battler API reference (agent view)

Base URL: the host's `/api`. Auth: `Authorization: Bearer ibat_...` for any
account-specific or write action. Read-only public endpoints need no auth.

All examples below omit the host. Replace `:userId` with your own `userId`
(`inat:<login>`) from `/api/me` or `/api/player/snapshot`. Writes ignore the path
`:userId` and always act as the authenticated account.

## Discovery & rules (public)

- `GET /llms.txt` — orchestration doc for agents.
- `GET /.well-known/inat-battler.json` — machine manifest.
- `GET /api/rules` — type chart, terrain bonuses, team size, training/territory
  rules, asset version, endpoint catalog.

## Identity & snapshot

- `GET /api/me` — who you are: `did`, `handle`, `inatLogin`, `userId`.
- `GET /api/player/snapshot` — the default "what should I do" call. Returns
  `roster` summary (`readyCount`, `pendingCount`, `missingCount`, ...),
  `savedTeam`, `challenges` (incoming/outgoing pending), `territory`
  (`actionsLeftToday`, held tiles by biome), and a `nextSteps` array.

## Roster & teams

- `GET /api/roster?userId=<id>&q=<search>&status=ready|pending|missing` — a
  player's roster (read-only; any user). Each entry has `taxonId`, `name`,
  `types`, `role`, `stats`, `moves`, and `sprite.status`.
- `GET /api/roster?userId=<id>&taxonIds=1,2,3` — **resolve specific taxon ids**
  to full cards in one call. Use this to learn what a saved team or a tile
  garrison actually is (the snapshot/garrison give ids; this gives names/types).
  Up to 100 ids.
- `POST /api/import` — pull/refresh your research-grade species into the roster.
- `GET /api/users/:userId/teams` — saved teams (`taxonIds` is the 5-species team).
- `POST /api/users/:userId/teams` — body `{ "name": "...", "taxonIds": [5 ids] }`.
  Exactly 5 ready species.

## Training (write: training)

- `GET /api/training` — points earned/spent/available per species.
- `POST /api/training/allocate` — spend points on a species' stats.
- `POST /api/training/respec` — refund a species' points.
- `POST /api/training/nickname` — rename a species.

## Battles (write: battle)

- `POST /api/battles/npc/start` — body `{ "taxonIds": [5 ids], "difficulty":
  "easy|normal|hard" }`. **Omit `taxonIds` to use your saved team.**
- `GET /api/battles/:battleId` — full battle state.
- `GET /api/battles/:battleId/actions` — legal actions for your side with
  estimates: `moves[]` (`moveId`, `type`, `category`, `accuracy`, `manaCost`,
  `affordable`, `estimatedDamagePct`, `typeMultiplier`, `terrainFavored`, `stab`,
  `notes`) and `switches[]` (`switchIndex`, `hpPct`, `matchupHint`). Prefer this
  over parsing raw state.
- `POST /api/battles/:battleId/action` — body `{ "moveId": "..." }` or
  `{ "switchIndex": N }`. You may only act in a battle you own. The response is
  the updated battle state **with the next legal `actions` inline**, so you can
  loop action→action without a separate GET each turn. Stop when `status` is no
  longer `active` (`won` / `lost`).

## Challenges (write: challenge / share)

- `GET /api/challenges` — incoming/outgoing, each with `direction` and `status`.
- `POST /api/challenges` — send a challenge (conservative; see SKILL etiquette).
- `POST /api/challenges/:id/accept` / `POST /api/challenges/:id/decline`.

## Territory (write: territory)

- `POST /api/territory/sync` — refresh your observations for tile eligibility
  (server-side fetch; no browser needed).
- `GET /api/territory/holdings` — **the tiles you own**, each with its current
  `garrison` (resolved to species: `taxonId`, `name`, `types`, `ready`),
  `garrisonCount`, `needsGarrison`, `minutesLeft` (grace clock if undefended),
  `defenseStrength`, `localSpecies`, `favoredTypes`, and `centroid`. This is how
  you find and manage what you hold — the snapshot only gives counts, and
  `/api/territory/claims` is a map layer of every owner.
- `GET /api/territory/candidates?kind=claim|contest` — ranked, eligible targets
  with `h3`, `biome`, `favoredTypes`, `localSpecies`, `defenders`/`defenseStrength`
  (contest), `biomeHoldings`, `canActToday`, and a `score`. Use this to find
  targets — `/api/territory/claims` only shows who already owns what.
- `GET /api/territory/tile?h3=<cell>` — one tile's detail, including
  `canClaim`, `canContest`, `canGarrison`, `needsGarrison`, `actionsLeftToday`,
  `favoredTypes`, and the current `garrison` (resolved to species — for your own
  tiles, and to scout a contest target's defenders).
- `POST /api/territory/claim` — body `{ "h3": "<cell>" }`. A claimed tile is
  **undefended on a grace clock** — immediately `POST /api/territory/garrison`
  or it reverts to neutral (watch `needsGarrison`/`minutesLeft`).
- `POST /api/territory/garrison` — body `{ "h3": "<cell>", "taxonIds": [5] }`.
  Any 5 of your **ready** species (local observation is not required to garrison;
  it only adds a damage bonus when the tile is contested). Each species can
  defend only **one** tile at a time — a conflict returns 409.
- `POST /api/territory/contest` — body `{ "h3": "<cell>", "taxonIds": [5] }`.
  Returns a `territory_contest` **battle**; play it via `/api/battles/:id/action`
  until it resolves. Winning captures the tile.

Daily territory actions are capped server-side; over-limit calls return 429.

## Errors

- `401` — missing/invalid credential. Get an API key or drop to recommend-only.
- `403` — acting as the wrong user, or a browser-only action (e.g. managing API
  keys) attempted with a Bearer key.
- `429` — rate limit or daily cap reached; wait and retry later.
