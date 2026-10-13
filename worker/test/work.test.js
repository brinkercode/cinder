import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { validateJob } from "../src/api/contract.js";
import worker from "../src/index.js";
import { collisionQuestion, recordJudgment } from "../src/judgments.js";
import { predictLease } from "../src/lease.js";
import { mergeBlockers } from "../src/queue.js";
import { agentsFake } from "./fakes/agents-repo.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

async function setup(name, intent = "x", fake = fakeArtifacts()) {
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent })).json();
  // Creating the change leased it and queued a develop job; each test queues its own jobs.
  await env.DB.prepare("DELETE FROM jobs WHERE change_id = ?").bind(change.id).run();
  // Earlier tests' reports leave verify and resolve jobs queued on other repos.
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
  const runner = async (slots) => (await (await call("/api/runners", { name: "lab", kinds: ["develop", "verify"], slots })).json()).token;
  const addJob = async (kind, priority = 0) => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, ?, ?, 'queued', ?, '{}')")
      .bind(id, change.repo_id, kind, change.id, new Date().toISOString()).run();
    if (priority) await env.DB.prepare("INSERT INTO job_priorities (job_id, priority) VALUES (?, ?)").bind(id, priority).run();
    return id;
  };
  return { fake, call, change, runner, addJob };
}

// A repo with .cinder.yml wiki.context on, a billing and a deploy page, and a develop claim for a billing intent.
async function wikiClaim(name) {
  const { fake, call, change, runner, addJob } = await setup(name, "round billing totals to the cent");
  Object.assign(fake.repos.get(name), { files: { ".cinder.yml": "wiki:\n  context: true\n" }, commits: [{ sha: "c1" }] });
  const page = (id, title, content) => env.DB.prepare("INSERT INTO wiki_pages (id, repo_id, title, slug, content, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '', '')")
    .bind(id, change.repo_id, title, id, content).run();
  await page(`${name}-billing`, "Billing", "Invoices round billing totals half-up.");
  await page(`${name}-deploy`, "Deploy", "Deploys go through staging.");
  await addJob("develop");
  const claim = await (await call("/api/work/claim", { kinds: ["develop"] }, await runner())).json();
  return { claim, call, change };
}

