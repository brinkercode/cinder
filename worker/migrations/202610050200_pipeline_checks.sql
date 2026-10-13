-- One cinder-pipeline check result per pushed (repo, sha); a rerun of the same sha replaces it.
CREATE TABLE IF NOT EXISTS pipeline_checks (
  repo TEXT NOT NULL,
  sha TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail')),
  logs TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo, sha)
);
