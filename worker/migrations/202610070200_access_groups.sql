-- Group → role mappings (Settings › Access & people): an Access, IdP or Cloudflare User Group and the cinder role it
-- maps to. repos is a JSON array of repo names; an empty one means every repo.
CREATE TABLE IF NOT EXISTS access_groups (
  name TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  role TEXT NOT NULL,
  repos TEXT NOT NULL
);
-- When each person last signed in through Access. A table rather than a people column because ALTER TABLE can't be replayed.
CREATE TABLE IF NOT EXISTS people_seen (
  email TEXT PRIMARY KEY,
  at TEXT NOT NULL
);
