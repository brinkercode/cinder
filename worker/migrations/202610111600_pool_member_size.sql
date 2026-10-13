-- The size a pool member was started on: a resize leaves busy members on their old Container binding until they finish.
-- No row (members started before this table) means the pool's size. A table rather than a pool_members column because
-- ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS pool_member_sizes (
  runner_id TEXT PRIMARY KEY,
  size TEXT NOT NULL
);
