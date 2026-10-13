-- Agents published to the marketplace catalog (src/agents.js listCatalog); bundled agents are listed without a row.
CREATE TABLE IF NOT EXISTS agent_listings (
  name TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  listed_at TEXT NOT NULL
);
