-- The Agents page (src/fleet.js): an agent's role, the fleet's one settings row, AI Gateway's per-call detail for a usage_logs row
-- (src/usage.js) and what a race leg's verify report adds (src/races.js settleLeg), rpm being its peak requests a minute.
CREATE TABLE IF NOT EXISTS agent_roles (name TEXT PRIMARY KEY, role TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS fleet_settings (id INTEGER PRIMARY KEY CHECK (id = 1), canary_auto_promote INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS usage_calls (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, model TEXT NOT NULL, call TEXT NOT NULL,
  input_tokens INTEGER NOT NULL, output_tokens INTEGER NOT NULL, latency_ms INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS race_leg_stats (change_id TEXT PRIMARY KEY, model TEXT, tokens INTEGER, tests_passed INTEGER, tests_total INTEGER,
  p_merge REAL, rpm INTEGER, rpm_limit INTEGER);
