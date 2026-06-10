CREATE TABLE IF NOT EXISTS accounts (
  did TEXT PRIMARY KEY,
  handle TEXT NOT NULL,
  display_name TEXT,
  avatar_url TEXT,
  inat_login TEXT,
  inat_user_id INTEGER,
  inat_verified_at TEXT,
  inat_pending_login TEXT,
  inat_verification_code TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_requests (
  state TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  handle TEXT NOT NULL,
  pds_url TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  pkce_verifier TEXT NOT NULL,
  dpop_private_jwk TEXT NOT NULL,
  dpop_public_jwk TEXT NOT NULL,
  return_to TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_sessions (
  session_id TEXT PRIMARY KEY,
  did TEXT NOT NULL,
  pds_url TEXT NOT NULL,
  issuer TEXT NOT NULL,
  client_id TEXT NOT NULL,
  access_token TEXT NOT NULL,
  refresh_token TEXT,
  token_expires_at TEXT,
  dpop_private_jwk TEXT NOT NULL,
  dpop_public_jwk TEXT NOT NULL,
  pds_nonce TEXT,
  auth_nonce TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  FOREIGN KEY (did) REFERENCES accounts(did)
);

CREATE TABLE IF NOT EXISTS challenges (
  challenge_id TEXT PRIMARY KEY,
  challenger_did TEXT NOT NULL,
  challenger_handle TEXT NOT NULL,
  challenger_inat_login TEXT NOT NULL,
  opponent_did TEXT NOT NULL,
  opponent_handle TEXT NOT NULL,
  team_json TEXT NOT NULL,
  message TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  battle_id TEXT,
  post_uri TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_oauth_sessions_did
  ON oauth_sessions(did);

CREATE INDEX IF NOT EXISTS idx_challenges_opponent
  ON challenges(opponent_did, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_challenges_challenger
  ON challenges(challenger_did, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_challenges_battle
  ON challenges(battle_id);
