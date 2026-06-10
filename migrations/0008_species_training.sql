ALTER TABLE taxa ADD COLUMN genus_id INTEGER;
ALTER TABLE taxa ADD COLUMN genus_name TEXT;
ALTER TABLE taxa ADD COLUMN family_id INTEGER;
ALTER TABLE taxa ADD COLUMN family_name TEXT;

ALTER TABLE user_taxa ADD COLUMN rg_obs_count INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS species_training (
  user_id TEXT NOT NULL,
  taxon_id INTEGER NOT NULL,
  nickname TEXT,
  allocated_json TEXT NOT NULL DEFAULT '{}',
  points_spent INTEGER NOT NULL DEFAULT 0,
  last_respec_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, taxon_id),
  FOREIGN KEY (taxon_id) REFERENCES taxa(taxon_id)
);

CREATE TABLE IF NOT EXISTS user_masteries (
  user_id TEXT NOT NULL,
  group_kind TEXT NOT NULL,
  group_id INTEGER NOT NULL,
  group_name TEXT,
  tier TEXT NOT NULL,
  species_observed INTEGER NOT NULL DEFAULT 0,
  species_total INTEGER,
  achieved_at TEXT,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, group_kind, group_id)
);

CREATE TABLE IF NOT EXISTS taxon_info_cache (
  taxon_id INTEGER PRIMARY KEY,
  rank TEXT,
  name TEXT,
  complete_species_count INTEGER,
  fetched_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_species_training_user
  ON species_training(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_masteries_user
  ON user_masteries(user_id, group_kind);

CREATE INDEX IF NOT EXISTS idx_taxa_genus
  ON taxa(genus_id);

CREATE INDEX IF NOT EXISTS idx_taxa_family
  ON taxa(family_id);
