-- A newly saved key is 'unchecked' until a runner's provider check or usage report marks it connected or failing.
ALTER TABLE model_providers RENAME TO model_providers_old;
CREATE TABLE model_providers (
  person TEXT NOT NULL,
  provider TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('credits', 'org', 'mine')),
  method TEXT CHECK (method IN ('key', 'login')),
  config_id TEXT,
  status TEXT NOT NULL CHECK (status IN ('unchecked', 'connected', 'failing')),
  reason TEXT,
  last_used_at TEXT,
  secret_id TEXT,
  PRIMARY KEY (person, provider)
);
INSERT INTO model_providers (person, provider, source, method, config_id, status, reason, last_used_at, secret_id)
  SELECT person, provider, source, method, config_id, status, reason, last_used_at, secret_id FROM model_providers_old;
DROP TABLE model_providers_old;
