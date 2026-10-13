-- GET /api/repos/:name/wiki/search: full-text index over wiki_pages, kept in step by triggers on every create, edit and delete.
CREATE VIRTUAL TABLE IF NOT EXISTS wiki_search USING fts5(page_id UNINDEXED, title, content);
INSERT INTO wiki_search (page_id, title, content) SELECT id, title, content FROM wiki_pages;
CREATE TRIGGER IF NOT EXISTS wiki_search_insert AFTER INSERT ON wiki_pages BEGIN
  INSERT INTO wiki_search (page_id, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS wiki_search_update AFTER UPDATE OF id, title, content ON wiki_pages BEGIN
  DELETE FROM wiki_search WHERE page_id = old.id;
  INSERT INTO wiki_search (page_id, title, content) VALUES (new.id, new.title, new.content);
END;
CREATE TRIGGER IF NOT EXISTS wiki_search_delete AFTER DELETE ON wiki_pages BEGIN
  DELETE FROM wiki_search WHERE page_id = old.id;
END;
