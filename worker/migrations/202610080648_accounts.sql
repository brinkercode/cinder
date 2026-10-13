-- Accounts decide repo access: a repo belongs to one account (repo_accounts), accounts may sit in a flat organization,
-- and account_members gives people a Git role on an account. The singleton `account` table stays as instance settings.
CREATE TABLE IF NOT EXISTS organizations (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  cf_org_id TEXT UNIQUE
);
CREATE TABLE IF NOT EXISTS accounts (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  org_id TEXT REFERENCES organizations(id),
  cf_account_id TEXT UNIQUE,
  personal_of TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS account_members (
  account_id TEXT NOT NULL REFERENCES accounts(id),
  person TEXT NOT NULL,
  git_role TEXT NOT NULL CHECK (git_role IN ('admin','maintainer','contributor','reader')),
  source TEXT NOT NULL CHECK (source IN ('direct','org','access_group')),
  PRIMARY KEY (account_id, person)
);
-- A table rather than a repos column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS repo_accounts (
  repo_id TEXT PRIMARY KEY REFERENCES repos(id),
  account_id TEXT NOT NULL REFERENCES accounts(id)
);

-- Backfill: the instance's own account (cf_account_id is filled by the first sync), every repo in it, and today's
-- built-in roles as direct members. Custom roles keep working through person_roles.
INSERT OR IGNORE INTO accounts (id, name, slug, created_at)
  SELECT 'instance', name, 'instance', strftime('%Y-%m-%dT%H:%M:%fZ', 'now') FROM account WHERE id = 1;
INSERT OR IGNORE INTO repo_accounts (repo_id, account_id) SELECT id, 'instance' FROM repos;
INSERT OR IGNORE INTO account_members (account_id, person, git_role, source)
  SELECT 'instance', email, CASE role WHEN 'owner' THEN 'admin' WHEN 'admin' THEN 'admin' WHEN 'maintainer' THEN 'maintainer' WHEN 'viewer' THEN 'reader' ELSE 'contributor' END, 'direct'
  FROM person_roles WHERE role IN ('owner', 'admin', 'maintainer', 'contributor', 'developer', 'viewer');
