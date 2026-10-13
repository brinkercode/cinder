import { env } from "cloudflare:workers";
import { beforeEach, expect, it, onTestFinished, vi } from "vitest";
import worker from "../src/index.js";
import { validateAccount, validateFleet, validateNeed } from "../src/api/contract.js";
import { raiseBudgetNeeds } from "../src/needs.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, body, headers = OWNER, e = env) => worker.fetch(
  new Request(`http://cinder.test${path}`, { method: body ? "POST" : "GET", headers, body: body && JSON.stringify(body) }), e);
const spend = (tokens) => env.DB.prepare("INSERT INTO usage_logs (id, repo_id, at, tokens, cost_usd) VALUES (?, 'budget', ?, ?, 0)")
  .bind(crypto.randomUUID(), new Date().toISOString(), tokens).run();
// A queued job of kind on repo; a develop job needs a change id to be claimable.
const queue = (repo, kind, payload = {}) => env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?1, ?2, ?3, 'c-' || ?1, 'queued', ?4, ?5)")
  .bind(crypto.randomUUID(), repo, kind, new Date().toISOString(), JSON.stringify(payload)).run();
const claim = (repo, kinds) => env.DISPATCH_DO.get(env.DISPATCH_DO.idFromName("global")).claim("r-budget", kinds, repo, false, 99);
const reached = async () => (await (await call("/api/needs")).json()).filter((n) => n.kind === "Budget reached");

beforeEach(async () => {
  await env.DB.batch([env.DB.prepare("DELETE FROM usage_logs"), env.DB.prepare("DELETE FROM needs WHERE kind = 'Budget reached'"),
    env.DB.prepare("UPDATE account SET budget_tokens = 1000 WHERE id = 1"), env.DB.prepare("DELETE FROM budget_policy")]);
});

it("no develop job is claimed once month spend reaches the budget, and verify still is", async () => {
  await queue("budget-a", "develop", { repair: 1, max: 2 });
  await queue("budget-a", "verify");
  await spend(1000);
  expect(await claim("budget-a", ["develop"])).toBeNull();
  expect((await claim("budget-a", ["develop", "verify"])).kind).toBe("verify");
});

it("reaching the budget raises one Budget reached need and the account reports paused", async () => {
  await spend(999);
  await raiseBudgetNeeds(env);
  expect(await reached()).toEqual([]);
  expect(await (await call("/api/account")).json()).toMatchObject({ budget_tokens: 1000, spent: 999, paused: false });
  await spend(1);
  await raiseBudgetNeeds(env);
  await raiseBudgetNeeds(env);
  const needs = await reached();
  expect(needs).toHaveLength(1);
  expect(validateNeed(needs[0]).ok).toBe(true);
  expect(needs[0]).toMatchObject({ repo: "account", change: null, actions: ["Raise budget", "Resume"] });
  const account = await (await call("/api/account")).json();
  expect(validateAccount(account).ok).toBe(true);
  expect(account).toMatchObject({ budget_tokens: 1000, spent: 1000, paused: true });
});

it("raising the budget above spend and resuming lets agent jobs claim again", async () => {
  await queue("budget-c", "develop");
  await spend(1000);
  await raiseBudgetNeeds(env);
  const [need] = await reached();
  const resume = await call(`/api/needs/${need.id}/resolve`, { action: "Resume" });
  expect(resume.status).toBe(409);
  expect((await resume.json()).error.code).toBe("over_budget");
  expect((await call(`/api/needs/${need.id}/resolve`, { action: "Raise budget", amount: 5000 })).status).toBe(200);
  expect((await reached()).map((n) => n.id)).toEqual([need.id]);
  expect((await call(`/api/needs/${need.id}/resolve`, { action: "Resume" })).status).toBe(200);
  expect(await reached()).toEqual([]);
  expect(await (await call("/api/account")).json()).toMatchObject({ budget_tokens: 5000, spent: 1000, paused: false });
  expect((await claim("budget-c", ["develop"])).kind).toBe("develop");
});

it("a developer raising the budget gets 403", async () => {
  serveCerts();
  onTestFinished(() => vi.restoreAllMocks());
  await env.DB.prepare("INSERT INTO person_roles VALUES ('dev@x.dev', 'developer') ON CONFLICT (email) DO UPDATE SET role = excluded.role").run();
  await spend(1000);
  await raiseBudgetNeeds(env);
  const [need] = await reached();
  const res = await call(`/api/needs/${need.id}/resolve`, { action: "Raise budget", amount: 5000 }, await as("dev@x.dev"), ACCESS);
  expect(res.status).toBe(403);
  expect(await (await call("/api/account")).json()).toMatchObject({ budget_tokens: 1000, paused: true });
});

it("runs in progress finish: a claimed agent job runs on while the budget pauses its agent", async () => {
  await env.DB.prepare("INSERT OR IGNORE INTO agent_roles VALUES ('developer', 'develop')").run();
  await queue("budget-d", "develop");
  const running = await claim("budget-d", ["develop"]);
  await queue("budget-d", "develop");
  await spend(1000);
  const fleet = await (await call("/api/fleet")).json();
  expect(validateFleet(fleet).ok).toBe(true);
  expect(fleet.agents.find((a) => a.name === "developer").paused).toEqual({ reason: "budget", resumes_at: (await (await call("/api/account")).json()).resets_at });
  expect(await claim("budget-d", ["develop"])).toBeNull();
  expect(await env.DB.prepare("SELECT status, id IN (SELECT job_id FROM job_cancels) AS cancelled FROM jobs WHERE id = ?").bind(running.id).first())
    .toEqual({ status: "claimed", cancelled: 0 });
});

it("alert only keeps agents running past the budget, and the account names the policy, reset and owners", async () => {
  await queue("budget-e", "develop");
  await spend(1000);
  const put = (body) => worker.fetch(new Request("http://cinder.test/api/account", { method: "PUT", headers: OWNER, body: JSON.stringify(body) }), env);
  expect((await put({ when_reached: "never" })).status).toBe(400);
  expect((await put({ when_reached: "alert" })).status).toBe(204);
  const account = await (await call("/api/account")).json();
  expect(validateAccount(account).ok).toBe(true);
  expect(account).toMatchObject({ spent: 1000, paused: false, when_reached: "alert", owners: expect.any(Array) });
  expect((await claim("budget-e", ["develop"])).kind).toBe("develop");
});
