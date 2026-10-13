const GIT_ROLES = ["admin", "maintainer", "contributor", "reader"];
const str = (v) => typeof v === "string" && v.length > 0;

// GET /api/me/accounts returns this: the accounts the caller reaches in their organization (when they have one), and
// the one account outside it. implicit: the access comes through the organization, not a direct membership.
export function validateAccountList(v) {
  const errors = [];
  const check = (ok, path, desc) => { if (!ok) errors.push(`${path}: expected ${desc}`); };
  const account = (a, p) => {
    for (const k of ["id", "name", "slug"]) check(str(a?.[k]), `${p}.${k}`, "non-empty string");
    check(GIT_ROLES.includes(a?.git_role), `${p}.git_role`, `one of ${GIT_ROLES.join(", ")}`);
    for (const k of ["implicit", "can_create", "current"]) check(typeof a?.[k] === "boolean", `${p}.${k}`, "boolean");
    check(Number.isInteger(a?.repos) && a.repos >= 0, `${p}.repos`, "non-negative integer");
  };
  if (v?.organization !== undefined) for (const k of ["id", "name"]) check(str(v.organization?.[k]), `organization.${k}`, "non-empty string");
  if (Array.isArray(v?.accounts)) v.accounts.forEach((a, i) => account(a, `accounts[${i}]`));
  else errors.push("accounts: expected array");
  if (v?.personal !== undefined) account(v.personal, "personal");
  return { ok: errors.length === 0, errors };
}
