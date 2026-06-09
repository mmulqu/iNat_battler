CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  inat_user_id INTEGER UNIQUE,
  inat_login TEXT UNIQUE,
  display_name TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS taxa (
  taxon_id INTEGER PRIMARY KEY,
  scientific_name TEXT NOT NULL,
  common_name TEXT,
  rank TEXT,
  iconic_taxon_name TEXT,
  ancestry TEXT,
  parent_id INTEGER,
  default_photo_url TEXT,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS user_taxa (
  user_id TEXT NOT NULL,
  taxon_id INTEGER NOT NULL,
  obs_count INTEGER NOT NULL DEFAULT 0,
  weighted_obs REAL NOT NULL DEFAULT 0,
  bond_level INTEGER NOT NULL DEFAULT 0,
  first_seen_on TEXT,
  last_seen_on TEXT,
  unique_days INTEGER DEFAULT 0,
  unique_months INTEGER DEFAULT 0,
  unique_places INTEGER DEFAULT 0,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (user_id, taxon_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (taxon_id) REFERENCES taxa(taxon_id)
);

CREATE TABLE IF NOT EXISTS creature_genomes (
  taxon_id INTEGER PRIMARY KEY,
  genome_version INTEGER NOT NULL,
  body_plan TEXT NOT NULL,
  ecological_types_json TEXT NOT NULL,
  battle_role TEXT NOT NULL,
  prompt_json TEXT NOT NULL,
  genome_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  FOREIGN KEY (taxon_id) REFERENCES taxa(taxon_id)
);

CREATE TABLE IF NOT EXISTS sprite_assets (
  asset_id TEXT PRIMARY KEY,
  taxon_id INTEGER NOT NULL,
  asset_kind TEXT NOT NULL,
  asset_version INTEGER NOT NULL,
  model TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  r2_key TEXT NOT NULL,
  status TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  content_type TEXT NOT NULL,
  cost_estimate_usd REAL,
  usage_json TEXT,
  created_at TEXT NOT NULL,
  UNIQUE (taxon_id, asset_kind, asset_version, prompt_hash),
  FOREIGN KEY (taxon_id) REFERENCES taxa(taxon_id)
);

CREATE TABLE IF NOT EXISTS sprite_jobs (
  job_id TEXT PRIMARY KEY,
  taxon_id INTEGER NOT NULL,
  asset_kind TEXT NOT NULL,
  asset_version INTEGER NOT NULL,
  prompt_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 100,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (taxon_id, asset_kind, asset_version, prompt_hash),
  FOREIGN KEY (taxon_id) REFERENCES taxa(taxon_id)
);

CREATE TABLE IF NOT EXISTS generation_budget_daily (
  day TEXT PRIMARY KEY,
  generated_count INTEGER NOT NULL DEFAULT 0,
  estimated_cost_usd REAL NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS user_generation_budget_daily (
  user_id TEXT NOT NULL,
  day TEXT NOT NULL,
  queued_count INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, day),
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE INDEX IF NOT EXISTS idx_user_taxa_obs_count
  ON user_taxa(user_id, obs_count DESC);

CREATE INDEX IF NOT EXISTS idx_sprite_assets_taxon_kind
  ON sprite_assets(taxon_id, asset_kind, asset_version, status);

CREATE INDEX IF NOT EXISTS idx_sprite_jobs_status_priority
  ON sprite_jobs(status, priority, created_at);
