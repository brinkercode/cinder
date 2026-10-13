-- Nonprod reset runs (admin.js ResetWorkflow): progress and what each store held. The reset keeps this table.
CREATE TABLE IF NOT EXISTS resets (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL DEFAULT 'running',
  step TEXT,
  counts TEXT NOT NULL DEFAULT '{}',
  error TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
