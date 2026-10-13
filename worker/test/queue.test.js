import { env } from "cloudflare:workers";
import { runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateChange, validateConflictObject, validateConvergePayload, validateQueueEntry } from "../src/api/contract.js";
import worker from "../src/index.js";
import { queueMergeJob } from "../src/queue.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  fake.repos.get(name).files[".cinder.yml"] = "branches:\n  integration: [main, next]\n";
  fake.repos.get(name).commits = [{ sha: "t1" }];
  // Re-applied before each change: a RepoDO instance evicted under load (or woken by its queue alarm) loses the fake.
  const patch = () => runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  await patch();
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["verify", "merge", "converge"], slots: 8 })).json()).token;
  const claim = async (kinds) => {
    // Other tests' repos keep queued jobs (their queue alarms re-queue merges after a cancel); only this repo's are claimable.
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status = 'queued' AND repo_id <> (SELECT id FROM repos WHERE name = ?)").bind(name).run();
    const res = await call("/api/work/claim", { kinds, slots_free: 99 }, runner);
    return res.status === 204 ? null : res.json();
  };
  // A change on target, pushed with `pushed` (a head with a clean guard result by default), taken through a real verify
  // job (speculating on `ahead`) into in_queue; it reports its tree and anything in report (writes, reads).
  const verified = async (target, ahead = [], report = {}, pushed = { head: "h1", guard: { status: "clear", sha: "h1", at: new Date().toISOString() } }) => {
    await patch();
    const change = await (await call(`/api/repos/${name}/changes`, { intent: "x", target_branch: target })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
    for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, {
      kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: change.id, result: "ok",
    });
    await stub.stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: change.id, result: "ok" }, pushed);
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ ahead })).run();
    const job = await claim(["verify"]);
    const res = await (await call(`/api/work/jobs/${job.job.id}/report`, { status: "done", tree: treeOf(change.id), base: BASE, ...report }, runner)).json();
    expect(res.change.state).toBe("in_queue");
    return change;
  };
  const queue = async (target) => (await call(`/api/repos/${name}/queue?target=${target}`, null, env.OWNER_TOKEN, "GET")).json();
  return { fake, call, runner, claim, verified, queue };
}

const BASE = "b".repeat(40);
const treeOf = (id) => id.replace(/[^0-9a-f]/g, "").padEnd(40, "0").slice(0, 40);
const writeTokens = (fake, repo) => fake.calls.filter((c) => c.method === "createToken" && c.args[0] === repo && c.args[1] === "write");

