-- Migration 0015: Territory layer (Biome merge — Bridge 1)
--
-- Folds the Biome H3-tile territory model into the battler DB. Identity is NOT
-- duplicated: Biome's separate `players` table and its own iNat verification flow
-- are dropped entirely. Territory rows hang off the battler's existing identity:
--   accounts(did)  -> Bluesky OAuth + iNat verification (the canonical flow)
--   users(id TEXT) -> game-data anchor, id = 'inat:<login>', has inat_user_id
-- So tile ownership and territory observations reference users(id) (TEXT).
--
-- Tile *biome* data (tile_biomes + landcover_classes) is ported verbatim from
-- Biome migration 0002 and is re-imported from the local landcover_export JSONL
-- (biome-db on Cloudflare was deleted; the JSONL is the source of truth).

-- ============================================
-- LANDCOVER REFERENCE (Copernicus Global Land Cover) — verbatim from Biome 0002
-- ============================================

CREATE TABLE IF NOT EXISTS landcover_classes (
    code INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    biome_type TEXT NOT NULL,
    color TEXT NOT NULL,
    description TEXT
);

INSERT OR REPLACE INTO landcover_classes (code, name, biome_type, color, description) VALUES
    (0, 'unknown', 'unknown', '#808080', 'Unknown or no data'),
    (20, 'shrubs', 'shrubland', '#ccb35c', 'Shrubland'),
    (30, 'herbaceous', 'grassland', '#b8e05c', 'Herbaceous vegetation / Grassland'),
    (40, 'cultivated', 'agricultural', '#e9d35f', 'Cultivated and managed vegetation'),
    (50, 'urban', 'urban', '#e60000', 'Urban / built up'),
    (60, 'bare_sparse', 'desert', '#c4b79f', 'Bare / sparse vegetation'),
    (70, 'snow_ice', 'polar', '#f0f0f0', 'Snow and ice'),
    (80, 'water', 'freshwater', '#0064c8', 'Permanent water bodies'),
    (90, 'wetland', 'wetland', '#009696', 'Herbaceous wetland'),
    (100, 'moss_lichen', 'tundra', '#7dd67d', 'Moss and lichen'),
    (111, 'forest_evergreen_needle', 'forest', '#006400', 'Closed forest, evergreen needle leaf'),
    (112, 'forest_evergreen_broad', 'forest', '#00a000', 'Closed forest, evergreen broad leaf'),
    (113, 'forest_deciduous_needle', 'forest', '#aac800', 'Closed forest, deciduous needle leaf'),
    (114, 'forest_deciduous_broad', 'forest', '#68c800', 'Closed forest, deciduous broad leaf'),
    (115, 'forest_mixed', 'forest', '#00c800', 'Closed forest, mixed'),
    (116, 'forest_unknown', 'forest', '#32c832', 'Closed forest, not matching any definition'),
    (121, 'forest_open_evergreen_needle', 'woodland', '#88a000', 'Open forest, evergreen needle leaf'),
    (122, 'forest_open_evergreen_broad', 'woodland', '#78c800', 'Open forest, evergreen broad leaf'),
    (123, 'forest_open_deciduous_needle', 'woodland', '#a0c000', 'Open forest, deciduous needle leaf'),
    (124, 'forest_open_deciduous_broad', 'woodland', '#90c800', 'Open forest, deciduous broad leaf'),
    (125, 'forest_open_mixed', 'woodland', '#78c864', 'Open forest, mixed'),
    (126, 'forest_open_unknown', 'woodland', '#6bc864', 'Open forest, not matching any definition'),
    (200, 'ocean', 'ocean', '#000080', 'Oceans and seas');

-- ============================================
-- TILE BIOMES (precomputed H3 -> majority landcover) — verbatim from Biome 0002
-- Re-imported from landcover_export/landcover_res{N}.jsonl.
-- ============================================

CREATE TABLE IF NOT EXISTS tile_biomes (
    h3_index TEXT PRIMARY KEY,
    resolution INTEGER NOT NULL,
    landcover_code INTEGER NOT NULL DEFAULT 0,
    biome_type TEXT NOT NULL DEFAULT 'unknown',
    created_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tile_biomes_resolution ON tile_biomes(resolution);
CREATE INDEX IF NOT EXISTS idx_tile_biomes_biome ON tile_biomes(biome_type);

-- ============================================
-- FACTIONS (flavor + map color) — seeded from Biome 0001
-- ============================================

CREATE TABLE IF NOT EXISTS factions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    color TEXT NOT NULL,
    description TEXT,
    created_at TEXT DEFAULT (datetime('now'))
);

