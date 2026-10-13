-- Per collision: what cinder advised the person on it (suggested_*) and who resolved it. A side table: ALTER TABLE ADD
-- COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS collision_notes (
  collision_id TEXT PRIMARY KEY REFERENCES collisions(id),
  suggested_action TEXT, suggested_why TEXT, suggested_p REAL,
  resolved_by_type TEXT, resolved_by_id TEXT
);
