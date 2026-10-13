-- The file a resembles_vuln judgment judged: a scan finding on that path at the change's head links to it (finding_judgments).
CREATE TABLE IF NOT EXISTS judgment_paths (
  judgment_id TEXT PRIMARY KEY REFERENCES judgments(id),
  path TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS judgment_paths_path ON judgment_paths (path);
