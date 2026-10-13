-- The change POST /api/findings/:id/fix opened for a finding (src/findings.js). fixed_by is that change's id once it
-- has merged and a full scan no longer sees the finding; NULL while the fix is pending or the finding reopens.
CREATE TABLE IF NOT EXISTS finding_fixes (
  finding_id INTEGER PRIMARY KEY REFERENCES findings(id),
  change_id TEXT NOT NULL REFERENCES changes(id),
  fixed_by TEXT REFERENCES changes(id)
);
