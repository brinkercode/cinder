-- Outbound webhooks: events is a JSON array of "change", "verdict", "judgment".
CREATE TABLE IF NOT EXISTS webhooks (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  url TEXT NOT NULL,
  secret TEXT NOT NULL,
  events TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS webhooks_repo ON webhooks (repo_id);
