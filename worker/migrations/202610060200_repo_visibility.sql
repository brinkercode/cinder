-- Repo visibility: only 'instance' repos appear in discovery (GET /api/explore); set with PUT /api/repos/:name/settings.
-- No row means private. A table rather than a repos column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS repo_visibility (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  visibility TEXT NOT NULL CHECK (visibility IN ('private', 'instance'))
);
