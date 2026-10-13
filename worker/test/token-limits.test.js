import { env, exports } from "cloudflare:workers";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { validateAgent, validateTokenLimits } from "../src/api/contract.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const put = (path, body) => exports.default.fetch(`http://cinder.test${path}`, {
  method: "PUT", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}`, "Content-Type": "application/json" }, body: JSON.stringify(body) });

beforeAll(() => { env.ARTIFACTS = fakeArtifacts(); });
afterAll(() => { delete env.ARTIFACTS; });

describe("agent version token limits", () => {
  it("limits save on the agent version", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES ('agent/capped/v1', 'capped', 1, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{\"max_cost_usd\":8,\"max_minutes\":120}')").run();
    const res = await put("/api/agents/capped/versions/1/limits", { max_tokens: 150000, max_tokens_month: 2000000 });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(validateTokenLimits(body)).toEqual({ ok: true, errors: [] });
    expect(body).toEqual({ max_tokens: 150000, max_tokens_month: 2000000 });
    const agent = await (await exports.default.fetch("http://cinder.test/api/agents/capped", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } })).json();
    expect(validateAgent(agent)).toEqual({ ok: true, errors: [] });
    expect(agent.versions[0].limits).toEqual({ max_cost_usd: 8, max_minutes: 120, max_tokens: 150000, max_tokens_month: 2000000 });

    expect((await put("/api/agents/capped/versions/1/limits", { max_tokens: null, max_tokens_month: 2000000 })).status).toBe(200);
    expect(JSON.parse(await env.DB.prepare("SELECT limits FROM agent_versions WHERE id = 'agent/capped/v1'").first("limits")).max_tokens).toBeNull();
    expect((await put("/api/agents/capped/versions/1/limits", { max_tokens: 0, max_tokens_month: 2000000 })).status).toBe(400);
    expect((await put("/api/agents/capped/versions/1/limits", { max_tokens: 1 })).status).toBe(400);
    expect((await put("/api/agents/capped/versions/9/limits", { max_tokens: 1, max_tokens_month: 1 })).status).toBe(404);
  });
});
