-- One row per lease collision, written when the colliding change goes to conflict: the diagnostic its agent was sent
-- (message), what the agent did (action) and how a person resolved it (resolution: stack, seam, handover or reprioritize).
CREATE TABLE IF NOT EXISTS collisions (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  conflict_id TEXT NOT NULL,
  ours TEXT NOT NULL,
  theirs TEXT NOT NULL,
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  severity TEXT NOT NULL,
  p REAL NOT NULL,
  message TEXT NOT NULL,
  action TEXT NOT NULL,
  detected_at TEXT NOT NULL,
  resolution TEXT,
  resolved_at TEXT
);
CREATE INDEX IF NOT EXISTS collisions_repo ON collisions (repo_id, detected_at);

-- The symbols a change's last push wrote, kept apart from leases: "editing now" lapses after 10 minutes.
CREATE TABLE IF NOT EXISTS symbol_editing (
  repo_id TEXT NOT NULL,
  symbol TEXT NOT NULL,
  change_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (repo_id, symbol, change_id)
);
