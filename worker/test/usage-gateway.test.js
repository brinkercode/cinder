import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { pullUsage } from "../src/usage.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { ...init, headers: OWNER }), { ...env, ARTIFACTS: fakeArtifacts() });
const gw = { ...env, AI_GATEWAY_ID: "cinder", CF_ACCOUNT_ID: "acct", CF_DEPLOY_TOKEN: "t" };

// A fake AI Gateway Logs API serving `logs` newest first, 50 a page.
const fakeLogs = (logs) => vi.fn(async (url) => {
  const u = new URL(url);
  expect(u.pathname).toBe("/client/v4/accounts/acct/ai-gateway/gateways/cinder/logs");
  const page = Number(u.searchParams.get("page"));
  return Response.json({ success: true, result: logs.slice((page - 1) * 50, page * 50) });
});
const repoId = async (name) => {
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) });
  return (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
};

afterEach(() => vi.unstubAllGlobals());

it("POST /api/repos/:name/usage is gone: the runner self-report returns 404", async () => {
  await repoId("gw-no-self-report");
  const row = { id: "u1", at: "2026-10-06T00:00:00Z", tokens: 10, cost_usd: 0.1 };
  expect((await call("/api/repos/gw-no-self-report/usage", { method: "POST", body: JSON.stringify([row]) })).status).toBe(404);
});

it("POST /api/repos/:name/seed/usage is not a route", async () => {
  await repoId("gw-no-seed-usage");
  const row = { id: "u1", at: "2026-10-06T00:00:00Z", tokens: 10, cost_usd: 0.1 };
  expect((await call("/api/repos/gw-no-seed-usage/seed/usage", { method: "POST", body: JSON.stringify([row]) })).status).toBe(404);
  expect(await env.DB.prepare("SELECT count(*) AS n FROM usage_logs WHERE id = 'u1'").first("n")).toBe(0);
});

it("a fake logs client feeds the ingest: rows land with cf-aig-metadata attribution and logs without it count as outside cinder", async () => {
  const repo = await repoId("gw-usage");
  const meta = JSON.stringify({ repo, change: "c-1", agent_version: "developer@v3", person: "runner:r1", job: "j-1" });
  const logs = [
    { id: "log-1", created_at: "2026-10-06T10:00:00Z", tokens_in: 100, tokens_out: 20, cost: 0.5, metadata: meta },
    { id: "log-2", created_at: "2026-10-06T09:00:00Z", tokens_in: 7, tokens_out: 3, cost: 0.1, metadata: null },
    { id: "log-3", created_at: "2026-10-06T08:00:00Z", tokens_in: 1, tokens_out: 1, cost: null, metadata: "not json" },
  ];
  const fetcher = fakeLogs(logs);
  await pullUsage(gw, fetcher);
  // A second pull sees only known logs and adds nothing.
  await pullUsage(gw, fetcher);
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer t");
  const { results } = await env.DB.prepare("SELECT id, repo_id, change_id, agent_version, person, job_id, tokens, cost_usd FROM usage_logs " +
    "LEFT JOIN job_gateway_logs ON log_id = id WHERE id LIKE 'log-%' ORDER BY id").all();
  const outside = { repo_id: "", change_id: null, agent_version: null, person: null, job_id: null };
  expect(results).toEqual([
    { id: "log-1", repo_id: repo, change_id: "c-1", agent_version: "developer@v3", person: "runner:r1", job_id: "j-1", tokens: 120, cost_usd: 0.5 },
    { id: "log-2", ...outside, tokens: 10, cost_usd: 0.1 },
    { id: "log-3", ...outside, tokens: 2, cost_usd: 0 },
  ]);
});

it("live install: a gateway request with metadata appears on the Insights Usage lens within one pull interval", async () => {
  const repo = await repoId("gw-live");
  const at = new Date(Date.now() - 60_000).toISOString();
  const meta = { repo, change: "c-live", agent_version: "developer@v4", person: "runner:r2", job: "j-live" };
  vi.stubGlobal("fetch", fakeLogs([{ id: "live-1", created_at: at, tokens_in: 300, tokens_out: 50, cost: 1.25, metadata: JSON.stringify(meta) }]));
  let pull;
  // One cron tick (wrangler.jsonc: every 10 minutes).
  worker.scheduled({}, gw, { waitUntil: (p) => { pull = p; } });
  await pull;
  const body = await (await call(`/api/repos/gw-live/insights?from=${new Date(Date.now() - 3600_000).toISOString()}`)).json();
  expect(body.usage.tokens).toBe(350);
  expect(body.usage.by_agent).toEqual([{ name: "developer@v4", outside: false, tokens: 350, cost_usd: 1.25, merged: 0 }]);
});

it("pullUsage stores a call row per gateway log with model, tokens and latency", async () => {
  const repo = await repoId("gw-calls");
  const meta = JSON.stringify({ repo, change: "c-calls", agent_version: "gw-calls@v1", person: "runner:r3", job: "j-calls" });
  const at = (s) => new Date(Date.now() - s * 1000).toISOString();
  await pullUsage(gw, fakeLogs([
    { id: "calls-2", created_at: at(10), model: "@cf/openai/gpt-oss-120b", path: "workers-ai/@cf/openai/gpt-oss-120b", duration: 900, tokens_in: 40, tokens_out: 5, cost: 0.2, metadata: meta },
    { id: "calls-1", created_at: at(20), model: "@cf/openai/gpt-oss-120b", duration: 1500, tokens_in: 100, tokens_out: 20, cost: 0.5, metadata: meta },
  ]));
  const agent = (await (await call("/api/fleet")).json()).agents.find((a) => a.name === "gw-calls");
  expect(agent).toMatchObject({ runs_24h: 1, tokens_24h: 165 });
  expect(agent.run).toMatchObject({ id: "j-calls", change_id: "c-calls", repo: "gw-calls" });
  expect(agent.run.calls).toEqual([
    { model: "@cf/openai/gpt-oss-120b", call: "@cf/openai/gpt-oss-120b", input_tokens: 100, output_tokens: 20, cost_usd: 0.5, latency_ms: 1500 },
    { model: "@cf/openai/gpt-oss-120b", call: "workers-ai/@cf/openai/gpt-oss-120b", input_tokens: 40, output_tokens: 5, cost_usd: 0.2, latency_ms: 900 },
  ]);
  expect(agent.run.calls.reduce((n, c) => n + c.input_tokens + c.output_tokens, 0)).toBe(agent.tokens);
});
