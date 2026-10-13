-- A flow run's attempt (src/flow-results.js): no row is attempt 1; each re-run adds one.
CREATE TABLE IF NOT EXISTS flow_run_attempts (
  run_id TEXT PRIMARY KEY,
  attempt INTEGER NOT NULL CHECK (attempt >= 2)
);
-- One test suite a flow job's runner parsed from a step's junit: file; failures are the failed tests' names (JSON).
CREATE TABLE IF NOT EXISTS flow_tests (
  run_id TEXT NOT NULL,
  job_key TEXT NOT NULL,
  suite TEXT NOT NULL,
  passed INTEGER NOT NULL,
  failed INTEGER NOT NULL,
  skipped INTEGER NOT NULL,
  failures TEXT NOT NULL,
  PRIMARY KEY (run_id, job_key, suite)
);
