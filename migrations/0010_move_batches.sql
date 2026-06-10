CREATE TABLE IF NOT EXISTS move_batches (
  batch_id TEXT PRIMARY KEY,
  input_file_id TEXT NOT NULL,
  output_file_id TEXT,
  status TEXT NOT NULL,
  model TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  applied_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  taxon_ids_json TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_move_batches_status
  ON move_batches(status, created_at DESC);
