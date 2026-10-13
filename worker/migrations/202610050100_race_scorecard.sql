-- Race scorecard axes the verify report carries beyond race_legs' own (src/races.js settleLeg).
-- A table rather than race_legs columns because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS race_scores (
  change_id TEXT PRIMARY KEY,
  new_deps INTEGER,
  review_findings INTEGER,
  duration_ms INTEGER NOT NULL
);
-- Outcomes scored against an agent version rather than a judgment, e.g. race_won when a leg is promoted.
CREATE TABLE IF NOT EXISTS agent_outcomes (
  id TEXT PRIMARY KEY,
  agent_version TEXT NOT NULL,
  outcome TEXT NOT NULL,
  change_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_outcomes_version ON agent_outcomes (agent_version, outcome);
