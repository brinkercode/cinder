-- Symbols from `cinder-verify symbols` at one commit; start and end are 1-based lines.
-- symbol_indexes marks a (repo, sha) as indexed, so a commit with no symbols is not re-queued.
CREATE TABLE IF NOT EXISTS symbol_indexes (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  sha TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha)
);
CREATE TABLE IF NOT EXISTS symbols (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  sha TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  start_line INTEGER NOT NULL,
  end_line INTEGER NOT NULL,
  UNIQUE (repo_id, sha, path, name, kind, start_line)
);
