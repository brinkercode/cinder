// GET /api/changes/:id/reviewers/suggested returns these (reviewers.js): an owner of owns of the touched paths.
export function validateSuggestedReviewer(v) {
  const errors = [];
  if (typeof v?.owner !== "string" || !v.owner) errors.push("owner: expected non-empty string");
  if (typeof v?.weight !== "number") errors.push("weight: expected number");
  for (const k of ["owns", "touched"]) if (!Number.isInteger(v?.[k]) || v[k] < 0) errors.push(`${k}: expected non-negative integer`);
  return { ok: errors.length === 0, errors };
}
