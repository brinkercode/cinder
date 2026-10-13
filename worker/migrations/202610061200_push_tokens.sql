-- One row per push token minted by POST /api/repos/:name/push-token: who got write access to which fork, until when.
-- The token itself is never stored.
CREATE TABLE IF NOT EXISTS push_tokens (
  id TEXT PRIMARY KEY,
  fork TEXT NOT NULL,
  person TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
