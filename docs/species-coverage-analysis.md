# US Species Coverage Analysis — how many sprites do we need?

**Source:** iNaturalist `observations/species_counts?place_id=1&quality_grade=research&rank=species`
(United States, **all taxa** — no kingdom filter; fungi/plants/animals ranked together),
pulled 2026-06-18 (`scripts`/ad-hoc; counts in `C:\tmp\us_counts.txt`).

**Dataset:** 91,794 distinct research-grade species · 82.0M species-level observations
(85.3M total RG obs incl. coarser IDs). Research-grade is what a player's roster is built
from, so this curve is a strong proxy for "how many sprites cover what people actually log."

## Coverage curve (top N species → % of US RG observations)

| Sprites (top N) | % of US sightings |
|---|---|
| 500 | 39.5% |
| 1,000 | 52.5% |
| **2,000 (≈ current)** | **66.5%** |
| 3,000 | 74.3% |
| 5,000 | 83.2% |
| 8,000 | 89.9% |
| 10,000 | 92.4% |
| 15,000 | 95.9% |
| 20,000 | 97.6% |

Thresholds: 50% = top **881** · 80% = **4,122** · 90% = **8,092** · 95% = **13,280** ·
99% = **28,915**.

## The long tail

- Species with ≥10k obs: **1,667** · ≥1k: **9,079** · ≥100: **26,112** · ≥10: **52,613**.
- **14,705 species have exactly ONE** US observation; median species has just **16**.
  ~half of all species have <16 obs.
- The last 10% of coverage (90%→99%) costs ~**21,000** extra sprites — pure diminishing
  returns (you'd be drawing one-observation species).

## Recommendation

- Current ~2,000 sprites already cover **~67%** of US sightings.
- **Knee of the curve ≈ 5,000–8,000 sprites (83%→90%).** Past ~10k is not worth it.
- **Sweet spot ≈ 5,000 (~83%)**: roughly doubles coverage for ~$120 (empirical ~$0.04/
  sprite all-in) and ~4 GB R2 total (within the 10 GB free tier). 8,000 (90%) ≈ ~$240 /
  ~7 GB.

## Current gap vs. the US top-5,000 (as of 2026-06-18) — HELD, not generated

Diffed the US top-5,000 RG species against our ~2,002 ready sprites:

- **Already have: 1,431 · Need to generate: 3,569** (the full list is in
  `data/us-top5000-missing.csv`).
- By rank: only **176 missing in the top 1,000** (our NA+Europe seed covers the very
  common ones), **624** in 1k–2k, **884** in 2k–3k, **1,885** in 3k–5k.
- By group: Plantae 1,631 · Insecta 935 · Aves 269 · Fungi 186 · Reptilia 118 ·
  Arachnida 105 · Mollusca 104 · Mammalia 72.
- Examples we're missing (common US species absent from the Euro-leaning seed): Lesser
  Goldfinch, White Ibis, Pied-billed Grebe, California Scrub-Jay, Pipevine Swallowtail,
  Carolina Chickadee.

Generating all 3,569 → ~83% US coverage. **~$143 OpenAI + ~3.2 GB R2.** Decision
2026-06-18: **hold** — list kept for later. To queue: bulk-import the taxa (they have full
objects re-fetchable from iNat, 10 pages) → move/genome batches → image batches (≤175
slices) → sync → re-run the ancestor backfill so the sprite tree stays complete.

## Caveat on "90% of users"

This is *observation* coverage, not per-user roster coverage
(we don't have many users' rosters). At top-8,000, a random logged species has ~90% odds of
being one we've drawn; covering every user's *entire* roster (incl. their rare tail finds)
is effectively impossible. Also US-only — the live roster was seeded from NA+Europe, so when
extending we diff the US target list against sprites we already have.
