// Battle balance simulator: round-robin AI-vs-AI duels across all body plans.
//
//   node scripts/simulate.mjs [seedsPerPairing]
//
// Both sides pick moves with the production "hard" AI; resolution uses the
// production seeded RNG, so results are deterministic for a given seed count.
// Run before and after any change to TYPE_CHART, MOVE_LIBRARY, or the damage
// formula, and compare the tables.

import {
  createBattleCreature,
  resolveTurn,
  chooseNpcMove,
  createSeededRng,
  TYPE_CHART
} from "../src/game.js";

const SEEDS_PER_PAIRING = Math.max(1, Number.parseInt(process.argv[2] ?? "25", 10) || 25);
const MAX_TURNS = 60;

// One representative taxon per body plan. Names are chosen to hit the
// inferBodyPlan/inferTypes regexes the way real imports do; bond/obs are
// fixed so only the body-plan kit varies.
const REPRESENTATIVE_TAXA = [
  { plan: "passerine_bird", commonName: "Song Sparrow", scientificName: "Melospiza melodia", iconicTaxonName: "Aves" },
  { plan: "raptor_bird", commonName: "Red-tailed Hawk", scientificName: "Buteo jamaicensis", iconicTaxonName: "Aves" },
  { plan: "waterbird", commonName: "Mallard Duck", scientificName: "Anas platyrhynchos", iconicTaxonName: "Aves" },
  { plan: "insect", commonName: "Ground Beetle", scientificName: "Carabus nemoralis", iconicTaxonName: "Insecta" },
  { plan: "moth_butterfly", commonName: "Luna Moth", scientificName: "Actias luna", iconicTaxonName: "Insecta" },
  { plan: "dragonfly", commonName: "Common Green Darner", scientificName: "Anax junius", iconicTaxonName: "Insecta" },
  { plan: "bee_wasp_ant", commonName: "Western Honey Bee", scientificName: "Apis mellifera", iconicTaxonName: "Insecta" },
  { plan: "plant_herb", commonName: "Common Yarrow", scientificName: "Achillea millefolium", iconicTaxonName: "Plantae" },
  { plan: "tree_shrub", commonName: "Northern Red Oak", scientificName: "Quercus rubra", iconicTaxonName: "Plantae" },
  { plan: "grass_sedge", commonName: "Foxtail Grass", scientificName: "Setaria pumila", iconicTaxonName: "Plantae" },
  { plan: "fern", commonName: "Bracken Fern", scientificName: "Pteridium aquilinum", iconicTaxonName: "Plantae" },
  { plan: "fungus", commonName: "Turkey-tail", scientificName: "Trametes versicolor", iconicTaxonName: "Fungi" },
  { plan: "mammal", commonName: "Eastern Gray Squirrel", scientificName: "Sciurus carolinensis", iconicTaxonName: "Mammalia" },
  { plan: "amphibian", commonName: "American Toad", scientificName: "Anaxyrus americanus", iconicTaxonName: "Amphibia" },
  { plan: "reptile", commonName: "Common Garter Snake", scientificName: "Thamnophis sirtalis", iconicTaxonName: "Reptilia" },
  { plan: "fish", commonName: "Brook Trout", scientificName: "Salvelinus fontinalis", iconicTaxonName: "Actinopterygii" },
  { plan: "mollusk", commonName: "Garden Snail", scientificName: "Cornu aspersum", iconicTaxonName: "Mollusca" },
  { plan: "unknown", commonName: "Mystery Organism", scientificName: "Incognita incognita", iconicTaxonName: "" }
].map((taxon, index) => ({ ...taxon, taxonId: 900000 + index, obsCount: 10, bondLevel: 8 }));

function makeState(taxonA, taxonB, seed) {
  return {
    battleId: seed,
    seed,
    turn: 1,
    player: { name: "A", activeIndex: 0, creatures: [createBattleCreature(taxonA, "a")] },
    opponent: { name: "B", activeIndex: 0, creatures: [createBattleCreature(taxonB, "b")] },
    log: [],
    status: "active"
  };
}

