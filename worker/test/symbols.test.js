import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished } from "vitest";
import { validateSymbolIndex } from "../src/api/contract.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const call = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, init), { ...env, ARTIFACTS: fakeArtifacts() });

// `cinder-verify symbols` output for a.go (func A, lines 4-6) and b.js (function b, lines 1-3).
const OUTPUT = [
  { name: "A", kind: "func", path: "a.go", line: 4, end: 6 },
  { name: "b", kind: "function", path: "b.js", line: 1, end: 3 },
];

async function setup(name) {
  await call("/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) });
  const repo = await env.DB.prepare("SELECT id, name FROM repos WHERE name = ?").bind(name).first();
  const reg = await call("/api/runners", { method: "POST", headers: OWNER, body: JSON.stringify({ name: `${name}-r`, kinds: ["index"] }) });
  const { id, token } = await reg.json();
  const runner = { Authorization: `Bearer ${token}` };
  const fake = fakeArtifacts();
  await fake.create(name);
  fake.repos.get(name).commits.unshift({ sha: "h1" });
  const stub = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  const symbols = () => runInDurableObject(stub, (instance) => {
    instance.env = { ...instance.env, ARTIFACTS: fake };
    return instance.symbols(repo, "main");
  });
  // The runner holds the repo's queued index job, as a claim would leave it.
  const put = async (sha, body) => {
    await env.DB.prepare("UPDATE jobs SET status = 'claimed', runner_id = ?, lease_expires_at = ? WHERE repo_id = ? AND kind = 'index' AND status = 'queued'")
      .bind(id, new Date(Date.now() + 60000).toISOString(), repo.id).run();
    return call(`/api/work/repos/${name}/symbols/${sha}`, { method: "PUT", headers: runner, body: JSON.stringify(body) });
  };
  return { repo, symbols, put };
}

describe("symbol index", () => {
  it("a target with no commits answers 200 with no index, not a 404", async () => {
    await call("/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "sym-empty" }) });
    const fake = fakeArtifacts();
    await fake.create("sym-empty");
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("sym-empty")), (instance) => { instance.env = { ...instance.env, ARTIFACTS: fake }; });
    const res = await call("/api/repos/sym-empty/symbols?target=main", { headers: OWNER });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ sha: null, symbols: null });
    expect(validateSymbolIndex(body).ok).toBe(true);
    expect(validateSymbolIndex({ sha: null, symbols: [] }).ok).toBe(false);
  });

  it("a Go and a JS file produce symbols with ranges", async () => {
    const { repo, symbols, put } = await setup("sym-gojs");
    expect(await symbols()).toEqual({ sha: "h1", symbols: null });
    await symbols();
    const jobs = await env.DB.prepare("SELECT payload FROM jobs WHERE repo_id = ? AND kind = 'index'").bind(repo.id).all();
    expect(jobs.results.map((j) => JSON.parse(j.payload))).toEqual([{ target: "main", sha: "h1" }]);

    expect((await put("h1", [{ ...OUTPUT[0], end: 3 }])).status).toBe(400);
    expect((await put("h1", OUTPUT)).status).toBe(204);
    // Re-indexing updates export status.
    expect((await put("h1", [OUTPUT[0], { ...OUTPUT[1], exported: true }])).status).toBe(204);
    const index = await symbols();
    expect(validateSymbolIndex(index)).toEqual({ ok: true, errors: [] });
    expect(index).toEqual({ sha: "h1", symbols: [
      { path: "a.go", name: "A", kind: "func", start: 4, end: 6, exported: false },
      { path: "b.js", name: "b", kind: "function", start: 1, end: 3, exported: true },
    ] });
  });

  it("an index request for a known sha is served from cache", async () => {
    const { repo, symbols, put } = await setup("sym-cache");
    await symbols();
    await put("h1", OUTPUT);
    const first = await symbols();
    expect(first.symbols).toHaveLength(2);
    await env.DB.prepare("DELETE FROM symbols WHERE repo_id = ?").bind(repo.id).run();
    expect(await symbols()).toEqual(first);
  });

  it("creating a change on an unindexed target queues the index first and predicts from it", async () => {
    const { repo, put } = await setup("sym-cold");
    const fake = fakeArtifacts();
    await fake.create("sym-cold");
    fake.repos.get("sym-cold").commits.unshift({ sha: "h1" });
    env.ARTIFACTS = fake;
    onTestFinished(() => { delete env.ARTIFACTS; });
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/sym-cold/changes", { method: "POST", headers: OWNER, body: JSON.stringify({ intent: "Retry fetch" }) }), env);
    expect(res.status).toBe(201);
    const change = await res.json();
    const jobs = async () => (await env.DB.prepare("SELECT kind, change_id, payload FROM jobs WHERE repo_id = ? ORDER BY kind").bind(repo.id).all()).results
      .map((j) => [j.kind, j.change_id, JSON.parse(j.payload)]);
    expect(change.state).toBe("planned");
    expect(await jobs()).toEqual([["index", null, { target: "main", sha: "h1" }]]);

    expect((await put("h1", [{ name: "retryFetch", kind: "function", path: "net.js", line: 1, end: 3, sig: "s1", body: "b1", reads: ["util.js#sleep"] },
      { name: "", kind: "file", path: "README.md", line: 1, end: 9, body: "b2" }])).status).toBe(204);
    expect(await env.DB.prepare("SELECT path, name, kind, sig, body, reads FROM symbol_hashes WHERE repo_id = ? ORDER BY path").bind(repo.id).all()).toMatchObject({ results: [
      { path: "README.md", name: "", kind: "file", sig: "", body: "b2", reads: "[]" },
      { path: "net.js", name: "retryFetch", kind: "function", sig: "s1", body: "b1", reads: "[\"util.js#sleep\"]" },
    ] });
    const develop = (await jobs()).find(([kind]) => kind === "develop");
    expect(develop.slice(0, 2)).toEqual(["develop", change.id]);
    expect(develop[2].lease).toContain("net.js#retryFetch");
  });
});
