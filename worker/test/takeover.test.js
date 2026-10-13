import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

// A change whose develop job a runner has claimed: the agent is driving.
async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  // Earlier tests leave jobs queued on other repos; only this change's develop job stays claimable.
  await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed') AND change_id <> ?").bind(change.id).run();
  const runner = (await (await call("/api/runners", { name: "lab", kinds: ["develop"], slots: 8 })).json()).token;
  const claim = await call("/api/work/claim", { kinds: ["develop"] }, runner);
  expect(claim.status).toBe(200);
  return { call, change, runner, job: (await claim.json()).job.id };
}

describe("takeover", () => {
  it("takeover cancels the running job and sets the driver", async () => {
    const { call, change, runner, job } = await setup("take-over");
    const res = await call(`/api/changes/${change.id}/takeover`);
    expect(res.status).toBe(200);
    expect((await res.json()).driver).toBe("owner");
    expect(await (await call(`/api/work/jobs/${job}/heartbeat`, null, runner)).json()).toMatchObject({ cancel: true });
    expect((await (await worker.fetch(new Request(`http://cinder.test/api/changes/${change.id}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env)).json()).driver).toBe("owner");
  });

  it("a message is included in the next resume prompt", async () => {
    const { call, change, runner, job } = await setup("take-msg");
    expect((await call(`/api/changes/${change.id}/messages`, { text: "use the existing helper" })).status).toBe(202);
    expect((await call(`/api/changes/${change.id}/messages`, { text: " " })).status).toBe(400);
    // The agent's next turn is the next develop job claimed for the change.
    await call(`/api/changes/${change.id}/takeover`);
    await call(`/api/changes/${change.id}/release`);
    const next = await (await call("/api/work/claim", { kinds: ["develop"], slots_free: 2 }, runner)).json();
    expect(next.job.id).not.toBe(job);
    expect(next.payload.messages).toEqual([{ text: "use the existing helper", by: "owner", at: expect.any(String) }]);
  });

  it("release re-queues the agent", async () => {
    const { call, change, runner, job } = await setup("take-release");
    await call(`/api/changes/${change.id}/takeover`);
    // Paused: the superseded job is the only one and it can't be claimed.
    expect((await call("/api/work/claim", { kinds: ["develop"] }, runner)).status).toBe(204);
    const res = await call(`/api/changes/${change.id}/release`);
    expect(res.status).toBe(200);
    expect((await res.json()).driver).toBe(null);
    const next = await call("/api/work/claim", { kinds: ["develop"], slots_free: 2 }, runner);
    expect(next.status).toBe(200);
    const queued = (await next.json()).job;
    expect(queued).toMatchObject({ kind: "develop", change_id: change.id });
    expect(queued.id).not.toBe(job);
    expect((await call(`/api/changes/${change.id}/release`)).status).toBe(409);
  });
});
