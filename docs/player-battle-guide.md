# iNat Battler Player Battle Guide

This guide explains how battles currently work in iNat Battler, from first team setup through advanced stat, type, status, and training mechanics.

## Quick Start

1. Sign in with Bluesky.
2. Verify your iNaturalist account with the temporary profile-code flow.
3. Import your iNaturalist observations.
4. Pick exactly five species with ready sprites.
5. Start an NPC battle or send a Bluesky challenge.

Only species with ready global sprites or approved/pending personal sprites can battle. Species without sprites can still appear in your roster, but they are not selectable for a battle team yet.

## Battle Formats

### NPC Battle (rated)

NPC battles played while signed in (Bluesky + linked iNaturalist) are rated. Each win or loss adjusts your **Field Score** (Elo-style, everyone starts at 1000; harder difficulties are worth more). The Leaderboard tab shows global rankings, rank titles (Sprout 🌱 up to Apex Predator 🦅), win streaks, and fastest wins — and you can post your victories and rank straight to Bluesky.

You pick five ready species and fight a computer team. The NPC has difficulty settings:

- Easy: chooses from several decent moves.
- Normal: usually chooses the best move, but sometimes chooses the second-best.
- Hard: chooses the best-scored move.

### Bluesky Challenge

Challenges are asynchronous. The challenger posts a Bluesky challenge link, the opponent accepts it, and the battle starts with the challenger team controlled by the battle AI. The challenger does not need to be online.

## Turn Flow

Each turn:

1. You choose a move or switch to a benched species.
2. The opponent chooses a move or switch.
3. Switches happen before moves.
4. Remaining moves resolve by priority, then Tempo.
5. Damage, statuses, healing, recoil, poison ticks, and fainting resolve.
6. If a species faints, the next unfainted team member auto-switches in.

Switching is tactical but risky: the incoming species takes the opponent's move that turn.

## The Five Stats

| Stat | What It Does |
|---|---|
| Vigor | Raises max HP. In battle, Vigor buffs regenerate 3% max HP per stage each turn (debuffs drain it). |
| Strike | Used for physical move damage. |
| Guard | Defends against physical moves and contributes to special defense. |
| Tempo | Determines move order after priority. Faster species move first. Tempo buffs/debuffs change turn order. |
| Sense | Used for special move damage and contributes to special defense. |

Max HP is based on Vigor plus a small bonus from observation count.

Special defense uses both Guard and Sense, so Sense-heavy species hit hard with special moves but do not get to wall special attacks by Sense alone.

## Stat Stages

Buffs and debuffs temporarily change stats during battle.

- Stages range from -4 to +4.
- Each positive stage adds 25% of the base stat.
- Each negative stage divides the stat by the same staged scale.
- Buffs affect the user.
- Debuffs affect the target.

Example: Guard +2 means the creature is substantially harder to damage with physical attacks.

## Damage Basics

Damage depends on:

- Move power.
- Physical or special category.
- Attacker's relevant attack stat.
- Defender's relevant defense stat.
- Same-type bonus.
- Type effectiveness.
- Bond-level nudge.
- Random damage variance.
- Late-battle fatigue.

Same-type bonus: if the attacker has the same type as the move, damage is multiplied by 1.15.

Fatigue: after turn 20, damage ramps upward by 6% per turn so healing and tank stalls eventually end.

Critical hits: every damaging move has an 8% chance to crit for 1.5x damage. Marked targets are easier to crit (20%).

Rally: the first time a species drops below 30% HP and survives, it rallies — +1 Strike and +1 Sense stage. One rally per species per battle, so a cornered creature always has one sharp counterpunch left.

## Move Categories

| Category | Uses |
|---|---|
| Physical | Attacker Strike vs defender Guard. |
| Special | Attacker Sense vs defender average of Guard and Sense. |
| Status | No direct damage; applies healing, buffs, shields, or other effects. |

Moves also have accuracy. A missed move does nothing that turn.

## Status Effects

| Status | Effect |
|---|---|
| Stunned | Skips the creature's next action. After a stun is consumed, the creature gets short stun immunity. |
| Marked | The next hit taken deals 25% more damage, then Marked is removed. |
| Poisoned | Takes 8% max HP damage per turn for 3 turns. |
| Shielded | Halves the next hit taken, then Shielded is removed. |

Other move effects:

- Drain: heals the attacker for a percentage of damage dealt.
- Recoil: damages the attacker after dealing damage.
- Multihit: strikes 2-3 times.
- Heal: restores a percentage of the user's max HP.

## Creature Classes

Species are assigned a body plan from their iNaturalist group and names. Body plan sets the base stat shape, common move pool, and often the role.

