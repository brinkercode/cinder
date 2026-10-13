-- What a need's decision acts on beyond its change, as JSON: a lease takeover's {path, person}, a critical advisory's
-- {package}. A table rather than a needs column because ALTER TABLE ADD COLUMN can't be replayed.
CREATE TABLE IF NOT EXISTS need_subjects (
  need_id TEXT PRIMARY KEY REFERENCES needs(id),
  subject TEXT NOT NULL
);