describe("merge queue", () => {
  it("two targets have independent queues", async () => {
    const { verified, queue, claim } = await setup("q-two");
    const a = await verified("main");
    const b = await verified("next");
    const c = await verified("main");
    const main = await queue("main");
    expect(main.map((e) => [e.change_id, e.position])).toEqual([[a.id, 0], [c.id, 1]]);
    expect((await queue("next")).map((e) => [e.change_id, e.position])).toEqual([[b.id, 0]]);
    for (const e of main) expect(validateQueueEntry(e)).toEqual({ ok: true, errors: [] });
    // Each target's head gets its own merge job.
    const heads = [(await claim(["merge"])).change.id, (await claim(["merge"])).change.id];
    expect(heads.sort()).toEqual([a.id, b.id].sort());
  });

  it("mirror failure still reports merged", async () => {
    const { call, runner, verified, claim } = await setup("q-mirror");
    await env.DB.prepare("INSERT INTO repo_mirrors (repo_id, mirror_url) SELECT id, ? FROM repos WHERE name = ?").bind("https://github.com/o/q-mirror.git", "q-mirror").run();
    const a = await verified("main");
    const merge = await claim(["merge"]);
    expect(merge.payload.mirror_url).toBe("https://github.com/o/q-mirror.git");
    const res = await (await call(`/api/work/jobs/${merge.job.id}/report`, { status: "done", mirror_failed: true }, runner)).json();
    expect(res.change.state).toBe("merged");
    const { events } = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(a.id)).get();
    expect(events.at(-1)).toMatchObject({ kind: "mirror_failed", target: merge.job.id, result: "failed" });
  });

  it("without the signing key binding a merge lands unsigned and is flagged on the change and in its timeline", async () => {
    const { call, runner, verified, claim } = await setup("q-unsigned");
    const a = await verified("main");
    const merge = await claim(["merge"]);
    // No MERGE_SIGNING_KEY binding in the test env: the sign route answers without a signature, and only GET signing-key fails.
    const sign = await call(`/api/work/jobs/${merge.job.id}/sign`, { commit: `tree ${treeOf(a.id)}\n` }, runner);
    expect(sign.status).toBe(200);
    expect(await sign.json()).toEqual({ signature: null });
    expect((await call("/api/repos/q-unsigned/signing-key", null, env.OWNER_TOKEN, "GET")).status).toBe(503);
    const res = await (await call(`/api/work/jobs/${merge.job.id}/report`, { status: "done", unsigned: true }, runner)).json();
    expect(res.change.state).toBe("merged");
    const { events, ...change } = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(a.id)).get();
    expect(change.unsigned).toBe(true);
    expect(validateChange(change).errors).toEqual([]);
    expect(events.at(-1)).toMatchObject({ kind: "merge_unsigned", target: merge.job.id, result: "unsigned", reason: "no_signing_key" });
  });

  it("only the head's job carries a write token", async () => {
    const { fake, call, runner, verified, claim } = await setup("q-head");
    const a = await verified("main");
    const b = await verified("main");
    const first = await claim(["merge"]);
    expect(first).toMatchObject({ job: { kind: "merge" }, change: { id: a.id } });
    expect(first.token).toBeTruthy();
    expect(await claim(["merge"])).toBeNull();
    expect(writeTokens(fake, "q-head")).toHaveLength(1);
    // Once the head merges, the next change converges, re-verifies, becomes head again and only then gets its token.
    expect((await (await call(`/api/work/jobs/${first.job.id}/report`, { status: "done" }, runner)).json()).change.state).toBe("merged");
    expect(await claim(["merge"])).toBeNull();
    const converge = await claim(["converge"]);
    expect((await (await call(`/api/work/jobs/${converge.job.id}/report`, { status: "done" }, runner)).json()).change.state).toBe("verifying");
    const verify = await claim(["verify"]);
    expect((await (await call(`/api/work/jobs/${verify.job.id}/report`, { status: "done" }, runner)).json()).change.state).toBe("in_queue");
    const second = await claim(["merge"]);
    expect(second).toMatchObject({ change: { id: b.id } });
    expect(second.token).toBeTruthy();
    expect(writeTokens(fake, "q-head")).toHaveLength(2);
  });

  it("a merge enqueues one converge job per active change on that target only", async () => {
    const { call, runner, verified, claim } = await setup("q-converge");
    const a = await verified("main");
    const b = await verified("main");
    const other = await verified("next");
    const dev = await (await call("/api/repos/q-converge/changes", { intent: "x", target_branch: "main" })).json();
    const devStub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(dev.id));
    for (const s of ["leased", "developing"]) await devStub.transition(s, {
      kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: dev.id, result: "ok",
    });
    const merge = await claim(["merge"]);
    expect(merge.change.id).toBe(a.id);
    await call(`/api/work/jobs/${merge.job.id}/report`, { status: "done" }, runner);
    const { results } = await env.DB.prepare("SELECT change_id, payload FROM jobs WHERE kind = 'converge' AND repo_id = ?").bind(a.repo_id).all();
    expect(results).toEqual([{ change_id: b.id, payload: JSON.stringify({ target: "main", return_to: "in_queue", theirs: [{ id: a.id, intent: a.intent }] }) }]);
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(b.id)).get()).state).toBe("converging");
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(other.id)).get()).state).toBe("in_queue");
    expect((await devStub.get()).state).toBe("developing");
    // Drain the other target's merge job: b is converging, so nothing on main is mergeable.
    expect((await claim(["merge"])).change.id).toBe(other.id);
    expect(await claim(["merge"])).toBeNull();
  });

  it("queueConvergeJobs produces a payload that validates against the contract with theirs as objects", async () => {
    const { call, runner, verified, claim } = await setup("q-converge-contract");
    const a = await verified("main");
    const b = await verified("main");
    const merge = await claim(["merge"]);
    await call(`/api/work/jobs/${merge.job.id}/report`, { status: "done" }, runner);
    const { payload } = await env.DB.prepare("SELECT payload FROM jobs WHERE kind = 'converge' AND change_id = ?").bind(b.id).first();
    expect(validateConvergePayload(JSON.parse(payload))).toEqual({ ok: true, errors: [] });
    expect(JSON.parse(payload).theirs).toEqual([{ id: a.id, intent: a.intent }]);
  });

  it("higher risk converges first", async () => {
    const { fake, runner, verified, claim } = await setup("q-budget");
    const a = await verified("main");
    const b = await verified("main");
    const c = await verified("main");
    // Leases ride on develop jobs: c overlaps the merged change a, b doesn't.
    for (const [id, lease] of [[a.id, ["net.js#fetch"]], [b.id, ["log.js#log"]], [c.id, ["net.js#fetch"]]]) {
      await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'done', ?, ?)")
        .bind(crypto.randomUUID(), a.repo_id, id, new Date().toISOString(), JSON.stringify({ lease })).run();
    }
    const states = [];
    const AI = fakeClefAI(async (_, { state }) => (states.push(state), { collision: state.overlap.length ? 0.9 : 0.2 }));
    const merge = await claim(["merge"]);
    fake.repos.get("q-budget").commits.unshift({ sha: "t2" });
    await worker.fetch(new Request(`http://cinder.test/api/work/jobs/${merge.job.id}/report`, {
      method: "POST", headers: { Authorization: `Bearer ${runner}` }, body: JSON.stringify({ status: "done" }),
    }), { ...env, ARTIFACTS: fake, AI });
    expect(states).toContainEqual({ intent: c.intent, commits_behind: 1, overlap: ["net.js#fetch"] });
    expect((await claim(["converge"])).change.id).toBe(c.id);
    expect((await claim(["converge"])).change.id).toBe(b.id);
  });

  it("token TTL ≤ 600", async () => {
    const { fake, verified, claim } = await setup("q-ttl");
    await verified("main");
    expect((await claim(["merge"])).token).toBeTruthy();
    const [[, , ttl]] = writeTokens(fake, "q-ttl").map((c) => c.args);
    expect(ttl).toBeLessThanOrEqual(600);
  });

  it("base_moved re-enters converging", async () => {
    const { fake, verified, claim, queue } = await setup("q-moved");
    const a = await verified("main");
    fake.repos.get("q-moved").commits.unshift({ sha: "t2" });
    expect(await claim(["merge"])).toBeNull();
    expect(writeTokens(fake, "q-moved")).toHaveLength(0);
    const change = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(a.id)).get();
    expect(change.state).toBe("converging");
    expect(change.events.at(-1)).toMatchObject({ kind: "base_moved", from_state: "in_queue", to_state: "converging" });
    expect(await queue("main")).toEqual([]);
  });
});

