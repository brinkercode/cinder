import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { validateGroup, validateMe, validatePerson, validateRepoRole, validateRole } from "../src/api/contract.js";
import { accessPerson } from "../src/access.js";
import { createChange } from "../src/changes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const TEAM = "cinder-test.cloudflareaccess.com";
const ACCESS = { ...env, ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud-cinder", OWNERS: "boss@example.com, Ana@Example.com" };
const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const part = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

let keys, forger;
beforeAll(async () => {
  keys = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
  forger = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
});

// Serves the test key at the team's certs URL; any other outbound fetch fails the test.
function serveCerts() {
  const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error(`unexpected fetch ${url}`);
    return Response.json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256" }] });
  });
  onTestFinished(() => fetch.mockRestore());
}

async function jwt(claims = {}, signer = keys.privateKey) {
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part({
    aud: ["aud-cinder"], iss: `https://${TEAM}`, email: "ana@example.com", exp: Math.floor(Date.now() / 1000) + 300, ...claims,
  })}`;
  return `${body}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", signer, new TextEncoder().encode(body)))}`;
}

const call = (path, headers, e = ACCESS, method = "GET") => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers }), e);

describe("cloudflare access", () => {
  it("a valid Access JWT resolves to its email on /api/me", async () => {
    serveCerts();
    const res = await call("/api/me", { "Cf-Access-Jwt-Assertion": await jwt() });
    expect(res.status).toBe(200);
    const me = await res.json();
    expect(me).toEqual({ email: "ana@example.com", owner: true, nonprod: true });
    expect(validateMe(me)).toEqual({ ok: true, errors: [] });
    expect(await env.DB.prepare("SELECT email FROM people WHERE email = ?").bind("ana@example.com").first()).toEqual({ email: "ana@example.com" });
    expect(Date.parse((await (await call("/api/people", OWNER)).json()).find((p) => p.email === "ana@example.com").last_seen)).toBeGreaterThan(Date.now() - 60_000);
    // Not in OWNERS: signed in, but not an owner.
    const guest = await call("/api/me", { "Cf-Access-Jwt-Assertion": await jwt({ email: "guest@example.com" }) });
    expect(await guest.json()).toEqual({ email: "guest@example.com", owner: false, nonprod: true });
    expect((await call("/api/repos", { "Cf-Access-Jwt-Assertion": await jwt({ email: "guest@example.com" }) })).status).toBe(403);
  });

  it("a JWT with the wrong aud, wrong issuer, bad signature or expired is refused with 401", async () => {
    serveCerts();
    const bad = {
      aud: await jwt({ aud: ["someone-else"] }),
      iss: await jwt({ iss: "https://evil.cloudflareaccess.com" }),
      signature: await jwt({}, forger.privateKey),
      expired: await jwt({ exp: Math.floor(Date.now() / 1000) - 61 }), // past the 60s skew leeway
      missing: null,
    };
    for (const [why, token] of Object.entries(bad)) {
      const res = await call("/api/me", token ? { "Cf-Access-Jwt-Assertion": token } : {});
      expect(res.status, why).toBe(401);
      expect((await res.json()).error.code, why).toBe("access_denied");
    }
  });

  it("10 forged key ids cause one fetch", async () => {
    const team = "cinder-forged.cloudflareaccess.com"; // own domain: no other test has fetched its certs
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ keys: [] }));
    onTestFinished(() => fetch.mockRestore());
    const e = { ...ACCESS, ACCESS_TEAM_DOMAIN: team };
    const claims = part({ aud: ["aud-cinder"], iss: `https://${team}`, email: "ana@example.com", exp: Math.floor(Date.now() / 1000) + 300 });
    for (let i = 0; i < 10; i++) {
      const token = `${part({ alg: "RS256", kid: `forged-${i}` })}.${claims}.${b64url(new Uint8Array(256))}`;
      expect(await accessPerson(new Request("http://cinder.test/api/me", { headers: { "Cf-Access-Jwt-Assertion": token } }), e)).toBeNull();
    }
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("5 concurrent requests with a valid JWT in a fresh isolate all get 200 and fetch the certs once", async () => {
    const team = "cinder-cold.cloudflareaccess.com"; // own domain: an empty key cache, as in a fresh isolate
    const jwk = { ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256" };
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 50)); // a slow certs fetch keeps the other misses waiting on it
      return Response.json({ keys: [jwk] });
    });
    onTestFinished(() => fetch.mockRestore());
    const e = { ...ACCESS, ACCESS_TEAM_DOMAIN: team };
    const token = await jwt({ iss: `https://${team}` });
    const res = await Promise.all(Array.from({ length: 5 }, () => call("/api/me", { "Cf-Access-Jwt-Assertion": token }, e)));
    expect(res.map((r) => r.status)).toEqual([200, 200, 200, 200, 200]);
    expect(fetch).toHaveBeenCalledTimes(1);
    // A stale owner bearer left in the browser doesn't hide the valid JWT.
    expect((await call("/api/me", { Authorization: "Bearer stale", "Cf-Access-Jwt-Assertion": token }, e)).status).toBe(200);
  });

  it("a new kid after a key rotation triggers one refetch and succeeds", async () => {
    const team = "cinder-rotate.cloudflareaccess.com";
    const rotated = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
    let served = [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256" }];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ keys: served }));
    onTestFinished(() => fetch.mockRestore());
    const e = { ...ACCESS, ACCESS_TEAM_DOMAIN: team };
    expect((await call("/api/me", { "Cf-Access-Jwt-Assertion": await jwt({ iss: `https://${team}` }) }, e)).status).toBe(200);
    served = [{ ...(await crypto.subtle.exportKey("jwk", rotated.publicKey)), kid: "k2", alg: "RS256" }];
    const later = Date.now() + 61_000; // past the refetch window
    const now = vi.spyOn(Date, "now").mockReturnValue(later);
    onTestFinished(() => now.mockRestore());
    const body = `${part({ alg: "RS256", kid: "k2" })}.${part({ aud: ["aud-cinder"], iss: `https://${team}`, email: "ana@example.com", exp: Math.floor(later / 1000) + 300 })}`;
    const token = `${body}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", rotated.privateKey, new TextEncoder().encode(body)))}`;
    const res = await Promise.all([1, 2].map(() => call("/api/me", { "Cf-Access-Jwt-Assertion": token }, e)));
    expect(res.map((r) => r.status)).toEqual([200, 200]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("an approval records the approving person from the JWT", async () => {
    serveCerts();
    const fake = fakeArtifacts();
    const e = { ...ACCESS, ARTIFACTS: fake };
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const post = (path, headers, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), e);
    expect((await post("/api/repos", OWNER, { name: "acc-approve" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("acc-approve")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const boss = { "Cf-Access-Jwt-Assertion": await jwt({ email: "boss@example.com" }) };
    const { id } = await (await post("/api/repos/acc-approve/changes", boss, { intent: "x" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.setReview({ route: "human", reason: "risk high" });
    await stub.moveHead("sha1");
    const approved = await (await post(`/api/changes/${id}/review`, boss, { verdict: "approve" })).json();
    expect(approved.approvals).toEqual([{ actor: { type: "human", id: "boss@example.com" }, head_sha: "sha1", at: expect.any(String) }]);
    expect((await stub.get()).events[0].actor).toEqual({ type: "human", id: "boss@example.com" });
  });

  it("a runner bearer token still claims jobs with Access on", async () => {
    serveCerts();
    const reg = await worker.fetch(new Request("http://cinder.test/api/runners", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "acc-lab", kinds: ["develop"] }) }), ACCESS);
    expect(reg.status).toBe(201);
    const { token } = await reg.json();
    // Access adds its JWT to every request; the bearer token still decides, so the runner claims (empty queue → 204).
    const person = { "Cf-Access-Jwt-Assertion": await jwt() };
    expect((await call("/api/work/claim", { ...person, Authorization: `Bearer ${token}` }, ACCESS, "POST")).status).toBe(204);
    // A person, even an owner, is not a runner.
    expect((await call("/api/work/claim", person, ACCESS, "POST")).status).toBe(403);
  });

  it("with Access vars unset, OWNER_TOKEN behaves as today", async () => {
    const me = await call("/api/me", OWNER, env);
    expect(me.status).toBe(200);
    expect(await me.json()).toEqual({ email: null, owner: true, nonprod: true });
    expect((await call("/api/repos", OWNER, env)).status).toBe(200);
    // An Access header means nothing without the vars: no token is still the plain 401 the token form answers.
    const res = await call("/api/me", { "Cf-Access-Jwt-Assertion": "x.y.z" }, env);
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("unauthorized");
  });

  it("the owner creates a change with author ana and the change and its created event show ana", async () => {
    const fake = fakeArtifacts();
    const e = { ...ACCESS, ARTIFACTS: fake };
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const post = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), e);
    expect((await post("/api/repos", { name: "acc-author" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("acc-author")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const created = await post("/api/repos/acc-author/changes", { intent: "x", author: "Ana@example.com" });
    expect(created.status).toBe(201);
    const change = await (await call(`/api/changes/${(await created.json()).id}`, OWNER, e)).json();
    expect(change.events[0]).toMatchObject({ kind: "created", actor: { type: "human", id: "ana@example.com" } });
    expect(await env.DB.prepare("SELECT email FROM people WHERE email = 'ana@example.com'").first()).toEqual({ email: "ana@example.com" });
  });

  it("the owner creating a change with author=bob records the owner as requester", async () => {
    const fake = fakeArtifacts();
    const e = { ...ACCESS, ARTIFACTS: fake };
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const post = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), e);
    expect((await post("/api/repos", { name: "acc-requester" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("acc-requester")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const { id } = await (await post("/api/repos/acc-requester/changes", { intent: "x", author: "bob@example.com" })).json();
    expect(await env.DB.prepare("SELECT person FROM change_requesters WHERE change_id = ?").bind(id).first("person")).toBe("boss@example.com");
  });

  it("authoring a change as a non-email actor answers 400 and creates no person", async () => {
    const e = { ...ACCESS, ARTIFACTS: fakeArtifacts() };
    const post = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), e);
    expect((await post("/api/repos", { name: "acc-author-email" })).status).toBe(201);
    const res = await post("/api/repos/acc-author-email/changes", { intent: "x", author: "bruno" });
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("bad_request");
    expect(await env.DB.prepare("SELECT email FROM people WHERE email = 'bruno'").first()).toBeNull();
  });

  it("a non-owner setting author gets 403", async () => {
    serveCerts();
    const request = new Request("http://cinder.test/api/repos/acc-author/changes", {
      method: "POST", headers: { "Cf-Access-Jwt-Assertion": await jwt({ email: "guest@example.com" }) }, body: JSON.stringify({ intent: "x", author: "ana" }),
    });
    expect(await accessPerson(request, ACCESS)).toBe("guest@example.com");
    const res = await createChange(request, ACCESS, { name: "acc-author" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("forbidden");
  });

  it("a non-author non-owner calling ready gets 403", async () => {
    serveCerts();
    const fake = fakeArtifacts();
    const e = { ...ACCESS, ARTIFACTS: fake };
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const post = (path, headers, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers, body: body && JSON.stringify(body) }), e);
    expect((await post("/api/repos", OWNER, { name: "acc-draft" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("acc-draft")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const { id } = await (await post("/api/repos/acc-draft/changes", OWNER, { intent: "x", author: "guest@example.com", draft: true })).json();
    const stranger = await post(`/api/changes/${id}/ready`, { "Cf-Access-Jwt-Assertion": await jwt({ email: "eve@example.com" }) });
    expect(stranger.status).toBe(403);
    expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).state).toBe("draft");
    // The author, though not an owner, may.
    const author = await post(`/api/changes/${id}/ready`, { "Cf-Access-Jwt-Assertion": await jwt({ email: "guest@example.com" }) });
    expect(author.status).toBe(200);
  });

  it("a requested reviewer approves without queueing the change", async () => {
    serveCerts();
    const fake = fakeArtifacts();
    const e = { ...ACCESS, ARTIFACTS: fake };
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const post = (path, body, headers = OWNER) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), e);
    expect((await post("/api/repos", { name: "acc-review-ok" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("acc-review-ok")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const { id } = await (await post("/api/repos/acc-review-ok/changes", { intent: "add retries" })).json();
    expect((await post(`/api/changes/${id}/reviewers`, { person: "ana@example.com" })).status).toBe(200);
    const ana = { "Cf-Access-Jwt-Assertion": await jwt({ email: "ana@example.com" }) };
    const res = await post(`/api/changes/${id}/review`, { verdict: "approve" }, ana);
    expect(res.status).toBe(200);
    expect((await res.json()).state).not.toBe("in_queue");
  });
});

describe("people and roles", () => {
  const as = async (email) => ({ "Cf-Access-Jwt-Assertion": await jwt({ email }) });
  const setRole = (email, role) => env.DB.prepare("INSERT INTO person_roles VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role")
    .bind(email, role).run();

  const service = async (common_name, signer) => ({ "Cf-Access-Jwt-Assertion": await jwt({ email: undefined, common_name }, signer) });
  const allow = (id, name) => worker.fetch(new Request(`http://cinder.test/api/service-tokens/${id}`, { method: "PUT", headers: OWNER, body: JSON.stringify({ name }) }), ACCESS);

  it("a service token added in the UI is accepted without ACCESS_SERVICE_TOKENS set; as a viewer GET /api/repos is 200 and POST /api/repos is 403", async () => {
    serveCerts();
    expect((await allow("abc.access", "bad name")).status).toBe(400);
    expect((await allow("abc.access", "ci-bot")).status).toBe(200);
    expect(await (await call("/api/service-tokens", OWNER)).json()).toContainEqual({ client_id: "abc.access", name: "ci-bot" });
    const me = await call("/api/me", await service("abc.access"), ACCESS);
    expect(await me.json()).toEqual({ email: "ci-bot@service-token", owner: false, nonprod: true });
    await setRole("ci-bot@service-token", "viewer");
    expect((await call("/api/repos", await service("abc.access"), ACCESS)).status).toBe(200);
    expect((await call("/api/repos", await service("abc.access"), ACCESS, "POST")).status).toBe(403);
    expect((await (await call("/api/people", OWNER, ACCESS)).json()).find((p) => p.email === "ci-bot@service-token")).toMatchObject({ role: "viewer" });
  });

  it("a non-allowlisted service token gets 401 access_no_email; a bad signature with an allowlisted one gets 401 access_denied", async () => {
    serveCerts();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    onTestFinished(() => warn.mockRestore());
    await allow("abc.access", "ci-bot");
    const unknown = await call("/api/repos", await service("nope.access"), ACCESS);
    expect(unknown.status).toBe(401);
    expect((await unknown.json()).error.code).toBe("access_no_email");
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("nope.access"));
    const forged = await call("/api/repos", await service("abc.access", forger.privateKey), ACCESS);
    expect(forged.status).toBe(401);
    expect((await forged.json()).error.code).toBe("access_denied");
  });

  it("DELETE /api/workers/byo-pools/:id removes it from GET /api/workers/byo-pools; a person without org.manage gets 403", async () => {
    serveCerts();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO byo_pools (id, name, labels, created_at) VALUES ('bp_del', 'e2e-leftover', '[]', '2026-10-01T00:00:00Z')"),
      env.DB.prepare("INSERT INTO runner_tokens (runner_id, name, kinds, token_hash, created_at) VALUES ('r_bp', 'bp-runner', '[\"verify\"]', 'h_bp', '2026-10-01T00:00:00Z')"),
      env.DB.prepare("INSERT INTO byo_members (runner_id, pool_id) VALUES ('r_bp', 'bp_del')"),
    ]);
    await setRole("viewer@example.com", "viewer");
    expect((await call("/api/workers/byo-pools/bp_del", await as("viewer@example.com"), ACCESS, "DELETE")).status).toBe(403);
    expect((await call("/api/workers/byo-pools/bp_del", OWNER, ACCESS, "DELETE")).status).toBe(204);
    expect((await call("/api/workers/byo-pools/bp_del", OWNER, ACCESS, "DELETE")).status).toBe(404);
    expect((await (await call("/api/workers/byo-pools", OWNER)).json()).some((p) => p.id === "bp_del")).toBe(false);
    expect((await (await call("/api/workers", OWNER)).json()).find((r) => r.id === "r_bp")).toMatchObject({ name: "bp-runner" });
  });

  it("granting a role PATCHes the Access policy include list with the email; revoking removes it", async () => {
    const e = { ...ACCESS, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
    const apps = "https://api.cloudflare.com/client/v4/accounts/acct/access/apps";
    let policy = { id: "pol1", name: "owners", decision: "allow", include: [{ email: { email: "boss@example.com" } }], exclude: [], require: [] };
    const puts = [];
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init = {}) => {
      if (url === apps) return Response.json({ success: true, result: [{ id: "other", aud: "x" }, { id: "app1", aud: "aud-cinder" }] });
      if (url === `${apps}/app1/policies`) return Response.json({ success: true, result: [{ id: "run", name: "runners", include: [] }, policy] });
      if (url === `${apps}/app1/policies/pol1` && init.method === "PUT") {
        puts.push(JSON.parse(init.body));
        policy = { ...policy, ...puts.at(-1) };
        return Response.json({ success: true, result: policy });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    onTestFinished(() => fetch.mockRestore());
    const add = await worker.fetch(new Request("http://cinder.test/api/people", { method: "POST", headers: OWNER, body: JSON.stringify({ email: "Dev@Example.com", role: "contributor" }) }), e);
    expect(add.status).toBe(201);
    expect(puts[0]).toEqual({ name: "owners", decision: "allow", include: [{ email: { email: "boss@example.com" } }, { email: { email: "dev@example.com" } }], exclude: [], require: [] });
    const listed = (await (await call("/api/people", OWNER, e)).json()).find((p) => p.email === "dev@example.com");
    expect(listed).toMatchObject({ email: "dev@example.com", role: "contributor", owner: false, last_seen: null });
    expect(validatePerson(listed)).toEqual({ ok: true, errors: [] });
    expect((await worker.fetch(new Request("http://cinder.test/api/people/dev%40example.com", { method: "DELETE", headers: OWNER }), e)).status).toBe(204);
    expect(puts[1].include).toEqual([{ email: { email: "boss@example.com" } }]);
    expect((await (await call("/api/people", OWNER, e)).json()).some((p) => p.email === "dev@example.com")).toBe(false);
    // An owner in OWNERS keeps their sign-in when their cinder role is removed.
    expect((await worker.fetch(new Request("http://cinder.test/api/people/boss%40example.com", { method: "DELETE", headers: OWNER }), e)).status).toBe(204);
    expect(puts).toHaveLength(2);
  });

  it("people invited in the Cloudflare dashboard list on People and take a cinder role; an unreadable Access API lists cinder's people only", async () => {
    const e = { ...ACCESS, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
    const base = "https://api.cloudflare.com/client/v4/accounts/acct/access";
    const policy = { id: "pol1", name: "owners", decision: "allow", updated_at: "2026-10-12T09:00:00Z",
      include: [{ email: { email: "Dash@Example.com" } }, { group: { id: "g1" } }], exclude: [], require: [] };
    let down = false;
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (down) return Response.json({ success: false, errors: [{ code: 10000, message: "down" }] }, { status: 503 });
      if (url === `${base}/apps`) return Response.json({ success: true, result: [{ id: "app1", aud: "aud-cinder" }] });
      if (url === `${base}/apps/app1/policies`) return Response.json({ success: true, result: [{ id: "run", name: "runners", decision: "non_identity", include: [{ email: { email: "no@example.com" } }] }, policy] });
      if (url === `${base}/groups/g1`) return Response.json({ success: true, result: { include: [{ email: { email: "grp@example.com" } }] } });
      throw new Error(`unexpected fetch ${url}`);
    });
    onTestFinished(() => fetch.mockRestore());
    const people = await (await call("/api/people", OWNER, e)).json();
    const dash = people.find((p) => p.email === "dash@example.com");
    expect(dash).toMatchObject({ role: null, last_seen: null, invited: "access", created_at: "2026-10-12T09:00:00Z" });
    expect(people.find((p) => p.email === "grp@example.com")).toMatchObject({ invited: "access" });
    expect(people.some((p) => p.email === "no@example.com")).toBe(false); // a non-identity policy admits no person
    expect(people.map((p) => validatePerson(p).ok)).not.toContain(false);

    const patch = (who) => worker.fetch(new Request(`http://cinder.test/api/people/${encodeURIComponent(who)}`, { method: "PATCH", headers: OWNER, body: JSON.stringify({ role: "maintainer" }) }), e);
    expect((await patch("dash@example.com")).status).toBe(200);
    expect((await (await call("/api/people", OWNER, e)).json()).find((p) => p.email === "dash@example.com")).toMatchObject({ role: "maintainer" });
    expect((await patch("stranger@example.com")).status).toBe(404);

    down = true;
    const fallback = await call("/api/people", OWNER, e);
    expect(fallback.status).toBe(200);
    const listed = await fallback.json();
    expect(listed.some((p) => p.email === "grp@example.com")).toBe(false);
    expect(listed.find((p) => p.email === "dash@example.com")).toMatchObject({ role: "maintainer" });
  });

  it("group mappings save, change role inline, list and delete", async () => {
    const send = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), ACCESS);
    expect((await send("PUT", "/api/groups/eng-payments", { source: "Access group", role: "nobody", repos: [] })).status).toBe(400);
    expect((await send("PUT", "/api/groups/eng-payments", { source: "Access group", role: "maintainer", repos: ["billing-api"] })).status).toBe(200);
    expect((await send("PUT", "/api/groups/eng-payments", { source: "Access group", role: "owner", repos: ["billing-api"] })).status).toBe(200);
    const groups = await (await call("/api/groups", OWNER)).json();
    expect(groups).toContainEqual({ name: "eng-payments", source: "Access group", role: "owner", repos: ["billing-api"] });
    expect(groups.map((g) => validateGroup(g).ok)).not.toContain(false);
    expect((await send("DELETE", "/api/groups/eng-payments")).status).toBe(204);
    expect((await (await call("/api/groups", OWNER)).json()).some((g) => g.name === "eng-payments")).toBe(false);
  });

  it("git credentials: a write token for the repo itself to a person with write access, 403 to one without", async () => {
    serveCerts();
    const fake = fakeArtifacts();
    const e = { ...ACCESS, ARTIFACTS: fake };
    expect((await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "creds" }) }), e)).status).toBe(201);
    await setRole("dev@example.com", "developer");
    await setRole("view@example.com", "viewer");
    const res = await call("/api/repos/creds/git-credentials", await as("dev@example.com"), e, "POST");
    expect(res.status).toBe(200);
    const grant = await res.json();
    expect(grant).toEqual({ remote: "https://artifacts.fake/cinder/creds.git", token: expect.stringMatching(/^fake-token-/), expires_at: expect.any(String) });
    expect(fake.calls.filter((c) => c.method === "createToken" || c.method === "fork")).toEqual([{ method: "createToken", args: ["creds", "write", 600] }]);
    const denied = await call("/api/repos/creds/git-credentials", await as("view@example.com"), e, "POST");
    expect(denied.status).toBe(403);
    expect((await denied.json()).error.message).toBe("you need write access to creds to get git credentials");
    expect(fake.calls.filter((c) => c.method === "createToken")).toHaveLength(1);
  });

  it("only an owner or maintainer may create or delete a branch", async () => {
    serveCerts();
    const e = { ...ACCESS, ARTIFACTS: fakeArtifacts() };
    expect((await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "rbac-branch" }) }), e)).status).toBe(201);
    await setRole("dev@example.com", "developer");
    await setRole("mai@example.com", "maintainer");
    expect((await call("/api/repos/rbac-branch/branches/x", await as("dev@example.com"), e, "DELETE")).status).toBe(403);
    // Past the role check: the handler refuses deleting the default branch.
    expect((await call("/api/repos/rbac-branch/branches/main", await as("mai@example.com"), e, "DELETE")).status).toBe(409);
  });

  it("a viewer gets 403 on change approve; a maintainer can approve", async () => {
    serveCerts();
    const fake = fakeArtifacts();
    const e = { ...ACCESS, ARTIFACTS: fake };
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const post = (path, headers, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), e);
    expect((await post("/api/repos", OWNER, { name: "rbac-approve" })).status).toBe(201);
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("rbac-approve")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
    const { id } = await (await post("/api/repos/rbac-approve/changes", OWNER, { intent: "x" })).json();
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.setReview({ route: "human", reason: "risk high" });
    await stub.moveHead("sha1");
    await setRole("vic@example.com", "viewer");
    await setRole("mai@example.com", "maintainer");
    const viewer = await post(`/api/changes/${id}/review`, await as("vic@example.com"), { verdict: "approve" });
    expect(viewer.status).toBe(403);
    expect((await call(`/api/changes/${id}`, await as("vic@example.com"), e)).status).toBe(200);
    const maintainer = await post(`/api/changes/${id}/review`, await as("mai@example.com"), { verdict: "approve" });
    expect(maintainer.status).toBe(200);
    expect((await maintainer.json()).approvals[0].actor).toEqual({ type: "human", id: "mai@example.com" });
  });

  it("a per-repo override grants write on one repo only", async () => {
    serveCerts();
    const e = { ...ACCESS, ARTIFACTS: fakeArtifacts() };
    const put = (path, headers, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "PUT", headers, body: JSON.stringify(body) }), e);
    for (const name of ["rbac-one", "rbac-two"]) {
      expect((await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }), e)).status).toBe(201);
    }
    await setRole("ovr@example.com", "viewer");
    const person = await as("ovr@example.com");
    expect((await put("/api/repos/rbac-one/settings", person, {})).status).toBe(403);
    expect((await put("/api/repos/rbac-one/people/ovr%40example.com", OWNER, { role: "developer" })).status).toBe(200);
    expect((await put("/api/repos/rbac-one/settings", person, {})).status).toBe(204);
    expect((await put("/api/repos/rbac-two/settings", person, {})).status).toBe(403);
  });

  const send = (method, path, headers, body, e = ACCESS) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers, body: body && JSON.stringify(body) }), e);

  it("GET …/people lists repo roles with set_by and at", async () => {
    const e = { ...ACCESS, ARTIFACTS: fakeArtifacts() };
    expect((await send("POST", "/api/repos", OWNER, { name: "rr-list" }, e)).status).toBe(201);
    expect((await send("PUT", "/api/repos/rr-list/people/Rae%40example.com", OWNER, { role: "maintainer" })).status).toBe(200);
    const people = await (await send("GET", "/api/repos/rr-list/people", OWNER)).json();
    expect(people).toEqual([{ email: "rae@example.com", role: "maintainer", set_by: "boss@example.com", at: expect.any(String) }]);
    expect(validateRepoRole(people[0])).toEqual({ ok: true, errors: [] });
  });

  it("DELETE …/people/:email removes the role, and returns 403 when the caller lacks people.manage", async () => {
    serveCerts();
    const e = { ...ACCESS, ARTIFACTS: fakeArtifacts() };
    expect((await send("POST", "/api/repos", OWNER, { name: "rr-del" }, e)).status).toBe(201);
    await send("PUT", "/api/repos/rr-del/people/rae%40example.com", OWNER, { role: "developer" });
    await setRole("mai@example.com", "maintainer");
    expect((await send("DELETE", "/api/repos/rr-del/people/rae%40example.com", await as("mai@example.com"))).status).toBe(403);
    expect(await (await send("GET", "/api/repos/rr-del/people", OWNER)).json()).toHaveLength(1);
    expect((await send("DELETE", "/api/repos/rr-del/people/rae%40example.com", OWNER)).status).toBe(204);
    expect(await (await send("GET", "/api/repos/rr-del/people", OWNER)).json()).toEqual([]);
  });

  it("GET /api/roles returns built-in roles first, then custom ones", async () => {
    expect((await send("PUT", "/api/roles/auditor", OWNER, { capabilities: ["repo.read"] })).status).toBe(200);
    expect((await send("PUT", "/api/roles/agent-ops", OWNER, { capabilities: ["agent.release"] })).status).toBe(200);
    const roles = await (await send("GET", "/api/roles", OWNER)).json();
    expect(roles.map((r) => r.name)).toEqual(["owner", "admin", "maintainer", "contributor", "developer", "viewer", "agent-ops", "auditor"]);
    expect(roles.at(-1)).toEqual({ name: "auditor", capabilities: ["repo.read"], built_in: false });
    expect(roles[0].built_in).toBe(true);
    expect(roles.map((r) => validateRole(r).ok)).not.toContain(false);
  });

  it("DELETE /api/repos/:name returns 403 for a non-owner and 400 on a confirm mismatch", async () => {
    serveCerts();
    const e = { ...ACCESS, ARTIFACTS: fakeArtifacts() };
    expect((await send("POST", "/api/repos", OWNER, { name: "rr-gone" }, e)).status).toBe(201);
    // An admin holds every capability, so the refusal is the owner-only check, not the role check.
    await setRole("adm@example.com", "admin");
    expect((await send("DELETE", "/api/repos/rr-gone", await as("adm@example.com"), { confirm: "rr-gone" }, e)).status).toBe(403);
    expect((await send("DELETE", "/api/repos/rr-gone", OWNER, { confirm: "rr-gon" }, e)).status).toBe(400);
    expect((await send("DELETE", "/api/repos/rr-gone", OWNER, {}, e)).status).toBe(400);
    expect(await env.DB.prepare("SELECT 1 FROM repos WHERE name = 'rr-gone'").first()).not.toBeNull();
  });
});
