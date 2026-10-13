import { validateChange } from "../contract.js";

export const LEASE_KINDS = ["held", "seam", "pending", "released", "none"];

const count = (n) => Number.isInteger(n) && n >= 0;

// GET /api/board: a change as the Changes board shows it. ver is null for a person; tok is [in, out, cache].
export function validateBoardChange(v) {
  const errors = [...validateChange(v).errors];
  if (typeof v?.agent !== "string" || !v.agent) errors.push("agent: expected non-empty string");
  if (v?.ver !== null && (typeof v?.ver !== "string" || !v.ver)) errors.push("ver: expected non-empty string or null");
  if (!Array.isArray(v?.tok) || v.tok.length !== 3 || !v.tok.every(count)) errors.push("tok: expected [in, out, cache] integers >= 0");
  if (!LEASE_KINDS.includes(v?.lease?.kind)) errors.push(`lease.kind: expected one of ${LEASE_KINDS.join(", ")}`);
  if (v?.lease?.n !== null && !count(v?.lease?.n)) errors.push("lease.n: expected integer >= 0 or null");
  const j = v?.risk_judge;
  if (j !== null && (typeof j?.name !== "string" || !j.name || !count(j.count) || typeof j.brier !== "number")) {
    errors.push("risk_judge: expected { name, count, brier } or null");
  }
  return { ok: errors.length === 0, errors };
}
