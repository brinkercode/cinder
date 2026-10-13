-- Repo setting: which System 1 backend and pinned model answer each judgment kind.
CREATE TABLE IF NOT EXISTS judge_config (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  kind TEXT NOT NULL,
  backend TEXT NOT NULL,
  model_version TEXT NOT NULL,
  base_url TEXT,
  PRIMARY KEY (repo_id, kind)
);
