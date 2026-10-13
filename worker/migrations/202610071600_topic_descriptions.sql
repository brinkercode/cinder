-- A topic page's one-line description, written by an owner with PUT /api/topics/:topic and served on GET /api/topics/:topic.
CREATE TABLE IF NOT EXISTS topic_descriptions (
  topic TEXT PRIMARY KEY,
  description TEXT NOT NULL
);