INSERT OR IGNORE INTO factions (id, name, color, description) VALUES
    (1, 'Verdant Circle', '#22c55e', 'Guardians of forests and plant life'),
    (2, 'Azure Wing',     '#3b82f6', 'Champions of birds and sky dwellers'),
    (3, 'Crimson Hive',   '#ef4444', 'Protectors of insects and pollinators'),
    (4, 'Amber Spore',    '#f59e0b', 'Seekers of fungi and decomposers');

-- ============================================
-- TERRITORY PLAYERS (AP + territory stats, keyed to the battler's users(id))
-- Replaces Biome's `players` table — identity stays in accounts/users.
-- ============================================

CREATE TABLE IF NOT EXISTS territory_players (
    user_id TEXT PRIMARY KEY REFERENCES users(id),

    faction_id INTEGER REFERENCES factions(id),

    -- Action Points
    action_points INTEGER NOT NULL DEFAULT 0,
    ap_earned_today INTEGER NOT NULL DEFAULT 0,
    last_ap_reset TEXT,

    -- Cached stats
    tiles_owned INTEGER NOT NULL DEFAULT 0,
    total_territory_observations INTEGER NOT NULL DEFAULT 0,

    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_territory_players_faction ON territory_players(faction_id);

-- ============================================
-- TILES (territory state) — owner is the battler's users(id) (TEXT), not an int
-- ============================================

CREATE TABLE IF NOT EXISTS tiles (
    h3_index TEXT PRIMARY KEY,
    resolution INTEGER NOT NULL,

    -- Biome of this tile (mirrors tile_biomes.biome_type at claim time; the
    -- landcover-derived set is the single source of truth, no narrow CHECK).
    biome_type TEXT NOT NULL DEFAULT 'unknown',

    state TEXT NOT NULL DEFAULT 'neutral'
        CHECK (state IN ('neutral', 'claimed', 'fortified', 'contested')),

    -- Ownership (battler identity)
    owner_id TEXT REFERENCES users(id),
    owner_faction_id INTEGER REFERENCES factions(id),
    capture_progress INTEGER NOT NULL DEFAULT 0,   -- 0-100
    defense_strength INTEGER NOT NULL DEFAULT 0,   -- fortification / home-field buff source

    -- Contest tracking
    contester_id TEXT REFERENCES users(id),
    contest_progress INTEGER NOT NULL DEFAULT 0,
    last_contested_at TEXT,

    -- Ecological value (drives yield / scoring — Bridge 3+)
    total_observations INTEGER NOT NULL DEFAULT 0,
    unique_species INTEGER NOT NULL DEFAULT 0,

    last_activity_at TEXT DEFAULT (datetime('now')),
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tiles_owner ON tiles(owner_id);
CREATE INDEX IF NOT EXISTS idx_tiles_state ON tiles(state);
CREATE INDEX IF NOT EXISTS idx_tiles_biome ON tiles(biome_type);

-- ============================================
-- TERRITORY OBSERVATIONS (the "one observation stream", map side)
-- Per-observation geo, fanned out from the unified iNat sync. Combat side keeps
-- writing user_taxa as today; this table adds the geo/tile dimension Biome needs.
-- ============================================

CREATE TABLE IF NOT EXISTS tile_observations (
    inat_observation_id INTEGER PRIMARY KEY,   -- dedupe key (same as Biome)
    user_id TEXT NOT NULL REFERENCES users(id),

    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    h3_index TEXT NOT NULL,                     -- computed client/worker-side from lat/lng

    taxon_id INTEGER,
    taxon_name TEXT,
    iconic_taxon_name TEXT,
    quality_grade TEXT,

    observed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tile_obs_user ON tile_observations(user_id);
CREATE INDEX IF NOT EXISTS idx_tile_obs_h3 ON tile_observations(h3_index);
CREATE INDEX IF NOT EXISTS idx_tile_obs_taxon ON tile_observations(taxon_id);

-- ============================================
-- TERRITORY ACTIONS (AP spend log — claim/fortify/scout/contest)
-- ============================================

CREATE TABLE IF NOT EXISTS territory_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users(id),
    h3_index TEXT NOT NULL,

    action_type TEXT NOT NULL CHECK (action_type IN ('claim', 'fortify', 'scout', 'contest')),
    ap_spent INTEGER NOT NULL DEFAULT 1,

    progress_added INTEGER NOT NULL DEFAULT 0,
    battle_id TEXT,                            -- set when a contest resolves via a battle (Bridge 3)
    result TEXT,                               -- JSON

    created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_territory_actions_user ON territory_actions(user_id);
CREATE INDEX IF NOT EXISTS idx_territory_actions_h3 ON territory_actions(h3_index);
CREATE INDEX IF NOT EXISTS idx_territory_actions_created ON territory_actions(created_at);
