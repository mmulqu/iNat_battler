// Species training: point earning, mastery tiers, and allocation rules.
//
// All point math is deterministic from current iNaturalist Research Grade
// data, so re-imports never need grant bookkeeping: earned is recomputed,
// spent is stored, available = max(0, earned - spent).

export const TRAINING_STATS = ["vigor", "strike", "guard", "tempo", "sense"];
export const STAT_CAP_RATIO = 0.6;
export const RESPEC_COOLDOWN_MS = 7 * 24 * 60 * 60 * 1000;
export const FIRST_RG_BONUS = 5;
export const NICKNAME_MAX_LENGTH = 24;

const TIER_ORDER = ["none", "bronze", "silver", "gold", "complete"];

// Distinct Research Grade species observed in the group unlock tiers.
// "complete" needs iNat to report an authoritative species count for the
// group (complete_species_count), with at least 3 species so monotypic
// genera are not trivially completable.
const MASTERY_RULES = {
  genus: {
    thresholds: { bronze: 3, silver: 7, gold: 15 },
    perSpeciesBonus: { bronze: 5, silver: 12, gold: 25, complete: 40 },
    buffPct: { gold: 0.1, complete: 0.15 }
  },
  family: {
    thresholds: { bronze: 5, silver: 12, gold: 25 },
    perSpeciesBonus: { bronze: 3, silver: 8, gold: 15, complete: 25 },
    buffPct: { gold: 0.05, complete: 0.08 }
  }
};

export function tierRank(tier) {
  const index = TIER_ORDER.indexOf(tier);
  return index < 0 ? 0 : index;
}

export function groupTier(kind, speciesObserved, speciesTotal) {
  const rules = MASTERY_RULES[kind];
  if (!rules || speciesObserved <= 0) return "none";

  if (
    Number.isFinite(speciesTotal) &&
    speciesTotal >= 3 &&
    speciesObserved >= speciesTotal
  ) {
    return "complete";
  }

  if (speciesObserved >= rules.thresholds.gold) return "gold";
  if (speciesObserved >= rules.thresholds.silver) return "silver";
  if (speciesObserved >= rules.thresholds.bronze) return "bronze";
  return "none";
}

export function masteryBonusPoints(kind, tier) {
  return MASTERY_RULES[kind]?.perSpeciesBonus[tier] ?? 0;
}

export function masteryBuffPct(kind, tier) {
  return MASTERY_RULES[kind]?.buffPct[tier] ?? 0;
}

export function combinedBuffPct(genusTier, familyTier) {
  return masteryBuffPct("genus", genusTier) + masteryBuffPct("family", familyTier);
}

export function nextTierTarget(kind, tier) {
  const rules = MASTERY_RULES[kind];
  if (!rules) return null;
  if (tier === "none") return { tier: "bronze", threshold: rules.thresholds.bronze };
  if (tier === "bronze") return { tier: "silver", threshold: rules.thresholds.silver };
  if (tier === "silver") return { tier: "gold", threshold: rules.thresholds.gold };
  return null;
}

export function speciesEarnedPoints({ rgObsCount, genusOthers, familyOthers, genusTier, familyTier }) {
  const rg = Math.max(0, Math.floor(rgObsCount ?? 0));
  const base = Math.floor(2 * Math.sqrt(rg));
  const firstBonus = rg >= 1 ? FIRST_RG_BONUS : 0;
  const genusSpill = 2 * Math.max(0, genusOthers ?? 0);
  const familySpill = Math.floor(Math.max(0, familyOthers ?? 0) / 2);
  const genusBonus = masteryBonusPoints("genus", genusTier ?? "none");
  const familyBonus = masteryBonusPoints("family", familyTier ?? "none");

  return {
    base,
    firstBonus,
    genusSpill,
    familySpill,
    genusBonus,
    familyBonus,
    total: base + firstBonus + genusSpill + familySpill + genusBonus + familyBonus
  };
}

export function statCapFor(baseStat) {
  return Math.max(1, Math.floor(Number(baseStat || 0) * STAT_CAP_RATIO));
}

export function sanitizeAllocations(raw) {
  const source = typeof raw === "string" ? safeParse(raw) : raw;
  const clean = {};
  for (const stat of TRAINING_STATS) {
    const value = Math.floor(Number(source?.[stat] ?? 0));
    if (Number.isFinite(value) && value > 0) clean[stat] = value;
  }
  return clean;
}

export function allocationsTotal(allocations) {
  return TRAINING_STATS.reduce((sum, stat) => sum + (allocations?.[stat] ?? 0), 0);
}

export function sanitizeNickname(raw) {
  const nickname = String(raw ?? "")
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, NICKNAME_MAX_LENGTH);
  return nickname || null;
}

function safeParse(json) {
  try {
    return JSON.parse(json);
  } catch {
    return {};
  }
}
