-- One row per verify job that reported tests. Its results are the test_results rows with the same repo, sha and
-- attempt, so a rerun on the same sha is the next attempt.
CREATE TABLE IF NOT EXISTS verify_runs (
  job TEXT PRIMARY KEY,
  repo TEXT NOT NULL REFERENCES repos(id),
  change_id TEXT NOT NULL,
  sha TEXT NOT NULL,
  attempt INTEGER NOT NULL CHECK (attempt >= 1),
  UNIQUE (repo, sha, attempt)
);
