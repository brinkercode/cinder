import { RESET_STATES } from "./reset.js";

// GET /api/admin/seed/:id: a reseed's or demo scenario's progress. step is reset, seed or demo; error is set once failed.
export function validateSeedRun(v) {
  const errors = [];
  if (typeof v?.id !== "string") errors.push("id: expected string");
  if (!RESET_STATES.includes(v?.status)) errors.push(`status: expected one of ${RESET_STATES.join(", ")}`);
  for (const k of ["step", "error"]) if (v?.[k] !== null && typeof v?.[k] !== "string") errors.push(`${k}: expected string or null`);
  return { ok: errors.length === 0, errors };
}
