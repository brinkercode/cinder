-- Scan findings on a repo's target branch (src/findings.js), one row per fingerprint. The fingerprint carries no line
-- number, so a moved finding stays one row. fixed_sha is the full scan that no longer saw it.
CREATE TABLE IF NOT EXISTS findings (
  id INTEGER PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  target TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('secret', 'dependency', 'code', 'egress')),
  rule TEXT NOT NULL,
  severity TEXT NOT NULL,
  path TEXT NOT NULL,
  fingerprint TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'dismissed', 'fixed')),
  first_sha TEXT NOT NULL,
  last_sha TEXT NOT NULL,
  fixed_sha TEXT,
  dismiss_reason TEXT,
  dismissed_by TEXT,
  UNIQUE (repo_id, target, source, fingerprint)
);
