-- The sha a release was published at (src/releases.js): promote deploys it even if the tag moved since. A table rather
-- than a releases column because ALTER TABLE ADD COLUMN can't be replayed. Releases published before it keep their tag's sha.
CREATE TABLE IF NOT EXISTS release_shas (
  release_id TEXT PRIMARY KEY REFERENCES releases(id),
  sha TEXT NOT NULL
);
INSERT INTO release_shas (release_id, sha) SELECT r.id, t.sha FROM releases r JOIN tags t ON t.repo = r.repo AND t.name = r.tag
  WHERE r.state = 'published' ON CONFLICT DO NOTHING;
