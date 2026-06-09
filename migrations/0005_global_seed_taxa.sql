CREATE TABLE IF NOT EXISTS global_seed_taxa (
  seed_key TEXT NOT NULL,
  group_key TEXT NOT NULL,
  taxon_id INTEGER NOT NULL,
  observed_count INTEGER NOT NULL DEFAULT 0,
  region_keys TEXT NOT NULL,
  source_json TEXT,
  imported_at TEXT NOT NULL,
  PRIMARY KEY (seed_key, group_key, taxon_id),
  FOREIGN KEY (taxon_id) REFERENCES taxa(taxon_id)
);

CREATE INDEX IF NOT EXISTS idx_global_seed_taxa_taxon
  ON global_seed_taxa(taxon_id);

CREATE INDEX IF NOT EXISTS idx_global_seed_taxa_group_count
  ON global_seed_taxa(seed_key, group_key, observed_count DESC);
