// GET /api/service-tokens returns these: an Access service token's client id and the name it acts as (<name>@service-token).
export function validateServiceToken(v) {
  const errors = [];
  for (const k of ["client_id", "name"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  return { ok: errors.length === 0, errors };
}
