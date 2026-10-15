import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";
import { validateWebhook } from "../src/api/contract.js";
import { binding } from "../src/keystore.js";
import { notify } from "../src/webhooks.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

// A repo with a change and a webhook on judgment events; sent collects what the WEBHOOKS Queue was given, cf holds the
// Secrets Store and qenv is the queue consumer's env with the hook's secret binding.
async function setup(name) {
  const sent = [];
  const fake = fakeArtifacts();
  const cf = fakeCloudflare();
  vi.stubGlobal("fetch", cf.fetch);
  const e = { ...env, ...cf.env, ARTIFACTS: fake, WEBHOOKS: { sendBatch: async (msgs) => { sent.push(...msgs); } } };
  const call = async (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), e);
  await call("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "x" })).json();
  const hook = await (await call(`/api/repos/${name}/webhooks`, { url: "https://ci.example/hook", events: ["judgment"] })).json();
  return { e, call, change, hook, sent, cf, qenv: { ...env, ...cf.env } };
}

// What a delivery's signature covers: its timestamp, its delivery id and its body.
const signed = (init) => `${init.headers["x-cinder-timestamp"]}.${init.headers["x-cinder-delivery"]}.${init.body}`;
const message = (body) => ({ id: crypto.randomUUID(), body, attempts: 1, ack: vi.fn(), retry: vi.fn() });

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

it("webhooks has no secret column, and a delivery is signed with the value stored in the Secrets Store", async () => {
  const { results: cols } = await env.DB.prepare("SELECT name FROM pragma_table_info('webhooks')").all();
  expect(cols.map((c) => c.name)).not.toContain("secret");
  const { e, change, hook, sent, cf, qenv } = await setup("hook-sign");
  const row = await env.DB.prepare("SELECT * FROM webhooks WHERE id = ?").bind(hook.id).first();
  expect(JSON.stringify(row)).not.toContain(hook.secret);
  const stored = [...cf.secrets.values()].find((s) => s.name === row.store_secret_name);
  expect(stored.value).toBe(hook.secret);
  await notify(e, change.repo_id, "judgment", { change_id: change.id, risk: "high" });
  expect(sent).toMatchObject([{ body: { hook: hook.id, kind: "judgment", data: { change_id: change.id, risk: "high" } } }]);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  const msg = message(sent[0].body);
  await worker.queue({ queue: "cinder-webhooks", messages: [msg] }, qenv);
  const [url, init] = fetch.mock.calls[0];
  expect(url).toBe("https://ci.example/hook");
  const signature = init.headers["x-cinder-signature"];
  expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(stored.value), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const mac = Uint8Array.from(signature.slice(7).match(/../g), (h) => parseInt(h, 16));
  expect(await crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(signed(init)))).toBe(true);
  expect(JSON.parse(init.body)).toEqual(sent[0].body);
  expect(msg.ack).toHaveBeenCalled();
  expect(msg.retry).not.toHaveBeenCalled();
});

it("a failed delivery is retried", async () => {
  const { hook, qenv } = await setup("hook-retry");
  vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(new Response("down", { status: 503 })).mockRejectedValueOnce(new Error("connection reset"));
  const failed = message({ hook: hook.id, kind: "judgment", data: {}, at: new Date().toISOString() });
  const unreachable = message({ hook: hook.id, kind: "judgment", data: {}, at: new Date().toISOString() });
  await worker.queue({ queue: "cinder-webhooks", messages: [failed, unreachable] }, qenv);
  for (const msg of [failed, unreachable]) {
    expect(msg.retry).toHaveBeenCalledWith({ delaySeconds: expect.any(Number) });
    expect(msg.ack).not.toHaveBeenCalled();
  }
});

const get = (path, e) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER }), e);

it("GET …/webhooks never contains a secret", async () => {
  const { hook, qenv } = await setup("hook-list");
  const res = await get("/api/repos/hook-list/webhooks", qenv);
  const text = await res.clone().text();
  expect(text).not.toContain(hook.secret);
  const list = await res.json();
  expect(list).toEqual([{ id: hook.id, url: "https://ci.example/…", events: ["judgment"], created_at: expect.any(String), last_delivery: null }]);
  expect(validateWebhook(list[0])).toEqual({ ok: true, errors: [] });
  const patched = await worker.fetch(new Request(`http://cinder.test/api/repos/hook-list/webhooks/${hook.id}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ events: ["change", "verdict"] }) }), qenv);
  expect(await patched.json()).toEqual({ id: hook.id, url: "https://ci.example/…", events: ["change", "verdict"] });
});

it("a contributor gets 403 on PATCH and rotate of a webhook; a manager's PATCH response masks the URL", async () => {
  const { hook, qenv } = await setup("hook-perm");
  serveCerts();
  await env.DB.prepare("INSERT INTO person_roles VALUES ('contrib@hooks.test', 'contributor'), ('adm@hooks.test', 'admin')").run();
  const e = { ...ACCESS, ...qenv };
  const send = async (who, method, path, body) => worker.fetch(new Request(`http://cinder.test/api/repos/hook-perm/webhooks/${hook.id}${path}`,
    { method, headers: await as(who), body: body && JSON.stringify(body) }), e);
  expect((await send("contrib@hooks.test", "PATCH", "", { events: ["change"] })).status).toBe(403);
  expect((await send("contrib@hooks.test", "POST", "/rotate")).status).toBe(403);
  const patched = await send("adm@hooks.test", "PATCH", "", { events: ["change"] });
  expect(await patched.json()).toEqual({ id: hook.id, url: "https://ci.example/…", events: ["change"] });
});

