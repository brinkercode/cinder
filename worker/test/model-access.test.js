import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeEach, expect, it, onTestFinished, vi } from "vitest";
import { validateModelAccess } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";
import { signedIn } from "./helpers/edge.js";
import { WorkerLite } from "../src/workers.js";
import { invalidate, modelAccess } from "../../web/src/client.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";

const OWNER = `Bearer ${env.OWNER_TOKEN}`;
const cf = fakeCloudflare();
// A fake Containers binding: a container's id is its runner's id.
const containers = { idFromName: (name) => name, get: () => ({ start: async () => {}, stop: async () => {} }) };
const e = { ...env, ARTIFACTS: fakeArtifacts(), ...cf.env, WORKER_LITE: containers };
const fetchWorker = (url, init) => worker.fetch(signedIn(url, init), e);
const call = (path, method = "GET", body, auth = OWNER) => fetchWorker(path, { method, headers: { Authorization: auth }, body: body && JSON.stringify(body) });
// A pool worker's runner id: the id its container's model calls arrive with.
const poolWorker = async (name) => {
  await call("/api/workers/pools", "POST", { name, size: "lite", min: 1, max: 1, kinds: ["develop"] });
  return (await env.DB.prepare("SELECT m.runner_id FROM pool_members m JOIN worker_pools p ON p.id = m.pool_id WHERE p.name = ?").bind(name).first()).runner_id;
};
// The owner requests a change; a develop job for it is created and claimed by runnerId.
const claimRequestersJob = async (repo, runnerId) => {
  await call("/api/repos", "POST", { name: repo });
  env.ARTIFACTS = e.ARTIFACTS;
  onTestFinished(() => { delete env.ARTIFACTS; });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(repo)), (i) => { i.env = { ...i.env, ARTIFACTS: e.ARTIFACTS }; });
  const change = await (await call(`/api/repos/${repo}/changes`, "POST", { intent: "x" })).json();
  const job = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'develop', ?, 'queued', ?, '{}')")
    .bind(job, change.repo_id, change.id, new Date().toISOString()).run();
  await env.DB.prepare("UPDATE jobs SET status = 'claimed', runner_id = ?, lease_expires_at = ? WHERE id = ?").bind(runnerId, new Date(Date.now() + 60_000).toISOString(), job).run();
  return job;
};
const provider = async (id) => (await (await call("/api/me/models")).json()).providers.find((p) => p.id === id);

beforeEach(() => vi.stubGlobal("fetch", cf.fetch));
afterEach(() => { vi.unstubAllEnvs(); vi.unstubAllGlobals(); });

// Fake AI binding: records each gateway run as {id, data, options}.
const fakeGateway = (sent) => ({ gateway: (id) => ({ run: async (data, options) => { sent.push({ id, data, options }); return new Response("{}"); } }) });
// One gateway call through models.internal from runner's container, to path, answered with status.
const answered = (runner, path, status) => WorkerLite.outboundByHost["models.internal"](new Request(`http://models.internal${path}`, { method: "POST", body: "{}" }),
  { ...e, AI: { gateway: () => ({ run: async () => new Response("{}", { status }) }) } }, { containerId: runner, className: "WorkerLite" });
const modelCall = (person, containerId, sent = [], bindings = {}) => WorkerLite.outboundByHost["models.internal"](new Request("http://models.internal/anthropic/v1/messages", { method: "POST",
  headers: { "x-api-key": "via-gateway", "cf-aig-metadata": JSON.stringify({ person, job: "j1" }), "content-type": "application/json" },
  body: JSON.stringify({ model: "claude", messages: [] }) }), { ...e, AI: fakeGateway(sent), ...bindings }, { containerId, className: "WorkerLite" });

