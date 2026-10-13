// GET /api/groups returns a list of these: an Access, IdP or Cloudflare User Group mapped to a cinder role.
// repos: the repo names it applies to; empty is every repo.
export function validateGroup(v) {
  const errors = [];
  for (const k of ["name", "source", "role"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  if (!Array.isArray(v?.repos) || !v.repos.every((r) => typeof r === "string")) errors.push("repos: expected string[]");
  return { ok: errors.length === 0, errors };
}
