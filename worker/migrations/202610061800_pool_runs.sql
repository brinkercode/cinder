-- One row per job a managed pool worker started (src/work.js claimWork); start_s = seconds from queued to claimed.
-- Kept apart from pool_members, which forgets a worker once it stops. GET /api/workers/pools reads the last hour.
CREATE TABLE IF NOT EXISTS pool_runs (
  job_id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  start_s REAL NOT NULL,
  started_at TEXT NOT NULL
);
