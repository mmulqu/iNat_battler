// Species move dossiers: a text LLM researches the organism and designs two
// signature moves as pure data; this module owns the prompts, the strict
// validation/clamping that keeps generated moves balanced, the genome v2
// assembly (2 signature + 2 common library moves), and the per-row
// sprite-sheet prompt sent to the image model.

import { MOVE_TYPES, createGenome } from "./game.js";

export const GENOME_VERSION_MOVES = 2;
export const MOVE_NAME_MAX_LENGTH = 22;
export const MOVE_FLAVOR_MAX_LENGTH = 110;
export const MOVE_ANIMATION_MAX_LENGTH = 160;
export const FACT_MAX_LENGTH = 160;

const MOVE_POWER_MIN = 20;
const MOVE_POWER_MAX = 60;
const MULTIHIT_POWER_MAX = 26;
const MOVE_ACCURACY_MIN = 75;
const MOVE_ACCURACY_MAX = 100;
const MOVE_BUDGET = 62;

const EFFECT_BUDGET_COST = {
  none: 0,
  buff: 10,
  debuff: 10,
  heal: 14,
  status: 12,
  drain: 12,
  recoil: -6,
  multihit: 14
};

const VALID_STATUSES = ["stunned", "marked", "poisoned", "shielded"];
const VALID_STATS = ["vigor", "strike", "guard", "tempo", "sense"];
const VALID_CATEGORIES = ["physical", "special", "status"];

// ---------------------------------------------------------------------------
// LLM prompt (sent to the move model, e.g. gpt-5.4-nano)
// ---------------------------------------------------------------------------

export function dossierMessages(taxon, wikipediaSummary) {
  const common = taxon.commonName || taxon.scientificName;

  const system =
    "You are a naturalist and game designer for a biodiversity creature-battler. " +
    "Given a real species, you research its actual biology and design exactly TWO signature battle moves " +
    "rooted in real behavior (hunting technique, defense, diet, courtship, chemical ecology, growth habit). " +
    "Moves must be species-specific and educational, never generic. " +
    "Respond with ONLY valid JSON matching this shape:\n" +
    '{"facts": ["3-5 short true natural-history facts"],\n' +
    ' "idleAnimation": "one line describing a 4-frame idle loop pose",\n' +
    ' "movementAnimation": "one line describing a 4-frame locomotion loop",\n' +
    ' "signatureMoves": [\n' +
    '   {"name": "Move Name", "type": "<one of: ' + MOVE_TYPES.join(", ") + '>",\n' +
    '    "category": "physical|special|status", "power": 20-60, "accuracy": 75-100,\n' +
    '    "effect": null or one of\n' +
    '      {"kind":"status","status":"stunned|marked|poisoned|shielded","chance":10-30}\n' +
    '      {"kind":"buff","stat":"vigor|strike|guard|tempo|sense","amount":1}\n' +
    '      {"kind":"debuff","stat":"vigor|strike|guard|tempo|sense","amount":1}\n' +
    '      {"kind":"heal","amountPct":10-25}\n' +
    '      {"kind":"drain","pct":20-50}\n' +
    '      {"kind":"recoil","pct":15-35}\n' +
    '      {"kind":"multihit","min":2,"max":3},\n' +
    '    "flavor": "<=110 chars connecting the move to the real biology",\n' +
    '    "animation": "one line storyboard for a 4-frame attack animation, pixel-art friendly"}\n' +
    " , {second move} ]}\n" +
    "Rules: status-category moves have power 0 and MUST have an effect; " +
    "poisoned/venom themes only if the species truly is toxic, venomous, or chemically defended; " +
    "shielded only for armored/shelled/bark-protected species; multihit only for rapid repeated strikes (pecking, stinging swarms); " +
    "names are punchy (<=22 chars), no trademarked monster names.";

  const user =
    `Species: ${common} (${taxon.scientificName})\n` +
    `Rank: ${taxon.rank ?? "species"} | iNaturalist iconic group: ${taxon.iconicTaxonName ?? "unknown"}\n` +
    (wikipediaSummary
      ? `Reference summary (from Wikipedia via iNaturalist):\n${String(wikipediaSummary).slice(0, 1600)}\n`
      : "No reference summary available; rely on well-established biology only and stay conservative.\n") +
    "Design the dossier now. JSON only.";

  return [
    { role: "system", content: system },
    { role: "user", content: user }
  ];
}

// ---------------------------------------------------------------------------
// Validation and balance clamping
// ---------------------------------------------------------------------------

