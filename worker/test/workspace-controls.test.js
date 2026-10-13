import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN, method = "POST") => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  await runInDurableObject(repoDO, (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed') AND change_id <> ?").bind(change.id).run();
  await repoDO.grant(change.target_branch, change.id, ["a.js#f"], []);
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json()).token;
  return { call, change, runner, held: async () => (await repoDO.leases(change.target_branch))[change.id]?.granted === true };
}

describe("workspace controls", () => {
  it("release frees the lease immediately and pauses the agent", async () => {
    const { call, change, runner, held } = await setup("ws-release");
    expect(await held()).toBe(true);
    const res = await call(`/api/leases/${change.id}`, null, env.OWNER_TOKEN, "DELETE");
    expect(res.status).toBe(200);
    expect((await res.json()).driver).toBe("owner");
    expect(await held()).toBe(false);
    expect((await call("/api/work/claim", { kinds: ["develop"] }, runner)).status).toBe(204);
  });

  it("release is refused while the change is mid-commit", async () => {
    const { call, change, held } = await setup("ws-midcommit");
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES ('mc-1', ?, 'commit', ?, 'claimed', ?, '{}')")
      .bind(change.repo_id, change.id, new Date().toISOString()).run();
    const res = await call(`/api/leases/${change.id}`, null, env.OWNER_TOKEN, "DELETE");
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toContain("mid-commit");
    expect(await held()).toBe(true);
  });

  it("give it back re-grants the lease", async () => {
    const { call, change, held } = await setup("ws-giveback");
    await call(`/api/leases/${change.id}`, null, env.OWNER_TOKEN, "DELETE");
    expect(await held()).toBe(false);
    expect((await call(`/api/changes/${change.id}/release`)).status).toBe(200);
    expect(await held()).toBe(true);
  });

  it("a message reaches the agent before its next tool call", async () => {
    const { call, change, runner } = await setup("ws-steer");
    expect((await call(`/api/changes/${change.id}/steer`, { message: "use the helper" })).status).toBe(202);
    expect((await call(`/api/changes/${change.id}/steer`, { message: " " })).status).toBe(400);
    const claim = await (await call("/api/work/claim", { kinds: ["develop"] }, runner)).json();
    expect(claim.payload.messages).toEqual([{ text: "use the helper", by: "owner", at: expect.any(String) }]);
  });
});
