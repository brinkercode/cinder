-- Watchtower's controls: the packages a repo auto-fixes (PATCH /api/repos/:name/dependencies), and the repos whose
-- daily scans are paused (PUT /api/repos/:name/settings {scans_paused}); Scan again still runs.
CREATE TABLE IF NOT EXISTS dep_auto_fix (repo_id TEXT NOT NULL, ecosystem TEXT NOT NULL, name TEXT NOT NULL, PRIMARY KEY (repo_id, ecosystem, name));
CREATE TABLE IF NOT EXISTS scan_pauses (repo_id TEXT PRIMARY KEY);
