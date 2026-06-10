CREATE TABLE IF NOT EXISTS user_sprite_submissions (
  submission_id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  user_id TEXT NOT NULL,
  taxon_id INTEGER NOT NULL,
  r2_key TEXT NOT NULL,
  content_type TEXT NOT NULL,
  width INTEGER,
  height INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  discord_message_id TEXT,
  discord_channel_id TEXT,
  discord_error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  decided_at TEXT,
  FOREIGN KEY (did) REFERENCES accounts(did),
  FOREIGN KEY (taxon_id) REFERENCES taxa(taxon_id)
);

CREATE INDEX IF NOT EXISTS idx_user_sprites_user_taxon
  ON user_sprite_submissions(user_id, taxon_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_user_sprites_status
  ON user_sprite_submissions(status, created_at);

CREATE INDEX IF NOT EXISTS idx_user_sprites_did
  ON user_sprite_submissions(did, created_at DESC);
