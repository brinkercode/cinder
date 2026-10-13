import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { REPOS, client, seed } from "../../seed/seed.mjs";
import { validateReset } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";
import { fakeReset } from "./fakes/reset.js";
import { seedArtifacts } from "./fakes/seed.js";

const TEAM = "cinder-reset.cloudflareaccess.com";
const RSA = { name: "RSASSA-PKCS1-v1_5", modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: "SHA-256" };
const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const part = (obj) => b64url(new TextEncoder().encode(JSON.stringify(obj)));

// RepoDO instances read .cinder.yml through the shared env, so the fake goes there (as in seed.test.js).
const fake = seedArtifacts();
let cf, keys;
beforeAll(async () => {
  env.ARTIFACTS = fake;
  keys = await crypto.subtle.generateKey(RSA, true, ["sign", "verify"]);
});
afterAll(() => { delete env.ARTIFACTS; });
beforeEach(() => {
  cf = fakeCloudflare();
  // The Cloudflare API goes to the fake; the Access certs URL serves the test key.
  vi.stubGlobal("fetch", cf.through(async (url) => {
    if (String(url) !== `https://${TEAM}/cdn-cgi/access/certs`) throw new Error(`unexpected fetch ${url}`);
    return Response.json({ keys: [{ ...(await crypto.subtle.exportKey("jwk", keys.publicKey)), kid: "k1", alg: "RS256" }] });
  }));
});
afterEach(() => vi.unstubAllGlobals());

