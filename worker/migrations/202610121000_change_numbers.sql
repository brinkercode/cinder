-- A change's per-repo number (its key is <REPO>-<number>) and the name of its Artifacts fork. A table rather than changes
-- columns because ALTER TABLE ADD COLUMN can't be replayed. A change without a row has neither.
CREATE TABLE IF NOT EXISTS change_numbers (
  change_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  number INTEGER NOT NULL,
  fork TEXT NOT NULL UNIQUE,
  UNIQUE (repo_id, number)
);
INSERT OR IGNORE INTO change_numbers (change_id, repo_id, number, fork)
  SELECT c.id, c.repo_id, row_number() OVER (PARTITION BY c.repo_id ORDER BY c.created_at, c.id), r.name || '--c' || c.id
  FROM changes c JOIN repos r ON r.id = c.repo_id;
