// GET /api/changes/:id/commits and /checks (src/change-checks.js).
const str = (v) => typeof v === "string" && v.length > 0;

export function validateChangeCommit(v) {
  const errors = [];
  if (!str(v?.sha)) errors.push("sha: expected non-empty string");
  if (typeof v?.message !== "string") errors.push("message: expected string");
  if (!Array.isArray(v?.trailers) || !v.trailers.every((t) => str(t?.key) && str(t?.value))) errors.push("trailers: expected [{key, value}]");
  return { ok: errors.length === 0, errors };
}

export function validateChangeCheck(v) {
  const errors = [];
  if (!["verify", "guard", "sarif", "test", "flow"].includes(v?.kind)) errors.push("kind: expected verify, guard, sarif, test or flow");
  for (const k of ["name", "sha"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!["pass", "fail", "pending", "quarantined"].includes(v?.status)) errors.push("status: expected pass, fail, pending or quarantined");
  if (v?.status === "quarantined" && !(typeof v.flake_rate === "number" && v.flake_rate >= 0 && v.flake_rate <= 1)) errors.push("flake_rate: expected number 0..1");
  if (v?.status === "quarantined" && !str(v.since)) errors.push("since: expected non-empty string");
  if (v?.duration_ms !== null && !(Number.isInteger(v?.duration_ms) && v.duration_ms >= 0)) errors.push("duration_ms: expected integer >= 0 or null");
  if (v?.log_url !== null && !str(v?.log_url)) errors.push("log_url: expected non-empty string or null");
  return { ok: errors.length === 0, errors };
}
