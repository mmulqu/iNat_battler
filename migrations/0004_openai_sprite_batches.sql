CREATE TABLE IF NOT EXISTS openai_sprite_batches (
  batch_id TEXT PRIMARY KEY,
  input_file_id TEXT NOT NULL,
  output_file_id TEXT,
  error_file_id TEXT,
  endpoint TEXT NOT NULL,
  model TEXT NOT NULL,
  status TEXT NOT NULL,
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS openai_sprite_batch_items (
  batch_id TEXT NOT NULL,
  custom_id TEXT NOT NULL,
  job_id TEXT NOT NULL,
  taxon_id INTEGER NOT NULL,
  status TEXT NOT NULL,
  r2_key TEXT,
  usage_json TEXT,
  error TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (batch_id, custom_id),
  FOREIGN KEY (batch_id) REFERENCES openai_sprite_batches(batch_id),
  FOREIGN KEY (job_id) REFERENCES sprite_jobs(job_id),
  FOREIGN KEY (taxon_id) REFERENCES taxa(taxon_id)
);

CREATE INDEX IF NOT EXISTS idx_openai_sprite_batch_items_job
  ON openai_sprite_batch_items(job_id);

CREATE INDEX IF NOT EXISTS idx_openai_sprite_batch_items_status
  ON openai_sprite_batch_items(status, updated_at);
