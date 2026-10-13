// GET /api/admin/reset/:id: a reset's progress and what it cleared, per store. d1 maps each data table to the rows it held;
// counts fills in as the stores empty, and is complete once status is done.
export const RESET_STATES = ["running", "done", "failed"];
const STORES = ["repo_do", "change_do", "dispatch_do", "artifacts", "logs", "secrets", "jobs_cancelled"];

export function validateReset(v) {
  const errors = [];
  const count = (n) => Number.isInteger(n) && n >= 0;
  if (typeof v?.id !== "string") errors.push("id: expected string");
  if (!RESET_STATES.includes(v?.status)) errors.push(`status: expected one of ${RESET_STATES.join(", ")}`);
  for (const k of ["step", "error"]) if (v?.[k] !== null && typeof v?.[k] !== "string") errors.push(`${k}: expected string or null`);
  const c = v?.counts ?? {};
  const done = v?.status === "done";
  if ((done || "d1" in c) && (typeof c.d1 !== "object" || c.d1 === null || !Object.values(c.d1).every(count))) errors.push("counts.d1: expected {table: non-negative integer}");
  for (const k of STORES) {
    if ((done || k in c) && !count(c[k])) errors.push(`counts.${k}: expected non-negative integer`);
  }
  return { ok: errors.length === 0, errors };
}
