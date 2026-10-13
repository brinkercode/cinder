-- Every create or content edit of a wiki page. edited_by is the person's email or "owner".
CREATE TABLE IF NOT EXISTS wiki_page_versions (
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  content TEXT NOT NULL,
  edited_by TEXT NOT NULL,
  message TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (page_id, version)
);
