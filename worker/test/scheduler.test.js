import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { validateLeaseMap } from "../src/api/contract.js";
import { collisionQuestion, recordJudgment } from "../src/judgments.js";
import { enqueue } from "../src/queue.js";
import { schedule } from "../src/scheduler.js";
import { startSeam } from "../src/seam.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

async function setup(name, intents) {
  const fake = fakeArtifacts();
  const fakeEnv = { ...env, ARTIFACTS: fake };
  const call = async (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    fakeEnv,
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  const changes = [];
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  // Planned changes stored directly: creating one through the API schedules it.
  for (const intent of intents) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const change = {
      id, repo_id: repo.id, kind: "change", title: intent, intent, target_branch: "main", state: "planned",
      fork: `${name}--c${id}`, stacked_on: null, risk: null, created_at: now, updated_at: now,
    };
    await (await fake.get(name)).fork(change.fork);
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).create(change, []);
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', ?)").bind(id, repo.id, now).run();
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)), (i) => { i.env = fakeEnv; });
    changes.push(change);
  }
  const token = (await (await call("/api/runners", { name: "lab", kinds: ["develop"], slots: 8 })).json()).token;
  // Set last: an idle DO can be evicted during a slow setup, dropping the fake env.
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = fakeEnv; });
  const claim = async () => {
    const res = await call("/api/work/claim", { kinds: ["develop"], slots_free: 99 }, token);
    return res.status === 200 ? res.json() : null;
  };
  return { fake, fakeEnv, call, changes, token, claim };
}

