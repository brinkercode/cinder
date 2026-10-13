import { calibrate, trustOf } from "./calibration.js";
import { cloudflare } from "./deploy.js";
import { error } from "./router.js";

const DAY = 86400000;
// A metric with no data (or, for rates that need a sample, too little) carries only its count, never a value.
const metric = (value, count, trusted = count > 0) => (trusted ? { value, count } : { untrusted: true, count });

// Every Analytics Engine point ChangeDO wrote for the repo (null: every repo), oldest first, read through the SQL API.
// Tests bind INSIGHTS_SQL to a fake dataset (test/fakes/analytics.js): Analytics Engine has no local SQL API.
// lazy: reads the repo's whole 90-day retention and filters in JS; filter on double1 in SQL past ~100k points per repo.
async function insightPoints(env, repoId) {
  if (repoId !== null && !/^[\w-]+$/.test(repoId)) throw new Error(`insights: bad repo id ${repoId}`);
  const sql = "SELECT blob1, blob2, blob3, blob4, blob5, blob6, double1, double2, double3, double4 FROM cinder_insights" +
    `${repoId === null ? "" : ` WHERE index1 = '${repoId}'`} ORDER BY double1 FORMAT JSON`;
  const api = async (body) => (await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/analytics_engine/sql`, { method: "POST", body })).data;
  return (env.INSIGHTS_SQL ?? api)(sql);
}

// GET /api/repos/:name/insights?from&to → Insights over [from, to) (default: the last 30 days); ?days=N is the last N UTC days, today included.
// ?branch=B (default: the repo's default branch) counts only changes targeting B.
export async function getInsights(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const q = new URL(request.url).searchParams;
  const to = q.has("to") ? Date.parse(q.get("to")) : Date.now();
  const from = q.has("days") ? (Math.floor(to / DAY) - Number(q.get("days")) + 1) * DAY : q.has("from") ? Date.parse(q.get("from")) : to - 30 * DAY;
  if (!(from < to) || to - from > 366 * DAY) return error(400, "bad_request", "from and to must be timestamps with from < to, at most 366 days apart");
  const trust = await trustOf(env.DB, repo.id);
  const [f, t] = [new Date(from).toISOString(), new Date(to).toISOString()];
  const inWindow = (at) => at >= f && at < t;

  const { results } = await env.DB.prepare("SELECT id, created_at FROM changes WHERE (?1 IS NULL OR repo_id = ?1) AND (?2 IS NULL OR target_branch = ?2)")
    .bind(repo.id, q.get("branch") ?? repo.default_branch ?? null).all();
  const byId = new Map(results.map(({ id, created_at }) => [id, { id, created_at, events: [], stages: [] }]));
  // A 401/403 from the SQL API means the deploy token lacks the analytics permission.
  const points = await insightPoints(env, repo.id).catch((err) => {
    if (err.status === 401 || err.status === 403) return null;
    throw err;
  });
  if (!points) return error(503, "analytics_unauthorized", "CF_DEPLOY_TOKEN needs the Account Analytics: Read permission to query Analytics Engine");
  for (const r of points) {
    const c = byId.get(r.blob2);
    if (c && r.blob1 === "event") c.events.push({ from_state: r.blob3 || null, to_state: r.blob4 || null, actor: { type: r.blob5, id: r.blob6 }, at: new Date(r.double1).toISOString() });
    if (c && r.blob1 === "stage") c.stages.push({ stage: r.blob3, verdict: r.blob4 || null, started_at: new Date(r.double1).toISOString(), cost_usd: r.double2, tokens: r.double3, cache_reads: r.double4 });
  }
  const changes = [...byId.values()];
  const events = changes.flatMap((c) => c.events).filter((e) => inWindow(e.at));
  const count = (state) => events.filter((e) => e.to_state === state).length;
  const merged = count("merged");
  const mergedIds = new Set(changes.filter((c) => c.events.some((e) => e.to_state === "merged" && inWindow(e.at))).map((c) => c.id));
  // Runners report stage cost as 0; the spend is the AI Gateway usage logged against the merged changes, whenever it was spent.
  const cost = await env.DB.prepare("SELECT coalesce(sum(cost_usd), 0) AS c FROM usage_logs WHERE change_id IN (SELECT value FROM json_each(?))")
    .bind(JSON.stringify([...mergedIds])).first("c");
  // A merged change counts once however often it conflicted, so the rate stays within [0, 1].
  const conflicted = (c) => c.events.some((e) => e.to_state === "conflict");

  // Mean number of changes in developing over the window; spans are clipped to it and open spans end at `to`.
  const spans = changes.flatMap(({ events: log }) => {
    const out = [];
    for (const e of log) {
      if (e.to_state === "developing") out.push([Date.parse(e.at), to]);
      else if (e.from_state === "developing" && out.length && out.at(-1)[1] === to) out.at(-1)[1] = Date.parse(e.at);
    }
    return out.map(([a, b]) => [Math.max(a, from), Math.min(b, to)]).filter(([a, b]) => a < b);
  });
  const busy = spans.reduce((sum, [a, b]) => sum + (b - a), 0);

  // Lead time (created → merged) and review time (first verifying → first in_queue), mean hours over changes merged in the window.
  const at = (c, state) => Date.parse(c.events.find((e) => e.to_state === state)?.at);
  const hours = (pick) => {
    const xs = changes.filter((c) => inWindow(c.events.find((e) => e.to_state === "merged")?.at ?? "")).map(pick).filter((x) => x >= 0);
    return metric(xs.length && xs.reduce((sum, x) => sum + x, 0) / xs.length / 3600000, xs.length);
  };
  const created = changes.filter((c) => inWindow(c.created_at ?? "")).length;
  const failed = count("failed");
  // DORA change-fail rate: merged changes a later revert or fix named (scoreMerge records their risk outcome "yes").
  const deploys = await env.DB.prepare(
    "SELECT COUNT(*) AS n, COALESCE(SUM(EXISTS (SELECT 1 FROM judgments j JOIN outcomes o ON o.judgment_id = j.id " +
    "WHERE j.change_id = m.change_id AND j.kind = 'risk' AND o.actual = 'yes')), 0) AS failed " +
    "FROM change_merges m WHERE (?1 IS NULL OR m.repo_id = ?1) AND m.merged_at >= ? AND m.merged_at < ?",
  ).bind(repo.id, f, t).first();
  // Top agents and people: how many changes each acted on in the window.
  const top = (type) => {
    const n = new Map();
    for (const c of changes) {
      for (const id of new Set(c.events.filter((e) => e.actor?.type === type && inWindow(e.at)).map((e) => e.actor.id))) n.set(id, (n.get(id) ?? 0) + 1);
    }
    return [...n].map(([id, k]) => ({ id, changes: k })).toSorted((a, b) => b.changes - a.changes).slice(0, 5);
  };
  const perDay = (n) => metric(n / ((to - from) / DAY), n);

  const { results: races } = await env.DB.prepare(
    "SELECT l.agent, COUNT(*) AS n, SUM(l.won) AS wins FROM race_legs l JOIN changes c ON c.id = l.change_id " +
    "WHERE (?1 IS NULL OR c.repo_id = ?1) AND l.won IS NOT NULL AND l.started_at >= ? AND l.started_at < ? GROUP BY l.agent ORDER BY l.agent",
  ).bind(repo.id, f, t).all();
  const { results: outcomes } = await env.DB.prepare(
    "SELECT substr(o.observed_at, 1, 10) AS day, j.probability AS p, o.correct AS y FROM judgments j JOIN outcomes o ON o.judgment_id = j.id " +
    "WHERE (?1 IS NULL OR j.repo_id = ?1) AND o.observed_at >= ? AND o.observed_at < ?",
  ).bind(repo.id, f, t).all();
  const byDay = Map.groupBy(outcomes, (o) => o.day);
  // Daily counters cover whole UTC days, the first and last included.
  const counted = new Map();
  const add = (iso, n) => {
    const c = counted.get(iso.slice(0, 10)) ?? { tokens: 0, cache_reads: 0, merged: 0, conflicts: 0 };
    for (const k in n) c[k] += n[k];
    counted.set(iso.slice(0, 10), c);
  };
  for (const s of changes.flatMap((c) => c.stages)) add(s.started_at, { tokens: s.tokens, cache_reads: s.cache_reads });
  for (const c of changes) for (const e of c.events) if (e.to_state === "merged") add(e.at, { merged: 1, conflicts: +conflicted(c) });
  const brier = [];
  const daily = [];
  let tokens = 0;
  let merges = 0;
  for (let d = Date.parse(f.slice(0, 10)); d < to; d += DAY) {
    const day = new Date(d).toISOString().slice(0, 10);
    const { brier: value, count: n, trusted } = calibrate(byDay.get(day) ?? [], trust.min_outcomes);
    brier.push({ day, ...metric(value, n, trusted) });
    const c = counted.get(day) ?? { tokens: 0, cache_reads: 0, merged: 0, conflicts: 0 };
    tokens += c.tokens;
    merges += c.merged;
    // The first and last days are clipped to the window.
    const [a0, b0] = [Math.max(d, from), Math.min(d + DAY, to)];
    const dayBusy = spans.reduce((sum, [a, b]) => sum + Math.max(0, Math.min(b, b0) - Math.max(a, a0)), 0);
    daily.push({
      day, tokens: c.tokens, cache_reads: c.cache_reads, merged: c.merged,
      parallelism: dayBusy / (b0 - a0), conflict_rate: c.merged && c.conflicts / c.merged,
    });
  }

  // 48 equal buckets over the window: merges, verifier runs and AI Gateway usage.
  // lazy: usage is the repo's gateway logs, never filtered by branch (a run outside cinder has no change, so no branch).
  const { results: usage } = await env.DB.prepare("SELECT * FROM usage_logs WHERE (?1 IS NULL OR repo_id = ?1) AND at >= ? AND at < ?").bind(repo.id, f, t).all();
  const step = (to - from) / 48;
  const series = Array.from({ length: 48 }, (_, i) => ({ at: new Date(from + i * step).toISOString(), merged: 0, passed: 0, failed: 0, tokens: 0, cost_usd: 0 }));
  const bucket = (iso) => series[Math.min(47, Math.floor((Date.parse(iso) - from) / step))];
  for (const e of events) if (e.to_state === "merged") bucket(e.at).merged++;
  for (const s of changes.flatMap((c) => c.stages)) if (s.stage === "verify" && s.verdict && inWindow(s.started_at)) bucket(s.started_at)[s.verdict === "pass" ? "passed" : "failed"]++;
  for (const u of usage) bucket(u.at).tokens += u.tokens;
  for (const u of usage) bucket(u.at).cost_usd += u.cost_usd;
  // Rows grouped by agent version or person; a row missing any cinder metadata is outside cinder and grouped apart.
  const outsideOf = (u) => !(u.change_id && u.agent_version && u.person);
  const group = (key) => [...Map.groupBy(usage, (u) => `${u[key]} ${outsideOf(u)}`).values()].map((rows) => ({
    name: rows[0][key] ?? "unknown", outside: outsideOf(rows[0]), tokens: rows.reduce((n, u) => n + u.tokens, 0), cost_usd: rows.reduce((n, u) => n + u.cost_usd, 0),
    merged: new Set(rows.map((u) => u.change_id).filter((id) => mergedIds.has(id))).size,
  })).toSorted((a, b) => b.tokens - a.tokens);
  // A by_agent row naming a registered <agent>@v<n> carries that version's token limits (null: no limit).
  // lazy: reads every agent version's limits; filter by the rows' names past ~1k versions.
  const { results: versions } = await env.DB.prepare("SELECT name || '@v' || version AS id, json_extract(limits, '$.max_tokens') AS max_tokens, " +
    "json_extract(limits, '$.max_tokens_month') AS max_tokens_month FROM agent_versions").all();
  const limitsOf = new Map(versions.map(({ id, max_tokens, max_tokens_month }) => [id, { max_tokens, max_tokens_month }]));
  const perChange = new Map();
  for (const u of usage) if (u.change_id) perChange.set(u.change_id, (perChange.get(u.change_id) ?? 0) + u.cost_usd);
  // The calibration card trusts 20 outcomes (the UI's trust rule), not a judge series' min_outcomes.
  const cal = calibrate(outcomes, 20);
  // The list that backs each metric's tiles; the all-repos view has no repo lists to name.
  const base = `/api/repos/${encodeURIComponent(name)}`;
  const lists = name === undefined ? [] : [
    { metric: "change_fail_rate", list: { path: `${base}/changes`, query: { state: "failed", since: f } } },
    { metric: "lease_conflicts", list: { path: `${base}/lease-map`, query: {} } },
    { metric: "calibration", list: { path: `${base}/judges`, query: {} } },
    { metric: "usage.by_agent", list: { path: "/api/agents", query: {} } },
  ];

  return Response.json({
    trust,
    from: f,
    to: t,
    cost_per_merged_change: metric(merged && cost / merged, merged),
    parallelism: metric(busy / (to - from), spans.length),
    conflict_rate: metric(merged && changes.filter((c) => mergedIds.has(c.id) && conflicted(c)).length / merged, merged),
    tokens_per_merged_change: metric(merges && tokens / merges, merges),
    changes_per_day: perDay(created),
    merges_per_day: perDay(merged),
    lead_time_hours: hours((c) => at(c, "merged") - Date.parse(c.created_at)),
    review_time_hours: hours((c) => at(c, "in_queue") - at(c, "verifying")),
    failure_rate: metric(merged + failed && failed / (merged + failed), merged + failed),
    // Every merge ships to its target branch, so a merge is a deploy; environment syncs are not counted.
    deploys_per_day: perDay(deploys.n),
    change_fail_rate: metric(deploys.n && deploys.failed / deploys.n, deploys.n),
    top_agents: top("agent"),
    top_people: top("human"),
    // A win rate counts once it has trust.min_races decided races.
    win_rates: races.map(({ agent, n, wins }) => ({ agent, ...metric(wins / n, n, n >= trust.min_races) })),
    brier,
    daily,
    series,
    calibration: { count: cal.count, brier: cal.brier, bins: cal.bins },
    lease_conflicts: { conflicts: count("conflict"), leases: count("leased") },
    usage: {
      tokens: usage.reduce((n, u) => n + u.tokens, 0), cost_usd: usage.reduce((n, u) => n + u.cost_usd, 0),
      by_agent: group("agent_version").map((r) => (!r.outside && limitsOf.has(r.name) ? { ...r, limits: limitsOf.get(r.name) } : r)), by_person: group("person"),
      by_change: [...perChange].map(([change_id, cost_usd]) => ({ change_id, cost_usd })).toSorted((a, b) => b.cost_usd - a.cost_usd).slice(0, 5),
    },
    lists,
  });
}
