const DEFAULT_STATS = {
  passerine_bird: { vigor: 42, strike: 42, guard: 34, tempo: 68, sense: 52 },
  raptor_bird: { vigor: 54, strike: 72, guard: 44, tempo: 64, sense: 58 },
  waterbird: { vigor: 58, strike: 48, guard: 52, tempo: 44, sense: 48 },
  insect: { vigor: 34, strike: 46, guard: 32, tempo: 66, sense: 48 },
  moth_butterfly: { vigor: 32, strike: 34, guard: 28, tempo: 60, sense: 66 },
  dragonfly: { vigor: 38, strike: 64, guard: 34, tempo: 82, sense: 56 },
  bee_wasp_ant: { vigor: 36, strike: 58, guard: 38, tempo: 62, sense: 52 },
  plant_herb: { vigor: 52, strike: 38, guard: 48, tempo: 24, sense: 60 },
  tree_shrub: { vigor: 76, strike: 42, guard: 70, tempo: 16, sense: 52 },
  grass_sedge: { vigor: 48, strike: 34, guard: 44, tempo: 32, sense: 54 },
  fern: { vigor: 50, strike: 36, guard: 46, tempo: 28, sense: 58 },
  fungus: { vigor: 62, strike: 38, guard: 58, tempo: 18, sense: 68 },
  mammal: { vigor: 58, strike: 52, guard: 46, tempo: 58, sense: 50 },
  amphibian: { vigor: 46, strike: 42, guard: 38, tempo: 48, sense: 62 },
  reptile: { vigor: 58, strike: 52, guard: 62, tempo: 38, sense: 48 },
  fish: { vigor: 48, strike: 46, guard: 40, tempo: 58, sense: 48 },
  mollusk: { vigor: 54, strike: 34, guard: 72, tempo: 18, sense: 44 },
  unknown: { vigor: 45, strike: 45, guard: 45, tempo: 45, sense: 45 }
};

const MOVE_LIBRARY = {
  jab: { id: "jab", name: "Jab", type: "Urban", category: "physical", power: 28, accuracy: 96, description: "A quick close-range strike." },
  peck: { id: "peck", name: "Peck", type: "Sky", category: "physical", power: 34, accuracy: 95, description: "A sharp beak jab." },
  wing_flick: { id: "wing_flick", name: "Wing Flick", type: "Sky", category: "physical", power: 38, accuracy: 92, priority: 1, description: "A fast wing-assisted strike." },
  crumb_rush: { id: "crumb_rush", name: "Crumb Rush", type: "Urban", category: "physical", power: 42, accuracy: 90, description: "A scrappy urban dash attack." },
  flock_burst: { id: "flock_burst", name: "Flock Burst", type: "Swarm", category: "special", power: 48, accuracy: 88, effect: { kind: "debuff", stat: "sense", amount: 1 }, description: "A confusing burst of echoing wings." },
  dust_bath: { id: "dust_bath", name: "Dust Bath", type: "Urban", category: "status", power: 0, accuracy: 100, effect: { kind: "buff", stat: "guard", amount: 1 }, description: "Raises Guard with a gritty dust cloud." },
  sting: { id: "sting", name: "Sting", type: "Venom", category: "physical", power: 40, accuracy: 92, effect: { kind: "status", status: "marked", chance: 25 }, description: "A venom-touched strike." },
  pollen_pulse: { id: "pollen_pulse", name: "Pollen Pulse", type: "Bloom", category: "special", power: 36, accuracy: 95, effect: { kind: "debuff", stat: "tempo", amount: 1 }, description: "A soft burst of pollen slows the target." },
  vine_lash: { id: "vine_lash", name: "Vine Lash", type: "Bloom", category: "physical", power: 42, accuracy: 90, description: "A flexible plant strike." },
  sunroot: { id: "sunroot", name: "Sunroot", type: "Sun", category: "status", power: 0, accuracy: 100, effect: { kind: "heal", amountPct: 18 }, description: "Recovers a little HP in sunlight." },
  spore_puff: { id: "spore_puff", name: "Spore Puff", type: "Fungus", category: "special", power: 34, accuracy: 92, effect: { kind: "status", status: "stunned", chance: 18 }, description: "A puff of spores may stun." },
  heartrot: { id: "heartrot", name: "Heartrot", type: "Decay", category: "special", power: 46, accuracy: 86, effect: { kind: "debuff", stat: "guard", amount: 1 }, description: "Decay magic that weakens defenses." },
  shell_guard: { id: "shell_guard", name: "Shell Guard", type: "Stone", category: "status", power: 0, accuracy: 100, effect: { kind: "buff", stat: "guard", amount: 2 }, description: "Raises Guard sharply." },
  stone_bump: { id: "stone_bump", name: "Stone Bump", type: "Stone", category: "physical", power: 40, accuracy: 92, description: "A heavy, grounded hit." },
  night_feint: { id: "night_feint", name: "Night Feint", type: "Night", category: "special", power: 40, accuracy: 92, effect: { kind: "debuff", stat: "sense", amount: 1 }, description: "A shadowy misdirection." },
  wetland_surge: { id: "wetland_surge", name: "Wetland Surge", type: "Wetland", category: "special", power: 42, accuracy: 90, description: "A rush of marsh energy." },
  burrow_trip: { id: "burrow_trip", name: "Burrow Trip", type: "Burrow", category: "physical", power: 36, accuracy: 94, effect: { kind: "debuff", stat: "tempo", amount: 1 }, description: "A low strike that slows the foe." },
  chorus_call: { id: "chorus_call", name: "Chorus Call", type: "Voice", category: "status", power: 0, accuracy: 100, effect: { kind: "buff", stat: "sense", amount: 1 }, description: "A call that focuses the team spirit." }
};

