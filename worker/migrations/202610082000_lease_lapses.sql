-- Changes whose code lease lapsed (expired while idle, or failed) with the symbols it held; their develop and verify
-- jobs aren't claimable until the lease is re-acquired (src/scheduler.js).
CREATE TABLE IF NOT EXISTS lease_lapses (
  change_id TEXT PRIMARY KEY,
  symbols TEXT NOT NULL
);