describe("work api", () => {
  it("an intent mentioning billing gets the billing page in its claim payload", async () => {
    const { claim } = await wikiClaim("work-wiki");
    expect(claim.payload.wiki).toEqual([{
      id: "work-wiki-billing", title: "Billing", content: "Invoices round billing totals half-up.", sha: expect.stringMatching(/^[0-9a-f]{40}$/),
    }]);
  });

  it("provenance lists the wiki page and its sha", async () => {
    const { claim, call, change } = await wikiClaim("work-wiki-prov");
    // git hash-object of the page's content.
    const sha = "40beb2973b43ab717dfe58a8aad820093d4429da";
    expect(claim.payload.wiki[0].sha).toBe(sha);
    expect((await call(`/api/changes/${change.id}/close`)).status).toBe(200);
    const token = (await (await call("/api/runners", { name: "lab", kinds: ["history"] })).json()).token;
    const history = await (await call("/api/work/claim", { kinds: ["history"] }, token)).json();
    expect(JSON.parse(history.payload.files["wiki.json"])).toEqual([{ id: "work-wiki-prov-billing", title: "Billing", sha }]);
  });


  it("develop job tokens never include target write", async () => {
    const { fake, call, change, runner, addJob } = await setup("work-tok");
    const id = await addJob("develop");
    const res = await call("/api/work/claim", { kinds: ["develop"], slots_free: 1 }, await runner());
    expect(res.status).toBe(200);
    const claim = await res.json();
    expect(validateJob(claim.job)).toEqual({ ok: true, errors: [] });
    expect(claim).toMatchObject({ job: { id, status: "claimed" }, change: { id: change.id, state: "developing" } });
    const tokens = fake.calls.filter((c) => c.method === "createToken" && c.args[0] !== "cinder-agents").map((c) => c.args);
    expect(tokens).toEqual([[change.fork, "write", 600], ["work-tok", "read", 600]]);
    expect(tokens).not.toContainEqual(["work-tok", "write", expect.anything()]);
  });

  it("a develop claim's fork token lasts at most 600 seconds", async () => {
    const { fake, call, change, runner, addJob } = await setup("work-ttl");
    await addJob("develop");
    expect((await call("/api/work/claim", { kinds: ["develop"] }, await runner())).status).toBe(200);
    const ttls = fake.calls.filter((c) => c.method === "createToken" && c.args[0] === change.fork).map((c) => c.args[2]);
    expect(ttls).toHaveLength(1);
    expect(ttls[0]).toBeLessThanOrEqual(600);
  });

  it("a heartbeat returns a fresh fork token", async () => {
    const { fake, call, change, runner, addJob } = await setup("work-beat-tok");
    const id = await addJob("develop");
    const token = await runner();
    const claim = await (await call("/api/work/claim", { kinds: ["develop"] }, token)).json();
    const before = fake.calls.length;
    const beat = await (await call(`/api/work/jobs/${id}/heartbeat`, null, token)).json();
    expect(beat).toMatchObject({ cancel: false, token: expect.any(String), read_token: expect.any(String) });
    expect(beat.token).not.toBe(claim.token);
    expect(fake.calls.slice(before).filter((c) => c.method === "createToken").map((c) => c.args)).toEqual([[change.fork, "write", 600], ["work-beat-tok", "read", 600]]);
  });

  it("a develop job reported failed with a reason stores it and the change detail returns it", async () => {
    const { call, change, runner, addJob } = await setup("work-dev-fail");
    const id = await addJob("develop");
    const token = await runner();
    await call("/api/work/claim", { kinds: ["develop"] }, token);
    const detail = "claude: output is not JSON: exec: \"claude\": executable file not found in $PATH";
    expect((await call(`/api/work/jobs/${id}/report`, { status: "failed", detail }, token)).status).toBe(200);
    const res = await worker.fetch(new Request(`http://cinder.test/api/changes/${change.id}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    const got = await res.json();
    expect(got.events.at(-1)).toMatchObject({ kind: "develop_failed", to_state: "failed", reason: detail });
    expect(got.failure).toEqual({ stage: "develop", reason: detail });
  });

  it("a failed verify's reason is its check output, without the Fetch change and Check leases steps", async () => {
    const { call, change, runner, addJob } = await setup("work-verify-steps");
    for (const st of ["leased", "developing", "verifying"]) await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).transition(st, {
      kind: st, actor: { type: "system", id: "test" }, action: "change.lease", target: change.id, result: "ok" });
    const id = await addJob("verify");
    const token = await runner();
    await call("/api/work/claim", { kinds: ["verify"] }, token);
    const detail = "##[group]Fetch change\nFetching h1 against main @ 9f2c1e4\n a.js | 2 +-\n##[endgroup]\n##[group]Check leases\nLease a.js · none\n##[endgroup]\n2 tests failed\n";
    expect((await call(`/api/work/jobs/${id}/report`, { status: "failed", detail }, token)).status).toBe(200);
    const got = await (await worker.fetch(new Request(`http://cinder.test/api/changes/${change.id}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env)).json();
    expect(got.events.find((e) => e.kind === "verify_failed")).toMatchObject({ reason: "2 tests failed" });
  });

  it("expired lease is claimable again", async () => {
    const { call, runner, addJob } = await setup("work-exp");
    const id = await addJob("develop");
    const [a, b] = [await runner(), await runner()];
    expect((await call("/api/work/claim", {}, a)).status).toBe(200);
    expect((await call("/api/work/claim", {}, b)).status).toBe(204);
    await env.DB.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ?").bind(new Date(Date.now() - 1000).toISOString(), id).run();
    const res = await call("/api/work/claim", {}, b);
    expect(res.status).toBe(200);
    expect((await res.json()).job.id).toBe(id);
    expect((await call(`/api/work/jobs/${id}/heartbeat`, null, a)).status).toBe(403);
  });

  it("report from another runner → 409 lease_lost; a second report → 409 already_reported", async () => {
    const { call, runner, addJob } = await setup("work-403");
    const id = await addJob("develop");
    const [a, b] = [await runner(), await runner()];
    expect((await call("/api/work/claim", {}, a)).status).toBe(200);
    const lost = await call(`/api/work/jobs/${id}/report`, { status: "done" }, b);
    expect([lost.status, (await lost.json()).error.code]).toEqual([409, "lease_lost"]);
    expect((await call(`/api/work/jobs/${id}/report`, { status: "done" }, a)).status).toBe(200);
    const again = await call(`/api/work/jobs/${id}/report`, { status: "done" }, a);
    expect([again.status, (await again.json()).error.code]).toEqual([409, "already_reported"]);
  });

  it("answers 409 with a reason code when a report arrives for a change that has moved on", async () => {
    const { call, change, runner, addJob } = await setup("work-moved");
    const id = await addJob("develop");
    const token = await runner();
    expect((await call("/api/work/claim", {}, token)).status).toBe(200);
    expect((await call(`/api/changes/${change.id}/close`)).status).toBe(200);
    const res = await call(`/api/work/jobs/${id}/report`, { status: "done" }, token);
    expect([res.status, (await res.json()).error.code]).toEqual([409, "change_moved"]);
  });

  it("after a 409 the job is not left in claimed", async () => {
    const { call, change, runner, addJob } = await setup("work-409-release");
    const id = await addJob("develop");
    const token = await runner();
    expect((await call("/api/work/claim", {}, token)).status).toBe(200);
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).moveHead("abc123");
    expect((await call(`/api/work/jobs/${id}/report`, { status: "done" }, token)).status).toBe(409);
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(id).first()).status).not.toBe("claimed");
  });

  it("refuses a symbols upload from a runner holding no index job of that repo", async () => {
    const { fake, call, addJob } = await setup("work-sym");
    expect((await call("/api/repos", { name: "work-sym-other" })).status).toBe(201);
    await addJob("index");
    const token = (await (await call("/api/runners", { name: "lab", kinds: ["index"] })).json()).token;
    const put = (repo) => worker.fetch(new Request(`http://cinder.test/api/work/repos/${repo}/symbols/h1`,
      { method: "PUT", headers: { Authorization: `Bearer ${token}` }, body: "[]" }), { ...env, ARTIFACTS: fake });
    expect((await put("work-sym")).status).toBe(403);
    expect((await call("/api/work/claim", { kinds: ["index"] }, token)).status).toBe(200);
    expect((await put("work-sym-other")).status).toBe(403);
    expect((await put("work-sym")).status).toBe(204);
  });

  it("refuses a second claim from a runner whose one slot holds a live lease", async () => {
    const { call, runner, addJob } = await setup("work-slots");
    await addJob("develop");
    const second = await addJob("develop");
    const token = await runner();
    expect((await call("/api/work/claim", { slots_free: 1 }, token)).status).toBe(200);
    expect((await call("/api/work/claim", { slots_free: 1 }, token)).status).toBe(204);
    expect((await call("/api/work/claim", { slots_free: 2 }, token)).status).toBe(204);
    expect((await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(second).first()).status).toBe("queued");
  });

  it("20 parallel claims against 20 jobs return 20 distinct jobs", async () => {
    const { call, runner, addJob } = await setup("work-par");
    const ids = [];
    const tokens = [];
    for (let i = 0; i < 20; i++) {
      ids.push(await addJob("verify"));
      tokens.push(await runner());
    }
    const res = await Promise.all(tokens.map((t) => call("/api/work/claim", { kinds: ["verify"] }, t)));
    expect(res.map((r) => r.status)).toEqual(Array(20).fill(200));
    const claimed = await Promise.all(res.map(async (r) => (await r.json()).job.id));
    expect(new Set(claimed).size).toBe(20);
    expect([...claimed].sort()).toEqual([...ids].sort());
  });

  it("a job's claim and report events name the runner that ran it", async () => {
    const { call, change, runner, addJob } = await setup("work-actor-name");
    await addJob("develop");
    const token = await runner();
    const job = (await (await call("/api/work/claim", { kinds: ["develop"] }, token)).json()).job.id;
    expect((await call(`/api/work/jobs/${job}/report`, { status: "done" }, token)).status).toBe(200);
    const res = await worker.fetch(new Request(`http://cinder.test/api/changes/${change.id}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    const ran = (await res.json()).events.filter((e) => e.actor.runner);
    expect(ran.map((e) => [e.kind, e.actor.name])).toEqual([["claimed", "lab"], ["develop_done", "lab"]]);
  });

  it("higher priority job is claimed first", async () => {
    const { call, runner, addJob } = await setup("work-pri");
    const low = await addJob("verify", 0);
    const high = await addJob("verify", 5);
    const token = await runner(2);
    expect((await (await call("/api/work/claim", { kinds: ["verify"], slots_free: 2 }, token)).json()).job.id).toBe(high);
    expect((await (await call("/api/work/claim", { kinds: ["verify"], slots_free: 2 }, token)).json()).job.id).toBe(low);
  });

  it("a gate job is claimed before an older develop job of the same priority", async () => {
    const { call, runner, addJob } = await setup("work-gate");
    await addJob("develop");
    const verify = await addJob("verify");
    const token = await runner(2);
    expect((await (await call("/api/work/claim", { kinds: ["develop", "verify"], slots_free: 2 }, token)).json()).job.id).toBe(verify);
  });

  it("third verify failure → failed", async () => {
    const { call, runner, addJob } = await setup("work-3x");
    const token = await runner();
    const states = [];
    for (let i = 0; i < 3; i++) {
      // After the first failure the change queues its own repair job.
      if (i === 0) await addJob("develop");
      const dev = (await (await call("/api/work/claim", { kinds: ["develop"] }, token)).json()).job.id;
      expect((await (await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token)).json()).change.state).toBe("verifying");
      const verify = (await (await call("/api/work/claim", { kinds: ["verify"] }, token)).json()).job.id;
      const res = await call(`/api/work/jobs/${verify}/report`, { status: "failed" }, token);
      states.push((await res.json()).change.state);
    }
    expect(states).toEqual(["needs_fix", "needs_fix", "failed"]);
  });

  it("head move marks the running develop job cancel_requested", async () => {
    const { call, change, runner, addJob } = await setup("work-head");
    const id = await addJob("develop");
    const token = await runner();
    expect((await call("/api/work/claim", {}, token)).status).toBe(200);
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).moveHead("abc123");
    expect(await env.DB.prepare("SELECT job_id FROM job_cancels WHERE job_id = ?").bind(id).first()).toEqual({ job_id: id });
    expect(await (await call(`/api/work/jobs/${id}/heartbeat`, null, token)).json()).toMatchObject({ cancel: true });
  });

  it("refuses a report from a cancelled job", async () => {
    const { call, change, runner, addJob } = await setup("work-cancel");
    const id = await addJob("develop");
    const token = await runner();
    expect((await call("/api/work/claim", {}, token)).status).toBe(200);
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).moveHead("abc123");
    expect((await call(`/api/work/jobs/${id}/report`, { status: "done" }, token)).status).toBe(409);
    expect((await call(`/api/work/jobs/${id}/report`, { status: "cancelled" }, token)).status).toBe(409);
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).get()).state).toBe("developing");
  });

  it("events.jsonl ordered: closing a change queues a history job with its events in order", async () => {
    const { fake, call, change } = await setup("work-hist");
    expect((await call(`/api/changes/${change.id}/close`)).status).toBe(200);
    const token = (await (await call("/api/runners", { name: "lab", kinds: ["history"] })).json()).token;
    const claim = await (await call("/api/work/claim", { kinds: ["history"] }, token)).json();
    expect(claim.payload.ref).toBe(`refs/cinder/changes/${change.id}`);
    const events = claim.payload.files["events.jsonl"].trimEnd().split("\n").map((l) => JSON.parse(l));
    expect(events.map((e) => e.kind)).toEqual(["created", "leased", "closed"]);
    expect(claim.payload.files["intent.md"]).toBe("x");
    expect(fake.calls.at(-1)).toEqual({ method: "createToken", args: ["work-hist", "write", 600] });
  });

  it("claim lock carries the version's token limits", async () => {
    await env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
      "VALUES ('agent/capped/v1', 'capped', 1, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{\"max_tokens\":5000,\"max_tokens_month\":90000}')").run();
    // This month's runs count toward max_tokens_month; last month's don't.
    const now = new Date();
    const lastMonth = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 15)).toISOString();
    await env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, agent_version, tokens, cost_usd) VALUES ('cap-1', 'r', ?, 'capped@v1', 1200, 0), ('cap-2', 'r', ?, 'capped@v1', 700, 0)")
      .bind(now.toISOString(), lastMonth).run();
    const { call, change, runner } = await setup("work-token-limits");
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), change.repo_id, change.id, now.toISOString(), JSON.stringify({ agent: "capped@v1" })).run();
    const claim = await (await call("/api/work/claim", { kinds: ["develop"] }, await runner())).json();
    // Later tests claim on a fresh deploy (no agent versions) and under the monthly budget.
    await env.DB.batch([env.DB.prepare("DELETE FROM agent_versions WHERE id = 'agent/capped/v1'"), env.DB.prepare("DELETE FROM usage_logs WHERE id IN ('cap-1', 'cap-2')")]);
    expect(claim.agent.limits).toMatchObject({ max_tokens: 5000, max_tokens_month: 90000, tokens_month: 1200 });
  });

  it("blocker report moves change to needs_fix", async () => {
    const { call, change, runner, addJob } = await setup("work-review-fix");
    const token = await runner();
    const dev = await addJob("develop");
    expect((await call("/api/work/claim", { kinds: ["develop"] }, token)).status).toBe(200);
    expect((await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token)).status).toBe(200);
    const reviewer = (await (await call("/api/runners", { name: "rev", kinds: ["review"] })).json()).token;
    const id = await addJob("review");
    expect((await call("/api/work/claim", { kinds: ["review"] }, reviewer)).status).toBe(200);
    expect((await call(`/api/work/jobs/${id}/report`, { status: "failed", blockers: [{ summary: "drops lease", repro: "" }] }, reviewer)).status).toBe(400);
    const res = await call(`/api/work/jobs/${id}/report`, { status: "failed", blockers: [{ summary: "drops lease", repro: "npx vitest run -t lease" }] }, reviewer);
    expect((await res.json()).change.state).toBe("needs_fix");
    const { events } = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).get();
    expect(events.at(-2)).toMatchObject({ kind: "review_failed", to_state: "needs_fix", reason: "drops lease (repro: npx vitest run -t lease)" });
  });

  const openJobs = async (change, kind) => (await env.DB.prepare("SELECT id FROM jobs WHERE change_id = ? AND kind = ? AND status IN ('queued', 'claimed')")
    .bind(change.id, kind).all()).results;

  it("a develop job reported done queues a verify job and the change is verifying", async () => {
    const { call, change, runner, addJob } = await setup("work-q-verify");
    const token = await runner();
    const dev = await addJob("develop");
    expect((await call("/api/work/claim", { kinds: ["develop"] }, token)).status).toBe(200);
    expect((await (await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token)).json()).change.state).toBe("verifying");
    expect(await openJobs(change, "verify")).toHaveLength(1);
    const claim = await (await call("/api/work/claim", { kinds: ["verify"] }, token)).json();
    expect(claim).toMatchObject({ job: { kind: "verify", change_id: change.id }, token: expect.any(String), read_token: expect.any(String) });
  });

  it("a verify job reported done moves the change to in_queue and queues the merge job", async () => {
    const { call, change, runner, addJob } = await setup("work-q-merge");
    const token = await runner();
    const dev = await addJob("develop");
    await call("/api/work/claim", { kinds: ["develop"] }, token);
    await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token);
    // The develop push: a head with a clean guard result.
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: change.id, result: "ok" }, { head: "h1", guard: { status: "clear", sha: "h1", at: new Date().toISOString() } });
    const verify = (await (await call("/api/work/claim", { kinds: ["verify"] }, token)).json()).job.id;
    expect((await (await call(`/api/work/jobs/${verify}/report`, { status: "done" }, token)).json()).change.state).toBe("in_queue");
    expect(await openJobs(change, "merge")).toHaveLength(1);
  });

  it("an approval given while the verify report is being routed queues the change", async () => {
    const { fake, call, change, runner, addJob } = await setup("work-early-approve");
    await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'risk', 'clef', 'clef@1')").bind(change.repo_id).run();
    // The person approves while the report waits on the risk judge: after the report read the change, before it routed.
    let approved = null;
    const AI = fakeClefAI(async () => {
      approved ??= (await call(`/api/changes/${change.id}/review`, { verdict: "approve", body: "" })).status;
      return { risk: { low: 0.9, medium: 0.05, high: 0.05 } };
    });
    const report = (id, token) => worker.fetch(new Request(`http://cinder.test/api/work/jobs/${id}/report`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: "done" }) }), { ...env, ARTIFACTS: fake, AI });
    const token = await runner();
    const dev = await addJob("develop");
    await call("/api/work/claim", { kinds: ["develop"] }, token);
    await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token);
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: change.id, result: "ok" }, { head: "h1", guard: { status: "clear", sha: "h1", at: new Date().toISOString() } });
    const verify = (await (await call("/api/work/claim", { kinds: ["verify"] }, token)).json()).job.id;
    const { change: after } = await (await report(verify, token)).json();
    expect(approved).toBe(200);
    expect(after.state).toBe("in_queue");
    expect(await openJobs(change, "merge")).toHaveLength(1);
  });

  // A verified change routed to the reviewer agent, whose review job then reports reviewReport; check(change, reviewed).
  const agentReview = async (name, reviewReport, check) => {
    const { fake, call, change, runner, addJob } = await setup(name);
    await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'risk', 'clef', 'clef@1')").bind(change.repo_id).run();
    // A released reviewer agent for this test only: later tests claim on a fresh deploy.
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
        "VALUES ('agent/reviewer/v1', 'reviewer', 1, 'opencode', 'm', 'default', 'sha256:0', '[]', '{}')"),
      env.DB.prepare("INSERT OR REPLACE INTO channels (agent_name, channel, version) VALUES ('reviewer', 'stable', 1)"),
    ]);
    const AI = fakeClefAI(async () => ({ risk: { low: 0.9, medium: 0.05, high: 0.05 } }));
    const report = (id, token, extra = {}) => worker.fetch(new Request(`http://cinder.test/api/work/jobs/${id}/report`,
      { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify({ status: "done", ...extra }) }), { ...env, ARTIFACTS: fake, AI });
    try {
      const token = await runner();
      const dev = await addJob("develop");
      await call("/api/work/claim", { kinds: ["develop"] }, token);
      await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token);
      const verify = (await (await call("/api/work/claim", { kinds: ["verify"] }, token)).json()).job.id;
      const base = "b".repeat(40);
      const { change: after } = await (await report(verify, token, { tree: "a".repeat(40), base })).json();
      expect(after.state).toBe("verifying");
      expect(after.review).toMatchObject({ route: "agent", reason: "risk low, judge not yet trusted", trusted: false });
      const reviewer = (await (await call("/api/runners", { name: "rev", kinds: ["review"] })).json()).token;
      const claimed = await (await call("/api/work/claim", { kinds: ["review"] }, reviewer)).json();
      // The reviewer diffs the fork's head against the target sha the verify ran on.
      expect(claimed.payload.base).toBe(base);
      const { change: reviewed } = await (await report(claimed.job.id, reviewer, reviewReport)).json();
      await check(change, reviewed);
    } finally {
      await env.DB.batch([env.DB.prepare("DELETE FROM channels WHERE agent_name = 'reviewer'"), env.DB.prepare("DELETE FROM agent_versions WHERE id = 'agent/reviewer/v1'")]);
    }
  };
  const agentRisk = async (change) => (await env.DB.prepare("SELECT answer, probability FROM judgments WHERE change_id = ? AND kind = 'risk' AND backend LIKE 'agent:%'")
    .bind(change.id).all()).results;

  it("a passing agent review queues the change with no approval_missing", () => agentReview("work-untrusted", { verdict: "pass" }, async (change, reviewed) => {
    expect(reviewed.state).toBe("in_queue");
    expect((await mergeBlockers(env, reviewed)).map((b) => b.code)).not.toContain("approval_missing");
    // The reviewer agent's pass is a risk judgment on the change, scored by the same outcome as the judge's.
    expect(await agentRisk(change)).toEqual([{ answer: "yes", probability: 0.1 }]);
  }));

  it("a review job that crashed records no reviewer verdict", () => agentReview("work-review-crash", { status: "failed", detail: "cinder-agent: harness exited 1" }, async (change) => {
    expect(await agentRisk(change)).toEqual([]);
  }));

  it("a git conflict queues a resolve job; claiming it moves the change to resolving", async () => {
    const { call, change, runner, addJob } = await setup("work-q-resolve");
    const token = await runner();
    const dev = await addJob("develop");
    await call("/api/work/claim", { kinds: ["develop"] }, token);
    await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token);
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'converge', ?, 'queued', ?, '{}')")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString()).run();
    const conv = (await (await call("/api/runners", { name: "conv", kinds: ["converge"] })).json()).token;
    const converge = (await (await call("/api/work/claim", { kinds: ["converge"] }, conv)).json()).job.id;
    const conflict = { files: ["a.js"], hunks: [{ file: "a.js", ours: "x()", theirs: "y()" }] };
    expect((await (await call(`/api/work/jobs/${converge}/report`, { status: "failed", conflict }, conv)).json()).change.state).toBe("conflict");
    const [resolve] = await openJobs(change, "resolve");
    const resolver = (await (await call("/api/runners", { name: "res", kinds: ["resolve"] })).json()).token;
    const claim = await (await call("/api/work/claim", { kinds: ["resolve"] }, resolver)).json();
    expect(claim).toMatchObject({ job: { id: resolve.id }, change: { state: "resolving" } });
  });

  it("a conflicted change with agent_pushes false gets no resolve job", async () => {
    const { call, change, runner, addJob } = await setup("work-q-no-agent-pushes");
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).stageEvent({
      kind: "edited", actor: { type: "human", id: "ann@x.test" }, action: "change.edit", target: change.id, result: "ok",
    }, { driver: "ann@x.test", agent_pushes: false });
    const token = await runner();
    const dev = await addJob("develop");
    await call("/api/work/claim", { kinds: ["develop"] }, token);
    await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token);
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'converge', ?, 'queued', ?, '{}')")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString()).run();
    const conv = (await (await call("/api/runners", { name: "conv", kinds: ["converge"] })).json()).token;
    const converge = (await (await call("/api/work/claim", { kinds: ["converge"] }, conv)).json()).job.id;
    const conflict = { files: ["a.js"], hunks: [{ file: "a.js", ours: "x()", theirs: "y()" }] };
    expect((await (await call(`/api/work/jobs/${converge}/report`, { status: "failed", conflict }, conv)).json()).change.state).toBe("conflict");
    expect(await openJobs(change, "resolve")).toEqual([]);
  });

  it("resolve job payload has both intents and the hunks", async () => {
    const { call, change, runner, addJob } = await setup("work-q-payload");
    const theirs = await (await call("/api/repos/work-q-payload/changes", { intent: "their intent" })).json();
    await env.DB.prepare("DELETE FROM jobs WHERE change_id = ?").bind(theirs.id).run();
    const token = await runner();
    const dev = await addJob("develop");
    await call("/api/work/claim", { kinds: ["develop"] }, token);
    await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token);
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'converge', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ theirs: [{ id: theirs.id, intent: "their intent" }] })).run();
    const res = (await (await call("/api/runners", { name: "res", kinds: ["converge", "resolve"] })).json()).token;
    const converge = (await (await call("/api/work/claim", { kinds: ["converge"] }, res)).json()).job.id;
    const hunks = [{ file: "a.js", ours: "x()", theirs: "y()" }];
    expect((await (await call(`/api/work/jobs/${converge}/report`, { status: "failed", conflict: { files: ["a.js"], hunks } }, res)).json()).change.state).toBe("conflict");
    const claim = await (await call("/api/work/claim", { kinds: ["resolve"] }, res)).json();
    expect(claim.payload).toEqual({ intent: "x", theirs: [{ id: theirs.id, intent: "their intent" }], hunks, symbols: [] });
  });

  it("reporting the same done twice leaves one open verify job", async () => {
    const { call, change, runner, addJob } = await setup("work-q-twice");
    const token = await runner();
    const dev = await addJob("develop");
    await call("/api/work/claim", { kinds: ["develop"] }, token);
    expect((await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token)).status).toBe(200);
    await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token);
    expect(await openJobs(change, "verify")).toHaveLength(1);
  });

  it("a claim of a closed change's job whose fork is gone fails the job instead of crashing", async () => {
    const { fake, call, change, addJob } = await setup("work-gone-fork");
    const reviewer = (await (await call("/api/runners", { name: "rev", kinds: ["review"] })).json()).token;
    expect((await call(`/api/changes/${change.id}/close`, {})).status).toBe(200);
    const job = await addJob("review");
    fake.repos.delete(change.fork);
    expect((await call("/api/work/claim", { kinds: ["review"] }, reviewer)).status).toBe(204);
    expect(await env.DB.prepare("SELECT status FROM jobs WHERE id = ?").bind(job).first("status")).toBe("failed");
  });

  it("a job whose open change's fork isn't listed yet goes back to the queue", async () => {
    const { fake, call, change, addJob } = await setup("work-new-fork");
    const reviewer = (await (await call("/api/runners", { name: "rev", kinds: ["review"] })).json()).token;
    const job = await addJob("review");
    fake.repos.delete(change.fork);
    expect((await call("/api/work/claim", { kinds: ["review"] }, reviewer)).status).toBe(204);
    expect(await env.DB.prepare("SELECT status, runner_id FROM jobs WHERE id = ?").bind(job).first()).toEqual({ status: "queued", runner_id: null });
  });

  it("review job has no write token", async () => {
    const { fake, call, change, addJob } = await setup("work-review-tok");
    const reviewer = (await (await call("/api/runners", { name: "rev", kinds: ["review"] })).json()).token;
    await addJob("review");
    const claim = await (await call("/api/work/claim", { kinds: ["review"] }, reviewer)).json();
    expect(claim.token).toBeNull();
    expect(claim.read_token).toEqual(expect.any(String));
    expect(fake.calls.filter((c) => c.method === "createToken" && c.args[0] !== "cinder-agents").map((c) => c.args)).toEqual([[change.fork, "read", 600]]);
  });
});

