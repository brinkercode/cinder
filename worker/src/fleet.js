// Automation › Agents beyond GET /api/agents: AI Gateway's logs (usage.js) and canary auto-promote.
import { cloudflare } from "./deploy.js";
import { budgetUse } from "./overview.js";
import { error } from "./router.js";

// Claude Code runs Anthropic models only and Codex OpenAI's; OpenCode runs any provider's.
const harnessesFor = (provider) => [{ anthropic: "claude-code", openai: "codex" }[provider], "opencode"].filter(Boolean);
const withHarnesses = (m) => ({ ...m, hosted: m.provider === "cf", harnesses: harnessesFor(m.provider) });
// The harnesses that can run model id: "<provider>/<model>" names its provider; a bare "claude-…" is Anthropic's, "gpt-…" or "o<n>…" OpenAI's.
export const modelHarnesses = (id) => harnessesFor(id.includes("/") ? id.split("/")[0] : /^claude-/.test(id) ? "anthropic" : /^(gpt-|o\d)/.test(id) ? "openai" : "");

// One row of Cloudflare's model catalog: "@cf/..." models run on Workers AI, "<provider>/<model>" ones on that provider.
// Third-party entries carry model_id, provider_id, context_length and pricing instead of name and properties.
function catalogRow({ name, model_id: id = name, provider_id, context_length, pricing, properties = [] }) {
  const prop = (k) => properties.find((p) => p.property_id === k)?.value;
  const ctx = Number(context_length ?? prop("context_window")), price = prop("price");
  const per = (dir) => (pricing ? Object.entries(pricing).find(([k]) => k.toLowerCase().startsWith(`${dir} tokens`))?.[1] : price?.find?.((p) => p.unit?.includes(dir))?.price);
  return { id, provider: provider_id ?? (id.startsWith("@cf/") ? "cf" : id.split("/")[0]),
    context: ctx > 0 ? (ctx >= 1e6 ? `${ctx / 1e6}M` : `${Math.round(ctx / 1e3)}k`) : "—",
    price: per("input") != null && per("output") != null ? `$${per("input")} / $${per("output")}` : "—" };
}

