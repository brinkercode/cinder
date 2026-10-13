-- A repo's branch names from its last refs job (git ls-remote --heads): the Artifacts binding lists no refs.
CREATE TABLE IF NOT EXISTS repo_refs (
  repo_id TEXT NOT NULL,
  name TEXT NOT NULL,
  PRIMARY KEY (repo_id, name)
);
