// GET /api/workers/byo-pools/:id/tokens (src/runners.js): the token itself is never listed; prefix names it for revoking.
const time = (v) => !Number.isNaN(Date.parse(v));

export function validatePoolToken(v) {
  const errors = [];
  if (typeof v?.prefix !== "string" || !/^[0-9a-f]{8}$/.test(v.prefix)) errors.push("prefix: expected 8 hex characters");
  if (typeof v?.created_by !== "string" || !v.created_by) errors.push("created_by: expected non-empty string");
  if (!time(v?.created_at)) errors.push("created_at: expected ISO timestamp");
  if (v?.used_at !== null && !time(v?.used_at)) errors.push("used_at: expected ISO timestamp or null");
  if (!time(v?.expires_at)) errors.push("expires_at: expected ISO timestamp");
  return { ok: errors.length === 0, errors };
}
