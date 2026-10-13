import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { queueScan } from "../src/scans.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A repo with auto-fix on for lodash, whose OSV advisory is fixed in 4.17.21, and a runner for scans and verifies.
async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN, method = body === undefined ? "GET" : "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  fake.repos.get(name).commits.unshift({ sha: "s1" });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");
  expect((await call(`/api/repos/${name}/dependencies`, { ecosystem: "npm", name: "lodash", auto_fix: true }, env.OWNER_TOKEN, "PATCH")).status).toBe(204);
  const vuln = { id: "GHSA-lodash", affected: [{ package: { name: "lodash" }, ranges: [{ type: "SEMVER", events: [{ introduced: "0" }, { fixed: "4.17.21" }] }] }] };
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => (String(url).endsWith("/querybatch")
    ? Response.json({ results: JSON.parse(init.body).queries.map((q) => ({ vulns: q.package.name === "lodash" ? [{ id: "GHSA-lodash" }] : [] })) })
    : Response.json(vuln)));
  onTestFinished(() => fetch.mockRestore());
  const token = (await (await call("/api/runners", { name: `${name}-lab`, kinds: ["scan", "verify"] })).json()).token;
  const scan = async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE repo_id = ? AND status = 'queued'").bind(repo).run();
    await queueScan(env, repo, "main", "daily");
    const { job } = await (await call("/api/work/claim", { kinds: ["scan"] }, token)).json();
    expect((await call(`/api/work/jobs/${job.id}/report`, { status: "done", deps: [{ ecosystem: "npm", name: "lodash", version: "4.17.20", license: "MIT", class: "permissive" }] }, token)).status).toBe(200);
  };
  const fixes = async () => (await env.DB.prepare("SELECT x.change_id, a.change_id IS NOT NULL AS auto_fix FROM finding_fixes x LEFT JOIN auto_fix_changes a ON a.change_id = x.change_id " +
    "JOIN findings f ON f.id = x.finding_id WHERE f.repo_id = ?").bind(repo).all()).results;
  return { call, repo, token, scan, fixes };
}

describe("auto-fix", () => {
  it("a scan finding on an auto-fix package with a fixed version opens a fix change", async () => {
    const { call, scan, fixes } = await setup("autofix-open");
    await scan();
    const [fix] = await fixes();
    expect(fix.auto_fix).toBe(1);
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(fix.change_id)).get()).intent).toMatch(/^bump lodash 4\.17\.20 → 4\.17\.21 \(fixes GHSA-lodash/);
    expect((await (await call("/api/repos/autofix-open/watchtower")).json()).fix_changes_open).toBe(1);
  });

  it("a second scan of the same finding opens no second change", async () => {
    const { repo, scan, fixes } = await setup("autofix-twice");
    await scan();
    await scan();
    expect(await fixes()).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM changes WHERE repo_id = ?").bind(repo).first("n")).toBe(1);
  });

  it("a verified auto-fix change waits for review and does not auto-queue", async () => {
    const { call, repo, token, scan, fixes } = await setup("autofix-review");
    await scan();
    const [{ change_id: id }] = await fixes();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await env.DB.batch([env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES ('agent/reviewer/v1', 'reviewer', 1, 'claude-code', 'm', 'default', 'h', '[]', '{}')"),
      env.DB.prepare("INSERT OR IGNORE INTO channels (agent_name, channel, version) VALUES ('reviewer', 'stable', 1)")]);
    for (const s of ["leased", "developing", "verifying"]) {
      if ((await stub.get()).state !== s) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: id, result: "ok" });
    }
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE repo_id = ? AND status IN ('queued', 'claimed')").bind(repo).run();
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')")
      .bind(job, repo, id, new Date().toISOString()).run();
    expect((await (await call("/api/work/claim", { kinds: ["verify"] }, token)).json()).job.id).toBe(job);
    const { change } = await (await call(`/api/work/jobs/${job}/report`, { status: "done" }, token)).json();
    expect(change.state).toBe("verifying");
    expect(change.review.route).toBe("agent");
    expect(await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE change_id = ? AND kind = 'review' AND status = 'queued'").bind(id).first("n")).toBe(1);
  });
});
