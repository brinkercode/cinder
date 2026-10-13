-- The Brier-by-week trend reads outcomes by when they were observed.
CREATE INDEX IF NOT EXISTS outcomes_observed ON outcomes (observed_at);
