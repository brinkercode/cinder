import { cloudflare } from "./deploy.js";

const label = (v) => v === undefined || v === null || (typeof v === "string" && v.trim() !== "");

// Validates and stores usage rows for repoId; returns the first bad row's error, else null (nothing stored).
async function saveUsage(env, repoId, rows) {
  for (const [i, r] of rows.entries()) {
    const ok = typeof r?.id === "string" && r.id && !Number.isNaN(Date.parse(r.at)) && Number.isInteger(r.tokens) && r.tokens >= 0 &&
      typeof r.cost_usd === "number" && r.cost_usd >= 0 && label(r.change_id) && label(r.agent_version) && label(r.person) && label(r.job_id);
    const c = r?.call, call = c === undefined || (["run_id", "model", "name"].every((k) => typeof c?.[k] === "string" && c[k]) &&
      ["input_tokens", "output_tokens", "latency_ms"].every((k) => Number.isInteger(c[k]) && c[k] >= 0));
    if (!ok || !call) return `[${i}]: expected {id, at, tokens >= 0, cost_usd >= 0}, non-empty change_id, agent_version, person, job_id when set and a call {run_id, model, name, input_tokens, output_tokens, latency_ms} when set`;
  }
  if (rows.length) {
    await env.DB.batch([...rows.map((r) => env.DB.prepare(
      "INSERT OR IGNORE INTO usage_logs (id, repo_id, at, change_id, agent_version, person, tokens, cost_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
    ).bind(r.id, repoId, new Date(r.at).toISOString(), r.change_id ?? null, r.agent_version ?? null, r.person ?? null, r.tokens, r.cost_usd)),
    ...rows.filter((r) => r.call).map(({ id, call: c }) => env.DB.prepare("INSERT OR IGNORE INTO usage_calls VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, c.run_id, c.model, c.name, c.input_tokens, c.output_tokens, c.latency_ms)),
    ...rows.filter((r) => r.job_id).map((r) => env.DB.prepare("INSERT OR IGNORE INTO job_gateway_logs (log_id, job_id) VALUES (?, ?)").bind(r.id, r.job_id))]);
  }
  return null;
}

const text = (v) => (typeof v === "string" && v.trim() ? v : undefined);

// Cron: pulls the AI Gateway's logs (AI_GATEWAY_ID, set by deploy/cloudflare-up.sh) newest first into usage_logs, stopping at the
// first page it already has. cf-aig-metadata {repo, change, agent_version, person, job} attributes a log (runner harness.go sets
// it); a log without it lands under no repo (repo_id '', the all-repos lens) as outside cinder. A log with a model also gets its
// usage_calls row (run: the metadata job, else the change), which the Agents page lists call by call.
export async function pullUsage(env, fetcher = fetch) {
  if (!env.AI_GATEWAY_ID) return;
  for (let page = 1; ; page++) {
    const { result: logs } = await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${env.AI_GATEWAY_ID}/logs` +
      `?order_by=created_at&order_by_direction=desc&per_page=50&page=${page}`, {}, fetcher);
    if (!logs?.length) return;
    const known = await env.DB.prepare("SELECT COUNT(*) AS n FROM usage_logs WHERE id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(logs.map((l) => l.id))).first("n");
    const rows = logs.map((l) => {
      let meta = l.metadata ?? {};
      // Metadata the gateway can't hand back as JSON is no cinder metadata: the log counts as outside cinder.
      if (typeof meta === "string") try { meta = JSON.parse(meta); } catch { meta = {}; }
      const [input_tokens, output_tokens, run_id] = [l.tokens_in ?? 0, l.tokens_out ?? 0, text(meta?.job) ?? text(meta?.change) ?? l.id];
      return { repo: text(meta?.repo) ?? "", id: l.id, at: l.created_at, tokens: input_tokens + output_tokens, cost_usd: l.cost ?? 0,
        change_id: text(meta?.change), agent_version: text(meta?.agent_version), person: text(meta?.person), job_id: text(meta?.job),
        // The call's name is the gateway path it went through (e.g. workers-ai/@cf/...), else its model.
        ...(text(l.model) && { call: { run_id, model: l.model, name: text(l.path) ?? l.model, input_tokens, output_tokens, latency_ms: Math.round(l.duration ?? 0) } }) };
    });
    for (const [repo, group] of Map.groupBy(rows, (r) => r.repo)) {
      const bad = await saveUsage(env, repo, group);
      if (bad) throw new Error(`usage: gateway log ${bad}`);
    }
    if (known === logs.length || logs.length < 50) return;
  }
}
