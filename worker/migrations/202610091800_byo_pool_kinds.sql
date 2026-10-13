-- The job kinds a BYO pool's workers may register for (src/runners.js), a JSON list; a pool without a row takes every
-- BYO kind except flow. A table because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS byo_pool_kinds (
  pool_id TEXT PRIMARY KEY REFERENCES byo_pools(id),
  kinds TEXT NOT NULL
);
