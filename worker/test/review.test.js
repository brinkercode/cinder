import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

// A change its develop job has reported done: it waits in verifying, where a person reviews it.
async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  // Earlier tests leave jobs queued on other repos; only this change's develop job stays claimable.
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed') AND change_id <> ?").bind(change.id).run();
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json()).token;
  const { job } = await (await call("/api/work/claim", { kinds: ["develop"] }, runner)).json();
  expect((await (await call(`/api/work/jobs/${job.id}/report`, { status: "done" }, runner)).json()).change.state).toBe("verifying");
  return { call, change, runner, fake };
}

// The change's review stage runs as reviewer@v2; its fork's head has src/a.js. Returns the claimed review job.
async function reviewJob({ call, change, fake }) {
  await env.DB.prepare("INSERT OR IGNORE INTO agent_versions (id, name, version, harness, model, effort, prompt_hash, tools, limits) " +
    "VALUES ('agent/reviewer/v2', 'reviewer', 2, 'claude-code', 'claude-opus-5-5', 'default', 'h', '[]', '{}')").run();
  await env.DB.prepare("INSERT OR REPLACE INTO change_heads (change_id, head_sha) VALUES (?, ?)").bind(change.id, "a".repeat(40)).run();
  fake.repos.get(change.fork).files["src/a.js"] = "one\ntwo\nthree\n";
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'review', ?, 'queued', ?, ?)")
    .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ agent_version: "reviewer@v2" })).run();
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["review"] })).json()).token;
  const { job } = await (await call("/api/work/claim", { kinds: ["review"] }, runner)).json();
  expect(job.kind).toBe("review");
  return { job, runner };
}