const BODY_MOVES = {
  passerine_bird: ["peck", "wing_flick", "flock_burst", "chorus_call"],
  raptor_bird: ["peck", "wing_flick", "night_feint", "flock_burst"],
  waterbird: ["peck", "wetland_surge", "wing_flick", "chorus_call"],
  insect: ["jab", "sting", "flock_burst", "pollen_pulse"],
  moth_butterfly: ["pollen_pulse", "wing_flick", "night_feint", "flock_burst"],
  dragonfly: ["wing_flick", "wetland_surge", "jab", "night_feint"],
  bee_wasp_ant: ["sting", "pollen_pulse", "jab", "flock_burst"],
  plant_herb: ["vine_lash", "pollen_pulse", "sunroot", "dust_bath"],
  tree_shrub: ["vine_lash", "sunroot", "shell_guard", "heartrot"],
  grass_sedge: ["vine_lash", "pollen_pulse", "wetland_surge", "sunroot"],
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
  Meadow: ["pollen_pulse"],
  Voice: ["chorus_call"]
};

const ROLE_MOVES = {
  scout: ["wing_flick", "crumb_rush"],
  striker: ["sting", "stone_bump", "heartrot"],
  tank: ["shell_guard", "stone_bump"],
  support: ["chorus_call", "sunroot", "pollen_pulse"],
  trickster: ["night_feint", "dust_bath", "burrow_trip"]
};

