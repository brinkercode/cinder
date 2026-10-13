-- The fix changes a scan opened for a dependency with auto-fix on (src/scans.js), not a person.
-- A table rather than a finding_fixes column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS auto_fix_changes (change_id TEXT PRIMARY KEY REFERENCES changes(id));
