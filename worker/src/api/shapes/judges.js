import { validateJudge } from "../contract.js";
import { validateJudgeConfig } from "./judge-config.js";

// The repo's trust thresholds (src/calibration.js trustOf), sent so the UI can show "untrusted: n of min".
export function trustErrors(t) {
  const ok = Number.isInteger(t?.min_outcomes) && t.min_outcomes >= 1 && Number.isInteger(t?.min_races) && t.min_races >= 1;
  return ok ? [] : ["trust: expected { min_outcomes, min_races } integers >= 1"];
}

// GET /api/repos/:name/judges returns this: whether airlock is on, the trust thresholds, and one entry per judge series.
export function validateJudges(v) {
  const errors = trustErrors(v?.trust);
  if (typeof v?.airlock !== "boolean") errors.push("airlock: expected boolean");
  if (!Array.isArray(v?.judges)) errors.push("judges: expected array");
  else v.judges.forEach((j, i) => errors.push(...validateJudge(j).errors.map((e) => `judges[${i}].${e}`),
    ...(j.config == null ? [] : validateJudgeConfig(j.config).errors.map((e) => `judges[${i}].config.${e}`))));
  return { ok: errors.length === 0, errors };
}
