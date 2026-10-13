-- The traffic percentage a sync last deployed (src/deploy.js syncEnvironment): the environment's rollout step.
-- A table rather than a deploy_syncs column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS deploy_sync_steps (
  sync_id TEXT PRIMARY KEY REFERENCES deploy_syncs (id),
  step INTEGER NOT NULL
);
