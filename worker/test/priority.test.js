import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

async function setup(name, base = env) {
  const fake = fakeArtifacts();
  const call = (path, body, method = "POST", headers = OWNER) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers, body: body && JSON.stringify(body) }), { ...base, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  return call;
}

describe("change priority", () => {
  it("an urgent change's develop job is claimed before an older normal one", async () => {
    const call = await setup("prio-claim");
    const older = await (await call("/api/repos/prio-claim/changes", { intent: "older normal" })).json();
    const urgent = await (await call("/api/repos/prio-claim/changes", { intent: "newer urgent", priority: "P0" })).json();
    // Only these two develop jobs are queued, the normal one an hour older.
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    const job = (change, at) => env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, '{}')")
      .bind(`job-${change.id}`, change.repo_id, change.id, at).run();
    await job(older, new Date(Date.now() - 3600_000).toISOString());
    await job(urgent, new Date().toISOString());
    const token = (await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json()).token;
    const claim = await (await call("/api/work/claim", { kinds: ["develop"] }, "POST", { Authorization: `Bearer ${token}` })).json();
    expect(claim.job.id).toBe(`job-${urgent.id}`);
  });

  it("PATCH changes labels and priority and publishes the change", async () => {
    const call = await setup("prio-patch");
    const { id } = await (await call("/api/repos/prio-patch/changes", { intent: "tidy cart", draft: true })).json();
    const { ticket } = await (await call("/api/live-ticket", { repo: "prio-patch" })).json();
    const ws = (await call(`/api/repos/prio-patch/live?ticket=${ticket}`, undefined, "GET", { ...OWNER, Origin: "http://cinder.test", Upgrade: "websocket" })).webSocket;
    ws.accept();
    onTestFinished(() => ws.close());
    const updated = new Promise((resolve) => ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (m.kind === "work.updated") resolve(m);
    }));
    expect((await call(`/api/changes/${id}`, { priority: "sometime" }, "PATCH")).status).toBe(400);
    expect((await call(`/api/changes/${id}`, { labels: [""] }, "PATCH")).status).toBe(400);
    const res = await call(`/api/changes/${id}`, { priority: "P1", labels: ["cart"] }, "PATCH");
    expect(res.status).toBe(200);
    const change = await res.json();
    expect(change).toMatchObject({ priority: "P1", labels: ["cart"] });
    expect(change.events.at(-1)).toMatchObject({ kind: "edited", action: "change.edit", actor: { type: "human", id: "owner" } });
    expect(await updated).toMatchObject({ kind: "work.updated", item: { change_id: id, labels: ["cart"] } });
  });

  it("a viewer's PATCH answers 403", async () => {
    serveCerts();
    onTestFinished(() => vi.restoreAllMocks());
    const call = await setup("prio-viewer", ACCESS);
    const { id } = await (await call("/api/repos/prio-viewer/changes", { intent: "tidy cart", draft: true, author: "ann@example.com" })).json();
    await env.DB.prepare("INSERT INTO person_roles VALUES ('view@example.com', 'viewer') ON CONFLICT (email) DO UPDATE SET role = excluded.role").run();
    expect((await call(`/api/changes/${id}`, { priority: "P0" }, "PATCH", await as("view@example.com"))).status).toBe(403);
    // The refusal is the role: the change's author, who holds none, may edit it.
    expect((await call(`/api/changes/${id}`, { priority: "P0" }, "PATCH", await as("ann@example.com"))).status).toBe(200);
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).priority).toBe("P0");
  });
});
