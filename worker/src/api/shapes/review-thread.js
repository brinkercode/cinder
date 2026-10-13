// GET /api/changes/:id/threads returns a list of these; POST returns one. path, side and line are null for a change-level thread.
// suggestion {from, to} is the anchored line and its suggested lines; applied_sha is the commit that applied it.
export function validateReviewThread(v) {
  const errors = [];
  const str = (x) => typeof x === "string" && x !== "";
  if (!str(v?.id)) errors.push("id: expected non-empty string");
  if (!(v?.path === null || str(v?.path))) errors.push("path: expected null or non-empty string");
  if (!(v?.side === null || v?.side === "old" || v?.side === "new")) errors.push("side: expected null, old or new");
  if (!(v?.line === null || (Number.isInteger(v?.line) && v.line >= 1))) errors.push("line: expected null or integer >= 1");
  if (!(v?.head_sha === null || str(v?.head_sha))) errors.push("head_sha: expected null or non-empty string");
  if (typeof v?.outdated !== "boolean") errors.push("outdated: expected boolean");
  if (typeof v?.resolved !== "boolean") errors.push("resolved: expected boolean");
  if (!(v?.state_by === null || str(v?.state_by))) errors.push("state_by: expected null or non-empty string");
  if (!(v?.suggestion === null || (typeof v?.suggestion?.from === "string" && typeof v.suggestion.to === "string"))) errors.push("suggestion: expected null or {from, to} strings");
  if (!(v?.applied_sha === null || str(v?.applied_sha))) errors.push("applied_sha: expected null or non-empty string");
  if (!Array.isArray(v?.comments) || !v.comments.every((c) => str(c?.actor) && str(c?.body) && str(c?.at))) {
    errors.push("comments: expected list of {actor, body, at}");
  }
  return { ok: errors.length === 0, errors };
}
