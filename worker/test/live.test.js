import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { validateChangeEvent } from "../src/api/contract.js";
import worker from "../src/index.js";
import { publish } from "../src/live.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const fake = fakeArtifacts();
const call = (path, { method = "POST", body, headers = OWNER } = {}) => worker.fetch(
  new Request(`http://cinder.test${path}`, { method, headers, body: body && JSON.stringify(body) }),
  { ...env, ARTIFACTS: fake },
);
const ticket = async (repo) => (await (await call("/api/live-ticket", { body: { repo } })).json()).ticket;
const open = (repo, t, origin = "http://cinder.test") => call(`/api/repos/${repo}/live?ticket=${t}`, { method: "GET", headers: { Origin: origin, Upgrade: "websocket" } });

// Access as in access.test.js: a team whose certs URL serves the test key.
const TEAM = "cinder-live.cloudflareaccess.com";
const ACCESS = { ...env, ARTIFACTS: fake, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud-cinder", OWNERS: "boss@example.com" };
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const part = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));
let keys;
beforeAll(async () => { keys = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]); });
async function jwt(email) {
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256" }] }));
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part({ aud: ["aud-cinder"], iss: `https://${TEAM}`, email, exp: Math.floor(Date.now() / 1000) + 300 })}`;
  return `${body}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body)))}`;
}
const openAccess = async (repo, email) => worker.fetch(new Request(`http://cinder.test/api/repos/${repo}/live`, {
  headers: { Origin: "http://cinder.test", Upgrade: "websocket", Cookie: `CF_Authorization=${await jwt(email)}` },
}), ACCESS);

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("live updates", () => {
  it("a transition reaches a connected socket", async () => {
    expect((await call("/api/repos", { body: { name: "live-tx" } })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("live-tx")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const { id } = await (await call("/api/repos/live-tx/changes", { body: { intent: "x" } })).json();

    const res = await open("live-tx", await ticket("live-tx"));
    expect(res.status).toBe(101);
    const ws = res.webSocket;
    ws.accept();
    const received = new Promise((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(e.data))));

    expect((await call(`/api/changes/${id}/close`)).status).toBe(200);
    const event = await received;
    expect(event).toMatchObject({ change_id: id, kind: "closed", from_state: "leased", to_state: "closed" });
    expect(validateChangeEvent(event)).toEqual({ ok: true, errors: [] });
    ws.close();
  });

  it("expired ticket refused", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    const t = await ticket("live-exp");
    vi.setSystemTime(Date.now() + 61_000);
    const res = await open("live-exp", t);
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeNull();
  });

  it("an Access JWT authorises the upgrade without a ticket", async () => {
    const res = await openAccess("live-access", "boss@example.com");
    expect(res.status).toBe(101);
    res.webSocket.accept();
    res.webSocket.close();
  });

  it("an Access person without a role on the repo is refused", async () => {
    const res = await openAccess("live-access", "guest@example.com");
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeNull();
  });

  it("refuses a websocket upgrade from another origin", async () => {
    const t = await ticket("live-origin");
    for (const origin of ["https://evil.example", null]) {
      const res = await open("live-origin", t, origin);
      expect(res.status).toBe(403);
      expect(res.webSocket).toBeNull();
    }
    const access = await worker.fetch(new Request("http://cinder.test/api/repos/live-access/live", {
      headers: { Origin: "https://evil.example", Upgrade: "websocket", Cookie: `CF_Authorization=${await jwt("boss@example.com")}` },
    }), ACCESS);
    expect(access.status).toBe(403);
  });

  it("refuses a ticket minted for another repo", async () => {
    const t = await ticket("live-mine");
    const res = await open("live-theirs", t);
    expect(res.status).toBe(401);
    expect(res.webSocket).toBeNull();
    expect((await call("/api/live-ticket", { body: {} })).status).toBe(400);
  });

  it("a ticket signed with OWNER_TOKEN is refused", async () => {
    const exp = String(Date.now() + 30_000);
    const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.OWNER_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const sig = [...new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(exp)))].map((b) => b.toString(16).padStart(2, "0")).join("");
    expect((await open("live-forged", `${exp}.${sig}`)).status).toBe(401);
  });

  it("with the LIVE_TICKET_KEY binding POST /api/live-ticket returns 200 with a ticket", async () => {
    const res = await call("/api/live-ticket", { body: { repo: "live-mint" } });
    expect(res.status).toBe(200);
    expect((await res.json()).ticket).toMatch(/^\d+\.[0-9a-f]{64}$/);
  });

  it("without the LIVE_TICKET_KEY binding POST /api/live-ticket returns 204, not 5xx", async () => {
    const res = await worker.fetch(new Request("http://cinder.test/api/live-ticket", { method: "POST", headers: OWNER }), { ...env, LIVE_TICKET_KEY: undefined });
    expect(res.status).toBe(204);
  });

  it("publish sends {kind, repo, at, …data} to every socket open on the repo", async () => {
    const t = await ticket("live-pub");
    const sockets = [(await open("live-pub", t)).webSocket, (await open("live-pub", t)).webSocket];
    const received = sockets.map((ws) => {
      ws.accept();
      return new Promise((resolve) => ws.addEventListener("message", (e) => resolve(JSON.parse(e.data))));
    });
    await publish(env, "live-pub", "pool.scaled", { size: 3 });
    for (const event of await Promise.all(received)) {
      expect(event).toEqual({ kind: "pool.scaled", repo: "live-pub", at: expect.any(String), size: 3 });
      expect(new Date(event.at).toISOString()).toBe(event.at);
    }
    for (const ws of sockets) ws.close();
  });

  it("publish rejects a kind that is not area.verb", () => {
    for (const kind of ["lease", "Pool.scaled", "pool.scaled.now", "pool-x.scaled", "", undefined]) {
      expect(() => publish(env, "live-pub", kind, {})).toThrow(/area>\.<verb/);
    }
  });
});
