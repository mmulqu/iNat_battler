-- Autonomous battle-highlight bot (docs/battle-highlights-bluesky.md).

-- Per-user opt-in: the bot only features battles whose owner opted in.
ALTER TABLE users ADD COLUMN allow_highlight_bot INTEGER NOT NULL DEFAULT 0;

-- Dedupe + daily-cap ledger: one row per battle the curator has acted on.
CREATE TABLE IF NOT EXISTS battle_highlights (
  battle_id  TEXT PRIMARY KEY,
  user_id    TEXT,
  status     TEXT NOT NULL,          -- 'posted' | 'failed' | 'skipped'
  score      REAL,
  post_uri   TEXT,
  error      TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_battle_highlights_created ON battle_highlights (created_at);
CREATE INDEX IF NOT EXISTS idx_battle_highlights_status ON battle_highlights (status);
