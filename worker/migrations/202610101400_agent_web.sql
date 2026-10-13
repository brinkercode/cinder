-- A release lock's web setting (runner release.go): markdown asks sites for Markdown and converts HTML answers before the
-- agent reads them; raw passes the web through. A table rather than an agent_releases column because ALTER TABLE ADD
-- COLUMN can't be replayed. No row (a version released before the setting) means raw.
CREATE TABLE IF NOT EXISTS agent_release_web (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  web TEXT NOT NULL CHECK (web IN ('markdown', 'raw')),
  PRIMARY KEY (name, version)
);

-- Per agent job: the web responses the container egress converted to Markdown and the bytes that saved (HTML minus Markdown).
CREATE TABLE IF NOT EXISTS job_web_usage (
  job_id TEXT PRIMARY KEY,
  agent_version TEXT NOT NULL,
  converted INTEGER NOT NULL,
  saved_bytes INTEGER NOT NULL
);
