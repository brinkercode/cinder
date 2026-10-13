-- Who last saved each wiki page, for Needs you (inbox.js). Versions now live in the org wiki's git history (wiki.js).
-- A table rather than a wiki_pages column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS wiki_editors (
  page_id TEXT PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE,
  edited_by TEXT NOT NULL,
  edited_at TEXT NOT NULL
);
INSERT OR IGNORE INTO wiki_editors SELECT page_id, edited_by, created_at FROM wiki_page_versions v
  WHERE version = (SELECT MAX(version) FROM wiki_page_versions WHERE page_id = v.page_id);