describe("lease enforcement", () => {
  // Develops and verifies the setup change; returns the verify report's response body.
  async function verifyTouching({ call, runner, addJob }, touched) {
    const token = await runner();
    const dev = await addJob("develop");
    await call("/api/work/claim", { kinds: ["develop"] }, token);
    await call(`/api/work/jobs/${dev}/report`, { status: "done" }, token);
    const verify = (await (await call("/api/work/claim", { kinds: ["verify"] }, token)).json()).job.id;
    return (await call(`/api/work/jobs/${verify}/report`, { status: "done", writes: touched.map((symbol) => ({ symbol, kind: "body" })) }, token)).json();
  }
  // Claims and reports the setup change's develop job with the push's writes; returns the report's response body.
  async function push({ call, runner, addJob }, writes) {
    const token = await runner();
    const dev = await addJob("develop");
    await call("/api/work/claim", { kinds: ["develop"] }, token);
    return (await call(`/api/work/jobs/${dev}/report`, { status: "done", writes, reads: ["a.js#h"] }, token)).json();
  }
  const repoDO = (name) => env.REPO_DO.get(env.REPO_DO.idFromName(name));

  it("touching a free symbol extends the lease", async () => {
    const s = await setup("enforce-free");
    await repoDO("enforce-free").grant("main", s.change.id, ["a.js#f"]);
    const { change } = await verifyTouching(s, ["a.js#f", "b.js#g"]);
    expect(change.state).toBe("in_queue");
    expect((await repoDO("enforce-free").leases("main"))[s.change.id]).toEqual({ symbols: ["a.js#f", "b.js#g"], granted: true });
  });

  it("touching a held symbol stacks the change behind the holder", async () => {
    const s = await setup("enforce-held");
    await repoDO("enforce-held").grant("main", s.change.id, ["a.js#f"]);
    await repoDO("enforce-held").grant("main", "other", ["b.js"]);
    const { change } = await verifyTouching(s, ["a.js#f", "b.js#g"]);
    expect(change).toMatchObject({ state: "waiting", stacked_on: "other" });
    expect(await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(s.change.id)).conflicts())
      .toMatchObject([{ ours: s.change.id, theirs: ["other"], files: ["b.js"], hunks: [] }]);
    // It waits for the held symbol behind the holder.
    expect((await repoDO("enforce-held").leases("main"))[s.change.id]).toEqual({ symbols: ["a.js#f", "b.js#g"], granted: false });
  });

  it("a push writing an unleased symbol extends the lease", async () => {
    const s = await setup("push-free");
    await repoDO("push-free").grant("main", s.change.id, ["a.js#f"]);
    const { change } = await push(s, [{ symbol: "b.js#g", kind: "body" }]);
    expect(change.state).toBe("verifying");
    expect((await repoDO("push-free").leases("main"))[s.change.id]).toEqual({ symbols: ["a.js#f", "b.js#g"], granted: true });
  });

  it("a push writing a symbol leased by another change marks a collision, stacks the change and blocks queueing", async () => {
    const s = await setup("push-held");
    await repoDO("push-held").grant("main", s.change.id, ["a.js#f"]);
    await repoDO("push-held").grant("main", "other", ["b.js#g"]);
    const { change } = await push(s, [{ symbol: "a.js#f", kind: "body" }, { symbol: "b.js#g", kind: "signature" }, { symbol: "c.js#k", kind: "body" }]);
    expect(change).toMatchObject({ state: "waiting", stacked_on: "other" });
    expect(await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(s.change.id)).conflicts()).toMatchObject([{
      ours: s.change.id, theirs: ["other"], files: ["b.js"], collisions: [{ symbol: "b.js#g", kind: "signature", holder: "other" }],
    }]);
    // The free write is leased; the held one stays the holder's, and the change waits for it.
    expect((await repoDO("push-held").leases("main"))[s.change.id]).toEqual({ symbols: ["a.js#f", "c.js#k", "b.js#g"], granted: false });
    expect((await s.call(`/api/changes/${s.change.id}/queue`, {})).status).toBe(409);
  });

  it("verify refuses to queue a change whose final diff writes a symbol held by another change", async () => {
    const s = await setup("verify-held");
    await repoDO("verify-held").grant("main", s.change.id, ["a.js#f"]);
    const token = await s.runner();
    const dev = await s.addJob("develop");
    await s.call("/api/work/claim", { kinds: ["develop"] }, token);
    await s.call(`/api/work/jobs/${dev}/report`, { status: "done", writes: [{ symbol: "a.js#f", kind: "body" }] }, token);
    // Another change leases b.js after the push; the final diff writes into it.
    await repoDO("verify-held").grant("main", "other", ["b.js"]);
    const verify = (await (await s.call("/api/work/claim", { kinds: ["verify"] }, token)).json()).job.id;
    const { change } = await (await s.call(`/api/work/jobs/${verify}/report`, { status: "done", writes: [{ symbol: "b.js#g", kind: "body" }] }, token)).json();
    expect(change.state).toBe("waiting");
    expect(await env.DB.prepare("SELECT id FROM jobs WHERE change_id = ? AND kind = 'merge'").bind(change.id).first()).toBeNull();
  });

  it("outcomes recorded for every predicted symbol", async () => {
    const s = await setup("enforce-outcomes");
    const repo = s.change.repo_id;
    await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'lease', 'clef', 'clef@1')").bind(repo).run();
    await env.DB.batch([["src/http.js", "retryFetch"], ["src/http.js", "retryPost"], ["src/backoff.js", "retryDelay"]]
      .map(([path, name]) => env.DB.prepare("INSERT INTO symbols VALUES (?, 'sha1', ?, ?, 'function', 1, 2)").bind(repo, path, name)));
    const AI = fakeClefAI(async (model, body) => Object.fromEntries(Object.keys(body.questions).map((n) => [n, 0.9])));
    await predictLease({ ...env, AI }, repo, "sha1", "retry", s.change.id);
    await verifyTouching(s, ["src/http.js#retryFetch"]);
    const { results } = await env.DB.prepare(
      "SELECT j.question, o.actual, o.correct FROM judgments j LEFT JOIN outcomes o ON o.judgment_id = j.id WHERE j.change_id = ? ORDER BY j.question",
    ).bind(s.change.id).all();
    expect(results).toEqual([
      { question: "Will this intent modify src/backoff.js#retryDelay?", actual: "no", correct: 0 },
      { question: "Will this intent modify src/http.js#retryFetch?", actual: "yes", correct: 1 },
      { question: "Will this intent modify src/http.js#retryPost?", actual: "no", correct: 0 },
    ]);
  });
  it("each mint site: every job kind gets only its scoped tokens with the shortest TTL", async () => {
    const { fake, call, change, addJob } = await setup("work-mint");
    const fork = [[change.fork, "write", 600], ["work-mint", "read", 600]];
    // merge first: claiming the other kinds moves the change out of in_queue.
    const sites = {
      merge: [["work-mint", "write", 600], [change.fork, "read", 600]],
      develop: fork, resolve: fork, verify: fork, converge: fork,
      review: [[change.fork, "read", 600]],
      history: [["work-mint", "write", 600]],
      index: [["work-mint", "read", 600]],
      guard: [[change.fork, "read", 600]],
    };
    const token = (await (await call("/api/runners", { name: "all", kinds: Object.keys(sites), slots: Object.keys(sites).length })).json()).token;
    // A merge job is only claimable for its queue's head.
    await env.DB.prepare("UPDATE changes SET state = 'in_queue' WHERE id = ?").bind(change.id).run();
    await env.DB.prepare("INSERT INTO queue_entries (change_id, repo_id, target_branch, enqueued_at) VALUES (?, ?, ?, ?)")
      .bind(change.id, change.repo_id, change.target_branch, new Date().toISOString()).run();
    for (const [kind, want] of Object.entries(sites)) {
      await addJob(kind);
      const before = fake.calls.length;
      expect((await call("/api/work/claim", { kinds: [kind], slots_free: Object.keys(sites).length }, token)).status, kind).toBe(200);
      expect(fake.calls.slice(before).filter((c) => c.method === "createToken" && c.args[0] !== "cinder-agents").map((c) => c.args), kind).toEqual(want);
    }
  });

  it("the merge claim response has no signing_key", async () => {
    const { call, change, addJob } = await setup("work-nokey");
    await env.DB.prepare("UPDATE changes SET state = 'in_queue' WHERE id = ?").bind(change.id).run();
    await env.DB.prepare("INSERT INTO queue_entries (change_id, repo_id, target_branch, enqueued_at) VALUES (?, ?, ?, ?)")
      .bind(change.id, change.repo_id, change.target_branch, new Date().toISOString()).run();
    await addJob("merge");
    const token = (await (await call("/api/runners", { name: "merger", kinds: ["merge"] })).json()).token;
    const claim = await (await call("/api/work/claim", { kinds: ["merge"] }, token)).json();
    expect(claim.job.kind).toBe("merge");
    expect(claim).not.toHaveProperty("signing_key");
    expect(JSON.stringify(claim)).not.toContain("PRIVATE KEY");
  });

  it("429 after the claim limit", async () => {
    const { call, runner } = await setup("work-limit");
    const [token, other] = [await runner(), await runner()];
    // Limit windows are wall-clock minutes, so one boundary may fall inside the loop: the 429 comes within two windows.
    let n = 0;
    let res;
    while ((res = await call("/api/work/claim", {}, token)).status === 204 && n < 120) n++;
    expect(n).toBeGreaterThanOrEqual(60);
    expect(res.status).toBe(429);
    expect((await res.json()).error.code).toBe("rate_limited");
    // The limit is per runner.
    expect((await call("/api/work/claim", {}, other)).status).toBe(204);
  });
});

