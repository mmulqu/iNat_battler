# Battle System Improvement Plan

Six workstreams, ordered so every balance change after #1 is measurable.
Engine code lives in `src/game.js` (pure + seeded RNG), move generation in
`src/moves.js`, battle orchestration and UI in `src/index.js`.

## 1. Simulation harness (`scripts/simulate.mjs`) — DO FIRST

Goal: turn "is it balanced?" into a table.

- Node script importing `createBattleCreature`, `resolveTurn`, `chooseNpcMove`,
  `createSeededRng` from `src/game.js` (package is `"type": "module"`).
- Synthetic taxa: one representative per body plan (names chosen to trigger
  `inferBodyPlan` / `inferTypes` regexes), fixed bond level so only the
  body-plan kit varies.
- Both sides AI-driven: player move chosen by calling `chooseNpcMove` on a
  mirrored state `{player: opponent, opponent: player}`.
- Round-robin 1v1 duels, N seeds per pairing, sides alternated; cap at 60
  turns → draw.
- Report: win-rate matrix per body plan, aggregate win % per body plan and
  per type, average battle length, stun-skip rate, miss rate, status uptime.
- Exit criteria for "balanced enough": no body plan above ~62% or below ~38%
  aggregate win rate in the duel matrix; no single move responsible for >30%
  of all knockouts.
- Re-run after every change in workstreams 3–5; paste the before/after tables
  into the commit message.

## 2. Type legibility in the UI

Goal: players can learn the chart by playing.

- `applyMove` already computes the multiplier inside `estimateDamage`; return
  it (or recompute in `applyMove`) and push log lines: multiplier ≥ 1.2 →
  "It's super effective!", ≤ 0.85 → "It's not very effective…". Include the
  multiplier in the log entry `data` for the UI.
- Battle UI: show type chips on both active combatants; tint each move button
  green/red/neutral against the current opponent (compute client-side with an
  exported TYPE_CHART, or precompute per-move hints server-side in battle
  state).
- Sidebar/cards already show types; add a small "type matchup" legend modal
  reachable from the battle view.

## 3. Type chart rework (`TYPE_CHART` in game.js)

Goal: every type has at least one real predator and one real prey; teachable
triangles; no mutual super-effectiveness.

- Fix the **Urban↔Burrow mutual 1.2/1.15** bug (decide one direction).
- Deepen multipliers: strong = 1.5, weak = 0.65 (today 1.35/0.7 max and most
  are ±0.15, which disappears on 150 HP pools).
- Give **Wood, Meadow, Voice** real offense (each currently has no multiplier
  above ~1.1) and make **Frost** assignable (it's nearly unreachable via
  `inferTypes` name regexes).
- Design around named triangles so the chart is explainable in one screen:
  - Sky > Bloom > Stone > Sky (already exists, keep)
  - Sun > Fungus/Decay > Bloom > Sun(?)
  - Venom > Swarm > Meadow > Venom(?)
  - Night > Voice > Stone(?) — decide and document in a chart comment.
- Reduce filler-type blandness: `inferTypes` pads most creatures with
  Urban/Meadow; consider padding with the body plan's natural second type
  instead.
- Validate with the simulator (#1): per-type win rates should spread, not
  cluster at 50%.

## 4. Switch action

Goal: make team order strategic and let players play around bad matchups.

- Engine: extend `resolveTurn` actions to `{kind: "switch", index}` — switch
  resolves before all moves (like Pokémon), the incoming creature eats the
  opponent's move that turn. Keep `autoSwitch` for faints.
- API: `submitBattleMove` accepts `{moveId}` or `{switchIndex}`; validate the
  target is unfainted and not active.
- NPC AI: simple heuristic — switch when active creature's best move
  multiplier vs opponent ≤ 0.75 AND a benched creature has ≥ 1.2, with a
  cooldown so it doesn't loop.
- UI: bench strip under the active sprite (5 slots, HP bars); click to
  switch; disable while busy/fainted.
- Re-run simulator with switching enabled for the AI to confirm it doesn't
  degenerate (switch-stall).

## 5. Engine feel & fairness fixes

- **Damage variance**: multiply final damage by 0.9–1.05 (seeded RNG) so
  battles aren't fully scripted.
- **Stun immunity**: after a stun is consumed, set
  `statusMeta.stunImmuneUntilTurn = turn + 2`; `applyEffect` refuses to
  re-stun before then. (Simulator metric: stun-skip rate should drop below
  ~8% of turns.)
- **Sense double-dip**: special moves currently use attacker sense vs
  defender sense (high-sense creatures both hit hard AND tank special hits).
  Options: (a) special defense = (guard + sense) / 2, or (b) add a 6th stat.
  Prefer (a) — no schema/training changes needed; stat caps and training UI
  unchanged.
- **Expose difficulty**: `chooseNpcMove` already supports
  random/easy/normal/hard; add a difficulty picker to the battle start UI and
  pass it through `startNpcBattle` → `submitBattleMove` (store on battle
  state).
- Optional: priority-move audit via simulator (wing_flick win-rate share).

## 6. Training visibility in battle

- Battle state already carries `trainingLevel` and `trainingBuffPct` per
  creature; render "Lv N" and "+X% mastery" chips on the combatant cards in
  the arena.
- Post-battle summary: show each creature's contribution (damage dealt/taken
  — tally in `state.log` data during `applyMove`).
- Stretch: a "training preview" in the Training tab that shows projected
  damage vs a reference creature before/after allocating points, reusing
  `estimateDamage`.

## Baseline results (2026-06-10, `node scripts/simulate.mjs 25`, 3825 duels)

- **Time-to-kill is the core problem**: avg battle length 2.6 turns. Damage
  (~50-80 per hit) is overtuned vs HP pools (~100-150), so duels are decided
  by turn order; statuses and stat stages never matter (stun-skip rate 0.0%).
- **Win-rate spread is extreme**: raptor_bird 90.8% .. unknown 16.2%
  (target band 38-62%). Priority+tempo dominates: wing_flick alone is 18.1%
  of all damage dealt.
- **RPS works where the chart is sharp**: reptile (Stone) beats raptor_bird
  92% because Stone resists Sky and hits back 1.25x — proof the dynamic is
  fun when multipliers are meaningful.
- **Chart audit found 3 mutual super-effective pairs** (Urban<->Burrow,
  Night<->Voice, Swarm<->Urban) and 3 inert-offense types (Wood, Meadow,
  Voice).
- **Type-assignment regex bug**: substring matching without word boundaries
  gives Red-tailed Hawk (*Buteo jama-ICE-nsis*) the Frost type. inferTypes
  needs word-ish boundaries.
- First balance levers to try (re-run sim after each): raise HP or cut
  damage ~40% (e.g. maxHp 45 -> 90 base, or global damage x0.6), tone down
  wing_flick, fix the chart pairs above.

## Sequencing

1 (harness) → 3 (chart, measured) → 5 (engine fixes, measured) → 2 (UI
legibility) → 4 (switching, largest change, measured) → 6 (polish). Each step
ships independently; 2 and 6 are UI-only and safe anytime.
