-- Each move of an agent's channel through PUT /api/agents/:name/channels/:channel (src/agents.js moveChannel): promoted or
-- rolled_back (stable moved up or down), or canary (the canary pointed at a version, share its traffic then). by is the caller.
CREATE TABLE IF NOT EXISTS agent_channel_events (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('promoted', 'rolled_back', 'canary')),
  version INTEGER NOT NULL,
  share INTEGER,
  by TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS agent_channel_events_by_agent ON agent_channel_events (agent_name, at);
