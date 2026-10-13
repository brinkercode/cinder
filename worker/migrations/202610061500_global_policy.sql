-- The global default branch policy (Settings): a JSON object of the fields every repo inherits unless its .cinder.yml sets them.
CREATE TABLE IF NOT EXISTS global_policy (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  policy TEXT NOT NULL
);
