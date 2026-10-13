// GET /api/people returns a list of these: everyone who signed in with Cloudflare Access or was added
// by email. role is null for someone who signed in but was never given one; last_seen is null until they sign in.
export function validatePerson(v) {
  const errors = [];
  if (typeof v?.email !== "string" || !v.email) errors.push("email: expected non-empty string");
  if (typeof v?.owner !== "boolean") errors.push("owner: expected boolean");
  if (v?.role !== null && (typeof v?.role !== "string" || !v.role)) errors.push("role: expected non-empty string or null");
  if (typeof v?.created_at !== "string" || Number.isNaN(Date.parse(v.created_at))) errors.push("created_at: expected ISO timestamp");
  if (v?.last_seen !== null && (typeof v?.last_seen !== "string" || Number.isNaN(Date.parse(v.last_seen)))) errors.push("last_seen: expected ISO timestamp or null");
  if (v?.invited !== undefined && v.invited !== "access") errors.push('invited: expected "access" when present');
  return { ok: errors.length === 0, errors };
}
