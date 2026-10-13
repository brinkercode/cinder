-- Tables rather than findings columns because ALTER TABLE ADD COLUMN can't be replayed.
-- The System 1 hazard judgment that raised a finding: a false-positive dismissal scores it "no", and while the finding
-- is open it blocks merging the judgment's change.
CREATE TABLE IF NOT EXISTS finding_judgments (
  finding_id INTEGER PRIMARY KEY REFERENCES findings(id),
  judgment_id TEXT NOT NULL REFERENCES judgments(id)
);
-- The owner's note on a dismissed finding, beside findings.dismiss_reason.
CREATE TABLE IF NOT EXISTS finding_notes (
  finding_id INTEGER PRIMARY KEY REFERENCES findings(id),
  note TEXT NOT NULL
);
