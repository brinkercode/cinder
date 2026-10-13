import { error } from "./router.js";

const DAYS = { "24h": 1, "7d": 7, "30d": 30 };
const TOP = 10;
const VERDICTS = ["allowed", "denied", "would_deny"];
const zero = () => ({ allowed: 0, denied: 0, would_deny: 0 });

// GET /api/repos/:name/egress?window=24h|7d|30d (default 24h) → {window, versions: [{agent, counts, allowed, denied, would_deny}],
// jobs: [{job_id, agent, counts}]}: each agent version's top hosts per verdict and CONNECT totals per verdict (the egress proxy's
// summary), summed over the jobs it reported in the window, plus each of those jobs' totals.
export async function getEgress(request, env, { name }) {
  const window = new URL(request.url).searchParams.get("window") ?? "24h";
  if (!DAYS[window]) return error(400, "bad_request", "window must be 24h, 7d or 30d");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const since = new Date(Date.now() - DAYS[window] * 86400000).toISOString();
  // lazy: sums every host and job in the window in JS; rank and page in SQL if a repo sees thousands of hosts or jobs.
  const [{ results: hosts }, { results: perJob }] = await env.DB.batch([
    env.DB.prepare("SELECT agent, host, verdict, SUM(count) AS count FROM job_egress_verdicts WHERE repo_id = ? AND at >= ? " +
      "GROUP BY agent, host, verdict ORDER BY agent, count DESC, host").bind(repo.id, since),
    env.DB.prepare("SELECT job_id, agent, verdict, SUM(count) AS count, MAX(at) AS at FROM job_egress_verdicts WHERE repo_id = ? AND at >= ? " +
      "GROUP BY job_id, agent, verdict ORDER BY at DESC, job_id").bind(repo.id, since),
  ]);
  const versions = new Map();
  for (const r of hosts) {
    if (!versions.has(r.agent)) versions.set(r.agent, { agent: r.agent, counts: zero(), ...Object.fromEntries(VERDICTS.map((v) => [v, []])) });
    const v = versions.get(r.agent);
    v.counts[r.verdict] += r.count;
    if (v[r.verdict].length < TOP) v[r.verdict].push({ host: r.host, count: r.count });
  }
  const jobs = new Map();
  for (const r of perJob) {
    if (!jobs.has(r.job_id)) jobs.set(r.job_id, { job_id: r.job_id, agent: r.agent, counts: zero() });
    jobs.get(r.job_id).counts[r.verdict] = r.count;
  }
  return Response.json({ window, versions: [...versions.values()], jobs: [...jobs.values()] });
}
