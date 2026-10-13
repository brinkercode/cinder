-- Repo Settings: default-branch changes join repo_audit's actions. A CHECK can't be altered, so the rows are copied
-- out, the table is created again and the rows copied back; replaying it does the same again.
CREATE TABLE IF NOT EXISTS repo_audit_copy AS SELECT * FROM repo_audit;
DROP TABLE repo_audit;
CREATE TABLE repo_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  action TEXT NOT NULL CHECK (action IN ('reimport', 'default_branch')),
  actor TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
INSERT INTO repo_audit SELECT * FROM repo_audit_copy;
DROP TABLE repo_audit_copy;

-- Who set each repo role and when (PUT /api/repos/:name/people/:email). A table rather than repo_roles columns
-- because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS repo_role_grants (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  person TEXT NOT NULL,
  set_by TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo_id, person)
);

-- A webhook's Secrets Store secret id, which rotate and delete address it by. Hooks made before have none.
CREATE TABLE IF NOT EXISTS webhook_secret_ids (
  hook_id TEXT PRIMARY KEY REFERENCES webhooks(id),
  store_secret_id TEXT NOT NULL
);

-- Every delivery attempt: ok with the HTTP status, or the status or error it failed with.
CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  hook_id TEXT NOT NULL REFERENCES webhooks(id),
  at TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER,
  error TEXT
);
CREATE INDEX IF NOT EXISTS webhook_deliveries_hook ON webhook_deliveries (hook_id, id);

-- Account-level record of deleted repos; keyed by name so it outlives the repo's rows.
CREATE TABLE IF NOT EXISTS repo_deletions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
