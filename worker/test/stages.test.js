import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

describe("stages", () => {
  it("a finished verify job appears in the change's stages and its card tokens", async () => {
    const fake = fakeArtifacts();
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), { ...env, ARTIFACTS: fake },
    );
    expect((await call("/api/repos", { name: "stages-verify" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("stages-verify")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const { id, repo_id } = await (await call("/api/repos/stages-verify/changes", { intent: "add retries" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    for (const s of ["leased", "developing", "verifying"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: id, result: "ok" });
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const runner = (await (await call("/api/runners", { name: "stages-lab", kinds: ["verify"] })).json()).token;
    const job = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')")
      .bind(job, repo_id, id, new Date().toISOString()).run();
    expect((await (await call("/api/work/claim", { kinds: ["verify"] }, runner)).json()).job.id).toBe(job);
    const res = await call(`/api/work/jobs/${job}/report`, { status: "failed", duration_ms: 4200, tokens: [100, 20, 7] }, runner);
    expect(res.status).toBe(200);
    expect(await stub.stages()).toMatchObject([{ change_id: id, stage: "verify", verdict: "fail", duration_ms: 4200, tokens: [100, 20, 7], session: job }]);
    const card = JSON.parse(await env.DB.prepare("SELECT card FROM change_cards WHERE change_id = ?").bind(id).first("card"));
    expect(card.tok).toEqual([100, 20, 7]);
  });

  it("rejects a report whose tokens are not [in, out, cache]", async () => {
    const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
      new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), env,
    );
    const runner = (await (await call("/api/runners", { name: "stages-bad", kinds: ["verify"] })).json()).token;
    const res = await call(`/api/work/jobs/${crypto.randomUUID()}/report`, { status: "done", tokens: [1, 2] }, runner);
    expect(res.status).toBe(400);
  });
});
