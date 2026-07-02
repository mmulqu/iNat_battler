# Battle System Improvement Plan

Seven workstreams, ordered so every balance change after #1 is measurable.
Engine code lives in `src/game.js` (pure + seeded RNG), move generation in
`src/moves.js`, battle orchestration and UI in `src/index.js`.

Status: **1–6 shipped 2026-06-10 (commit `48638b3`)** — see per-section notes for
the few sub-items still open. **7 (juice) is largely shipped**: attack lunges,
screen shake, floating damage numbers and word bursts (CRIT!/SUPER
EFFECTIVE!/RESISTED/status), a synthesized Web Audio SFX set, sequenced turn
playback, and (2026-07-02) the ghost HP bar and effectiveness-coded damage
numbers. Still open in 7: background music, a Reduce-motion toggle the JS
animations honor, and move-type flavor effects. Balance *tuning* remains
ongoing (see the 2026-06-19 high-volume run below): mechanics are in, but the
38–62% win-rate band is not yet met.

## 1. Simulation harness (`scripts/simulate.mjs`) — ✅ DONE (2026-06-10)

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

## 2. Type legibility in the UI — ✅ DONE (2026-06-10, `48638b3`)

Shipped: "It's super effective!" log lines with the multiplier in log data; move
buttons tinted green/red with ×N.N tags vs the current opponent (client-side
TYPE_CHART). _Still open: the small "type matchup" legend modal reachable from
the battle view._

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

## 3. Type chart rework (`TYPE_CHART` in game.js) — ✅ DONE (first pass, 2026-06-10, `48638b3`)

Shipped: chart rebuilt around teachable triangles (1.5/0.65 with 1.3/0.8 mids),
zero mutual super-effective pairs (confirmed clean in the 2026-06-19 audit),
Wood/Meadow/Voice given real offense (new seed_volley Meadow move), and
`inferTypes` regexes got word boundaries (the Hawk/Frost bug). _Balance targets
still open: Night/Sky/Swarm/Wetland lag and Fungus/Wood are strong per the
2026-06-19 run — tuning continues, but the structural work here is done._

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

## 4. Switch action — ✅ DONE (2026-06-10, `48638b3`)

Shipped: `resolveTurn` supports `{kind: "switch"}` (resolves before moves, the
incoming creature takes the hit), API accepts `switchIndex` with validation, NPC
switches on bad matchups with a 4-turn cooldown, bench slots clickable with HP
shown. Verified end-to-end including invalid-switch rejection.

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

## 5. Engine feel & fairness fixes — ✅ DONE (2026-06-10, `48638b3`)

Shipped: damage variance ×0.9–1.05, 2-turn stun immunity after a stun resolves,
special defense = (guard+sense)/2 (option (a), sense double-dip removed), NPC
difficulty stored on battle state and selectable in the sidebar. The optional
priority-move audit resolved itself: wing_flick is down to 4.0% damage share in
the 2026-06-19 run. _Note: stun-skip rate is still 0.0% in the sim — see the
2026-06-19 "next balance targets" for the open investigation._

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

## 6. Training visibility in battle — ✅ DONE (2026-06-10, `48638b3`)

Shipped: arena shows Lv and +mastery% chips; the result overlay lists each
creature's damage dealt/taken. _Still open: the stretch "training preview" in
the Training tab (projected damage before/after allocating points)._

- Battle state already carries `trainingLevel` and `trainingBuffPct` per
  creature; render "Lv N" and "+X% mastery" chips on the combatant cards in
  the arena.
- Post-battle summary: show each creature's contribution (damage dealt/taken
  — tally in `state.log` data during `applyMove`).
- Stretch: a "training preview" in the Training tab that shows projected
  damage vs a reference creature before/after allocating points, reusing
  `estimateDamage`.

## 7. Battle juice — animations & audio — ✅ mostly shipped

Status (2026-07-02): most of this section predated the plan entry — attack
lunges toward the target, hit recoil + screen shake, floating damage numbers,
crit bursts, effectiveness/status/heal word floats, faint effects, status
overlays, sequenced log playback, procedural biome backdrops, and a fully
synthesized Web Audio SFX pack (hit/crit/special/miss/heal/buff/debuff/status/
faint/win/lose) gated on the sound toggle. Added 2026-07-02: **HP ghost bar**
(pale segment lingers at the pre-hit value, then drains) and
**effectiveness-coded damage numbers** (super-effective bigger/hotter, resisted
smaller/dimmer, same 1.2/0.85 thresholds as the log lines). _Still open:
background music (+ Settings music toggle/volume), a Reduce-motion setting the
JS-driven animations honor, and move-type flavor effects (stretch)._

Goal: make battles feel alive and readable, not just a log scrolling under static
sprites. Pure presentation layer — no engine/balance changes — so it can ship
independently and won't affect the simulator.

### Move & event animations

