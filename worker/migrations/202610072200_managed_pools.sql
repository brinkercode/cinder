-- Every install starts with the managed pools, scaled to zero and serving every job kind: build (basic, slim image) and
-- toolchains (standard-2, full image). A pool already named so is left as it is.
INSERT INTO worker_pools (id, name, size, min_count, max_count, kinds, created_at)
SELECT lower(hex(randomblob(16))), name, size, 0, 4,
  '["index","develop","verify","converge","merge","resolve","review","acceptance","seam","split","guard","bisect","release","draft","history","commit","blame","scan","ingest-sarif","refs","compare","flow"]',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM (SELECT 'build' AS name, 'basic' AS size UNION ALL SELECT 'toolchains', 'standard-2') WHERE true
ON CONFLICT (name) DO NOTHING;
