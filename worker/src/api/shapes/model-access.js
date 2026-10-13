// GET /api/me/models: the signed-in person's credential source, providers and this month's usage. A key's value is
// never part of it. status "unchecked" is a saved key no provider check has run on yet; "failing" carries the provider check's reason; source is null for a provider with no credential.
// account is the active account's name (null if it has none); org_keys lists the provider ids with an org key, null when AI Gateway can't be read.
const SOURCES = ["credits", "org", "mine"];
export function validateModelAccess(v) {
  const errors = [];
  if (!SOURCES.includes(v?.source)) errors.push(`source: expected one of ${SOURCES.join(", ")}`);
  if (!Array.isArray(v?.providers)) errors.push("providers: expected array");
  (v?.providers ?? []).forEach((p, i) => {
    for (const k of ["id", "name"]) if (typeof p?.[k] !== "string" || !p[k]) errors.push(`providers[${i}].${k}: expected non-empty string`);
    if (!(p?.source === null || SOURCES.includes(p?.source))) errors.push(`providers[${i}].source: expected source or null`);
    if (!(p?.method === null || ["key", "login"].includes(p?.method))) errors.push(`providers[${i}].method: expected key, login or null`);
    if (!["unchecked", "connected", "missing", "failing"].includes(p?.status)) errors.push(`providers[${i}].status: expected unchecked, connected, missing or failing`);
    for (const k of ["reason", "last_used_at"]) if (!(p?.[k] === null || typeof p?.[k] === "string")) errors.push(`providers[${i}].${k}: expected string or null`);
  });
  for (const k of ["tokens", "cost_usd", "runs"]) if (typeof v?.usage?.[k] !== "number") errors.push(`usage.${k}: expected number`);
  if (!(v?.account === null || typeof v?.account === "string")) errors.push("account: expected string or null");
  if (!(v?.org_keys === null || (Array.isArray(v?.org_keys) && v.org_keys.every((p) => typeof p === "string")))) errors.push("org_keys: expected array of strings or null");
  return { ok: errors.length === 0, errors };
}