| Class | Typical Shape | Strengths | Weaknesses |
|---|---|---|---|
| Passerine Bird | High Tempo, good Sense | Fast, flexible, often Sky/Voice | Lower Guard; can struggle into Stone. |
| Raptor Bird | High Strike, good Tempo | Strong physical pressure | Less bulky than tanks; Stone checks Sky. |
| Waterbird | High Vigor and Guard | Durable Wetland pressure | Slower than other birds. |
| Insect | High Tempo, good Strike | Fast Swarm/Venom tricks | Fragile. |
| Moth / Butterfly | High Sense and Tempo | Special pressure, Night/Sky potential | Very low Guard and Vigor. |
| Dragonfly | Very high Tempo, high Strike | Fastest striker class | Low Guard; punished if it misses. |
| Bee / Wasp / Ant | Strike-focused Swarm/Venom | Strong damage and status pressure | Moderate bulk; type matchups matter. |
| Herbaceous Plant | High Vigor and Sense | Good support and Bloom pressure | Slow. |
| Tree / Shrub | Very high Vigor and Guard | Excellent tank, Wood/Bloom identity | Extremely slow. |
| Grass / Sedge | Vigor and Guard support | Reliable Bloom/Wetland support | Low Tempo. |
| Fern | Guard/Sense support | Defensive utility and Sunroot access | Low Tempo and Strike. |
| Fungus | Guard/Sense tank | Fungus/Decay pressure and debuffs | Very slow. |
| Mammal | Well-rounded | Flexible physical attacker | Less specialized. |
| Amphibian | Sense-focused | Wetland/Night utility | Moderate bulk and speed. |
| Reptile | High Guard and Vigor | Stone tank, strong into Sky/Venom | Slow. |
| Fish | Moderate Tempo and Wetland | Wetland pressure | Average defenses. |
| Mollusk | Very high Guard | Excellent Stone/Wetland wall | Very slow and low Strike. |
| Unknown | Balanced | No major hole | No major specialty. |

## Battle Roles

Roles are derived from body plan and types.

| Role | Usual Game Plan |
|---|---|
| Scout | Move early, exploit priority and type coverage. |
| Striker | Deal damage quickly, especially with high-power moves. |
| Tank | Absorb hits, buff Guard, win slower exchanges. |
| Support | Heal, buff, debuff, and stabilize the team. |
| Trickster | Use Night, Venom, Urban, statuses, and debuffs to disrupt. |

Roles also influence NPC move scoring. For example, striker NPCs value high-power attacks, tanks value defensive buffs, and support creatures value status moves.

## Ecological Types

Each species gets 2-3 ecological types, such as Sky, Bloom, Venom, Stone, or Wetland. Types affect both damage dealt and damage received.

Type assignment comes from:

- iNaturalist iconic group.
- Body plan.
- Common and scientific name keywords.
- Natural fallback types if too few were found.

Examples:

- Birds often get Sky.
- Plants often get Bloom.
- Fungi get Fungus and Decay.
- Bees, wasps, ants, and many insects get Swarm or Venom.
- Amphibians, fish, waterbirds, and dragonflies often get Wetland.
- Reptiles and mollusks often get Stone.

## Type Matchups

Multipliers stack across all defender types. A move can become very strong or very weak against multi-type defenders.

| Attack Type | Strong Against | Weak Into |
|---|---|---|
| Sky | Bloom x1.5, Burrow x1.5, Swarm x1.3 | Stone x0.65, Night x0.8, Voice x0.8 |
| Urban | Night x1.5, Swarm x1.3, Fungus x1.3 | Meadow x0.8, Burrow x0.65, Decay x0.8, Voice x0.65 |
| Wetland | Stone x1.5, Sun x1.3, Burrow x1.2 | Bloom x0.8, Frost x0.65 |
| Bloom | Stone x1.5, Sun x1.3, Wetland x1.2 | Venom x0.65, Sky x0.65, Frost x0.8 |
| Venom | Swarm x1.5, Bloom x1.3, Voice x1.2 | Meadow x0.65, Fungus x0.8, Stone x0.65 |
| Decay | Wood x1.5, Bloom x1.3, Urban x1.2 | Sun x0.65, Frost x0.8 |
| Fungus | Wood x1.5, Decay x1.3, Bloom x1.2 | Sun x0.65, Venom x0.8 |
| Stone | Sky x1.5, Venom x1.3, Frost x1.2 | Wetland x0.65, Fungus x0.8, Burrow x0.8 |
| Burrow | Urban x1.5, Stone x1.3, Venom x1.2 | Sky x0.65, Wetland x0.8 |
| Night | Voice x1.5, Sky x1.3, Meadow x1.2 | Sun x0.65, Urban x0.65 |
| Swarm | Meadow x1.5, Bloom x1.3, Fungus x1.3, Wetland x1.2 | Sky x0.65, Venom x0.65, Urban x0.8 |
| Sun | Fungus x1.5, Night x1.3, Decay x1.3 | Wetland x0.8, Stone x0.8 |
| Frost | Wetland x1.5, Bloom x1.3, Swarm x1.2 | Sun x0.65, Stone x0.8 |
| Wood | Sun x1.5, Urban x1.3, Stone x1.2 | Decay x0.65, Fungus x0.65 |
| Meadow | Venom x1.5, Burrow x1.3, Urban x1.2 | Swarm x0.65, Night x0.8 |
| Voice | Urban x1.5, Stone x1.3, Swarm x1.2 | Night x0.65, Sky x0.8 |

