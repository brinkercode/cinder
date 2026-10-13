-- Who asked for a job: the person who requested its change (newChange in src/changes.js). Model calls from the runner
-- holding the job use this person's own keys (byokAlias in src/model-access.js), never a person the runner names.
CREATE TABLE IF NOT EXISTS change_requesters (
  change_id TEXT PRIMARY KEY,
  person TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS job_requesters (
  job_id TEXT PRIMARY KEY,
  person TEXT NOT NULL
);
-- No foreign keys: jobs and changes are deleted without these rows, which are only read joined to a live job.
-- Every job for a change records the change's requester as it is created, whichever module inserts it.
CREATE TRIGGER IF NOT EXISTS job_requester_insert AFTER INSERT ON jobs WHEN NEW.change_id IS NOT NULL BEGIN
  INSERT OR IGNORE INTO job_requesters SELECT NEW.id, person FROM change_requesters WHERE change_id = NEW.change_id;
END;
