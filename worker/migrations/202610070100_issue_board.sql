-- The issues board: an issue's column, priority and iteration. A table: ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS issue_board (
  issue_id TEXT PRIMARY KEY REFERENCES issues(id),
  status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'progress', 'review', 'done')),
  priority TEXT CHECK (priority IN ('P0', 'P1', 'P2', 'P3')),
  iteration TEXT
);
