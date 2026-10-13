// GET /api/races/:id: each leg's comparable axes. Axes are null until the leg's verify reports them.
const nullOr = (ok) => (v) => v === null || ok(v);
const count = (v) => Number.isInteger(v) && v >= 0;
const AXES = {
  verdict: nullOr((v) => v === "pass" || v === "fail"), diff_lines: nullOr(count), new_deps: nullOr(count),
  review_findings: nullOr(count), cost_usd: nullOr((v) => typeof v === "number" && v >= 0), duration_ms: nullOr(count),
};

export function validateRaceScorecard(v) {
  const errors = [];
  if (typeof v?.id !== "string" || !v.id) errors.push("id: expected non-empty string");
  if (!Array.isArray(v?.legs) || v.legs.length < 2) errors.push("legs: expected array of 2 or more legs");
  else v.legs.forEach((l, i) => {
    for (const k of ["change_id", "leg"]) if (typeof l?.[k] !== "string" || !l[k]) errors.push(`legs[${i}].${k}: expected non-empty string`);
    for (const [k, ok] of Object.entries(AXES)) if (!ok(l?.[k])) errors.push(`legs[${i}].${k}: invalid`);
    if (![null, 0, 1].includes(l?.won)) errors.push(`legs[${i}].won: expected null, 0 or 1`);
  });
  return { ok: errors.length === 0, errors };
}
