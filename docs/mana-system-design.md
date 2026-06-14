# Mana System — Design & Build Notes

A shared-pool "mana" resource (PP-style) that gates move usage, to add pacing and
resource decisions to battles. Decided 2026-06-13.

## Decisions (locked)

- **Shared pool**, one mana bar per creature (not per-move PP).
- **Cost-from-power**: a move's mana cost is derived from its existing `power`
  (+ small surcharge for strong effects). No genome regeneration, no authored costs.
- **Full each battle**: mana starts at max (free — battle creatures are built fresh in
  `createBattleCreature`, no overworld persistence).
- **+1 regen per turn**, applied to **every non-fainted creature on both teams** —
  active *and* benched. So a player can swap a drained creature out, let it regen on the
  bench, and bring it back. Swapping costs no mana (but loses tempo: the opponent still
  moves that turn).
- **Struggle fallback**: when the active creature can afford none of its moves, it can
  only use Struggle — a free, weak, fixed-damage attack with light self-recoil — or swap.
- **One bar + cost labels**: a mana bar under the HP bar; each move button shows its cost;
  unaffordable moves are greyed/disabled.
- **Opponent mana bar shown** (parity with HP; readable counterplay).
- **Mana bar color: blue.**

## Numbers (initial, all tunable)

- `MAX_MANA = 10` (flat for MVP; may later scale lightly with a stat).
- `MANA_REGEN_PER_TURN = 1`.
- Cost formula:
  - status-category move → flat `3`.
  - damage move → `clamp(round(power / 10), 2, 6)` (power 20→2 … 60→6).
  - optional `+1` for multihit / strong-effect riders (using the existing effect-budget).
- Struggle: `power ~15`, typeless, cost `0`, recoil ~`1/8` of max HP.

These give roughly "2 big moves then pace yourself / swap to regen," which is the feel
we want. Tune `MAX_MANA` and the cost divisor first if it feels off.

## Where it lives (server-authoritative)

All validation and deduction happen server-side in the engine; the client only displays
bars + costs and disables unaffordable buttons (never trusted).

- `src/game.js`
  - `createBattleCreature` — add `mana` / `maxMana` (mana = maxMana).
  - `resolveTurn` — deduct cost when a move is used; coerce unaffordable → Struggle;
    apply `+1` regen to all non-fainted creatures (both teams) at end of turn.
  - `applyMove` — handle the special `struggle` move (fixed damage + recoil, cost 0).
  - `chooseNpcMove` / `chooseNpcAction` — AI considers only affordable moves; if none,
    swap (if it has a benched option) else Struggle.
- `src/moves.js` (or a small helper) — `moveManaCost(move)` cost formula.
- `src/index.js` client `renderBattle` / `renderCombatant` / swap dialog — mana bar (blue),
  per-move cost labels, disable unaffordable, Struggle button when nothing affordable,
  mana bar in each swap-dialog row.

Note: confirm the battle-state serializer sends the whole creature (so `mana`/`maxMana`
ride along automatically); add them to the whitelist if one exists.

## Build checklist (go through in order)

1. [x] `moveManaCost(move)` helper + `MAX_MANA` / `MANA_REGEN_PER_TURN` constants.
2. [x] `createBattleCreature`: add `mana`/`maxMana`.
3. [x] `resolveTurn`: spend on move use; unaffordable → Struggle; end-of-turn +1 regen to
       all non-fainted creatures on both teams.
4. [x] `applyMove`: Struggle move (reuses the existing `recoil` effect; cost 0).
5. [x] NPC AI: affordable-only move selection; Struggle fallback (swap fallback deferred).
6. [x] Serializer: full battle state is sent — `mana`/`maxMana` ride along automatically.
7. [x] Client: blue mana bar under HP (player + opponent) via the HP-bar pattern.
8. [x] Client: per-move cost labels (`N MP`) + disable unaffordable + Struggle button.
9. [x] Client: mana bar in each swap-dialog row.
10. [x] QA via Playwright (demo battle): bars render, costs show (3/3/4/3), spend+regen
        works (10→8 on a cost-3 move), Struggle server path verified, opponent bar shows.
11. [ ] **Balance pass** on real 5v5s; tune `MAX_MANA` / cost divisor. _(Initial values
        feel reasonable: ~4 moves before you must swap/cheap-out; iterate from play.)_

## Open / later

- Scale `MAX_MANA` with a stat (e.g., tempo) so creatures differ — deferred.
- Whether benched regen should be faster than active (rest bonus) — deferred; start equal.
- Mana-drain / mana-burn move effects — possible future move-effect category.
