-- Per judge (repo, kind): airlock (it scores, but its verdict doesn't count), its own trust threshold (null: the repo's)
-- and the minimum confidence below which it abstains (null: never). No row means all off.
-- A table rather than judge_config columns because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS judge_settings (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  kind TEXT NOT NULL,
  airlock INTEGER NOT NULL DEFAULT 0,
  min_outcomes INTEGER,
  min_confidence REAL,
  PRIMARY KEY (repo_id, kind)
);