const nonprod = () => {
  const e = { ...env, ARTIFACTS: fake, ...cf.env, CINDER_ENV: "nonprod" };
  return Object.assign(e, { RESET: fakeReset(e) });
};
const call = (path, e, headers = { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body, method = "POST") =>
  worker.fetch(new Request(`http://cinder.test${path}`, { method, headers, body: body && JSON.stringify(body) }), e);
// Starts a reset, waits for its run, and returns its GET /api/admin/reset/:id.
async function reset(e) {
  const res = await call("/api/admin/reset", e);
  expect(res.status).toBe(202);
  const { id } = await res.json();
  await Promise.all(e.RESET.runs);
  return (await call(`/api/admin/reset/${id}`, e, undefined, undefined, "GET")).json();
}
const rows = async (table) => (await env.DB.prepare(`SELECT count(*) AS n FROM "${table}"`).first("n"));

async function jwt(email) {
  const body = `${part({ alg: "RS256", kid: "k1" })}.${part({ aud: ["aud-reset"], iss: `https://${TEAM}`, email, exp: Math.floor(Date.now() / 1000) + 300 })}`;
  return `${body}.${b64url(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", keys.privateKey, new TextEncoder().encode(body)))}`;
}

it("with CINDER_ENV=nonprod, reset empties D1 data tables (migrations table kept) and returns counts; without the var, or for a non-owner, it returns 403", async () => {
  expect((await call("/api/repos", nonprod(), undefined, { name: "leftover" })).status).toBe(201);
  expect((await call("/api/keystore", nonprod(), undefined, { name: "TOKEN", kind: "api_key", scope: "global", value: "s3cret-value" })).status).toBe(201);
  // An infrastructure secret, as deploy/reconcile.sh creates.
  await cf.fetch("https://api.cloudflare.com/client/v4/accounts/acct/secrets_store/stores/store1/secrets", { method: "POST", body: JSON.stringify([{ name: "cinder_merge_signing_key", value: "k" }]) });
  await env.LOGS.put("logs/check-1", "output");

  // Production (no CINDER_ENV) refuses and keeps the data.
  expect((await call("/api/admin/reset", { ...nonprod(), CINDER_ENV: undefined })).status).toBe(403);
  // A signed-in admin who isn't an owner may manage the org, but not reset it.
  await env.DB.prepare("INSERT INTO person_roles (email, role) VALUES ('admin@example.com', 'admin')").run();
  const access = { ...nonprod(), ACCESS_TEAM_DOMAIN: TEAM, ACCESS_AUD: "aud-reset", OWNERS: "boss@example.com" };
  expect((await call("/api/admin/reset", access, { "Cf-Access-Jwt-Assertion": await jwt("admin@example.com") })).status).toBe(403);
  expect(await rows("repos")).toBe(1);

  const status = await reset(nonprod());
  expect(validateReset(status)).toEqual({ ok: true, errors: [] });
  expect(status.status).toBe("done");
  const cleared = status.counts;
  expect(cleared).toMatchObject({ d1: { repos: 1, keystore_secrets: 1, person_roles: 1 }, artifacts: 1, logs: 1, secrets: 1, dispatch_do: 1 });
  for (const table of Object.keys(cleared.d1)) expect([table, await rows(table)]).toEqual([table, ["account", "accounts"].includes(table) ? 1 : 0]);
  expect(cleared.d1).not.toHaveProperty("d1_migrations");
  expect(await rows("d1_migrations")).toBeGreaterThan(0);
  expect([...fake.repos.keys()]).toEqual(["cinder-wiki"]);
  expect((await env.LOGS.list()).objects).toEqual([]);
  expect([...cf.secrets.values()].map((s) => s.name)).toEqual(["cinder_merge_signing_key"]);
});

it("Worker test: after reset, listing cinder-agents refs returns none, or the repo is absent", async () => {
  await fake.create("cinder-agents");
  if (!fake.repos.has("cinder-wiki")) await fake.create("cinder-wiki");
  fake.repos.get("cinder-wiki").commits.push({ sha: "old" });
  await call("/api/repos", nonprod(), undefined, { name: "newest" });
  fake.page = 1;
  try {
    expect((await reset(nonprod())).status).toBe("done");
  } finally {
    fake.page = Infinity;
  }
  expect(fake.repos.has("cinder-agents")).toBe(false);
  expect(await (await fake.get("cinder-wiki")).log({ ref: "main" })).toEqual([]);
});

it("Worker test: reset of a dataset larger than one batch completes across several steps and reports totals", async () => {
  await call("/api/repos", nonprod(), undefined, { name: "batched" });
  await Promise.all([...Array(120)].map((_, i) => env.LOGS.put(`logs/check-${i}`, "output")));
  const e = nonprod();
  const status = await reset(e);
  expect(validateReset(status)).toEqual({ ok: true, errors: [] });
  expect(status).toMatchObject({ status: "done", step: "secrets", error: null, counts: { logs: 120, dispatch_do: 1, d1: { repos: 1 } } });
  expect(e.RESET.steps.filter((s) => s.startsWith("logs "))).toEqual(["logs 0", "logs 1", "logs 2"]);
  expect(e.RESET.steps.length).toBeGreaterThan(5);
  expect((await env.LOGS.list()).objects).toEqual([]);
  expect(await rows("repos")).toBe(0);
});

it("Seed test: --reset waits for completion before the first section runs, and two runs end in the same state", async () => {
  const paths = [];
  const e = nonprod();
  const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: async (url, init) => {
    const res = await worker.fetch(new Request(url, init), e);
    const { pathname } = new URL(url);
    paths.push(`${init.method} ${pathname.startsWith("/api/admin/reset/") ? `/api/admin/reset/:id ${(await res.clone().json()).status}` : pathname}`);
    return res;
  } });
  await api("POST", "/api/repos", { name: "leftover" });
  paths.length = 0;

  await seed(api, undefined, [], undefined, undefined, true);
  expect(paths[0]).toBe("POST /api/admin/reset");
  expect(paths.indexOf("POST /api/admin/reset", 1)).toBe(-1);
  // Every call until the first section's is a poll, and the last of them saw the reset done.
  const first = paths.findIndex((p) => !p.includes("/api/admin/reset"));
  expect(paths[first - 1]).toBe("GET /api/admin/reset/:id done");
  const names = async () => (await api("GET", "/api/repos")).map((r) => r.name).sort();
  const seeded = await names();
  expect(seeded).not.toContain("leftover");
  expect(seeded).toEqual(expect.arrayContaining(Object.values(REPOS)));

  await seed(api, undefined, [], undefined, undefined, true);
  expect(await names()).toEqual(seeded);
});
