-- The symbols a change's final diff read, from its last verify: a merge changing one's signature converges the change.
CREATE TABLE IF NOT EXISTS change_reads (
  change_id TEXT NOT NULL REFERENCES changes(id),
  symbol TEXT NOT NULL,
  PRIMARY KEY (change_id, symbol)
);
-- A change a merge on its target didn't affect: it rebases when it reaches the queue head or its next push lands.
CREATE TABLE IF NOT EXISTS change_behind (
  change_id TEXT PRIMARY KEY REFERENCES changes(id)
);
