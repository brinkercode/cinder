// Repo Settings shapes. RepoSettings: GET /api/repos/:name/settings. Webhook: an item of GET …/webhooks (never a
// secret). RepoRole: an item of GET …/people. Role: an item of GET /api/roles.
const check = (errors, ok, path, want) => { if (!ok) errors.push(`${path}: expected ${want}`); };
const str = (v) => typeof v === "string" && v.length > 0;
const time = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));
const result = (errors) => ({ ok: errors.length === 0, errors });

export function validateRepoSettings(v) {
  const e = [];
  check(e, typeof v?.description === "string", "description", "string");
  check(e, v?.language === null || str(v?.language), "language", "null or string");
  check(e, str(v?.default_branch), "default_branch", "branch name");
  check(e, ["trunk", "gitflow", "release", "custom"].includes(v?.strategy), "strategy", "trunk, gitflow, release or custom");
  check(e, typeof v?.flake_quarantine === "number" && v.flake_quarantine >= 0 && v.flake_quarantine <= 1, "flake_quarantine", "number from 0 to 1");
  check(e, v?.mirror_url === null || str(v?.mirror_url), "mirror_url", "null or URL");
  for (const k of ["scans_paused", "auto_quarantine", "can_reimport"]) check(e, typeof v?.[k] === "boolean", k, "boolean");
  check(e, time(v?.created_at), "created_at", "ISO timestamp");
  return result(e);
}

export function validateWebhook(v) {
  const e = [];
  for (const k of ["id", "url"]) check(e, str(v?.[k]), k, "non-empty string");
  check(e, Array.isArray(v?.events) && v.events.length > 0 && v.events.every((x) => ["change", "verdict", "judgment"].includes(x)), "events", "change, verdict or judgment list");
  check(e, time(v?.created_at), "created_at", "ISO timestamp");
  const d = v?.last_delivery;
  check(e, d === null || (time(d?.at) && typeof d.ok === "boolean" && (d.status === null || Number.isInteger(d.status)) && (d.error === null || typeof d.error === "string")),
    "last_delivery", "null or {at, ok, status, error}");
  check(e, !("secret" in (v ?? {})), "secret", "absent");
  return result(e);
}

export function validateRepoRole(v) {
  const e = [];
  for (const k of ["email", "role"]) check(e, str(v?.[k]), k, "non-empty string");
  check(e, v?.set_by === null || str(v?.set_by), "set_by", "null or email");
  check(e, v?.at === null || time(v?.at), "at", "null or ISO timestamp");
  return result(e);
}

export function validateRole(v) {
  const e = [];
  check(e, str(v?.name), "name", "non-empty string");
  check(e, Array.isArray(v?.capabilities) && v.capabilities.every(str), "capabilities", "string[]");
  check(e, typeof v?.built_in === "boolean", "built_in", "boolean");
  return result(e);
}
