// GET /api/workers/byo-pools (src/workers.js): online = runners with a heartbeat in the last 2 minutes; settings as a managed pool's.
import { validateSettings } from "./pool.js";

const str = (v) => typeof v === "string" && v.length > 0;
const count = (v) => Number.isInteger(v) && v >= 0;

export function validateByoPool(v) {
  const errors = [];
  for (const k of ["id", "name"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!Array.isArray(v?.labels) || !v.labels.every(str)) errors.push("labels: expected a list of non-empty strings");
  for (const k of ["cloud", "region"]) if (v?.[k] !== null && !str(v?.[k])) errors.push(`${k}: expected non-empty string or null`);
  for (const k of ["members", "online"]) if (!count(v?.[k])) errors.push(`${k}: expected integer >= 0`);
  if (v?.last_heartbeat_at !== null && Number.isNaN(Date.parse(v?.last_heartbeat_at))) errors.push("last_heartbeat_at: expected ISO timestamp or null");
  if (Number.isNaN(Date.parse(v?.created_at))) errors.push("created_at: expected ISO timestamp");
  validateSettings(v, errors);
  return { ok: errors.length === 0, errors };
}
