# Territory policy

Territory is an async, daily layer. You claim unowned tiles, garrison them with
biome-appropriate teams, and contest defended tiles. Acting on a tile requires a
minimum number of research-grade species observed locally (see
`minLocalSpeciesToAct` in `/api/rules`) and consumes one of a limited number of
daily actions (`dailyActionCap`).

## Daily routine

1. If observations are stale (`snapshot.territory.needsSync` is true, or you have
   not synced today), `POST /api/territory/sync`. The server fetches your
   observations itself — no browser needed.
2. Get ranked, eligible targets:
   - `GET /api/territory/candidates?kind=claim`
   - `GET /api/territory/candidates?kind=contest`
   Each candidate includes `h3`, `biome`, `favoredTypes`, `localSpecies`,
   `defenders`/`defenseStrength` (for contests), `biomeHoldings`, `canActToday`,
   and a `score` you can re-rank. (`GET /api/territory/claims` is only a map of
   who already owns what.)
3. Claim high-value unowned tiles first: `POST /api/territory/claim {h3}`.
4. Garrison your claims with biome-appropriate teams:
   `POST /api/territory/garrison {h3, taxonIds:[5]}`.
5. Contest weak or strategically valuable defended tiles:
   `POST /api/territory/contest {h3, taxonIds:[5]}`. **This starts a battle** —
   it returns a `territory_contest` battle that you must play to completion via
   `/api/battles/:id/action` (see battle-policy.md). Winning takes the tile.
6. Stop when `actionsLeftToday` (from the snapshot or a candidate) hits 0.

## Value signals

- biome diversity (more biomes → broader roster buffs)
- local observed species count (eligibility and strength)
- defender strength and garrison summary for contests
- whether a tile strengthens an existing cluster you hold
- whether you have strong local/team coverage to hold it

## Discipline

- Never exceed the daily cap; the server returns 429, and burning actions on
  weak tiles wastes the human's day.
- Garrison with teams whose types are favored by that biome.
- For contests, bring local-observed species and check defender strength first;
  don't attack tiles you cannot win.
