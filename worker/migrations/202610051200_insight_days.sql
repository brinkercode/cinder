-- Per-repo daily counters for GET /api/repos/:name/insights, bumped as stages report and changes merge or conflict.
CREATE TABLE IF NOT EXISTS insight_days (
  repo_id TEXT NOT NULL,
  day TEXT NOT NULL, -- YYYY-MM-DD, UTC
  tokens INTEGER NOT NULL DEFAULT 0,
  cache_reads INTEGER NOT NULL DEFAULT 0,
  merged INTEGER NOT NULL DEFAULT 0,
  conflicts INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (repo_id, day)
);
