import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeClefAI } from "./fakes/ai.js";

const AI = fakeClefAI(async () => ({ secret: 0, agent_instructions: 0, file_type: 0 }));
const LEFT_PAD = [{ ecosystem: "npm", name: "left-pad", version: "1.3.0", license: "MIT", class: "permissive" }];

// A repo with one verifying change and a runner that reports guard jobs on it; OSV answers with no vulns.
async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: body ? "POST" : "GET",
    headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake, AI });
  await call("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
  await env.DB.prepare("DELETE FROM jobs WHERE change_id = ?").bind(change.id).run();
  for (const s of ["developing", "verifying"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: change.id, result: "ok" });
  await stub.moveHead("sha1");
  // A person drives it: an agent's quarantined change goes back for a fix instead of raising Needs you items (guard.js).
  await stub.setDriver("dev@example.com");
  await env.DB.prepare("INSERT OR REPLACE INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, 'guard', 'clef', 'clef@1')").bind(change.repo_id).run();
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => Response.json({ results: JSON.parse(init.body).queries.map(() => ({})) }));
  onTestFinished(() => fetch.mockRestore());
  const token = (await (await call("/api/runners", { name: "lab", kinds: ["guard"] })).json()).token;
  const guard = async (report) => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'guard', ?, 'queued', ?, json_object('after', 'sha1'))")
      .bind(id, change.repo_id, change.id, new Date().toISOString()).run();
    const run = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` },
      body: JSON.stringify(body) }), { ...env, ARTIFACTS: fake, AI });
    await run("/api/work/claim", { kinds: ["guard"] });
    expect((await run(`/api/work/jobs/${id}/report`, { status: "done", diff: "", ...report })).status).toBe(200);
  };
  const needs = async (kind) => (await (await call("/api/needs")).json()).filter((n) => n.change === change.id && n.kind === kind);
  const blockers = async (code) => (await (await call(`/api/changes/${change.id}`)).json()).blockers.filter((b) => b.code === code);
  // The why-line on the board card, in the change's readiness and on its open Needs you items.
  const whys = async () => [(await (await call(`/api/repos/${name}/changes`)).json()).find((c) => c.id === change.id).blocked,
    (await (await call(`/api/changes/${change.id}`)).json()).blocked, ...(await (await call("/api/needs")).json()).filter((n) => n.change === change.id).map((n) => n.text)];
  return { id: change.id, stub, call, guard, needs, blockers, whys };
}

describe("blocker needs", () => {
  it("a quarantined change raises a Change quarantined need and Release unblocks the merge", async () => {
    const { id, stub, call, guard, needs, blockers } = await setup("bn-quarantine");
    await guard({ findings: [{ rule: "aws-access-key", path: "a.js", line: 3 }] });
    const raised = await needs("Change quarantined");
    expect(raised).toMatchObject([{ actions: ["Release", "Keep"], text: expect.stringContaining("deterministic: aws-access-key") }]);
    expect(await blockers("guard_quarantined")).toHaveLength(1);
    // A failed quarantined change's why names the quarantine.
    await runInDurableObject(stub, async (i) => i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "failed" }));
    expect((await (await call(`/api/changes/${id}`)).json()).failure).toEqual({ stage: "guard", reason: "quarantined: deterministic: aws-access-key" });
    await runInDurableObject(stub, async (i) => i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "verifying" }));
    expect((await call(`/api/needs/${raised[0].id}/resolve`, { action: "Release" })).status).toBe(200);
    expect((await stub.get()).guard.status).toBe("clear");
    expect(await blockers("guard_quarantined")).toEqual([]);
    expect(await needs("Change quarantined")).toEqual([]);
  });

  it("an unapproved dependency raises one need and Approve unblocks the merge", async () => {
    const { call, guard, needs, blockers } = await setup("bn-deps");
    await guard({ findings: [], deps: [...LEFT_PAD, { ...LEFT_PAD[0], name: "right-pad" }] });
    const raised = await needs("Dependency needs approval");
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ actions: ["Approve", "Reject", "Open change"], text: expect.stringContaining("Blocked: new dependencies left-pad 1.3.0, right-pad 1.3.0 need approval") });
    expect(await blockers("dependency_unapproved")).toHaveLength(2);
    expect((await call(`/api/needs/${raised[0].id}/resolve`, { action: "Approve" })).status).toBe(200);
    expect(await blockers("dependency_unapproved")).toEqual([]);
    expect(await needs("Dependency needs approval")).toEqual([]);
    // Reject on a fresh guard result sends the change back for a fix.
    await guard({ findings: [], deps: LEFT_PAD });
    const [again] = await needs("Dependency needs approval");
    expect((await call(`/api/needs/${again.id}/resolve`, { action: "Reject", reason: "We retry in-house" })).status).toBe(200);
    expect((await (await call(`/api/changes/${again.change}`)).json()).events.find((e) => e.kind === "changes_requested").reason).toBe("Dependency rejected: We retry in-house");
  });

  it("the why-text is the same on the card, in readiness and in Needs you", async () => {
    const { guard, whys } = await setup("bn-why");
    await guard({ findings: [], deps: LEFT_PAD });
    const [card, readiness, need] = await whys();
    expect(card).toBe("Blocked: new dependency left-pad 1.3.0 needs approval");
    expect(readiness).toBe(card);
    expect(need.startsWith(`${card} · guarded `)).toBe(true);
  });

  it("resolving it clears all three", async () => {
    const { call, guard, needs, whys } = await setup("bn-clear");
    await guard({ findings: [{ rule: "binary", path: "x.bin" }] });
    expect((await whys())[0]).toBe("Blocked: quarantined (deterministic: binary)");
    expect((await call(`/api/needs/${(await needs("Change quarantined"))[0].id}/resolve`, { action: "Release" })).status).toBe(200);
    expect(await whys()).toEqual([undefined, undefined]);
    await guard({ findings: [], deps: LEFT_PAD });
    expect((await call(`/api/needs/${(await needs("Dependency needs approval"))[0].id}/resolve`, { action: "Approve" })).status).toBe(200);
    expect(await whys()).toEqual([undefined, undefined]);
  });

  it("closing the change resolves its blocker needs", async () => {
    const { id, call, guard, needs } = await setup("bn-close");
    await guard({ findings: [{ rule: "binary", path: "x.bin" }], deps: LEFT_PAD });
    expect(await needs("Change quarantined")).toHaveLength(1);
    expect(await needs("Dependency needs approval")).toHaveLength(1);
    expect((await call(`/api/changes/${id}/close`, {})).status).toBe(200);
    expect(await needs("Change quarantined")).toEqual([]);
    expect(await needs("Dependency needs approval")).toEqual([]);
  });
});
