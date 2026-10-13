-- Managed worker pools (src/workers.js). repo_id null means any repo; kinds are the flows its workers claim.
CREATE TABLE IF NOT EXISTS worker_pools (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  size TEXT NOT NULL,
  min_count INTEGER NOT NULL CHECK (min_count >= 0),
  max_count INTEGER NOT NULL CHECK (max_count >= min_count),
  repo_id TEXT REFERENCES repos(id),
  kinds TEXT NOT NULL,
  draining INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS pool_members (
  runner_id TEXT PRIMARY KEY REFERENCES runner_tokens(runner_id),
  pool_id TEXT NOT NULL REFERENCES worker_pools(id)
);
