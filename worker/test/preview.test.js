import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import { validateChangePreview } from "../src/api/contract.js";
import agentVersions from "../src/api/fixtures/agent-versions.json";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });
  fake.repos.get(name).commits.push({ sha: "sha1" });
  const { id } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  await env.DB.prepare("INSERT INTO symbols VALUES (?, 'sha1', 'src/http.js', 'retryFetch', 'function', 1, 2)").bind(id).run();
  await env.DB.prepare("INSERT INTO symbol_indexes VALUES (?, 'sha1')").bind(id).run();
  const preview = async (body) => {
    const res = await call(`/api/repos/${name}/changes/preview`, body);
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(validateChangePreview(json)).toEqual({ ok: true, errors: [] });
    return json;
  };
  return { fake, call, preview, id };
}

describe("change preview", () => {
  it("rate limits a person's previews", async () => {
    await setup("prev-limit");
    serveCerts();
    onTestFinished(() => vi.restoreAllMocks());
    // Invalid bodies count too, so the limit is cheap to reach; windows are wall-clock minutes, so allow one boundary.
    const post = async (headers) => (await worker.fetch(new Request("http://cinder.test/api/repos/prev-limit/changes/preview", { method: "POST", headers, body: "{}" }), ACCESS)).status;
    const boss = await as("boss@example.com");
    let n = 0;
    while (await post(boss) === 400 && n < 60) n++;
    expect(n).toBeGreaterThanOrEqual(30);
    expect(await post(boss)).toBe(429);
    // The owner token is boss too (the first of OWNERS), so another person is a developer.
    await env.DB.prepare("INSERT INTO person_roles VALUES ('dev@example.com', 'developer') ON CONFLICT (email) DO UPDATE SET role = excluded.role").run();
    expect(await post(await as("dev@example.com"))).toBe(400);
  });

  it("a target that moved past its index still predicts from the last indexed commit and queues the new head's index", async () => {
    const { fake, preview, id } = await setup("prev-moved");
    // A merge moved main to sha2, which no index job has run on yet.
    fake.repos.get("prev-moved").commits.unshift({ sha: "sha2" });
    const out = await preview({ intent: "Retry fetch", target: "main" });
    expect(out.symbols).toEqual([{ symbol: "src/http.js#retryFetch", p: null }]);
    expect(await env.DB.prepare("SELECT 1 FROM jobs WHERE repo_id = ? AND kind = 'index' AND json_extract(payload, '$.sha') = 'sha2'").bind(id).first()).not.toBeNull();
  });

  it("preview creates no change and no fork", async () => {
    const { fake, preview, id } = await setup("prev-none");
    const out = await preview({ intent: "Retry fetch", target: "main", request_id: "req-7" });
    expect(out).toMatchObject({ request_id: "req-7", target: "main", symbols: [{ symbol: "src/http.js#retryFetch", p: null }] });
    expect(fake.calls.map((c) => c.method)).not.toContain("fork");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM changes WHERE repo_id = ?").bind(id).first("n")).toBe(0);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE repo_id = ? AND kind = 'develop'").bind(id).first("n")).toBe(0);
    expect(await env.REPO_DO.get(env.REPO_DO.idFromName("prev-none")).leases("main")).toEqual({});
  });

  it("an intent naming an active change's symbol reports the collision", async () => {
    const { call, preview } = await setup("prev-hit");
    const res = await call("/api/repos/prev-hit/changes", { intent: "Make retryFetch back off" });
    expect(res.status).toBe(201);
    const { id } = await res.json();
    const out = await preview({ intent: "Log every retryFetch attempt" });
    expect(out.collisions).toEqual([{ change: id, symbols: ["src/http.js#retryFetch"] }]);
  });

  it("@dev@v2 resolves to that agent version", async () => {
    for (const v of agentVersions) {
      await env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
        .bind(v.id, v.name, v.version, v.harness, v.model, v.effort, v.prompt_hash, JSON.stringify(v.tools), JSON.stringify(v.limits)).run();
    }
    const { preview } = await setup("prev-agent");
    const out = await preview({ intent: "Have @dev@v2 fix it after #c-123, not @nobody@v9" });
    expect(out.agents).toEqual([{ ref: "dev@v2", agent_version: "agent/dev/v2" }, { ref: "nobody@v9", agent_version: null }]);
    expect(out.changes).toEqual(["c-123"]);
  });
});
