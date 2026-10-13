import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A repo with one change, verifying on head sha1 and routed to a human, and a need of `kind` about it.
async function setup(name, kind, actions, subject) {
  const fake = fakeArtifacts();
  const call = (path, body, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });
  const { id } = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
  for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: id, result: "ok" });
  await stub.setReview({ route: "human", reason: "risk high" });
  await stub.moveHead("sha1");
  await stub.stageEvent({ kind: "verify_done", actor: { type: "system", id: "test" }, action: "job.report", target: id, result: "ok" },
    { verdict: { sha: "sha1", status: "pass", at: new Date().toISOString() } });
  // Only cinder raises needs (flows, releases), so the test writes the row as they do.
  const need = { id: crypto.randomUUID() };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO needs (id, kind, repo, change_id, text, actions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(need.id, kind, name, id, `${kind} on ${id}`, JSON.stringify(actions), new Date().toISOString()),
    ...(subject ? [env.DB.prepare("INSERT INTO need_subjects (need_id, subject) VALUES (?, ?)").bind(need.id, JSON.stringify(subject))] : []),
  ]);
  const resolve = (action) => call(`/api/needs/${need.id}/resolve`, { action });
  const open = async () => (await (await call("/api/needs", undefined, "GET")).json()).some((n) => n.id === need.id);
  return { id, stub, call, resolve, open };
}

describe("needs you decisions", () => {
  it("a need about an agent's change names the agent@version that wrote it", async () => {
    const { id, stub, call } = await setup("need-agent", "Untrusted judge", ["Approve change"]);
    await stub.transition("needs_fix", { kind: "claimed", actor: { type: "system", id: "r1", agent_version: "developer@v8" }, action: "job.claim", target: id, result: "ok" });
    const needs = await (await call("/api/needs", undefined, "GET")).json();
    expect(needs.find((n) => n.change === id).agent).toBe("developer@v8");
  });

  it("POST /api/needs is not a route", async () => {
    const res = await worker.fetch(new Request("http://cinder.test/api/needs", { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
      body: JSON.stringify({ kind: "Judges disagree", repo: "r", change: null, text: "t", actions: ["Merge"] }) }), env);
    expect(res.status).toBe(404);
  });

  it("Merge on a Judges disagree need records a human approval, moves the verified human-routed change to in_queue and resolves the need", async () => {
    const { stub, resolve, open } = await setup("need-merge", "Judges disagree", ["Merge", "Reject", "Open change"]);
    expect((await resolve("Merge")).status).toBe(200);
    const change = await stub.get();
    expect(change.state).toBe("in_queue");
    expect(change.approvals).toEqual([{ actor: { type: "human", id: "owner" }, head_sha: "sha1", at: expect.any(String) }]);
    expect(await open()).toBe(false);
  });

  it("Reject closes the change; Approve change records an approval", async () => {
    const judges = await setup("need-reject", "Judges disagree", ["Merge", "Reject", "Open change"]);
    expect((await judges.resolve("Reject")).status).toBe(200);
    expect((await judges.stub.get()).state).toBe("closed");
    expect(await judges.open()).toBe(false);
    const untrusted = await setup("need-approve", "Untrusted judge", ["Approve change", "Open change"]);
    expect((await untrusted.resolve("Approve change")).status).toBe(200);
    expect((await untrusted.stub.get()).approvals).toEqual([{ actor: { type: "human", id: "owner" }, head_sha: "sha1", at: expect.any(String) }]);
    expect(await untrusted.open()).toBe(false);
  });

  it("Grant to <person> on a Lease takeover need makes the subject's person drive the leased change", async () => {
    const { stub, resolve, open } = await setup("need-grant", "Lease takeover", ["Grant to ana", "Keep agent lease"], { path: "main.tf", person: "ana" });
    expect((await resolve("Grant to ana")).status).toBe(200);
    expect((await stub.get()).driver).toBe("ana");
    expect(await open()).toBe(false);
  });

  it("when the operation fails (the change is already merged), resolve returns its error and the need stays unresolved", async () => {
    const { stub, resolve, open } = await setup("need-fail", "Judges disagree", ["Merge", "Reject", "Open change"]);
    await runInDurableObject(stub, async (i) => i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "merged" }));
    const res = await resolve("Merge");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("not_ready");
    expect(await open()).toBe(true);
  });

  it("POST /api/needs/:id/resolve {action: Open change} is 400 and the need stays open", async () => {
    const { stub, resolve, open } = await setup("need-nav", "Judges disagree", ["Merge", "Reject", "Open change"]);
    expect((await resolve("Open change")).status).toBe(400);
    expect(await open()).toBe(true);
    expect((await stub.get()).state).toBe("verifying");
  });
});
