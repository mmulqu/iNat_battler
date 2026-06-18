// Empirical proof that battle replay is bit-for-bit deterministic — including
// crits, accuracy, damage variance, and status procs. We run a battle "live"
// (the same loop as submitBattleMove), record only the player's per-turn action,
// then reconstruct the whole battle from the compact replay artifact and assert
// every state matches. Run: `node scripts/verify-replay.mjs`
import {
  createNpcTeam,
  createSeededRng,
  chooseNpcAction,
  resolveTurn,
  effectiveDifficulty,
  reconstructBattleStates,
  terrainForTeam
} from "../src/game.js";

const clone = (value) => structuredClone(value);

function runOne(seed, difficulty) {
  // Build two teams; treat one as the player. Snapshot pristine copies for the
  // replay artifact BEFORE any mutation.
  const playerTeam = createNpcTeam("wetland_watcher");
  const opponent = createNpcTeam("backyard_beginner");
  const terrain = terrainForTeam(opponent);

  const pristinePlayerCreatures = clone(playerTeam.creatures);
  const pristineOpponent = clone(opponent);

  // Initial state in the exact shape reconstructBattleStates() rebuilds.
  let cur = {
    mode: "npc",
    difficulty,
    seed,
    turn: 1,
    terrain,
    player: { name: "Your Team", activeIndex: 0, creatures: clone(pristinePlayerCreatures) },
    opponent: clone(pristineOpponent),
    log: [],
    status: "active"
  };

  const liveStates = [clone(cur)];
  const actions = [];
  // A separate seeded picker so the test itself is reproducible but the player's
  // choices are varied (move vs. switch, different moves).
  const pick = createSeededRng(`picker:${seed}`);

  while (cur.status === "active" && cur.turn < 300) {
    const difficultyEff = effectiveDifficulty(cur.difficulty);
    const rng = createSeededRng(`${cur.seed}:${cur.turn}`);
    const npcAction = chooseNpcAction(cur, difficultyEff, rng);

    const active = cur.player.creatures[cur.player.activeIndex];
    let playerAction;
    // ~15% of the time, switch to a random non-fainted benched creature.
    const bench = cur.player.creatures
      .map((c, i) => ({ c, i }))
      .filter(({ c, i }) => !c.fainted && i !== cur.player.activeIndex);
    if (bench.length && pick() < 0.15) {
      playerAction = { kind: "switch", index: bench[Math.floor(pick() * bench.length)].i };
    } else {
      const move = active.moves[Math.floor(pick() * active.moves.length)];
      playerAction = { kind: "move", moveId: move.id };
    }

    actions.push({ turn: cur.turn, ...playerAction });
    cur = resolveTurn(cur, playerAction, npcAction, rng);
    liveStates.push(clone(cur));
  }

  // Reconstruct from the artifact + actions only.
  const replay = {
    v: 1,
    mode: "npc",
    seed,
    difficulty,
    terrain,
    player: { name: "Your Team", creatures: pristinePlayerCreatures },
    opponent: pristineOpponent
  };
  const rebuilt = reconstructBattleStates(replay, actions);

  // Compare.
  if (rebuilt.length !== liveStates.length) {
    throw new Error(`state count mismatch: live ${liveStates.length} vs rebuilt ${rebuilt.length}`);
  }
  for (let i = 0; i < liveStates.length; i += 1) {
    const a = JSON.stringify(liveStates[i]);
    const b = JSON.stringify(rebuilt[i]);
    if (a !== b) {
      throw new Error(`state ${i} mismatch for seed=${seed} difficulty=${difficulty}`);
    }
  }

  const crits = liveStates.at(-1).log.filter((e) => e?.data?.crit).length;
  return { turns: actions.length, crits, status: liveStates.at(-1).status };
}

let totalCrits = 0;
let battles = 0;
for (const difficulty of ["easy", "normal", "hard"]) {
  for (let s = 0; s < 40; s += 1) {
    const r = runOne(`seed-${difficulty}-${s}`, difficulty);
    totalCrits += r.crits;
    battles += 1;
  }
}

console.log(`OK — ${battles} battles reconstructed bit-for-bit.`);
console.log(`Total crits reproduced exactly across runs: ${totalCrits}`);
