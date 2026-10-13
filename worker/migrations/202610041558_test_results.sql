-- One row per test attempt, so a rerun on the same sha has a place to go; a fail then a pass on one sha is a flake.
-- Supersedes test_runs (one row per test per sha), which nothing ever wrote.
CREATE TABLE IF NOT EXISTS test_results (
  repo TEXT NOT NULL REFERENCES repos(id),
  sha TEXT NOT NULL,
  test TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'skip')),
  duration REAL NOT NULL CHECK (duration >= 0),
  PRIMARY KEY (repo, sha, test, attempt)
);

-- A test whose flake rate is above flake_quarantine is quarantined. No row means the default, 0.2.
CREATE TABLE IF NOT EXISTS repo_settings (
  repo TEXT PRIMARY KEY REFERENCES repos(id),
  flake_quarantine REAL NOT NULL CHECK (flake_quarantine >= 0 AND flake_quarantine <= 1)
);
