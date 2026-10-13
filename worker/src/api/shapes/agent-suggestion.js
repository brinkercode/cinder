// GET /api/repos/:name/agents/suggest: one agent version (name@vN) with its merge rate on the repo, null with no
// outcomes, its outcome count n and whether n reaches the repo's trust threshold.
export function validateAgentSuggestion(v) {
  const errors = [];
  if (!/^.+@v[1-9]\d*$/.test(v?.agent ?? "")) errors.push("agent: expected name@vN");
  if (!Number.isInteger(v?.n) || v.n < 0) errors.push("n: expected integer >= 0");
  if (!(v?.p_merge === null || (typeof v?.p_merge === "number" && v.p_merge >= 0 && v.p_merge <= 1))) errors.push("p_merge: expected null or 0..1");
  if (v?.n === 0 && v?.p_merge !== null) errors.push("p_merge: expected null with no outcomes");
  if (typeof v?.trusted !== "boolean") errors.push("trusted: expected boolean");
  return { ok: errors.length === 0, errors };
}
