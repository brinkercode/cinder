-- When a path's owners weights were last decayed (merges.js): every owner of a path decays together on each merge
-- touching it, so one time per path is enough. No row means no decay yet.
CREATE TABLE IF NOT EXISTS owner_decays (
  repo TEXT NOT NULL REFERENCES repos(id),
  path TEXT NOT NULL,
  decayed_at TEXT NOT NULL,
  PRIMARY KEY (repo, path)
);
