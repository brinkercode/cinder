-- A change's resolved stack plan (JSON {stack, stages: [{name, kind, agent?}]}), written at planning.
-- A table rather than a changes column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS change_plans (
  change_id TEXT PRIMARY KEY REFERENCES changes(id),
  plan TEXT NOT NULL
);
