-- The base line ranges ("12-13,7-6") a change's final diff replaced in each written symbol (change_writes), from the
-- runner. A write of a symbol another change holds is a collision only when these ranges overlap or touch
-- (lease.js enforceLease). A side table, so the migration can be applied twice.
CREATE TABLE IF NOT EXISTS change_write_lines (
  change_id TEXT NOT NULL REFERENCES changes(id),
  symbol TEXT NOT NULL,
  lines TEXT NOT NULL,
  PRIMARY KEY (change_id, symbol)
);
