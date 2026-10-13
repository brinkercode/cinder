-- One row per change merged into a target branch: the commit it produced and what System 1 needs to judge it.
-- paths is a JSON array of the files the change touched.
CREATE TABLE IF NOT EXISTS merges (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  sha TEXT NOT NULL,
  change_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  intent TEXT NOT NULL,
  diff_summary TEXT NOT NULL,
  paths TEXT NOT NULL,
  merged_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha)
);
-- A ranked suspect list for a failing test; suspects is the JSON array returned by the API.
CREATE TABLE IF NOT EXISTS regressions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  target TEXT NOT NULL,
  test TEXT NOT NULL,
  suspects TEXT NOT NULL,
  created_at TEXT NOT NULL
);
