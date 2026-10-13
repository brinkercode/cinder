-- Branch moves cinder itself pushes (src/git/index.js), consumed by the push event they cause; any other push to a
-- protected target is a person's and is rolled back (src/pushes.js).
CREATE TABLE IF NOT EXISTS ref_writes (
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (repo, ref, sha)
);
