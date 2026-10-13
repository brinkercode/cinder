-- When each change merged (written by its ChangeDO), so a follow-up naming it within 14 days scores its risk judgments.
CREATE TABLE IF NOT EXISTS change_merges (
  change_id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  merged_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS change_merges_repo_at ON change_merges (repo_id, merged_at);