Drive visuals off the structured `state.log` entries the engine already emits (each
turn's actions, multipliers, status changes, faints) so the animation layer reacts to
authoritative data rather than re-deriving it.

- **Attack/move cues**: a short lunge/recoil on the attacker and a hit reaction (shake +
  flash) on the defender, timed to the damage log line.
- **Crits**: a distinct, bigger reaction — screen-shake, a "Critical!" burst, an
  impact flash — so crits read as special (ties into the highlight-clip trigger in the
  alpha-readiness growth plan).
- **Damage numbers**: floating damage numbers that pop off the target, color/size-coded
  by effectiveness (super-effective bigger/hotter, resisted smaller/dimmer) — reinforces
  the type-legibility work in #2.
- **Healing / buffs**: a green restorative glow + rising heal number; stat-up vs
  stat-down arrows; distinct tints so support moves feel different from attacks.
- **Status effects**: persistent overlays/icons on afflicted creatures (poison tick,
  stun stars, burn) and a small cue when a status is applied vs ticks vs expires.
- **HP bar motion**: animate the bar draining/refilling (with a delayed "ghost" bar to
  show the chunk lost), instead of snapping to the new value.
- **Faint**: a clear KO animation (sprite drop/fade) — also a highlight-clip trigger.
- **Move-type flavor** (stretch): bias the effect by move type/body plan (e.g. Sky =
  feather/gust, Venom = splash) so moves don't all look identical.

Implementation notes: confirm how much of the arena is canvas vs DOM first (informs CSS
transitions vs canvas/sprite tweening, and the highlight-clip capture spike). Keep an
animation queue so multi-event turns play in order and the UI stays in sync with the
log. Honor `prefers-reduced-motion` / the planned Reduce-motion setting — fall back to
instant state changes.

### Sound effects

A small SFX set keyed to the same events, respecting the existing `state.soundOn` toggle
(and the Settings sound control).

- Per-event cues: generic hit, crit hit, super-effective vs resisted, miss, heal,
  stat-up/down, status applied, faint, victory/defeat.
- Keep the pack small and compressed; preload and play via Web Audio (or pooled
  `<audio>`), debounced so a busy turn doesn't stack into noise.
- Default volume sane; never autoplay before a user gesture (browser policy).

### Background music

Looping music to set the mood, off by default until the user opts in.

- A short looping battle theme; optional separate menu/idle track.
- **Music on/off + volume** control in Settings (separate from SFX); persist to
  `localStorage`. Respect autoplay policy — start only after a user interaction.
- Stretch: a tenser variant or tempo lift when a combatant is low on HP.
- Source royalty-free / appropriately-licensed audio and record the license; keep files
  small to protect mobile payload (the landing hero was already squeezed for this
  reason).

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

## High-volume body-plan duel check (2026-06-19, `npm run simulate -- 1000`, 153,000 duels)

Current core engine rules are substantially healthier than the 2026-06-10 baseline, but
still outside the target 38–62% aggregate win-rate band. Scope caveat: this harness uses
current `createBattleCreature`, `chooseNpcMove`, `resolveTurn`, mana costs/regen, damage,
crit/miss/status/rally logic, and TYPE_CHART, but it is not a full production battle
simulation. It runs 1v1 representative body-plan duels with fixed `obsCount: 10` and
`bondLevel: 8`; it does not load DB species move genomes, training/mastery, territory
buffs, local tile bonuses, terrain, five-creature teams, or switch actions.

- **Run size:** 153,000 duels (`1000` seeds × 153 body-plan pairings), hard AI both
  sides, 60-turn cap.
- **Battle length:** avg 6.9 turns; 1,190 turn-cap draws.
- **Event rates:** stun-skipped turns 0.0% of creature-turns; missed attacks 6.1%;
  critical hits 8.1% of landed attacks; rallies 199,828 total (1.31 per duel).
- **Top end still too strong:** raptor_bird 65.5%, mammal 64.1%, reptile 61.9%,
  fungus 61.9%, tree_shrub 61.4%.
- **Bottom end still too weak:** moth_butterfly 33.9%, passerine_bird 34.7%, insect
  38.5%, dragonfly 41.9%, waterbird 42.8%.
- **Type chart audit is clean:** no mutual super-effective pairs remain.
- **Move damage concentration is acceptable:** no single move is near the 30% danger
  line. Top shares were night_feint 15.1%, flock_burst 10.4%, burrow_trip 9.3%,
  struggle 8.2%, peck 7.7%, wetland_surge 7.3%. wing_flick is now only 4.0%.
- **Type-level read:** Fungus/Decay (61.9%), Wood (61.4%), Venom (59.3%) are strong;
  Night (33.9%), Sky (41.6%), Swarm (42.0%), Wetland (44.2%) lag.

Next balance targets:

- Bring raptor_bird and mammal below ~62% without flattening their identities. Raptor
  is still extremely polarized by matchup; mammal's Urban/Meadow kit is broadly safe.
- Lift moth_butterfly and passerine_bird above ~38%. Night is especially weak despite
  night_feint contributing high total damage, so the issue appears to be matchup spread
  and survivability rather than one underpowered move.
- Investigate why stun never produces skipped turns in the current hard-AI sim. It may
  be absent from chosen move pools or not competitive enough for the AI to select.
- Re-run `npm run simulate -- 1000` after each type/body-plan adjustment and compare
  aggregate rates, type rates, and top move damage share.

## Sequencing

1 (harness) → 3 (chart, measured) → 5 (engine fixes, measured) → 2 (UI
legibility) → 4 (switching, largest change, measured) → 6 (polish) → 7 (juice).
Each step ships independently; 2, 6, and 7 are UI/presentation-only and safe
anytime (7 pairs well with 2's effectiveness cues and the highlight-clip work).

Steps 1–7 are done apart from small leftovers: music + Reduce-motion +
move-type flavor in 7, the legend modal in 2, the training preview in 6, and
ongoing balance tuning driven by `npm run simulate -- 1000` runs against the
38–62% band.
