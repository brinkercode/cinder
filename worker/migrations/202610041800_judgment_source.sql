-- Judgments back-filled from a repo's imported history (source: inherited); every other judgment is live.
CREATE TABLE IF NOT EXISTS inherited_judgments (
  judgment_id TEXT PRIMARY KEY REFERENCES judgments(id)
);
