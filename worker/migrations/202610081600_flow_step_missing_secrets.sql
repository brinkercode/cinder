-- The step secrets a flow step could not read (src/flows.js reportStep), as a JSON list of names. A table rather than a
-- flow_steps column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS flow_step_missing_secrets (
  job_id TEXT NOT NULL,
  name TEXT NOT NULL,
  secrets TEXT NOT NULL,
  PRIMARY KEY (job_id, name)
);
