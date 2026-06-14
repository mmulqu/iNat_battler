-- Migration 0017: Decoupled garrisons + capture grace window (Bridge 3 refinement)
--
-- A species can defend only ONE tile at a time (garrison exclusivity), so a
-- player's collection is a finite defensive resource. Garrisoning is now a
-- deliberate step decoupled from claiming/attacking:
--   * claim / win-a-contest  -> tile is OWNED but UNDEFENDED, on a 15-min clock
--     (tiles.garrison_deadline set). Contest-locked during this window.
--   * assign a garrison (5 free species) -> defended (garrison_deadline cleared).
--   * deadline passes undefended -> tile reverts to neutral (cron sweep).
--
-- "pending" is detected by garrison_deadline IS NOT NULL (avoids altering the
-- tiles.state CHECK constraint). Defenders live in tile_garrison, one row per
-- (tile, species), which makes the "is this species defending elsewhere?" check
-- a single indexed query.

CREATE TABLE IF NOT EXISTS tile_garrison (
  h3_index TEXT NOT NULL,
  owner_id TEXT NOT NULL REFERENCES users(id),
  taxon_id INTEGER NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (h3_index, taxon_id)
);

CREATE INDEX IF NOT EXISTS idx_tile_garrison_owner ON tile_garrison(owner_id, taxon_id);
CREATE INDEX IF NOT EXISTS idx_tile_garrison_h3 ON tile_garrison(h3_index);

ALTER TABLE tiles ADD COLUMN garrison_deadline TEXT;