describe("review", () => {
  it("request_changes moves the change to needs_fix", async () => {
    const { call, change } = await setup("review-fix");
    expect((await call(`/api/changes/${change.id}/review`, { verdict: "merge" })).status).toBe(400);
    const res = await call(`/api/changes/${change.id}/review`, { verdict: "request_changes", body: "split the helper" });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("needs_fix");
    // Already back for a fix: a second request has nowhere to move it.
    expect((await call(`/api/changes/${change.id}/review`, { verdict: "request_changes", body: "" })).status).toBe(409);
    expect((await call("/api/changes/no-such/review", { verdict: "comment", body: "x" })).status).toBe(404);
  });

  // An agent-routed change: a person's review is recorded but doesn't release it past the route.
  async function agentRouted(name) {
    const s = await setup(name);
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(s.change.id));
    await stub.setReview({ route: "agent", reason: "risk low" });
    await stub.moveHead("sha1");
    return { ...s, stub };
  }

  it("approve on a verified agent-routed change returns 200, records the person at the head and leaves the state", async () => {
    const { call, change, stub } = await agentRouted("review-any-approve");
    const res = await call(`/api/changes/${change.id}/review`, { verdict: "approve", body: "" });
    expect(res.status).toBe(200);
    const after = await stub.get();
    expect(after.approvals).toEqual([{ actor: { type: "human", id: "owner" }, head_sha: "sha1", at: expect.any(String) }]);
    expect(after.state).toBe("verifying");
  });

  it("request_changes on a verified agent-routed change returns 200 and moves it to needs_fix", async () => {
    const { call, change } = await agentRouted("review-any-fix");
    const res = await call(`/api/changes/${change.id}/review`, { verdict: "request_changes", body: "" });
    expect(res.status).toBe(200);
    expect((await res.json()).state).toBe("needs_fix");
  });

  it("an agent version approving the change it developed is still refused", async () => {
    const { change, stub } = await agentRouted("review-any-self");
    await stub.report({ change_id: change.id, stage: "develop", agent_version: "dev@v1", harness: "claude-code", model: "claude-opus",
      cost_usd: 0.1, duration_ms: 1000, session: "s", verdict: "pass", dirty: false, started_at: "2026-10-04T00:00:00Z" });
    expect(await stub.approve({ type: "agent", id: "dev", agent_version: "dev@v1" })).toBe(false);
    expect((await stub.get()).approvals).toBeUndefined();
  });

  it("the repair claim payload carries the unresolved threads", async () => {
    const { call, change, runner } = await setup("review-repair");
    const open = await (await call(`/api/changes/${change.id}/threads`, { path: "src/a.js", side: "old", line: 3, body: "keep this guard" })).json();
    await call(`/api/changes/${change.id}/threads/${open.id}/comments`, { body: "and test it" });
    const done = await (await call(`/api/changes/${change.id}/threads`, { path: "src/b.js", side: "old", line: 1, body: "typo" })).json();
    await call(`/api/changes/${change.id}/threads/${done.id}/resolve`);
    expect((await call(`/api/changes/${change.id}/review`, { verdict: "request_changes", body: "split the helper" })).status).toBe(200);
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, '{}')")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString()).run();
    const claim = await (await call("/api/work/claim", { kinds: ["develop"] }, runner)).json();
    expect(claim.change.state).toBe("developing");
    expect(claim.payload.threads).toEqual([
      { path: "src/a.js", line: 3, body: "keep this guard\n\nand test it" },
      { path: null, line: null, body: "split the helper" },
    ]);
  });

  it("a reviewer finding becomes a thread with the agent version as author", async () => {
    const s = await setup("review-agent-thread");
    const { job, runner } = await reviewJob(s);
    const bad = await s.call(`/api/work/jobs/${job.id}/report`, { status: "failed", findings: [{ path: "src/a.js", line: 0, body: "x" }] }, runner);
    expect(bad.status).toBe(400);
    const findings = [{ path: "src/a.js", line: 2, body: "two is unchecked", suggestion: "if (two) {}" }, { path: "src/gone.js", line: 9, body: "dead file" }];
    expect((await s.call(`/api/work/jobs/${job.id}/report`, { status: "failed", findings }, runner)).status).toBe(200);
    const threads = await (await s.call(`/api/changes/${s.change.id}/threads`, undefined, env.OWNER_TOKEN, "GET")).json();
    expect(threads.map((t) => [t.path, t.side, t.line, t.original_lines, t.resolved, t.comments.map((c) => [c.actor, c.body])])).toEqual([
      ["src/a.js", "new", 2, ["two"], false, [["agent:reviewer@v2", "two is unchecked\n\n```suggestion\nif (two) {}\n```"]]],
      [null, null, null, null, false, [["agent:reviewer@v2", "src/gone.js:9: dead file"]]],
    ]);
  });

  it("the repair prompt includes the agent's unresolved findings", async () => {
    const s = await setup("review-agent-repair");
    const { job, runner } = await reviewJob(s);
    const findings = [{ path: "src/a.js", line: 1, body: "rename one" }, { path: "src/a.js", line: 3, body: "three is fine" }];
    const res = await (await s.call(`/api/work/jobs/${job.id}/report`, { status: "failed", findings }, runner)).json();
    expect(res.change.state).toBe("needs_fix");
    const [, settled] = await (await s.call(`/api/changes/${s.change.id}/threads`, undefined, env.OWNER_TOKEN, "GET")).json();
    await s.call(`/api/changes/${s.change.id}/threads/${settled.id}/resolve`);
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, '{}')")
      .bind(crypto.randomUUID(), s.change.repo_id, s.change.id, new Date().toISOString()).run();
    const claim = await (await s.call("/api/work/claim", { kinds: ["develop"] }, s.runner)).json();
    expect(claim.change.state).toBe("developing");
    expect(claim.payload.threads).toEqual([{ path: "src/a.js", line: 1, body: "rename one" }]);
  });

  it("the verdict is stored as a judgment with a human backend", async () => {
    const { call, change } = await setup("review-judged");
    expect((await call(`/api/changes/${change.id}/review`, { verdict: "comment", body: "looks close" })).status).toBe(200);
    expect((await call(`/api/changes/${change.id}/review`, { verdict: "request_changes", body: "" })).status).toBe(200);
    const list = (await env.DB.prepare("SELECT j.* FROM judgments j JOIN repos r ON r.id = j.repo_id WHERE r.name = ? AND j.kind = ? ORDER BY j.made_at").bind("review-judged", "risk").all()).results;
    expect(list.map((j) => [j.change_id, j.backend, j.probability])).toEqual([[change.id, "human:owner", 0.9]]);
  });

  it("a review comment is attributed to the reviewer, not the owner", async () => {
    const { call, change, fake } = await setup("review-attributed");
    serveCerts();
    const res = await worker.fetch(new Request(`http://cinder.test/api/changes/${change.id}/review`, {
      method: "POST", headers: await as("boss@example.com"), body: JSON.stringify({ verdict: "comment", body: "looks close" }),
    }), { ...ACCESS, ARTIFACTS: fake });
    expect(res.status).toBe(200);
    const threads = await (await call(`/api/changes/${change.id}/threads`, undefined, env.OWNER_TOKEN, "GET")).json();
    expect(threads.map((t) => t.comments.map((c) => c.actor))).toEqual([["boss@example.com"]]);
  });
});
