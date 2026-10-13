-- Trust thresholds per repo (src/calibration.js trustOf). No row or NULL means the default: 200 outcomes, 30 races.
-- A table rather than repo_settings columns because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS repo_trust (
  repo TEXT PRIMARY KEY REFERENCES repos(id),
  min_outcomes INTEGER CHECK (min_outcomes >= 1),
  min_races INTEGER CHECK (min_races >= 1)
);