describe("queue readiness", () => {
  it("the readiness the API reports matches what enqueue accepts", async () => {
    const { call } = await setup("q-ready");
    const change = await (await call("/api/repos/q-ready/changes", { intent: "x", target_branch: "main" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
    for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: change.id, result: "ok" });
    await stub.stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: change.id, result: "ok" },
      { head: "h1", verdict: { sha: "h1", status: "pass", at: new Date().toISOString() } });
    // Verified once, then a push left a verify pending on the new head; the route wants a person.
    await stub.setReview({ route: "human", reason: "risk high" });
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')")
      .bind(job, change.repo_id, change.id, new Date().toISOString()).run();
    const agree = async (blocker) => {
      const detail = await (await call(`/api/changes/${change.id}`, null, env.OWNER_TOKEN, "GET")).json();
      expect(detail.queue_blocker).toBe(blocker);
      return detail;
    };
    await agree("Verifier hasn't passed the head");
    expect((await call(`/api/changes/${change.id}/review`, { verdict: "approve" })).status).toBe(200);
    // Approved, yet the head is unverified: the API says not ready and the queue refuses alike.
    await agree("Verifier hasn't passed the head");
    const refused = await call(`/api/changes/${change.id}/queue`);
    expect([refused.status, (await refused.json()).error.message]).toEqual([409, `change ${change.id} can't queue: Verifier hasn't passed the head`]);
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").bind(job).run();
    await agree(null);
    expect((await (await call(`/api/changes/${change.id}/queue`)).json()).state).toBe("in_queue");
  });

  it("a change with no head is refused by POST /queue and by autoQueue", async () => {
    const { call } = await setup("q-headless");
    const change = await (await call("/api/repos/q-headless/changes", { intent: "x", target_branch: "main" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
    for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: change.id, result: "ok" });
    await stub.setReview({ route: "human", reason: "risk high" });
    // The approval runs autoQueue, which must not queue a change with nothing pushed.
    expect((await (await call(`/api/changes/${change.id}/review`, { verdict: "approve" })).json()).state).toBe("verifying");
    const refused = await call(`/api/changes/${change.id}/queue`);
    expect([refused.status, (await refused.json()).error.message]).toEqual([409, `change ${change.id} can't queue: No head pushed`]);
  });
});

describe("queue re-evaluation", () => {
  const repoDO = (name) => env.REPO_DO.get(env.REPO_DO.idFromName(name));
  // Later tests claim merge jobs from any repo.
  afterEach(() => env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'merge' AND status = 'queued'").run());
  // The head's own transitions wake the alarm by themselves; wait for that evaluation before acting on the queue.
  const stuck = (queue) => vi.waitFor(async () => expect((await queue("main"))[0].blocker).toContain("no guard result"), { timeout: 10_000 });

  it("coalesces three events on one target into one evaluation", async () => {
    await setup("qe-coalesce");
    // A head put in the queue directly: no transition, so no alarm of its own races the one under test.
    const a = { id: crypto.randomUUID(), repo_id: (await env.DB.prepare("SELECT id FROM repos WHERE name = 'qe-coalesce'").first()).id };
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(a.id)).create({ ...a, head: "h1", target_branch: "main", state: "planned", intent: "x", created_at: new Date().toISOString() }, []);
    await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'in_queue', ?)")
      .bind(a.id, a.repo_id, new Date().toISOString()).run();
    await env.DB.prepare("INSERT INTO queue_entries (change_id, repo_id, target_branch, enqueued_at) VALUES (?, ?, 'main', ?)")
      .bind(a.id, a.repo_id, new Date().toISOString()).run();
    let evaluations = 0;
    await runInDurableObject(repoDO("qe-coalesce"), async (i) => {
      const real = i.env.CHANGE_DO;
      i.env = { ...i.env, CHANGE_DO: { idFromName: (n) => real.idFromName(n), get: (id) => (evaluations++, real.get(id)) } };
      await i.ctx.storage.put({ sweep_at: Date.now() + 60_000 });
      for (let n = 0; n < 3; n++) await i.touch(a.repo_id, "main");
    });
    // On a slow runner the 250ms alarm can fire by itself before this runs it; either way exactly one evaluation follows.
    await runDurableObjectAlarm(repoDO("qe-coalesce"));
    await vi.waitFor(() => expect(evaluations).toBe(1));
  });

  it("merges the head when blockers clear", async () => {
    const { verified, queue } = await setup("qe-merge");
    const a = await verified("main", [], {}, { head: "h1" });
    await stuck(queue);
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'merge' AND change_id = ?").bind(a.id).run();
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(a.id)), async (i) => {
      const change = await i.ctx.storage.get("change");
      const at = new Date().toISOString();
      await i.ctx.storage.put("change", {
        ...change, head: "h1", verdict: { sha: "h1", status: "pass", at }, guard: { status: "clear", sha: "h1", at }, approvals: [],
        policy: { approvals: 0 }, route: { reviewers: [] },
      });
    });
    await repoDO("qe-merge").touch(a.repo_id, "main");
    const job = () => env.DB.prepare("SELECT 1 FROM jobs WHERE kind = 'merge' AND status = 'queued' AND change_id = ?").bind(a.id).first();
    await vi.waitFor(async () => expect(await job()).toBeTruthy(), { timeout: 10_000 });
    expect((await queue("main"))[0]).toMatchObject({ change_id: a.id, blocker: null });
  });

  it("stores the blocker reason on a stuck head", async () => {
    const { verified, queue } = await setup("qe-stuck");
    const a = await verified("main", [], {}, { head: "h1" });
    await stuck(queue);
    const [head] = await queue("main");
    expect(head.change_id).toBe(a.id);
    expect(head.blocker).toContain("no guard result");
    expect(validateQueueEntry(head)).toEqual({ ok: true, errors: [] });
  });

  it("sweep alarm evaluates a target with no events", async () => {
    const { verified, queue } = await setup("qe-sweep");
    const a = await verified("main", [], {}, { head: "h1" });
    await stuck(queue);
    await env.DB.prepare("DELETE FROM queue_blockers WHERE change_id = ?").bind(a.id).run();
    // No event is pending; only the sweep, due now, can store the reason again.
    await runInDurableObject(repoDO("qe-sweep"), (i) => i.ctx.storage.put({ pending: [], sweep_at: 0 }));
    await runDurableObjectAlarm(repoDO("qe-sweep"));
    await stuck(queue);
  });

  // An open thread on the stuck head, then a sweep re-evaluates it; returns the stored blocker.
  async function threadBlocker(name, yml) {
    const { fake, verified, queue } = await setup(name);
    fake.repos.get(name).files[".cinder.yml"] = yml;
    const a = await verified("main", [], {}, { head: "h1" });
    await stuck(queue);
    // The verify report stores the blocker itself, before the alarm its in_queue transition set has run. Wait for that
    // alarm to finish (nothing pending, the sweep re-armed): one still in flight would write a thread-less blocker last.
    await vi.waitFor(() => runInDurableObject(repoDO(name), async (i) => {
      expect(!(await i.ctx.storage.get("pending"))?.length && await i.ctx.storage.getAlarm() !== null).toBe(true);
    }), { timeout: 10_000 });
    await env.DB.prepare("INSERT INTO review_threads (id, change_id, outdated, created_at) VALUES (?, ?, 1, ?)").bind(crypto.randomUUID(), a.id, new Date().toISOString()).run();
    await runInDurableObject(repoDO(name), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; return i.ctx.storage.put({ pending: [], sweep_at: 0 }); });
    await runDurableObjectAlarm(repoDO(name));
    return (await queue("main"))[0].blocker;
  }

  it("an unresolved thread blocks the merge when the policy is on", async () => {
    expect(await threadBlocker("qe-thread-on", "branches:\n  integration: [main]\nreview:\n  require_resolved: true\n"))
      .toContain("1 unresolved review thread(s)");
  });

  it("with the policy off, threads never block", async () => {
    expect(await threadBlocker("qe-thread-off", "branches:\n  integration: [main]\n")).not.toContain("unresolved");
  });
});

