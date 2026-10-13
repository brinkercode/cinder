-- The commit a change's merge job landed on its target: a squash merge's commit is not the change's head.
-- A table rather than a change_heads column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS change_merged_shas (
  change_id TEXT PRIMARY KEY REFERENCES changes(id),
  merged_sha TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_merged_shas_sha ON change_merged_shas (merged_sha);
