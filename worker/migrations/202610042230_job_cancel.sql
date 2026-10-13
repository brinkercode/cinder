-- Jobs superseded because their change's head moved; the heartbeat tells the runner to kill them.
CREATE TABLE IF NOT EXISTS job_cancels (
  job_id TEXT PRIMARY KEY REFERENCES jobs(id)
);