describe("merge gate", () => {
  const mergeJob = (id) => env.DB.prepare("SELECT 1 FROM jobs WHERE kind = 'merge' AND status = 'queued' AND change_id = ?").bind(id).first();
  const blocker = (id) => env.DB.prepare("SELECT reason FROM queue_blockers WHERE change_id = ?").bind(id).first("reason");
  // A queued head whose merge job is dropped once `pushed` lands on it, then queued for merge again.
  const requeue = async (a, pushed) => {
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(a.id)).stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: a.id, result: "ok" }, pushed);
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'merge' AND change_id = ?").bind(a.id).run();
    await queueMergeJob(env, a.repo_id, a.target_branch);
  };

  it("a change without a clean guard result for its head is not queued for merge", async () => {
    const { verified } = await setup("mg-guard");
    const a = await verified("main", [], {}, { head: "h1", guard: { status: "clear", sha: "h0", at: new Date().toISOString() } });
    expect(await mergeJob(a.id)).toBeNull();
    expect(await blocker(a.id)).toContain("no guard result");
  });

  it("a queued change whose verdict is for an earlier head rebases and verifies again instead of waiting forever", async () => {
    const { verified } = await setup("mg-verdict");
    const a = await verified("main");
    expect(await mergeJob(a.id)).not.toBeNull();
    await requeue(a, { head: "h2", guard: { status: "clear", sha: "h2", at: new Date().toISOString() } });
    expect(await mergeJob(a.id)).toBeNull();
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(a.id)).get()).state).toBe("converging");
    // The RepoDO alarm may win the in_queue → converging transition; it then queues the converge job itself, a moment later.
    await vi.waitFor(async () => expect(await env.DB.prepare("SELECT 1 FROM jobs WHERE kind = 'converge' AND status = 'queued' AND change_id = ?").bind(a.id).first()).not.toBeNull(), { timeout: 10_000 });
  });

  it("a change missing a required approval is not queued for merge", async () => {
    const { verified } = await setup("mg-approval");
    const a = await verified("main");
    await requeue(a, { reviewers: [{ person: "alice" }] });
    expect(await mergeJob(a.id)).toBeNull();
    expect(await blocker(a.id)).toContain("waiting on alice");
  });
});

describe("conflict objects", () => {
  // b converges onto a's merge and conflicts.
  async function conflicted(name) {
    const s = await setup(name);
    const a = await s.verified("main");
    const b = await s.verified("main");
    const merge = await s.claim(["merge"]);
    await s.call(`/api/work/jobs/${merge.job.id}/report`, { status: "done" }, s.runner);
    // Earlier tests in this file leave converge jobs queued on other repos.
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'converge' AND repo_id <> ?").bind(b.repo_id).run();
    const converge = await s.claim(["converge"]);
    const conflict = { files: ["src/a.js"], hunks: [{ file: "src/a.js", ours: "x", theirs: "y" }] };
    const res = await (await s.call(`/api/work/jobs/${converge.job.id}/report`, { status: "failed", conflict }, s.runner)).json();
    expect(res.change.state).toBe("conflict");
    const list = () => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(b.id)).conflicts();
    return { a, b, list };
  }

  it("converge conflict creates an object naming the other change", async () => {
    const { a, b, list } = await conflicted("cf-create");
    const conflicts = await list();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ ours: b.id, theirs: [a.id], files: ["src/a.js"], status: "open", resolved_at: null });
    expect(conflicts[0].hunks).toEqual([{ file: "src/a.js", ours: "x", theirs: "y" }]);
    expect(validateConflictObject(conflicts[0])).toEqual({ ok: true, errors: [] });
  });

  it("resolved conflict keeps its history", async () => {
    const { b, list } = await conflicted("cf-resolve");
    const [open] = await list();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(b.id));
    for (const s of ["resolving", "verifying"]) await stub.transition(s, {
      kind: s, actor: { type: "system", id: "test" }, action: "job.report", target: b.id, result: "done",
    });
    const conflicts = await list();
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toEqual({ ...open, status: "resolved", resolved_at: expect.any(String) });
    expect(Date.parse(conflicts[0].resolved_at)).toBeGreaterThanOrEqual(Date.parse(open.detected_at));
    expect(validateConflictObject(conflicts[0])).toEqual({ ok: true, errors: [] });
  });
});

