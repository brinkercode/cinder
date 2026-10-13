import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index.js";

const call = (path, { token = env.OWNER_TOKEN, body, method = "POST", headers } = {}) => worker.fetch(
  new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}`, ...headers }, body: body && JSON.stringify(body) }), env);

// Repo `name` with one change whose develop job is leased to a new runner; returns that runner's token and the job.
async function leased(name) {
  const at = new Date().toISOString();
  const runner = await (await call("/api/runners", { body: { name: "lab", kinds: ["develop"] } })).json();
  const job = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', ?)").bind(`id-${name}`, name, at),
    env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'developing', ?)").bind(`${name}-c`, `id-${name}`, at),
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, runner_id, created_at, payload) VALUES (?, ?, 'develop', ?, 'claimed', ?, ?, '{}')")
      .bind(job, `id-${name}`, `${name}-c`, runner.id, at),
  ]);
  return { token: runner.token, job };
}

describe("work activity", () => {
  it("activity from the leased runner publishes work.activity at most once per second per change", async () => {
    const { token, job } = await leased("wa-live");
    const { ticket } = await (await call("/api/live-ticket", { body: { repo: "wa-live" } })).json();
    const ws = (await call(`/api/repos/wa-live/live?ticket=${ticket}`, { method: "GET", headers: { Origin: "http://cinder.test", Upgrade: "websocket" } })).webSocket;
    ws.accept();
    const seen = [];
    ws.addEventListener("message", (e) => { seen.push({ ...JSON.parse(e.data), got: Date.now() }); });
    for (const path of ["a.js", "b.js", "c.js"]) {
      expect((await call(`/api/work/jobs/${job}/activity`, { token, body: { activity: `editing ${path}`, path } })).status).toBe(204);
    }
    await new Promise((r) => setTimeout(r, 1500));
    ws.close();
    expect(seen.map(({ kind, repo, change_id, activity, path }) => ({ kind, repo, change_id, activity, path }))).toEqual([
      { kind: "work.activity", repo: "wa-live", change_id: "wa-live-c", activity: "editing a.js", path: "a.js" },
      // b.js was held and replaced by c.js, the last value inside the second.
      { kind: "work.activity", repo: "wa-live", change_id: "wa-live-c", activity: "editing c.js", path: "c.js" },
    ]);
    expect(seen[1].got - seen[0].got).toBeGreaterThanOrEqual(900);
  });

  it("activity for a job not leased to the runner is refused with 403", async () => {
    const { job } = await leased("wa-other");
    const other = await (await call("/api/runners", { body: { name: "other", kinds: ["develop"] } })).json();
    const res = await call(`/api/work/jobs/${job}/activity`, { token: other.token, body: { activity: "editing a.js", path: "a.js" } });
    expect(res.status).toBe(403);
    expect((await call(`/api/work/jobs/${crypto.randomUUID()}/activity`, { token: other.token, body: { activity: "editing a.js" } })).status).toBe(403);
  });
});
