-- A change head's diff summary counted from its fork's files when no compare reported for it (changes.js diffSummary).
-- summary is JSON {files_changed, additions, deletions, ahead, behind}; a head sha's diff never changes, so a row is never rewritten.
CREATE TABLE IF NOT EXISTS head_diffs (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  head_sha TEXT NOT NULL,
  summary TEXT NOT NULL,
  PRIMARY KEY (repo_id, head_sha)
);