### Defensive Weaknesses

Read this table as: if your species has this type, these attack types threaten it.

| Defender Type | Weak To | Resists |
|---|---|---|
| Sky | Stone x1.5, Night x1.3 | Bloom x0.65, Burrow x0.65, Swarm x0.65, Voice x0.8 |
| Urban | Burrow x1.5, Wood x1.3, Voice x1.5, Decay x1.2, Meadow x1.2 | Night x0.65, Swarm x0.8 |
| Wetland | Frost x1.5, Bloom x1.2, Swarm x1.2 | Stone x0.65, Burrow x0.8, Sun x0.8 |
| Bloom | Sky x1.5, Venom x1.3, Decay x1.3, Fungus x1.2, Swarm x1.3, Frost x1.3 | Wetland x0.8 |
| Venom | Meadow x1.5, Stone x1.3, Burrow x1.2 | Bloom x0.65, Fungus x0.8, Swarm x0.65 |
| Decay | Fungus x1.3, Sun x1.3 | Urban x0.8, Wood x0.65 |
| Fungus | Sun x1.5, Urban x1.3, Swarm x1.3 | Venom x0.8, Stone x0.8, Wood x0.65 |
| Stone | Wetland x1.5, Bloom x1.5, Burrow x1.3, Wood x1.2, Voice x1.3 | Sky x0.65, Venom x0.65, Sun x0.8, Frost x0.8 |
| Burrow | Sky x1.5, Meadow x1.3, Wetland x1.2 | Urban x0.65, Stone x0.8 |
| Night | Urban x1.5, Sun x1.3 | Sky x0.8, Meadow x0.8, Voice x0.65 |
| Swarm | Venom x1.5, Sky x1.3, Urban x1.3, Frost x1.2, Voice x1.2 | Meadow x0.65 |
| Sun | Wood x1.5, Wetland x1.3, Bloom x1.3 | Decay x0.65, Fungus x0.65, Night x0.65, Frost x0.65 |
| Frost | Stone x1.2 | Wetland x0.65, Bloom x0.8, Decay x0.8 |
| Wood | Decay x1.5, Fungus x1.5 | None currently |
| Meadow | Swarm x1.5, Night x1.2 | Urban x0.8, Venom x0.65 |
| Voice | Night x1.5, Venom x1.2 | Sky x0.8, Urban x0.65 |

## Common Move Examples

| Move | Type | Category | Notes |
|---|---|---|---|
| Wing Flick | Sky | Physical | Priority +1, so it often moves first. |
| Sting | Venom | Physical | Can Mark the target. |
| Pollen Pulse | Bloom | Special | Lowers target Tempo. |
| Sunroot | Sun | Status | Heals the user. |
| Spore Puff | Fungus | Special | Can Stun. |
| Shell Guard | Stone | Status | Raises Guard sharply. |
| Night Feint | Night | Special | Lowers target Sense. |
| Burrow Trip | Burrow | Physical | Lowers target Tempo. |
| Chorus Call | Voice | Status | Raises user Sense. |
| Seed Volley | Meadow | Special | Reliable Meadow damage. |

## Signature Moves

Some species have generated signature moves grounded in their real natural history.

Signature move rules:

- Each species can receive two signature moves.
- Signature moves use the same 16-type chart.
- Power is clamped between 20 and 60.
- Accuracy is clamped between 75 and 100.
- Multihit moves are capped at 26 power per hit.
- Damaging status riders are capped at 30% chance.
- Pure status moves always apply their effect if the move hits.
- The server enforces a power budget so a move cannot combine huge damage, high accuracy, and a strong effect.

Species with signature dossiers also get real natural-history facts and animation directions for future sprite generations.

## Training

Training lets you personalize species after importing and syncing iNaturalist data.

Training points are earned deterministically from observation data. Research Grade observations are preferred. If iNaturalist rate-limits the Research Grade refresh, the app may use roster counts as a provisional fallback.

### Point Formula

Per species:

- Base points: `floor(2 * sqrt(training observations))`
- First-observation bonus: +5 if there is at least one training observation
- Genus spillover: +2 per other observed species in the same genus
- Family spillover: +1 per 2 other observed species in the same family
- Mastery bonuses: added when genus or family tiers are reached

