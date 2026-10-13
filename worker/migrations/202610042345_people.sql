-- People who signed in with Cloudflare Access, created on first sign-in. Owners come from the OWNERS var, not here.
CREATE TABLE IF NOT EXISTS people (
  email TEXT PRIMARY KEY,
  created_at TEXT NOT NULL
);
