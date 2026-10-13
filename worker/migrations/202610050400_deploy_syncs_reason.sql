-- Why a sync was rolled back: the person's reason for a manual rollback, the failed health check for an automatic one.
-- A table rather than a deploy_syncs column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS deploy_sync_reasons (
  sync_id TEXT PRIMARY KEY REFERENCES deploy_syncs(id),
  reason TEXT NOT NULL
);
