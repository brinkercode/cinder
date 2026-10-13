-- Teams are removed: every team member keeps the team's role as a direct role (an existing direct role wins), then
-- the tables go. The CREATEs make a replay safe after the drop: the tables are empty and the backfill does nothing.
CREATE TABLE IF NOT EXISTS teams (name TEXT PRIMARY KEY, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS team_members (team TEXT NOT NULL, person TEXT NOT NULL, PRIMARY KEY (team, person));
INSERT INTO person_roles (email, role) SELECT m.person, MIN(t.role) FROM team_members m JOIN teams t ON t.name = m.team
  GROUP BY m.person ON CONFLICT (email) DO NOTHING;
DROP TABLE IF EXISTS team_members;
DROP TABLE IF EXISTS teams;