it("a models.internal call is forwarded through the gateway without AI_GATEWAY_TOKEN set", async () => {
  const sent = [];
  const res = await modelCall("owner", await claimedJob(null), sent, { AI_GATEWAY_TOKEN: undefined });
  expect(res.status).toBe(200);
  expect(sent).toEqual([{ id: "cinder", data: { provider: "anthropic", endpoint: "v1/messages", headers: { "content-type": "application/json" },
    query: { model: "claude", messages: [] } }, options: { extraHeaders: { "cf-aig-metadata": JSON.stringify({ person: "owner", job: "j1" }) } } }]);
});

it("a call for a person with their own key still carries their BYOK alias, and no provider key appears in the request cinder builds", async () => {
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-own3r-s3cret" })).status).toBe(204);
  expect((await call("/api/me/models", "PUT", { source: "mine" })).status).toBe(204);
  const [config] = [...cf.configs.values()];
  expect(config).toMatchObject({ provider_slug: "anthropic", alias: expect.stringMatching(/^p-[0-9a-f]{16}$/) });
  expect([...cf.secrets.values()].find((x) => x.name === `cinder_anthropic_${config.alias}`).value).toBe("sk-ant-own3r-s3cret");

  const runner = await poolWorker("ma-pool-own");
  await claimRequestersJob("ma-own", runner);
  const sent = [];
  await modelCall("owner", runner, sent);
  await modelCall("owner", await claimedJob(null), sent);
  const [own, other] = sent;
  expect(own.options.extraHeaders["cf-aig-byok-alias"]).toBe(config.alias);
  expect(other.options.extraHeaders["cf-aig-byok-alias"]).toBeUndefined();
  for (const { data, options } of sent) {
    expect(JSON.stringify([data, options])).not.toContain("sk-ant-own3r-s3cret");
    expect(data.headers["x-api-key"]).toBeUndefined();
    expect(data.headers.authorization).toBeUndefined();
  }
});

it("a model call whose metadata names another person still uses the job requester's alias", async () => {
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-own3r" })).status).toBe(204);
  expect((await call("/api/me/models", "PUT", { source: "mine" })).status).toBe(204);
  const runner = await poolWorker("ma-pool-other");
  await claimRequestersJob("ma-other", runner);
  const sent = [];
  await modelCall("someone-else", runner, sent);
  expect(sent[0].options.extraHeaders["cf-aig-byok-alias"]).toBe([...cf.configs.values()].find((c) => c.provider_slug === "anthropic").alias);
});

it("a pool worker with no claimed job is refused and nothing reaches the gateway", async () => {
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-own3r" })).status).toBe(204);
  expect((await call("/api/me/models", "PUT", { source: "mine" })).status).toBe(204);
  const runner = await poolWorker("ma-pool-idle");
  const sent = [];
  expect((await modelCall("owner", runner, sent)).status).toBe(403);
  expect((await modelCall("owner", "no-such-container", sent)).status).toBe(403);
  expect(sent).toEqual([]);
});

it("A key is never shown after saving: the save answers no body and GET returns only its method, stored in AI Gateway", async () => {
  const save = await call("/api/me/models/google", "PUT", { method: "key", value: "sk-g00gle-s3cret" });
  expect([save.status, await save.text()]).toEqual([204, ""]);
  const res = await call("/api/me/models");
  const text = await res.text();
  expect(validateModelAccess(JSON.parse(text))).toEqual({ ok: true, errors: [] });
  expect(text).not.toContain("sk-g00gle-s3cret");
  expect(await provider("google")).toEqual({ id: "google", name: "Google", source: "mine", method: "key", status: "unchecked", reason: null, last_used_at: null });
  const row = await env.DB.prepare("SELECT * FROM model_providers WHERE person = 'owner' AND provider = 'google'").first();
  expect(JSON.stringify(row)).not.toContain("sk-g00gle-s3cret");
  expect(cf.configs.get(row.config_id)).toMatchObject({ provider_slug: "google-ai-studio" });
});