describe("speculative queue", () => {
  const cancelJobs = (name) => env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE repo_id = (SELECT id FROM repos WHERE name = ?) AND status IN ('queued', 'claimed')").bind(name).run();
  const pushed = (id, sha) => env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, ?)").bind(id, sha).run();

  it("queue of 3 issues verify jobs with 0, 1 and 2 heads ahead", async () => {
    const { call, runner, claim } = await setup("sq-ahead");
    const aheads = [];
    for (const sha of ["h1", "h2", "h3"]) {
      // A clean converge sends the change to verifying, which queues its verify job.
      const change = await (await call("/api/repos/sq-ahead/changes", { intent: sha, target_branch: "main" })).json();
      await pushed(change.id, sha);
      const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
      await stub.stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: change.id, result: "ok" }, { head: sha });
      for (const s of ["leased", "developing", "converging"]) await stub.transition(s, {
        kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: change.id, result: "ok",
      });
      await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'converge', ?, 'queued', ?, ?)")
        .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ target: "main", return_to: "verifying", theirs: [] })).run();
      const converge = await claim(["converge"]);
      expect((await (await call(`/api/work/jobs/${converge.job.id}/report`, { status: "done" }, runner)).json()).change.state).toBe("verifying");
      const verify = await claim(["verify"]);
      aheads.push(verify.payload.ahead.map((h) => h.head_sha));
      expect((await (await call(`/api/work/jobs/${verify.job.id}/report`, { status: "done" }, runner)).json()).change.state).toBe("in_queue");
    }
    expect(aheads).toEqual([[], ["h1"], ["h1", "h2"]]);
    // Jobs share one D1 across tests: drop the head's merge job so no other test claims it.
    await cancelJobs("sq-ahead");
  });

  it("failure of entry 1 re-verifies 2 and 3 only", async () => {
    const { call, runner, verified, claim } = await setup("sq-respec");
    const [a, b, c] = [await verified("main"), await verified("main"), await verified("main")];
    await pushed(a.id, "h1");
    await pushed(b.id, "h2");
    await pushed(c.id, "h3");
    const merge = await claim(["merge"]);
    expect(merge.change.id).toBe(a.id);
    await call(`/api/work/jobs/${merge.job.id}/report`, { status: "failed" }, runner);
    const { results } = await env.DB.prepare("SELECT change_id, payload FROM jobs WHERE kind = 'verify' AND status = 'queued' AND repo_id = ? ORDER BY created_at")
      .bind(a.repo_id).all();
    expect(results.map((r) => [r.change_id, JSON.parse(r.payload).ahead])).toEqual([
      [b.id, []],
      [c.id, [{ change_id: b.id, head_sha: "h2" }]],
    ]);
    for (const x of [b, c]) expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(x.id)).get()).events.at(-1)).toMatchObject({ kind: "respeculate", to_state: "converging" });
    await cancelJobs("sq-respec");
  });

  const stateOf = async (id) => (await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).state;
  const openJobs = (id, kind) => env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = ? AND status = 'queued' AND id NOT IN (SELECT job_id FROM job_cancels)")
    .bind(id, kind).all();

  it("a verify claim carries every lease granted on its target", async () => {
    const { call, claim } = await setup("q-leases");
    const change = await (await call("/api/repos/q-leases/changes", { intent: "x", target_branch: "main" })).json();
    await env.REPO_DO.get(env.REPO_DO.idFromName("q-leases")).grant("main", change.id, ["src/pay.js#retry"]);
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString()).run();
    expect((await claim(["verify"])).payload.leases).toEqual([{ symbol: "src/pay.js#retry", holder: change.id }]);
  });

  it("a merged change's merge commit subject starts with its key: the merge claim carries its key and title", async () => {
    const { verified, claim } = await setup("sq-key");
    const a = await verified("main");
    await pushed(a.id, "h1");
    expect((await claim(["merge"])).payload.batch).toMatchObject([{ change_id: a.id, key: "SQKEY-1", title: a.title }]);
  });

  it("three queued changes with passing speculative verifies merge in one batch, in order", async () => {
    const { call, runner, verified, claim } = await setup("sq-batch");
    const a = await verified("main");
    await pushed(a.id, "h1");
    const b = await verified("main", [{ change_id: a.id, head_sha: "h1" }]);
    await pushed(b.id, "h2");
    const c = await verified("main", [{ change_id: a.id, head_sha: "h1" }, { change_id: b.id, head_sha: "h2" }]);
    await pushed(c.id, "h3");
    const merge = await claim(["merge"]);
    expect(merge.payload.batch).toMatchObject([a, b, c].map((x) => ({ change_id: x.id, tree: treeOf(x.id), base: BASE, remote: expect.any(String), token: expect.any(String) })));
    expect((await (await call(`/api/work/jobs/${merge.job.id}/report`, { status: "done" }, runner)).json()).change.state).toBe("merged");
    for (const x of [a, b, c]) expect(await stateOf(x.id)).toBe("merged");
    expect(await claim(["merge"])).toBeNull();
  });

  it("when the second of three fails, the third is re-verified without it and the first still merges", async () => {
    const { call, runner, verified, claim } = await setup("sq-eject");
    // x heads the queue; its refused merge re-speculates a, b and c as a chain: [], [a], [a, b].
    const x = await verified("main");
    const [a, b, c] = [await verified("main"), await verified("main"), await verified("main")];
    for (const [y, sha] of [[x, "h0"], [a, "h1"], [b, "h2"], [c, "h3"]]) await pushed(y.id, sha);
    const refused = await claim(["merge"]);
    expect(refused.change.id).toBe(x.id);
    await call(`/api/work/jobs/${refused.job.id}/report`, { status: "failed" }, runner);
    const verifyA = await claim(["verify"]);
    expect(verifyA.change.id).toBe(a.id);
    expect((await (await call(`/api/work/jobs/${verifyA.job.id}/report`, { status: "done", tree: treeOf(a.id) }, runner)).json()).change.state).toBe("in_queue");
    const verifyB = await claim(["verify"]);
    expect(verifyB.change.id).toBe(b.id);
    expect((await (await call(`/api/work/jobs/${verifyB.job.id}/report`, { status: "failed" }, runner)).json()).change.state).toBe("needs_fix");
    const verifyC = await claim(["verify"]);
    expect(verifyC.change.id).toBe(c.id);
    // x keeps its place while it rebases, so c speculates on it too.
    expect(verifyC.payload.ahead.map((h) => h.head_sha)).toEqual(["h0", "h1"]);
    const merge = await claim(["merge"]);
    expect(merge.payload.batch.map((e) => e.change_id)).toEqual([a.id]);
    await call(`/api/work/jobs/${merge.job.id}/report`, { status: "done" }, runner);
    expect(await stateOf(a.id)).toBe("merged");
    expect(await stateOf(b.id)).not.toBe("merged");
    await cancelJobs("sq-eject");
  });

  it("a clean rebase onto a moved target re-verifies before it can merge", async () => {
    const { call, runner, verified, claim } = await setup("sq-rebase");
    const a = await verified("main");
    const b = await verified("main");
    const first = await claim(["merge"]);
    expect(first.change.id).toBe(a.id);
    await call(`/api/work/jobs/${first.job.id}/report`, { status: "done" }, runner);
    const converge = await claim(["converge"]);
    expect(converge.change.id).toBe(b.id);
    expect((await (await call(`/api/work/jobs/${converge.job.id}/report`, { status: "done" }, runner)).json()).change.state).toBe("verifying");
    expect(await claim(["merge"])).toBeNull();
    expect((await openJobs(b.id, "verify")).results).toHaveLength(1);
    await cancelJobs("sq-rebase");
  });

  it("a refused merge leaves the change with a queued converge job", async () => {
    const { fake, call, runner, verified, claim } = await setup("sq-refused");
    const a = await verified("main");
    const merge = await claim(["merge"]);
    await call(`/api/work/jobs/${merge.job.id}/report`, { status: "failed" }, runner);
    expect(await stateOf(a.id)).toBe("converging");
    expect((await openJobs(a.id, "converge")).results.map((j) => JSON.parse(j.payload))).toEqual([{ target: "main", return_to: "verifying", theirs: [] }]);
    // Refused at claim: the target moved under the head.
    const b = await verified("main");
    fake.repos.get("sq-refused").commits.unshift({ sha: "t2" });
    expect(await claim(["merge"])).toBeNull();
    expect(await stateOf(b.id)).toBe("converging");
    expect((await openJobs(b.id, "converge")).results).toHaveLength(1);
    await cancelJobs("sq-refused");
  });
});

