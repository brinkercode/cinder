-- Secrets move to Cloudflare: keystore values live in the account's Secrets Store and model keys in AI Gateway
-- stored keys. Cinder keeps only references, never a value, an iv or a ciphertext. The rows before were seed data
-- so they and their audit go; the seed recreates them in Secrets Store.
DROP TABLE IF EXISTS keystore_secrets;
CREATE TABLE keystore_secrets (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('runner_token', 'worker_token', 'deploy_token', 'import_credential', 'flow_secret', 'environment_secret', 'agent_secret', 'api_key')),
  scope TEXT NOT NULL CHECK (scope IN ('global', 'repo', 'environment', 'flow')),
  repo TEXT,
  environment TEXT,
  flow TEXT,
  owner TEXT NOT NULL,
  expires_at TEXT,
  store_id TEXT NOT NULL,
  store_secret_id TEXT NOT NULL,
  store_secret_name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  rotated_at TEXT
);
CREATE INDEX keystore_secrets_name ON keystore_secrets (name);

-- 'remove' joins the audit's actions: who removed a secret and when, never its value.
DROP TABLE IF EXISTS keystore_audit;
CREATE TABLE keystore_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  secret_id TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('create', 'rotate', 'read', 'remove')),
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX keystore_audit_secret ON keystore_audit (secret_id, id);

-- A person's own key is an AI Gateway stored key under their alias; config_id is its provider config. Keys saved
-- before ('mine' rows) go with their ciphertext: that provider shows missing until the key is saved again.
ALTER TABLE model_providers RENAME TO model_providers_old;
CREATE TABLE model_providers (
  person TEXT NOT NULL,
  provider TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('credits', 'org', 'mine')),
  method TEXT CHECK (method IN ('key', 'login')),
  config_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'failing')),
  reason TEXT,
  last_used_at TEXT,
  PRIMARY KEY (person, provider)
);
INSERT INTO model_providers (person, provider, source, method, status, reason, last_used_at)
  SELECT person, provider, source, method, status, reason, last_used_at FROM model_providers_old WHERE source <> 'mine';
DROP TABLE model_providers_old;
