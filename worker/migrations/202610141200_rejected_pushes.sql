-- Direct pushes to a protected ref that cinder rolled back, or tried to (src/pushes.js): while one is still the default
-- branch's head, no cron or manual flow runs there (src/flows.js).
CREATE TABLE IF NOT EXISTS rejected_pushes (
  repo TEXT NOT NULL,
  ref TEXT NOT NULL,
  sha TEXT NOT NULL,
  PRIMARY KEY (repo, ref, sha)
);
