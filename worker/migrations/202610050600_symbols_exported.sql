-- The exported JS functions, classes and variables of an indexed sha; no row means not exported.
-- A table rather than a symbols column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS symbol_exports (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  sha TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha, path, name, kind)
);
