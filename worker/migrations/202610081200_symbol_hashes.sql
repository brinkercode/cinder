-- Per-symbol signature and body hashes and read edges from an index job. name is qualified (Scope.Name); reads is a
-- JSON list of "path#name". A file in a language without symbols is one row with kind 'file' and an empty name.
CREATE TABLE IF NOT EXISTS symbol_hashes (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  sha TEXT NOT NULL,
  path TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  sig TEXT NOT NULL,
  body TEXT NOT NULL,
  reads TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha, path, name, kind)
);
