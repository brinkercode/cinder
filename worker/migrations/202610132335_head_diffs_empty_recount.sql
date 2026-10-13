-- Empty diff summaries cached before they stopped being kept (changes.js diffSummary), such as heads pushed to refs/for/<target>
-- read from the wrong fork branch: recounted on the next list.
DELETE FROM head_diffs WHERE json_extract(summary, '$.files_changed') = 0;
