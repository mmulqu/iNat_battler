-- Migration 0016: Tile garrison (Biome merge — Bridge 3)
--
-- When a player claims or takes a tile, their current battle team is stored as
-- the tile's garrison (defender snapshot). A contest then resolves as a ghost
-- battle against that snapshot on the tile's real biome terrain (Bridge 2).
-- owner_id / defense_strength / capture_progress / state already exist (0015).

ALTER TABLE tiles ADD COLUMN defender_team_json TEXT;
ALTER TABLE tiles ADD COLUMN claimed_at TEXT;
