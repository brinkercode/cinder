-- Per-target merge queue (docs/DESIGN.md §6). Order is seq; a change re-entering the queue is replaced at the back.
-- Only entries whose change is still in_queue count (src/queue.js).
CREATE TABLE IF NOT EXISTS queue_entries (
  seq INTEGER PRIMARY KEY,
  change_id TEXT NOT NULL UNIQUE,
  repo_id TEXT NOT NULL,
  target_branch TEXT NOT NULL,
  enqueued_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS queue_entries_repo_target ON queue_entries (repo_id, target_branch, seq);