it("The wizard in UI-11 reads this status live: a save, a failing provider check and a removal show on the next read", async () => {
  vi.stubEnv("VITE_FIXTURES", "0");
  vi.stubGlobal("fetch", cf.through(fetchWorker));
  // Each read opens the wizard afresh: the writes below go straight to the Worker, not through the page.
  const status = async () => { invalidate(); const p = (await modelAccess()).providers.find((x) => x.id === "xai"); return [p.status, p.reason]; };
  expect(await status()).toEqual(["missing", null]);
  await call("/api/me/models/xai", "PUT", { method: "key", value: "xai-k3y" });
  expect(await status()).toEqual(["unchecked", null]);
  const runner = await poolWorker("ma-pool-xai");
  await claimRequestersJob("ma-xai", runner);
  expect((await answered(runner, "/grok/v1/chat/completions", 401)).status).toBe(401);
  expect(await status()).toEqual(["failing", "xAI refused the key (HTTP 401)"]);
  await call("/api/me/models/xai", "DELETE");
  expect(await status()).toEqual(["missing", null]);
});

it("saving a key stores status unchecked; a gateway call that the key answers moves it to connected", async () => {
  expect((await call("/api/me/models/google", "PUT", { method: "key", value: "manual-key-1" })).status).toBe(204);
  expect((await provider("google")).status).toBe("unchecked");
  const runner = await poolWorker("ma-pool-google");
  await claimRequestersJob("ma-google", runner);
  expect((await answered(runner, "/google-ai-studio/v1beta/models/gemini:generateContent", 200)).status).toBe(200);
  expect((await provider("google")).status).toBe("connected");
});

it("a run made on credits doesn't mark the person's own key connected", async () => {
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-own3r" })).status).toBe(204);
  expect((await call("/api/me/models", "PUT", { source: "credits" })).status).toBe(204);
  // The gateway call carries no alias, and the runner's report of the run names no key.
  const pool = await poolWorker("ma-pool-credits");
  await claimRequestersJob("ma-credits", pool);
  expect((await answered(pool, "/anthropic/v1/messages", 200)).status).toBe(200);
  const { id, token } = await (await call("/api/runners", "POST", { name: "ma-credits", kinds: ["develop"] })).json();
  const job = await claimRequestersJob("ma-credits-2", id);
  const report = await call("/api/work/model-usage", "POST", { job, provider: "anthropic", source: "org", tokens: 10, cost_usd: 0.01 }, `Bearer ${token}`);
  expect(report.status).toBe(204);
  expect(await provider("anthropic")).toMatchObject({ source: "mine", status: "unchecked" });
});

it("a 401 from the gateway on the person's key shows status failing with the reason", async () => {
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-r3voked" })).status).toBe(204);
  const runner = await poolWorker("ma-pool-401");
  await claimRequestersJob("ma-401", runner);
  expect((await answered(runner, "/anthropic/v1/messages", 401)).status).toBe(401);
  expect(await provider("anthropic")).toMatchObject({ status: "failing", reason: "Anthropic refused the key (HTTP 401)", last_used_at: expect.any(String) });
});

it("without AI Gateway: Edit on cinder's token, saving a key answers 503 naming the permission and records nothing", async () => {
  vi.stubGlobal("fetch", fakeCloudflare({ deny: ["/ai-gateway"] }).fetch);
  const res = await call("/api/me/models/openai", "PUT", { method: "key", value: "sk-openai-s3cret" });
  expect(res.status).toBe(503);
  expect((await res.json()).error.message).toBe("cinder's Cloudflare API token needs AI Gateway: Edit");
  expect((await provider("openai")).status).toBe("missing");
});