it("redacts a webhook URL's path in the list", async () => {
  const { e } = await setup("hook-redact");
  const add = { method: "POST", headers: OWNER, body: JSON.stringify({ url: "https://hooks.example/services/T0/B0/xyzzy?k=1", events: ["change"] }) };
  await worker.fetch(new Request("http://cinder.test/api/repos/hook-redact/webhooks", add), e);
  const text = await (await get("/api/repos/hook-redact/webhooks", e)).text();
  expect(text).not.toContain("xyzzy");
  expect(JSON.parse(text).map((h) => h.url)).toEqual(["https://ci.example/…", "https://hooks.example/…"]);
});

it("last_delivery reflects the latest deliver() attempt, whether it succeeded or failed", async () => {
  const { hook, qenv } = await setup("hook-last");
  const last = async () => (await (await get("/api/repos/hook-last/webhooks", qenv)).json())[0].last_delivery;
  const send = () => worker.queue({ queue: "cinder-webhooks", messages: [message({ hook: hook.id, kind: "judgment", data: {}, at: new Date().toISOString() })] }, qenv);
  const fetch = vi.spyOn(globalThis, "fetch");
  fetch.mockResolvedValueOnce(new Response("down", { status: 503 }));
  await send();
  expect(await last()).toEqual({ at: expect.any(String), ok: false, status: 503, error: null });
  fetch.mockResolvedValueOnce(new Response("ok"));
  await send();
  expect(await last()).toEqual({ at: expect.any(String), ok: true, status: 200, error: null });
  fetch.mockRejectedValueOnce(new Error("connection reset"));
  await send();
  expect(await last()).toEqual({ at: expect.any(String), ok: false, status: null, error: "connection reset" });
});

it("DELETE …/webhooks/:id removes the hook and its secret reference", async () => {
  const { hook, cf, qenv } = await setup("hook-delete");
  const name = (await env.DB.prepare("SELECT store_secret_name FROM webhooks WHERE id = ?").bind(hook.id).first("store_secret_name"));
  const res = await worker.fetch(new Request(`http://cinder.test/api/repos/hook-delete/webhooks/${hook.id}`, { method: "DELETE", headers: OWNER }), qenv);
  expect(res.status).toBe(204);
  expect(await env.DB.prepare("SELECT 1 FROM webhooks WHERE id = ?").bind(hook.id).first()).toBeNull();
  expect(await env.DB.prepare("SELECT 1 FROM webhook_secret_ids WHERE hook_id = ?").bind(hook.id).first()).toBeNull();
  expect([...cf.secrets.values()].some((s) => s.name === name)).toBe(false);
  expect(cf.bound).not.toContain(binding(hook.id));
  expect(await (await get("/api/repos/hook-delete/webhooks", qenv)).json()).toEqual([]);
});

it("rotate returns a new secret, and delivery signs with it", async () => {
  const { hook, cf } = await setup("hook-rotate");
  const res = await worker.fetch(new Request(`http://cinder.test/api/repos/hook-rotate/webhooks/${hook.id}/rotate`, { method: "POST", headers: OWNER }), { ...env, ...cf.env });
  expect(res.status).toBe(200);
  const { secret } = await res.json();
  expect(secret).toMatch(/^[0-9a-f]{64}$/);
  expect(secret).not.toBe(hook.secret);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  await worker.queue({ queue: "cinder-webhooks", messages: [message({ hook: hook.id, kind: "judgment", data: {}, at: new Date().toISOString() })] }, { ...env, ...cf.env });
  const [, init] = fetch.mock.calls[0];
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const mac = Uint8Array.from(init.headers["x-cinder-signature"].slice(7).match(/../g), (h) => parseInt(h, 16));
  expect(await crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(signed(init)))).toBe(true);
});

it("a delivery signs its timestamp and delivery id with the body, so a replay under another id or time fails", async () => {
  const { hook, qenv } = await setup("hook-replay");
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("ok"));
  const msg = message({ hook: hook.id, kind: "judgment", data: {}, at: new Date().toISOString() });
  await worker.queue({ queue: "cinder-webhooks", messages: [msg] }, qenv);
  const [, init] = fetch.mock.calls[0];
  expect(init.headers["x-cinder-delivery"]).toBe(msg.id);
  expect(Math.abs(Number(init.headers["x-cinder-timestamp"]) - Date.now() / 1000)).toBeLessThan(60);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(hook.secret), { name: "HMAC", hash: "SHA-256" }, false, ["verify"]);
  const mac = Uint8Array.from(init.headers["x-cinder-signature"].slice(7).match(/../g), (h) => parseInt(h, 16));
  const verify = (text) => crypto.subtle.verify("HMAC", key, mac, new TextEncoder().encode(text));
  expect(await verify(signed(init))).toBe(true);
  expect(await verify(init.body)).toBe(false);
  expect(await verify(`${Number(init.headers["x-cinder-timestamp"]) + 1}.${msg.id}.${init.body}`)).toBe(false);
});
