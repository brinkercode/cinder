import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { enqueue } from "../src/queue.js";
import { expireLeases, schedule } from "../src/scheduler.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A repo with planned changes on main (one per intent) and a develop runner; cinderYml is its .cinder.yml.
async function setup(name, intents, cinderYml = "") {
  const fake = fakeArtifacts();
  const fakeEnv = { ...env, ARTIFACTS: fake };
  const call = async (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    fakeEnv,
  );
  // The tests in this file share D1: a claim must only see this test's jobs.
  await env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE status = 'queued'").run();
  expect((await call("/api/repos", { name })).status).toBe(201);
  Object.assign(fake.repos.get(name), { commits: [{ sha: "s1" }], files: { ".cinder.yml": cinderYml } });
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  const changes = [];
  for (const intent of intents) {
    const id = crypto.randomUUID();
    const now = new Date().toISOString();
    const change = {
      id, repo_id: repo.id, kind: "change", title: intent, intent, target_branch: "main", state: "planned",
      fork: `${name}--c${id}`, head: "h1", stacked_on: null, risk: null, created_at: now, updated_at: now,
    };
    await (await fake.get(name)).fork(change.fork);
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).create(change, []);
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'planned', ?)").bind(id, repo.id, now).run();
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)), (i) => { i.env = fakeEnv; });
    changes.push(change);
  }
  const token = (await (await call("/api/runners", { name: "lab", kinds: ["develop"], slots: 8 })).json()).token;
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  await runInDurableObject(repoDO, (i) => { i.env = fakeEnv; });
  const claim = async () => {
    const res = await call("/api/work/claim", { kinds: ["develop"], slots_free: 99 }, token);
    return res.status === 200 ? res.json() : null;
  };
  const stub = (c) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c.id));
  const get = async (c) => stub(c).get();
  const move = async (c, states, kind) => {
    for (const to of states) {
      expect(await stub(c).transition(to, { kind: kind ?? to, actor: { type: "system", id: "test" }, action: "change.lease", target: c.id, result: "ok" }))
        .toMatchObject({ state: to });
    }
  };
  const leases = async () => repoDO.leases("main");
  return { fake, fakeEnv, call, changes, token, claim, get, move, leases };
}

// a holds a.js#f and is parked in needs_fix with its repair job queued; b waits on a.js#f (overlap: wait).
async function parked(name) {
  const s = await setup(name, ["a", "b"], "overlap: wait\nlease:\n  idle_minutes: 10\n");
  const [a, b] = s.changes;
  await schedule(s.fakeEnv, a.id, ["a.js#f"]);
  expect(await schedule(s.fakeEnv, b.id, ["a.js#f"])).toMatchObject({ state: "waiting" });
  const { job } = await s.claim();
  s.fake.repos.get(a.fork).commits = [{ sha: "a1" }];
  expect((await s.call(`/api/work/jobs/${job.id}/report`, { status: "done" }, s.token)).status).toBe(200);
  await s.move(a, ["needs_fix"]);
  return { ...s, a, b };
}

describe("leases", () => {
  it("a change parked in needs_fix past the idle window loses its lease and the next waiter receives it", async () => {
    const { fakeEnv, a, b, get, leases } = await parked("lease-idle");
    await expireLeases(fakeEnv, Date.now() + 9 * 60_000);
    expect(await leases()).toMatchObject({ [a.id]: { granted: true }, [b.id]: { granted: false } });
    await expireLeases(fakeEnv, Date.now() + 11 * 60_000);
    const table = await leases();
    expect(table[a.id]).toBeUndefined();
    expect(table[b.id]).toMatchObject({ granted: true });
    expect(await get(b)).toMatchObject({ state: "leased" });
    expect((await get(a)).events.at(-1)).toMatchObject({ kind: "lease_expired", from_state: null });
  });

  it("three waiters on one symbol receive it in arrival order; a higher-priority waiter goes first", async () => {
    const { fakeEnv, changes, get, move } = await setup("lease-fifo", ["h", "w1", "w2", "w3", "p"], "overlap: wait\n");
    const [h, w1, w2, w3, p] = changes;
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(p.id)), async (_, state) => {
      await state.storage.put("change", { ...(await state.storage.get("change")), priority: "P1" });
    });
    for (const c of changes) await schedule(fakeEnv, c.id, ["a.js#f"]);
    const order = [];
    for (let holder = h; order.length < 4; holder = order.at(-1)) {
      await move(holder, ["closed"]);
      const states = await Promise.all([w1, w2, w3, p].map(get));
      order.push(states.find((c) => c.state === "leased"));
      expect(states.filter((c) => c.state === "leased")).toHaveLength(1);
    }
    expect(order.map((c) => c.id)).toEqual([p.id, w1.id, w2.id, w3.id]);
  });

  it("a stacked change's own symbols can't be granted to a later change", async () => {
    const { fakeEnv, changes: [a, b, c], leases } = await setup("lease-stacked", ["a", "b", "c"]);
    await schedule(fakeEnv, a.id, ["a.js#f"]);
    expect(await schedule(fakeEnv, b.id, ["a.js#f", "b.js#g"])).toMatchObject({ state: "waiting", stacked_on: a.id });
    expect(await schedule(fakeEnv, c.id, ["b.js#g"])).toMatchObject({ state: "waiting", stacked_on: b.id });
    expect((await leases())[c.id]).toMatchObject({ granted: false });
  });

  it("a change resolved after a converge conflict re-enters the queue at its original position", async () => {
    const { fakeEnv, changes, get, move } = await setup("lease-resolve", ["a", "b", "c"]);
    for (const [i, c] of changes.entries()) {
      await schedule(fakeEnv, c.id, [`${i}.js#f`]);
      await move(c, ["developing", "verifying", "in_queue"]);
      await enqueue(fakeEnv, await get(c));
    }
    const [a] = changes;
    await move(a, ["converging"], "target_advanced");
    await move(a, ["conflict", "resolving", "verifying", "in_queue"]);
    await enqueue(fakeEnv, await get(a));
    const { results } = await env.DB.prepare("SELECT change_id FROM queue_entries WHERE repo_id = ? ORDER BY seq").bind(a.repo_id).all();
    expect(results.map((r) => r.change_id)).toEqual(changes.map((c) => c.id));
  });

  it("a change resuming from needs_fix re-acquires its lease before its job is claimable", async () => {
    const { fakeEnv, a, b, claim, get, move, leases } = await parked("lease-resume");
    await expireLeases(fakeEnv, Date.now() + 11 * 60_000);
    expect((await claim()).change.id).toBe(b.id);
    // a's repair job stays unclaimable while b holds a.js#f; a waits in line for it.
    expect(await claim()).toBeNull();
    expect((await leases())[a.id]).toMatchObject({ granted: false });
    await move(b, ["closed"]);
    expect(await claim()).toMatchObject({ change: { id: a.id, state: "developing" } });
    expect((await leases())[a.id]).toMatchObject({ granted: true });
    expect(await get(a)).toMatchObject({ state: "developing" });
  });
});
