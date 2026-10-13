-- What a release tag's lock records beyond agent_versions (src/pushes.js): its egress (JSON text) and when it was recorded.
-- A table rather than agent_versions columns because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS agent_releases (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  egress TEXT NOT NULL,
  released_at TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
