-- A flow step's log state (src/flow-logs.js), a table rather than flow_step_runs columns because ALTER TABLE ADD COLUMN
-- can't be replayed. Lines live in R2 LOGS at flows/<run_id>/<job_key>/<idx>/<chunk>; chunks is the JSON list of each
-- chunk's line count, open_bytes the size of the last one, bytes the step's total. job_id is the `jobs` row whose
-- runner posts the lines, which the 50 MB per-job cap adds up over.
CREATE TABLE IF NOT EXISTS flow_step_logs (
  run_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  job_id TEXT NOT NULL,
  seq INTEGER NOT NULL DEFAULT 0,
  exit_code INTEGER,
  chunks TEXT NOT NULL DEFAULT '[]',
  open_bytes INTEGER NOT NULL DEFAULT 0,
  bytes INTEGER NOT NULL DEFAULT 0,
  truncated INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, job_key, idx)
);
CREATE INDEX IF NOT EXISTS flow_step_logs_job ON flow_step_logs (job_id);
