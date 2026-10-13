-- The dependency inventory a done scan saw (src/scans.js), a JSON list read by GET /api/repos/:name/dependencies.
-- A table rather than a scans column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS scan_deps (
  job_id TEXT PRIMARY KEY REFERENCES scans(job_id),
  deps TEXT NOT NULL
);
