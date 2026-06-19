-- Personal API keys / personal access tokens for non-browser clients (agents,
-- scripts, MCP wrappers). A key maps to the same account record as the browser
-- session, so every existing authenticated endpoint works for agents without a
-- separate "bot account". Tokens are shown once and stored only as a sha-256
-- hash. See docs/agent-player-integration-plan.md.
CREATE TABLE IF NOT EXISTS api_keys (
  api_key_id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  label TEXT NOT NULL,
  scopes TEXT NOT NULL DEFAULT 'full',
  created_at TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_api_keys_did ON api_keys(did);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);
