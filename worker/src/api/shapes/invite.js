// POST /api/invites answers this: the lowercased emails invited, their role, and the repos it applies to (empty is every repo).
export function validateInvite(v) {
  const errors = [];
  if (!Array.isArray(v?.emails) || !v.emails.length || !v.emails.every((e) => typeof e === "string" && e)) errors.push("emails: expected non-empty string[]");
  if (typeof v?.role !== "string" || !v.role) errors.push("role: expected non-empty string");
  if (!Array.isArray(v?.repos) || !v.repos.every((r) => typeof r === "string")) errors.push("repos: expected string[]");
  return { ok: errors.length === 0, errors };
}
