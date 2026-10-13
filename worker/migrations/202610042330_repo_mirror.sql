-- The repo's GitHub mirror; the merge job pushes the merged target branch there. No row means no mirror.
-- A table rather than a repos column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS repo_mirrors (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  mirror_url TEXT NOT NULL
);
