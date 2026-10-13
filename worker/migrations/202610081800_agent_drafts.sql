-- An agent's saved draft is a row here, not a queued `draft` job: no runner ran those jobs.
-- The latest draft job per agent moves over, then the draft jobs go.
CREATE TABLE IF NOT EXISTS agent_drafts (name TEXT PRIMARY KEY, draft TEXT NOT NULL, saved_at TEXT NOT NULL);
INSERT INTO agent_drafts (name, draft, saved_at)
  SELECT json_extract(payload, '$.name'), json_extract(payload, '$.draft'), created_at FROM jobs
  WHERE rowid IN (SELECT MAX(rowid) FROM jobs WHERE kind = 'draft' GROUP BY json_extract(payload, '$.name'))
  ON CONFLICT (name) DO NOTHING;
DELETE FROM jobs WHERE kind = 'draft';
-- Pools keep their kinds in order without the retired one.
UPDATE worker_pools SET kinds = (SELECT json_group_array(value) FROM json_each(worker_pools.kinds) WHERE value <> 'draft')
  WHERE EXISTS (SELECT 1 FROM json_each(worker_pools.kinds) WHERE value = 'draft');
