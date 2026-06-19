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
  player's roster (read-only; any user).
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

- `POST /api/battles/npc/start` — start an NPC battle with your selected/saved 5.
- `GET /api/battles/:battleId` — full battle state.
- `GET /api/battles/:battleId/actions` — legal actions for your side with
  estimates: `moves[]` (`moveId`, `type`, `category`, `accuracy`, `manaCost`,
  `affordable`, `estimatedDamagePct`, `typeMultiplier`, `terrainFavored`, `stab`,
  `notes`) and `switches[]` (`switchIndex`, `hpPct`, `matchupHint`). Prefer this
  over parsing raw state.
- `POST /api/battles/:battleId/action` — body `{ "moveId": "..." }` or
  `{ "switchIndex": N }`. You may only act in a battle you own.

## Challenges (write: challenge / share)

- `GET /api/challenges` — incoming/outgoing, each with `direction` and `status`.
- `POST /api/challenges` — send a challenge (conservative; see SKILL etiquette).
- `POST /api/challenges/:id/accept` / `POST /api/challenges/:id/decline`.

## Territory (write: territory)

- `POST /api/territory/sync` — refresh your observations for tile eligibility
  (server-side fetch; no browser needed).
- `GET /api/territory/candidates?kind=claim|contest` — ranked, eligible targets
  with `h3`, `biome`, `favoredTypes`, `localSpecies`, `defenders`/`defenseStrength`
  (contest), `biomeHoldings`, `canActToday`, and a `score`. Use this to find
  targets — `/api/territory/claims` only shows who already owns what.
- `GET /api/territory/tile?h3=<cell>` — one tile's detail, including
  `canClaim`, `canContest`, `canGarrison`, `actionsLeftToday`, `favoredTypes`.
- `POST /api/territory/claim` — body `{ "h3": "<cell>" }`.
- `POST /api/territory/garrison` — body `{ "h3": "<cell>", "taxonIds": [...] }`.
- `POST /api/territory/contest` — body `{ "h3": "<cell>", "taxonIds": [...] }`.
  Returns a `territory_contest` **battle**; play it via `/api/battles/:id/action`
  until it resolves. Winning captures the tile.

Daily territory actions are capped server-side; over-limit calls return 429.

## Errors

- `401` — missing/invalid credential. Get an API key or drop to recommend-only.
- `403` — acting as the wrong user, or a browser-only action (e.g. managing API
  keys) attempted with a Bearer key.
- `429` — rate limit or daily cap reached; wait and retry later.
