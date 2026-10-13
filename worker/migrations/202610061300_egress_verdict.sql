-- job_egress keyed by the egress proxy's verdict (allowed | denied | would_deny) instead of allowed 0/1, backfilled from job_egress.
-- would_deny is an audit-mode version's CONNECT to a host outside its egress list, let through. A new table rather than a
-- job_egress column because ALTER TABLE ADD COLUMN can't be replayed; job_egress is no longer written.
CREATE TABLE IF NOT EXISTS job_egress_verdicts (
  job_id TEXT NOT NULL,
  repo_id TEXT NOT NULL,
  agent TEXT NOT NULL,
  host TEXT NOT NULL,
  verdict TEXT NOT NULL CHECK (verdict IN ('allowed', 'denied', 'would_deny')),
  count INTEGER NOT NULL CHECK (count > 0),
  at TEXT NOT NULL,
  PRIMARY KEY (job_id, host, verdict)
);
CREATE INDEX IF NOT EXISTS job_egress_verdicts_repo_at ON job_egress_verdicts (repo_id, at);
INSERT OR IGNORE INTO job_egress_verdicts SELECT job_id, repo_id, agent, host, CASE allowed WHEN 1 THEN 'allowed' ELSE 'denied' END, count, at FROM job_egress;

-- A release lock's egress_mode (runner release.go). A table rather than an agent_releases column because ALTER TABLE ADD
-- COLUMN can't be replayed. No row means enforce.
CREATE TABLE IF NOT EXISTS agent_release_egress_mode (
  name TEXT NOT NULL,
  version INTEGER NOT NULL,
  egress_mode TEXT NOT NULL CHECK (egress_mode IN ('enforce', 'audit')),
  PRIMARY KEY (name, version)
);
