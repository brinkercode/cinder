-- Repo topics: slugs set by the owner with PUT /api/repos/:name/topics, served on GET /api/repos.
CREATE TABLE IF NOT EXISTS repo_topics (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  topic TEXT NOT NULL,
  PRIMARY KEY (repo_id, topic)
);
