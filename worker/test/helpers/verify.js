import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect } from "vitest";
import worker from "../../src/index.js";
import { fakeArtifacts } from "../fakes/artifacts.js";

export const SHA = "a".repeat(40);

// A repo with one change at head SHA and a runner; verify() claims a fresh verify job for it and reports body.
export async function verifyRepo(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["verify"] })).json()).token;
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, ?)").bind(change.id, SHA).run();
  const repo = (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first()).id;
  const verify = async (body) => {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    // A failed verify leaves the change in needs_fix; a push puts it back in verifying.
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).transition("verifying", {
      kind: "verify_queued", actor: { type: "system", id: "cinder" }, action: "change.push", target: change.id, result: "ok" });
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, '{}')")
      .bind(crypto.randomUUID(), repo, change.id, new Date().toISOString()).run();
    const claim = await (await call("/api/work/claim", { kinds: ["verify"], slots_free: 1 }, runner)).json();
    expect(claim.job.change_id).toBe(change.id);
    return { job: claim.job, res: await call(`/api/work/jobs/${claim.job.id}/report`, body, runner) };
  };
  return { call, repo, change, verify };
}
