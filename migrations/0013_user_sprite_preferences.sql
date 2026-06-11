CREATE TABLE IF NOT EXISTS user_sprite_preferences (
  user_id TEXT NOT NULL,
  taxon_id INTEGER NOT NULL,
  asset_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (user_id, taxon_id),
  FOREIGN KEY (user_id, taxon_id) REFERENCES user_taxa(user_id, taxon_id),
  FOREIGN KEY (asset_id) REFERENCES sprite_assets(asset_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sprite_preferences_asset
  ON user_sprite_preferences(asset_id);
