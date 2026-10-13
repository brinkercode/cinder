import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { validateClaim } from "../src/api/contract.js";
import { DEFAULT_EGRESS } from "../src/agents.js";
import worker from "../src/index.js";
import { autoscale } from "../src/workers.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A fake Containers binding records each started worker's token and each stop.
const started = [];
const stopped = [];
const containers = { idFromName: (name) => name, get: (id) => ({ start: async (o) => { started.push({ id, ...o }); }, stop: async () => { stopped.push(id); } }) };
const e = { ...env, ARTIFACTS: fakeArtifacts(), WORKER_LITE: containers, WORKER_BASIC: containers, WORKER_STANDARD: containers, WORKER_STANDARD4: containers };
const call = async (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(new Request(`http://cinder.test${path}`,
  { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), e);
const claim = (token) => call("/api/work/claim", { kinds: ["flow"] }, token);
const statusOf = async (job) => (await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(job).first("status"));
const members = async (pool) => env.DB.prepare("SELECT count(*) AS n FROM pool_members WHERE pool_id = ?").bind(pool).first("n");

// Fails every earlier job, so only the ones a test queues are claimable.
const fresh = () => env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
// A queued flow job on `repo` (created on first use) with `payload`.
async function queue(repo, payload = {}) {
  await call("/api/repos", { name: repo });
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) SELECT ?, id, 'flow', NULL, 'queued', ?, ? FROM repos WHERE name = ?")
    .bind(id, new Date().toISOString(), JSON.stringify(payload), repo).run();
  return id;
}
// A managed flow pool with `settings`, running `min` workers; returns the pool and its last worker's token.
async function managed(name, settings, min = 1) {
  const pool = await (await call("/api/workers/pools", { name, size: "lite", min, max: 2, kinds: ["flow"] })).json();
  expect((await call(`/api/workers/pools/${pool.id}`, settings, env.OWNER_TOKEN, "PUT")).status).toBe(200);
  return { pool, token: min ? started.at(-1).envVars.CINDER_RUNNER_TOKEN : null };
}
// A BYO pool with `settings` and a token per runner name.
async function byo(name, settings, runners) {
  expect((await call("/api/workers/byo-pools", { name, kinds: ["flow"], ...settings })).status).toBe(201);
  return Promise.all(runners.map(async (r) => (await (await call("/api/workers", { name: r, kinds: ["flow"], pool: name })).json()).token));
}

describe("claims honour pool labels, repo scope and egress", () => {
  it("a job with runs-on [gpu] is claimed only by a worker of a pool labelled gpu", async () => {
    await fresh();
    const job = await queue("cp-gpu", { runs_on: ["gpu"] });
    const { token: linux } = await managed("cp-linux", { labels: ["linux"] });
    const [arm] = await byo("cp-arm", { labels: ["arm64"] }, ["cp-arm-1"]);
    expect((await claim(linux)).status).toBe(204);
    expect((await claim(arm)).status).toBe(204);
    expect(await statusOf(job)).toBe("queued");
    const [gpu] = await byo("cp-gpu-pool", { labels: ["gpu", "linux"] }, ["cp-gpu-1"]);
    expect((await (await claim(gpu)).json()).job.id).toBe(job);
  });

  it("a job in a repo outside the pool's repo scope is never claimed by that pool", async () => {
    await fresh();
    await call("/api/repos", { name: "cp-in" });
    const out = await queue("cp-out");
    const { token } = await managed("cp-scoped", { repos: ["cp-in"] });
    expect((await claim(token)).status).toBe(204);
    expect(await statusOf(out)).toBe("queued");
    const mine = await queue("cp-in");
    expect((await (await claim(token)).json()).job.id).toBe(mine);
  });

  it("a BYO pool at max_concurrent claims nothing more", async () => {
    await fresh();
    const [one, two] = await byo("cp-capped", { labels: ["linux"], max_concurrent: 1 }, ["cp-capped-1", "cp-capped-2"]);
    await queue("cp-cap");
    const second = await queue("cp-cap");
    expect((await claim(one)).status).toBe(200);
    expect((await claim(two)).status).toBe(204);
    expect(await statusOf(second)).toBe("queued");
  });

  it("a job with no runs-on is claimed by any pool", async () => {
    await fresh();
    const empty = await queue("cp-any", { runs_on: [] });
    const none = await queue("cp-any");
    const { token } = await managed("cp-any-managed", { labels: ["linux"] });
    const [own] = await byo("cp-any-byo", { labels: ["arm64"] }, ["cp-any-1"]);
    expect((await (await claim(token)).json()).job.id).toBe(empty);
    expect((await (await claim(own)).json()).job.id).toBe(none);
  });

  it("a lite pool never claims or scales up for an agent harness job", async () => {
    await fresh();
    const pool = await (await call("/api/workers/pools", { name: "cp-lite-agent", size: "lite", min: 1, max: 2, kinds: ["develop", "review", "flow"] })).json();
    const token = started.at(-1).envVars.CINDER_RUNNER_TOKEN;
    await call("/api/repos", { name: "cp-lite-agent" });
    const review = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) SELECT ?, id, 'review', NULL, 'queued', ?, '{}' FROM repos WHERE name = ?")
      .bind(review, new Date().toISOString(), "cp-lite-agent").run();
    expect((await call("/api/work/claim", { kinds: ["develop", "review"] }, token)).status).toBe(204);
    expect(await statusOf(review)).toBe("queued");
    await autoscale(e);
    expect(await members(pool.id)).toBe(1);
  });

  it("autoscale starts no worker for a job the pool's labels can't take", async () => {
    await fresh();
    const { pool } = await managed("cp-scale", { labels: ["linux"] }, 0);
    await queue("cp-scale", { runs_on: ["gpu"] });
    await autoscale(e);
    expect(await members(pool.id)).toBe(0);
    await queue("cp-scale", { runs_on: ["linux"] });
    await autoscale(e);
    expect(await members(pool.id)).toBe(1);
  });

  it("an idle pool worker stays until keep_warm_s after its last job", async () => {
    await fresh();
    const { pool } = await managed("cp-warm", { keep_warm_s: 60 }, 0);
    expect((await call(`/api/workers/pools/${pool.id}/scale`, { count: 1 })).status).toBe(200);
    const { id, envVars } = started.at(-1);
    const job = await queue("cp-warm");
    expect((await claim(envVars.CINDER_RUNNER_TOKEN)).status).toBe(200);
    // The job is gone (failed elsewhere), and the worker started long ago: its last job, just now, keeps it warm.
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").bind(job).run();
    const ago = (s) => new Date(Date.now() - s * 1000).toISOString();
    await env.DB.prepare("UPDATE runner_tokens SET created_at = ? WHERE runner_id = ?").bind(ago(600), id).run();
    expect((await claim(envVars.CINDER_RUNNER_TOKEN)).status).toBe(204);
    expect(await members(pool.id)).toBe(1);
    expect(stopped).not.toContain(id);
    await env.DB.prepare("UPDATE pool_runs SET started_at = ? WHERE job_id = ?").bind(ago(61), job).run();
    expect((await claim(envVars.CINDER_RUNNER_TOKEN)).status).toBe(204);
    expect(await members(pool.id)).toBe(0);
    expect(stopped).toContain(id);
  });

  it("the claim carries the pool's egress mode and allow list", async () => {
    await fresh();
    await queue("cp-egress");
    await queue("cp-egress");
    const [locked] = await byo("cp-egress-byo", { labels: ["linux"], egress: "none", egress_allow: ["proxy.golang.org"] }, ["cp-egress-1"]);
    const body = await (await claim(locked)).json();
    expect(validateClaim(body).errors).toEqual([]);
    expect(body.egress).toEqual({ mode: "none", allow: ["proxy.golang.org"] });
    // A runner outside any pool gets the default allow list.
    const { token } = await (await call("/api/runners", { name: "cp-plain", kinds: ["flow"] })).json();
    expect((await (await claim(token)).json()).egress).toEqual({ mode: "allowlist", allow: DEFAULT_EGRESS });
  });
});
