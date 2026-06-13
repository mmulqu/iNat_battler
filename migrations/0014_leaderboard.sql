CREATE TABLE IF NOT EXISTS player_ratings (
  user_id TEXT PRIMARY KEY,
  rating REAL NOT NULL DEFAULT 1000,
  wins INTEGER NOT NULL DEFAULT 0,
  losses INTEGER NOT NULL DEFAULT 0,
  draws INTEGER NOT NULL DEFAULT 0,
  battles INTEGER NOT NULL DEFAULT 0,
  win_streak INTEGER NOT NULL DEFAULT 0,
  best_streak INTEGER NOT NULL DEFAULT 0,
  fastest_win_turns INTEGER,
  last_result TEXT,
  last_battle_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_player_ratings_rating
  ON player_ratings(rating DESC);
