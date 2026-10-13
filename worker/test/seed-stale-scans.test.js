// Stale queued daily scans on several repos: claims are global and oldest first, and an empty repo's scan fails
// at claim with a 204. Its own file: storage is shared within a file.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, it, vi } from "vitest";
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
// As seed-full.test.js: the real seed route into a relay bare repo, mirrored into the fake. The relay's repos dir is
// shared by every file, so this file's bare repos get their own prefix.
const commit = (body) => relayCommit("stale", fake)(body);

// Live's state: checkout-js has no scans and yesterday's daily scans sit queued on pulse-smoke (no commits), billing-api
// and checkout-js, oldest first.
const staleScans = async () => {
  const mine = "SELECT job_id FROM scans WHERE repo_id = (SELECT id FROM repos WHERE name = ?1)";
  await env.DB.batch(["scan_licenses", "scan_deps", "scans"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE job_id IN (${mine})`).bind(REPOS.gitflow)));
  for (const [i, name] of ["pulse-smoke", REPOS.infra, REPOS.gitflow].entries()) {
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) SELECT ?, id, 'scan', 'queued', ?, json_object('target', default_branch, 'source', 'daily') FROM repos WHERE name = ?")
      .bind(crypto.randomUUID(), `2026-01-01T13:30:0${i}.000Z`, name).run();
  }
};

beforeAll(async () => {
  fake = await agentsFake(`seed-${crypto.randomUUID()}`, SEED_IMPORTS);
  env.ARTIFACTS = fake;
  vi.stubGlobal("fetch", cf.through(globalThis.fetch)); // the keystore and model keys' Cloudflare API; the rest unchanged
  await seed(api, push, ["race", "changes", "gitflow", "judges", "insights"], commit, SEED_SOURCES);
  await api("POST", "/api/repos", { name: "pulse-smoke" });
}, 120000);
afterAll(() => { delete env.ARTIFACTS; vi.unstubAllGlobals(); });

it("seed.mjs --full exits 0 against a local Worker with stale queued daily scans on 3 repos", async () => {
  await staleScans();
  await seed(api, push, "all", commit, SEED_SOURCES);
}, 120000);
