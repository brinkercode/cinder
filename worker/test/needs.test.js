import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { recordScan } from "../src/findings.js";
import worker from "../src/index.js";
import { raiseNeeds } from "../src/needs.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

// A change on head sha1 whose verify passed with an untrusted risk judge answering low: it waits in verifying for
// a person, with an Untrusted judge need open.
async function untrusted(name) {
  const fake = fakeArtifacts();
  const AI = fakeClefAI(async () => ({ risk: { low: 0.9, medium: 0.05, high: 0.05 } }));
  const call = (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake, AI },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
  fake.repos.get(change.fork).commits.unshift({ sha: "sha1" });
  await stub.moveHead("sha1");
  for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: change.id, result: "ok" });
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["verify"] })).json()).token;
  // Queues a verify job; the returned function claims it and reports it passed.
  const startVerify = async () => {
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')")
      .bind(job, change.repo_id, change.id, new Date().toISOString()).run();
    return async () => {
      expect((await (await call("/api/work/claim", { kinds: ["verify"] }, runner)).json()).job.id).toBe(job);
      return (await call(`/api/work/jobs/${job}/report`, { status: "done" }, runner)).json();
    };
  };
  expect((await (await startVerify())()).change.state).toBe("verifying");
  const need = (await (await call("/api/needs", undefined, env.OWNER_TOKEN, "GET")).json()).find((n) => n.change === change.id && n.kind === "Untrusted judge");
  const resolve = (action) => call(`/api/needs/${need.id}/resolve`, { action });
  const open = async () => (await (await call("/api/needs", undefined, env.OWNER_TOKEN, "GET")).json()).some((n) => n.id === need.id);
  const queued = async () => (await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(change.id).first()) !== null;
  const liveReviews = async () => (await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE change_id = ? AND kind = 'review' AND status IN ('queued', 'claimed') AND id NOT IN (SELECT job_id FROM job_cancels)")
    .bind(change.id).first("n"));
  return { id: change.id, stub, startVerify, resolve, open, queued, liveReviews };
}

describe("needs", () => {
  it("approving an untrusted judge's verified change queues it", async () => {
    const { stub, resolve, open, queued, liveReviews } = await untrusted("needs-untrusted-verified");
    expect(await liveReviews()).toBe(0);
    expect((await resolve("Approve change")).status).toBe(200);
    const change = await stub.get();
    expect(change.state).toBe("in_queue");
    expect(change.review.route).toBe("human");
    expect(change.approvals).toEqual([{ actor: { type: "human", id: "owner" }, head_sha: "sha1", at: expect.any(String) }]);
    expect(await liveReviews()).toBe(0);
    expect(await queued()).toBe(true);
    expect(await open()).toBe(false);
  });

  it("approving an untrusted-judge item enqueues the change", async () => {
    const { id, stub, resolve, open, queued } = await untrusted("needs-untrusted-enqueue");
    // Auto-queue off: Change detail still shows the change Ready, so the item's approval must enqueue it itself.
    await env.DB.prepare("INSERT OR REPLACE INTO change_views (change_id, auto_queue) VALUES (?, 0)").bind(id).run();
    expect((await resolve("Approve change")).status).toBe(200);
    const change = await stub.get();
    expect(change.state).toBe("in_queue");
    expect(change.approvals).toEqual([{ actor: { type: "human", id: "owner" }, head_sha: "sha1", at: expect.any(String) }]);
    expect(await queued()).toBe(true);
    expect(await open()).toBe(false);
  });

  it("approving while the change verifies queues it when verify passes", async () => {
    const { stub, startVerify, resolve, open, queued, liveReviews } = await untrusted("needs-untrusted-verifying");
    const pass = await startVerify();
    expect((await resolve("Approve change")).status).toBe(200);
    expect((await stub.get()).state).toBe("verifying");
    expect(await queued()).toBe(false);
    expect(await open()).toBe(false);
    const report = await pass();
    expect(report.change.state).toBe("in_queue");
    expect(report.change.review.route).toBe("human");
    expect(await liveReviews()).toBe(0);
    expect(await queued()).toBe(true);
  });

  it("a judges-disagree merge that answers 409 leaves no approval and the need open", async () => {
    const { id, stub } = await untrusted("needs-disagree-409");
    // The change is agent-routed, so it can't queue.
    await stub.setReview({ route: "agent", reason: "risk medium" });
    const need = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO needs (id, kind, repo, change_id, text, actions, created_at) VALUES (?, 'Judges disagree', 'needs-disagree-409', ?, 't', ?, ?)")
      .bind(need, id, JSON.stringify(["Merge", "Reject", "Open change"]), new Date().toISOString()).run();
    const res = await worker.fetch(new Request(`http://cinder.test/api/needs/${need}/resolve`, {
      method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify({ action: "Merge" }),
    }), { ...env, ARTIFACTS: fakeArtifacts() });
    expect(res.status).toBe(409);
    const change = await stub.get();
    expect(change.approvals ?? []).toEqual([]);
    expect(change.state).toBe("verifying");
    expect(await env.DB.prepare("SELECT resolved_at FROM needs WHERE id = ?").bind(need).first("resolved_at")).toBeNull();
  });

  it("the critical advisory need's Open fix change reuses the finding's fix change", async () => {
    const fake = fakeArtifacts();
    const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
      body: JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
    expect((await call("/api/repos", { name: "needs-advisory-fix" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("needs-advisory-fix")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = 'needs-advisory-fix'").first("id");
    await recordScan(env.DB, { repo, target: "main", source: "dependency", sha: "s1", full: true,
      findings: [{ rule: "GHSA-crit", severity: "critical", path: "next@16.3.8", fingerprint: "npm|next|GHSA-crit" }] });
    const finding = await env.DB.prepare("SELECT id FROM findings WHERE repo_id = ?").bind(repo).first("id");
    const fix = await (await call(`/api/findings/${finding}/fix`, {})).json();
    await raiseNeeds(env.DB, repo, [{ kind: "Critical advisory", change: null, text: "next 16.3.8 has critical advisory GHSA-crit.",
      actions: ["Open fix change", "Watchtower"], subject: { package: "next" } }]);
    const need = await env.DB.prepare("SELECT id FROM needs WHERE repo = 'needs-advisory-fix' AND kind = 'Critical advisory'").first("id");
    const res = await call(`/api/needs/${need}/resolve`, { action: "Open fix change" });
    expect(res.status).toBe(200);
    expect((await res.json()).change).toBe(fix.id);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM changes WHERE repo_id = ?").bind(repo).first("n")).toBe(1);
  });
});
