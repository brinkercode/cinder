const str = (v) => typeof v === "string" && v.length > 0;

// GET /api/repos/:name/commits/:sha?ref: the commit and its changed files, each a line diff (" ", "-", "+" prefixes)
// against parent, or lines null when too large to diff.
export function validateCommitDiff(v) {
  const errors = [];
  if (!str(v?.sha)) errors.push("sha: expected non-empty string");
  if (!(v?.parent === null || str(v?.parent))) errors.push("parent: expected string | null");
  if (typeof v?.message !== "string") errors.push("message: expected string");
  if (!(v?.author === null || typeof v?.author === "string")) errors.push("author: expected string | null");
  if (!Array.isArray(v?.files)) errors.push("files: expected array");
  else v.files.forEach((f, i) => errors.push(...validateDiffFile(f).errors.map((e) => `files[${i}]: ${e}`)));
  return { ok: errors.length === 0, errors };
}

// One changed file of a CommitDiff; GET /api/changes/:id/files lists these for a change's head against its base.
export function validateDiffFile(f) {
  const ok = str(f?.path) && ["added", "modified", "deleted"].includes(f.status) && (f.lines === null || (Array.isArray(f.lines) && f.lines.every((l) => typeof l === "string")));
  return { ok, errors: ok ? [] : ["expected {path, status: added | modified | deleted, lines: string[] | null}"] };
}
