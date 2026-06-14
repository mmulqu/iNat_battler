# Territory × Combat — Merging Biome into iNat Battler

**Status:** Design / implementation plan. Nothing here is built yet.
**Decided to pursue:** 2026-06-14.
**Source repos:** `iNat_battler` (this repo — the combat layer) and
[`mmulqu/Biome`](https://github.com/mmulqu/Biome) (the H3 territory/tiling layer).

---

## The thesis

Biome and iNat Battler are two halves of one game that were built apart. Biome is the
**strategic layer** — real-world iNaturalist observations convert into H3 hex territory,
landcover-derived biomes, and an AP/claim/contest economy. iNat Battler is the **tactical
layer** — a server-authoritative creature-battler (`src/game.js`) with a 16-type chart,
mana, status, in-battle swapping, and async "ghost" battles.

Today Biome resolves a tile contest with arithmetic
(`progressAdded - floor(defense_strength / 10)`). The entire design conversation behind
this doc is really one request: **make that contest a battle, fought on the tile's real
biome.** Both pieces to do that already exist; they just live in different repos.

The flywheel we're building:

> observe in the real world → claim/strengthen tiles **and** roster → win territory →
> territory makes your roster stronger and yields resources → you covet richer tiles →
> go back outside and observe the next research-grade species. Every step pulls the
> player into the field, which is the only reason an iNat game should exist.

### How alike they already are (why this is cheap)

| Concern | Biome | iNat Battler |
| --- | --- | --- |
| Runtime | Cloudflare Worker + D1 | Cloudflare Worker + D1 + R2 + KV + Queues |
| Identity | `inat_user_id` + bio-code verification | `inat:<login>` + bio-code verification (+ Bluesky OAuth) |
| Data source | iNat observations → AP + tile value | iNat `species_counts` → roster + training points |
| "Biome" vocabulary | Copernicus landcover → ~13 classes / 8 `biome_type`s | 16 move types + 5 backdrop palettes |
| Async conflict | `contest` = AP arithmetic | ghost battles (snapshot team piloted by AI) — **already shipped** |

---

## Architecture decision: battler is the host

**Make `iNat_battler` the host app; fold Biome's territory layer in as new D1 migrations +
route modules.** Reasons:

- The battler is the far more mature app (Bluesky OAuth, sprite pipeline, training, mobile
  layout, async ghost battles, a *pure portable* engine in `src/game.js`).
- The battle engine is a pure module with no network dependency — it's the thing Biome
  needs and can't easily reimplement.
- Biome's whole backend is a single `worker/src/index.ts` + two migrations. It ports as a
  set of tables (`tiles`, `tile_biomes`, `landcover_classes`, `factions`, `actions`,
  `quests`, `achievements`) and a `/tiles`, `/actions`, `/biomes` route group.

**Alternative considered — two Workers wired by a Cloudflare Service Binding** (Biome
RPC-calls the battler's engine): keeps the repos deployed independently, but doubles the
identity/observation plumbing and splits a D1 we will constantly join across (tile owner ↔
roster ↔ training). Only worth it if Biome must stay independently deployed. **Not
recommended.**

---

## The four bridges (in dependency order)

### Bridge 1 — One identity, one observation stream

Both apps key on the same iNat account and verify ownership the same way (paste a code in
the iNat profile bio). Today an observation feeds *either* the map *or* the roster
depending on which app ingested it. Unified, a single `observations/sync` fans out:

- **→ map side:** AP, `tile.total_observations`, `tile.unique_species` (tile value),
  faction score. (Biome's existing logic.)
- **→ combat side:** roster membership + training points for that species
  (`src/training.js` already derives points from research-grade counts).

This unlocks everything else and requires **no battle-engine change**. Do it first.

**Data-model reconciliation (the unglamorous prerequisite):**

- **Player key.** Biome uses integer `players.id` (+ `inat_user_id`); the battler uses
  string `inat:<login>`. Pick one — recommend the battler's string id as canonical, add
  `inat_user_id` to its `users` table, repoint Biome FKs.
- **Observations.** Both have an `observations` table with overlapping columns and the
  same `inat_observation_id` dedupe key. Merge into one, fanning out to both scoring paths.
- **`biome_type` enum drift.** Biome's `tiles.biome_type` CHECK (8 values) is narrower than
  the `tile_biomes` landcover set (~13). Standardize on the landcover-derived set and make
  the terrain map (Bridge 2) the single source of truth.

### Bridge 2 — Tile biome → battle **terrain** (highest value, most localized)

This is the gameplay payoff and the only real engine work. **The key finding from reading
the code: terrain today is purely cosmetic.** `pickBiome(battle)` (`src/index.js:15743`)
chooses a backdrop palette from the *combatants' types*, and `makePixelBackdropSvg`
(`src/index.js:15754`) only draws pixels. It has **zero mechanical effect** and is derived
from the creatures, **not from a place**. So this bridge is a genuine — but small and
self-contained — engine change.

The 16 move types are already mostly habitat words, so the mapping nearly writes itself:

| Biome tile `biome_type` | Battle terrain | Buffs move types / native body plans |
| --- | --- | --- |
| forest / woodland | `forest` | Wood, Bloom, Fungus · tree_shrub, fungus |
| wetland / freshwater | `wetland` | Wetland · amphibian, waterbird, dragonfly, fish |
| grassland / agricultural | `meadow` | Meadow, Sun · grass_sedge, plant_herb, insect |
| shrubland | `scrub` | Bloom, Meadow |
| urban | `urban` | Urban · passerine_bird, mammal |
| desert / bare_sparse | `arid` | Stone, Sun · reptile |
| polar / tundra | `frost` | Frost, Fungus |
| coastal / mountain | `stone` / `sky` | Stone, Sky |
| ocean / unknown | `neutral` | — (the deliberate "blank field") |

**Three concrete changes:**

1. **Thread a `terrain` field into battle state.** The state object is a plain
   `{ player, opponent, seed, turn, ... }` literal built where battles start
   (`startDemoBattle`, `src/index.js:4431`, and the live-battle creator). Add
   `terrain: "<key>"`. Because the serializer sends the whole state object (no field
   whitelist — same reason `mana`/`maxMana` rode along for free), it reaches the client
   automatically.

2. **Apply it in the pure engine.** The single injection point is `estimateDamage`
   (`src/game.js:645`), specifically the `base` product at **`src/game.js:659`** which
   already multiplies `sameTypeBonus * typeMultiplier * bondNudge * DAMAGE_SCALE`. Add a
   `terrainMultiplier` factor next to those:

   ```js
   // game.js — sketch, mirrors the existing sameTypeBonus pattern
   const TERRAIN_MOVE_BONUS = {
     forest:  ["Wood", "Bloom", "Fungus"],
     wetland: ["Wetland"],
     meadow:  ["Meadow", "Sun"],
     urban:   ["Urban"],
     arid:    ["Stone", "Sun"],
     frost:   ["Frost", "Fungus"],
     // neutral: none
   };
   function terrainMultiplier(move, terrain) {
     const boosted = TERRAIN_MOVE_BONUS[terrain];
     return boosted && boosted.includes(move.type) ? 1.15 : 1;
   }
   ```

   …then in `estimateDamage` thread `state.terrain` through and multiply `base` by
   `terrainMultiplier(move, terrain)`. Keep the bonus modest (≈ +15%, same magnitude as
   STAB) so it adds texture without becoming a hard counter. The engine stays pure and
   seeded, so **`scripts/simulate.mjs` can re-validate balance** after the change.

3. **Drive the cosmetic backdrop from `terrain` instead of inferring it from combatants.**
   Replace `pickBiome(battle)`'s type-sniffing with a straight `battle.terrain → palette`
   lookup — strictly a simplification, and now the backdrop finally means something.

This is what turns "the territorial layer and the battle layer feed each other": the
attacker fights on the **defender's home biome**, so you defend hardest where your species
are native and covet tiles that suit your roster. It also replaces a brittle 16×16 type
chart's role as the *only* matchup axis with something legible ("of course the salamander
is stronger in the wetland").

**Controlled variance (do not randomize the biome).** The biome is the tile's real
landcover — fixed. Add freshness *on top*: a weather/season/day-night overlay (real iNat
timestamps), and in-battle terrain shifts (a beaver floods it, fire clears it) so a player
can fight *away* from a bad matchup rather than just suffering it. Random per-battle
terrain would sever the one connection that makes this game ours — don't.

### Bridge 3 — A contest **is** a battle (reuse the ghost system)

Replace/augment Biome's `contest` action with a battle. The elegant part: **iNat Battler
already implements async PvP as ghost battles** — the defender need not be online; their
snapshotted 5-team is piloted by `chooseNpcAction` (`src/game.js:327`). That is exactly the
primitive territorial conquest needs.

- **Contest →** start a ghost battle: attacker's live team vs. defender's snapshot, on the
  tile's `terrain` (Bridge 2), with `tile.defense_strength` mapped to a defender buff
  (home-field advantage).
- **Win →** advance `capture_progress` / flip the tile; **lose →** defense holds. The
  existing `getBattleStatus` `won`/`lost` verdict already produces the result.
- **Keep AP as the gate/cost to *initiate*, not the resolver** — preserves Biome's
  anti-spam (`player_daily_limits`, `maxContestsPerTile`).

**The gate split (from the design notes):** separate *claim* from *attack*.

- **Claim an empty tile** requires an observation **in that tile** — you were literally
  there. Strongest possible tie to place.
- **Attack a held tile** requires presence **in the neighborhood** (the radius idea) — you
  can push a front line into adjacent territory without having stood on every hex.

### Bridge 4 — Tile control → roster power (closes the loop)

Holding a biome strengthens species native to it; contiguous-habitat "corridors" grant set
bonuses. Concretely this rides the **existing `trainingBuffPct` path** in
`createBattleCreature` (`src/game.js:235`): controlled-territory becomes another additive
buff source, applied at build time exactly like genus/family mastery is today. **No new
battle math.**

---

## Make tile *value* ecological (not flat)

The reason to control a tile must be more than "you control the tile." Tile worth = a
function of real biodiversity (research-grade species count, rarity, habitat richness),
paying out in three currencies that all feed the loop:

1. **Passive yield** — held tiles generate currency over time, scaled by biodiversity. The
   economic engine and the reason for conflict.
2. **Roster power** — Bridge 4. Territory directly shapes your battle deck.
3. **Collection progress** — controlling a tile registers its species toward the
   taxonomic-completion meta. Biodiverse tiles advance it fastest.

---

## Risks to design against

- **PvP fairness / collection power-creep.** Observation-count → stats is thematically
  perfect but lets fieldwork-heavy players field strictly superior teams for contesting
  tiles ("you must own 5 games to be competitive," applied to fieldwork). Mirror Pokémon
  Showdown: let observation-count drive **flavor / unlocks / native buffs**, but offer a
  **normalized-stat ranked mode** for symmetric contests, so skill lives in the battle, not
  the collection.
- **Urban snowball.** Dense iNat areas are both easiest to claim and richest in
  biodiversity — cities run away with the board. Counter with **higher yield-per-observation
  on sparse tiles** + the claim/attack gate split + a cap on contiguous extraction.
- **Density dead-zones.** A flat 5-obs gate makes rural tiles unplayable. Normalize the
  threshold by local observation density, or make sparse tiles high-value.
- **Async-only, for now.** Real-time PvP needs a Durable Object per battle (noted unbuilt
  in the battler README). Territorial conquest is *naturally* async, so the ghost-battle
  path is the right MVP — don't block on realtime.
- **H3 resolution sets the whole feel.** At res 8 (~0.7 km² hexes) the game is hyperlocal;
  at res 6 it's regional. Decide the feel *first*, then the neighborhood radius.

---

## Suggested path

1. **Bridge 1 — merge identity + observation ingestion.** Unlocks everything; no battle
   changes. Includes the data-model reconciliation.
2. **Bridge 2 — mechanical terrain in the engine + simulator-validate.** Self-contained,
   the biggest gameplay payoff, testable in isolation via `scripts/simulate.mjs`.
3. **Bridge 3 — wire contest → ghost battle on terrain.** Mostly glue; reuses the existing
   ghost-battle, `getBattleStatus`, and AP-gate systems.
4. **Bridge 4 — territory → roster buffs** via `trainingBuffPct`. Closes the flywheel.

Bridges 2 and 4 are the only ones that touch `src/game.js`, and both are additive factors
in code paths that already exist (`estimateDamage`, `createBattleCreature`). Bridge 2 is the
recommended first concrete slice because it's isolated, simulator-testable, and delivers the
single richest source of dynamism — terrain as a contestable third combatant — essentially
for free from data we already have.
