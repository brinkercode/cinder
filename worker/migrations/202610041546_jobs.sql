-- Jobs for runners. Columns follow Job in src/api/contract.js; payload is the job's JSON input.
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  change_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'claimed', 'done', 'failed')),
  runner_id TEXT,
  lease_expires_at TEXT,
  created_at TEXT NOT NULL,
  payload TEXT NOT NULL
);
