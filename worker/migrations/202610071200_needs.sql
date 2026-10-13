-- Needs you: decisions only a person can make. A resolved item keeps its row (resolution is the action taken,
-- or Dismiss), so raising the same decision again (kind, repo, text) doesn't bring it back.
CREATE TABLE IF NOT EXISTS needs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  repo TEXT NOT NULL,
  change_id TEXT,
  text TEXT NOT NULL,
  actions TEXT NOT NULL,
  created_at TEXT NOT NULL,
  resolution TEXT,
  resolved_at TEXT,
  UNIQUE (kind, repo, text)
);
