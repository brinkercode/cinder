-- Tables nothing reads: job_egress (replaced by job_egress_verdicts), wiki_page_versions (wiki history is git),
-- regressions and repo_events (never read).
DROP TABLE IF EXISTS job_egress;
DROP TABLE IF EXISTS wiki_page_versions;
DROP TABLE IF EXISTS regressions;
DROP TABLE IF EXISTS repo_events;
-- The bisect and acceptance job kinds are retired: no runner ran them. Their jobs go; pools keep their other kinds in order.
DELETE FROM jobs WHERE kind IN ('bisect', 'acceptance');
UPDATE worker_pools SET kinds = (SELECT json_group_array(value) FROM json_each(worker_pools.kinds) WHERE value NOT IN ('bisect', 'acceptance'))
  WHERE EXISTS (SELECT 1 FROM json_each(worker_pools.kinds) WHERE value IN ('bisect', 'acceptance'));
