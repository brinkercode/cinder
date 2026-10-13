-- A change as GET /api/repos/:name/changes lists it (JSON: the change plus agent, ver, tok, risk_judge), written by its
-- ChangeDO on every change write so the list makes no DO call. No foreign key: the DO writes it before the changes row.
CREATE TABLE IF NOT EXISTS change_cards (
  change_id TEXT PRIMARY KEY,
  card TEXT NOT NULL
);
