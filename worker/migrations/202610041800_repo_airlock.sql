-- Repo setting: a row here turns airlock on, so the repo's judges only use backends on the owner's infrastructure.
CREATE TABLE IF NOT EXISTS airlock_repos (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id)
);