it("saving a key creates the Secrets Store secret {gateway}_{provider}_{alias} before the provider config; a config whose secret is missing is rejected with 7001", async () => {
  const fresh = fakeCloudflare();
  vi.stubGlobal("fetch", fresh.fetch);
  expect((await call("/api/me/models/openai", "PUT", { method: "key", value: "sk-openai-0rder" })).status).toBe(204);
  const [config] = [...fresh.configs.values()];
  const name = `cinder_openai_${config.alias}`;
  const posts = fresh.requests.filter((r) => r.method === "POST").map((r) => r.url.replace(/^.*\/accounts\/acct/, ""));
  expect(posts).toEqual(["/secrets_store/stores/store1/secrets", "/ai-gateway/gateways/cinder/provider_configs"]);
  expect(JSON.parse(fresh.requests.find((r) => r.method === "POST").body)).toEqual([expect.objectContaining({ name, value: "sk-openai-0rder", scopes: ["ai_gateway"] })]);
  expect(config).toEqual({ alias: config.alias, provider_slug: "openai", default_config: false });

  const orphan = await fresh.fetch("https://api.cloudflare.com/client/v4/accounts/acct/ai-gateway/gateways/cinder/provider_configs", { method: "POST",
    headers: { "content-type": "application/json" }, body: JSON.stringify({ alias: "p-nosecret", provider_slug: "anthropic", default_config: false }) });
  expect([orphan.status, (await orphan.json()).errors[0].code]).toEqual([400, 7001]);
});

it("PUT /me/models/:p calls the gateway and Secrets Store fakes and writes no ciphertext; a replace and a removal delete the old config and secret", async () => {
  const columns = (await env.DB.prepare("SELECT name FROM pragma_table_info('model_providers')").all()).results.map((c) => c.name);
  expect(columns).not.toContain("ciphertext");
  expect(columns).not.toContain("iv");
  await call("/api/me/models/xai", "PUT", { method: "key", value: "xai-first-k3y" });
  expect((await call("/api/me/models/xai", "PUT", { method: "key", value: "xai-second-k3y" })).status).toBe(204);
  const row = await env.DB.prepare("SELECT * FROM model_providers WHERE person = 'owner' AND provider = 'xai'").first();
  expect(JSON.stringify(row)).not.toMatch(/xai-(first|second)-k3y/);
  const values = () => [...cf.secrets.values()].filter((x) => x.name.startsWith("cinder_grok_")).map((x) => x.value);
  expect(values()).toEqual(["xai-second-k3y"]);
  expect([...cf.configs.values()].filter((c) => c.provider_slug === "grok")).toHaveLength(1);
  await call("/api/me/models/xai", "DELETE");
  expect(values()).toEqual([]);
  expect(cf.configs.has(row.config_id)).toBe(false);
});

it("a Cloudflare 400 with code 7001 makes PUT /api/me/models/anthropic return a JSON 502 with Cloudflare's message", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ success: false, errors: [{ code: 7001, message: "Gateway cinder does not have a Secrets Store configured" }] }, { status: 400 }));
  const res = await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-s3cret" });
  expect(res.status).toBe(502);
  const text = await res.text();
  expect(JSON.parse(text).error).toMatchObject({ code: "cloudflare_error", message: expect.stringContaining("Gateway cinder does not have a Secrets Store configured (code 7001)") });
  expect(text).not.toContain("sk-ant-s3cret");
});

it("a Cloudflare 403 on PUT /api/me/models/anthropic still maps to the permission message", async () => {
  vi.stubGlobal("fetch", async () => Response.json({ success: false, errors: [{ code: 10000, message: "Authentication error" }] }, { status: 403 }));
  const res = await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-s3cret" });
  expect(res.status).toBe(503);
  expect((await res.json()).error).toEqual({ code: "missing_permission", message: "cinder's Cloudflare API token needs Secrets Store: Edit" });
});

it("saving a key retries the provider config while the new secret propagates, and removes the secret when it never does", async () => {
  vi.stubGlobal("setTimeout", (fn) => fn());
  const fresh = fakeCloudflare();
  let misses = 2;
  const lagging = (input, init) => (String(input).endsWith("/provider_configs") && init?.method === "POST" && misses-- > 0
    ? Promise.resolve(Response.json({ success: false, errors: [{ code: 7001, message: "Secret cinder_anthropic_x was not found. Create the secret in Secrets Store" }] }, { status: 400 }))
    : fresh.fetch(input, init));
  vi.stubGlobal("fetch", lagging);
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-lag" })).status).toBe(204);
  expect(fresh.configs.size).toBe(1);

  misses = Infinity;
  const before = fresh.requests.length;
  expect((await call("/api/me/models/xai", "PUT", { method: "key", value: "sk-xai-lag" })).status).toBe(502);
  expect(fresh.configs.size).toBe(1);
  expect(fresh.requests.slice(before).filter((r) => r.method === "DELETE" && r.url.includes("/secrets_store/"))).toHaveLength(1);
});