// GET /api/models/catalog[?harness=] → the models agents can run, with the harnesses each works with. Reads Cloudflare's
// catalog cached in D1, refreshing it once a day; a failed refresh serves the stale cache.
// lazy: one page of 1000 models; page through once the catalog outgrows it.
export async function getCatalog(request, env) {
  const read = () => env.DB.prepare("SELECT id, provider, context, price, fetched_at FROM model_catalog ORDER BY rowid").all();
  let { results } = await read();
  if (!results.length || Date.now() - Date.parse(results[0].fetched_at) > 864e5) {
    try {
      // Text generation is picked here, not with ?task=: third-party models give their task as a plain string, not {name}.
      const { result } = await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/ai/models/search?per_page=1000`);
      const id = (m) => m?.model_id ?? m?.name, task = (m) => m.task?.name ?? m.task ?? "Text Generation";
      await saveCatalog(env, result.filter((m) => typeof id(m) === "string" && id(m) && task(m) === "Text Generation").map(catalogRow));
      ({ results } = await read());
    } catch (err) {
      if (!results.length) return error(502, "catalog_unavailable", `model catalog: ${err.message}`);
    }
  }
  const harness = new URL(request.url).searchParams.get("harness");
  return Response.json(results.map(({ id, provider, context, price }) => withHarnesses({ id, provider, context, price })).filter((m) => !harness || m.harnesses.includes(harness)));
}

const saveCatalog = (env, models, at = new Date().toISOString()) => env.DB.batch([env.DB.prepare("DELETE FROM model_catalog"),
  ...models.map((m) => env.DB.prepare("INSERT OR REPLACE INTO model_catalog VALUES (?, ?, ?, ?, ?)").bind(m.id, m.provider, m.context, m.price, at))]);

// GET /api/fleet → {canary_auto_promote, agents: [{name, role, tokens, repos, merged, running, runs_24h, tokens_24h,
// cost_24h, run, paused}]} (api/shapes/fleet.js); paused is {reason: "budget", resumes_at} while the budget pauses agent
// work. run is the agent's latest run with each AI Gateway call, or null. A log's run is its call's run_id, else its job,
// else its change, so every log counted in tokens and cost also counts toward runs.
// lazy: reads every gateway log; aggregate in SQL past ~10k logs.
export async function getFleet(request, env) {
  const [settings, roles, logs] = await env.DB.batch([
    env.DB.prepare("SELECT canary_auto_promote FROM fleet_settings"),
    env.DB.prepare("SELECT name, role FROM agent_roles"),
    env.DB.prepare("SELECT u.at, u.repo_id, u.change_id, u.agent_version, u.tokens, u.cost_usd, k.model, k.call, k.input_tokens, k.output_tokens, k.latency_ms, " +
      "COALESCE(k.run_id, j.job_id, u.change_id, u.id) AS run_id, r.name AS repo, c.state FROM usage_logs u " +
      "LEFT JOIN usage_calls k ON k.id = u.id LEFT JOIN job_gateway_logs j ON j.log_id = u.id LEFT JOIN repos r ON r.id = u.repo_id LEFT JOIN changes c ON c.id = u.change_id " +
      "WHERE instr(u.agent_version, '@') > 1 ORDER BY u.at"),
  ]);
  const now = Date.now(), budget = await budgetUse(env.DB);
  const paused = budget.paused ? { reason: "budget", resumes_at: budget.resets_at } : null;
  const roleOf = new Map(roles.results.map((r) => [r.name, r.role]));
  const names = new Set([...roleOf.keys(), ...logs.results.map((l) => l.agent_version.split("@")[0])]);
  const sum = (ls, k) => ls.reduce((n, l) => n + l[k], 0);
  const runs = (ls) => new Set(ls.map((l) => l.run_id)).size;
  return Response.json({ canary_auto_promote: settings.results[0]?.canary_auto_promote === 1, agents: [...names].map((name) => {
    const all = logs.results.filter((l) => l.agent_version.startsWith(`${name}@`)), day = all.filter((l) => now - Date.parse(l.at) < 864e5), last = all.at(-1);
    return { name, role: roleOf.get(name) ?? "", tokens: sum(all, "tokens"), repos: new Set(all.map((l) => l.repo_id)).size,
      merged: new Set(all.filter((l) => l.state === "merged").map((l) => l.change_id)).size, runs_24h: runs(day), tokens_24h: sum(day, "tokens"), cost_24h: sum(day, "cost_usd"),
      // lazy: running means AI Gateway logged a call in the last 10 minutes; read claimed jobs once they name their agent.
      running: all.some((l) => now - Date.parse(l.at) < 6e5), paused,
      run: last ? { id: last.run_id, agent_version: last.agent_version, change_id: last.change_id, repo: last.repo, state: last.state, calls: all.filter((l) => l.run_id === last.run_id && l.model)
        .map(({ model, call, input_tokens, output_tokens, cost_usd, latency_ms }) => ({ model, call, input_tokens, output_tokens, cost_usd, latency_ms })) } : null };
  }) });
}

// PUT /api/fleet {canary_auto_promote} → 204.
export async function putFleet(request, env) {
  const on = (await request.json().catch(() => null))?.canary_auto_promote;
  if (typeof on !== "boolean") return error(400, "bad_request", "body must be {canary_auto_promote: boolean}");
  await env.DB.prepare("INSERT INTO fleet_settings VALUES (1, ?1) ON CONFLICT (id) DO UPDATE SET canary_auto_promote = ?1").bind(on ? 1 : 0).run();
  await autoPromote(env);
  return new Response(null, { status: 204 });
}

// PUT /api/agents/:name/role {role} → 204.
export async function putAgentRole(request, env, { name }) {
  const role = (await request.json().catch(() => null))?.role;
  if (typeof role !== "string" || !role.trim()) return error(400, "bad_request", "body must be {role: non-empty string}");
  await env.DB.prepare("INSERT INTO agent_roles VALUES (?1, ?2) ON CONFLICT (name) DO UPDATE SET role = ?2").bind(name, role.trim()).run();
  return new Response(null, { status: 204 });
}

// With auto-promote on, points stable at each canary that has won 60% of at least 30 decided races, recording a promoted
// channel event for each (written first in the batch, so only where stable still differs).
const WINNERS = "SELECT c.agent_name FROM channels c JOIN race_legs l ON l.agent = c.agent_name || '@v' || c.version " +
  "WHERE c.channel = 'canary' AND (SELECT canary_auto_promote FROM fleet_settings) = 1 GROUP BY c.agent_name HAVING COUNT(l.won) >= 30 AND SUM(l.won) >= 0.6 * COUNT(l.won)";
export const autoPromote = (env) => env.DB.batch([
  env.DB.prepare("INSERT INTO agent_channel_events (id, agent_name, kind, version, share, by, at) SELECT lower(hex(randomblob(16))), c.agent_name, " +
    "'promoted', c.version, NULL, 'auto-promote', ?1 FROM channels c JOIN channels s ON s.agent_name = c.agent_name AND s.channel = 'stable' " +
    `AND s.version <> c.version WHERE c.channel = 'canary' AND c.agent_name IN (${WINNERS})`).bind(new Date().toISOString()),
  env.DB.prepare("UPDATE channels SET version = (SELECT c.version FROM channels c WHERE c.agent_name = channels.agent_name AND c.channel = 'canary') " +
    `WHERE channel = 'stable' AND agent_name IN (${WINNERS})`),
]);
