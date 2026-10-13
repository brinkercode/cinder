import { trustErrors } from "./judges.js";

// The overview's activity metrics (an activity summary plus DORA).
export const ACTIVITY_METRICS = ["changes_per_day", "merges_per_day", "lead_time_hours", "review_time_hours", "failure_rate", "deploys_per_day", "change_fail_rate"];

// GET /api/repos/:name/insights returns this: the repo's trust thresholds and metrics. A metric is {value, count}, or {untrusted: true, count} when it has no
// (or too little) data: an untrusted metric never carries a value.
export function validateInsights(v) {
  const errors = trustErrors(v?.trust);
  const metric = (m, path) => {
    if (!(Number.isInteger(m?.count) && m.count >= 0)) errors.push(`${path}.count: expected integer >= 0`);
    if (m?.untrusted === true ? "value" in m : !(typeof m?.value === "number" && m.value >= 0)) {
      errors.push(`${path}: expected {value: number >= 0} or {untrusted: true} without a value`);
    }
  };
  for (const k of ["from", "to"]) if (Number.isNaN(Date.parse(v?.[k]))) errors.push(`${k}: expected ISO timestamp`);
  for (const k of ["cost_per_merged_change", "parallelism", "conflict_rate", "tokens_per_merged_change", ...ACTIVITY_METRICS]) metric(v?.[k], k);
  for (const k of ["top_agents", "top_people"]) {
    if (!(Array.isArray(v?.[k]) && v[k].every((a) => typeof a?.id === "string" && a.id && Number.isInteger(a.changes) && a.changes > 0))) {
      errors.push(`${k}: expected [{ id, changes > 0 }]`);
    }
  }
  if (!Array.isArray(v?.win_rates)) errors.push("win_rates: expected array");
  else v.win_rates.forEach((w, i) => (typeof w?.agent === "string" && w.agent ? metric(w, `win_rates[${i}]`) : errors.push(`win_rates[${i}].agent: expected non-empty string`)));
  if (!Array.isArray(v?.brier)) errors.push("brier: expected array");
  else v.brier.forEach((b, i) => (/^\d{4}-\d{2}-\d{2}$/.test(b?.day) ? metric(b, `brier[${i}]`) : errors.push(`brier[${i}].day: expected YYYY-MM-DD`)));
  // One point per UTC day in the window, oldest first.
  if (!Array.isArray(v?.daily)) errors.push("daily: expected array");
  else v.daily.forEach((p, i) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(p?.day)) errors.push(`daily[${i}].day: expected YYYY-MM-DD`);
    for (const k of ["tokens", "cache_reads", "merged"]) if (!(Number.isInteger(p?.[k]) && p[k] >= 0)) errors.push(`daily[${i}].${k}: expected integer >= 0`);
    for (const k of ["parallelism", "conflict_rate"]) if (!(typeof p?.[k] === "number" && p[k] >= 0)) errors.push(`daily[${i}].${k}: expected number >= 0`);
  });
  // 48 buckets over the window, and AI Gateway usage; a usage row is outside cinder when its log lacks cinder's metadata.
  const int = (x) => Number.isInteger(x) && x >= 0, usd = (x) => typeof x === "number" && x >= 0;
  if (!(Array.isArray(v?.series) && v.series.length === 48 && v.series.every((b) => !Number.isNaN(Date.parse(b?.at)) &&
    ["merged", "passed", "failed", "tokens"].every((k) => int(b[k])) && usd(b.cost_usd)))) errors.push("series: expected 48 { at, merged, passed, failed, tokens, cost_usd }");
  const c = v?.calibration;
  if (!(int(c?.count) && (c.count ? usd(c.brier) : c.brier === null) && Array.isArray(c.bins) &&
    c.bins.every((b) => usd(b?.mean_p) && usd(b.observed) && int(b.count)))) errors.push("calibration: expected { count, brier (null without outcomes), bins: [{ mean_p, observed, count }] }");
  if (!(int(v?.lease_conflicts?.conflicts) && int(v.lease_conflicts.leases))) errors.push("lease_conflicts: expected { conflicts, leases }");
  const u = v?.usage;
  const rows = (list) => Array.isArray(list) && list.every((r) => typeof r?.name === "string" && r.name && int(r.tokens) && usd(r.cost_usd) && int(r.merged) && typeof r.outside === "boolean");
  if (!(int(u?.tokens) && usd(u.cost_usd) && rows(u.by_agent) && rows(u.by_person) && Array.isArray(u.by_change) &&
    u.by_change.every((r) => typeof r?.change_id === "string" && r.change_id && usd(r.cost_usd)))) {
    errors.push("usage: expected { tokens, cost_usd, by_agent, by_person: [{ name, tokens, cost_usd, merged, outside }], by_change: [{ change_id, cost_usd }] }");
  }
  // Each tile's backing list: an API path and its string query, e.g. the paged changes list filtered to failed since from.
  const str = (x) => typeof x === "string" && x !== "";
  if (!(Array.isArray(v?.lists) && v.lists.every((l) => str(l?.metric) && str(l.list?.path) && l.list.path.startsWith("/api/") &&
    l.list.query !== null && typeof l.list.query === "object" && !Array.isArray(l.list.query) && Object.values(l.list.query).every((q) => typeof q === "string")))) {
    errors.push("lists: expected [{ metric, list: { path: /api/..., query: { [key]: string } } }]");
  }
  return { ok: errors.length === 0, errors };
}
