-- Bring-your-own runner pools (src/workers.js): runners a team hosts anywhere, grouped by name, with labels and where they run.
CREATE TABLE IF NOT EXISTS byo_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  labels TEXT NOT NULL,
  cloud TEXT,
  region TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS byo_members (
  runner_id TEXT PRIMARY KEY REFERENCES runner_tokens(runner_id),
  pool_id TEXT NOT NULL REFERENCES byo_pools(id)
);
