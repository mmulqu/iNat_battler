-- Indexes for two hot read paths, to cut D1 rows-read (and cost).

-- Leaderboard joins resolve a player's current account via a correlated
-- subquery: `SELECT did FROM accounts WHERE inat_login = u.inat_login
-- ORDER BY updated_at DESC LIMIT 1`, run once per leaderboard row. Without an
-- index on inat_login that is a full table scan of accounts per row; this turns
-- it into a seek. updated_at DESC is included so the ORDER BY/LIMIT is covered.
CREATE INDEX IF NOT EXISTS idx_accounts_inat_login
  ON accounts(inat_login, updated_at DESC);

-- The highlight curator scans recent finished battles every cron tick:
-- `WHERE status = 'won' AND created_at >= ? ORDER BY created_at DESC`.
CREATE INDEX IF NOT EXISTS idx_battle_instances_status_created
  ON battle_instances(status, created_at DESC);
