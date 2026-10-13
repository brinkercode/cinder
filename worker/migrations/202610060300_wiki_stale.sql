-- A wiki page naming a symbol a merged change touched: change_id is the latest such merge. Any title or content edit clears it.
CREATE TABLE IF NOT EXISTS wiki_stale (
  page_id TEXT PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE,
  change_id TEXT NOT NULL,
  flagged_at TEXT NOT NULL
);
CREATE TRIGGER IF NOT EXISTS wiki_stale_clear AFTER UPDATE OF title, content ON wiki_pages BEGIN
  DELETE FROM wiki_stale WHERE page_id = old.id;
END;
