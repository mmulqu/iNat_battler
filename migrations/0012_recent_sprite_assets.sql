CREATE INDEX IF NOT EXISTS idx_sprite_assets_recent_ready
  ON sprite_assets(asset_kind, asset_version, status, created_at DESC);
