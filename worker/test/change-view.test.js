import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

describe("change view", () => {
  it("turning auto-queue on for a green change queues it", async () => {
    const fake = fakeArtifacts();
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const call = (path, body, method = "POST") => worker.fetch(
      new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake },
    );
    expect((await call("/api/repos", { name: "cv-auto" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("cv-auto")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const { id } = await (await call("/api/repos/cv-auto/changes", { intent: "add retries" })).json();
    expect((await call(`/api/changes/${id}/auto_queue`, { auto_queue: false }, "PATCH")).status).toBe(204);
    // Green: verifying with the route a passing verify stores, held only by auto-queue being off.
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: id, result: "ok" });
    await stub.setReview({ route: "auto", reason: "no risk judgment" });
    await stub.stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: id, result: "ok" },
      { head: "h1", verdict: { sha: "h1", status: "pass", at: new Date().toISOString() } });
    expect((await call(`/api/changes/${id}/auto_queue`, { auto_queue: true }, "PATCH")).status).toBe(204);
    expect((await stub.get()).state).toBe("in_queue");
    expect(await env.DB.prepare("SELECT 1 FROM queue_entries WHERE change_id = ?").bind(id).first()).not.toBeNull();
  });
});
