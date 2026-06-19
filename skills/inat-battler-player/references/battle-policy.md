# Battle policy

Battles are turn-based. Each turn you read the battle state, choose one legal
action (a move or a switch), submit it, and wait for the result.

Loop:

1. `GET /api/battles/:battleId` to read current state (your active creature, the
   opponent, HP, statuses, and your available moves/switches).
2. Choose an action with the priority below.
3. `POST /api/battles/:battleId/action` with your choice.
4. Repeat until the battle ends.

Use the type chart and terrain bonuses from `GET /api/rules` to evaluate damage.

## Move priority

1. If a legal move can KO the opponent at acceptable accuracy, take it.
2. When damage is close, prefer terrain-favored and same-type (STAB) moves.
3. Switch out if the active creature is near fainting **and** a bench creature
   has a clearly better matchup. Don't switch needlessly — switching costs tempo.
4. Account for statuses (poison, etc.) on both sides when valuing a turn.
5. When already winning, preserve your best remaining creature; don't risk it.

## Notes

- Only act in a battle you own; the server returns 403 otherwise.
- Do not fabricate move outcomes — read the resulting state from the API.
- If the server later exposes `GET /api/battles/:battleId/actions` (legal actions
  with damage estimates), prefer it over computing legality yourself.
