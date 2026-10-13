-- Wiki pages per repo. A folder groups pages; parent_id NULL is the top level.
CREATE TABLE IF NOT EXISTS wiki_pages (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  parent_id TEXT REFERENCES wiki_pages(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  slug TEXT NOT NULL,
  type TEXT NOT NULL DEFAULT 'page' CHECK (type IN ('page', 'folder')),
  content TEXT NOT NULL DEFAULT '',
  sort_order INTEGER NOT NULL DEFAULT 0,
  view_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
-- COALESCE: a plain UNIQUE treats NULL parents as distinct, which would let top-level slugs repeat.
CREATE UNIQUE INDEX IF NOT EXISTS wiki_pages_slug ON wiki_pages (repo_id, COALESCE(parent_id, ''), slug);
