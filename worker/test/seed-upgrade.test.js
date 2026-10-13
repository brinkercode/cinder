// An instance seeded by an older seed: only the old sections, then --full. Its own file: storage is shared within a file.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { REPOS, client, commitRelease, seed } from "../../seed/seed.mjs";
import worker from "../src/index.js";
import { agentsFake } from "./fakes/agents-repo.js";
import { SEED_IMPORTS, SEED_SOURCES, relayCommit } from "./fakes/seed.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";

let fake;
const cf = fakeCloudflare();
const real = (url, init) => worker.fetch(new Request(new URL(url, "http://cinder.test"), init), { ...env, ARTIFACTS: fake, PIPELINE: { create: async () => ({}) }, ...cf.env });
const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: real });
const push = commitRelease(api);
// The relay's bare repos are shared by every test file in the run, so this file's are prefixed with its own dir.
const dir = crypto.randomUUID();
// As seed-full.test.js: the real seed route into a relay bare repo, mirrored into the fake.
const commit = (body) => relayCommit(dir, fake)(body);

beforeAll(async () => {
  fake = await agentsFake(`seed-${crypto.randomUUID()}`, SEED_IMPORTS);
  env.ARTIFACTS = fake;
  vi.stubGlobal("fetch", cf.through(globalThis.fetch)); // the keystore and model keys' Cloudflare API; the rest unchanged
  await seed(api, push, ["race", "changes", "gitflow", "judges", "insights"], commit, SEED_SOURCES);
}, 120000);
afterAll(() => { delete env.ARTIFACTS; vi.unstubAllGlobals(); });

it("upgrade seed: after only the old sections, --full completes and every section's data is present", async () => {
  await seed(api, push, "all", commit, SEED_SOURCES);
  const { trunk: t, gitflow: g } = REPOS;
  expect((await api("GET", `/api/repos/${g}/branches`)).length).toBeGreaterThan(0);
  expect((await api("GET", `/api/repos/${t}/wiki/tree`)).length).toBeGreaterThan(0);
  expect((await api("GET", `/api/repos/${t}/issues`)).length).toBe(3);
  expect((await api("GET", `/api/repos/${g}/releases`)).map((r) => r.tag)).toEqual(expect.arrayContaining(["v1.1.0", "v1.2.0-rc.1"]));
  expect((await api("GET", "/api/workers/pools")).map((p) => p.name)).toEqual(["build", "toolchains"]);
  expect((await api("GET", `/api/repos/${t}/tree?ref=main`)).entries.length).toBeGreaterThan(0);
  expect((await api("GET", "/api/agents/developer")).versions.length).toBeGreaterThanOrEqual(2);
  expect((await api("GET", `/api/repos/${g}/changes`)).some((c) => c.state === "draft")).toBe(true);
}, 120000);

it("seed.mjs --full exits 0 twice in a row against a fresh local Worker seeded by the old sections", async () => {
  await seed(api, push, "all", commit, SEED_SOURCES);
  await seed(api, push, "all", commit, SEED_SOURCES);
}, 120000);
