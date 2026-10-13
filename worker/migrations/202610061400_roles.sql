-- Roles. A person added by email gets a role; one who only
-- signed in through Access has none and reaches nothing but /api/me. Built-in roles live in people.js; custom ones here.
-- A table rather than a people column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS person_roles (
  email TEXT PRIMARY KEY,
  role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS roles (
  name TEXT PRIMARY KEY,
  capabilities TEXT NOT NULL -- JSON array of capability names
);
-- Per-repo overrides: an extra role for one person on one repo.
CREATE TABLE IF NOT EXISTS repo_roles (
  repo_id TEXT NOT NULL REFERENCES repos(id),
  person TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (repo_id, person)
);
CREATE TABLE IF NOT EXISTS teams (
  name TEXT PRIMARY KEY,
  role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS team_members (
  team TEXT NOT NULL REFERENCES teams(name),
  person TEXT NOT NULL,
  PRIMARY KEY (team, person)
);
