-- Agent registry (docs/DESIGN.md §7). agent_versions rows follow AgentVersion in src/api/contract.js;
-- tools and limits are JSON text. A channel points one agent at one of its versions.
CREATE TABLE IF NOT EXISTS agent_versions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  version INTEGER NOT NULL CHECK (version >= 1),
  harness TEXT NOT NULL,
  model TEXT NOT NULL,
  effort TEXT NOT NULL,
  prompt_hash TEXT NOT NULL,
  tools TEXT NOT NULL,
  limits TEXT NOT NULL,
  UNIQUE (name, version)
);

CREATE TABLE IF NOT EXISTS channels (
  agent_name TEXT NOT NULL,
  channel TEXT NOT NULL CHECK (channel IN ('stable', 'canary')),
  version INTEGER NOT NULL,
  PRIMARY KEY (agent_name, channel),
  FOREIGN KEY (agent_name, version) REFERENCES agent_versions (name, version)
);
