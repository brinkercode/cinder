-- Tags and releases (src/releases.js). The Artifacts binding lists no
-- refs, so a tag is recorded here when the commit API pushes it. A release is drafted or published from one tag.
CREATE TABLE IF NOT EXISTS tags (
  repo TEXT NOT NULL,
  name TEXT NOT NULL,
  sha TEXT NOT NULL,
  message TEXT NOT NULL,
  tagger TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (repo, name)
);

CREATE TABLE IF NOT EXISTS releases (
  id TEXT PRIMARY KEY,
  repo TEXT NOT NULL,
  tag TEXT NOT NULL,
  title TEXT NOT NULL,
  notes TEXT NOT NULL DEFAULT '',
  state TEXT NOT NULL CHECK (state IN ('draft', 'published')),
  author TEXT NOT NULL,
  created_at TEXT NOT NULL,
  published_at TEXT,
  UNIQUE (repo, tag),
  FOREIGN KEY (repo, tag) REFERENCES tags (repo, name)
);

-- One row per promote: the environment sync (deploy_syncs id) that deploys the release's tag.
CREATE TABLE IF NOT EXISTS release_promotions (
  sync_id TEXT PRIMARY KEY,
  release_id TEXT NOT NULL REFERENCES releases(id),
  env TEXT NOT NULL,
  actor TEXT NOT NULL,
  at TEXT NOT NULL
);
