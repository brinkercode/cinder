import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { validateCatalogModel, validateFleet } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const cf = { ...env, ARTIFACTS: fakeArtifacts(), CF_ACCOUNT_ID: "acct", CF_DEPLOY_TOKEN: "t" };
const catalog = (path) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER }), cf);

afterEach(() => vi.unstubAllGlobals());

it("a fake Cloudflare catalog response flows through GET /api/models/catalog, cached in D1 and filtered by harness", async () => {
  const fetcher = vi.fn(async (url) => {
    expect(new URL(url).pathname).toBe("/client/v4/accounts/acct/ai/models/search");
    return Response.json({ success: true, result: [
      { name: "@cf/moonshotai/kimi-k2", properties: [{ property_id: "context_window", value: "256000" },
        { property_id: "price", value: [{ unit: "per M input tokens", price: 0.6 }, { unit: "per M output tokens", price: 2.5 }] }] },
      { name: "anthropic/claude-sonnet-5", properties: [{ property_id: "context_window", value: "1000000" }] },
    ] });
  });
  vi.stubGlobal("fetch", fetcher);

  const all = await (await catalog("/api/models/catalog")).json();
  expect(all).toEqual([
    { id: "@cf/moonshotai/kimi-k2", provider: "cf", context: "256k", price: "$0.6 / $2.5", hosted: true, harnesses: ["opencode"] },
    { id: "anthropic/claude-sonnet-5", provider: "anthropic", context: "1M", price: "—", hosted: false, harnesses: ["claude-code", "opencode"] },
  ]);
  all.forEach((m) => expect(validateCatalogModel(m).ok).toBe(true));
  expect(fetcher.mock.calls[0][1].headers.Authorization).toBe("Bearer t");

  // The second read comes from the D1 cache, filtered to the harness asked for.
  const claude = await (await catalog("/api/models/catalog?harness=claude-code")).json();
  expect(claude.map((m) => m.id)).toEqual(["anthropic/claude-sonnet-5"]);
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("GET /api/models/catalog returns the stubbed Cloudflare catalog with @cf/... and <provider>/<model> ids; PUT can no longer write dummy rows", async () => {
  await env.DB.prepare("DELETE FROM model_catalog").run();
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ success: true, result: [{ name: "@cf/zai-org/glm-4.6" }, { name: "openai/gpt-5-codex" }] })));
  const put = await worker.fetch(new Request("http://cinder.test/api/models/catalog", { method: "PUT", headers: OWNER,
    body: JSON.stringify([{ id: "GLM 4.6", provider: "cf", context: "128k", price: "$1 / $2" }]) }), cf);
  expect(put.status).not.toBe(204);
  expect((await (await catalog("/api/models/catalog")).json()).map((m) => [m.id, m.provider])).toEqual([["@cf/zai-org/glm-4.6", "cf"], ["openai/gpt-5-codex", "openai"]]);
});

it("getCatalog maps a third-party catalog entry to provider anthropic with harness claude-code", async () => {
  await env.DB.prepare("DELETE FROM model_catalog").run();
  const fetcher = vi.fn(async () => Response.json({ success: true, result: [
    { name: "@cf/moonshotai/kimi-k2.6", task: { name: "Text Generation" } },
    { name: "@cf/baai/bge-m3", task: { name: "Text Embeddings" } },
    { model_id: "anthropic/claude-opus-5", provider_id: "anthropic", name: "Claude Opus 5", task: "Text Generation", context_length: 1000000,
      pricing: { "Input tokens (per 1M)": 5, "Output tokens (per 1M)": 25, "Cached input tokens (per 1M)": 0.5 } },
  ] }));
  vi.stubGlobal("fetch", fetcher);
  const claude = await (await catalog("/api/models/catalog?harness=claude-code")).json();
  expect(claude).toEqual([{ id: "anthropic/claude-opus-5", provider: "anthropic", context: "1M", price: "$5 / $25", hosted: false, harnesses: ["claude-code", "opencode"] }]);
  expect(new URL(fetcher.mock.calls[0][0]).searchParams.has("task")).toBe(false);
  expect((await (await catalog("/api/models/catalog")).json()).map((m) => m.id)).toEqual(["@cf/moonshotai/kimi-k2.6", "anthropic/claude-opus-5"]);
});

it("/api/fleet returns runs_24h >= 1 for an agent with gateway calls in the last 24h, alongside its tokens and cost", async () => {
  // A gateway log with no per-call detail: tokens and cost come from it, so it must count as a run too.
  await env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, change_id, agent_version, person, tokens, cost_usd) VALUES (?, 'r', ?, 'ch-runs', 'runs-agent@v1', 'p', 1260000, 3.2)")
    .bind(crypto.randomUUID(), new Date().toISOString()).run();
  const res = await catalog("/api/fleet");
  const body = await res.json();
  expect(validateFleet(body).ok).toBe(true);
  const a = body.agents.find((x) => x.name === "runs-agent");
  expect(a).toMatchObject({ runs_24h: 1, tokens_24h: 1260000, cost_24h: 3.2 });
  expect(a.run).toMatchObject({ id: "ch-runs", agent_version: "runs-agent@v1", change_id: "ch-runs", calls: [] });
});
