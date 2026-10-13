-- The dependencies a done scan saw whose license the dependency policy doesn't clear on its own (class copyleft or
-- unknown, as merge/blockers.js asks an owner to approve). GET /api/repos/:name/posture reads the latest scan's rows.
CREATE TABLE IF NOT EXISTS scan_licenses (
  job_id TEXT NOT NULL REFERENCES scans(job_id),
  ecosystem TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  license TEXT NOT NULL,
  class TEXT NOT NULL CHECK (class IN ('copyleft', 'unknown'))
);
