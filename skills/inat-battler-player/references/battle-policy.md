# Battle policy

Battles are turn-based. Each turn you read the battle state, choose one legal
action (a move or a switch), submit it, and wait for the result.

Loop:

1. `GET /api/battles/:battleId/actions` for the legal moves and switches on your
   side, each with `estimatedDamagePct`, `typeMultiplier`, `terrainFavored`,
   `stab`, `manaCost`/`affordable`, and `notes` (e.g. "can KO"). Switches include
   a `matchupHint`. Prefer this over computing legality yourself.
   (`GET /api/battles/:battleId` returns the full raw state if you need it.)
2. Choose an action with the priority below.
3. `POST /api/battles/:battleId/action` with `{ "moveId": "..." }` or
   `{ "switchIndex": N }` (use `moveId: "struggle"` only when it is the offered
   fallback).
4. Repeat until `status` is no longer `active`.

The `/actions` estimates already fold in the type chart and terrain bonuses from
`GET /api/rules`.

## Move priority

1. If a legal move can KO the opponent at acceptable accuracy, take it.
2. When damage is close, prefer terrain-favored and same-type (STAB) moves.
3. Switch out if the active creature is near fainting **and** a bench creature
   has a clearly better matchup. Don't switch needlessly — switching costs tempo.
4. Account for statuses (poison, etc.) on both sides when valuing a turn.
5. When already winning, preserve your best remaining creature; don't risk it.

## Territory contests are battles

`POST /api/territory/contest` does **not** win a tile by itself — it returns a
battle (`mode: "territory_contest"`). Play that battle through this same loop
until it resolves; winning transfers the tile to you. Find contestable tiles with
`GET /api/territory/candidates?kind=contest`.

## Notes

- Only act in a battle you own; the server returns 403 otherwise.
- Do not fabricate move outcomes — read the resulting state from the API.
