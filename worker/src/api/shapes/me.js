// GET /api/me: the signed-in person. email is null for the OWNER_TOKEN (machine/break-glass auth).
export function validateMe(v) {
  const errors = [];
  if (!(v?.email === null || (typeof v?.email === "string" && v.email.length > 0))) errors.push("email: expected non-empty string or null");
  if (typeof v?.owner !== "boolean") errors.push("owner: expected boolean");
  if (v?.nonprod !== undefined && typeof v.nonprod !== "boolean") errors.push("nonprod: expected boolean");
  return { ok: errors.length === 0, errors };
}
