import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const CI = "name: ci\non: [change, manual]\nsteps:\n  test: { stage: build, run: \"npm test\", needs: [] }\n";
const NIGHTLY = "name: nightly\non: [cron]\ncron: \"0 3 * * *\"\nsteps:\n  e2e: { stage: build, run: \"npm run e2e\", needs: [] }\n";

// A repo `name` whose head s1 holds files, and a GET against the Worker with the owner's token.
async function repoWith(name, files) {
  const fake = fakeArtifacts();
  const get = (path) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), { ...env, ARTIFACTS: fake });
  await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify({ name }) }), { ...env, ARTIFACTS: fake });
  Object.assign(fake.repos.get(name), { commits: [{ sha: "s1" }], files });
  const { id } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  return { get, id, fake };
}
// statuses[0] is the newest run of flow.
async function runs(repoId, flow, statuses) {
  await env.DB.batch(statuses.map((status, i) => env.DB.prepare(`INSERT INTO flow_runs (id, repo_id, flow, number, sha, trigger, status, created_at, payload)
    VALUES (?, ?, ?, ?, 's1', 'manual', ?, ?, '{}')`).bind(`${repoId}-${flow}-${i}`, repoId, flow, statuses.length - i, status, new Date(Date.UTC(2026, 9, 1) - i * 60_000).toISOString())));
}

describe("flow list", () => {
  it("flows lists every .cinder/flows file at the ref with health over its last 30 runs", async () => {
    const { get, id, fake } = await repoWith("fl-list", { ".cinder/flows/ci.yml": CI, ".cinder/flows/nightly.yml": NIGHTLY, ".cinder/flows/notes.txt": "x", "README.md": "hi" });
    await env.DB.prepare("INSERT INTO repo_trust (repo, min_outcomes) VALUES (?, 25)").bind(id).run();
    // 20 passed and 9 failed of the last 30 (one still running), then 5 older failures that fall outside the window.
    await runs(id, "ci", ["running", ...Array(20).fill("passed"), ...Array(9).fill("failed"), ...Array(5).fill("failed")]);
    const res = await get("/api/repos/fl-list/flows?ref=main");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([
      { flow: "ci", head: "s1", trigger: "change", on: ["change", "manual"], health: { passed: 20, failed: 9, n: 29, trusted: true }, last_run: { id: `${id}-ci-0`, status: "running", number: 35 },
        file: { yaml: CI, def: expect.objectContaining({ name: "ci" }), last_run_steps: {} } },
      { flow: "nightly", head: "s1", trigger: "cron", on: ["cron"], health: { passed: 0, failed: 0, n: 0, trusted: false } },
    ]);
    expect(fake.calls.filter((c) => c.method === "readFile").map((c) => c.args[2])).toEqual([".cinder/flows/ci.yml", ".cinder/flows/nightly.yml"]);
  });

  it("a flow with fewer runs than the trust threshold reports trusted false", async () => {
    const { get, id } = await repoWith("fl-untrusted", { ".cinder/flows/ci.yml": CI });
    await env.DB.prepare("INSERT INTO repo_trust (repo, min_outcomes) VALUES (?, 5)").bind(id).run();
    await runs(id, "ci", ["passed", "passed", "failed", "passed"]);
    const [ci] = await (await get("/api/repos/fl-untrusted/flows")).json();
    expect(ci.health).toEqual({ passed: 3, failed: 1, n: 4, trusted: false });
  });

  it("an unparseable flow file returns def null with its parse error", async () => {
    const bad = "name: broken\nthis is not yaml\n";
    const { get, id } = await repoWith("fl-bad", { ".cinder/flows/broken.yml": bad, ".cinder/flows/ci.yml": CI });
    await runs(id, "ci", ["passed"]);
    await env.DB.prepare("INSERT INTO flow_step_runs (run_id, job_key, idx, name, status, started_at, finished_at) VALUES (?, 'build/test', 0, 'test', 'passed', '2026-10-01T00:00:00Z', '2026-10-01T00:00:02.5Z')")
      .bind(`${id}-ci-0`).run();
    const res = await get("/api/repos/fl-bad/flows/broken?ref=main");
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ yaml: bad, def: null, head: "s1", last_run_steps: {}, error: '.cinder/flows/broken.yml:2: expected "key: value", got "this is not yaml"' });
    const ci = await (await get("/api/repos/fl-bad/flows/ci")).json();
    expect([ci.def.name, ci.last_run_steps]).toEqual(["ci", { test: { status: "passed", ms: 2500 } }]);
    expect((await (await get("/api/repos/fl-bad/flows")).json()).map((f) => [f.flow, f.trigger, f.on])).toEqual([["broken", "manual", []], ["ci", "change", ["change", "manual"]]]);
    expect((await get("/api/repos/fl-bad/flows/missing")).status).toBe(404);
  });
});
