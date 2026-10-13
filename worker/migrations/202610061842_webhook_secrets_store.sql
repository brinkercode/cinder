-- Webhook signing secrets move to the account's Secrets Store: D1 keeps only the reference, never the value. A value
-- can't move from SQL, so hooks made before go and are created again (each create returns a new secret).
DROP TABLE IF EXISTS webhooks;
CREATE TABLE webhooks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  url TEXT NOT NULL,
  events TEXT NOT NULL,
  store_id TEXT NOT NULL,
  store_secret_name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX webhooks_repo ON webhooks (repo_id);
