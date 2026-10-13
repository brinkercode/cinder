-- A job's claim priority; higher is claimed first, a job without a row has priority 0 (DispatchDO in src/work.js).
-- A table rather than a jobs column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS job_priorities (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id),
  priority INTEGER NOT NULL
);