const TYPE_CHART = {
  Sky: { Burrow: 1.35, Bloom: 1.25, Swarm: 1.2, Stone: 0.75, Night: 0.85, Frost: 0.9 },
  Urban: { Swarm: 1.25, Burrow: 1.2, Meadow: 1.1, Decay: 0.8, Wood: 0.85, Wetland: 0.9 },
  Wetland: { Stone: 1.25, Burrow: 1.2, Sun: 0.8, Frost: 0.85 },
  Bloom: { Stone: 1.25, Burrow: 1.25, Venom: 0.75, Frost: 0.75, Urban: 0.85, Decay: 0.9 },
  Venom: { Bloom: 1.35, Swarm: 1.25, Fungus: 0.8, Stone: 0.75, Decay: 0.85, Meadow: 1.15 },
  Decay: { Bloom: 1.25, Wood: 1.25, Fungus: 0.9, Sun: 0.75, Frost: 0.85 },
  Fungus: { Bloom: 1.15, Decay: 1.1, Wood: 1.2, Sun: 0.75, Venom: 0.8 },
  Stone: { Sky: 1.25, Venom: 1.15, Wetland: 0.75, Bloom: 0.85, Wood: 0.9 },
  Burrow: { Urban: 1.15, Stone: 0.85, Sky: 0.75, Sun: 0.9 },
  Night: { Sky: 1.15, Bloom: 1.15, Voice: 1.15, Sun: 0.7, Urban: 0.85 },
  Swarm: { Bloom: 1.2, Urban: 1.1, Sky: 0.75, Venom: 0.75, Frost: 0.8 },
  Sun: { Fungus: 1.3, Decay: 1.2, Night: 1.25, Wetland: 0.85, Frost: 1.15 },
  Frost: { Bloom: 1.25, Swarm: 1.2, Wetland: 1.1, Sun: 0.75 },
  Wood: { Urban: 0.85, Decay: 0.75, Sun: 1.05, Fungus: 0.85 },
  Meadow: { Urban: 0.9, Swarm: 0.95, Bloom: 1.05, Sky: 0.9 },
  Voice: { Night: 1.1, Swarm: 1.1, Stone: 0.85, Urban: 1.05 }
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

export function createBattleCreature(taxon, instanceSuffix = "a") {
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
  const maxHp = Math.round(45 + stats.vigor * 1.4 + Math.min(20, Math.sqrt(obsCount) * 2));

  return {
    instanceId: `${taxon.taxonId}-${instanceSuffix}`,
    taxonId: taxon.taxonId,
    name: taxon.commonName || taxon.scientificName,
    scientificName: taxon.scientificName,
    bodyPlan: genome.bodyPlan,
    types: genome.types,
    role: genome.role,
    maxHp,
    hp: maxHp,
    stats,
    statStages: {},
    moves: genome.moves,
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
  const legal = npc.moves;

  if (difficulty === "random") {
    return legal[Math.floor(rng() * legal.length)].id;
  }

  const scored = legal.map((move) => ({
    move,
    score: scoreNpcMove(npc, target, move, difficulty, rng)
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

export function resolveTurn(state, playerAction, npcAction, rng) {
  const next = structuredClone(state);
  const playerCreature = getActive(next.player);
  const npcCreature = getActive(next.opponent);
  const actions = [
    { actor: playerCreature, target: npcCreature, action: playerAction },
    { actor: npcCreature, target: playerCreature, action: npcAction }
  ];

  actions.sort((left, right) => {
    const moveLeft = left.actor.moves.find((move) => move.id === left.action.moveId);
    const moveRight = right.actor.moves.find((move) => move.id === right.action.moveId);
    const priorityDiff = (moveRight?.priority ?? 0) - (moveLeft?.priority ?? 0);
    if (priorityDiff !== 0) return priorityDiff;
    return right.actor.stats.tempo - left.actor.stats.tempo;
  });

  for (const item of actions) {
    if (item.actor.fainted || item.target.fainted) continue;

    const move = item.actor.moves.find((candidate) => candidate.id === item.action.moveId);
    if (!move) continue;

    applyMove(next, item.actor, item.target, move, rng);

    if (item.target.hp <= 0) {
      item.target.hp = 0;
      item.target.fainted = true;
      next.log.push({ turn: next.turn, text: `${item.target.name} fainted.` });
    }
  }

  autoSwitch(next.player);
  autoSwitch(next.opponent);
  next.status = getBattleStatus(next);
  next.turn += 1;
  return next;
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

  if (/urban|house|city|pavement|sidewalk|rock pigeon|starling|sparrow|dandelion|squirrel|rat|mouse/.test(name)) add("Urban");
  if (/venom|poison|stinging|nettles|wasp|bee|snake|milkweed/.test(name)) add("Venom");
  if (/night|nocturnal|owl|bat|moth|moon/.test(name)) add("Night");
  if (/sun|sunflower|daisy|goldenrod|aster|meadow|prairie|clover/.test(name)) add("Sun");
  if (/swarm|flock|ant|bee|wasp|termite|sparrow|starling|blackbird/.test(name)) add("Swarm");
  if (/burrow|groundhog|mole|chipmunk|rabbit|toad|salamander/.test(name)) add("Burrow");
  if (/frost|snow|winter|ice/.test(name)) add("Frost");
  if (/warbler|sparrow|robin|thrush|wren|oriole|blackbird|starling|frog|toad/.test(name)) add("Voice");

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

function estimateDamage(attacker, defender, move) {
  if (move.category === "status") return 0;

  const attackKey = move.category === "physical" ? "strike" : "sense";
  const defenseKey = move.category === "physical" ? "guard" : "sense";
  const attackStat = stagedStat(attacker.stats[attackKey], attacker.statStages[attackKey] ?? 0);
  const defenseStat = stagedStat(defender.stats[defenseKey], defender.statStages[defenseKey] ?? 0);
  const sameTypeBonus = attacker.types.includes(move.type) ? 1.15 : 1;
  const typeMultiplier = getTypeMultiplier(move.type, defender.types);
  const bondNudge = 1 + Math.min(0.08, attacker.bondLevel * 0.002);
  const base = move.power * (attackStat / Math.max(1, defenseStat)) * sameTypeBonus * typeMultiplier * bondNudge;

  return Math.max(1, Math.floor(base));
}

function applyMove(state, attacker, defender, move, rng) {
  if (rng() * 100 > move.accuracy) {
    state.log.push({ turn: state.turn, text: `${attacker.name} used ${move.name}, but it missed.` });
    return;
  }

  if (move.category !== "status") {
    const damage = estimateDamage(attacker, defender, move);
    defender.hp -= damage;
    state.log.push({
      turn: state.turn,
      text: `${attacker.name} used ${move.name} and dealt ${damage} damage.`,
      data: { damage, moveId: move.id }
    });
  } else {
    state.log.push({ turn: state.turn, text: `${attacker.name} used ${move.name}.` });
  }

  if (move.effect) applyEffect(state, attacker, defender, move, rng);
}

function applyEffect(state, attacker, defender, move, rng) {
  const effect = move.effect;
  const target = effect.kind === "buff" || effect.kind === "heal" ? attacker : defender;

  if (effect.kind === "buff") {
    target.statStages[effect.stat] = Math.min(4, (target.statStages[effect.stat] ?? 0) + effect.amount);
    state.log.push({ turn: state.turn, text: `${target.name}'s ${effect.stat} rose.` });
  }

  if (effect.kind === "debuff") {
    target.statStages[effect.stat] = Math.max(-4, (target.statStages[effect.stat] ?? 0) - effect.amount);
    state.log.push({ turn: state.turn, text: `${target.name}'s ${effect.stat} fell.` });
  }

  if (effect.kind === "heal") {
    const amount = Math.max(1, Math.floor(attacker.maxHp * (effect.amountPct / 100)));
    attacker.hp = Math.min(attacker.maxHp, attacker.hp + amount);
    state.log.push({ turn: state.turn, text: `${attacker.name} recovered ${amount} HP.` });
  }

  if (effect.kind === "status" && rng() * 100 <= effect.chance && !defender.statuses.includes(effect.status)) {
    defender.statuses.push(effect.status);
    state.log.push({ turn: state.turn, text: `${defender.name} became ${effect.status}.` });
  }
}

function scoreNpcMove(attacker, defender, move, difficulty, rng) {
  const damage = estimateDamage(attacker, defender, move);
  const accuracy = move.accuracy / 100;
  let score = damage * accuracy;

  if (damage >= defender.hp) score += 40;
  if (attacker.types.includes(move.type)) score += 6;

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
