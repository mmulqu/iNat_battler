# Territory policy

Territory is an async, daily layer. You claim unowned tiles, garrison them with
biome-appropriate teams, and contest defended tiles. Acting on a tile requires a
minimum number of research-grade species observed locally (see
`minLocalSpeciesToAct` in `/api/rules`) and consumes one of a limited number of
daily actions (`dailyActionCap`).

## Daily routine

1. If observations are stale, `POST /api/territory/sync`.
2. `GET /api/territory/claims` to see claimable and contestable tiles.
3. Claim high-value unowned tiles first (`POST /api/territory/claim`).
4. Garrison your claims with biome-appropriate teams
   (`POST /api/territory/garrison`).
5. Contest weak or strategically valuable defended tiles
   (`POST /api/territory/contest`).
6. Stop when `actionsLeftToday` (from the snapshot or tile detail) hits 0.

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
