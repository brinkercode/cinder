-- One row per declaration ("path#name") a converge resolved by structured merge; wrong_at is set when another
-- change on the target touches it within 7 days, so wrong / all is the wrong-merge rate.
CREATE TABLE IF NOT EXISTS merge_resolutions (
  repo_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  change_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  resolved_at TEXT NOT NULL,
  wrong_at TEXT
);
CREATE INDEX IF NOT EXISTS merge_resolutions_target ON merge_resolutions (repo_id, target_branch, symbol);
