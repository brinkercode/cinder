import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { MAX_TOOL_BYTES } from "../src/toolcache.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const fake = fakeArtifacts();
const call = (method, path, { token = env.OWNER_TOKEN, body, headers = {} } = {}) => worker.fetch(
  new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body }),
  { ...env, ARTIFACTS: fake },
);
const flow = (setup) => `name: build
on: [manual]
steps:
  test: { stage: build, run: "go test ./...", setup: ${setup}, needs: [] }
`;

const sha256Hex = async (text) => [...new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)))]
  .map((b) => b.toString(16).padStart(2, "0")).join("");
// A claimed flow job held by runner id with one step setting up setup.
const holdFlowJob = (id, setup) => env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload, runner_id) VALUES (?, 'r', 'flow', 'claimed', ?, ?, ?)")
  .bind(crypto.randomUUID(), new Date().toISOString(), JSON.stringify({ steps: [{ name: "test", stage: "build", run: "x", setup }] }), id).run();

describe("flow tool cache", () => {
  it("a flow with setup go 1.24.13 validates; cobol and an empty version are rejected with a 400 naming the step", async () => {
    await call("POST", "/api/repos", { body: JSON.stringify({ name: "toolcache-flow" }) });
    const repo = fake.repos.get("toolcache-flow");
    repo.commits = [{ sha: "s1" }];
    const start = async (setup) => {
      repo.files = { ".cinder/flows/build.yml": flow(setup) };
      return call("POST", "/api/repos/toolcache-flow/flows/build/runs");
    };
    expect((await start('{ go: "1.24.13" }')).status).toBe(201);
    for (const bad of ['{ cobol: "1" }', '{ go: "" }']) {
      const res = await start(bad);
      expect(res.status).toBe(400);
      expect((await res.json()).error.message).toContain("steps.test.setup");
    }
  });

  it("PUT then GET with a runner token round-trips; owner and no token are refused; an archive over the cap is rejected", async () => {
    const { id, token } = await (await call("POST", "/api/runners", { body: JSON.stringify({ name: "toolcache-lab", kinds: ["flow"] }) })).json();
    await holdFlowJob(id, { go: "1.24.13" });
    const path = "/api/work/toolcache/go/1.24.13";
    expect((await call("PUT", path, { token, body: "packed go", headers: { "Content-Length": "9" } })).status).toBe(204);
    const got = await call("GET", path, { token });
    expect([got.status, await got.text()]).toEqual([200, "packed go"]);
    expect(await (await env.TOOL_CACHE.get("toolcache/go/1.24.13/release.sha256")).text())
      .toBe(await sha256Hex("packed go"));
    expect((await call("PUT", path, { body: "x" })).status).toBe(403);
    expect((await call("GET", path)).status).toBe(403);
    expect((await call("PUT", path, { token: "", body: "x" })).status).toBe(401);
    expect((await call("GET", path, { token: "" })).status).toBe(401);
    const big = await call("PUT", "/api/work/toolcache/go/1.25.0", { token, body: "x", headers: { "Content-Length": String(MAX_TOOL_BYTES + 1) } });
    expect(big.status).toBe(413);
    expect((await call("GET", "/api/work/toolcache/go/1.25.0", { token })).status).toBe(404);
  });

  it("refuses a tool upload from a runner holding no flow job that sets it up", async () => {
    const { id, token } = await (await call("POST", "/api/runners", { body: JSON.stringify({ name: "toolcache-poison", kinds: ["flow"] }) })).json();
    const put = () => call("PUT", "/api/work/toolcache/node/22.20.0", { token, body: "poison", headers: { "Content-Length": "6" } });
    expect((await put()).status).toBe(403);
    await holdFlowJob(id, { go: "1.24.13", node: "20.0.0" });
    expect((await put()).status).toBe(403);
    expect(await env.TOOL_CACHE.get("toolcache/node/22.20.0/release")).toBeNull();
  });

  it("GET on a version not in the cache returns 404", async () => {
    const { token } = await (await call("POST", "/api/runners", { body: JSON.stringify({ name: "toolcache-miss", kinds: ["flow"] }) })).json();
    expect((await call("GET", "/api/work/toolcache/node/99.0.0", { token })).status).toBe(404);
  });
});
