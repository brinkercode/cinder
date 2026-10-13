-- Head of each change's fork, moved by cf.artifacts.repo.pushed events (src/pushes.js).
CREATE TABLE IF NOT EXISTS change_heads (
  change_id TEXT PRIMARY KEY REFERENCES changes(id),
  head_sha TEXT NOT NULL
);

-- Pushes cinder did not expect, e.g. kind 'unexpected_target_push': a target branch moved without an active merge job.
CREATE TABLE IF NOT EXISTS repo_events (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  kind TEXT NOT NULL,
  ref TEXT NOT NULL,
  before_sha TEXT NOT NULL,
  after_sha TEXT NOT NULL,
  at TEXT NOT NULL
);
