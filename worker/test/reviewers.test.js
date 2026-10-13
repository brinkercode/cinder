import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { validateChangeDetail } from "../src/api/contract.js";
import { fakeClefAI } from "./fakes/ai.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

describe("reviewers", () => {
  it("suggestions rank the top owner of the touched path first and exclude the author", async () => {
    const fake = fakeArtifacts();
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const call = (path, body, method = "POST") => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake },
    );
    expect((await call("/api/repos", { name: "rev-suggest" })).status).toBe(201);
    const { id, repo_id, target_branch } = await (await call("/api/repos/rev-suggest/changes", { intent: "add retries", author: "ana@example.com" })).json();
    await env.REPO_DO.get(env.REPO_DO.idFromName("rev-suggest")).grant(target_branch, id, ["src/a.js#fetch"]);
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).report({
      change_id: id, stage: "develop", agent_version: "dev@v1", harness: "claude-code", model: "m", cost_usd: 0,
      duration_ms: 1, session: "s", verdict: "pass", dirty: false, started_at: "2026-10-05T00:00:00Z",
    });
    // ana (person author) and dev@v1 (agent author) own the most; dee owns only an untouched path.
    await env.DB.prepare("INSERT INTO owners (repo, path, owner, weight) VALUES (?1, 'src/a.js', 'ana@example.com', 9), (?1, 'src/a.js', 'dev@v1', 8), " +
      "(?1, 'src/a.js', 'bo', 1), (?1, 'src/a.js#fetch', 'cy', 0.5), (?1, 'src/a.js', 'cy', 1), (?1, 'src/z.js', 'dee', 20)").bind(repo_id).run();
    const res = await call(`/api/changes/${id}/reviewers/suggested`, undefined, "GET");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual([{ owner: "cy", weight: 1.5, owns: 2, touched: 2 }, { owner: "bo", weight: 1, owns: 1, touched: 2 }]);
  });

  // A change on head sha1 with the owner requested as reviewer, taken through a passing verify report. No risk judgment
  // answers (the AI call fails), so its route is auto and only the requested reviewer can hold it.
  async function verifiedWithReviewer(name) {
    const fake = fakeArtifacts();
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const e = { ...env, ARTIFACTS: fake, AI: fakeClefAI(async () => { throw new Error("no judge"); }) };
    const call = (path, body, method = "POST", token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), e,
    );
    expect((await call("/api/repos", { name })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const { id, repo_id } = await (await call(`/api/repos/${name}/changes`, { intent: "add retries" })).json();
    expect((await call(`/api/changes/${id}/reviewers`, { person: "owner" })).status).toBe(200);
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.moveHead("sha1");
    for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: id, result: "ok" });
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const runner = (await (await call("/api/runners", { name: "lab", kinds: ["verify"] })).json()).token;
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')")
      .bind(job, repo_id, id, new Date().toISOString()).run();
    expect((await (await call("/api/work/claim", { kinds: ["verify"] }, "POST", runner)).json()).job.id).toBe(job);
    const report = await (await call(`/api/work/jobs/${job}/report`, { status: "done" }, "POST", runner)).json();
    return { id, call, stub, report };
  }

  it("a verified change with a pending requested reviewer stays verifying when auto-queue is on", async () => {
    const { id, call, report } = await verifiedWithReviewer("rev-hold");
    expect(report.change.state).toBe("verifying");
    const detail = await (await call(`/api/changes/${id}`, undefined, "GET")).json();
    expect([detail.auto_queue, detail.review.route, detail.review.requested]).toEqual([true, "auto", [{ who: "owner", state: "pending" }]]);
    expect(validateChangeDetail(detail)).toEqual({ ok: true, errors: [] });
  });

  it("the last requested reviewer's approval queues the verified change", async () => {
    const { id, call, report } = await verifiedWithReviewer("rev-approve");
    expect(report.change.state).toBe("verifying");
    const approved = await (await call(`/api/changes/${id}/review`, { verdict: "approve" })).json();
    expect(approved.state).toBe("in_queue");
    expect(await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(id).first()).not.toBeNull();
  });

  it("auto-queue never enqueues while a requested reviewer hasn't approved the current head, even after a clean agent review", async () => {
    const { id, call, stub } = await verifiedWithReviewer("rev-agent");
    await stub.setReview({ route: "agent", reason: "risk high" });
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'review', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), (await stub.get()).repo_id, id, new Date().toISOString(), JSON.stringify({ agent_version: "reviewer@v2" })).run();
    const runner = (await (await call("/api/runners", { name: "rev", kinds: ["review"] })).json()).token;
    const { job } = await (await call("/api/work/claim", { kinds: ["review"] }, "POST", runner)).json();
    expect((await call(`/api/work/jobs/${job.id}/report`, { status: "done" }, "POST", runner)).status).toBe(200);
    expect((await stub.get()).state).toBe("verifying");
    expect(await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(id).first()).toBeNull();
    // The passed review no longer holds it: the requested person's approval of the head queues it.
    expect((await (await call(`/api/changes/${id}/review`, { verdict: "approve" })).json()).state).toBe("in_queue");
  });

  it("removing the last pending reviewer lets auto-queue fire within one readiness tick", async () => {
    const { id, call, stub } = await verifiedWithReviewer("rev-remove");
    expect((await call(`/api/changes/${id}/reviewers/owner`, undefined, "DELETE")).status).toBe(204);
    const change = await stub.get();
    expect(change).toMatchObject({ state: "in_queue", reviewers: [] });
    expect(change.events.find((e) => e.kind === "reviewer_removed")).toMatchObject({ actor: { type: "human", id: "owner" }, action: "reviewer.remove", target: "owner" });
    expect(validateChangeDetail(await (await call(`/api/changes/${id}`, undefined, "GET")).json())).toEqual({ ok: true, errors: [] });
    expect(await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(id).first()).not.toBeNull();
  });

  it("the change author without org.manage requests a reviewer", async () => {
    serveCerts();
    const fake = fakeArtifacts();
    env.ARTIFACTS = fake;
    onTestFinished(() => { vi.restoreAllMocks(); delete env.ARTIFACTS; });
    const call = (path, headers, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), { ...ACCESS, ARTIFACTS: fake });
    expect((await call("/api/repos", OWNER, { name: "rev-author" })).status).toBe(201);
    const { id } = await (await call("/api/repos/rev-author/changes", OWNER, { intent: "add retries", author: "rae@example.com" })).json();
    // rae holds no role at all: only authorship lets her in; anyone else without repo.write is refused.
    expect((await call(`/api/changes/${id}/reviewers`, await as("sam@example.com"), { person: "bo@example.com" })).status).toBe(403);
    const res = await call(`/api/changes/${id}/reviewers`, await as("rae@example.com"), { person: "bo@example.com" });
    expect(res.status).toBe(200);
    expect(JSON.stringify(await res.json())).toContain("bo@example.com");
  });
});