// A develop job claimed now by a new pool worker; `person` requested it (none: system-created). → the worker's runner id.
async function claimedJob(person) {
  const runner = await poolWorker(`ma-login-${crypto.randomUUID()}`);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, runner_id, lease_expires_at, created_at, payload) VALUES (?, 'r-login', 'develop', 'claimed', ?, ?, ?, '{}')")
    .bind(id, runner, new Date(Date.now() + 60_000).toISOString(), new Date().toISOString()).run();
  if (person) await env.DB.prepare("INSERT INTO job_requesters (job_id, person) VALUES (?, ?)").bind(id, person).run();
  return runner;
}
const LOGIN = "sk-ant-oat01-own3r-l0gin";
async function loginCalls(runners, answer = () => new Response("{}")) {
  expect((await call("/api/me/models/anthropic", "PUT", { method: "login", value: LOGIN })).status).toBe(204);
  expect((await call("/api/me/models", "PUT", { source: "mine" })).status).toBe(204);
  const sent = [];
  const AI = { gateway: (id) => ({ run: async (data, options) => { sent.push({ id, ...data, extra: options.extraHeaders }); return answer(); } }) };
  // The container names itself "owner" on every call: only the requester of the job its worker holds decides.
  const res = [];
  for (const runner of runners) res.push(await WorkerLite.outboundByHost["models.internal"](new Request("http://models.internal/anthropic/v1/messages", { method: "POST",
    headers: { "x-api-key": "via-gateway", "anthropic-beta": "claude-code-20250219", "cf-aig-metadata": JSON.stringify({ person: "owner" }) }, body: "{}" }),
  { ...e, ...cf.env, AI }, { containerId: runner, className: "WorkerLite" })); // cf.env's SECRETS sees the bindings as of now
  return { sent, res };
}

it("a job requested by person A with a saved login runs with A's login; a job by person B never receives it", async () => {
  const a = await claimedJob("owner");
  const b = await claimedJob("bob@example.com");
  const system = await claimedJob(null);
  const { sent: [own, other, sys] } = await loginCalls([a, b, system]);
  expect(own.headers.authorization).toBe(`Bearer ${LOGIN}`);
  expect(own.headers["anthropic-beta"]).toBe("claude-code-20250219,oauth-2025-04-20");
  expect(own.extra["cf-aig-byok-alias"]).toBeUndefined();
  for (const req of [other, sys]) {
    expect(JSON.stringify(req)).not.toContain(LOGIN);
    expect(req.headers.authorization).toBeUndefined();
  }
  // Stored as a Worker-read secret, never as a gateway provider key.
  expect([...cf.secrets.values()].find((x) => x.value === LOGIN).scopes).toEqual(["workers"]);
  expect(await provider("anthropic")).toMatchObject({ method: "login", source: "mine" });
});

it("a develop job with the owner's saved login reaches the model, and the login's status comes from that use", async () => {
  const job = await claimedJob("owner");
  const { sent: [req], res: [ok] } = await loginCalls([job], () => Response.json({ type: "message" }));
  expect(req).toMatchObject({ id: "cinder", provider: "anthropic", endpoint: "v1/messages", headers: { authorization: `Bearer ${LOGIN}` } });
  expect(await ok.json()).toEqual({ type: "message" });
  expect(await provider("anthropic")).toMatchObject({ method: "login", status: "connected", reason: null, last_used_at: expect.any(String) });

  const { res: [refused] } = await loginCalls([job], () => new Response("{}", { status: 401 }));
  expect(refused.status).toBe(401);
  expect(await provider("anthropic")).toMatchObject({ status: "failing", reason: "Anthropic refused the login (HTTP 401)" });
});