function cleanLine(value, maxLength) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function cleanMoveName(value, fallback) {
  const name = cleanLine(value, MOVE_NAME_MAX_LENGTH).replace(/[^A-Za-z0-9 '\-!]/g, "").trim();
  return name || fallback;
}

function clampInt(value, min, max, fallback) {
  const parsed = Math.floor(Number(value));
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}

function sanitizeEffect(rawEffect, category) {
  if (!rawEffect || typeof rawEffect !== "object") {
    return category === "status" ? { kind: "buff", stat: "guard", amount: 1 } : null;
  }

  const kind = String(rawEffect.kind ?? "");
  if (kind === "status" && VALID_STATUSES.includes(rawEffect.status)) {
    // Pure status moves always land their effect; on damaging moves the
    // status is a rider capped at 30% chance.
    const chance = category === "status" ? 100 : clampInt(rawEffect.chance, 10, 30, 20);
    return { kind, status: rawEffect.status, chance };
  }
  if ((kind === "buff" || kind === "debuff") && VALID_STATS.includes(rawEffect.stat)) {
    return { kind, stat: rawEffect.stat, amount: 1 };
  }
  if (kind === "heal") {
    return { kind, amountPct: clampInt(rawEffect.amountPct, 10, 25, 18) };
  }
  if (kind === "drain") {
    return { kind, pct: clampInt(rawEffect.pct, 20, 50, 30) };
  }
  if (kind === "recoil") {
    return { kind, pct: clampInt(rawEffect.pct, 15, 35, 25) };
  }
  if (kind === "multihit") {
    const min = clampInt(rawEffect.min, 2, 3, 2);
    return { kind, min, max: clampInt(rawEffect.max, min, 3, 3) };
  }
  return category === "status" ? { kind: "buff", stat: "guard", amount: 1 } : null;
}

function moveSlug(name) {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 28) || "move";
}

export function sanitizeSignatureMove(rawMove, taxonId, index) {
  if (!rawMove || typeof rawMove !== "object") {
    throw new Error(`signature move ${index + 1} is missing`);
  }

  const name = cleanMoveName(rawMove.name, `Signature ${index + 1}`);
  const type = MOVE_TYPES.includes(rawMove.type) ? rawMove.type : "Meadow";
  const category = VALID_CATEGORIES.includes(rawMove.category) ? rawMove.category : "physical";
  const effect = sanitizeEffect(rawMove.effect, category);

  let power = category === "status" ? 0 : clampInt(rawMove.power, MOVE_POWER_MIN, MOVE_POWER_MAX, 40);
  const accuracy = clampInt(rawMove.accuracy, MOVE_ACCURACY_MIN, MOVE_ACCURACY_MAX, 90);

  if (effect?.kind === "multihit") {
    // Power is per hit for multihit moves; keep the total in line.
    power = Math.min(power, MULTIHIT_POWER_MAX);
  }

  // Budget keeps the LLM from stacking high power with strong effects:
  // expected power + effect cost must fit, or raw power is reduced.
  if (category !== "status") {
    const effectCost = EFFECT_BUDGET_COST[effect?.kind ?? "none"] ?? 0;
    const expected = (power * accuracy) / 100 + effectCost;
    if (expected > MOVE_BUDGET) {
      power = Math.max(MOVE_POWER_MIN, Math.floor(((MOVE_BUDGET - effectCost) * 100) / accuracy));
      if (effect?.kind === "multihit") power = Math.min(power, MULTIHIT_POWER_MAX);
    }
  }

  return {
    id: `sig_${taxonId}_${moveSlug(name)}`,
    name,
    type,
    category,
    power,
    accuracy,
    effect,
    signature: true,
    animRow: index === 0 ? 3 : 4,
    flavor: cleanLine(rawMove.flavor, MOVE_FLAVOR_MAX_LENGTH),
    animation: cleanLine(rawMove.animation, MOVE_ANIMATION_MAX_LENGTH),
    description: cleanLine(rawMove.flavor, MOVE_FLAVOR_MAX_LENGTH)
  };
}

export function validateDossier(raw, taxonId) {
  const data = typeof raw === "string" ? JSON.parse(raw) : raw;
  if (!data || typeof data !== "object") throw new Error("dossier is not an object");

  const rawMoves = Array.isArray(data.signatureMoves) ? data.signatureMoves : [];
  if (rawMoves.length < 2) throw new Error("dossier must include two signature moves");

  const moves = [
    sanitizeSignatureMove(rawMoves[0], taxonId, 0),
    sanitizeSignatureMove(rawMoves[1], taxonId, 1)
  ];
  if (moves[0].name.toLowerCase() === moves[1].name.toLowerCase()) {
    moves[1].name = `${moves[1].name} II`.slice(0, MOVE_NAME_MAX_LENGTH);
  }

  const facts = (Array.isArray(data.facts) ? data.facts : [])
    .map((fact) => cleanLine(fact, FACT_MAX_LENGTH))
    .filter(Boolean)
    .slice(0, 5);

  return {
    facts,
    idleAnimation: cleanLine(data.idleAnimation, MOVE_ANIMATION_MAX_LENGTH) || "alert resting pose with subtle breathing and small head movements",
    movementAnimation: cleanLine(data.movementAnimation, MOVE_ANIMATION_MAX_LENGTH) || "natural locomotion cycle for this species",
    signatureMoves: moves
  };
}

// ---------------------------------------------------------------------------
// Genome v2 assembly: 2 signature moves + 2 common library moves
// ---------------------------------------------------------------------------

export function assembleGenomeV2(taxonSummary, dossier) {
  const procedural = createGenome(taxonSummary);
  const signatureNames = new Set(dossier.signatureMoves.map((move) => move.name.toLowerCase()));

  const commonMoves = procedural.moves
    .filter((move) => !signatureNames.has(move.name.toLowerCase()))
    .slice(0, 2)
    .map((move) => ({ ...move, signature: false, animRow: move.category === "special" ? 4 : 3 }));

  while (commonMoves.length < 2) {
    commonMoves.push({
      id: "jab",
      name: "Jab",
      type: "Urban",
      category: "physical",
      power: 28,
      accuracy: 96,
      description: "A quick close-range strike.",
      signature: false,
      animRow: 3
    });
  }

  return {
    genomeVersion: GENOME_VERSION_MOVES,
    taxonId: taxonSummary.taxonId,
    scientificName: taxonSummary.scientificName,
    commonName: taxonSummary.commonName,
    bodyPlan: procedural.bodyPlan,
    types: procedural.types,
    role: procedural.role,
    baseStats: procedural.baseStats,
    facts: dossier.facts,
    animations: {
      idle: dossier.idleAnimation,
      movement: dossier.movementAnimation,
      row3: dossier.signatureMoves[0].animation,
      row4: dossier.signatureMoves[1].animation
    },
    moves: [...dossier.signatureMoves, ...commonMoves]
  };
}

// ---------------------------------------------------------------------------
// Sprite-sheet prompt v2 (sent to gpt-image-2)
// ---------------------------------------------------------------------------

export function buildSpriteSheetPromptV2(taxonSummary, genome) {
  const common = taxonSummary.commonName || taxonSummary.scientificName;
  const [signatureA, signatureB] = genome.moves;

  const prompt =
    "Create one clean 4x4 pixel-art sprite sheet (16 equal square cells: 4 rows, 4 columns, " +
    "left to right = animation frames 1-4 of each row) for an original biodiversity creature-battler game.\n\n" +
    `SUBJECT: a stylized battle-spirit of the real species ${common} (${taxonSummary.scientificName}), ` +
    `body plan ${genome.bodyPlan}, ecological types ${genome.types.join(" / ")}, battle role ${genome.role}. ` +
    "Preserve the true field marks of this species: accurate colors, markings, silhouette, and proportions, " +
    "with a charming but battle-ready expression. The SAME character at the SAME scale appears in every cell, " +
    "centered in its cell, crisp pixel art with clean dark outlines and a limited palette, " +
    "plain light neutral opaque background, no scenery, no text, no UI, no visible grid lines.\n\n" +
    "ANIMATION ROWS:\n" +
    `Row 1 - IDLE loop: ${genome.animations.idle}\n` +
    `Row 2 - MOVEMENT loop: ${genome.animations.movement}\n` +
    `Row 3 - SIGNATURE MOVE "${signatureA.name}" (${signatureA.flavor || "species signature attack"}): ${genome.animations.row3}\n` +
    `Row 4 - SIGNATURE MOVE "${signatureB.name}" (${signatureB.flavor || "species signature attack"}): ${genome.animations.row4}\n\n` +
    "Each row reads as a smooth 4-frame loop with clear silhouette changes between frames; " +
    "exaggerate key poses for small-size game readability. Rows 3 and 4 should feel distinct from each other " +
    "and visibly grounded in this species' real behavior. " +
    "Do not imitate any copyrighted monster franchise or existing character.";

  const negativePrompt =
    "No text, labels, logos, UI, scenery, complex background, extra unrelated creatures, humans, " +
    "copyrighted monster-franchise styles, messy or uneven grid, inconsistent character between cells, " +
    "scale changes between cells, cropped sprites, blurry pixels, photorealism, malformed anatomy, " +
    "random fantasy traits that erase the real species identity.";

  return {
    body_plan: genome.bodyPlan,
    ecological_types: genome.types,
    battle_role: genome.role,
    reference_image_url: taxonSummary.defaultPhotoUrl ?? null,
    negative_prompt: negativePrompt,
    genome,
    sprite_prompt: prompt,
    prompt_version: 2
  };
}
