-- One-time pool tokens (src/workers.js mintPoolToken): anyone holding one registers runners into its BYO pool until
-- expires_at. Only the SHA-256 (hex) is stored; used_at is the first registration.
CREATE TABLE IF NOT EXISTS byo_pool_tokens (
  id TEXT PRIMARY KEY,
  pool_id TEXT NOT NULL,
  token_hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
