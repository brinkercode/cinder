-- AI Gateway usage (src/usage.js): one row per gateway log. change_id, agent_version and person are cinder's metadata;
-- a row missing any of them came from an agent run outside cinder.
CREATE TABLE IF NOT EXISTS usage_logs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  at TEXT NOT NULL,
  change_id TEXT,
  agent_version TEXT,
  person TEXT,
  tokens INTEGER NOT NULL CHECK (tokens >= 0),
  cost_usd REAL NOT NULL CHECK (cost_usd >= 0)
);
CREATE INDEX IF NOT EXISTS usage_logs_repo_at ON usage_logs (repo_id, at);
