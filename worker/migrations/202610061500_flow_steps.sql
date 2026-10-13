-- Each step of a flow run (src/flows.js); the run itself is its `flow` job.
CREATE TABLE IF NOT EXISTS flow_steps (
  job_id TEXT NOT NULL REFERENCES jobs(id),
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  logs TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (job_id, name)
);
