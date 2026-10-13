// PUT /api/agents/:name/versions/:version/limits takes and returns this: an agent version's token limits per run and per
// calendar month. null means no limit. Stored in the version's limits next to max_cost_usd.
export function validateTokenLimits(v) {
  const errors = [];
  for (const k of ["max_tokens", "max_tokens_month"]) {
    if (!(v?.[k] === null || (Number.isInteger(v?.[k]) && v[k] >= 1))) errors.push(`${k}: expected integer >= 1 or null`);
  }
  return { ok: errors.length === 0, errors };
}
