-- The byo_pool_tokens row a worker registered with (src/runners.js createRunner). Once that token is revoked the worker
-- is refused at its next claim (src/work.js claimWork). A table because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS byo_member_tokens (
  runner_id TEXT PRIMARY KEY REFERENCES runner_tokens(runner_id),
  pool_token_id TEXT NOT NULL
);
