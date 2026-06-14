const DEFAULT_STATS = {
  passerine_bird: { vigor: 42, strike: 42, guard: 34, tempo: 68, sense: 52 },
  raptor_bird: { vigor: 52, strike: 55, guard: 42, tempo: 56, sense: 50 },
  waterbird: { vigor: 58, strike: 48, guard: 52, tempo: 44, sense: 48 },
  insect: { vigor: 34, strike: 46, guard: 32, tempo: 66, sense: 48 },
  moth_butterfly: { vigor: 32, strike: 34, guard: 28, tempo: 60, sense: 66 },
  dragonfly: { vigor: 38, strike: 64, guard: 34, tempo: 82, sense: 56 },
  bee_wasp_ant: { vigor: 36, strike: 58, guard: 38, tempo: 62, sense: 52 },
  plant_herb: { vigor: 60, strike: 42, guard: 52, tempo: 24, sense: 64 },
  tree_shrub: { vigor: 68, strike: 42, guard: 58, tempo: 16, sense: 52 },
  grass_sedge: { vigor: 60, strike: 44, guard: 52, tempo: 32, sense: 58 },
  fern: { vigor: 60, strike: 42, guard: 52, tempo: 28, sense: 64 },
  fungus: { vigor: 50, strike: 38, guard: 46, tempo: 18, sense: 53 },
  mammal: { vigor: 58, strike: 52, guard: 46, tempo: 58, sense: 50 },
  amphibian: { vigor: 50, strike: 46, guard: 40, tempo: 48, sense: 62 },
  reptile: { vigor: 56, strike: 48, guard: 54, tempo: 38, sense: 46 },
  fish: { vigor: 48, strike: 46, guard: 40, tempo: 58, sense: 48 },
  mollusk: { vigor: 54, strike: 34, guard: 72, tempo: 18, sense: 44 },
  unknown: { vigor: 56, strike: 56, guard: 50, tempo: 58, sense: 56 }
};

// Shared-pool mana: gates move usage. Full each battle (creatures are built
// fresh), +1 to every non-fainted creature each turn (active and benched, so a
// drained creature can swap out and regen). Costs derive from move power.
const MAX_MANA = 25;
const MANA_REGEN_PER_TURN = 1;

const STRUGGLE_MOVE = {
  id: "struggle",
  name: "Struggle",
  type: "Normal",
  category: "physical",
  power: 15,
  accuracy: 100,
  effect: { kind: "recoil", pct: 25 },
  description: "A desperate last-resort attack with recoil — costs no mana."
};

export function moveManaCost(move) {
  if (!move || move.id === "struggle") return 0;
  if (move.category === "status") return 3;
  const base = Math.round((Number(move.power) || 0) / 10);
  let cost = Math.max(2, Math.min(6, base));
  if (move.effect && move.effect.kind === "multihit") cost += 1;
  return cost;
}

function regenMana(team) {
  for (const creature of team.creatures) {
    if (creature.fainted) continue;
    creature.mana = Math.min(creature.maxMana ?? MAX_MANA, (creature.mana ?? 0) + MANA_REGEN_PER_TURN);
  }
}

const MOVE_LIBRARY = {
  jab: { id: "jab", name: "Jab", type: "Urban", category: "physical", power: 28, accuracy: 96, description: "A quick close-range strike." },
  peck: { id: "peck", name: "Peck", type: "Sky", category: "physical", power: 34, accuracy: 95, description: "A sharp beak jab." },
  wing_flick: { id: "wing_flick", name: "Wing Flick", type: "Sky", category: "physical", power: 26, accuracy: 92, priority: 1, description: "A fast wing-assisted strike." },
  crumb_rush: { id: "crumb_rush", name: "Crumb Rush", type: "Urban", category: "physical", power: 42, accuracy: 90, description: "A scrappy urban dash attack." },
  flock_burst: { id: "flock_burst", name: "Flock Burst", type: "Swarm", category: "special", power: 42, accuracy: 88, effect: { kind: "debuff", stat: "sense", amount: 1 }, description: "A confusing burst of echoing wings." },
  dust_bath: { id: "dust_bath", name: "Dust Bath", type: "Urban", category: "status", power: 0, accuracy: 100, effect: { kind: "buff", stat: "guard", amount: 1 }, description: "Raises Guard with a gritty dust cloud." },
  sting: { id: "sting", name: "Sting", type: "Venom", category: "physical", power: 40, accuracy: 92, effect: { kind: "status", status: "marked", chance: 25 }, description: "A venom-touched strike." },
  pollen_pulse: { id: "pollen_pulse", name: "Pollen Pulse", type: "Bloom", category: "special", power: 36, accuracy: 95, effect: { kind: "debuff", stat: "tempo", amount: 1 }, description: "A soft burst of pollen slows the target." },
  vine_lash: { id: "vine_lash", name: "Vine Lash", type: "Bloom", category: "physical", power: 42, accuracy: 90, description: "A flexible plant strike." },
  sunroot: { id: "sunroot", name: "Sunroot", type: "Sun", category: "status", power: 0, accuracy: 100, effect: { kind: "heal", amountPct: 18 }, description: "Recovers a little HP in sunlight." },
  spore_puff: { id: "spore_puff", name: "Spore Puff", type: "Fungus", category: "special", power: 34, accuracy: 92, effect: { kind: "status", status: "stunned", chance: 18 }, description: "A puff of spores may stun." },
  heartrot: { id: "heartrot", name: "Heartrot", type: "Decay", category: "special", power: 40, accuracy: 86, effect: { kind: "debuff", stat: "guard", amount: 1 }, description: "Decay magic that weakens defenses." },
  shell_guard: { id: "shell_guard", name: "Shell Guard", type: "Stone", category: "status", power: 0, accuracy: 100, effect: { kind: "buff", stat: "guard", amount: 2 }, description: "Raises Guard sharply." },
  stone_bump: { id: "stone_bump", name: "Stone Bump", type: "Stone", category: "physical", power: 40, accuracy: 92, description: "A heavy, grounded hit." },
  night_feint: { id: "night_feint", name: "Night Feint", type: "Night", category: "special", power: 40, accuracy: 92, effect: { kind: "debuff", stat: "sense", amount: 1 }, description: "A shadowy misdirection." },
  wetland_surge: { id: "wetland_surge", name: "Wetland Surge", type: "Wetland", category: "special", power: 42, accuracy: 90, description: "A rush of marsh energy." },
  burrow_trip: { id: "burrow_trip", name: "Burrow Trip", type: "Burrow", category: "physical", power: 36, accuracy: 94, effect: { kind: "debuff", stat: "tempo", amount: 1 }, description: "A low strike that slows the foe." },
  chorus_call: { id: "chorus_call", name: "Chorus Call", type: "Voice", category: "status", power: 0, accuracy: 100, effect: { kind: "buff", stat: "sense", amount: 1 }, description: "A call that focuses the team spirit." },
  seed_volley: { id: "seed_volley", name: "Seed Volley", type: "Meadow", category: "special", power: 40, accuracy: 92, description: "A scattering burst of hard seeds." }
};

