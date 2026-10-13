-- Per-repo issues (src/issues.js). number is per repo, from 1.
-- labels is a JSON array of names; assignee is one person's email or null.
CREATE TABLE IF NOT EXISTS issues (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  number INTEGER NOT NULL CHECK (number >= 1),
  title TEXT NOT NULL,
  body TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL DEFAULT 'open' CHECK (state IN ('open', 'closed')),
  author TEXT NOT NULL,
  assignee TEXT,
  labels TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  closed_at TEXT,
  UNIQUE (repo_id, number)
);

CREATE TABLE IF NOT EXISTS issue_comments (
  id TEXT PRIMARY KEY,
  issue_id TEXT NOT NULL REFERENCES issues(id),
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS issue_comments_issue ON issue_comments (issue_id, created_at);

-- A change links an issue by `#n` in its intent (ChangeDO save) or explicitly (PUT …/issues/:n/changes/:id).
CREATE TABLE IF NOT EXISTS issue_links (
  issue_id TEXT NOT NULL REFERENCES issues(id),
  -- No foreign key: the ChangeDO saves (and links) before newChange inserts the changes row.
  change_id TEXT NOT NULL,
  PRIMARY KEY (issue_id, change_id)
);
CREATE INDEX IF NOT EXISTS issue_links_change ON issue_links (change_id);
