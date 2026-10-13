-- GET /api/overview (src/overview.js). description and language are set on create or import and in repo settings;
-- pushed_at moves on every push event to the repo (src/pushes.js); archived_at hides the repo from GET /api/repos and
-- refuses its pushes. No row means no description, language or push, and not archived. Tables rather than repos and
-- repo_audit changes because ALTER TABLE ADD COLUMN and a rebuild for a wider CHECK can't be replayed.
CREATE TABLE IF NOT EXISTS repo_meta (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  description TEXT NOT NULL DEFAULT '',
  language TEXT,
  pushed_at TEXT,
  archived_at TEXT
);

-- Each archive and unarchive (POST/DELETE /api/repos/:name/archive), who did it and when.
CREATE TABLE IF NOT EXISTS repo_archive_audit (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  action TEXT NOT NULL CHECK (action IN ('archive', 'unarchive')),
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);

-- The one account: its name, Git host (null: the Worker's own host), monthly agent-token budget and the budget alerts,
-- a JSON array of percentages of the budget.
CREATE TABLE IF NOT EXISTS account (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  name TEXT NOT NULL,
  git_host TEXT,
  budget_tokens INTEGER CHECK (budget_tokens > 0),
  alerts TEXT NOT NULL DEFAULT '[]'
);
INSERT OR IGNORE INTO account (id, name) VALUES (1, 'cinder');
