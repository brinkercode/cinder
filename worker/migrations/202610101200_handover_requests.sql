-- Requests to a lease's holder to hand the lease over (src/handover.js). expires_at is the lease's expiry when asked.
CREATE TABLE IF NOT EXISTS handover_requests (
  id TEXT PRIMARY KEY,
  holder TEXT NOT NULL,
  requester TEXT NOT NULL,
  symbol TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'requested' CHECK (status IN ('requested', 'accepted', 'declined', 'cancelled')),
  reason TEXT,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS handover_requests_holder ON handover_requests (holder);
