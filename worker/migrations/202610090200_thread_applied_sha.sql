-- The commit an applied suggestion landed as (src/pushes.js), a table because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS review_thread_applied (
  thread_id TEXT PRIMARY KEY REFERENCES review_threads(id),
  applied_sha TEXT NOT NULL
);
