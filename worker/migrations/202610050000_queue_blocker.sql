-- The last blocker reason from RepoDO's queue re-evaluation (src/queue.js evaluateHead), null when the head was clear.
-- A table rather than a queue_entries column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS queue_blockers (
  change_id TEXT PRIMARY KEY,
  reason TEXT
);
