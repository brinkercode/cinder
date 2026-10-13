// GET /api/fleet (src/fleet.js): per-agent figures from AI Gateway logs and auto-promote; GET /api/models/catalog: models and their harnesses.
const str = (v) => typeof v === "string" && v.length > 0;
const num = (v) => typeof v === "number" && v >= 0;
const call = (c) => str(c?.model) && str(c?.call) && ["input_tokens", "output_tokens", "cost_usd", "latency_ms"].every((k) => num(c[k]));
const run = (r) => r === null || (str(r?.id) && ["change_id", "repo", "state"].every((k) => r[k] === null || str(r[k])) && Array.isArray(r.calls) && r.calls.every(call));
// Why an agent takes no new jobs: "budget" while this month's spend is at or over the account's budget (resumes_at is
// when the month resets). Jobs it already holds run on.
export const AGENT_PAUSE_REASONS = ["budget"];
const paused = (p) => p === null || (AGENT_PAUSE_REASONS.includes(p?.reason) && !Number.isNaN(Date.parse(p.resumes_at)));
const agent = (a) => str(a?.name) && typeof a.role === "string" && typeof a.running === "boolean" && run(a.run) && paused(a.paused) &&
  ["tokens", "repos", "merged", "runs_24h", "tokens_24h", "cost_24h"].every((k) => num(a[k]));

export function validateFleet(v) {
  const errors = [];
  if (typeof v?.canary_auto_promote !== "boolean") errors.push("canary_auto_promote: expected boolean");
  if (!Array.isArray(v?.agents)) errors.push("agents: expected array");
  else v.agents.forEach((a, i) => agent(a) || errors.push(`agents[${i}]: expected {name, role, tokens, repos, merged, running, runs_24h, tokens_24h, cost_24h, run, paused}`));
  return { ok: errors.length === 0, errors };
}

const model = (v) => ["id", "provider", "context", "price"].every((k) => str(v?.[k])) && Array.isArray(v.harnesses) && v.harnesses.every(str) && typeof v.hosted === "boolean";
export const validateCatalogModel = (v) => (model(v) ? { ok: true, errors: [] } : { ok: false, errors: ["expected {id, provider, context, price, harnesses, hosted}"] });
