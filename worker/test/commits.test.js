import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from "vitest";
import { commit, listRefs } from "../src/git/index.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const ANN = { name: "Ann", email: "ann@x.test", time: 1700000000 };

it("a three-file commit to a change's fork queues verify", async () => {
  const fake = fakeArtifacts();
  const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
  expect((await call("/api/repos", { name: "commit-verify" })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("commit-verify")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const prior = env.ARTIFACTS;
  env.ARTIFACTS = fake;
  onTestFinished(() => { env.ARTIFACTS = prior; });

  const created = await (await call("/api/repos/commit-verify/changes", { intent: "Add discount", target_branch: "main" })).json();
  expect((await call(`/api/changes/${created.id}/takeover`)).status).toBe(200);
  await git(["init", "-q", "--bare", "-b", "main", `${created.fork}.git`]);
  const base = await commit(bareRepo(created.fork), { branch: "main", base: null, message: "base", author: ANN, changes: [{ path: "README", content: "hi\n" }] });
  const get = fake.get;
  fake.get = async (name) => (name === created.fork ? bareRepo(name) : get(name));
  // The first commit sends the change to verifying; the second, a workspace's staged submit, lands while it verifies.
  const first = await (await call(`/api/repos/${created.fork}/commits`, { branch: "main", base_sha: base.sha, message: "one", changes: [{ path: "a.js", content: "1\n" }] })).json();
  const res = await call(`/api/repos/${created.fork}/commits`, { branch: "main", base_sha: first.sha, message: "three",
    changes: [{ path: "a.js", content: "2\n" }, { path: "b.js", content: "2\n" }, { path: "README", content: "two\n" }] });
  expect(res.status).toBe(201);
  const { sha } = await res.json();

  expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(created.id)).get()).state).toBe("verifying");
  const { results } = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'verify' AND status = 'queued' AND id NOT IN (SELECT job_id FROM job_cancels)")
    .bind(created.id).all();
  expect(results.map((j) => JSON.parse(j.payload).head_sha)).toEqual([sha]);
  expect(await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(created.id).first("head_sha")).toBe(sha);
});

const ARTIFACTS = { get: async (name) => bareRepo(name) };

// RepoDO reads the policy through the shared env, so the bare repos go there too.
beforeAll(() => { env.ARTIFACTS = ARTIFACTS; });
afterAll(() => { delete env.ARTIFACTS; });
afterEach(() => vi.restoreAllMocks());

// A registered repo whose main holds one commit; returns main's sha and a poster for its commit API.
async function repo(name) {
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const { sha } = await commit(bareRepo(name), { branch: "main", base: null, message: "base", author: ANN, changes: [{ path: "README", content: "hi\n" }] });
  await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?1, ?1, 'main', 'trunk', '{}', ?2)")
    .bind(name, new Date().toISOString()).run();
  const post = (headers, body) => worker.fetch(new Request(`http://cinder.test/api/repos/${name}/commits`, { method: "POST", headers, body: JSON.stringify(body) }), { ...ACCESS, ARTIFACTS });
  return { sha, post };
}
const role = (email, r) => env.DB.prepare("INSERT INTO person_roles VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role").bind(email, r).run();
const feature = { branch: "feat", base_sha: null, message: "add a", changes: [{ path: "a.txt", content: "a\n" }] };

