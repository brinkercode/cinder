-- A release lock's prompt (runner release.go), served to the runner in its claim (src/work.js). A table rather than an
-- agent_releases column because ALTER TABLE ADD COLUMN can't be replayed. No row means the harness runs without one.
CREATE TABLE IF NOT EXISTS agent_release_prompts (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  prompt TEXT NOT NULL,
  PRIMARY KEY (name, version)
);
