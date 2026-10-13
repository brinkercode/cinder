import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { signedIn } from "./helpers/edge.js";

const OWNER = `Bearer ${env.OWNER_TOKEN}`;
const call = (path, method = "GET", body, auth = OWNER) => worker.fetch(signedIn(path, { method, headers: { Authorization: auth }, body: body && JSON.stringify(body) }), env);
const usageOf = (person) => env.DB.prepare("SELECT tokens, runs FROM model_usage WHERE person = ?").bind(person).first();
// A job claimed by runner id, asked for by requester (none when null).
const job = async (runner, requester) => {
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, runner_id, created_at, payload) VALUES (?, 'r', 'develop', 'claimed', ?, ?, '{}')")
    .bind(id, runner, new Date().toISOString()).run();
  if (requester) await env.DB.prepare("INSERT INTO job_requesters VALUES (?, ?)").bind(id, requester).run();
  return id;
};

it("usage posted by the runner for a job is recorded against its requester", async () => {
  const { id, token } = await (await call("/api/runners", "POST", { name: "usage", kinds: ["develop"] })).json();
  const body = { job: await job(id, "owner"), person: "someone-else", provider: "anthropic", source: "org", tokens: 120, cost_usd: 0.25 };
  expect((await call("/api/work/model-usage", "POST", body, `Bearer ${token}`)).status).toBe(204);
  expect(await usageOf("owner")).toEqual({ tokens: 120, runs: 1 });
  expect(await usageOf("someone-else")).toBeNull();

  // A job nobody asked for, or another runner's job, stays this runner's.
  const { id: other } = await (await call("/api/runners", "POST", { name: "other", kinds: ["develop"] })).json();
  for (const j of [await job(id, null), await job(other, "owner")]) {
    expect((await call("/api/work/model-usage", "POST", { ...body, job: j }, `Bearer ${token}`)).status).toBe(204);
  }
  expect(await usageOf(`runner:${id}`)).toEqual({ tokens: 240, runs: 2 });
  expect(await usageOf("owner")).toEqual({ tokens: 120, runs: 1 });
});

it("a run before any key is saved leaves Anthropic showing Connect", async () => {
  const { id, token } = await (await call("/api/runners", "POST", { name: "no-key", kinds: ["develop"] })).json();
  const body = { job: await job(id, "owner"), provider: "anthropic", source: "org", tokens: 0, cost_usd: 0, error: "gateway answered 401" };
  expect((await call("/api/work/model-usage", "POST", body, `Bearer ${token}`)).status).toBe(204);
  const me = await (await call("/api/me/models")).json();
  // No source and status missing is the row the page renders with Connect.
  expect(me.providers.find((p) => p.id === "anthropic")).toMatchObject({ source: null, status: "missing", last_used_at: null });
});
