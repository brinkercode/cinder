-- The share (0-100) of changes whose review and resolve jobs run an agent's canary version (src/work.js channelAgent).
-- A table rather than a channels column because ALTER TABLE ADD COLUMN can't be replayed. No row means 0.
CREATE TABLE IF NOT EXISTS canary_shares (
  agent_name TEXT PRIMARY KEY,
  share INTEGER NOT NULL CHECK (share BETWEEN 0 AND 100)
);
