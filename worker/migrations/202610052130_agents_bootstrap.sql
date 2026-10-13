-- One row: the cross-isolate lock on bootstrapping cinder-agents (locked_until) and when its create() was last called.
CREATE TABLE IF NOT EXISTS agents_bootstrap (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  locked_until INTEGER,
  created_at INTEGER
);
