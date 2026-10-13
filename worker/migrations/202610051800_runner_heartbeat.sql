-- A runner's last claim or job heartbeat, and the slots_free it last reported on a claim (null until it claims).
-- A table rather than runner_tokens columns because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS runner_heartbeats (
  runner_id TEXT PRIMARY KEY REFERENCES runner_tokens(runner_id),
  last_heartbeat_at TEXT NOT NULL,
  slots INTEGER
);
