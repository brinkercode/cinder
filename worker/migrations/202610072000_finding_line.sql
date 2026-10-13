-- Per finding (src/findings.js): the line it was last seen on (NULL when the scanner reports none) and when it was
-- first recorded. A table rather than findings columns because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS finding_seen (
  finding_id INTEGER PRIMARY KEY REFERENCES findings(id),
  line INTEGER,
  first_seen TEXT NOT NULL
);
