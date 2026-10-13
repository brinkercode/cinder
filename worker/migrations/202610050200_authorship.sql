-- Line authorship from a blame job (`cinder-verify blame`), cached per commit and path. lines is the job's JSON list.
CREATE TABLE IF NOT EXISTS authorship (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  sha TEXT NOT NULL,
  path TEXT NOT NULL,
  lines TEXT NOT NULL,
  PRIMARY KEY (repo_id, sha, path)
);
