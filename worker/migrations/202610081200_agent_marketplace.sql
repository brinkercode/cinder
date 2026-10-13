-- A marketplace listing's published version, who may see it and the account that published it (src/agents.js
-- publishAgent). Listings from before it have no row: their newest version, visible to the instance.
CREATE TABLE IF NOT EXISTS agent_publications (
  name TEXT PRIMARY KEY,
  version INTEGER NOT NULL,
  visibility TEXT NOT NULL CHECK (visibility IN ('organization', 'instance')),
  account_id TEXT NOT NULL
);
-- One row per marketplace install: the new agent, the template version it pins and the installer's account.
CREATE TABLE IF NOT EXISTS agent_installs (
  name TEXT PRIMARY KEY,
  template TEXT NOT NULL,
  version INTEGER NOT NULL,
  account_id TEXT NOT NULL,
  channel TEXT NOT NULL,
  installed_by TEXT NOT NULL,
  installed_at TEXT NOT NULL
);
