-- What happens when this month's agent spend reaches the account's budget (PUT /api/account when_reached): 'pause'
-- stops new agent jobs (work.js claim), 'alert' only raises the alerts. No row means 'pause'. A table rather than an
-- account column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS budget_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  when_reached TEXT NOT NULL CHECK (when_reached IN ('pause', 'alert'))
);
