-- One row per environment sync (src/deploy.js syncEnvironment): the environment's status is its latest row, the rest is history.
CREATE TABLE IF NOT EXISTS deploy_syncs (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  env TEXT NOT NULL,
  sha TEXT NOT NULL,
  version_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('Synced', 'OutOfSync', 'Progressing', 'Degraded', 'Failed')),
  changes TEXT NOT NULL,
  actor TEXT NOT NULL,
  started_at TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS deploy_syncs_env ON deploy_syncs (repo, env, started_at);
