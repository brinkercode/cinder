import { JOB_KINDS } from "../contract.js";

// GET /api/workers/pools (src/workers.js): repo null = any repo; kinds = the flows it claims; workers = how many run now;
// online = those with a heartbeat in the last 2 minutes; default = the oldest pool; runs_per_hour and median_start_s
// (queued to claimed, null without runs) cover jobs its workers started in the last hour. The settings (validateSettings)
// come from pool_settings and pool_repos: repos is "*" (every repo) or repo names.
export const POOL_SIZES = ["lite", "basic", "standard-2", "standard-4"];
const str = (v) => typeof v === "string" && v.length > 0;
const count = (v) => Number.isInteger(v) && v >= 0;

export function validatePool(v) {
  const errors = [];
  for (const k of ["id", "name"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!POOL_SIZES.includes(v?.size)) errors.push(`size: expected one of ${POOL_SIZES.join(", ")}`);
  for (const k of ["min", "max", "workers", "online"]) if (!count(v?.[k])) errors.push(`${k}: expected integer >= 0`);
  if (v?.repo !== null && !str(v?.repo)) errors.push("repo: expected non-empty string or null");
  if (!Array.isArray(v?.kinds) || !v.kinds.length || !v.kinds.every((k) => JOB_KINDS.includes(k))) errors.push("kinds: expected a non-empty list of job kinds");
  for (const k of ["draining", "default"]) if (typeof v?.[k] !== "boolean") errors.push(`${k}: expected boolean`);
  if (!count(v?.runs_per_hour)) errors.push("runs_per_hour: expected integer >= 0");
  if (v?.median_start_s !== null && !count(v?.median_start_s)) errors.push("median_start_s: expected integer >= 0 or null");
  if (Number.isNaN(Date.parse(v?.created_at))) errors.push("created_at: expected ISO timestamp");
  validateSettings(v, errors);
  return { ok: errors.length === 0, errors };
}

// The settings a managed or BYO pool returns; pushes onto errors.
export function validateSettings(v, errors) {
  for (const k of ["labels", "egress_allow"]) if (!Array.isArray(v?.[k]) || !v[k].every(str)) errors.push(`${k}: expected a list of non-empty strings`);
  if (!count(v?.keep_warm_s)) errors.push("keep_warm_s: expected integer >= 0");
  if (!Number.isInteger(v?.max_concurrent) || v.max_concurrent < 1) errors.push("max_concurrent: expected integer >= 1");
  if (!str(v?.placement)) errors.push("placement: expected non-empty string");
  if (!["allowlist", "none", "open"].includes(v?.egress)) errors.push("egress: expected allowlist, none or open");
  if (v?.repos !== "*" && !(Array.isArray(v?.repos) && v.repos.length && v.repos.every(str))) errors.push('repos: expected "*" or a non-empty list of repo names');
}
