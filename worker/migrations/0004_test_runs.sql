-- Per-test history: one row per test per verified commit. duration is seconds.
CREATE TABLE IF NOT EXISTS test_runs (
  repo TEXT NOT NULL REFERENCES repos(id),
  sha TEXT NOT NULL,
  test TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('pass', 'fail', 'skip')),
  duration REAL NOT NULL CHECK (duration >= 0),
  PRIMARY KEY (repo, sha, test)
);