function runDuel(taxonA, taxonB, seed, metrics) {
  let state = makeState(taxonA, taxonB, seed);

  while (state.status === "active" && state.turn <= MAX_TURNS) {
    // Separate selection RNGs so AI deliberation doesn't perturb resolution.
    const selectA = createSeededRng(`${seed}:sel-a:${state.turn}`);
    const selectB = createSeededRng(`${seed}:sel-b:${state.turn}`);
    const resolveRng = createSeededRng(`${seed}:${state.turn}`);

    const mirrored = { ...state, player: state.opponent, opponent: state.player };
    const moveA = chooseNpcMove(mirrored, "hard", selectA);
    const moveB = chooseNpcMove(state, "hard", selectB);

    state = resolveTurn(
      state,
      { kind: "move", moveId: moveA },
      { kind: "move", moveId: moveB },
      resolveRng
    );
  }

  for (const entry of state.log) {
    const text = String(entry.text ?? "");
    metrics.logTurns += 0; // keep shape obvious
    if (text.includes("is stunned and cannot move")) metrics.stunSkips += 1;
    if (text.includes("but it missed")) metrics.misses += 1;
    if (entry.data?.moveId) {
      metrics.actions += 1;
      const m = metrics.moveDamage.get(entry.data.moveId) ?? { uses: 0, damage: 0 };
      m.uses += 1;
      m.damage += Number(entry.data.damage ?? 0);
      metrics.moveDamage.set(entry.data.moveId, m);
    }
  }
  metrics.creatureTurns += (state.turn - 1) * 2;

  const status = state.status === "active" ? "draw" : state.status;
  return { status, turns: state.turn - 1 };
}

// --- run the round robin ---------------------------------------------------

const plans = REPRESENTATIVE_TAXA;
const winCounts = new Map(plans.map((p) => [p.plan, { wins: 0, losses: 0, draws: 0 }]));
const matrix = new Map(); // "a|b" -> { aWins, bWins, draws, games }
const metrics = { stunSkips: 0, misses: 0, actions: 0, creatureTurns: 0, logTurns: 0, moveDamage: new Map() };
let totalTurns = 0;
let totalDuels = 0;
let totalDraws = 0;

for (let i = 0; i < plans.length; i += 1) {
  for (let j = i + 1; j < plans.length; j += 1) {
    const a = plans[i];
    const b = plans[j];
    const key = `${a.plan}|${b.plan}`;
    const cell = { aWins: 0, bWins: 0, draws: 0, games: 0 };

    for (let s = 0; s < SEEDS_PER_PAIRING; s += 1) {
      // Alternate orientation so turn-order ties don't bias one slot.
      const forward = s % 2 === 0;
      const first = forward ? a : b;
      const second = forward ? b : a;
      const { status, turns } = runDuel(first, second, `duel:${key}:${s}`, metrics);

      totalDuels += 1;
      totalTurns += turns;
      cell.games += 1;

      const aWon = (status === "won") === forward;
      if (status === "draw") {
        cell.draws += 1;
        totalDraws += 1;
        winCounts.get(a.plan).draws += 1;
        winCounts.get(b.plan).draws += 1;
      } else if (aWon) {
        cell.aWins += 1;
        winCounts.get(a.plan).wins += 1;
        winCounts.get(b.plan).losses += 1;
      } else {
        cell.bWins += 1;
        winCounts.get(b.plan).wins += 1;
        winCounts.get(a.plan).losses += 1;
      }
    }

    matrix.set(key, cell);
  }
}

// --- type win rates (only duels where exactly one side has the type) -------

const typeRecords = new Map();
for (let i = 0; i < plans.length; i += 1) {
  for (let j = i + 1; j < plans.length; j += 1) {
    const a = plans[i];
    const b = plans[j];
    const typesA = createBattleCreature(a, "x").types;
    const typesB = createBattleCreature(b, "x").types;
    const cell = matrix.get(`${a.plan}|${b.plan}`);

    for (const type of new Set([...typesA, ...typesB])) {
      const onA = typesA.includes(type);
      const onB = typesB.includes(type);
      if (onA === onB) continue;
      const record = typeRecords.get(type) ?? { wins: 0, games: 0 };
      record.wins += onA ? cell.aWins : cell.bWins;
      record.games += cell.aWins + cell.bWins;
      typeRecords.set(type, record);
    }
  }
}

// --- report -----------------------------------------------------------------

const pct = (n, d) => (d > 0 ? ((100 * n) / d).toFixed(1).padStart(5) : "  n/a");

