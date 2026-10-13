// GET /api/repos/:name/flakes returns a list of these; result only with ?sha=.
export function validateFlake(v) {
  const errors = [];
  if (typeof v?.test !== "string" || !v.test) errors.push("test: expected non-empty string");
  if (!Number.isInteger(v?.runs) || v.runs < 1) errors.push("runs: expected integer >= 1");
  if (!Number.isInteger(v?.flakes) || v.flakes < 0) errors.push("flakes: expected integer >= 0");
  if (typeof v?.rate !== "number" || !(v.rate >= 0 && v.rate <= 1)) errors.push("rate: expected number in [0, 1]");
  if (typeof v?.quarantined !== "boolean") errors.push("quarantined: expected boolean");
  if (v?.quarantined_since !== null && Number.isNaN(Date.parse(v?.quarantined_since))) errors.push("quarantined_since: expected null or ISO timestamp");
  if ((v?.quarantined_by === null) !== (v?.quarantined_since === null) || (v?.quarantined_by !== null && typeof v?.quarantined_by !== "string")) {
    errors.push("quarantined_by: expected a name while quarantined_since is set, else null");
  }
  if (v?.result !== undefined && ![null, "pass", "fail", "skip"].includes(v.result)) errors.push("result: expected pass, fail, skip or null");
  return { ok: errors.length === 0, errors };
}