it("me/models lists providers with an org key without returning the key", async () => {
  cf.configs.set("org-anthropic", { provider_slug: "anthropic", alias: "default", secret: "sk-ant-org-s3cret" });
  onTestFinished(() => cf.configs.delete("org-anthropic"));
  expect((await call("/api/me/models/openai", "PUT", { method: "key", value: "sk-own" })).status).toBe(204);
  const res = await call("/api/me/models");
  const text = await res.clone().text();
  const body = await res.json();
  expect(validateModelAccess(body)).toEqual({ ok: true, errors: [] });
  expect(body.org_keys).toEqual(["anthropic"]);
  expect(body.account).toEqual(expect.any(String));
  expect(text).not.toContain("sk-ant-org-s3cret");
});

it("saving a provider key whose secret already exists without a row replaces it", async () => {
  const fresh = fakeCloudflare();
  vi.stubGlobal("fetch", fresh.fetch);
  // A save aborted after its store write left the owner's OpenAI secret behind, with no model_providers row.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("owner")));
  const name = `cinder_openai_p-${[...digest.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  await env.DB.prepare("DELETE FROM model_providers WHERE person = 'owner' AND provider = 'openai'").run();
  fresh.secrets.set("stale", { name, value: "sk-openai-st4le", scopes: ["ai_gateway"], created: new Date().toISOString() });
  expect((await call("/api/me/models/openai", "PUT", { method: "key", value: "sk-openai-fr3sh" })).status).toBe(204);
  expect([...fresh.secrets].filter(([, s]) => s.name === name).map(([id, s]) => [id, s.value])).toEqual([["stale", "sk-openai-fr3sh"]]);
  expect(await env.DB.prepare("SELECT secret_id FROM model_providers WHERE person = 'owner' AND provider = 'openai'").first("secret_id")).toBe("store1/stale");
});

it("saving a key whose provider config already exists without a row reuses that config", async () => {
  const fresh = fakeCloudflare();
  vi.stubGlobal("fetch", fresh.fetch);
  // A save aborted after its config was created left the owner's Anthropic secret and config behind, with no row.
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("owner")));
  const alias = `p-${[...digest.slice(0, 8)].map((x) => x.toString(16).padStart(2, "0")).join("")}`;
  await env.DB.prepare("DELETE FROM model_providers WHERE person = 'owner' AND provider = 'anthropic'").run();
  fresh.secrets.set("left", { name: `cinder_anthropic_${alias}`, value: "sk-ant-st4le", scopes: ["ai_gateway"], created: new Date().toISOString() });
  fresh.configs.set("left-config", { alias, provider_slug: "anthropic", default_config: false });
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-fr3sh" })).status).toBe(204);
  expect([...fresh.configs.keys()]).toEqual(["left-config"]);
  expect(await env.DB.prepare("SELECT config_id FROM model_providers WHERE person = 'owner' AND provider = 'anthropic'").first("config_id")).toBe("left-config");
});

it("after PUT /api/me/models/anthropic {method:key}, GET /api/me/models shows source mine and a job requested by that person gets the BYOK alias", async () => {
  // A person who never picked a source: earlier tests in this file picked mine.
  await env.DB.prepare("DELETE FROM model_sources WHERE person = 'owner'").run();
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-just-saved" })).status).toBe(204);
  expect((await (await call("/api/me/models")).json()).source).toBe("mine");
  const runner = await poolWorker("ma-pool-saved");
  await claimRequestersJob("ma-saved", runner);
  const sent = [];
  await modelCall("owner", runner, sent);
  expect(sent[0].options.extraHeaders["cf-aig-byok-alias"]).toBe([...cf.configs.values()].find((c) => c.provider_slug === "anthropic").alias);
});

it("a change created with the owner token runs on the key the owner saved through Access", async () => {
  serveCerts();
  const { ACCESS_TEAM_DOMAIN, ACCESS_AUD, OWNERS } = ACCESS;
  Object.assign(e, { ACCESS_TEAM_DOMAIN, ACCESS_AUD, OWNERS });
  onTestFinished(() => { delete e.ACCESS_TEAM_DOMAIN; delete e.ACCESS_AUD; delete e.OWNERS; });
  const before = new Set(cf.configs.keys());
  const save = await worker.fetch(new Request("http://cinder.test/api/me/models/anthropic", { method: "PUT", headers: await as("boss@example.com"),
    body: JSON.stringify({ method: "key", value: "sk-ant-b0ss" }) }), e);
  expect(save.status).toBe(204);
  const [id] = [...cf.configs.keys()].filter((k) => !before.has(k));
  const runner = await poolWorker("ma-pool-token");
  await claimRequestersJob("ma-token", runner);
  const sent = [];
  await modelCall("owner", runner, sent);
  expect(sent[0].options.extraHeaders["cf-aig-byok-alias"]).toBe(cf.configs.get(id).alias);
});

it("a failed replace leaves the previous key working", async () => {
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-previous" })).status).toBe(204);
  const row = () => env.DB.prepare("SELECT config_id, secret_id FROM model_providers WHERE person = 'owner' AND provider = 'anthropic'").first();
  const kept = await row();
  // Every write of a secret fails, so the replace stops before it has a new key.
  vi.stubGlobal("fetch", (input, init) => (["POST", "PATCH"].includes(init?.method) && String(input?.url ?? input).includes("/secrets_store/")
    ? Response.json({ success: false, errors: [{ code: 1000, message: "store down" }] }, { status: 500 }) : cf.fetch(input, init)));
  expect((await call("/api/me/models/anthropic", "PUT", { method: "key", value: "sk-ant-next" })).status).toBe(502);
  expect(await row()).toEqual(kept);
  expect(cf.configs.has(kept.config_id)).toBe(true);
  expect(cf.secrets.get(kept.secret_id.split("/")[1]).value).toBe("sk-ant-previous");
  const runner = await poolWorker("ma-pool-replace");
  await claimRequestersJob("ma-replace", runner);
  const sent = [];
  await modelCall("owner", runner, sent);
  expect(sent[0].options.extraHeaders["cf-aig-byok-alias"]).toBe(cf.configs.get(kept.config_id).alias);
});

// A save through a Worker whose AI binding answers every gateway run with status, recording each run in sent.
const saveWith = (provider, body, status, sent) => worker.fetch(signedIn(`/api/me/models/${provider}`, { method: "PUT", headers: { Authorization: OWNER }, body: JSON.stringify(body) }),
  { ...e, AI: { gateway: (id) => ({ run: async (data, options) => { sent.push({ id, data, options }); return new Response("{}", { status }); } }) } });

it("saving a key checks it through the gateway at once: a key the provider accepts shows connected", async () => {
  const sent = [];
  expect((await saveWith("anthropic", { method: "key", value: "sk-ant-ch3ck" }, 200, sent)).status).toBe(204);
  expect(await provider("anthropic")).toMatchObject({ status: "connected", reason: null, last_used_at: expect.any(String) });
  expect(sent).toMatchObject([{ id: "cinder", data: { provider: "anthropic", endpoint: "v1/messages/count_tokens" },
    options: { extraHeaders: { "cf-aig-byok-alias": expect.stringMatching(/^p-[0-9a-f]{16}$/) } } }]);
  expect(JSON.stringify(sent)).not.toContain("sk-ant-ch3ck");
});

it("saving a key the provider refuses shows failing with the reason", async () => {
  expect((await saveWith("openai", { method: "key", value: "sk-bad" }, 401, [])).status).toBe(204);
  expect(await provider("openai")).toMatchObject({ status: "failing", reason: "OpenAI refused the key (HTTP 401)" });
});
