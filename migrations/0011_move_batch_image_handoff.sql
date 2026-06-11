ALTER TABLE move_batches
  ADD COLUMN auto_submit_images INTEGER NOT NULL DEFAULT 0;

ALTER TABLE move_batches
  ADD COLUMN image_batch_id TEXT;

ALTER TABLE move_batches
  ADD COLUMN image_submit_status TEXT;

ALTER TABLE move_batches
  ADD COLUMN image_submit_error TEXT;

ALTER TABLE move_batches
  ADD COLUMN image_submitted_at TEXT;

CREATE INDEX IF NOT EXISTS idx_move_batches_auto_submit
  ON move_batches(auto_submit_images, image_batch_id, status, created_at DESC);
