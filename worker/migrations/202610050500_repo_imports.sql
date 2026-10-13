-- An imported repo's import, while it isn't finished: Artifacts imports asynchronously. No row means the repo is ready.
-- A table rather than a repos column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS repo_imports (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  state TEXT NOT NULL CHECK (state IN ('importing', 'failed')),
  reason TEXT
);
