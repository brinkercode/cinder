-- Pool settings (src/workers.js), keyed by worker_pools.id or byo_pools.id. A pool without a row has the column defaults.
-- A BYO pool's labels, cloud and region stay on byo_pools; labels here are a managed pool's. egress is allowlist, none or open;
-- egress_allow holds host patterns (path.Match syntax, runner/internal/egress).
CREATE TABLE IF NOT EXISTS pool_settings (
  pool_id TEXT PRIMARY KEY,
  labels TEXT NOT NULL DEFAULT '[]',
  max_concurrent INTEGER NOT NULL DEFAULT 8 CHECK (max_concurrent >= 1),
  keep_warm_s INTEGER NOT NULL DEFAULT 60 CHECK (keep_warm_s >= 0),
  placement TEXT NOT NULL DEFAULT 'nearest',
  egress TEXT NOT NULL DEFAULT 'allowlist' CHECK (egress IN ('allowlist', 'none', 'open')),
  egress_allow TEXT NOT NULL DEFAULT '[]'
);
-- The repos a pool serves; a pool without rows serves every repo.
CREATE TABLE IF NOT EXISTS pool_repos (
  pool_id TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  PRIMARY KEY (pool_id, repo_id)
);
INSERT INTO pool_repos (pool_id, repo_id) SELECT id, repo_id FROM worker_pools WHERE repo_id IS NOT NULL ON CONFLICT DO NOTHING;
