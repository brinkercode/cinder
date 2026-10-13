-- A compare job's result per base/head sha pair: commits and per-file diffs, already truncated (compare.js). result is JSON.
CREATE TABLE IF NOT EXISTS compares (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  base_sha TEXT NOT NULL,
  head_sha TEXT NOT NULL,
  result TEXT NOT NULL,
  PRIMARY KEY (repo_id, base_sha, head_sha)
);
