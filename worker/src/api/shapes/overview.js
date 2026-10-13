// GET /api/overview (src/overview.js): the account, its monthly agent-token budget and this month's spend, per live repo
// its description, language, last push, active agents and spend, and the archived repos. account.id is null off Cloudflare.
// Budget alert thresholds in %: 10 to 100 in steps of 5.
export const ALERT_THRESHOLDS = Array.from({ length: 19 }, (_, i) => 10 + 5 * i);
const count = (v) => Number.isInteger(v) && v >= 0;
const text = (v) => typeof v === "string" && v.length > 0;
const time = (v) => typeof v === "string" && !Number.isNaN(Date.parse(v));

export function validateOverview(v) {
  const errors = [];
  const a = v?.account, b = v?.budget;
  if (!((a?.id === null || text(a?.id)) && text(a?.name) && text(a?.git_host))) errors.push("account: expected { id: null or string, name, git_host }");
  if (!((b?.tokens === null || (count(b?.tokens) && b.tokens > 0)) && count(b?.spent) && time(b?.resets_at) &&
    Array.isArray(b?.alerts) && b.alerts.every((t) => ALERT_THRESHOLDS.includes(t)))) {
    errors.push("budget: expected { tokens: null or integer > 0, spent, resets_at, alerts: [10 to 100 in steps of 5] }");
  }
  if (!Array.isArray(v?.repos)) errors.push("repos: expected array");
  else v.repos.forEach((r, i) => {
    const at = (m) => errors.push(`repos[${i}].${m}`);
    if (!text(r?.repo_id)) at("repo_id: expected non-empty string");
    if (typeof r?.description !== "string") at("description: expected string");
    if (!(r?.language === null || text(r?.language))) at("language: expected null or non-empty string");
    for (const k of ["agents", "spent"]) if (!count(r?.[k])) at(`${k}: expected integer >= 0`);
    if (!time(r?.pushed_at)) at("pushed_at: expected ISO timestamp");
  });
  if (!(Array.isArray(v?.archived) && v.archived.every((r) => text(r?.name) && time(r?.archived_at)))) errors.push("archived: expected [{ name, archived_at }]");
  return { ok: errors.length === 0, errors };
}
