# Territory × Combat — Merging Biome into iNat Battler

**Status:** All four bridges done — the flywheel is closed (see Progress below).
**Decided to pursue:** 2026-06-14.
**Tile scale:** res5 (~250 km² hexes) for the MVP; res7 hyperlocal later.
**Source repos:** `iNat_battler` (this repo — the combat layer) and
[`mmulqu/Biome`](https://github.com/mmulqu/Biome) (the H3 territory/tiling layer).

---

## Progress (updated 2026-06-14)

**Bridge 1 — identity + observation stream: backend done & verified.**

- ✅ **Identity unified, not duplicated.** `migrations/0015_territory.sql` folds the
  territory model into `inat_battler`. Biome's separate `players` table and its own iNat
  verification flow are **dropped**; ownership references the battler's `users(id)` (TEXT).
  Seeds `landcover_classes` (23) + `factions` (4). Tables: `tile_biomes`, `tiles`,
  `tile_observations`, `territory_players`, `territory_actions`, `factions`,
  `landcover_classes`.
- ✅ **Tiles recovered.** `biome-db` on Cloudflare was deleted; the H3→biome data survives
  as local JSONL. `scripts/import_tile_biomes.mjs` re-imports it (batched under D1's
  statement-length cap, resumable). **1.81M global res5 tiles loaded into local D1.**
  _Remote load held until the app reads tiles — run on deploy._
- ✅ **Geo observation ingestion.** `POST /api/territory/sync` fetches the linked user's
  research-grade observations from iNat `/observations` (with coords), computes the res5
  H3 cell per observation (`h3-js`, the first runtime dep — pure-JS asm.js, verified to
  load **and run inside workerd**), and upserts into `tile_observations` (dedupe by
  `inat_observation_id`). Obscured/private + geo-less observations are skipped.
- ✅ **Chain proven end-to-end in the real runtime:** observation lat/lng → res5 cell →
  `tile_biomes` join returns the correct biome (Amazon→forest, Sahara→desert, London→urban,
  Florida→wetland).

- ✅ **Territory map tab (Leaflet).** New **Map** tab (top tabs + mobile More sheet) renders
  a CARTO dark basemap with biome-colored H3 hexes (`GET /api/territory/tiles` →
  `polygonToCells` in the viewport + `cellToBoundary` + biome from `tile_biomes`, capped
  with a `tooMany` guard, zoom-gated at z≥6) and the user's observation markers
  (`GET /api/territory/observations`), plus a biome legend and a **Sync my observations**
  button. Verified: real Bay Area tiles render as a biome honeycomb (urban=red core,
  forest=green hills, agricultural=tan valley, freshwater=blue delta). `leaflet@1.9.4` via
  CDN; no client build step.

**Remaining to fully close Bridge 1:** an authenticated end-to-end run against live iNat
(sync → markers → owned-tile rendering).

**Bridge 2 — mechanical terrain: done & balance-checked.**

- ✅ **Terrain now affects combat.** `game.js` gained `TERRAIN_MOVE_BONUS` (each biome
  favors 2–3 of the 16 move types) and a `terrainMultiplier` (+15%, STAB-magnitude) folded
  into `estimateDamage` alongside STAB/type/bond. The NPC scorer (`scoreNpcMove`) is
  terrain-aware too, so the AI leans into favored moves. `terrain` rides in battle state
  and survives `structuredClone` across turns.
- ✅ **Terrain source (pre-Bridge-3).** `terrainForTeam()` picks the biome that best favors
  a team's types — its "home". NPC battles are fought on the **opponent's** home biome;
  challenge battles on the **defender's** (accepter's) home; the sprite-test battle is
  `neutral`. This previews the Bridge-3 rule ("attacker fights on the defender's home
  biome") before tiles drive it.
- ✅ **Surfaced in the UI.** The backdrop palette is now chosen from `battle.terrain`
  (not the combatants' types); a terrain banner names the biome and its favored types; and
  terrain-favored move buttons get a 🌿 marker + leaf glow, with the `~dmg` preview
  including the +15%.
- ✅ **Balance-checked** via `scripts/simulate.mjs` (baseline unchanged — terrain is a pure
  opt-in multiplier) plus an A/B: home terrain is a **+2.3 pt** win-rate edge and trims
  battles ~7.4→6.8 turns. Meaningful home-field advantage, not a hard counter.

**Bridge 3 — claim & contest tiles: done.** The map is now playable; the loop is closed.

- ✅ **Claim** (`POST /api/territory/claim`) — claim an **unowned** tile you have an
  observation in; your current 5-team is stored as the tile's **garrison**
  (`migrations/0016`: `tiles.defender_team_json`, `claimed_at`).
- ✅ **Contest** (`POST /api/territory/contest`) — start a **ghost battle** vs the owner's
  garrison snapshot, fought on the tile's **real biome** (the `terrain` the engine already
  consumes — Bridge 2), with `defense_strength` as a defender HP/guard buff
  (`applyTileDefenseBuff`). Reuses `loadUserBattleCreatures` + `chooseNpcAction`.
- ✅ **Resolution** — the existing battle resolver gained a hook: a finished contest with
  `state.tileH3` **flips the tile** to the attacker (re-snapshotting their team) on a win,
  or **fortifies** the defender (`defense_strength +1`, capped 5) on a loss. Validated
  against local D1 (claim → win-flip → loss-fortify, FK-guarded owner).
- ✅ **Gating (simple daily cap):** both actions require an observation in the tile and
  count against a per-user **daily action cap** (`TERRITORY_DAILY_ACTION_CAP`, default 20),
  counted from `territory_actions`. No AP currency yet — a later enhancement.
- ✅ **UI** — hexes are clickable → a **tile panel** (biome, owner, favored types, actions
  left) with **Claim** / **Contest** buttons (uses your selected 5-team); contest drops you
  into the normal battle flow, and winning flips the tile (rendered brighter as `mine`).

**Bridge 4 — held territory buffs your roster: done.** Holding land now makes you stronger.

- ✅ **Roster power.** `territoryBuffPctForBiomeCount(count)` turns your held-tile count per
  biome into a buff; `createBattleCreature` applies it (stacked with genus/family mastery,
  same all-stat multiplier) to any creature **native** to a biome you hold — i.e. whose type
  is favored there (`TERRAIN_MOVE_BONUS`). `loadUserBattleCreatures` feeds it the owner's
  holdings, so it applies in every battle (NPC, challenge, contest) for that owner's team.
- ✅ **Curve (gentle, tunable):** 1–2 tiles +3%, 3–5 +4%, 6–9 +5%, 10+ +6%. Capped low on
  purpose — it's an all-stat multiplier, so it's potent per point.
- ✅ **Balance-checked** (`scripts/simulate.mjs` baseline unchanged — buff defaults off):
  A/B shows +6% home-territory ≈ **+9.8 pt** win edge, +10% ≈ +15.6 (which is why the curve
  caps at 6%). A real reward for holding land without warping PvP.
- ✅ **Surfaced:** the tile panel shows "You hold N {biome} tiles → +X% to your {biome}-native
  species"; buffed creatures wear a 🏞️ **+X% home** chip in battle.

**The flywheel is closed:** observe → sync → claim/contest tiles on the map → **holding a
biome buffs your species native to it** → you win more territory → you covet richer biomes →
back out to observe. Remaining (future): the **ecological economy** (tile value →
yield/AP/collection) to make holding land *pay* beyond combat power, and a normalized ranked
mode so the collection edge doesn't decide competitive play.

### Cloudflare cost & scale (Workers Paid, $5/mo)

Designed to stay inside the included D1 allowances: **5 GB storage** (max 10 GB/db),
**25 B rows read/mo**, **50 M rows written/mo**.

- **`tile_biomes` — ocean + unknown dropped at import.** Of the 1.81 M global res5 tiles,
  70.4 % are ocean (the basemap already draws water) and are never queried, so only the
  **516,175 land tiles** are loaded (~3.5× smaller). Est. **~90 MB** with the PK + 2
  indexes ≈ **1.8 % of storage**; one-time **516 k writes** ≈ 1 % of the monthly write
  budget.
- **`tile_observations` (per-user).** Capped at `MAX_TERRITORY_SYNC_PAGES`×200 = **2000
  obs/user** (~500 KB/user incl. indexes) → ~**10,000 users** before storage matters.
  Each sync writes ≤2000 rows; a **120 s per-user sync cooldown** (`TERRITORY_SYNC_COOLDOWN_SECONDS`)
  + iNat's own rate limit bound write-spam → ~25 k full syncs/mo of headroom.
- **Reads per map pan** ≤ ~3000 rows (`tile_biomes` IN + `tiles` IN), zoom-gated (z≥6) and
  `tooMany`-capped → ~8 M pans/mo of headroom.
- **Auth:** all three territory endpoints require a Bluesky session; sync additionally
  requires a linked iNat account; observations are scoped to the caller's own `user_id`.

**Why not res7 globally:** 88.8 M tiles (~26 M land) ≈ 4.7 GB + 26 M one-time writes would
nearly fill the database. The res7 hyperlocal upgrade must be **lazy/regional** — load
tiles only where players actually observe — not a global bulk load.

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
