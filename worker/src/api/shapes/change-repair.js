// A change's `repair` (card and detail): its automatic repair round `round` of `max` (the agent's limits.max_repairs, default 2),
// fixing `check` (verify, review, ...); `passed` once the fix passes verify.
export function validateChangeRepair(v) {
  const errors = [];
  if (!Number.isInteger(v?.max) || v.max < 1) errors.push("max: expected integer >= 1");
  if (!Number.isInteger(v?.round) || v.round < 1 || v.round > v?.max) errors.push("round: expected integer in [1, max]");
  if (v?.check !== undefined && !(typeof v.check === "string" && v.check)) errors.push("check: expected non-empty string");
  if (v?.passed !== undefined && v.passed !== true) errors.push("passed: expected true");
  return { ok: errors.length === 0, errors };
}
