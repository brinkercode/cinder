// GET /api/repos/:name/branches (src/branches.js).
const str = (v) => typeof v === "string" && v.length > 0;
const count = (v) => Number.isInteger(v) && v >= 0;

export function validateBranch(v) {
  const errors = [];
  if (!str(v?.name)) errors.push("name: expected non-empty string");
  if (!["branch", "tag"].includes(v?.kind)) errors.push("kind: expected branch or tag");
  if (typeof v?.default !== "boolean") errors.push("default: expected boolean");
  if (v?.head_sha !== null && !str(v?.head_sha)) errors.push("head_sha: expected non-empty string or null");
  for (const k of ["ahead", "behind", "open_changes"]) if (!count(v?.[k])) errors.push(`${k}: expected integer >= 0`);
  if (v?.last_commit !== null && !(str(v?.last_commit?.sha) && typeof v.last_commit.message === "string")) errors.push("last_commit: expected {sha, message, author} or null");
  if (!["integration", "release", "other"].includes(v?.role)) errors.push("role: expected integration, release or other");
  return { ok: errors.length === 0, errors };
}