const BODY_MOVES = {
  passerine_bird: ["peck", "wing_flick", "flock_burst", "chorus_call"],
  raptor_bird: ["peck", "wing_flick", "night_feint", "flock_burst"],
  waterbird: ["peck", "wetland_surge", "wing_flick", "chorus_call"],
  insect: ["jab", "sting", "flock_burst", "pollen_pulse"],
  moth_butterfly: ["pollen_pulse", "wing_flick", "night_feint", "flock_burst"],
  dragonfly: ["wing_flick", "wetland_surge", "jab", "night_feint"],
  bee_wasp_ant: ["sting", "pollen_pulse", "jab", "flock_burst"],
  plant_herb: ["vine_lash", "seed_volley", "sunroot", "pollen_pulse"],
  tree_shrub: ["vine_lash", "sunroot", "shell_guard", "heartrot"],
  grass_sedge: ["vine_lash", "seed_volley", "wetland_surge", "sunroot"],
  fern: ["vine_lash", "night_feint", "sunroot", "dust_bath"],
  fungus: ["spore_puff", "heartrot", "night_feint", "shell_guard"],
  mammal: ["jab", "burrow_trip", "dust_bath", "crumb_rush"],
  amphibian: ["wetland_surge", "night_feint", "burrow_trip", "jab"],
  reptile: ["stone_bump", "burrow_trip", "shell_guard", "sunroot"],
  fish: ["wetland_surge", "jab", "night_feint", "burrow_trip"],
  mollusk: ["shell_guard", "wetland_surge", "stone_bump", "night_feint"],
  unknown: ["jab", "dust_bath", "night_feint", "chorus_call"]
};

const TYPE_MOVES = {
  Sky: ["wing_flick", "peck"],
  Urban: ["crumb_rush", "dust_bath"],
  Wetland: ["wetland_surge"],
  Bloom: ["pollen_pulse", "vine_lash"],
  Venom: ["sting"],
  Decay: ["heartrot"],
  Fungus: ["spore_puff"],
  Stone: ["stone_bump", "shell_guard"],
  Burrow: ["burrow_trip"],
  Night: ["night_feint"],
  Swarm: ["flock_burst"],
  Sun: ["sunroot"],
  Frost: ["night_feint"],
  Wood: ["vine_lash"],
  Meadow: ["seed_volley", "pollen_pulse"],
  Voice: ["chorus_call"]
};

const ROLE_MOVES = {
  scout: ["wing_flick", "crumb_rush"],
  striker: ["sting", "stone_bump", "heartrot"],
  tank: ["shell_guard", "stone_bump"],
  support: ["chorus_call", "sunroot", "pollen_pulse"],
  trickster: ["night_feint", "dust_bath", "burrow_trip"]
};

// Attacker-keyed multipliers: TYPE_CHART[attackType][defenderType].
// Built around teachable triangles (strong 1.5 / resisted 0.65, mids 1.3/0.8):
//   Sky > Bloom > Stone > Sky
//   Sun > Fungus > Wood > Sun
//   Venom > Swarm > Meadow > Venom
//   Night > Voice > Urban > Night
//   Sky > Burrow > Urban  (and Burrow hides from Sky? no - Sky dives on Burrow)
//   Wetland > Stone, Sun > Wetland-ish via Bloom
// Every type keeps at least one 1.3+ attack and at least one type that hits
// it for 1.3+. No mutual super-effective pairs (audited by scripts/simulate.mjs).
const TYPE_CHART = {
  Sky: { Bloom: 1.5, Burrow: 1.5, Swarm: 1.3, Stone: 0.65, Night: 0.8, Voice: 0.8 },
  Urban: { Night: 1.5, Swarm: 1.3, Fungus: 1.3, Meadow: 0.8, Burrow: 0.65, Decay: 0.8, Voice: 0.65 },
  Wetland: { Stone: 1.5, Sun: 1.3, Burrow: 1.2, Bloom: 0.8, Frost: 0.65 },
  Bloom: { Stone: 1.5, Sun: 1.3, Wetland: 1.2, Venom: 0.65, Sky: 0.65, Frost: 0.8 },
  Venom: { Swarm: 1.5, Bloom: 1.3, Voice: 1.2, Meadow: 0.65, Fungus: 0.8, Stone: 0.65 },
  Decay: { Wood: 1.5, Bloom: 1.3, Urban: 1.2, Sun: 0.65, Frost: 0.8 },
  Fungus: { Wood: 1.5, Decay: 1.3, Bloom: 1.2, Sun: 0.65, Venom: 0.8 },
  Stone: { Sky: 1.5, Venom: 1.3, Frost: 1.2, Wetland: 0.65, Fungus: 0.8, Burrow: 0.8 },
  Burrow: { Urban: 1.5, Stone: 1.3, Venom: 1.2, Sky: 0.65, Wetland: 0.8 },
  Night: { Voice: 1.5, Sky: 1.3, Meadow: 1.2, Sun: 0.65, Urban: 0.65 },
  Swarm: { Meadow: 1.5, Bloom: 1.3, Fungus: 1.3, Wetland: 1.2, Sky: 0.65, Venom: 0.65, Urban: 0.8 },
  Sun: { Fungus: 1.5, Night: 1.3, Decay: 1.3, Wetland: 0.8, Stone: 0.8 },
  Frost: { Wetland: 1.5, Bloom: 1.3, Swarm: 1.2, Sun: 0.65, Stone: 0.8 },
  Wood: { Sun: 1.5, Urban: 1.3, Stone: 1.2, Decay: 0.65, Fungus: 0.65 },
  Meadow: { Venom: 1.5, Burrow: 1.3, Urban: 1.2, Swarm: 0.65, Night: 0.8 },
  Voice: { Urban: 1.5, Stone: 1.3, Swarm: 1.2, Night: 0.65, Sky: 0.8 }
};

