-- Spotlight: up to 6 repos per topic pinned by the owner with PUT /api/topics/:topic/pins, each with a one-line blurb.
CREATE TABLE IF NOT EXISTS topic_pins (
  topic TEXT NOT NULL,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  blurb TEXT NOT NULL,
  position INTEGER NOT NULL,
  PRIMARY KEY (topic, repo_id)
);