describe("commits", () => {
  it("a commit response carries Server-Timing for token, tree, pack and push", async () => {
    serveCerts();
    const { post } = await repo("cm-timing");
    await role("dev@example.com", "developer");
    const res = await post(await as("dev@example.com"), feature);
    expect(res.status).toBe(201);
    expect(res.headers.get("Server-Timing")).toMatch(/token;dur=[\d.]+, tree;dur=[\d.]+, pack;dur=[\d.]+, push;dur=[\d.]+/);
    expect(await res.json()).not.toHaveProperty("timings");
  });

  it("a commit response carries Server-Timing for auth, policy and index", async () => {
    serveCerts();
    const { post } = await repo("cm-timing2");
    await role("dev@example.com", "developer");
    // A commit onto an existing branch reads the repo's policy.
    const { sha } = await (await post(OWNER, feature)).json();
    const res = await post(await as("dev@example.com"), { ...feature, base_sha: sha });
    expect(res.status).toBe(201);
    expect(res.headers.get("Server-Timing")).toMatch(/^auth;dur=[\d.]+, policy;dur=[\d.]+, token;dur=[\d.]+, tree;dur=[\d.]+, pack;dur=[\d.]+, push;dur=[\d.]+, index;dur=[\d.]+$/);
  });

  it("a commit responds before its code index finishes", async () => {
    await repo("cm-index");
    let release;
    const gate = new Promise((r) => { release = r; });
    // The index's one batch waits on the gate; nothing else in a commit batches.
    const DB = new Proxy(env.DB, { get: (t, k) => (k === "batch" ? (s) => gate.then(() => t.batch(s)) : t[k].bind(t)) });
    const waits = [];
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/cm-index/commits", { method: "POST", headers: OWNER, body: JSON.stringify(feature) }),
      { ...env, ARTIFACTS, DB }, { waitUntil: (p) => waits.push(p) });
    expect(res.status).toBe(201);
    const indexed = () => env.DB.prepare("SELECT count(*) AS n FROM code_search WHERE store = 'cm-index' AND ref = 'feat'").first("n");
    expect(await indexed()).toBe(0);
    release();
    await Promise.all(waits);
    expect(await indexed()).toBe(1);
  });

  it("refuses a contributor's commit to the agents repo", async () => {
    serveCerts();
    await role("contrib@example.com", "contributor");
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/cinder-agents/commits", { method: "POST",
      headers: await as("contrib@example.com"), body: JSON.stringify({ ...feature, tag: "agent/dev/v9" }) }), { ...ACCESS, ARTIFACTS });
    expect(res.status).toBe(403);
    expect(await env.DB.prepare("SELECT 1 FROM tags WHERE repo = 'cinder-agents'").first()).toBeNull();
  });

  it("a repo.write member commits to a feature branch", async () => {
    serveCerts();
    const { post } = await repo("cm-member");
    await role("dev@example.com", "developer");
    const res = await post(await as("dev@example.com"), feature);
    expect(res.status).toBe(201);
    const { sha } = await res.json();
    expect(await git(["--git-dir", "cm-member.git", "rev-parse", "feat"])).toBe(sha);
    // A browser commit is a person's push, not cinder's: no ref_writes marker.
    expect(await env.DB.prepare("SELECT 1 FROM ref_writes WHERE repo = 'cm-member' AND sha = ?").bind(sha).first()).toBeNull();
  });

  it("a commit to an integration branch is still refused with 422", async () => {
    serveCerts();
    const { sha, post } = await repo("cm-main");
    await role("dev2@example.com", "developer");
    for (const headers of [OWNER, await as("dev2@example.com")]) {
      const res = await post(headers, { ...feature, branch: "main", base_sha: sha });
      expect(res.status).toBe(422);
      expect(await res.json()).toMatchObject({ error: { code: "integration_branch", hint: "open a change" } });
    }
    expect(await git(["--git-dir", "cm-main.git", "rev-parse", "main"])).toBe(sha);
  });

  it("a contributor's commit that changes .cinder.yml policy is refused", async () => {
    serveCerts();
    const { post } = await repo("cm-policy");
    await role("pol@example.com", "contributor");
    const res = await post(await as("pol@example.com"), { ...feature, changes: [{ path: ".cinder.yml", content: "rules:\n" }] });
    expect(res.status).toBe(403);
    expect(await git(["--git-dir", "cm-policy.git", "for-each-ref", "refs/heads/feat"])).toBe("");
    expect((await post(await as("pol@example.com"), feature)).status).toBe(201);
  });

  it("a viewer's commit answers 403", async () => {
    serveCerts();
    const { post } = await repo("cm-viewer");
    await role("view@example.com", "viewer");
    await role("dev3@example.com", "developer");
    const res = await post(await as("view@example.com"), feature);
    expect(res.status).toBe(403);
    expect(await git(["--git-dir", "cm-viewer.git", "for-each-ref", "refs/heads/feat"])).toBe("");
    // The refusal is the viewer's role: the same commit by a repo.write member lands.
    expect((await post(await as("dev3@example.com"), feature)).status).toBe(201);
  });
});

describe("a new repo's first commit", () => {
  const zero = "0".repeat(40);
  // A repo made with POST /api/repos (an empty bare repo), its first commit through the commit API, and the push event
  // Artifacts then delivers; returns the commit's sha and a reader of the repo's API.
  async function firstCommit(name, changes) {
    const binding = { ...ARTIFACTS, create: async (n) => {
      await git(["init", "-q", "--bare", "-b", "main", `${n}.git`]);
      // Artifacts lets a push delete the default branch; plain git refuses to delete HEAD's branch.
      await git(["--git-dir", `${n}.git`, "config", "receive.denyDeleteCurrent", "ignore"]);
      return { name: n, remote: (await bareRepo(n).info()).remote, defaultBranch: "main", token: "art_v2_secret?expires=1" };
    } };
    const e = { ...env, ARTIFACTS: binding };
    const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: body ? "POST" : "GET", headers: OWNER, body: body && JSON.stringify(body) }), e);
    expect((await call("/api/repos", { name })).status).toBe(201);
    const res = await call(`/api/repos/${name}/commits`, { branch: "main", base_sha: null, message: "first commit", changes });
    expect(res.status).toBe(201);
    const { sha } = await res.json();
    await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: name },
      payload: { ref: "refs/heads/main", before: zero, after: sha, commits: [{ message: "first commit" }] } } }] }, e);
    return { sha, get: async (path) => (await call(path)).json() };
  }

  it("a first commit with base_sha null on a new repo becomes main's head, visible to tree, log and a verify claim", async () => {
    const { sha, get } = await firstCommit("cm-first", [{ path: "a.txt", content: "a\n" }]);
    expect(await get("/api/repos/cm-first/tree?ref=main")).toMatchObject({ sha, entries: [{ name: "a.txt" }] });
    expect((await get("/api/repos/cm-first/log?ref=main")).commits.map((c) => c.sha)).toEqual([sha]);
    // A verify claim's runner checks the target branch on the repo's remote advertisement (gitauth.HasBranch).
    expect((await listRefs(bareRepo("cm-first"))).find((r) => r.name === "main")?.sha).toBe(sha);
  });

  it("Quick setup's Create a README on an empty repo leaves a non-empty main", async () => {
    const { get } = await firstCommit("cm-readme", [{ path: "README.md", content: "# cm-readme\n" }]);
    expect((await get("/api/repos/cm-readme")).empty).toBe(false);
    expect((await get("/api/repos/cm-readme/tree?ref=main")).entries.map((x) => x.name)).toEqual(["README.md"]);
  });
});
