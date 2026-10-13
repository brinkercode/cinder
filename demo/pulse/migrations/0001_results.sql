CREATE TABLE results (
  url TEXT NOT NULL,
  ok INTEGER NOT NULL,
  status INTEGER NOT NULL,
  ms INTEGER NOT NULL,
  checked_at INTEGER NOT NULL
);
CREATE INDEX results_url_time ON results (url, checked_at);
