-- A repo listed here quarantines no new tests; tests already quarantined stay out of the verdict until released.
CREATE TABLE IF NOT EXISTS quarantine_off (
  repo TEXT PRIMARY KEY REFERENCES repos(id)
);
