-- A/B race legs (src/races.js): one row per leg's change. won is NULL until the race is decided, then 1 for the winner.
CREATE TABLE IF NOT EXISTS race_legs (
  change_id TEXT PRIMARY KEY,
  race_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  started_at TEXT NOT NULL,
  verdict TEXT CHECK (verdict IN ('pass', 'fail')),
  cost_usd REAL,
  secs INTEGER,
  changed_lines INTEGER,
  won INTEGER
);
CREATE INDEX IF NOT EXISTS race_legs_race ON race_legs (race_id);
