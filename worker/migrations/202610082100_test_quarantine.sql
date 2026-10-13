-- A test whose flake rate reached the repo's flake_quarantine; its failures leave the verify verdict while released_at
-- is NULL. A released test keeps its row, so it is not quarantined again on its own.
CREATE TABLE IF NOT EXISTS test_quarantine (
  repo TEXT NOT NULL REFERENCES repos(id),
  test TEXT NOT NULL,
  flake_rate REAL NOT NULL CHECK (flake_rate >= 0 AND flake_rate <= 1),
  since TEXT NOT NULL,
  released_at TEXT,
  PRIMARY KEY (repo, test)
);
