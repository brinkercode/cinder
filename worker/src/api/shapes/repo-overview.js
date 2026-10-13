// The Repos page's data: GET /api/overview (overview.js) plus the stat strip and each repo's activity from its changes.
import { validateOverview } from "./overview.js";

const count = (v) => Number.isInteger(v) && v >= 0;
const text = (v) => typeof v === "string" && v.length > 0;
const unit = (v) => typeof v === "number" && v >= 0 && v <= 1;
const time = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

export function validateRepoOverview(v) {
  const errors = validateOverview(v).errors;
  for (const k of ["slots", "merged_today"]) if (!count(v?.[k])) errors.push(`${k}: expected integer >= 0`);
  if (Array.isArray(v?.repos)) v.repos.forEach((r, i) => {
    const at = (m) => errors.push(`repos[${i}].${m}`);
    for (const k of ["active", "merged", "conflicts"]) if (!count(r?.[k])) at(`${k}: expected integer >= 0`);
    if (!(count(r?.verifier?.n) && (r.verifier.pass === null || (r.verifier.pass >= 0 && r.verifier.pass <= 100)))) at("verifier: expected { n, pass: null or 0-100 }");
    const j = r?.lead_judge;
    if (j !== null && !(text(j?.name) && count(j.count) && unit(j.brier) && typeof j.trusted === "boolean")) {
      at("lead_judge: expected null or { name, count, brier, trusted }");
    }
    const m = r?.last_merge;
    if (m !== null && !(text(m?.sha) && text(m.branch) && time(m.at))) at("last_merge: expected null or { sha, branch, at }");
  });
  return { ok: errors.length === 0, errors };
}
