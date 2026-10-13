-- My model access: each person's model providers. source 'mine' rows hold their own key or login token, sealed like
-- keystore values (iv and ciphertext base64, never selected by a GET); 'credits' and 'org' rows only track use.
-- status and reason come from runners' provider checks.
CREATE TABLE IF NOT EXISTS model_providers (
  person TEXT NOT NULL,
  provider TEXT NOT NULL,
  source TEXT NOT NULL CHECK (source IN ('credits', 'org', 'mine')),
  method TEXT CHECK (method IN ('key', 'login')),
  iv TEXT,
  ciphertext TEXT,
  status TEXT NOT NULL CHECK (status IN ('connected', 'failing')),
  reason TEXT,
  last_used_at TEXT,
  PRIMARY KEY (person, provider)
);

-- The credential source a person picked on My model access.
CREATE TABLE IF NOT EXISTS model_sources (person TEXT PRIMARY KEY, source TEXT NOT NULL CHECK (source IN ('credits', 'org', 'mine')));

-- Each person's agent runs, tokens and spend by month (YYYY-MM), from runners' reports.
CREATE TABLE IF NOT EXISTS model_usage (
  person TEXT NOT NULL,
  month TEXT NOT NULL,
  tokens INTEGER NOT NULL,
  cost_usd REAL NOT NULL,
  runs INTEGER NOT NULL,
  PRIMARY KEY (person, month)
);
