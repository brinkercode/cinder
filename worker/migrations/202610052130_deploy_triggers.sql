-- deploy_resources also tags the Worker triggers cinder set per environment: route, custom_domain and cron
-- (src/deploy.js reconcileTriggers). SQLite can't alter a CHECK, so the table is rebuilt.
ALTER TABLE deploy_resources RENAME TO deploy_resources_old;
CREATE TABLE deploy_resources (
  repo TEXT NOT NULL,
  env TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('d1', 'kv', 'queue', 'r2', 'route', 'custom_domain', 'cron')),
  name TEXT NOT NULL,
  cf_id TEXT NOT NULL,
  PRIMARY KEY (repo, env, type, name)
);
INSERT INTO deploy_resources SELECT repo, env, type, name, cf_id FROM deploy_resources_old;
DROP TABLE deploy_resources_old;
