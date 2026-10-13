-- Flow runs (src/flows.js): a run of a flow, its jobs (stage/job[/leg]), each job's steps and their annotations.
-- payload is the flow definition the run was planned from. A flow job of the `jobs` table runs one flow_jobs row; a
-- flow with no job, matrix, shard or stages runs as one `jobs` row (id = run id) holding a one-step job per step.
CREATE TABLE IF NOT EXISTS flow_runs (
  id TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL,
  flow TEXT NOT NULL,
  number INTEGER NOT NULL,
  sha TEXT NOT NULL,
  ref TEXT,
  trigger TEXT NOT NULL,
  change_id TEXT,
  actor TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed')),
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  payload TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS flow_runs_repo ON flow_runs (repo_id, created_at);
CREATE TABLE IF NOT EXISTS flow_jobs (
  run_id TEXT NOT NULL,
  key TEXT NOT NULL,
  stage TEXT NOT NULL,
  name TEXT NOT NULL,
  leg TEXT,
  status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'passed', 'failed', 'skipped', 'cancelled')),
  runner_id TEXT,
  instance TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  started_at TEXT,
  finished_at TEXT,
  job_id TEXT,
  PRIMARY KEY (run_id, key)
);
CREATE INDEX IF NOT EXISTS flow_jobs_job ON flow_jobs (job_id);
-- A table rather than columns on flow_steps because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS flow_step_runs (
  run_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  idx INTEGER NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  lines INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (run_id, job_key, name)
);
CREATE TABLE IF NOT EXISTS flow_annotations (
  run_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  step TEXT NOT NULL,
  line INTEGER NOT NULL,
  level TEXT NOT NULL CHECK (level IN ('error', 'warning', 'notice')),
  message TEXT NOT NULL,
  file TEXT,
  file_line INTEGER
);

-- Backfill: every flow job from before per-job scheduling (no run_id in its payload) is a run with one job per step.
INSERT OR IGNORE INTO flow_runs (id, repo_id, flow, number, sha, ref, trigger, actor, status, created_at, started_at, payload)
  SELECT id, repo_id, json_extract(payload, '$.flow'),
    ROW_NUMBER() OVER (PARTITION BY repo_id, json_extract(payload, '$.flow') ORDER BY created_at, rowid),
    coalesce(json_extract(payload, '$.sha'), ''), json_extract(payload, '$.ref'), coalesce(json_extract(payload, '$.trigger'), 'manual'), 'cinder',
    CASE status WHEN 'claimed' THEN 'running' WHEN 'done' THEN 'passed' ELSE status END, created_at,
    CASE WHEN status <> 'queued' THEN created_at END, payload
  FROM jobs WHERE kind = 'flow' AND json_extract(payload, '$.run_id') IS NULL;
INSERT OR IGNORE INTO flow_jobs (run_id, key, stage, name, status, job_id)
  SELECT j.id, json_extract(s.value, '$.stage') || '/' || json_extract(s.value, '$.name'), json_extract(s.value, '$.stage'), json_extract(s.value, '$.name'),
    coalesce(fs.status, CASE j.status WHEN 'claimed' THEN 'running' WHEN 'done' THEN 'passed' WHEN 'failed' THEN 'failed' ELSE 'queued' END), j.id
  FROM jobs j JOIN json_each(j.payload, '$.steps') s LEFT JOIN flow_steps fs ON fs.job_id = j.id AND fs.name = json_extract(s.value, '$.name')
  WHERE j.kind = 'flow' AND json_extract(j.payload, '$.run_id') IS NULL;
INSERT OR IGNORE INTO flow_step_runs (run_id, job_key, idx, name, status)
  SELECT fs.job_id, json_extract(s.value, '$.stage') || '/' || fs.name, 0, fs.name, fs.status
  FROM flow_steps fs JOIN jobs j ON j.id = fs.job_id JOIN json_each(j.payload, '$.steps') s ON json_extract(s.value, '$.name') = fs.name;
