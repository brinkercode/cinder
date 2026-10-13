-- Wiki pages flagged as agent context: every develop claim on the repo carries them (work.js), and /wiki/context lists them.
CREATE TABLE IF NOT EXISTS wiki_agent_context (
  page_id TEXT PRIMARY KEY REFERENCES wiki_pages(id) ON DELETE CASCADE,
  flagged_at TEXT NOT NULL
);
-- One row per person per page per day a page was read; a page's views are its row count.
CREATE TABLE IF NOT EXISTS wiki_views (
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  person TEXT NOT NULL,
  day TEXT NOT NULL,
  PRIMARY KEY (page_id, person, day)
);
-- The wiki pages (and the blob sha of the content) each develop claim handed its agent.
CREATE TABLE IF NOT EXISTS job_wiki_context (
  job_id TEXT NOT NULL,
  page_id TEXT NOT NULL REFERENCES wiki_pages(id) ON DELETE CASCADE,
  sha TEXT NOT NULL,
  PRIMARY KEY (job_id, page_id)
);
