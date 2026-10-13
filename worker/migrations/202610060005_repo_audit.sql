-- Owner actions on a repo that replace its content, e.g. 'reimport' (POST /api/repos/:name/import). detail is JSON.
CREATE TABLE IF NOT EXISTS repo_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  action TEXT NOT NULL CHECK (action IN ('reimport')),
  actor TEXT NOT NULL,
  detail TEXT NOT NULL,
  at TEXT NOT NULL
);
