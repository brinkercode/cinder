import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, inject, it, vi } from "vitest";
import { INTENTS, REPO } from "../../seed/demo.mjs";
import { REPOS } from "../../seed/seed.mjs";
import { validateSeedRun } from "../src/api/shapes.js";
import worker, { SeedWorkflow } from "../src/index.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";
import { fakeReset } from "./fakes/reset.js";
import { indexPulse } from "./fakes/seed.js";

// Artifacts whose repos are relay bare repos, so the seed route's pushes land and every later read sees them; each
// create (a reset deletes, the seed creates again) starts a fresh bare repo. The rest (a change's fork) stays the fake's.
function relayArtifacts() {
  const fake = fakeArtifacts(), dir = crypto.randomUUID(), at = new Map();
  let n = 0;
  return Object.assign(Object.create(fake), {
    async create(name, opts) {
      await fake.create(name, opts);
      at.set(name, `${dir}-${name}-${n++}`);
      await git(["init", "-q", "--bare", "-b", "main", `${at.get(name)}.git`]);
      const repo = bareRepo(at.get(name));
      return { name, ...(await repo.info()), defaultBranch: "main", token: (await repo.createToken()).plaintext };
    },
    async get(name) {
      const repo = await fake.get(name);
      if (!at.has(name)) return repo;
      const bare = bareRepo(at.get(name));
      // info() names the repo as cinder does: the push marks and cached heads are keyed by it.
      return Object.assign(repo, bare, { info: async () => ({ name, remote: (await bare.info()).remote }) });
    },
  });
}

let cf;
beforeEach(() => {
  cf = fakeCloudflare();
  const net = globalThis.fetch;
  // The Cloudflare API goes to the fake, git to the relay.
  vi.stubGlobal("fetch", cf.through((url, init) => {
    if (!String(url?.url ?? url).startsWith(inject("runnerRelay").url)) throw new Error(`unexpected fetch ${url}`);
    return net(url, init);
  }));
});
afterEach(() => {
  vi.unstubAllGlobals();
  delete env.ARTIFACTS;
});

// A nonprod Worker env whose SEED and RESET Workflows run in the background like the platform's; runs holds their promises.
function nonprod(extra = {}) {
  const e = { ...env, ...cf.env, CINDER_ENV: "nonprod", ARTIFACTS: relayArtifacts(), PIPELINE: { create: async () => ({}) }, ...extra };
  // RepoDO reads .cinder.yml through the shared env.
  env.ARTIFACTS = e.ARTIFACTS;
  const runs = [];
  const step = { do: async (name, fn) => fn() };
  e.RESET = fakeReset(e);
  e.SEED = { runs, create: async ({ id, params }) => { runs.push(SeedWorkflow.prototype.run.call({ env: e, ctx: undefined }, { instanceId: id, payload: params }, step)); return { id }; } };
  return e;
}
const call = (e, method, path, body, headers = { Authorization: `Bearer ${env.OWNER_TOKEN}` }) =>
  worker.fetch(new Request(`http://cinder.test${path}`, { method, headers, body: body && JSON.stringify(body) }), e);
// Starts POST path, waits for its Workflow and returns GET /api/admin/seed/:id.
async function run(e, path) {
  const res = await call(e, "POST", path);
  expect(res.status).toBe(202);
  const { id } = await res.json();
  await Promise.allSettled(e.SEED.runs);
  return (await call(e, "GET", `/api/admin/seed/${id}`)).json();
}

// The demo runs first: the reseed then starts from its leftovers, and its queued index job is the only one indexPulse can claim.
it("reseed and the demo scenario are refused for a non-owner and outside nonprod", async () => {
  serveCerts();
  await env.DB.prepare("INSERT OR REPLACE INTO person_roles (email, role) VALUES ('admin@example.com', 'admin')").run();
  const access = nonprod(ACCESS);
  const prod = nonprod({ CINDER_ENV: undefined });
  for (const path of ["/api/admin/seed", "/api/admin/demo"]) {
    expect((await call(access, "POST", path, undefined, await as("admin@example.com"))).status).toBe(403);
    expect((await call(prod, "POST", path)).status).toBe(403);
  }
  expect([...access.SEED.runs, ...prod.SEED.runs]).toEqual([]);
});

it("the demo scenario files the twelve demo intents on pulse", { timeout: 120_000 }, async () => {
  const e = nonprod();
  const api = async (method, path, body, token = env.OWNER_TOKEN) => {
    const res = await call(e, method, path, body, { Authorization: `Bearer ${token}` });
    return res.status === 204 || (res.status === 404 && method === "GET") ? null : res.json();
  };
  const [status] = await Promise.all([run(e, "/api/admin/demo"), indexPulse(api)]);
  expect([status.status, status.step, status.error]).toEqual(["done", "demo", null]);
  const changes = (await api("GET", `/api/repos/${REPO}/changes`)).filter((c) => c.kind !== "seam");
  expect(new Set(changes.map((c) => c.intent))).toEqual(new Set(INTENTS.map((i) => i.intent)));
  expect(INTENTS).toHaveLength(12);
  expect(changes.every((c) => c.target_branch === "develop")).toBe(true);
});

it("an owner's reseed empties and seeds the deployment with no repo checkout", { timeout: 600_000 }, async () => {
  const e = nonprod();
  expect((await call(e, "POST", "/api/repos", { name: "leftover" })).status).toBe(201);
  const status = await run(e, "/api/admin/seed");
  expect(validateSeedRun(status)).toEqual({ ok: true, errors: [] });
  expect([status.status, status.step, status.error]).toEqual(["done", "seed", null]);
  const repos = (await (await call(e, "GET", "/api/repos")).json()).map((r) => r.name);
  expect(repos).not.toContain("leftover");
  expect(repos).toEqual(expect.arrayContaining(Object.values(REPOS)));
  // The repos hold seed/repos' files, from the sources bundled into the Worker.
  const tree = await (await call(e, "GET", `/api/repos/${REPOS.trunk}/tree?ref=main&path=&recursive=1`)).json();
  expect(JSON.stringify(tree)).toContain("orders.go");
  expect((await (await call(e, "GET", "/api/people")).json()).length).toBeGreaterThanOrEqual(5);
});
