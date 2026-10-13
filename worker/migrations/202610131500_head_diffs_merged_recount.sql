-- A merged change counted after its fork was deleted kept a 0-file summary; the next list counts it again from the repo.
DELETE FROM head_diffs WHERE json_extract(summary, '$.files_changed') = 0;