const NPC_TAXA = {
  backyard_beginner: [
    { taxonId: 13858, commonName: "House Sparrow", scientificName: "Passer domesticus", iconicTaxonName: "Aves", obsCount: 12, bondLevel: 10 },
    { taxonId: 47602, commonName: "Common Dandelion", scientificName: "Taraxacum officinale", iconicTaxonName: "Plantae", obsCount: 7, bondLevel: 8 },
    { taxonId: 46011, commonName: "Eastern Gray Squirrel", scientificName: "Sciurus carolinensis", iconicTaxonName: "Mammalia", obsCount: 9, bondLevel: 9 }
  ],
  wetland_watcher: [
    { taxonId: 67731, commonName: "Common Green Darner", scientificName: "Anax junius", iconicTaxonName: "Insecta", obsCount: 10, bondLevel: 10 },
    { taxonId: 5011, commonName: "Red-winged Blackbird", scientificName: "Agelaius phoeniceus", iconicTaxonName: "Aves", obsCount: 8, bondLevel: 9 },
    { taxonId: 52845, commonName: "Broadleaf Cattail", scientificName: "Typha latifolia", iconicTaxonName: "Plantae", obsCount: 6, bondLevel: 8 }
  ],
  rotwood_mycologist: [
    { taxonId: 48431, commonName: "Chicken of the Woods", scientificName: "Laetiporus sulphureus", iconicTaxonName: "Fungi", obsCount: 8, bondLevel: 9 },
    { taxonId: 54177, commonName: "Turkey-tail", scientificName: "Trametes versicolor", iconicTaxonName: "Fungi", obsCount: 8, bondLevel: 9 },
    { taxonId: 27723, commonName: "Eastern Red-backed Salamander", scientificName: "Plethodon cinereus", iconicTaxonName: "Amphibia", obsCount: 7, bondLevel: 8 }
  ]
};

export function createGenome(taxon) {
  const bodyPlan = inferBodyPlan(taxon);
  const types = inferTypes(taxon, bodyPlan);
  const role = inferRole(bodyPlan, types);
  const baseStats = { ...DEFAULT_STATS[bodyPlan] };
  const moves = chooseMoves(bodyPlan, types, role, taxon.bondLevel ?? 0);
  const prompts = buildSpritePrompt(taxon, bodyPlan, types, role);

  return {
    taxonId: taxon.taxonId,
    scientificName: taxon.scientificName,
    commonName: taxon.commonName,
    bodyPlan,
    types,
    role,
    baseStats,
    moves,
    prompt: prompts.prompt,
    negativePrompt: prompts.negativePrompt,
    genomeVersion: 1
  };
}

export const MOVE_TYPES = Object.keys(TYPE_CHART);
export { TYPE_CHART, TERRAIN_MOVE_BONUS };

export function createBattleCreature(taxon, instanceSuffix = "a", training = null, speciesMoves = null, territoryBuffByBiome = null) {
  const genome = createGenome(taxon);
  const bondLevel = taxon.bondLevel ?? 0;
  const obsCount = taxon.obsCount ?? 0;
  const bondScale = Math.min(0.24, bondLevel * 0.008);
  const stats = {
    vigor: Math.round(genome.baseStats.vigor * (1 + bondScale)),
    strike: Math.round(genome.baseStats.strike * (1 + bondScale * 0.75)),
    guard: Math.round(genome.baseStats.guard * (1 + bondScale * 0.75)),
    tempo: Math.round(genome.baseStats.tempo * (1 + bondScale * 0.5)),
    sense: Math.round(genome.baseStats.sense * (1 + bondScale * 0.75))
  };

  // Manual training: allocated points add to the bond-scaled base, then
  // genus/family mastery buffs multiply the result.
  const allocations = training?.allocations ?? null;
  const buffPct = Number(training?.buffPct ?? 0);
  // Held-territory roster power stacks additively with genus/family mastery.
  const territoryBuffPct = territoryBuffForTypes(genome.types, territoryBuffByBiome);
  const totalBuffPct = buffPct + territoryBuffPct;
  for (const stat of Object.keys(stats)) {
    if (allocations && Number.isFinite(allocations[stat])) {
      stats[stat] += Math.max(0, Math.floor(allocations[stat]));
    }
    if (totalBuffPct > 0) {
      stats[stat] = Math.round(stats[stat] * (1 + totalBuffPct));
    }
  }

  const maxHp = Math.round(45 + stats.vigor * 1.4 + Math.min(20, Math.sqrt(obsCount) * 2));
  const speciesName = taxon.commonName || taxon.scientificName;
  const nickname = training?.nickname ?? null;

  return {
    instanceId: `${taxon.taxonId}-${instanceSuffix}`,
    taxonId: taxon.taxonId,
    name: nickname || speciesName,
    speciesName,
    nickname,
    trainingLevel: Math.max(0, Math.floor(Number(training?.level ?? 0))),
    trainingBuffPct: buffPct,
    territoryBuffPct,
    scientificName: taxon.scientificName,
    bodyPlan: genome.bodyPlan,
    types: genome.types,
    role: genome.role,
    maxHp,
    hp: maxHp,
    maxMana: MAX_MANA,
    mana: MAX_MANA,
    stats,
    statStages: {},
    moves: Array.isArray(speciesMoves) && speciesMoves.length === 4 ? speciesMoves : genome.moves,
    bondLevel,
    fainted: false,
    statuses: [],
    spriteUrl: taxon.spriteUrl ?? null
  };
}