describe("scheduler", () => {
  it("3 disjoint intents all start", async () => {
    const { fakeEnv, changes, claim } = await setup("sched-disjoint", ["a", "b", "c"]);
    const leases = [["a.js#f"], ["b.js#g"], ["c.js#h"]];
    for (const [i, c] of changes.entries()) expect(await schedule(fakeEnv, c.id, leases[i])).toMatchObject({ state: "leased" });
    const claims = [await claim(), await claim(), await claim()];
    expect(claims.map((c) => [c.change.id, c.change.state, c.payload.lease]))
      .toEqual(changes.map((c, i) => [c.id, "developing", leases[i]]));
  });

  it("overlapping intent stacks on the other's head", async () => {
    const { fakeEnv, changes: [a, b], claim } = await setup("sched-stack", ["a", "b"]);
    await schedule(fakeEnv, a.id, ["a.js#f"]);
    expect(await schedule(fakeEnv, b.id, ["a.js#f", "b.js#g"])).toMatchObject({ state: "waiting", stacked_on: a.id });
    expect((await claim()).change.id).toBe(a.id);
    expect(await claim()).toBeNull();
  });

  it("stacked change starts when its base pushes", async () => {
    const { fake, fakeEnv, call, changes: [a, b], token, claim } = await setup("sched-push", ["a", "b"]);
    await schedule(fakeEnv, a.id, ["a.js#f"]);
    await schedule(fakeEnv, b.id, ["a.js#f"]);
    const job = (await claim()).job;
    expect(await claim()).toBeNull();
    fake.repos.get(a.fork).commits = [{ sha: "a1" }];
    expect((await call(`/api/work/jobs/${job.id}/report`, { status: "done" }, token)).status).toBe(200);
    const stacked = await claim();
    expect(stacked).toMatchObject({ change: { id: b.id, state: "developing", stacked_on: a.id }, payload: { lease: ["a.js#f"], onto: { fork: a.fork, sha: "a1" } } });
    // The runner parses `base` as a string; a stacked change's fork rides as `onto`.
    expect(stacked.payload.base ?? null).toBeNull();
  });

  // b stacked on a, started once a pushed: a is verifying, b developing.
  async function stacked(name) {
    const s = await setup(name, ["a", "b"]);
    const [a, b] = s.changes;
    await schedule(s.fakeEnv, a.id, ["a.js#f"]);
    await schedule(s.fakeEnv, b.id, ["a.js#f"]);
    s.fake.repos.get(a.fork).commits = [{ sha: "a1" }];
    await s.call(`/api/work/jobs/${(await s.claim()).job.id}/report`, { status: "done" }, s.token);
    const job = (await s.claim()).job;
    const move = async (c, states) => {
      for (const to of states) await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c.id)).transition(to, {
        kind: to, actor: { type: "system", id: "test" }, action: "change.lease", target: c.id, result: "ok",
      });
    };
    return { ...s, a, b, job, move, get: async (c) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c.id)).get() };
  }

  it("dependent converges after base merge", async () => {
    const { a, b, move, get } = await stacked("sched-restack-merge");
    await move(b, ["verifying", "in_queue"]);
    await move(a, ["in_queue", "merged"]);
    expect(await get(b)).toMatchObject({ state: "converging", stacked_on: null });
    const { results } = await env.DB.prepare("SELECT payload FROM jobs WHERE kind = 'converge' AND change_id = ?").bind(b.id).all();
    expect(results.map((j) => JSON.parse(j.payload))).toEqual([{ target: b.target_branch, return_to: "in_queue", theirs: [{ id: a.id, intent: a.intent }], onto: null }]);
  });

  it("closing a stack base restarts a developing change stacked on it", async () => {
    const { a, b, job, move, get, claim } = await stacked("sched-restack-close");
    expect(await get(b)).toMatchObject({ state: "developing", stacked_on: a.id });
    await move(a, ["closed"]);
    expect(await get(b)).toMatchObject({ state: "leased", stacked_on: null });
    expect(await env.DB.prepare("SELECT 1 AS x FROM job_cancels WHERE job_id = ?").bind(job.id).first()).toEqual({ x: 1 });
    expect(await claim()).toMatchObject({ change: { id: b.id, state: "developing" }, payload: { lease: ["a.js#f"], wait_for: null, base: null } });
  });

  // Creates changes through the API on a target indexed at s1 with symbol parse.js#parser, so every intent naming
  // "parser" predicts the same lease.
  async function created(name, intents, cinderYml = "") {
    const { fake, fakeEnv, call, claim } = await setup(name, []);
    const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
    Object.assign(fake.repos.get(name), { commits: [{ sha: "s1" }], files: { ".cinder.yml": cinderYml } });
    await env.DB.prepare("INSERT INTO symbols VALUES (?, 's1', 'parse.js', 'parser', 'function', 1, 2)").bind(repo.id).run();
    await env.DB.prepare("INSERT INTO symbol_indexes VALUES (?, 's1')").bind(repo.id).run();
    const changes = [];
    for (const intent of intents) {
      const res = await call(`/api/repos/${name}/changes`, { intent });
      expect(res.status).toBe(201);
      const change = await res.json();
      await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)), (i) => { i.env = fakeEnv; });
      changes.push(change);
    }
    const developJobs = async (id) => (await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'develop'").bind(id).all()).results;
    return { fakeEnv, changes, claim, developJobs };
  }

  it("creating a change with no overlapping leases queues a develop job and the change is leased", async () => {
    const { changes: [a], claim, developJobs } = await created("sched-create", ["fix the parser"]);
    expect(a).toMatchObject({ state: "leased" });
    expect((await developJobs(a.id)).map((j) => JSON.parse(j.payload))).toEqual([{ lease: ["parse.js#parser"], wait_for: null, base: null }]);
    expect(await claim()).toMatchObject({ change: { id: a.id, state: "developing" } });
  });

  it("a stacked change starts when the change it waits on merges", async () => {
    const { changes: [a, b], claim } = await created("sched-merge", ["fix the parser", "speed up the parser"], "overlap: wait\n");
    expect(b).toMatchObject({ state: "waiting" });
    expect((await claim()).change.id).toBe(a.id);
    expect(await claim()).toBeNull();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(a.id));
    const event = (kind) => ({ kind, actor: { type: "system", id: "cinder" }, action: "change.lease", target: a.id, result: "ok" });
    for (const to of ["verifying", "in_queue", "merged"]) expect(await stub.transition(to, event(to))).toMatchObject({ state: to });
    expect(await claim()).toMatchObject({ change: { id: b.id, state: "developing" }, payload: { wait_for: null } });
  });

  it("scheduling twice queues one develop job", async () => {
    const { fakeEnv, changes: [a, b], developJobs } = await created("sched-twice", ["fix the parser", "speed up the parser"]);
    expect(await schedule(fakeEnv, a.id, ["parse.js#parser"])).toBeNull();
    expect(await schedule(fakeEnv, b.id, ["parse.js#parser"])).toBeNull();
    expect((await developJobs(a.id)).length).toBe(1);
    expect((await developJobs(b.id)).length).toBe(1);
  });

  // a and b leased on disjoint symbols, then a seam proposed for them on a.js#f; the seam has pushed and a, b are developing on it.
  async function seamed(name) {
    const s = await setup(name, ["a", "b"]);
    const [a, b] = s.changes;
    await schedule(s.fakeEnv, a.id, ["a.js#f"]);
    await schedule(s.fakeEnv, b.id, ["b.js#g"]);
    const seam = await startSeam(s.fakeEnv, { id: a.repo_id, name }, "main", { changes: [a.id, b.id], symbols: ["a.js#f"], p: 0.9 });
    expect(seam).toMatchObject({ kind: "seam", state: "leased" });
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(seam.id)), (i) => { i.env = s.fakeEnv; });
    const get = async (c) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c.id)).get();
    expect([await get(a), await get(b)]).toMatchObject([{ state: "waiting", stacked_on: seam.id }, { state: "waiting", stacked_on: seam.id }]);
    const move = async (c, states) => {
      for (const to of states) await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c.id)).transition(to, {
        kind: to, actor: { type: "system", id: "test" }, action: "change.lease", target: c.id, result: "ok",
      });
    };
    s.fake.repos.get(seam.fork).commits = [{ sha: "s1" }];
    await move(seam, ["developing", "verifying"]);
    const { results } = await env.DB.prepare("SELECT change_id, payload FROM jobs WHERE kind = 'develop' AND change_id IN (?, ?) ORDER BY change_id")
      .bind(a.id, b.id).all();
    expect(results.map((j) => [j.change_id, JSON.parse(j.payload).onto])).toEqual([a, b].map((c) => [c.id, { fork: seam.fork, sha: "s1" }]).sort());
    await move(a, ["developing"]);
    await move(b, ["developing"]);
    return { ...s, a, b, seam, get, move };
  }

  // a and b both predict the Go type api.go#Client; the seam scheduling b starts is held in seam mode.
  async function predicted(name, intents = ["a", "b"]) {
    const s = await setup(name, intents);
    await env.DB.prepare("INSERT INTO symbols (repo_id, sha, path, name, kind, start_line, end_line) VALUES (?, 's0', 'api.go', 'Client', 'type', 1, 3)")
      .bind(s.changes[0].repo_id).run();
    await schedule(s.fakeEnv, s.changes[0].id, ["api.go#Client"]);
    await schedule(s.fakeEnv, s.changes[1].id, ["api.go#Client", "b.go#g"]);
    const get = async (c) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c.id)).get();
    const seam = await get({ id: (await get(s.changes[0])).stacked_on });
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(seam.id)), (i) => { i.env = s.fakeEnv; });
    const leases = async () => (await (await worker.fetch(new Request(`http://cinder.test/api/repos/${name}/lease-map`, {
      headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
    }), s.fakeEnv)).json()).leases.filter((l) => l.file === "api.go");
    return { ...s, seam, get, leases };
  }

  it("two changes predicting the same interface symbol produce one seam change, holding it in seam mode, with both changes waiting on it", async () => {
    const { changes: [a, b], seam, get, leases } = await predicted("sched-seam-start");
    expect(seam).toMatchObject({ kind: "seam", state: "leased" });
    expect([await get(a), await get(b)]).toMatchObject([{ state: "waiting", stacked_on: seam.id }, { state: "waiting", stacked_on: seam.id }]);
    expect(await leases()).toEqual([{ symbol: "api.go#Client", file: "api.go", holder: seam.id, expires_at: expect.any(String), mode: "seam", waiting: [] }]);
  });

  it("the seam change is written by developer's version, not the harness default", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES ('agent/developer/v7', 'developer', 7, 'opencode', '@cf/openai/gpt-oss-120b', 'medium', 'h', '[]', '{}')"),
      env.DB.prepare("INSERT OR REPLACE INTO channels (agent_name, channel, version) VALUES ('developer', 'stable', 7)"),
    ]);
    const { seam } = await predicted("sched-seam-agent");
    expect(seam.agent_version).toBe("developer@v7");
    const job = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'develop'").bind(seam.id).first("payload");
    expect(JSON.parse(job).agent).toBe("developer@v7");
  });

  it("after the seam change merges, both dependents are scheduled and the leases API shows their leases on the symbol as shared", async () => {
    const { fake, changes: [a, b], seam, get, leases } = await predicted("sched-seam-shared");
    fake.repos.get(seam.fork).commits = [{ sha: "s1" }];
    for (const to of ["developing", "verifying", "in_queue", "merged"]) {
      await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(seam.id)).transition(to, {
        kind: to, actor: { type: "system", id: "test" }, action: "change.lease", target: seam.id, result: "ok",
      });
    }
    expect([await get(a), await get(b)]).toMatchObject([{ state: "leased" }, { state: "leased" }]);
    expect((await leases()).map((l) => [l.holder, l.symbol, l.mode]).sort())
      .toEqual([[a.id, "api.go#Client", "shared"], [b.id, "api.go#Client", "shared"]].sort());
    const map = await (await worker.fetch(new Request("http://cinder.test/api/repos/sched-seam-shared/lease-map", {
      headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
    }), env)).json();
    expect(map.leases.filter((l) => l.symbol === "api.go#Client").map((l) => l.mode)).toEqual(["shared", "shared"]);
  });

  it("a recorded collision judgment appears as an edge with its p", async () => {
    const { fakeEnv, changes: [a, b, c] } = await setup("sched-judged-edge", ["a", "b", "c"]);
    await schedule(fakeEnv, a.id, ["a.js#f"]);
    await schedule(fakeEnv, b.id, ["a.js#f"]);
    const judgment = (id, other, answer, p) => recordJudgment(env.DB, {
      repo: a.repo_id, change: id, kind: "collision", backend: "clef-flash", model: "clef-flash@1", state_hash: id, question: collisionQuestion(other), answer, p,
    });
    await judgment(c.id, a.id, "yes", 0.8);
    await judgment(b.id, a.id, "no", 0.9);
    const map = await (await worker.fetch(new Request("http://cinder.test/api/repos/sched-judged-edge/lease-map", {
      headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
    }), env)).json();
    expect(validateLeaseMap(map).errors).toEqual([]);
    const ab = map.edges.filter((e) => [e.a, e.b].sort().join() === [a.id, b.id].sort().join());
    expect(ab).toMatchObject([{ p: 1, judge: { name: "lease" } }]);
    expect(map.edges.filter((e) => e.a === c.id)).toEqual([{ a: c.id, b: a.id, p: 0.8, calibrated: 0.8, judge: { name: "clef-flash", count: 0, trusted: false } }]);
  });

  it("scheduling twice creates one seam change", async () => {
    const { fakeEnv, changes: [a, b, c], seam, get } = await predicted("sched-seam-twice", ["a", "b", "c"]);
    expect(await schedule(fakeEnv, a.id, ["api.go#Client"])).toBeNull();
    expect(await schedule(fakeEnv, b.id, ["api.go#Client", "b.go#g"])).toBeNull();
    await schedule(fakeEnv, c.id, ["api.go#Client"]);
    expect(await get(c)).toMatchObject({ state: "waiting", stacked_on: seam.id });
    const { results } = await env.DB.prepare("SELECT id FROM changes WHERE repo_id = ?").bind(a.repo_id).all();
    const kinds = await Promise.all(results.map((r) => get(r).then((x) => x.kind)));
    expect(kinds.filter((k) => k === "seam")).toHaveLength(1);
  });

  it("two changes predicting the same exported function produce one seam change; on an unexported function they stack instead", async () => {
    const s = await setup("sched-seam-js", ["a", "b", "c", "d"]);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO symbols VALUES (?1, 's0', 'x.js', 'pub', 'function', 1, 3), (?1, 's0', 'x.js', 'priv', 'function', 5, 7)"),
      env.DB.prepare("INSERT INTO symbol_exports VALUES (?1, 's0', 'x.js', 'pub', 'function')"),
    ].map((q) => q.bind(s.changes[0].repo_id)));
    const get = async (c) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c.id)).get();
    const [a, b, c, d] = s.changes;
    await schedule(s.fakeEnv, a.id, ["x.js#pub"]);
    await schedule(s.fakeEnv, b.id, ["x.js#pub"]);
    const seam = await get({ id: (await get(a)).stacked_on });
    expect(seam).toMatchObject({ kind: "seam" });
    expect(await get(b)).toMatchObject({ state: "waiting", stacked_on: seam.id });
    await schedule(s.fakeEnv, c.id, ["x.js#priv"]);
    await schedule(s.fakeEnv, d.id, ["x.js#priv"]);
    expect([await get(c), await get(d)]).toMatchObject([{ state: "leased", stacked_on: null }, { state: "waiting", stacked_on: c.id }]);
  });

  it("seam change is queued ahead of dependents", async () => {
    const { fakeEnv, a, b, seam, get, move } = await seamed("sched-seam-queue");
    // Queued changes have pushed heads: a headless one goes back to needs_fix on the repo's next sweep (queue.js).
    for (const [c, sha] of [[a, "a2"], [b, "b2"], [seam, "s2"]]) await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c.id)).moveHead(sha);
    await move(a, ["verifying", "in_queue"]);
    await move(b, ["verifying", "in_queue"]);
    await enqueue(fakeEnv, await get(a));
    await enqueue(fakeEnv, await get(b));
    await move(seam, ["in_queue"]);
    await enqueue(fakeEnv, await get(seam));
    // The sweep the moves armed runs now, not whenever its alarm fires, so the order is read after it.
    await runDurableObjectAlarm(env.REPO_DO.get(env.REPO_DO.idFromName("sched-seam-queue")));
    const { results } = await env.DB.prepare("SELECT change_id FROM queue_entries WHERE repo_id = ? ORDER BY seq").bind(a.repo_id).all();
    expect(results.map((r) => r.change_id)).toEqual([seam.id, a.id, b.id]);
  });

  it("dependents restack after the seam merges", async () => {
    const { a, b, seam, get, move } = await seamed("sched-seam-merge");
    await move(a, ["verifying", "in_queue"]);
    await move(b, ["verifying", "needs_fix"]);
    await move(seam, ["in_queue", "merged"]);
    expect([await get(a), await get(b)]).toMatchObject([{ state: "converging", stacked_on: null }, { state: "converging", stacked_on: null }]);
    const { results } = await env.DB.prepare("SELECT change_id, payload FROM jobs WHERE kind = 'converge' AND repo_id = ? ORDER BY change_id").bind(a.repo_id).all();
    expect(results.map((j) => [j.change_id, JSON.parse(j.payload).theirs])).toEqual([a, b].map((c) => [c.id, [{ id: seam.id, intent: seam.intent }]]).sort());
  });
});
