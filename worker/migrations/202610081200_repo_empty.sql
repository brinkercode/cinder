-- A repo created with no commit (POST /api/repos, src/repos.js). GET /api/repos reports it empty and deletes the row
-- once the default branch has a commit. No row means the repo has commits.
CREATE TABLE IF NOT EXISTS repo_empty (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id)
);
