-- A job's egress proxy counts as reported by its runner: CONNECTs per host, allowed or denied, never payloads.
-- agent is the version the job ran as (name@vN).
CREATE TABLE IF NOT EXISTS job_egress (
  job_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  host TEXT NOT NULL,
  allowed INTEGER NOT NULL CHECK (allowed IN (0, 1)),
  count INTEGER NOT NULL CHECK (count > 0),
  at TEXT NOT NULL,
  PRIMARY KEY (job_id, host, allowed)
);
CREATE INDEX IF NOT EXISTS job_egress_repo_at ON job_egress (repo_id, at);