describe("queue never stalls", () => {
  const stub = (id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
  const cancelJobs = (name) => env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE repo_id = (SELECT id FROM repos WHERE name = ?) AND status IN ('queued', 'claimed')").bind(name).run();
  const order = (repoId) => env.DB.prepare("SELECT change_id FROM queue_entries WHERE repo_id = ? ORDER BY seq").bind(repoId).all().then((r) => r.results.map((e) => e.change_id));

  it("B stacked on A queued before A: A merges, then B", async () => {
    const { call, runner, verified, claim } = await setup("qs-stack");
    const b = await verified("main");
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'merge' AND change_id = ?").bind(b.id).run();
    // A, which B is stacked on, verifies and queues after B.
    const a = await (await call("/api/repos/qs-stack/changes", { intent: "a", target_branch: "main" })).json();
    await runInDurableObject(stub(b.id), async (i) => i.ctx.storage.put("change", { ...await i.ctx.storage.get("change"), stacked_on: a.id }));
    for (const s of ["leased", "developing", "verifying"]) await stub(a.id).transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: a.id, result: "ok" });
    const at = new Date().toISOString();
    await stub(a.id).stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: a.id, result: "ok" }, { head: "h1", guard: { status: "clear", sha: "h1", at } });
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')").bind(crypto.randomUUID(), a.repo_id, a.id, at).run();
    const verify = await claim(["verify"]);
    expect((await (await call(`/api/work/jobs/${verify.job.id}/report`, { status: "done", tree: treeOf(a.id), base: BASE }, runner)).json()).change.state).toBe("in_queue");
    expect(await order(a.repo_id)).toEqual([a.id, b.id]);
    const first = await claim(["merge"]);
    expect(first.change.id).toBe(a.id);
    expect((await (await call(`/api/work/jobs/${first.job.id}/report`, { status: "done" }, runner)).json()).change.state).toBe("merged");
    // B rebases onto the merged A, re-verifies in its place and merges next.
    for (const kind of ["converge", "verify"]) {
      const job = await claim([kind]);
      expect(job.change.id).toBe(b.id);
      await call(`/api/work/jobs/${job.job.id}/report`, { status: "done", tree: treeOf(b.id), base: BASE }, runner);
    }
    expect((await claim(["merge"])).change.id).toBe(b.id);
    await cancelJobs("qs-stack");
  });

  it("a respeculated change whose verify passes with auto_queue off leaves converging", async () => {
    const { call, runner, verified, claim } = await setup("qs-converging");
    const [a, b] = [await verified("main"), await verified("main")];
    await env.DB.prepare("INSERT OR REPLACE INTO change_views (change_id, auto_queue) VALUES (?, 0)").bind(b.id).run();
    const merge = await claim(["merge"]);
    expect(merge.change.id).toBe(a.id);
    await call(`/api/work/jobs/${merge.job.id}/report`, { status: "failed" }, runner);
    expect((await stub(b.id).get()).state).toBe("converging");
    const verify = await claim(["verify"]);
    expect(verify.change.id).toBe(b.id);
    expect((await (await call(`/api/work/jobs/${verify.job.id}/report`, { status: "done", tree: treeOf(b.id), base: BASE }, runner)).json()).change.state).toBe("verifying");
    await cancelJobs("qs-converging");
  });

  it("a head refused with base_moved keeps its queue position", async () => {
    const { fake, call, runner, verified, claim } = await setup("qs-place");
    const [a, b] = [await verified("main"), await verified("main")];
    fake.repos.get("qs-place").commits.unshift({ sha: "t2" });
    expect(await claim(["merge"])).toBeNull();
    expect((await stub(a.id).get()).events.at(-1)).toMatchObject({ kind: "base_moved", to_state: "converging" });
    expect(await order(a.repo_id)).toEqual([a.id, b.id]);
    // Rebased, it re-verifies on nothing ahead: the change behind it is not ahead of it.
    const converge = await claim(["converge"]);
    expect(converge.change.id).toBe(a.id);
    await call(`/api/work/jobs/${converge.job.id}/report`, { status: "done" }, runner);
    const verify = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'verify' AND status = 'queued'").bind(a.id).first("payload");
    expect(JSON.parse(verify).ahead).toEqual([]);
    await cancelJobs("qs-place");
  });

  it("a queued head with no head sha leaves the queue and the change behind it gets a merge job", async () => {
    const { call, runner, verified, claim } = await setup("qs-headless");
    const a = await verified("main");
    const b = await verified("main", [{ change_id: a.id, head_sha: "h1" }]);
    // a loses its head (the live stuck entry: verdict for null, head undefined).
    await runInDurableObject(stub(a.id), async (i) => {
      const change = await i.ctx.storage.get("change");
      delete change.head;
      await i.ctx.storage.put("change", { ...change, verdict: { sha: null, status: "pass", at: new Date().toISOString() } });
    });
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'merge' AND change_id = ?").bind(a.id).run();
    await queueMergeJob(env, a.repo_id, "main");
    expect((await stub(a.id).get()).state).toBe("needs_fix");
    expect(await order(a.repo_id)).toEqual([b.id]);
    // b re-verifies without a ahead, then merges.
    const verify = await claim(["verify"]);
    expect(verify.change.id).toBe(b.id);
    await call(`/api/work/jobs/${verify.job.id}/report`, { status: "done", tree: treeOf(b.id), base: BASE }, runner);
    expect((await claim(["merge"])).change.id).toBe(b.id);
    await cancelJobs("qs-headless");
  });

  it("an alarm whose queueMergeJob throws once still queues the merge job on the retry", async () => {
    const { verified } = await setup("qs-alarm");
    const a = await verified("main");
    const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName("qs-alarm"));
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = 'merge' AND change_id = ?").bind(a.id).run();
    await runInDurableObject(repoDO, async (i) => {
      const db = i.env.DB;
      let down = true;
      i.env = { ...i.env, DB: { prepare: (q) => { if (down) { down = false; throw new Error("D1 unavailable"); } return db.prepare(q); }, batch: (b) => db.batch(b) } };
      await i.ctx.storage.put({ repo_id: a.repo_id, pending: ["main"], sweep_at: Date.now() + 60_000 });
      await i.ctx.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(repoDO).catch(() => {});
    await vi.waitFor(async () => {
      await runDurableObjectAlarm(repoDO).catch(() => {});
      expect(await env.DB.prepare("SELECT 1 FROM jobs WHERE kind = 'merge' AND status = 'queued' AND change_id = ?").bind(a.id).first()).toBeTruthy();
    }, { timeout: 5_000 });
    await cancelJobs("qs-alarm");
  });
});

