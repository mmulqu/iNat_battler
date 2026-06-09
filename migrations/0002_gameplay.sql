CREATE TABLE IF NOT EXISTS teams (
  team_id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL,
  name TEXT NOT NULL,
  slots_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (user_id) REFERENCES users(id)
);

CREATE TABLE IF NOT EXISTS battle_instances (
  battle_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL,
  attacker_user_id TEXT NOT NULL,
  defender_user_id TEXT,
  npc_template_id TEXT,
  state_json TEXT NOT NULL,
  seed TEXT NOT NULL,
  turn INTEGER NOT NULL,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS battle_results (
  battle_id TEXT PRIMARY KEY,
  winner_user_id TEXT,
  loser_user_id TEXT,
  result_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_teams_user
  ON teams(user_id, updated_at DESC);

CREATE INDEX IF NOT EXISTS idx_battles_attacker
  ON battle_instances(attacker_user_id, created_at DESC);
