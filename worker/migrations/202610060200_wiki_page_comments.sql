-- Comments on wiki pages. author is personOf (access.js).
CREATE TABLE IF NOT EXISTS wiki_page_comments (
  id TEXT PRIMARY KEY,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  author TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  edited_at TEXT
);
CREATE INDEX IF NOT EXISTS wiki_page_comments_page ON wiki_page_comments (page_id, created_at);
