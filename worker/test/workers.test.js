import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { JOB_KINDS, validateByoPool, validatePool } from "../src/api/contract.js";
import worker from "../src/index.js";
import { autoscale, BINDINGS, pruneGone, WorkerLite } from "../src/workers.js";
import raw from "../wrangler.jsonc?raw";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A fake Containers binding records each container's start options and stops.
const started = [];
const stopped = [];
const containers = { idFromName: (name) => name, get: (id) => ({ start: async (o) => { started.push({ id, ...o }); }, stop: async () => { stopped.push(id); } }) };
const e = { ...env, ARTIFACTS: fakeArtifacts(), WORKER_LITE: containers, WORKER_BASIC: containers, WORKER_STANDARD: containers };
const call = async (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(new Request(`http://cinder.test${path}`,
  { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), e);
const claim = (token) => call("/api/work/claim", { kinds: ["index"] }, token);

// A queued index job (no change) on `repo`, created on first use. Earlier tests' jobs are failed first so only these are claimable.
async function queueJob(repo, kind = "index") {
  const res = await call("/api/repos", { name: repo });
  const { id: repoId } = await (res.status === 201 ? res : await call(`/api/repos/${repo}`, null, env.OWNER_TOKEN, "GET")).json();
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, ?, NULL, 'queued', ?, '{}')")
    .bind(id, repoId, kind, new Date().toISOString()).run();
  return id;
}
// Strips the jsonc line comments; no string value in wrangler.jsonc contains " //".
const config = JSON.parse(raw.replace(/(^|\s)\/\/.*$/gm, ""));
const statusOf = async (job) => (await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(job).first()).status;

describe("workers", () => {
  it("creating a managed pool starts a container worker that claims a job", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const job = await queueJob("wp-start");
    const res = await call("/api/workers/pools", { name: "pool-start", size: "lite", min: 1, max: 2, kinds: ["index"] });
    expect(res.status).toBe(201);
    const pool = await res.json();
    expect(validatePool(pool)).toEqual({ ok: true, errors: [] });
    expect(started).toHaveLength(1);
    expect(started[0].envVars.CINDER_URL).toBe("http://cinder.internal");
    expect((await (await claim(started[0].envVars.CINDER_RUNNER_TOKEN)).json()).job.id).toBe(job);
    const workers = await (await call("/api/workers", null, env.OWNER_TOKEN, "GET")).json();
    expect(workers.find((w) => w.id === started[0].id)).toMatchObject({ pool: pool.id, online: true, claims: [{ job }] });

    // Scaling down stops the newest container and its token stops working.
    expect((await call(`/api/workers/pools/${pool.id}/scale`, { count: 2 })).status).toBe(200);
    expect((await call(`/api/workers/pools/${pool.id}/scale`, { count: 1 })).status).toBe(200);
    expect(stopped).toEqual([started[1].id]);
    expect((await claim(started[1].envVars.CINDER_RUNNER_TOKEN)).status).toBe(401);
  });

  it("a pool instance's first heartbeat registers it online in its pool", async () => {
    const pool = await (await call("/api/workers/pools", { name: "pool-beat", size: "lite", min: 1, max: 1, kinds: ["index"] })).json();
    expect(pool).toMatchObject({ workers: 1, online: 0 });
    const { id, envVars } = started.at(-1);
    // The container's egress: CINDER_URL is cinder.internal, which the outbound proxy hands to the router, past Access.
    const beat = await WorkerLite.outboundByHost["cinder.internal"](new Request(`${envVars.CINDER_URL}/api/work/claim`,
      { method: "POST", headers: { Authorization: `Bearer ${envVars.CINDER_RUNNER_TOKEN}` }, body: JSON.stringify({ kinds: ["index"], slots_free: 0 }) }), e);
    expect(beat.status).toBe(204);
    const workers = await (await call("/api/workers", null, env.OWNER_TOKEN, "GET")).json();
    expect(workers.find((w) => w.id === id)).toMatchObject({ pool: pool.id, online: true });
    expect((await (await call("/api/workers/pools", null, env.OWNER_TOKEN, "GET")).json()).find((p) => p.id === pool.id)).toMatchObject({ workers: 1, online: 1 });
  });

  it("the build pool returns to min when idle", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const pool = await (await call("/api/workers/pools", { name: "pool-idle", size: "lite", min: 1, max: 3, kinds: ["index"] })).json();
    await call(`/api/workers/pools/${pool.id}`, { keep_warm_s: 0 }, env.OWNER_TOKEN, "PUT");
    expect((await call(`/api/workers/pools/${pool.id}/scale`, { count: 3 })).status).toBe(200);
    const [busy, idle, last] = started.slice(-3);
    await queueJob("wp-idle");
    expect((await claim(busy.envVars.CINDER_RUNNER_TOKEN)).status).toBe(200);
    // A worker holding a job never stops; idle ones stop until the pool is back at min.
    expect((await claim(busy.envVars.CINDER_RUNNER_TOKEN)).status).toBe(204);
    expect((await claim(idle.envVars.CINDER_RUNNER_TOKEN)).status).toBe(204);
    expect((await claim(last.envVars.CINDER_RUNNER_TOKEN)).status).toBe(204);
    expect(stopped.slice(-2)).toEqual([idle.id, last.id]);
    expect((await claim(idle.envVars.CINDER_RUNNER_TOKEN)).status).toBe(401);
    expect((await (await call("/api/workers/pools", null, env.OWNER_TOKEN, "GET")).json()).find((p) => p.id === pool.id)).toMatchObject({ workers: 1 });
  });

  it("a pool assigned to repo A never claims repo B's jobs", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const other = await queueJob("wp-b");
    const mine = await queueJob("wp-a");
    const pool = await (await call("/api/workers/pools", { name: "pool-a", size: "lite", min: 1, max: 1, kinds: ["develop"] })).json();
    expect(await (await call(`/api/workers/pools/${pool.id}/assign`, { repo: "wp-a", kinds: ["index"] }, env.OWNER_TOKEN, "PUT")).json()).toMatchObject({ repo: "wp-a" });
    const token = started.at(-1).envVars.CINDER_RUNNER_TOKEN;
    expect((await (await claim(token)).json()).job.id).toBe(mine);
    expect((await claim(token)).status).toBe(204);
    expect(await statusOf(other)).toBe("queued");

    // A drained pool claims nothing new.
    const later = await queueJob("wp-a");
    expect((await call(`/api/workers/pools/${pool.id}/drain`, {})).status).toBe(200);
    expect((await claim(token)).status).toBe(204);
    expect(await statusOf(later)).toBe("queued");
  });
  it("a job for a repo whose stack needs go is claimed only by a standard-pool runner; a plain review job can be claimed by a basic (slim) runner", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const verify = await queueJob("wp-go", "verify");
    const review = await queueJob("wp-go", "review");
    await env.DB.prepare("UPDATE repo_meta SET language = 'Go' WHERE repo_id = (SELECT id FROM repos WHERE name = 'wp-go')").run();
    const pool = (name, size) => call("/api/workers/pools", { name, size, min: 1, max: 1, kinds: ["verify", "review"], repo: "wp-go" });
    expect((await pool("pool-go-slim", "basic")).status).toBe(201);
    const lite = started.at(-1).envVars.CINDER_RUNNER_TOKEN;
    const claimKind = (token, kind) => call("/api/work/claim", { kinds: [kind] }, token);
    expect((await claimKind(lite, "verify")).status).toBe(204);
    expect((await (await claimKind(lite, "review")).json()).job.id).toBe(review);
    expect((await pool("pool-go-standard", "standard-2")).status).toBe(201);
    expect((await (await claimKind(started.at(-1).envVars.CINDER_RUNNER_TOKEN, "verify")).json()).job.id).toBe(verify);
  });

  // A basic (slim) and a standard-2 pool assigned to `repo` (language set), each with one worker; returns their tokens.
  async function routedPools(repo, language, kinds) {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await env.DB.prepare("UPDATE repo_meta SET language = ? WHERE repo_id = (SELECT id FROM repos WHERE name = ?)").bind(language, repo).run();
    const tokens = [];
    for (const size of ["basic", "standard-2"]) {
      expect((await call("/api/workers/pools", { name: `pool-${repo}-${size}`, size, min: 1, max: 1, kinds, repo })).status).toBe(201);
      tokens.push(started.at(-1).envVars.CINDER_RUNNER_TOKEN);
    }
    return tokens;
  }
  const claimKind = (token, kind) => call("/api/work/claim", { kinds: [kind] }, token);

  it("a queued develop job for a Java repo is claimed by a standard-pool runner and not by a lite one", async () => {
    await queueJob("wp-java");
    const [lite, standard] = await routedPools("wp-java", "Java", ["develop"]);
    const job = await queueJob("wp-java", "develop");
    expect((await claimKind(lite, "develop")).status).toBe(204);
    expect((await (await claimKind(standard, "develop")).json()).job.id).toBe(job);
  });

  it("a Ruby or PHP repo routes to the full pool; a plain review job still goes to the slim pool", async () => {
    for (const [repo, language] of [["wp-ruby", "Ruby"], ["wp-php", "PHP"]]) {
      await queueJob(repo);
      const [lite, standard] = await routedPools(repo, language, ["verify", "review"]);
      const verify = await queueJob(repo, "verify");
      const review = await queueJob(repo, "review");
      expect((await claimKind(lite, "verify")).status).toBe(204);
      expect((await (await claimKind(lite, "review")).json()).job.id).toBe(review);
      expect((await (await claimKind(standard, "verify")).json()).job.id).toBe(verify);
    }
  });

  it("WorkerStandard's instance type is the one the pool map in workers.js names", () => {
    const standard = config.containers.find((c) => c.class_name === "WorkerStandard");
    expect(BINDINGS[standard.instance_type]).toBe("WORKER_STANDARD");
    expect(standard.image).toBe("../runner/Dockerfile.full");
  });

  it("a managed pool's kinds include index, blame and compare, and its worker claims each with a read token for the repo", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const pool = await (await call("/api/workers/pools", { name: "pool-results", size: "lite", min: 1, max: 1 })).json();
    expect(pool.kinds).toEqual(expect.arrayContaining(["index", "blame", "compare"]));
    const token = started.at(-1).envVars.CINDER_RUNNER_TOKEN;
    for (const kind of ["index", "blame", "compare"]) {
      const job = await queueJob("wp-results", kind);
      const c = await (await call("/api/work/claim", { kinds: [kind], slots_free: 3 }, token)).json();
      expect(c).toMatchObject({ job: { id: job }, payload: { repo: "wp-results" }, target_remote: "https://artifacts.fake/cinder/wp-results.git" });
      expect(c.read_token).toMatch(/^fake-token-/);
      await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").bind(job).run(); // frees the worker's one slot
    }
  });

  it("The managed pool can't be deleted, only resized", async () => {
    const pool = await (await call("/api/workers/pools", { name: "pool-size", size: "lite", min: 0, max: 1, kinds: ["develop"] })).json();
    const at = `/api/workers/pools/${pool.id}`;
    expect((await call(at, null, env.OWNER_TOKEN, "DELETE")).status).toBe(404);
    expect((await call(`${at}/size`, { size: "huge" }, env.OWNER_TOKEN, "PUT")).status).toBe(400);
    expect(await (await call(`${at}/size`, { size: "basic" }, env.OWNER_TOKEN, "PUT")).json()).toMatchObject({ size: "basic" });
    expect((await call("/api/workers/pools/nope/size", { size: "lite" }, env.OWNER_TOKEN, "PUT")).status).toBe(404);
  });

  // One fake binding per size, so a stop sent through the wrong Container class shows.
  const bySize = () => {
    const calls = { lite: [], basic: [] };
    const fake = (size) => ({ idFromName: (n) => n, get: (id) => ({ start: async () => calls[size].push(["start", id]), stop: async () => calls[size].push(["stop", id]) }) });
    return { calls, env: { ...e, WORKER_LITE: fake("lite"), WORKER_BASIC: fake("basic") } };
  };
  const callIn = (en, path, body, method = "POST") => worker.fetch(new Request(`http://cinder.test${path}`,
    { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), en);

  it("changing a pool's size drains members on the old size and starts them on the new one", async () => {
    const { calls, env: en } = bySize();
    const pool = await (await callIn(en, "/api/workers/pools", { name: "pool-resize", size: "lite", min: 1, max: 1, kinds: ["index"] })).json();
    const [[, old]] = calls.lite;
    const res = await callIn(en, `/api/workers/pools/${pool.id}/size`, { size: "basic" }, "PUT");
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ size: "basic" });
    expect(calls.lite).toContainEqual(["stop", old]);
    await autoscale(en);
    expect(calls.basic.filter(([k]) => k === "start")).toHaveLength(1);
  });

  it("a member started on the old size is still found and stopped after a size change", async () => {
    const { calls, env: en } = bySize();
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const pool = await (await callIn(en, "/api/workers/pools", { name: "pool-busy", size: "lite", min: 1, max: 1, kinds: ["index"] })).json();
    const [[, member]] = calls.lite;
    // The member holds a job, so the resize leaves it running on lite.
    const job = await queueJob("wp-busy");
    await env.DB.prepare("UPDATE jobs SET status = 'claimed', runner_id = ?, lease_expires_at = ? WHERE id = ?")
      .bind(member, new Date(Date.now() + 600000).toISOString(), job).run();
    expect((await callIn(en, `/api/workers/pools/${pool.id}/size`, { size: "basic" }, "PUT")).status).toBe(200);
    expect(calls.lite).not.toContainEqual(["stop", member]);
    expect((await callIn(en, `/api/workers/${member}`, null, "DELETE")).status).toBe(204);
    expect(calls.lite).toContainEqual(["stop", member]);
    expect(calls.basic).not.toContainEqual(["stop", member]);
  });

  it("queuing a verify job with an empty pool calls start once; reporting the job calls stop and its token row is gone", async () => {
    // Only this pool scales: earlier tests' pools are drained and their jobs failed.
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await env.DB.prepare("UPDATE worker_pools SET draining = 1").run();
    const pending = [];
    const write = (path, body, token = env.OWNER_TOKEN) => worker.fetch(new Request(`http://cinder.test${path}`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), e, { waitUntil: (p) => pending.push(p) });
    const settle = () => Promise.all(pending.splice(0));
    expect((await write("/api/repos", { name: "wp-verify" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("wp-verify")), (i) => { i.env = { ...i.env, ARTIFACTS: e.ARTIFACTS }; });
    expect(await (await write("/api/workers/pools", { name: "pool-verify", size: "lite", max: 2, kinds: ["verify"] })).json()).toMatchObject({ min: 0, workers: 0 });
    // The change's develop job goes to a self-hosted runner; its done report queues the verify job.
    await write("/api/repos/wp-verify/changes", { intent: "x" });
    const { token } = await (await write("/api/runners", { name: "lab", kinds: ["develop"] })).json();
    const dev = (await (await write("/api/work/claim", { kinds: ["develop"] }, token)).json()).job.id;
    await settle();
    const before = started.length;
    expect((await write(`/api/work/jobs/${dev}/report`, { status: "done" }, token)).status).toBe(200);
    await settle();
    expect(started).toHaveLength(before + 1);
    const { id, envVars } = started.at(-1);
    const verify = await (await write("/api/work/claim", { kinds: ["verify"] }, envVars.CINDER_RUNNER_TOKEN)).json();
    expect(verify.job.kind).toBe("verify");
    expect((await write(`/api/work/jobs/${verify.job.id}/report`, { status: "failed" }, envVars.CINDER_RUNNER_TOKEN)).status).toBe(200);
    await settle();
    expect(started).toHaveLength(before + 1);
    expect(stopped.at(-1)).toBe(id);
    expect(await env.DB.prepare("SELECT 1 FROM runner_tokens WHERE runner_id = ?").bind(id).first()).toBeNull();
  });

  it("a pool with min=0 holds no members after an idle claim", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const pool = await (await call("/api/workers/pools", { name: "pool-zero", size: "lite", max: 1, kinds: ["index"] })).json();
    expect(pool).toMatchObject({ min: 0, workers: 0 });
    await call(`/api/workers/pools/${pool.id}`, { keep_warm_s: 0 }, env.OWNER_TOKEN, "PUT");
    expect((await call(`/api/workers/pools/${pool.id}/scale`, { count: 1 })).status).toBe(200);
    expect((await claim(started.at(-1).envVars.CINDER_RUNNER_TOKEN)).status).toBe(204);
    expect((await (await call("/api/workers/pools", null, env.OWNER_TOKEN, "GET")).json()).find((p) => p.id === pool.id)).toMatchObject({ workers: 0 });
  });

  it("a pool worker not heard from in 15 minutes is stopped and its token pruned", async () => {
    const pool = await (await call("/api/workers/pools", { name: "pool-gone", size: "lite", min: 1, max: 1, kinds: ["index"] })).json();
    const { id } = started.at(-1);
    await pruneGone(e);
    expect(stopped).not.toContain(id);
    await env.DB.prepare("UPDATE runner_tokens SET created_at = ? WHERE runner_id = ?").bind(new Date(Date.now() - 16 * 60 * 1000).toISOString(), id).run();
    await pruneGone(e);
    expect(stopped.at(-1)).toBe(id);
    expect(await env.DB.prepare("SELECT 1 FROM runner_tokens WHERE runner_id = ?").bind(id).first()).toBeNull();
    expect((await (await call("/api/workers/pools", null, env.OWNER_TOKEN, "GET")).json()).find((p) => p.id === pool.id)).toMatchObject({ workers: 0 });
  });

  it("a scaleTo interrupted after registering leaves no runner without membership", async () => {
    const orphans = "SELECT t.runner_id FROM runner_tokens t WHERE t.name LIKE 'pool-cut-%' AND NOT EXISTS (SELECT 1 FROM pool_members m WHERE m.runner_id = t.runner_id)";
    // The membership write fails as if the invocation were cut off right after the runner was registered.
    await env.DB.prepare("CREATE TRIGGER cut BEFORE INSERT ON pool_members BEGIN SELECT RAISE(ABORT, 'cut off'); END").run();
    const res = await call("/api/workers/pools", { name: "pool-cut", size: "lite", min: 1, max: 1, kinds: ["index"] }).catch((err) => err);
    await env.DB.prepare("DROP TRIGGER cut").run();
    expect(res).toBeInstanceOf(Error);
    expect((await env.DB.prepare(orphans).all()).results).toEqual([]);

    // An orphan an older deploy left is pruned once it has been silent for 15 minutes.
    await env.DB.prepare("INSERT INTO runner_tokens (runner_id, name, kinds, token_hash, created_at) VALUES ('orphan', 'pool-cut-0420aaf9', '[]', 'h', ?)")
      .bind(new Date(Date.now() - 16 * 60 * 1000).toISOString()).run();
    await pruneGone(e);
    expect((await env.DB.prepare(orphans).all()).results).toEqual([]);
  });

  it("GET /api/workers/pools returns runs_per_hour and median_start_s per pool", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const pool = await (await call("/api/workers/pools", { name: "pool-stats", size: "lite", min: 1, max: 1, kinds: ["index"] })).json();
    expect(pool).toMatchObject({ runs_per_hour: 0, median_start_s: null });
    const token = started.at(-1).envVars.CINDER_RUNNER_TOKEN;
    for (const ago of [10, 20]) {
      const job = await queueJob("wp-stats");
      await env.DB.prepare("UPDATE jobs SET created_at = ? WHERE id = ?").bind(new Date(Date.now() - ago * 1000).toISOString(), job).run();
      expect((await (await call("/api/work/claim", { kinds: ["index"], slots_free: 2 }, token)).json()).job.id).toBe(job);
      await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").bind(job).run(); // frees the worker's one slot
    }
    const list = await (await call("/api/workers/pools", null, env.OWNER_TOKEN, "GET")).json();
    for (const p of list) expect(validatePool(p).errors).toEqual([]);
    const stats = list.find((p) => p.id === pool.id);
    expect(stats).toMatchObject({ runs_per_hour: 2, default: false });
    // Starts were 10 s and 20 s ago when claimed; a loaded run claims a second or two later.
    expect(stats.median_start_s).toBeGreaterThanOrEqual(15);
    expect(stats.median_start_s).toBeLessThanOrEqual(17);
    expect(list.filter((p) => p.default)).toHaveLength(1);
  });

  // Only the pools a test creates scale: earlier tests' pools are drained and their jobs failed.
  const isolate = () => env.DB.batch([env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')"), env.DB.prepare("UPDATE worker_pools SET draining = 1")]);
  const membersOf = async (pool) => (await env.DB.prepare("SELECT count(*) AS n FROM pool_members WHERE pool_id = ?").bind(pool).first()).n;

  it("a default pool with a queued blame job autoscales to 1 worker whose token claims blame", async () => {
    await isolate();
    const pool = await (await call("/api/workers/pools", { name: "pool-default", size: "basic", max: 2 })).json();
    expect(pool.kinds).toEqual(JOB_KINDS);
    const job = await queueJob("wp-blame", "blame");
    await autoscale(e);
    expect(await membersOf(pool.id)).toBe(1);
    const res = await call("/api/work/claim", { kinds: ["blame"] }, started.at(-1).envVars.CINDER_RUNNER_TOKEN);
    expect((await res.json()).job.id).toBe(job);
  });

  it("a worker's write through cinder.internal scales the pools for jobs queued meanwhile", async () => {
    await isolate();
    const pool = await (await call("/api/workers/pools", { name: "pool-internal", size: "basic", min: 1, max: 3 })).json();
    expect(await membersOf(pool.id)).toBe(1);
    const { id: busy, envVars } = started.at(-1);
    // Its one worker is busy, so the job queued next needs another.
    const held = await queueJob("wp-internal", "blame");
    await env.DB.prepare("UPDATE jobs SET status = 'claimed', runner_id = ?, lease_expires_at = ? WHERE id = ?").bind(busy, new Date(Date.now() + 600000).toISOString(), held).run();
    await queueJob("wp-internal", "blame");
    const beat = await WorkerLite.outboundByHost["cinder.internal"](new Request(`${envVars.CINDER_URL}/api/work/claim`,
      { method: "POST", headers: { Authorization: `Bearer ${envVars.CINDER_RUNNER_TOKEN}` }, body: JSON.stringify({ kinds: ["index"], slots_free: 0 }) }), e);
    expect(beat.status).toBe(204);
    expect(await membersOf(pool.id)).toBe(2);
  });

  it("a claimed job whose lease expired starts a worker to take it again", async () => {
    await isolate();
    const pool = await (await call("/api/workers/pools", { name: "pool-expired", size: "basic", max: 2 })).json();
    const job = await queueJob("wp-expired", "blame");
    await env.DB.prepare("UPDATE jobs SET status = 'claimed', runner_id = 'gone', lease_expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), job).run();
    await autoscale(e);
    expect(await membersOf(pool.id)).toBe(1);
  });

  it("a queued job for a Go repo scales the standard-2 pool and not the basic one", async () => {
    await isolate();
    const basic = await (await call("/api/workers/pools", { name: "pool-go-basic", size: "basic", max: 2 })).json();
    const full = await (await call("/api/workers/pools", { name: "pool-go-full", size: "standard-2", max: 2 })).json();
    await queueJob("wp-go-scale", "verify");
    await env.DB.prepare("UPDATE repo_meta SET language = 'Go' WHERE repo_id = (SELECT id FROM repos WHERE name = 'wp-go-scale')").run();
    await autoscale(e);
    expect([await membersOf(basic.id), await membersOf(full.id)]).toEqual([0, 1]);
  });

  it("undrain clears draining and autoscale then scales the pool", async () => {
    await isolate();
    const pool = await (await call("/api/workers/pools", { name: "pool-undrain", size: "basic", max: 1 })).json();
    expect((await call(`/api/workers/pools/${pool.id}/drain`, {})).status).toBe(200);
    await queueJob("wp-undrain");
    await autoscale(e);
    expect(await membersOf(pool.id)).toBe(0);
    expect(await (await call(`/api/workers/pools/${pool.id}/undrain`, {})).json()).toMatchObject({ draining: false });
    await autoscale(e);
    expect(await membersOf(pool.id)).toBe(1);
    expect((await call("/api/workers/pools/nope/undrain", {})).status).toBe(404);
  });

  it("a pool whose container start is refused doesn't stop the next pool scaling", async () => {
    await isolate();
    // Created first, so autoscale reaches it first: Cloudflare has no instance for its size right now.
    const refused = await (await call("/api/workers/pools", { name: "pool-refused", size: "lite", max: 1, kinds: ["blame"] })).json();
    const ok = await (await call("/api/workers/pools", { name: "pool-next", size: "basic", max: 1, kinds: ["blame"] })).json();
    await queueJob("wp-refused", "blame");
    const noInstance = { ...containers, get: (id) => ({ ...containers.get(id), start: async () => { throw new Error("There is no container instance that can be provided to this Durable Object, try again later"); } }) };
    await autoscale({ ...e, WORKER_LITE: noInstance });
    expect([await membersOf(refused.id), await membersOf(ok.id)]).toEqual([0, 1]);
  });

  it("autoscale deletes pool_runs older than a day", async () => {
    const at = (ms) => new Date(Date.now() - ms).toISOString();
    await env.DB.batch([["pr-old", at(25 * 3600 * 1000)], ["pr-new", at(23 * 3600 * 1000)]].map(([job, started]) =>
      env.DB.prepare("INSERT INTO pool_runs (job_id, pool_id, start_s, started_at) VALUES (?, 'p', 1, ?)").bind(job, started)));
    await autoscale(e);
    const { results } = await env.DB.prepare("SELECT job_id FROM pool_runs WHERE job_id LIKE 'pr-%'").all();
    expect(results.map((r) => r.job_id)).toEqual(["pr-new"]);
  });

  it("after DELETE /api/workers/:id, a request with that runner's token gets 401 and its claimed job is queued again", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const job = await queueJob("wp-revoke");
    const { id, token } = await (await call("/api/workers", { name: "revoke-me", kinds: ["index"] })).json();
    expect((await (await claim(token)).json()).job.id).toBe(job);
    expect((await call(`/api/workers/${id}`, null, env.OWNER_TOKEN, "DELETE")).status).toBe(204);
    expect((await claim(token)).status).toBe(401);
    expect(await statusOf(job)).toBe("queued");
    expect((await (await call("/api/workers", null, env.OWNER_TOKEN, "GET")).json()).some((w) => w.id === id)).toBe(false);
    expect((await call(`/api/workers/${id}`, null, env.OWNER_TOKEN, "DELETE")).status).toBe(404);
  });

  it("refuses a container request to a host outside the job's allowlist", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await call("/api/workers/pools", { name: "pool-egress", size: "lite", min: 1, max: 1, kinds: ["index"] });
    const { id, envVars } = started.at(-1);
    const out = (url, method = "GET") => WorkerLite.outbound(new Request(url, { method }), e, { containerId: id, className: "WorkerLite" });
    expect((await out("https://registry.npmjs.org/left-pad")).status).toBe(403); // no job held yet
    await queueJob("wp-egress");
    expect((await claim(envVars.CINDER_RUNNER_TOKEN)).status).toBe(200);
    const res = await out("https://evil.example/exfil");
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("egress_denied");
    expect((await out("https://registry.npmjs.org/left-pad", "PUT")).status).toBe(403); // a publish to a default host
  });

  it("refuses a Go proxy request for a module on a host off the allowlist", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await call("/api/workers/pools", { name: "pool-goproxy", size: "lite", min: 1, max: 1, kinds: ["index"] });
    const { id, envVars } = started.at(-1);
    await queueJob("wp-goproxy");
    expect((await claim(envVars.CINDER_RUNNER_TOKEN)).status).toBe(200);
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const out = (url) => WorkerLite.outbound(new Request(url), e, { containerId: id, className: "WorkerLite" });
    try {
      for (const url of ["https://proxy.golang.org/attacker.example/secret/@v/list", "https://sum.golang.org/lookup/attacker.example/secret@v1.0.0",
        "https://pkg.go.dev/attacker.example/secret", "https://proxy.golang.org/sumdb/sum.golang.org/lookup/attacker%2eexample/x@v1.0.0"]) {
        const res = await out(url);
        expect([url, res.status, (await res.json()).error.code]).toEqual([url, 403, "egress_denied"]);
      }
      expect((await out("https://proxy.golang.org/github.com/x/y/@v/list")).status).toBe(200); // a public code host
      expect((await out("https://pkg.go.dev/net/http")).status).toBe(200); // the standard library
      expect(fetched).toHaveBeenCalledTimes(2);
    } finally {
      fetched.mockRestore();
    }
  });

  it("a container holding two jobs gets only the hosts both allow", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await call("/api/workers/pools", { name: "pool-two", size: "lite", min: 1, max: 1, kinds: ["develop"] });
    const { id } = started.at(-1);
    const lease = new Date(Date.now() + 60_000).toISOString();
    await env.DB.batch(["a", "b"].flatMap((n) => [
      env.DB.prepare("INSERT INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
        "VALUES (?, ?, 1, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{}')").bind(`agent/two-${n}/v1`, `two-${n}`),
      env.DB.prepare("INSERT INTO agent_releases (name, version, egress, released_at) VALUES (?, 1, ?, '2026-10-09T00:00:00.000Z')")
        .bind(`two-${n}`, JSON.stringify([`${n}.example`, "both.example"])),
      env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, runner_id, lease_expires_at, created_at, payload) VALUES (?, 'r-two', 'develop', ?, 'claimed', ?, ?, ?, ?)")
        .bind(crypto.randomUUID(), `c-two-${n}`, id, lease, new Date().toISOString(), JSON.stringify({ agent: `two-${n}@v1` })),
    ]));
    const fetched = vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("ok"));
    const out = (url) => WorkerLite.outbound(new Request(url), e, { containerId: id, className: "WorkerLite" });
    try {
      expect((await out("https://a.example/x")).status).toBe(403);
      expect((await out("https://b.example/x")).status).toBe(403);
      expect((await out("https://both.example/x")).status).toBe(200);
      expect(fetched).toHaveBeenCalledTimes(1);
    } finally {
      fetched.mockRestore();
    }
  });

  it("refuses a model call from a container running a verify job", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await call("/api/workers/pools", { name: "pool-models", size: "lite", min: 1, max: 1, kinds: ["verify", "develop"] });
    const { id } = started.at(-1);
    const sent = [];
    const AI = { gateway: () => ({ run: async (data) => { sent.push(data); return new Response("{}"); } }) };
    const model = () => WorkerLite.outboundByHost["models.internal"](new Request("http://models.internal/anthropic/v1/messages",
      { method: "POST", body: "{}" }), { ...e, AI, AI_GATEWAY_ID: "cinder" }, { containerId: id, className: "WorkerLite" });
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, runner_id, lease_expires_at, created_at, payload) VALUES (?, 'r-models', 'verify', 'claimed', ?, ?, ?, '{}')")
      .bind(job, id, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString()).run();
    const refused = await model();
    expect([refused.status, (await refused.json()).error.code]).toEqual([403, "no_agent_job"]);
    await env.DB.prepare("UPDATE jobs SET kind = 'develop' WHERE id = ?").bind(job).run();
    expect((await model()).status).toBe(200);
    // The month's budget is reached: the develop job's call is refused too.
    const { budget_tokens } = await env.DB.prepare("SELECT budget_tokens FROM account WHERE id = 1").first();
    await env.DB.batch([env.DB.prepare("UPDATE account SET budget_tokens = 1 WHERE id = 1"),
      env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, tokens, cost_usd) VALUES ('u-models', 'r-models', ?, 1, 0)").bind(new Date().toISOString())]);
    const paused = await model();
    await env.DB.batch([env.DB.prepare("UPDATE account SET budget_tokens = ? WHERE id = 1").bind(budget_tokens),
      env.DB.prepare("DELETE FROM usage_logs WHERE id = 'u-models'")]);
    expect([paused.status, (await paused.json()).error.code]).toEqual([402, "budget_paused"]);
    expect(sent).toHaveLength(1);
  });

  it("a container-set cf-aig-byok-alias never reaches the gateway", async () => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await call("/api/workers/pools", { name: "pool-alias", size: "lite", min: 1, max: 1, kinds: ["develop"] });
    const { id } = started.at(-1);
    const sent = [];
    const AI = { gateway: () => ({ run: async (data, options) => { sent.push(options.extraHeaders); return new Response("{}"); } }) };
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, runner_id, lease_expires_at, created_at, payload) VALUES (?, 'r-alias', 'develop', 'claimed', ?, ?, ?, '{}')")
      .bind(crypto.randomUUID(), id, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString()).run();
    const headers = { "cf-aig-byok-alias": "p-0123456789abcdef", "cf-aig-skip-cache": "true", "cf-aig-metadata": "{\"job\":\"j1\"}" };
    const res = await WorkerLite.outboundByHost["models.internal"](new Request("http://models.internal/anthropic/v1/messages",
      { method: "POST", body: "{}", headers }), { ...e, AI, AI_GATEWAY_ID: "cinder" }, { containerId: id, className: "WorkerLite" });
    expect(res.status).toBe(200);
    expect(sent).toEqual([{ "cf-aig-metadata": "{\"job\":\"j1\"}" }]);
  });

  it("a runner joins a bring-your-own pool by name and counts online once it checks in", async () => {
    expect((await call("/api/workers/byo-pools", { name: "byo-a" })).status).toBe(400);
    expect((await call("/api/workers/byo-pools", { name: "byo-a", labels: ["gpu"], region: "eu-west-1" })).status).toBe(201);
    expect((await call("/api/workers/byo-pools", { name: "byo-a", labels: [] })).status).toBe(409);
    expect((await call("/api/workers", { name: "byo-x", kinds: ["verify"], pool: "nope" })).status).toBe(404);
    const { token } = await (await call("/api/workers", { name: "byo-1", kinds: ["verify"], pool: "byo-a" })).json();
    await call("/api/workers", { name: "byo-2", kinds: ["verify"], pool: "byo-a" });
    await call("/api/work/claim", { kinds: ["verify"], slots_free: 0 }, token);
    const byo = (await (await call("/api/workers/byo-pools", null, env.OWNER_TOKEN, "GET")).json()).find((p) => p.name === "byo-a");
    expect(validateByoPool(byo).errors).toEqual([]);
    expect(byo).toMatchObject({ labels: ["gpu"], cloud: null, region: "eu-west-1", members: 2, online: 1 });
  });
});
