import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, inject, it } from "vitest";
import { validateBranch } from "../src/api/contract.js";
import { commit } from "../src/git/index.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const relayRemote = (n) => `${inject("runnerRelay").url}/smart/${n}.git`;
const ann = { name: "Ann", email: "ann@x.test" };

// A gitflow repo whose git holds main, develop, release/1.2 and feature/x, the tag v1.0.0 and the annotated tag v1.1.0.
// No refs job reports, so repo_refs stays empty.
async function setup(name) {
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const { sha } = await commit(bareRepo(name), { branch: "main", base: null, message: "init", author: ann, changes: [{ path: "README", content: "hi\n" }] });
  for (const ref of ["heads/develop", "heads/release/1.2", "heads/feature/x", "tags/v1.0.0"]) await git(["--git-dir", `${name}.git`, "update-ref", `refs/${ref}`, sha]);
  await git(["-c", "user.name=Ann", "-c", "user.email=ann@x.test", "--git-dir", `${name}.git`, "tag", "-a", "-m", "v1.1.0", "v1.1.0", sha]);
  const fake = fakeArtifacts({ remote: relayRemote });
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(new Request(`http://cinder.test${path}`,
    { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
  await call("/api/repos", { name });
  fake.repos.get(name).files[".cinder.yml"] = "branches:\n  integration: [develop, main]\n";
  fake.repos.get(name).commits.unshift({ sha: "c1", message: "init" });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  const branches = async () => {
    const list = await (await call(`/api/repos/${name}/branches`)).json();
    for (const b of list) expect(validateBranch(b), b.name).toEqual({ ok: true, errors: [] });
    return list;
  };
  return { repo, sha, branches, fake };
}

describe("branches list", () => {
  it("with a git fixture holding main, develop, release/1.2, feature/x and tags v1.0.0 and v1.1.0, and an empty repo_refs, the branches API returns all four branches and both tags", async () => {
    const { repo, sha, branches } = await setup("br-git");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM repo_refs WHERE repo_id = ?").bind(repo.id).first()).n).toBe(0);
    expect((await branches()).map(({ name, kind, default: d, head_sha }) => ({ name, kind, d, head_sha }))).toEqual([
      { name: "develop", kind: "branch", d: false, head_sha: sha }, { name: "feature/x", kind: "branch", d: false, head_sha: sha },
      { name: "main", kind: "branch", d: true, head_sha: sha }, { name: "release/1.2", kind: "branch", d: false, head_sha: sha },
      { name: "v1.0.0", kind: "tag", d: false, head_sha: sha }, { name: "v1.1.0", kind: "tag", d: false, head_sha: sha },
    ]);
  });

  it("lists develop and main with their policy roles", async () => {
    const { branches } = await setup("br-roles");
    const last_commit = { sha: "c1", message: "init", author: null };
    expect((await branches()).filter((b) => b.kind === "branch").map(({ name, role, ahead, behind, last_commit }) => ({ name, role, ahead, behind, last_commit }))).toEqual([
      { name: "develop", role: "integration", ahead: 0, behind: 0, last_commit },
      { name: "feature/x", role: "other", ahead: 0, behind: 0, last_commit },
      { name: "main", role: "integration", ahead: 0, behind: 0, last_commit },
      { name: "release/1.2", role: "other", ahead: 0, behind: 0, last_commit },
    ]);
  });

  it("two branch-list requests without a push perform one refs computation and no D1 write", async () => {
    const { fake } = await setup("br-cached");
    const writes = [];
    const DB = new Proxy(env.DB, { get: (db, k) => (k === "prepare" ? (sql) => {
      if (/^\s*(INSERT|UPDATE|DELETE|REPLACE)/i.test(sql)) writes.push(sql);
      return db.prepare(sql);
    } : typeof db[k] === "function" ? db[k].bind(db) : db[k]) });
    const list = async () => (await worker.fetch(new Request("http://cinder.test/api/repos/br-cached/branches",
      { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), { ...env, DB, ARTIFACTS: fake })).json();
    // branchHeads logs each of the six refs by sha.
    const refLogs = () => fake.calls.filter((c) => c.method === "log" && /^[0-9a-f]{40}$/.test(c.args[1])).length;
    const first = await list();
    expect(refLogs()).toBe(6);
    expect(await list()).toEqual(first);
    expect(refLogs()).toBe(6);
    expect(writes).toEqual([]);
  });

  it("a second branches request on unchanged refs makes no Artifacts call", async () => {
    const { fake, branches } = await setup("br-no-artifacts");
    const first = await branches();
    const calls = fake.calls.length;
    expect(await branches()).toEqual(first);
    expect(fake.calls.slice(calls)).toEqual([]);
  });

  it("the branches response carries Server-Timing", async () => {
    await setup("br-timing");
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/br-timing/branches", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } }), env);
    expect(res.status).toBe(200);
    expect(res.headers.get("Server-Timing")).toMatch(/^repo;dur=[\d.]+, (refs|open);dur=[\d.]+, (refs|open);dur=[\d.]+$/);
  });

  it("shows the open-change count per target", async () => {
    const { repo, branches } = await setup("br-open");
    const add = (id, target, state) => env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, ?, ?, '')")
      .bind(id, repo.id, target, state).run();
    await add("br-open-1", "develop", "developing");
    await add("br-open-2", "develop", "in_queue");
    await add("br-open-3", "develop", "merged");
    await add("br-open-4", "main", "closed");
    expect((await branches()).slice(0, 3).map(({ name, open_changes }) => ({ name, open_changes }))).toEqual([
      { name: "develop", open_changes: 2 }, { name: "feature/x", open_changes: 0 }, { name: "main", open_changes: 0 },
    ]);
  });

  it("the branch list's open count for a target includes its failed changes", async () => {
    const { repo, branches } = await setup("br-failed");
    for (const [id, state] of [["br-failed-1", "developing"], ["br-failed-2", "failed"], ["br-failed-3", "failed"], ["br-failed-4", "merged"]]) {
      await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'develop', ?, '')").bind(id, repo.id, state).run();
    }
    expect((await branches()).find((b) => b.name === "develop").open_changes).toBe(3);
  });
});

it("GET /api/repos/:repo/branches on a repo whose only branch is master with commits returns master", async () => {
  await git(["init", "-q", "--bare", "-b", "master", "br-master.git"]);
  const { sha } = await commit(bareRepo("br-master"), { branch: "master", base: null, message: "init", author: ann, changes: [{ path: "README", content: "hi\n" }] });
  const fake = fakeArtifacts({ remote: relayRemote });
  const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`,
    { method: body ? "POST" : "GET", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
  await call("/api/repos", { name: "br-master", default_branch: "master" });
  fake.repos.get("br-master").commits.unshift({ sha: "m1", message: "init" });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("br-master")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const res = await call("/api/repos/br-master/branches");
  expect(res.status).toBe(200);
  const list = await res.json();
  for (const b of list) expect(validateBranch(b)).toEqual({ ok: true, errors: [] });
  expect(list.map(({ name, head_sha }) => ({ name, head_sha }))).toEqual([{ name: "master", head_sha: sha }]);
});

describe("branch create and delete", () => {
  it("create and delete a branch persist after a reload", async () => {
    const { sha, branches } = await setup("br-write");
    const write = (method, path, body) => worker.fetch(new Request(`http://cinder.test/api/repos/br-write/branches${path}`, { method,
      headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: { get: async (n) => bareRepo(n) } });
    expect((await write("POST", "", { name: "feature/new", from: "main" })).status).toBe(201);
    expect(await git(["--git-dir", "br-write.git", "rev-parse", "refs/heads/feature/new"])).toBe(sha);
    expect((await branches()).map((b) => b.name)).toContain("feature/new");
    // Taken names, bad names and the default branch are refused.
    expect((await write("POST", "", { name: "feature/new" })).status).toBe(409);
    expect((await write("POST", "", { name: "a..b" })).status).toBe(400);
    expect((await write("DELETE", "/main")).status).toBe(409);
    expect((await write("DELETE", "/%E0")).status).toBe(400);
    expect((await write("DELETE", "/feature%2Fnew")).status).toBe(204);
    expect(await git(["--git-dir", "br-write.git", "branch", "--list", "feature/new"])).toBe("");
    expect((await branches()).map((b) => b.name)).not.toContain("feature/new");
  });
});
