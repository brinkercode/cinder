-- One row per registered runner token. Only the SHA-256 hex of the token is stored, never the token.
CREATE TABLE IF NOT EXISTS runner_tokens (
  runner_id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kinds TEXT NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL
);