describe("probe outcomes close collision judgments", () => {
  // Records an open collision judgment on the setup change about theirs, then reports a converge probe against it.
  async function probe(name, report, reports = 1) {
    const { call, change } = await setup(name);
    const theirs = crypto.randomUUID();
    await recordJudgment(env.DB, { repo: change.repo_id, change: change.id, kind: "collision", backend: "clef", model: "clef@1",
      state_hash: "h", question: collisionQuestion(theirs), answer: "yes", p: 0.8 });
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)), async (i) => {
      await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "converging" });
    });
    const runner = (await (await call("/api/runners", { name: "probe", kinds: ["converge"] })).json()).token;
    for (let i = 0; i < reports; i++) {
      await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'converge', ?, 'queued', ?, ?)")
        .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ theirs: [{ id: theirs, intent: "" }] })).run();
      const job = (await (await call("/api/work/claim", { kinds: ["converge"] }, runner)).json()).job.id;
      expect((await call(`/api/work/jobs/${job}/report`, report[i] ?? report[0], runner)).status).toBe(200);
    }
    return (await env.DB.prepare("SELECT o.actual, o.correct FROM outcomes o JOIN judgments j ON j.id = o.judgment_id WHERE j.change_id = ?")
      .bind(change.id).all()).results;
  }
  const conflicting = { status: "failed", conflict: { files: ["a.js"], hunks: [{ file: "a.js" }] } };

  it("attaches collided=true to the pair's judgment on a conflicting probe", async () => {
    expect(await probe("probe-true", [conflicting])).toEqual([{ actual: "yes", correct: 1 }]);
  });

  it("attaches collided=false on a clean probe", async () => {
    expect(await probe("probe-false", [{ status: "done" }])).toEqual([{ actual: "no", correct: 0 }]);
  });

  it("does not attach a second outcome to the same pair", async () => {
    expect(await probe("probe-once", [{ status: "done" }, conflicting], 2)).toEqual([{ actual: "no", correct: 0 }]);
  });
});

