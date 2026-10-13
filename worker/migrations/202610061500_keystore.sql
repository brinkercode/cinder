-- The keystore: every key and secret, encrypted at rest with AES-GCM under the
-- KEYSTORE_KEY Worker secret. iv and ciphertext are base64; the value is never selected by a GET.
CREATE TABLE IF NOT EXISTS keystore_secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('runner_token', 'worker_token', 'deploy_token', 'import_credential', 'flow_secret', 'environment_secret', 'agent_secret', 'api_key')),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'repo', 'environment', 'flow')),
  repo TEXT,
  environment TEXT,
  flow TEXT,
  owner TEXT NOT NULL,
  expires_at TEXT,
  iv TEXT NOT NULL,
  ciphertext TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);
CREATE INDEX IF NOT EXISTS keystore_secrets_name ON keystore_secrets (name);

CREATE TABLE IF NOT EXISTS keystore_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secret_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'rotate', 'read')),
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS keystore_audit_secret ON keystore_audit (secret_id, id);
