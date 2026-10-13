import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { runInDurableObject } from "cloudflare:test";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { validateHandover, validateLeaseMap } from "../src/api/contract.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const fake = fakeArtifacts();
const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: body ? "POST" : "GET", headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });

// A repo whose change c holds a granted lease on src/a.js#two.
async function holder(name) {
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "Rework two" })).json();
  await env.REPO_DO.get(env.REPO_DO.idFromName(name)).grant("main", change.id, ["src/a.js#two"]);
  return change;
}

describe("lease handover requests", () => {
  it("a request to the holder is recorded with the lease's expiry and reaches its agent", async () => {
    const c = await holder("handover-ask");
    expect((await call(`/api/leases/${c.id}/handover-request`, { symbol: "src/b.js#x", intent: "Edit two" })).status).toBe(409);
    const res = await call(`/api/leases/${c.id}/handover-request`, { symbol: "src/a.js#two", intent: "Edit two" });
    expect(res.status).toBe(201);
    const r = await res.json();
    expect(validateHandover(r).errors).toEqual([]);
    expect(r).toMatchObject({ holder: c.id, requester: "owner", status: "requested", reason: null });
    expect(Date.parse(r.expires_at)).toBeGreaterThan(Date.now());
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c.id)).takeMessages())[0].text).toContain("Edit two");
    const map = await (await call("/api/repos/handover-ask/lease-map")).json();
    expect(validateLeaseMap(map).errors).toEqual([]);
    expect(map.leases[0].expires_at).toBe(r.expires_at);
  });

  it("a decline carries the holder's reason, a cancel closes the request, and an unanswered request reads expired", async () => {
    const c = await holder("handover-answer");
    const ask = async () => (await (await call(`/api/leases/${c.id}/handover-request`, { symbol: "src/a.js#two", intent: "Edit two" })).json());
    const answer = (r, body) => call(`/api/leases/${c.id}/handover-request/${r.id}/answer`, body);
    const a = await ask();
    expect((await answer(a, { answer: "declined" })).status).toBe(400);
    expect(await (await answer(a, { answer: "declined", reason: "mid-commit" })).json()).toMatchObject({ status: "declined", reason: "mid-commit" });
    expect((await answer(a, { answer: "cancelled" })).status).toBe(409);
    const b = await ask();
    expect(await (await answer(b, { answer: "cancelled" })).json()).toMatchObject({ status: "cancelled" });
    const d = await ask();
    await env.DB.prepare("UPDATE handover_requests SET expires_at = '2020-01-01T00:00:00.000Z' WHERE id = ?").bind(d.id).run();
    expect(await (await call(`/api/leases/${c.id}/handover-request/${d.id}`)).json()).toMatchObject({ status: "expired" });
  });
});