describe("wrong-merge rate", () => {
  it("a follow-up fix to a merged declaration marks the resolution wrong", async () => {
    const { call, change } = await setup("wrong-merge");
    const fix = await (await call("/api/repos/wrong-merge/changes", { intent: "fix f" })).json();
    await env.DB.prepare("DELETE FROM jobs WHERE change_id = ?").bind(fix.id).run();
    await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)), async (i) => {
      await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "converging" });
    });
    const runner = (await (await call("/api/runners", { name: "wm", kinds: ["converge", "develop", "verify"] })).json()).token;
    // Each report queues the change's next job; only the job inserted here may be claimed.
    const job = async (kind, id, report) => {
      await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status = 'queued'").run();
      await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, ?, ?, 'queued', ?, '{}')")
        .bind(crypto.randomUUID(), change.repo_id, kind, id, new Date().toISOString()).run();
      const claimed = (await (await call("/api/work/claim", { kinds: [kind] }, runner)).json()).job.id;
      expect((await call(`/api/work/jobs/${claimed}/report`, report, runner)).status).toBe(200);
    };
    await job("converge", change.id, { status: "done", resolutions: ["a.js#f", "a.js#g"] });
    await job("develop", fix.id, { status: "done" });
    await job("verify", fix.id, { status: "done", writes: [{ symbol: "a.js#f", kind: "body" }] });
    const { results } = await env.DB.prepare("SELECT symbol, wrong_at IS NOT NULL AS wrong FROM merge_resolutions WHERE change_id = ? ORDER BY symbol")
      .bind(change.id).all();
    expect(results).toEqual([{ symbol: "a.js#f", wrong: 1 }, { symbol: "a.js#g", wrong: 0 }]);
  });
});

