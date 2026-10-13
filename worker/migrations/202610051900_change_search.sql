-- GET /api/search: one row per searchable text of a change. source is intent, acceptance, summary (written by the
-- ChangeDO on every save) or question (written with each judgment).
CREATE VIRTUAL TABLE IF NOT EXISTS change_search USING fts5(change_id UNINDEXED, source UNINDEXED, text);
