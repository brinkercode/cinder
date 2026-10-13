-- The symbols (kind signature|body) a change's final diff wrote, from its last verify; read by the edit check.
CREATE TABLE IF NOT EXISTS change_writes (
  change_id TEXT NOT NULL REFERENCES changes(id),
  symbol TEXT NOT NULL,
  kind TEXT NOT NULL,
  PRIMARY KEY (change_id, symbol)
);

-- Every edit-check diagnostic, on its change. job_id is the check that returned it; NULL until delivered (raised by another change's edit).
CREATE TABLE IF NOT EXISTS edit_diagnostics (
  id INTEGER PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes(id),
  job_id TEXT,
  severity TEXT NOT NULL,
  file TEXT NOT NULL,
  symbol TEXT NOT NULL,
  other TEXT,
  intent TEXT NOT NULL,
  suggestion TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS edit_diagnostics_change ON edit_diagnostics (change_id);
