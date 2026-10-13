-- The slots an owner registered a runner with (POST /api/runners {slots}); claimWork caps its live leases there, 1 without a row.
CREATE TABLE IF NOT EXISTS runner_slots (
  runner_id TEXT PRIMARY KEY REFERENCES runner_tokens(runner_id),
  slots INTEGER NOT NULL CHECK (slots >= 1)
);