describe("claims on a fresh deploy", () => {
  // A release job on a fake with no cinder-agents repo, and a runner that claims it.
  async function releaseClaim(fake) {
    const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
      { ...env, ARTIFACTS: fake },
    );
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) VALUES (?, 'cinder-agents', 'release', 'queued', ?, '{}')")
      .bind(crypto.randomUUID(), new Date().toISOString()).run();
    const { token } = await (await call("/api/runners", { name: "releaser", kinds: ["release"] })).json();
    return call("/api/work/claim", { kinds: ["release"], slots_free: 1 }, token);
  }

  it("with no cinder-agents repo, a claim succeeds and the repo exists afterwards", async () => {
    const fake = fakeArtifacts();
    const res = await releaseClaim(fake);
    expect(res.status).toBe(200);
    expect((await res.json()).payload.remote).toBe("https://artifacts.fake/cinder/cinder-agents.git");
    expect(fake.repos.has("cinder-agents")).toBe(true);
    expect((await releaseClaim(fake)).status).toBe(200);
  });

  it("a claim with no recorded version uses the default agent", async () => {
    const { call, runner, addJob } = await setup("work-default-agent");
    await addJob("develop");
    const claim = await (await call("/api/work/claim", { kinds: ["develop"] }, await runner())).json();
    expect(claim).toMatchObject({ agent: null, default_agent: "cinder-agent@v0" });
  });

  it("the changes list returns the agent name and version for an agent-driven change", async () => {
    const { call, change, runner, addJob } = await setup("work-list-agent");
    const list = async () => (await (await worker.fetch(new Request("http://cinder.test/api/repos/work-list-agent/changes", {
      headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env)).json()).find((c) => c.id === change.id);
    expect((await list()).ver).toBeNull();
    await addJob("develop");
    expect((await call("/api/work/claim", { kinds: ["develop"] }, await runner())).status).toBe(200);
    expect(await list()).toMatchObject({ state: "developing", agent: "cinder-agent", ver: "v0" });
  });

  it("with the agents repo unreachable (create also fails), a claim still answers 200 with the default agent", async () => {
    const { fake, call, runner, addJob } = await setup("work-agents-down");
    await env.DB.batch(["agent_releases", "channels", "agent_versions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    fake.create = async () => { throw new Error("artifacts unavailable"); };
    await addJob("develop");
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const res = await call("/api/work/claim", { kinds: ["develop"] }, await runner());
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ agent: null, default_agent: "cinder-agent@v0" });
    expect(logged).toHaveBeenCalledOnce();
    logged.mockRestore();
  });

  it("an Artifacts failure inside claim answers a JSON error, not an exception", async () => {
    const fake = fakeArtifacts();
    fake.get = async () => { throw new Error("artifacts unavailable"); };
    const res = await releaseClaim(fake);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("internal");
  });

  it("5 concurrent claims on a fresh deploy create the repo once and all answer 200 (default agent until ready)", async () => {
    await env.DB.batch(["agent_releases", "channels", "agent_versions", "agents_bootstrap"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
    const { fake, call, runner, addJob } = await setup("work-fresh-agents", "x", await agentsFake("work-fresh-agents"));
    fake.creating = 2;
    for (let i = 0; i < 5; i++) await addJob("develop");
    const token = await runner(5);
    const logged = vi.spyOn(console, "error");
    const claims = await Promise.all(Array.from({ length: 5 }, () => call("/api/work/claim", { kinds: ["develop"], slots_free: 5 }, token)));
    expect(claims.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    for (const claim of await Promise.all(claims.map((r) => r.json()))) expect(claim.default_agent).toBe("cinder-agent@v0");
    expect(fake.calls.filter((c) => c.method === "create" && c.args[0] === "cinder-agents")).toHaveLength(1);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM agent_versions").first("n")).toBe(3);
    expect(logged).not.toHaveBeenCalledWith(expect.stringMatching(/cinder-agents bootstrap failed/));
    logged.mockRestore();
  });
});

describe("work list diff summaries", () => {
  it("the work list carries each change's diff summary from a cache keyed by head sha", async () => {
    const fake = fakeArtifacts();
    const { change } = await setup("work-diff", "x", fake);
    const fork = fake.repos.get(change.fork);
    fork.files["a.md"] = "keep\nnew\n";
    fork.commits.unshift({ hash: "c1", message: "edit" });
    fork.at = { c1: fork.files };
    await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, 'c1')").bind(change.id).run();
    const work = async () => (await (await worker.fetch(new Request("http://cinder.test/api/repos/work-diff/work",
      { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), { ...env, ARTIFACTS: fake })).json()).items.find((i) => i.change_id === change.id);
    const summary = { files_changed: 1, additions: 2, deletions: 0, ahead: null, behind: null };
    expect((await work()).diff).toEqual(summary);
    expect(JSON.parse(await env.DB.prepare("SELECT summary FROM head_diffs WHERE head_sha = 'c1'").first("summary"))).toEqual(summary);
    // The second list reads the cache: no Artifacts call for the head.
    const reads = fake.calls.length;
    expect((await work()).diff).toEqual(summary);
    expect(fake.calls.length).toBe(reads);
  });
});

describe("a failed agent job", () => {
  // The change's develop job on retrier@v1 (stable; v2 is its canary) fails with `detail`; returns what the report did.
  async function failDevelop(name, detail) {
    const { call, change, runner } = await setup(name);
    const row = "INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) VALUES (?, 'retrier', ?, 'opencode', 'm', 'default', 'h', '[]', '{}')";
    await env.DB.batch([env.DB.prepare(row).bind("retrier-1", 1), env.DB.prepare(row).bind("retrier-2", 2),
      env.DB.prepare("INSERT OR REPLACE INTO channels (agent_name, channel, version) VALUES ('retrier', 'stable', 1), ('retrier', 'canary', 2)")]);
    const token = await runner();
    const fail = async (payload) => {
      const id = crypto.randomUUID();
      await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, ?)")
        .bind(id, change.repo_id, change.id, new Date().toISOString(), JSON.stringify(payload)).run();
      expect((await (await call("/api/work/claim", { kinds: ["develop"] }, token)).json()).job.id).toBe(id);
      return { id, body: await (await call(`/api/work/jobs/${id}/report`, { status: "failed", detail }, token)).json() };
    };
    const queued = async () => (await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'develop' AND status = 'queued'")
      .bind(change.id).all()).results.map((r) => JSON.parse(r.payload));
    return { fail, queued };
  }

  it("a failed develop job retries once on the other agent version", async () => {
    const { fail, queued } = await failDevelop("work-retry", "tests failed");
    const first = await fail({ agent: "retrier@v1" });
    expect(first.body.change.state).not.toBe("failed");
    expect(first.body.change.events.at(-1)).toMatchObject({ kind: "retry", reason: expect.stringContaining("retrier@v2") });
    const [retry] = await queued();
    expect(retry).toMatchObject({ agent: "retrier@v2", retry_of: first.id });
    // The retry failing too ends the change: one retry only.
    await env.DB.prepare("DELETE FROM jobs WHERE status = 'queued' AND kind = 'develop'").run();
    expect((await fail(retry)).body.change.state).toBe("failed");
  });

  it("a budget stop never retries", async () => {
    const { fail, queued } = await failDevelop("work-retry-limit", "max spend reached");
    expect((await fail({ agent: "retrier@v1" })).body.change.state).toBe("failed");
    expect(await queued()).toEqual([]);
  });
});
