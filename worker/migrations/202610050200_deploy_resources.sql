-- Cloudflare resources cinder created per repo and environment (src/deploy.js reconcileResources).
-- D1, KV, Queues and R2 take no tags, so a row here is the cinder-managed tag; drift is a row the manifest no longer declares.
CREATE TABLE IF NOT EXISTS deploy_resources (
  repo TEXT NOT NULL,
  env TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('d1', 'kv', 'queue', 'r2')),
  name TEXT NOT NULL,
  cf_id TEXT NOT NULL,
  PRIMARY KEY (repo, env, type, name)
);