describe("post-merge converge scope", () => {
  const stateOf = async (id) => (await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).state;
  const convergeOf = (id) => env.DB.prepare("SELECT id, payload FROM jobs WHERE change_id = ? AND kind = 'converge' AND status = 'queued'").bind(id).first();
  const wrote = (id, symbol) => env.DB.prepare("INSERT INTO change_writes VALUES (?, ?, 'body')").bind(id, symbol).run();
  // Other tests' repos keep queued jobs (their queue alarms re-queue merges after a cancel); only repoId's are claimable.
  const claimOwn = async (s, repoId, kind) => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE kind = ? AND status = 'queued' AND repo_id <> ?").bind(kind, repoId).run();
    return s.claim([kind]);
  };
  // m merges having written symbol A (with kind); the target gains its commit.
  async function merge(s, m, name) {
    const job = await claimOwn(s, m.repo_id, "merge");
    expect(job.change.id).toBe(m.id);
    s.fake.repos.get(name).commits.unshift({ sha: "t2" });
    expect((await (await s.call(`/api/work/jobs/${job.job.id}/report`, { status: "done" }, s.runner)).json()).change.state).toBe("merged");
  }

  it("a merge touching symbol A converges the change that writes A and not a change that only touches B", async () => {
    const s = await setup("cs-writes");
    const m = await s.verified("main", [], { writes: [{ symbol: "a.js#A", kind: "body" }] });
    const a = await s.verified("main");
    const b = await s.verified("main");
    await wrote(a.id, "a.js#A");
    await wrote(b.id, "b.js#B");
    await merge(s, m, "cs-writes");
    expect(await stateOf(a.id)).toBe("converging");
    expect(JSON.parse((await convergeOf(a.id)).payload)).toMatchObject({ theirs: [{ id: m.id }], symbols: ["a.js#A"] });
    expect(await stateOf(b.id)).toBe("in_queue");
    expect(await convergeOf(b.id)).toBeNull();
    expect(await env.DB.prepare("SELECT 1 AS behind FROM change_behind WHERE change_id = ?").bind(b.id).first()).toEqual({ behind: 1 });
    await s.call("/api/repos/cs-writes/jobs/cancel");
  });

  it("a change reading a symbol whose signature changed in the merge is converged", async () => {
    const s = await setup("cs-reads");
    const m = await s.verified("main", [], { writes: [{ symbol: "a.js#A", kind: "signature" }] });
    const r = await s.verified("main", [], { writes: [], reads: ["a.js#A"] });
    const other = await s.verified("main", [], { writes: [], reads: ["b.js#B"] });
    await merge(s, m, "cs-reads");
    expect(await stateOf(r.id)).toBe("converging");
    expect(JSON.parse((await convergeOf(r.id)).payload).symbols).toEqual(["a.js#A"]);
    expect(await stateOf(other.id)).toBe("in_queue");
    await s.call("/api/repos/cs-reads/jobs/cancel");
  });

  it("a converge conflict hands the resolver the conflicting symbols and both intents", async () => {
    const s = await setup("cs-resolve");
    const m = await s.verified("main", [], { writes: [{ symbol: "a.js#A", kind: "body" }] });
    const a = await s.verified("main");
    await wrote(a.id, "a.js#A");
    await merge(s, m, "cs-resolve");
    const { id } = await convergeOf(a.id);
    expect((await claimOwn(s, a.repo_id, "converge")).job.id).toBe(id);
    const conflict = { files: ["a.js"], hunks: [{ file: "a.js" }] };
    expect((await (await s.call(`/api/work/jobs/${id}/report`, { status: "failed", conflict }, s.runner)).json()).change.state).toBe("conflict");
    const { payload } = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'resolve'").bind(a.id).first();
    expect(JSON.parse(payload)).toMatchObject({ intent: a.intent, theirs: [{ id: m.id, intent: m.intent }], symbols: ["a.js#A"] });
    await s.call("/api/repos/cs-resolve/jobs/cancel");
  });

  it("a behind change rebases when it reaches the queue head", async () => {
    const s = await setup("cs-head");
    const m = await s.verified("main", [], { writes: [{ symbol: "a.js#A", kind: "body" }] });
    const b = await s.verified("main");
    await wrote(b.id, "b.js#B");
    await merge(s, m, "cs-head");
    expect(await stateOf(b.id)).toBe("in_queue");
    expect(await convergeOf(b.id)).toBeNull();
    // b is now the head: its merge claim finds the target moved and rebases it instead.
    expect(await claimOwn(s, b.repo_id, "merge")).toBeNull();
    expect(await stateOf(b.id)).toBe("converging");
    const converge = await claimOwn(s, b.repo_id, "converge");
    expect(converge.change.id).toBe(b.id);
    expect((await (await s.call(`/api/work/jobs/${converge.job.id}/report`, { status: "done" }, s.runner)).json()).change.state).toBe("verifying");
    expect(await env.DB.prepare("SELECT 1 FROM change_behind WHERE change_id = ?").bind(b.id).first()).toBeNull();
    await s.call("/api/repos/cs-head/jobs/cancel");
  });

  it("a behind change converges when its next push lands", async () => {
    const s = await setup("cs-push");
    const change = await (await s.call("/api/repos/cs-push/changes", { intent: "x", target_branch: "main" })).json();
    for (const st of ["leased", "developing"]) await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).transition(st, {
      kind: st, actor: { type: "system", id: "test" }, action: "change.lease", target: change.id, result: "ok",
    });
    await env.DB.prepare("INSERT INTO change_behind (change_id) VALUES (?)").bind(change.id).run();
    const dev = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, '{}')")
      .bind(dev, change.repo_id, change.id, new Date().toISOString()).run();
    const runner = (await (await s.call("/api/runners", { name: "dev", kinds: ["develop"] })).json()).token;
    expect((await (await s.call("/api/work/claim", { kinds: ["develop"] }, runner)).json()).job.id).toBe(dev);
    expect((await (await s.call(`/api/work/jobs/${dev}/report`, { status: "done" }, runner)).json()).change.state).toBe("converging");
    expect(JSON.parse((await convergeOf(change.id)).payload)).toMatchObject({ target: "main", return_to: "verifying" });
    await s.call("/api/repos/cs-push/jobs/cancel");
  });
});
