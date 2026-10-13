-- One row per full scan of a target branch (src/scans.js): a scan job's trigger, the head it scanned and its outcome.
-- counts is {secret, dependency, code} once done. A scan whose job lease runs out is failed, never re-claimed.
CREATE TABLE IF NOT EXISTS scans (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  repo_id TEXT NOT NULL REFERENCES repos(id),
  target TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('merge', 'daily')),
  sha TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'done', 'failed')),
  counts TEXT,
  started_at TEXT NOT NULL,
  finished_at TEXT
);
