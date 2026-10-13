// GET /api/accounts returns an array of these: an account the caller can see, and whether they may install agents
// into it (Git Admin there, or an instance owner).
export function validateAccountChoice(v) {
  const errors = [];
  for (const k of ["id", "name", "slug"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  if (typeof v?.can_install !== "boolean") errors.push("can_install: expected boolean");
  return { ok: errors.length === 0, errors };
}
