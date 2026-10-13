-- GET /api/repos/:name/code-search: the files of each branch's head, indexed on push (pushes.js). trigram serves substring LIKE.
CREATE VIRTUAL TABLE IF NOT EXISTS code_search USING fts5(store UNINDEXED, ref UNINDEXED, sha UNINDEXED, path UNINDEXED, content, tokenize = 'trigram');
