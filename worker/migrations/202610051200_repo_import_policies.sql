-- The .cinder.yml a re-import of a policy-only repo keeps: merged onto the imported default branch once the
-- import lands. A table rather than a repo_imports column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS repo_import_policies (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  yaml TEXT NOT NULL
);
