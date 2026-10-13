-- Judge calls that fell back to the kind's untrusted safe default: one counter per (repo, kind, backend, model_version, reason).
CREATE TABLE IF NOT EXISTS judge_failures (
  repo_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  backend TEXT NOT NULL,
  model_version TEXT NOT NULL,
  reason TEXT NOT NULL,
  count INTEGER NOT NULL,
  last_at TEXT NOT NULL,
  PRIMARY KEY (repo_id, kind, backend, model_version, reason)
);
