-- Columns follow the shapes in src/api/contract.js. Time columns are ISO-8601 text.
CREATE TABLE IF NOT EXISTS repos (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  strategy TEXT NOT NULL,
  branch_policy TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  target_branch TEXT NOT NULL,
  state TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS changes_repo_branch_state ON changes (repo_id, target_branch, state);

CREATE TABLE IF NOT EXISTS runners (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  harnesses TEXT NOT NULL,
  last_seen_at TEXT
);

CREATE TABLE IF NOT EXISTS judgments (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  change_id TEXT REFERENCES changes(id),
  kind TEXT NOT NULL,
  backend TEXT NOT NULL,
  model_version TEXT NOT NULL,
  state_hash TEXT NOT NULL,
  question TEXT NOT NULL,
  answer TEXT NOT NULL,
  probability REAL NOT NULL CHECK (probability >= 0 AND probability <= 1),
  made_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS judgments_repo_kind_backend ON judgments (repo_id, kind, backend);

CREATE TABLE IF NOT EXISTS outcomes (
  judgment_id TEXT PRIMARY KEY REFERENCES judgments(id),
  actual TEXT NOT NULL,
  correct INTEGER NOT NULL CHECK (correct IN (0, 1)),
  observed_at TEXT NOT NULL
);
