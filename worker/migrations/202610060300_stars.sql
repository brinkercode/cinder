-- Stars and followed topics, keyed by the Access person (personOf); PUT/DELETE in stars.js, star counts on GET /api/repos.
CREATE TABLE IF NOT EXISTS stars (
  person TEXT NOT NULL,
  repo TEXT NOT NULL REFERENCES repos(id),
  at TEXT NOT NULL,
  PRIMARY KEY (person, repo)
);
CREATE TABLE IF NOT EXISTS topic_follows (
  person TEXT NOT NULL,
  topic TEXT NOT NULL,
  PRIMARY KEY (person, topic)
);
