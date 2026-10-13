-- Changes move to the issues' P0–P3 scale: low, normal, high, urgent become P3, P2, P1, P0 (ChangeDO moves its own record on load).
UPDATE change_cards SET card = json_set(card, '$.priority', CASE json_extract(card, '$.priority')
  WHEN 'low' THEN 'P3' WHEN 'normal' THEN 'P2' WHEN 'high' THEN 'P1' ELSE 'P0' END)
  WHERE json_extract(card, '$.priority') IN ('low', 'normal', 'high', 'urgent');

-- Label routing rules set in Settings (src/routing.js): a JSON list of {label, agent|driver|reviewer}, first match wins.
CREATE TABLE IF NOT EXISTS label_routes (
  repo_id TEXT PRIMARY KEY,
  rules TEXT NOT NULL
);
