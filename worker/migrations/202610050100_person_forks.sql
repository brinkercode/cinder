-- Each person's own Artifacts fork of a repo (<repo>--u-<person slug>), created by POST /api/repos/:name/push-token.
-- The fork name is the key so a push event finds its person; two people whose emails slug alike are refused.
CREATE TABLE IF NOT EXISTS person_forks (
  fork TEXT PRIMARY KEY,
  repo_id TEXT NOT NULL REFERENCES repos(id),
  person TEXT NOT NULL
);
