import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { routes } from "../src/routes.js";

it("POST /promotions is not a route", () => {
  expect(Object.keys(routes).filter((r) => r.includes("promotions"))).toEqual([]);
});

it("PUT /api/teams/:team is not a route", async () => {
  const res = await worker.fetch(new Request("http://cinder.test/api/teams/web", {
    method: "PUT", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify({ role: "viewer", members: ["ana@example.com"] }),
  }), env);
  expect(res.status).toBe(404);
});

it("GET /api/inbox is gone", async () => {
  const res = await worker.fetch(new Request("http://cinder.test/api/inbox", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
  expect(res.status).toBe(404);
});

it("environment secret routes answer 404", async () => {
  expect(Object.keys(routes).filter((r) => r.includes("/environments/:env/secrets"))).toEqual([]);
  const call = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body }), env);
  expect((await call("GET", "/api/repos/pulse/environments/production/secrets")).status).toBe(404);
  expect((await call("PUT", "/api/repos/pulse/environments/production/secrets/STRIPE_KEY", JSON.stringify({ value: "sk_live_value" }))).status).toBe(404);
});

it("GET /api/repos/:name/queues is not a route", () => {
  expect(Object.keys(routes).filter((r) => r.endsWith("/queues"))).toEqual([]);
});

it("the removed change and code routes answer 404", async () => {
  const removed = [
    ["POST", "/api/changes/c1/approve"], ["PUT", "/api/changes/c1/acceptance"], ["POST", "/api/changes/c1/label"],
    ["GET", "/api/repos/r/owners"], ["GET", "/api/repos/r/why"], ["GET", "/api/repos/r/conflicts"], ["GET", "/api/repos/r/leases"],
    ["GET", "/api/search?q=x"], ["GET", "/api/repos/r/wiki/pages/p/history/1"], ["POST", "/api/repos/r/jobs/cancel"],
  ];
  for (const [method, path] of removed) {
    const res = await worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    expect([path, res.status, (await res.json()).error.message]).toEqual([path, 404, "no such route"]);
  }
});

it("the removed insights, watchtower and admin routes answer 404", async () => {
  await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('gone', 'gone', 'main', 'trunk', '{}', '2026-10-01T00:00:00Z')").run();
  const call = (key, token = env.OWNER_TOKEN) => {
    const [method, path] = key.split(" ");
    return worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: method === "POST" ? "[]" : undefined }), env);
  };
  const { token } = await (await worker.fetch(new Request("http://cinder.test/api/runners", { method: "POST",
    headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify({ name: "routes-gone", kinds: ["index"] }) }), env)).json();
  const gone = ["GET /api/insights", "GET /api/repos/gone/metrics", "POST /api/repos/gone/regressions", "GET /api/repos/gone/judgments",
    "GET /api/repos/gone/posture", "GET /api/repos/gone/scans", "GET /api/repos/gone/evidence"];
  for (const key of gone) expect(await (await call(key)).json(), key).toEqual({ error: { code: "not_found", message: "no such route" } });
  for (const key of ["POST /api/work/repos/gone/inherited", "POST /api/work/races/inherited"]) {
    expect(await (await call(key, token)).json(), key).toEqual({ error: { code: "not_found", message: "no such route" } });
  }
  expect((await call("GET /api/repos/gone/watchtower/scans")).status).toBe(200);
});

it("POST /push-token is not a route", async () => {
  expect(Object.keys(routes).filter((r) => r.includes("push-token"))).toEqual([]);
  const res = await worker.fetch(new Request("http://cinder.test/api/repos/pulse/push-token", { method: "POST", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
  expect(res.status).toBe(404);
});

it("GET /api/runners is not a route", async () => {
  expect(Object.keys(routes)).not.toContain("GET /api/runners");
  expect(Object.keys(routes)).not.toContain("DELETE /api/runners/:id");
  const res = await worker.fetch(new Request("http://cinder.test/api/runners", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
  expect(res.status).toBe(404);
});
