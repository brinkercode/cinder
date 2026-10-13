-- GET /api/models/catalog (src/fleet.js): Cloudflare's model catalog, refreshed from its API once a day.
CREATE TABLE IF NOT EXISTS model_catalog (id TEXT PRIMARY KEY, provider TEXT NOT NULL, context TEXT NOT NULL, price TEXT NOT NULL, fetched_at TEXT NOT NULL);
