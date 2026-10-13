-- The cinder run (job) behind each gateway log: log_id is the model call's cf-aig-log-id (usage_logs.id). A table, not a
-- usage_logs column, because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS job_gateway_logs (
  log_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS job_gateway_logs_job ON job_gateway_logs (job_id);