export function createNpcTeam(template = "backyard_beginner") {
  const taxa = NPC_TAXA[template] ?? NPC_TAXA.backyard_beginner;

  return {
    name: template.split("_").map((word) => word[0].toUpperCase() + word.slice(1)).join(" "),
    activeIndex: 0,
    creatures: taxa.map((taxon, index) => createBattleCreature(taxon, `npc-${index}`))
  };
}

export function createSeededRng(seedString) {
  let hash = 2166136261;
  for (let index = 0; index < seedString.length; index += 1) {
    hash ^= seedString.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return function rng() {
    hash += 0x6d2b79f5;
    let value = hash;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

export function chooseNpcMove(state, difficulty, rng) {
  const npc = getActive(state.opponent);
  const target = getActive(state.player);
  // Only consider moves the creature can currently afford; if none, Struggle.
  const legal = npc.moves.filter((move) => (npc.mana ?? 0) >= moveManaCost(move));
  if (legal.length === 0) return "struggle";

  if (difficulty === "random") {
    return legal[Math.floor(rng() * legal.length)].id;
  }

  const scored = legal.map((move) => ({
    move,
    score: scoreNpcMove(npc, target, move, difficulty, rng, state.terrain)
  }));
  scored.sort((left, right) => right.score - left.score);

  if (difficulty === "easy") {
    const top = scored.slice(0, Math.min(3, scored.length));
    return top[Math.floor(rng() * top.length)].move.id;
  }

  if (difficulty === "normal") {
    const top = scored.slice(0, Math.min(2, scored.length));
    return (rng() < 0.8 ? top[0] : top[top.length - 1]).move.id;
  }

  return scored[0].move.id;
}

function performSwitch(state, team, index, label) {
  const target = team.creatures[index];
  if (!target || target.fainted || index === team.activeIndex) return false;

  const outgoing = getActive(team);
  team.activeIndex = index;
  team.lastSwitchTurn = state.turn;
  state.log.push({
    turn: state.turn,
    text: `${label} withdrew ${outgoing.name} and sent in ${target.name}.`
  });
  return true;
}

// Move-or-switch decision for the NPC side. Switches when the active
// creature has no decent type matchup and a benched one does, with a
// cooldown so the AI can't switch-stall.
export function chooseNpcAction(state, difficulty, rng) {
  const team = state.opponent;
  const active = getActive(team);
  const target = getActive(state.player);

  const bestOffense = (creature) => {
    const options = creature.moves
      .filter((move) => move.category !== "status")
      .map((move) => getTypeMultiplier(move.type, target.types));
    return options.length ? Math.max(...options) : 0;
  };

  const bench = team.creatures
    .map((creature, index) => ({ creature, index }))
    .filter(({ creature, index }) => !creature.fainted && index !== team.activeIndex);

  const cooledDown = (team.lastSwitchTurn ?? -10) <= state.turn - 4;
  if (bench.length > 0 && difficulty !== "random" && difficulty !== "easy" && cooledDown) {
    const activeBest = bestOffense(active);
    if (activeBest <= 0.8 && active.hp > active.maxHp * 0.25) {
      const candidate = bench
        .map((entry) => ({ ...entry, mult: bestOffense(entry.creature) }))
        .sort((left, right) => right.mult - left.mult)[0];
      if (candidate && candidate.mult >= 1.2) {
        return { kind: "switch", index: candidate.index };
      }
    }
  }

  return { kind: "move", moveId: chooseNpcMove(state, difficulty, rng) };
}

export function resolveTurn(state, playerAction, npcAction, rng) {
  const next = structuredClone(state);

  // Switches resolve before any move; the incoming creature eats this
  // turn's attack. That is the cost of playing around a bad matchup.
  if (playerAction?.kind === "switch") {
    performSwitch(next, next.player, Number(playerAction.index), next.player.name || "Player");
  }
  if (npcAction?.kind === "switch") {
    performSwitch(next, next.opponent, Number(npcAction.index), next.opponent.name || "Opponent");
  }

  const playerCreature = getActive(next.player);
  const npcCreature = getActive(next.opponent);
  const actions = [
    { actor: playerCreature, target: npcCreature, action: playerAction },
    { actor: npcCreature, target: playerCreature, action: npcAction }
  ].filter((item) => item.action?.kind !== "switch");

  actions.sort((left, right) => {
    const moveLeft = left.actor.moves.find((move) => move.id === left.action.moveId);
    const moveRight = right.actor.moves.find((move) => move.id === right.action.moveId);
    const priorityDiff = (moveRight?.priority ?? 0) - (moveLeft?.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    // Staged tempo, not raw: tempo buffs/debuffs must actually change turn order.
    const tempoLeft = stagedStat(left.actor.stats.tempo, left.actor.statStages.tempo ?? 0);
    const tempoRight = stagedStat(right.actor.stats.tempo, right.actor.statStages.tempo ?? 0);
    if (tempoLeft !== tempoRight) return tempoRight - tempoLeft;
    return rng() < 0.5 ? -1 : 1;
  });

  for (const item of actions) {
    if (item.actor.fainted || item.target.fainted) continue;

    if (hasStatus(item.actor, "stunned")) {
      removeStatus(item.actor, "stunned");
      const meta = item.actor.statusMeta ?? (item.actor.statusMeta = {});
      meta.stunImmuneUntilTurn = next.turn + 2;
      next.log.push({ turn: next.turn, text: `${item.actor.name} is stunned and cannot move.` });
      continue;
    }

    let move = item.action.moveId === "struggle"
      ? STRUGGLE_MOVE
      : item.actor.moves.find((candidate) => candidate.id === item.action.moveId);
    if (!move) continue;

    // Shared mana pool: if the chosen move is unaffordable, the creature
    // Struggles instead. Mana is then deducted for whatever actually runs.
    if (move.id !== "struggle" && (item.actor.mana ?? 0) < moveManaCost(move)) {
      next.log.push({ turn: next.turn, text: `${item.actor.name} is out of mana and struggles!` });
      move = STRUGGLE_MOVE;
    }
    item.actor.mana = Math.max(0, (item.actor.mana ?? 0) - moveManaCost(move));

    applyMove(next, item.actor, item.target, move, rng);

    for (const combatant of [item.target, item.actor]) {
      if (!combatant.fainted && combatant.hp <= 0) {
        combatant.hp = 0;
        combatant.fainted = true;
        next.log.push({ turn: next.turn, text: `${combatant.name} fainted.` });
      }
    }
  }

  applyPoisonTicks(next, [playerCreature, npcCreature]);
  applyVigorTicks(next, [playerCreature, npcCreature]);

  autoSwitch(next.player);
  autoSwitch(next.opponent);
  next.status = getBattleStatus(next);
  // +1 mana to every non-fainted creature on both teams (active and benched).
  regenMana(next.player);
  regenMana(next.opponent);
  next.turn += 1;
  return next;
}

export function hasStatus(creature, status) {
  return Array.isArray(creature.statuses) && creature.statuses.includes(status);
}

function removeStatus(creature, status) {
  if (!Array.isArray(creature.statuses)) return;
  const index = creature.statuses.indexOf(status);
  if (index >= 0) creature.statuses.splice(index, 1);
}

// Comeback mechanic: the first time a creature is knocked below 30% HP and
// survives, it rallies — +1 Strike and +1 Sense stage. One shot per creature
// per battle, so being behind always leaves one sharp counterpunch.
function applyRally(state, creature) {
  if (creature.rallied || creature.fainted || creature.hp <= 0) return;
  if (creature.hp > creature.maxHp * 0.3) return;

  creature.rallied = true;
  creature.statStages.strike = Math.min(4, (creature.statStages.strike ?? 0) + 1);
  creature.statStages.sense = Math.min(4, (creature.statStages.sense ?? 0) + 1);
  state.log.push({
    turn: state.turn,
    text: `${creature.name} is cornered and rallies with wild resolve!`,
    data: { rally: true }
  });
}

// Vigor stages were previously inert (vigor is only read at creature
// creation). Now they tick at end of turn: +3% max HP regen per positive
// stage, -3% drain per negative stage.
function applyVigorTicks(state, creatures) {
  for (const creature of creatures) {
    if (creature.fainted) continue;
    const stage = creature.statStages?.vigor ?? 0;
    if (!stage) continue;

    const amount = Math.max(1, Math.floor(creature.maxHp * 0.03 * Math.abs(stage)));
    if (stage > 0) {
      const healed = Math.min(amount, creature.maxHp - creature.hp);
      if (healed <= 0) continue;
      creature.hp += healed;
      state.log.push({ turn: state.turn, text: `${creature.name}'s vigor restores ${healed} HP.` });
    } else {
      creature.hp -= amount;
      state.log.push({ turn: state.turn, text: `${creature.name}'s sapped vigor drains ${amount} HP.` });
      if (creature.hp <= 0) {
        creature.hp = 0;
        creature.fainted = true;
        state.log.push({ turn: state.turn, text: `${creature.name} fainted.` });
      }
    }
  }
}

function applyPoisonTicks(state, creatures) {
  for (const creature of creatures) {
    if (creature.fainted || !hasStatus(creature, "poisoned")) continue;

    const meta = creature.statusMeta ?? (creature.statusMeta = {});
    const turnsLeft = Number.isFinite(meta.poisonedTurns) ? meta.poisonedTurns : 3;
    const damage = Math.max(1, Math.floor(creature.maxHp * 0.08));

    creature.hp -= damage;
    state.log.push({
      turn: state.turn,
      text: `${creature.name} is hurt by poison and loses ${damage} HP.`
    });

    meta.poisonedTurns = turnsLeft - 1;
    if (meta.poisonedTurns <= 0) {
      removeStatus(creature, "poisoned");
      state.log.push({ turn: state.turn, text: `${creature.name} shook off the poison.` });
    }

    if (creature.hp <= 0) {
      creature.hp = 0;
      creature.fainted = true;
      state.log.push({ turn: state.turn, text: `${creature.name} fainted.` });
    }
  }
}

export function getActive(team) {
  return team.creatures[team.activeIndex];
}

function inferBodyPlan(taxon) {
  const iconic = String(taxon.iconicTaxonName ?? "").toLowerCase();
  const name = `${taxon.commonName ?? ""} ${taxon.scientificName ?? ""}`.toLowerCase();

  if (iconic.includes("aves") || iconic.includes("bird")) {
    if (/hawk|eagle|falcon|owl|raptor|vulture/.test(name)) return "raptor_bird";
    if (/duck|goose|swan|heron|egret|gull|tern|shorebird|sandpiper|plover|rail|coot/.test(name)) return "waterbird";
    return "passerine_bird";
  }
  if (iconic.includes("insect")) {
    if (/moth|butterfly|skipper/.test(name)) return "moth_butterfly";
    if (/dragonfly|damselfly|darner/.test(name)) return "dragonfly";
    if (/bee|wasp|ant|hornet|yellowjacket/.test(name)) return "bee_wasp_ant";
    return "insect";
  }
  if (iconic.includes("plantae") || iconic.includes("plant")) {
    if (/oak|maple|pine|spruce|birch|tree|shrub|willow|cedar/.test(name)) return "tree_shrub";
    if (/grass|sedge|rush|carex|juncus/.test(name)) return "grass_sedge";
    if (/fern|polypody|bracken/.test(name)) return "fern";
    return "plant_herb";
  }
  if (iconic.includes("fungi") || /mushroom|fungus|lichen|mold|polypore|bracket/.test(name)) return "fungus";
  if (iconic.includes("mammalia") || iconic.includes("mammal")) return "mammal";
  if (iconic.includes("amphibia") || /frog|toad|salamander|newt/.test(name)) return "amphibian";
  if (iconic.includes("reptilia") || /snake|lizard|turtle|skink/.test(name)) return "reptile";
  if (iconic.includes("actinopterygii") || /fish|trout|bass|minnow|sunfish/.test(name)) return "fish";
  if (iconic.includes("mollusca") || /snail|slug|clam|mussel/.test(name)) return "mollusk";
  return "unknown";
}

function inferTypes(taxon, bodyPlan) {
  const name = `${taxon.commonName ?? ""} ${taxon.scientificName ?? ""}`.toLowerCase();
  const types = [];
  const add = (type) => {
    if (!types.includes(type)) types.push(type);
  };

  if (["passerine_bird", "raptor_bird", "waterbird", "dragonfly", "moth_butterfly"].includes(bodyPlan)) add("Sky");
  if (["plant_herb", "tree_shrub", "grass_sedge", "fern"].includes(bodyPlan)) add("Bloom");
  if (bodyPlan === "fungus") {
    add("Fungus");
    add("Decay");
  }
  if (["bee_wasp_ant", "insect"].includes(bodyPlan)) add("Swarm");
  if (["amphibian", "waterbird", "dragonfly", "fish"].includes(bodyPlan)) add("Wetland");
  if (["reptile", "mollusk"].includes(bodyPlan)) add("Stone");
  if (bodyPlan === "tree_shrub") add("Wood");

  // Word boundaries matter: bare substrings mistype species (e.g. Buteo
  // jama-ICE-nsis would become Frost, "aster" hides inside many epithets).
  if (/\b(urban|house|city|pavement|sidewalk|rock pigeon|starling|sparrow|dandelion|squirrel|rat|mouse)\b/.test(name)) add("Urban");
  if (/\b(venom|venomous|poison|poisonous|stinging|nettles?|wasp|bee|snake|milkweed)\b/.test(name)) add("Venom");
  if (/\b(night|nocturnal|owl|bat|moth|moon)\b/.test(name)) add("Night");
  if (/\b(sun|sunflower|daisy|goldenrod|aster|meadow|prairie|clover)\b/.test(name)) add("Sun");
  if (/\b(swarm|flock|ant|bee|wasp|termite|sparrow|starling|blackbird)\b/.test(name)) add("Swarm");
  if (/\b(burrow|burrowing|groundhog|mole|chipmunk|rabbit|toad|salamander)\b/.test(name)) add("Burrow");
  if (/\b(frost|snow|snowy|winter|ice)\b/.test(name)) add("Frost");
  if (/\b(warbler|sparrow|robin|thrush|wren|oriole|blackbird|starling|frog|toad)\b/.test(name)) add("Voice");

  for (const fallback of [bodyPlan === "unknown" ? "Meadow" : "Urban", "Meadow", "Sky"]) {
    if (types.length >= 2) break;
    add(fallback);
  }

  while (types.length < 2) {
    types.push(types.length === 0 ? "Meadow" : "Urban");
  }

  return types.slice(0, 3);
}

function inferRole(bodyPlan, types) {
  if (["raptor_bird", "dragonfly", "bee_wasp_ant"].includes(bodyPlan)) return "striker";
  if (["tree_shrub", "fungus", "reptile", "mollusk"].includes(bodyPlan)) return "tank";
  if (["plant_herb", "grass_sedge", "fern"].includes(bodyPlan)) return "support";
  if (types.includes("Night") || types.includes("Venom") || types.includes("Urban")) return "trickster";
  return "scout";
}

function chooseMoves(bodyPlan, types, role, bondLevel = 0) {
  const ids = [];
  ids.push(...(BODY_MOVES[bodyPlan] ?? BODY_MOVES.unknown));

  for (const type of types) {
    ids.push(...(TYPE_MOVES[type] ?? []));
  }

  ids.push(...ROLE_MOVES[role]);
  if (bondLevel >= 10) ids.push("flock_burst", "heartrot", "sunroot");

  const unique = Array.from(new Set(ids)).filter((id) => MOVE_LIBRARY[id]);
  while (unique.length < 4) unique.push("jab");

  return unique.slice(0, 4).map((id) => MOVE_LIBRARY[id]);
}

function buildSpritePrompt(taxon, bodyPlan, types, role) {
  const common = taxon.commonName || taxon.scientificName;
  const prompt = `Create a single clean 4x4 sprite sheet image for an original biodiversity creature-battler game. Subject: a stylized field-spirit battler based on ${common} (${taxon.scientificName}). Body plan: ${bodyPlan}. Ecological types: ${types.join(" / ")}. Battle role: ${role}. Preserve the real species identity and recognizable field marks; use a readable silhouette, limited palette, clean outlines, charming but battle-ready expression, and consistent proportions. Sprite sheet layout: 16 total frames in equal-sized cells; row 1 idle animation, row 2 movement loop, row 3 basic attack, row 4 special ecological attack. Crisp pixel art, plain light neutral opaque background, no scenery, no UI, no labels. Do not imitate any copyrighted monster franchise or existing character.`;
  const negativePrompt = "No text, labels, logos, UI, scenery, complex background, extra unrelated creatures, humans, copyrighted monster-franchise style, messy grid, inconsistent proportions, cropped sprites, blurry pixels, photorealism, malformed anatomy, random fantasy traits that erase species identity.";

  return { prompt, negativePrompt };
}

function getTypeMultiplier(attackingType, defenderTypes) {
  return defenderTypes.reduce((multiplier, defenderType) => {
    return multiplier * (TYPE_CHART[attackingType]?.[defenderType] ?? 1);
  }, 1);
}

function stagedStat(base, stage = 0) {
  const clamped = Math.max(-4, Math.min(4, stage));
  if (clamped >= 0) return base * (1 + clamped * 0.25);
  return base / (1 + Math.abs(clamped) * 0.25);
}

// Global damage scale: tuned with scripts/simulate.mjs so 1v1 duels average
// roughly 6-10 turns instead of 2-3 (statuses and stat stages need time to
// matter).
const DAMAGE_SCALE = 0.6;

// --- Terrain (Biome merge, Bridge 2) ------------------------------------
// A battle is fought on a tile's biome. Moves whose type suits the terrain hit
// harder (STAB-magnitude, so it adds texture without becoming a hard counter).
// Keys match tile_biomes.biome_type; "neutral" (ocean/unknown/unset) buffs
// nothing.
const TERRAIN_MOVE_BONUS = {
  forest: ["Wood", "Fungus", "Decay"],
  woodland: ["Wood", "Bloom", "Meadow"],
  grassland: ["Meadow", "Sun", "Swarm"],
  agricultural: ["Meadow", "Sun", "Bloom"],
  shrubland: ["Bloom", "Meadow", "Stone"],
  urban: ["Urban", "Night", "Voice"],
  desert: ["Stone", "Sun", "Burrow"],
  polar: ["Frost", "Stone"],
  freshwater: ["Wetland", "Frost", "Swarm"],
  wetland: ["Wetland", "Swarm", "Bloom"],
  tundra: ["Frost", "Fungus", "Burrow"]
};
const TERRAIN_DAMAGE_BONUS = 1.15;

function terrainMultiplier(move, terrain) {
  if (!move || !terrain || terrain === "neutral") return 1;
  const boosted = TERRAIN_MOVE_BONUS[terrain];
  return boosted && boosted.includes(move.type) ? TERRAIN_DAMAGE_BONUS : 1;
}

// Held-territory roster power (Bridge 4): holding tiles of a biome strengthens
// your species native to that biome (their type appears in the biome's favored
// list). The per-biome buff scales with how many of that biome you hold.
export function territoryBuffPctForBiomeCount(count) {
  // Multiplies ALL stats of biome-native species, so it's potent per point;
  // capped gently (~+6%) to reward holding land without warping PvP. Tunable.
  if (count >= 10) return 0.06;
  if (count >= 6) return 0.05;
  if (count >= 3) return 0.04;
  if (count >= 1) return 0.03;
  return 0;
}

// Best territory buff a creature qualifies for, given the owner's per-biome buff
// map ({ biome: pct }). A creature is "native" to a biome if one of its types is
// favored there. Takes the strongest qualifying biome (no stacking).
function territoryBuffForTypes(types, buffByBiome) {
  if (!buffByBiome || !Array.isArray(types)) return 0;
  let best = 0;
  for (const biome of Object.keys(buffByBiome)) {
    const favored = TERRAIN_MOVE_BONUS[biome];
    if (favored && types.some((type) => favored.includes(type)) && buffByBiome[biome] > best) {
      best = buffByBiome[biome];
    }
  }
  return best;
}

// Which terrain best favors a team — its "home biome". Used to set the arena
// for NPC/challenge battles until tile-driven contests (Bridge 3) supply one.
export function terrainForTeam(team) {
  if (!team || !Array.isArray(team.creatures) || team.creatures.length === 0) return "neutral";
  const typeCounts = {};
  for (const creature of team.creatures) {
    for (const type of creature.types || []) {
      typeCounts[type] = (typeCounts[type] || 0) + 1;
    }
  }
  let best = "neutral";
  let bestScore = 0;
  for (const [terrain, types] of Object.entries(TERRAIN_MOVE_BONUS)) {
    let score = 0;
    for (const type of types) score += typeCounts[type] || 0;
    if (score > bestScore) {
      bestScore = score;
      best = terrain;
    }
  }
  return best;
}

function estimateDamage(attacker, defender, move, terrain) {
  if (move.category === "status") return 0;

  const attackKey = move.category === "physical" ? "strike" : "sense";
  const attackStat = stagedStat(attacker.stats[attackKey], attacker.statStages[attackKey] ?? 0);
  // Special defense blends guard and sense so high-sense creatures don't both
  // hit hard AND wall special attacks with the same stat.
  const defenseStat = move.category === "physical"
    ? stagedStat(defender.stats.guard, defender.statStages.guard ?? 0)
    : (stagedStat(defender.stats.guard, defender.statStages.guard ?? 0) +
       stagedStat(defender.stats.sense, defender.statStages.sense ?? 0)) / 2;
  const sameTypeBonus = attacker.types.includes(move.type) ? 1.15 : 1;
  const typeMultiplier = getTypeMultiplier(move.type, defender.types);
  const terrainBonus = terrainMultiplier(move, terrain);
  const bondNudge = 1 + Math.min(0.08, attacker.bondLevel * 0.002);
  const base = move.power * (attackStat / Math.max(1, defenseStat)) * sameTypeBonus * typeMultiplier * terrainBonus * bondNudge * DAMAGE_SCALE;

  return Math.max(1, Math.floor(base));
}

const STATUS_APPLY_TEXT = {
  stunned: (name) => `${name} is stunned.`,
  marked: (name) => `${name} is marked for the hunt.`,
  poisoned: (name) => `${name} was poisoned.`,
  shielded: (name) => `${name} raised a shield.`
};

function applyMove(state, attacker, defender, move, rng) {
  if (rng() * 100 > move.accuracy) {
    state.log.push({ turn: state.turn, text: `${attacker.name} used ${move.name}, but it missed.` });
    return;
  }

  if (move.category !== "status") {
    // Variance keeps repeated matchups from feeling fully scripted; the
    // fatigue ramp ensures heal/tank stalls always converge (battles past
    // turn 20 escalate 6% per turn).
    const variance = 0.9 + rng() * 0.15;
    const fatigue = 1 + Math.max(0, (state.turn ?? 0) - 20) * 0.06;
    // Critical hits: rare spike moments. Marked prey is easier to crit.
    const critChance = hasStatus(defender, "marked") ? 0.2 : 0.08;
    const crit = rng() < critChance;
    let damage = Math.max(1, Math.floor(estimateDamage(attacker, defender, move, state.terrain) * variance * fatigue * (crit ? 1.5 : 1)));
    let hits = 1;

    if (move.effect?.kind === "multihit") {
      const min = Math.max(2, Math.min(3, Math.floor(move.effect.min ?? 2)));
      const max = Math.max(min, Math.min(3, Math.floor(move.effect.max ?? 3)));
      hits = min + Math.floor(rng() * (max - min + 1));
      damage *= hits;
    }

    if (hasStatus(defender, "marked")) {
      damage = Math.floor(damage * 1.25);
      removeStatus(defender, "marked");
    }

    if (hasStatus(defender, "shielded")) {
      damage = Math.max(1, Math.floor(damage / 2));
      removeStatus(defender, "shielded");
      state.log.push({ turn: state.turn, text: `${defender.name}'s shield softened the blow.` });
    }

    const effectiveness = getTypeMultiplier(move.type, defender.types);
    defender.hp -= damage;
    attacker.damageDealt = (attacker.damageDealt ?? 0) + damage;
    defender.damageTaken = (defender.damageTaken ?? 0) + damage;
    state.log.push({
      turn: state.turn,
      text: `${attacker.name} used ${move.name} and dealt ${damage} damage.`,
      data: { damage, moveId: move.id, effectiveness, crit }
    });
    if (crit) {
      state.log.push({ turn: state.turn, text: "A critical hit!", data: { crit: true } });
    }
    if (effectiveness >= 1.2) {
      state.log.push({ turn: state.turn, text: "It's super effective!" });
    } else if (effectiveness <= 0.85) {
      state.log.push({ turn: state.turn, text: "It's not very effective…" });
    }
    if (hits > 1) {
      state.log.push({ turn: state.turn, text: `It struck ${hits} times.` });
    }
    applyRally(state, defender);

    if (move.effect?.kind === "drain") {
      const pct = Math.max(10, Math.min(60, Math.floor(move.effect.pct ?? 30)));
      const healed = Math.max(1, Math.floor((damage * pct) / 100));
      attacker.hp = Math.min(attacker.maxHp, attacker.hp + healed);
      state.log.push({ turn: state.turn, text: `${attacker.name} drained ${healed} HP.` });
    }

    if (move.effect?.kind === "recoil") {
      const pct = Math.max(10, Math.min(50, Math.floor(move.effect.pct ?? 25)));
      const recoil = Math.max(1, Math.floor((damage * pct) / 100));
      attacker.hp -= recoil;
      state.log.push({ turn: state.turn, text: `${attacker.name} took ${recoil} recoil damage.` });
    }
  } else {
    state.log.push({ turn: state.turn, text: `${attacker.name} used ${move.name}.` });
  }

  if (move.effect && ["buff", "debuff", "heal", "status"].includes(move.effect.kind)) {
    applyEffect(state, attacker, defender, move, rng);
  }
}

function applyEffect(state, attacker, defender, move, rng) {
  const effect = move.effect;

  if (effect.kind === "buff") {
    attacker.statStages[effect.stat] = Math.min(4, (attacker.statStages[effect.stat] ?? 0) + effect.amount);
    state.log.push({ turn: state.turn, text: `${attacker.name}'s ${effect.stat} rose.` });
  }

  if (effect.kind === "debuff") {
    defender.statStages[effect.stat] = Math.max(-4, (defender.statStages[effect.stat] ?? 0) - effect.amount);
    state.log.push({ turn: state.turn, text: `${defender.name}'s ${effect.stat} fell.` });
  }

  if (effect.kind === "heal") {
    const amount = Math.max(1, Math.floor(attacker.maxHp * (effect.amountPct / 100)));
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + amount);
    state.log.push({ turn: state.turn, text: `${attacker.name} recovered ${amount} HP.` });
  }

  if (effect.kind === "status" && rng() * 100 <= (effect.chance ?? 100)) {
    // Shields protect the user; every other status afflicts the target.
    const target = effect.status === "shielded" ? attacker : defender;
    if (effect.status === "stunned" && (target.statusMeta?.stunImmuneUntilTurn ?? 0) > state.turn) {
      state.log.push({ turn: state.turn, text: `${target.name} shrugged off the stun.` });
      return;
    }
    if (!target.statuses.includes(effect.status)) {
      target.statuses.push(effect.status);
      if (effect.status === "poisoned") {
        (target.statusMeta ?? (target.statusMeta = {})).poisonedTurns = 3;
      }
      const describe = STATUS_APPLY_TEXT[effect.status];
      state.log.push({
        turn: state.turn,
        text: describe ? describe(target.name) : `${target.name} became ${effect.status}.`
      });
    }
  }
}

function scoreNpcMove(attacker, defender, move, difficulty, rng, terrain) {
  const damage = estimateDamage(attacker, defender, move, terrain);
  const accuracy = move.accuracy / 100;
  let score = damage * accuracy;

  if (damage >= defender.hp) score += 40;
  if (attacker.types.includes(move.type)) score += 6;
  if (terrainMultiplier(move, terrain) > 1) score += 8;

  const typeMultiplier = getTypeMultiplier(move.type, defender.types);
  if (typeMultiplier > 1) score += 10 * typeMultiplier;
  if (typeMultiplier < 1) score -= 12 * (1 - typeMultiplier);
  if (move.accuracy < 80) score -= (80 - move.accuracy) * 0.4;

  if (move.category === "status" && move.effect) {
    if (move.effect.kind === "heal") {
      const missing = attacker.maxHp - attacker.hp;
      score += missing > attacker.maxHp * 0.25 ? 22 : 2;
    }
    if (move.effect.kind === "buff") score += attacker.hp > attacker.maxHp * 0.4 ? 15 : 5;
    if (move.effect.kind === "debuff") score += defender.hp > defender.maxHp * 0.35 ? 13 : 2;
    if (move.effect.kind === "status") score += defender.statuses.includes(move.effect.status) ? -10 : 12 * (move.effect.chance / 100);
  }

  if (attacker.role === "striker" && move.power >= 40) score += 8;
  if (attacker.role === "tank" && move.effect?.kind === "buff") score += 8;
  if (attacker.role === "support" && move.category === "status") score += 10;
  if (attacker.role === "scout" && (move.priority ?? 0) > 0) score += 8;
  if (attacker.role === "trickster" && ["status", "debuff"].includes(move.effect?.kind ?? "")) score += 8;

  const noise = difficulty === "easy" ? rng() * 20 : difficulty === "normal" ? rng() * 8 : rng() * 2;
  return score + noise;
}

function autoSwitch(team) {
  const active = team.creatures[team.activeIndex];
  if (!active?.fainted) return;

  const nextIndex = team.creatures.findIndex((creature) => !creature.fainted);
  if (nextIndex >= 0) team.activeIndex = nextIndex;
}

function getBattleStatus(state) {
  const playerAlive = state.player.creatures.some((creature) => !creature.fainted);
  const npcAlive = state.opponent.creatures.some((creature) => !creature.fainted);

  if (playerAlive && npcAlive) return "active";
  if (playerAlive && !npcAlive) return "won";
  if (!playerAlive && npcAlive) return "lost";
  return "draw";
}