Available points equal earned points minus spent points. If observations later disappear, spent points are not clawed back below zero available.

### Allocating Points

- 1 training point gives +1 to Vigor, Strike, Guard, Tempo, or Sense.
- Each stat is capped at +60% of that species' bond-scaled base stat.
- Vigor allocations also increase max HP.
- Level equals total points spent.
- You can save a nickname up to 24 characters.
- One free full respec is available per species per week.

### Mastery

Mastery rewards observing related species.

| Group | Bronze | Silver | Gold | Complete |
|---|---:|---:|---:|---|
| Genus | 3 species | 7 species | 15 species | All known species, when iNat publishes a complete count |
| Family | 5 species | 12 species | 25 species | All known species, when iNat publishes a complete count |

Mastery point bonuses:

| Group | Bronze | Silver | Gold | Complete |
|---|---:|---:|---:|---:|
| Genus | +5 | +12 | +25 | +40 |
| Family | +3 | +8 | +15 | +25 |

Permanent mastery stat buffs:

- Genus Gold: +10% stats
- Genus Complete: +15% stats
- Family Gold: +5% stats
- Family Complete: +8% stats

Genus and family buffs are additive. Mastery tiers never downgrade once achieved.

## Team Building Tips

- Bring type coverage. A five-species team should not all share the same weakness.
- Include at least one fast attacker. Tempo decides many close turns.
- Include one durable switch-in. A high-Guard or high-Vigor species can absorb a bad matchup.
- Do not ignore support. Healing, Guard buffs, Stun, Mark, and Tempo debuffs can win longer fights.
- Train favorites into roles they already want. A dragonfly usually wants Strike or Tempo; a tree usually wants Vigor or Guard; a fungus often wants Guard or Sense.
- Watch move category. A high-Strike creature wants physical moves. A high-Sense creature wants special moves.
- Use switching carefully. Switching protects the outgoing species but the incoming species still takes the opponent's move.

## Current Improvement Opportunities

These are gameplay issues or opportunities noticed while writing this guide.

### 1. Add This Guide In-App

Players need a visible Battle Guide or Help button inside the app, especially near Battle and Training. The type chart is too large to learn from memory.

Suggested implementation:

- Add a `Guide` or `?` button in the Battle tab.
- Include the type chart, status glossary, and training formulas.
- Add small tooltips for stats and move categories.

### 2. Show Why a Species Has Its Types

Type assignment is interesting but opaque. Players will ask why a species is Sky/Voice, Bloom/Sun, or Urban/Meadow.

Suggested implementation:

- Add a small "why these types?" explanation on the roster card back or details view.
- Show signals such as body plan, iconic group, and matched keywords.

### 3. Better Team Builder Support

The game has enough depth that users could benefit from team-building help.

Suggested implementation:

- Warn when a selected team has a shared weakness.
- Show team coverage: strong into / weak to.
- Recommend one ready species that covers the team's biggest weakness.

### 4. Battle Tutorial NPC

New users should not learn all mechanics from a live challenge.

Suggested implementation:

- Add a tutorial NPC with scripted examples: super-effective move, resisted move, switch, status, training.
- Reward nothing permanent; keep it safe and replayable.

### 5. Training Preview

The Training tab tells users what points do, but not how a point changes actual battle outcomes.

Suggested implementation:

- Show before/after stat and HP deltas.
- Show estimated damage change for one physical and one special move.
- Show when a stat hits its cap.

### 6. Post-Battle Learning

Battles already track damage dealt and taken. The post-battle summary could teach players what happened.

Suggested implementation:

- MVP, damage taken, clutch KO, best switch-in.
- "Your team struggled against Stone" or similar type summary.
- Link back to training or roster filters based on the result.

### 7. Progression Loop

Battles are fun, but players need a reason to keep returning besides roster completion.

Suggested implementation:

- Daily NPC challenge.
- Battle badges for winning with different groups.
- Species mastery goals surfaced from the Training tab.
- Friendly challenge history.

### 8. Sprite Readiness Clarity

Players will not always understand why a species is missing or queued.

Suggested implementation:

- Add concise states: Ready, Queued, Generating, Missing, Custom Pending, Custom Approved.
- On missing species, show "Queue sprite" or "waiting for shared library" depending on permissions.

### 9. Type Chart Balance Monitoring

The chart is improved and more legible than the early version, but it still needs ongoing simulation checks as more signature moves arrive.

Suggested implementation:

- Run the simulator after any type, move, or stat formula change.
- Track per-type win rates, average turns, stun rate, and move knockout share.
- Watch for Wood having no resistances and Frost being relatively rare from current type-assignment rules.

