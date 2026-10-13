-- Review threads anchored to a line of a change's diff (src/threads.js). A null path is a change-level thread.
-- line is 1-based in path at head_sha on side; original_lines is the anchored text, re-mapped on each head move.
CREATE TABLE IF NOT EXISTS review_threads (
  id TEXT PRIMARY KEY,
  change_id TEXT NOT NULL REFERENCES changes(id),
  path TEXT,
  side TEXT CHECK (side IN ('old', 'new')),
  line INTEGER CHECK (line >= 1),
  head_sha TEXT,
  original_lines TEXT,
  outdated INTEGER NOT NULL DEFAULT 0,
  resolved INTEGER NOT NULL DEFAULT 0,
  -- Who last resolved or reopened the thread, and when.
  state_by TEXT,
  state_at TEXT,
  created_at TEXT NOT NULL,
  CHECK ((path IS NULL) = (line IS NULL) AND (path IS NULL) = (side IS NULL))
);
CREATE INDEX IF NOT EXISTS review_threads_change ON review_threads (change_id);

CREATE TABLE IF NOT EXISTS review_comments (
  id TEXT PRIMARY KEY,
  thread_id TEXT NOT NULL REFERENCES review_threads(id),
  actor TEXT NOT NULL,
  body TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS review_comments_thread ON review_comments (thread_id, at);
