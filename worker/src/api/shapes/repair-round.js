// GET /api/changes/:id/repairs (src/repairs.js): one automatic repair round, oldest first. `did` is what the agent's develop
// run reported, `result` the verifier's verdict after it, `reason` why it failed; both null while the round runs.
export function validateRepairRound(v) {
  const errors = [];
  if (!Number.isInteger(v?.round) || v.round < 1) errors.push("round: expected integer >= 1");
  if (!(typeof v?.check === "string" && v.check)) errors.push("check: expected non-empty string");
  for (const k of ["did", "reason"]) if (v?.[k] !== null && typeof v?.[k] !== "string") errors.push(`${k}: expected string or null`);
  if (![null, "pass", "fail"].includes(v?.result)) errors.push("result: expected pass, fail or null");
  if (!Number.isInteger(v?.tokens) || v.tokens < 0) errors.push("tokens: expected integer >= 0");
  if (typeof v?.at !== "string" || Number.isNaN(Date.parse(v.at))) errors.push("at: expected ISO time");
  return { ok: errors.length === 0, errors };
}
