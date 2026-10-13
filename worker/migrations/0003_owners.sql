-- Learned ownership: recency-weighted (half-life 90 days) authors and agent versions per path.
CREATE TABLE IF NOT EXISTS owners (
  repo TEXT NOT NULL REFERENCES repos(id),
  path TEXT NOT NULL,
  owner TEXT NOT NULL,
  weight REAL NOT NULL CHECK (weight >= 0),
  PRIMARY KEY (repo, path, owner)
);
