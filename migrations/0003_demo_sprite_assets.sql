INSERT INTO users (id, inat_login, display_name, created_at, updated_at)
VALUES ('demo:birds', 'demo_birds', 'Demo Birds', '2026-06-09T00:00:00.000Z', '2026-06-09T00:00:00.000Z')
ON CONFLICT(id) DO UPDATE SET
  display_name = excluded.display_name,
  updated_at = excluded.updated_at;

INSERT INTO taxa (
  taxon_id, scientific_name, common_name, rank,
  iconic_taxon_name, ancestry, parent_id, default_photo_url, updated_at
)
VALUES
  (13858, 'Passer domesticus', 'House Sparrow', 'species', 'Aves', NULL, NULL, NULL, '2026-06-09T00:00:00.000Z'),
  (12727, 'Turdus migratorius', 'American Robin', 'species', 'Aves', NULL, NULL, NULL, '2026-06-09T00:00:00.000Z'),
  (8229, 'Cyanocitta cristata', 'Blue Jay', 'species', 'Aves', NULL, NULL, NULL, '2026-06-09T00:00:00.000Z'),
  (7429, 'Bombycilla garrulus', 'Bohemian Waxwing', 'species', 'Aves', NULL, NULL, NULL, '2026-06-09T00:00:00.000Z'),
  (7428, 'Bombycilla cedrorum', 'Cedar Waxwing', 'species', 'Aves', NULL, NULL, NULL, '2026-06-09T00:00:00.000Z'),
  (9921, 'Piranga olivacea', 'Scarlet Tanager', 'species', 'Aves', NULL, NULL, NULL, '2026-06-09T00:00:00.000Z'),
  (9915, 'Piranga rubra', 'Summer Tanager', 'species', 'Aves', NULL, NULL, NULL, '2026-06-09T00:00:00.000Z'),
  (1965, 'Coccyzus americanus', 'Yellow-billed Cuckoo', 'species', 'Aves', NULL, NULL, NULL, '2026-06-09T00:00:00.000Z')
ON CONFLICT(taxon_id) DO UPDATE SET
  scientific_name = excluded.scientific_name,
  common_name = excluded.common_name,
  rank = excluded.rank,
  iconic_taxon_name = excluded.iconic_taxon_name,
  updated_at = excluded.updated_at;

INSERT INTO user_taxa (
  user_id, taxon_id, obs_count, weighted_obs, bond_level, imported_at
)
VALUES
  ('demo:birds', 13858, 42, 42, 16, '2026-06-09T00:00:00.000Z'),
  ('demo:birds', 12727, 38, 38, 15, '2026-06-09T00:00:00.000Z'),
  ('demo:birds', 8229, 34, 34, 15, '2026-06-09T00:00:00.000Z'),
  ('demo:birds', 7428, 28, 28, 14, '2026-06-09T00:00:00.000Z'),
  ('demo:birds', 1965, 24, 24, 13, '2026-06-09T00:00:00.000Z'),
  ('demo:birds', 7429, 20, 20, 13, '2026-06-09T00:00:00.000Z'),
  ('demo:birds', 9921, 18, 18, 12, '2026-06-09T00:00:00.000Z'),
  ('demo:birds', 9915, 16, 16, 12, '2026-06-09T00:00:00.000Z')
ON CONFLICT(user_id, taxon_id) DO UPDATE SET
  obs_count = excluded.obs_count,
  weighted_obs = excluded.weighted_obs,
  bond_level = excluded.bond_level,
  imported_at = excluded.imported_at;

INSERT INTO sprite_assets (
  asset_id, taxon_id, asset_kind, asset_version, model, prompt_hash,
  r2_key, status, width, height, content_type, cost_estimate_usd, usage_json, created_at
)
VALUES
  ('manual-v1-13858-sprite-sheet', 13858, 'sprite_sheet', 1, 'manual-upload', 'manual-v1', 'species/v1/13858/manual/sprite_sheet.png', 'ready', 1254, 1254, 'image/png', 0, '{}', '2026-06-09T00:00:00.000Z'),
  ('manual-v1-12727-sprite-sheet', 12727, 'sprite_sheet', 1, 'manual-upload', 'manual-v1', 'species/v1/12727/manual/sprite_sheet.png', 'ready', 1254, 1254, 'image/png', 0, '{}', '2026-06-09T00:00:00.000Z'),
  ('manual-v1-8229-sprite-sheet', 8229, 'sprite_sheet', 1, 'manual-upload', 'manual-v1', 'species/v1/8229/manual/sprite_sheet.png', 'ready', 1254, 1254, 'image/png', 0, '{}', '2026-06-09T00:00:00.000Z'),
  ('manual-v1-7429-sprite-sheet', 7429, 'sprite_sheet', 1, 'manual-upload', 'manual-v1', 'species/v1/7429/manual/sprite_sheet.png', 'ready', 1254, 1254, 'image/png', 0, '{}', '2026-06-09T00:00:00.000Z'),
  ('manual-v1-7428-sprite-sheet', 7428, 'sprite_sheet', 1, 'manual-upload', 'manual-v1', 'species/v1/7428/manual/sprite_sheet.png', 'ready', 1254, 1254, 'image/png', 0, '{}', '2026-06-09T00:00:00.000Z'),
  ('manual-v1-9921-sprite-sheet', 9921, 'sprite_sheet', 1, 'manual-upload', 'manual-v1', 'species/v1/9921/manual/sprite_sheet.png', 'ready', 1254, 1254, 'image/png', 0, '{}', '2026-06-09T00:00:00.000Z'),
  ('manual-v1-9915-sprite-sheet', 9915, 'sprite_sheet', 1, 'manual-upload', 'manual-v1', 'species/v1/9915/manual/sprite_sheet.png', 'ready', 1254, 1254, 'image/png', 0, '{}', '2026-06-09T00:00:00.000Z'),
  ('manual-v1-1965-sprite-sheet', 1965, 'sprite_sheet', 1, 'manual-upload', 'manual-v1', 'species/v1/1965/manual/sprite_sheet.png', 'ready', 1254, 1254, 'image/png', 0, '{}', '2026-06-09T00:00:00.000Z')
ON CONFLICT(taxon_id, asset_kind, asset_version, prompt_hash) DO UPDATE SET
  model = excluded.model,
  r2_key = excluded.r2_key,
  status = excluded.status,
  width = excluded.width,
  height = excluded.height,
  content_type = excluded.content_type,
  cost_estimate_usd = excluded.cost_estimate_usd,
  usage_json = excluded.usage_json;