console.log(`\n=== iNat Battler balance simulation ===`);
console.log(`${totalDuels} duels (${SEEDS_PER_PAIRING} seeds x ${matrix.size} pairings), AI=hard both sides, max ${MAX_TURNS} turns`);
console.log(`avg battle length: ${(totalTurns / totalDuels).toFixed(1)} turns, draws (turn cap): ${totalDraws}`);
console.log(`stun-skipped turns: ${pct(metrics.stunSkips, metrics.creatureTurns)}% of creature-turns`);
console.log(`missed attacks:     ${pct(metrics.misses, metrics.misses + metrics.actions)}% of attempted moves`);

console.log(`\n--- aggregate win rate by body plan (decisive games) ---`);
const standings = [...winCounts.entries()]
  .map(([plan, r]) => ({ plan, ...r, rate: r.wins + r.losses > 0 ? r.wins / (r.wins + r.losses) : 0 }))
  .sort((x, y) => y.rate - x.rate);
for (const row of standings) {
  const types = createBattleCreature(plans.find((p) => p.plan === row.plan), "x").types.join("/");
  console.log(
    `${(100 * row.rate).toFixed(1).padStart(5)}%  ${row.plan.padEnd(16)} W${String(row.wins).padStart(4)} L${String(row.losses).padStart(4)} D${String(row.draws).padStart(3)}  [${types}]`
  );
}

console.log(`\n--- pairing matrix (row beats column, % of decisive games) ---`);
const order = standings.map((s) => s.plan);
const colWidth = 6;
console.log(" ".repeat(17) + order.map((p) => p.slice(0, colWidth - 1).padStart(colWidth)).join(""));
for (const rowPlan of order) {
  let line = rowPlan.padEnd(17);
  for (const colPlan of order) {
    if (rowPlan === colPlan) {
      line += "    --";
      continue;
    }
    const fwd = matrix.get(`${rowPlan}|${colPlan}`);
    const rev = matrix.get(`${colPlan}|${rowPlan}`);
    const wins = fwd ? fwd.aWins : rev.bWins;
    const losses = fwd ? fwd.bWins : rev.aWins;
    line += pct(wins, wins + losses) + " ";
  }
  console.log(line);
}

console.log(`\n--- type win rates (duels where exactly one side has the type) ---`);
for (const [type, r] of [...typeRecords.entries()].sort((a, b) => b[1].wins / b[1].games - a[1].wins / a[1].games)) {
  console.log(`${pct(r.wins, r.games)}%  ${type.padEnd(8)} (${r.games} decisive games)`);
}

console.log(`\n--- move damage share (top 12) ---`);
const totalDamage = [...metrics.moveDamage.values()].reduce((sum, m) => sum + m.damage, 0);
const moveRows = [...metrics.moveDamage.entries()]
  .sort((a, b) => b[1].damage - a[1].damage)
  .slice(0, 12);
for (const [moveId, m] of moveRows) {
  console.log(`${pct(m.damage, totalDamage)}%  ${moveId.padEnd(14)} uses ${String(m.uses).padStart(5)}  avg ${(m.damage / m.uses).toFixed(1)} dmg`);
}

console.log(`\n--- TYPE_CHART audit ---`);
const types = Object.keys(TYPE_CHART);
let mutualCount = 0;
for (const atk of types) {
  for (const def of types) {
    if (atk >= def) continue;
    const ab = TYPE_CHART[atk]?.[def] ?? 1;
    const ba = TYPE_CHART[def]?.[atk] ?? 1;
    if (ab > 1 && ba > 1) {
      mutualCount += 1;
      console.log(`MUTUAL SUPER-EFFECTIVE: ${atk} -> ${def} (${ab}) and ${def} -> ${atk} (${ba})`);
    }
  }
}
if (mutualCount === 0) console.log("no mutual super-effective pairs");
for (const type of types) {
  const offense = Math.max(...Object.values(TYPE_CHART[type] ?? { x: 1 }));
  const weaknesses = types.filter((other) => (TYPE_CHART[other]?.[type] ?? 1) > 1).length;
  const flags = [];
  if (offense < 1.15) flags.push("INERT OFFENSE");
  if (weaknesses === 0) flags.push("NO WEAKNESS");
  if (flags.length) console.log(`${type.padEnd(8)} max offense ${offense.toFixed(2)}, weaknesses ${weaknesses}  <- ${flags.join(", ")}`);
}
console.log("");
