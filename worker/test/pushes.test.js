import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, inject, it } from "vitest";
import worker, { PipelineWorkflow } from "../src/index.js";
import { validateChange } from "../src/api/contract.js";
import { commit } from "../src/git/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const pushed = (repoName, ref, after) => ({
  type: "cf.artifacts.repo.pushed",
  source: { type: "artifacts.repo", namespace: "cinder", repoName },
  payload: { ref, before: "a".repeat(40), after, commits: [] },
});

async function setup(name) {
  const fake = fakeArtifacts();
  const call = async (path, body) => (await worker.fetch(
    new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  )).json();
  const repo = await call("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  return { repo, change: await call(`/api/repos/${name}/changes`, { intent: "x" }), e: { ...env, ARTIFACTS: fake } };
}

it("fork push event updates head_sha and enqueues guard", async () => {
  const { repo, change, e } = await setup("push-fork");
  await worker.queue({ messages: [{ body: pushed(change.fork, "refs/heads/main", "b".repeat(40)) }] }, e);
  expect(await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(change.id).first("head_sha")).toBe("b".repeat(40));
  const job = await env.DB.prepare("SELECT repo_id, status, payload FROM jobs WHERE kind = 'guard' AND change_id = ?").bind(change.id).first();
  expect(job).toMatchObject({ repo_id: repo.id, status: "queued" });
  expect(JSON.parse(job.payload)).toMatchObject({ fork: change.fork, after: "b".repeat(40) });
});

it("after a push event, GET /api/changes/:id returns that head_sha", async () => {
  const { change, e } = await setup("push-head");
  const get = async () => (await worker.fetch(new Request(`http://cinder.test/api/changes/${change.id}`, { headers: OWNER }), env)).json();
  expect((await get()).head_sha).toBeNull();
  await worker.queue({ messages: [{ body: pushed(change.fork, "refs/heads/main", "f".repeat(40)) }] }, e);
  const got = await get();
  expect(got.head_sha).toBe("f".repeat(40));
  expect(validateChange(got).errors).toEqual([]);
});

it("a fork push appends one pushed event", async () => {
  const { change, e } = await setup("push-event");
  await worker.queue({ messages: [{ body: pushed(change.fork, "refs/heads/main", "9".repeat(40)) }] }, e);
  const { events } = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).get();
  expect(events.filter((e) => e.kind === "pushed")).toMatchObject([{ action: "change.push", target: "9".repeat(40), actor: { type: "system" } }]);
});

it("pipeline workflow enqueues the push to cinder-events", async () => {
  const { change, e } = await setup("push-workflow");
  const sent = [];
  const step = { do: (_name, fn) => fn() };
  // workerd only constructs a WorkflowEntrypoint for a real instance, so run() gets a stand-in `this`.
  // pipeline() is stubbed: this test covers only the enqueue step; test/pipeline.test.js covers the checks.
  const workflow = Object.assign(Object.create(PipelineWorkflow.prototype), { env: { EVENTS: { send: async (body) => { sent.push(body); } } }, pipeline: async () => {} });
  await PipelineWorkflow.prototype.run.call(workflow, { payload: pushed(change.fork, "refs/heads/main", "e".repeat(40)) }, step);
  expect(sent).toEqual([pushed(change.fork, "refs/heads/main", "e".repeat(40))]);
  await worker.queue({ messages: sent.map((body) => ({ body })) }, e);
  expect(await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(change.id).first("head_sha")).toBe("e".repeat(40));
});

it("a push starts no sandbox check", async () => {
  const { change } = await setup("push-no-sandbox");
  const ci = Object.getPrototypeOf(PipelineWorkflow.prototype);
  const real = ci.run;
  let started = 0;
  ci.run = async () => { started++; };
  try {
    const workflow = Object.assign(Object.create(PipelineWorkflow.prototype), { env: { EVENTS: { send: async () => {} } } });
    await PipelineWorkflow.prototype.run.call(workflow, { payload: pushed(change.fork, "refs/heads/main", "f".repeat(40)) }, { do: (_name, fn) => fn() });
  } finally {
    ci.run = real;
  }
  expect(started).toBe(0);
});

async function credentialedRepo(name) {
  // The relay answers for repos it lacks, so copying a pushed commit fails fast rather than on a DNS lookup.
  const fake = fakeArtifacts({ remote: (n) => `${inject("runnerRelay").url}/smart/${n}.git` });
  const e = { ...env, ARTIFACTS: fake };
  const post = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), e);
  const repo = await (await post("/api/repos", { name })).json();
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  expect((await post(`/api/repos/${name}/git-credentials`)).status).toBe(200);
  return { e, repo };
}

it("a refs/for push event creates one change with the right target", async () => {
  const { e, repo } = await credentialedRepo("push-for");
  const event = pushed("push-for", "refs/for/main", "1".repeat(40));
  await worker.queue({ messages: [{ body: event }] }, e);
  await worker.queue({ messages: [{ body: event }] }, e);
  const { results } = await env.DB.prepare("SELECT id, target_branch, state FROM changes WHERE repo_id = ?").bind(repo.id).all();
  expect(results).toMatchObject([{ target_branch: "main", state: "verifying" }]);
  const change = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(results[0].id)).get();
  expect(change.events[0].actor).toEqual({ type: "human", id: "owner" });
  expect(await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(change.id).first("head_sha")).toBe("1".repeat(40));
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE change_id = ? AND kind = 'verify'").bind(change.id).first("n")).toBe(1);
});

it("a push to refs/for/main on the base repo by a credentialed person creates one change with that commit and target main", async () => {
  const { e, repo } = await credentialedRepo("push-base-for");
  await worker.queue({ messages: [{ body: pushed("push-base-for", "refs/for/main", "3".repeat(40)) }] }, e);
  const { results } = await env.DB.prepare("SELECT c.id, c.target_branch, h.head_sha FROM changes c JOIN change_heads h ON h.change_id = c.id WHERE c.repo_id = ?").bind(repo.id).all();
  expect(results).toMatchObject([{ target_branch: "main", head_sha: "3".repeat(40) }]);
  const change = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(results[0].id)).get();
  expect(change.events[0].actor).toEqual({ type: "human", id: "owner" });
});

it("a push event for tag agent/dev/v4 with a lock message records version 4 with that lock, once, even when delivered twice", async () => {
  const lock = { name: "dev", version: 4, harness: "claude-code", model: "claude-opus-5-5", effort: "high", prompt_hash: "sha256:abc",
    tools: ["bash", "edit"], limits: { max_cost_usd: 8, max_minutes: 120 }, egress: ["pkg.go.dev"] };
  const event = pushed("cinder-agents", "refs/tags/agent/dev/v4", "d".repeat(40));
  event.payload.commits = [{ id: "e".repeat(40), message: JSON.stringify(lock, null, 2) }];
  await env.DB.prepare("INSERT INTO ref_writes (repo, ref, sha) VALUES ('cinder-agents', 'refs/tags/agent/dev/v4', ?)").bind("d".repeat(40)).run();
  await worker.queue({ messages: [{ body: event }] }, env);
  await worker.queue({ messages: [{ body: event }] }, env);
  const { results } = await env.DB.prepare("SELECT * FROM agent_versions WHERE name = 'dev'").all();
  expect(results).toEqual([{ id: "agent/dev/v4", name: "dev", version: 4, harness: "claude-code", model: "claude-opus-5-5", effort: "high",
    prompt_hash: "sha256:abc", tools: '["bash","edit"]', limits: '{"max_cost_usd":8,"max_minutes":120}' }]);
  const { results: releases } = await env.DB.prepare("SELECT egress FROM agent_releases WHERE name = 'dev'").all();
  expect(releases).toEqual([{ egress: '["pkg.go.dev"]' }]);
  // The first release of an agent goes to canary.
  expect((await env.DB.prepare("SELECT channel, version FROM channels WHERE agent_name = 'dev'").all()).results).toEqual([{ channel: "canary", version: 4 }]);
});

it("ignores an agent tag cinder did not write", async () => {
  const lock = { name: "rogue", version: 1, harness: "claude-code", model: "claude-opus-5-5", effort: "high", prompt_hash: "sha256:abc",
    tools: [], limits: { max_cost_usd: 8, max_minutes: 120 }, egress: [] };
  const event = pushed("cinder-agents", "refs/tags/agent/rogue/v1", "d".repeat(40));
  event.payload.commits = [{ id: "e".repeat(40), message: JSON.stringify(lock) }];
  const versions = () => env.DB.prepare("SELECT COUNT(*) AS n FROM agent_versions WHERE name = 'rogue'").first("n");
  await worker.queue({ messages: [{ body: event }] }, env);
  expect(await versions()).toBe(0);
  // The same tag pushed while a release job of rogue holds its lease is a release.
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, lease_expires_at, payload) VALUES (?, 'cinder-agents', 'release', 'claimed', ?, ?, ?)")
    .bind(crypto.randomUUID(), new Date().toISOString(), new Date(Date.now() + 60000).toISOString(), JSON.stringify({ name: "rogue" })).run();
  await worker.queue({ messages: [{ body: event }] }, env);
  expect(await versions()).toBe(1);
});

it("rejects an agent tag whose model does not fit its harness", async () => {
  const lock = { name: "misfit", version: 1, harness: "claude-code", model: "gpt-5", effort: "high", prompt_hash: "sha256:abc",
    tools: [], limits: { max_cost_usd: 8, max_minutes: 120 }, egress: [] };
  const event = pushed("cinder-agents", "refs/tags/agent/misfit/v1", "d".repeat(40));
  event.payload.commits = [{ id: "e".repeat(40), message: JSON.stringify(lock) }];
  await env.DB.prepare("INSERT INTO ref_writes (repo, ref, sha) VALUES ('cinder-agents', 'refs/tags/agent/misfit/v1', ?)").bind("d".repeat(40)).run();
  const sent = [];
  const REPO_DO = { idFromName: (n) => n, get: () => ({ dropHeads: async () => {}, broadcast: async (m) => { sent.push(m); } }) };
  await worker.queue({ messages: [{ body: event }] }, { ...env, REPO_DO });
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM agent_versions WHERE name = 'misfit'").first("n")).toBe(0);
  expect(sent).toMatchObject([{ kind: "agent.tag_refused", ref: "refs/tags/agent/misfit/v1", reason: "model_not_for_harness", harness: "claude-code", model: "gpt-5" }]);
});

it("a tag push creates a tags row", async () => {
  await setup("push-tag");
  await worker.queue({ messages: [{ body: pushed("push-tag", "refs/tags/v2.0.0", "d".repeat(40)) }] }, env);
  expect(await env.DB.prepare("SELECT sha FROM tags WHERE repo = ? AND name = ?").bind("push-tag", "v2.0.0").first("sha")).toBe("d".repeat(40));
});

it("a tag-delete push removes the tag", async () => {
  await setup("push-tag-delete");
  await worker.queue({ messages: [{ body: pushed("push-tag-delete", "refs/tags/v1", "d".repeat(40)) }] }, env);
  await worker.queue({ messages: [{ body: pushed("push-tag-delete", "refs/tags/v1", "0".repeat(40)) }] }, env);
  expect(await env.DB.prepare("SELECT 1 FROM tags WHERE repo = ? AND name = 'v1'").bind("push-tag-delete").first()).toBeNull();
});

it("a push of a new non-protected branch lists it in GET /api/repos/:name/branches", async () => {
  const name = "push-branch";
  const dir = ["--git-dir", `${name}.git`];
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const { sha } = await commit(bareRepo(name), { branch: "main", base: null, message: "init", author: { name: "Ann", email: "ann@x.test" }, changes: [{ path: "README", content: "hi\n" }] });
  const fake = fakeArtifacts({ remote: (n) => `${inject("runnerRelay").url}/smart/${n}.git` });
  const e = { ...env, ARTIFACTS: fake };
  expect((await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }), e)).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  // A person's push of feature/q, as git leaves it, then its event: the branch stays and is listed.
  await git([...dir, "update-ref", "refs/heads/feature/q", sha]);
  await worker.queue({ messages: [{ body: { ...pushed(name, "refs/heads/feature/q", sha), payload: { ref: "refs/heads/feature/q", before: "0".repeat(40), after: sha, commits: [] } } }] }, e);
  expect(await git([...dir, "rev-parse", "refs/heads/feature/q"])).toBe(sha);
  const res = await worker.fetch(new Request(`http://cinder.test/api/repos/${name}/branches`, { headers: OWNER }), e);
  expect((await res.json()).map((b) => b.name)).toContain("feature/q");
});

it("a direct push to a protected target (main, develop, release/1.2) is rolled back and no ref moves", async () => {
  const name = "push-protected";
  const bare = { get: async (n) => bareRepo(n) };
  expect((await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }), { ...env, ARTIFACTS: fakeArtifacts() })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: bare }; });
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const { sha: base, tree } = await commit(bareRepo(name), { branch: "main", base: null, message: "policy", author: { name: "Ann", email: "ann@x.test" },
    changes: [{ path: ".cinder.yml", content: "branches:\n  integration: [main, develop]\n  release: [release/*]\n" }] });
  const dir = ["--git-dir", `${name}.git`];
  await git([...dir, "update-ref", "refs/heads/develop", base]);
  // A person's push, as git leaves it: the refs already moved, with no marker from cinder.
  const who = { GIT_AUTHOR_NAME: "Eve", GIT_AUTHOR_EMAIL: "eve@x.test", GIT_COMMITTER_NAME: "Eve", GIT_COMMITTER_EMAIL: "eve@x.test" };
  const direct = await git([...dir, "commit-tree", tree, "-p", base, "-m", "direct"], { env: who });
  const zero = "0".repeat(40);
  for (const [ref, before] of [["refs/heads/main", base], ["refs/heads/develop", base], ["refs/heads/release/1.2", zero]]) {
    await git([...dir, "update-ref", ref, direct]);
    await worker.queue({ messages: [{ body: { ...pushed(name, ref, direct), payload: { ref, before, after: direct, commits: [] } } }] }, { ...env, ARTIFACTS: bare });
  }
  expect(await git([...dir, "rev-parse", "refs/heads/main", "refs/heads/develop"])).toBe(`${base}\n${base}`);
  expect(await git([...dir, "for-each-ref", "refs/heads/release"])).toBe("");
});

it("an annotated tag records the commit sha", async () => {
  const name = "push-annotated-tag";
  expect((await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }), { ...env, ARTIFACTS: fakeArtifacts() })).status).toBe(201);
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const author = { name: "Ann", email: "ann@x.test" };
  const { sha } = await commit(bareRepo(name), { branch: "main", base: null, message: "one", author, changes: [{ path: "a", content: "1\n" }], tag: "v1", ours: false });
  const object = await git(["--git-dir", `${name}.git`, "rev-parse", "refs/tags/v1"]);
  expect(object).not.toBe(sha);
  await worker.queue({ messages: [{ body: pushed(name, "refs/tags/v1", object) }] }, { ...env, ARTIFACTS: { get: async (n) => bareRepo(n) } });
  expect(await env.DB.prepare("SELECT sha FROM tags WHERE repo = ? AND name = 'v1'").bind(name).first("sha")).toBe(sha);
});

it("rolls back a push that moves a released tag", async () => {
  const name = "push-released-tag";
  const bare = { get: async (n) => bareRepo(n) };
  const e = { ...env, ARTIFACTS: bare };
  expect((await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }), { ...env, ARTIFACTS: fakeArtifacts() })).status).toBe(201);
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const { sha, tree } = await commit(bareRepo(name), { branch: "main", base: null, message: "one", author: { name: "Ann", email: "ann@x.test" }, changes: [{ path: "a", content: "1\n" }] });
  const dir = ["--git-dir", `${name}.git`];
  const zero = "0".repeat(40);
  const push = async (before, after) => {
    await git([...dir, ...(after === zero ? ["update-ref", "-d", "refs/tags/v1"] : ["update-ref", "refs/tags/v1", after])]);
    await worker.queue({ messages: [{ body: { ...pushed(name, "refs/tags/v1", after), payload: { ref: "refs/tags/v1", before, after, commits: [] } } }] }, e);
  };
  await push(zero, sha);
  const res = await worker.fetch(new Request(`http://cinder.test/api/repos/${name}/releases`, { method: "POST", headers: OWNER, body: JSON.stringify({ tag: "v1", title: "One" }) }), e);
  expect(res.status).toBe(201);
  // A person repoints the tag, then deletes it: both are put back.
  const other = await git([...dir, "commit-tree", tree, "-p", sha, "-m", "unreviewed"]);
  await push(sha, other);
  expect(await git([...dir, "rev-parse", "refs/tags/v1"])).toBe(sha);
  await push(sha, zero);
  expect(await git([...dir, "rev-parse", "refs/tags/v1"])).toBe(sha);
  expect(await env.DB.prepare("SELECT sha FROM tags WHERE repo = ? AND name = 'v1'").bind(name).first("sha")).toBe(sha);
});

// A person-driven change from head branch feat of name, verifying on feat's first commit, with real bare repos for the base
// and its fork. push() moves the base's feat onto a new commit, as git leaves a person's push, and delivers its event.
async function headBranchChange(name) {
  const fake = fakeArtifacts({ remote: (n) => `${inject("runnerRelay").url}/smart/${n}.git` });
  const e = { ...env, ARTIFACTS: fake };
  const post = async (path, body) => (await worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), e)).json();
  await post("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const dir = ["--git-dir", `${name}.git`];
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const ann = { name: "Ann", email: "ann@x.test" };
  const { sha: base, tree } = await commit(bareRepo(name), { branch: "main", base: null, message: "init", author: ann, changes: [{ path: "README", content: "hi\n" }] });
  await git([...dir, "update-ref", "refs/heads/feat", base]);
  fake.repos.get(name).commits = [{ hash: base }];
  const change = await post(`/api/repos/${name}/changes`, { intent: "feat", target_branch: "main", head_branch: "feat" });
  await git(["clone", "-q", "--bare", `${name}.git`, `${change.fork}.git`]);
  let head = base;
  const push = async (message) => {
    const who = { GIT_AUTHOR_NAME: "Ann", GIT_AUTHOR_EMAIL: "ann@x.test", GIT_COMMITTER_NAME: "Ann", GIT_COMMITTER_EMAIL: "ann@x.test" };
    const sha = await git([...dir, "commit-tree", tree, "-p", head, "-m", message], { env: who });
    await git([...dir, "update-ref", "refs/heads/feat", sha]);
    await worker.queue({ messages: [{ body: { ...pushed(name, "refs/heads/feat", sha), payload: { ref: "refs/heads/feat", before: head, after: sha, commits: [] } } }] }, e);
    head = sha;
    return sha;
  };
  const verifies = async () => (await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'verify' AND status = 'queued' AND id NOT IN (SELECT job_id FROM job_cancels)")
    .bind(change.id).all()).results.map((j) => JSON.parse(j.payload).head_sha);
  return { change, push, verifies, base };
}

it("a push to an open change's head branch moves its head and queues verify", async () => {
  const { change, push, verifies, base } = await headBranchChange("push-head-branch");
  expect(await verifies()).toEqual([base]);
  const sha = await push("second");
  expect(await git(["--git-dir", `${change.fork}.git`, "rev-parse", "refs/heads/feat"])).toBe(sha);
  expect(await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(change.id).first("head_sha")).toBe(sha);
  expect(await verifies()).toEqual([sha]);
  expect((await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).get()).state).toBe("verifying");
});

it("a push to a verifying change stages a pushed event and re-runs verify", async () => {
  const { change, push, verifies } = await headBranchChange("push-verifying-event");
  const sha = await push("second");
  const got = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)).get();
  expect(got.state).toBe("verifying");
  expect(got.events.filter((e) => e.kind === "pushed")).toMatchObject([{ action: "change.push", target: sha }]);
  expect(await verifies()).toEqual([sha]);
});

it("a second push while verify is queued leaves one verify job on the newest sha", async () => {
  const { push, verifies } = await headBranchChange("push-head-twice");
  await push("second");
  const newest = await push("third");
  expect(await verifies()).toEqual([newest]);
});

it("a push to a needs_fix change returns it to verifying", async () => {
  const { change, push, verifies } = await headBranchChange("push-needs-fix");
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
  expect(await stub.transition("needs_fix", { kind: "verify_failed", actor: { type: "system", id: "cinder" }, action: "job.report", target: change.id, result: "failed" })).toMatchObject({ state: "needs_fix" });
  const sha = await push("fix");
  expect((await stub.get()).state).toBe("verifying");
  expect(await verifies()).toEqual([sha]);
});

it("a push to refs/for/main opens a person-driven change and queues verify, not develop", async () => {
  const { e, repo } = await credentialedRepo("push-for-verify");
  await worker.queue({ messages: [{ body: pushed("push-for-verify", "refs/for/main", "4".repeat(40)) }] }, e);
  const { id } = await env.DB.prepare("SELECT id FROM changes WHERE repo_id = ?").bind(repo.id).first();
  expect(await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).toMatchObject({ state: "verifying", driver: "owner", head_branch: "refs/for/main" });
  const jobs = (await env.DB.prepare("SELECT kind, payload FROM jobs WHERE change_id = ?").bind(id).all()).results;
  expect(jobs.filter((j) => j.kind !== "guard").map((j) => [j.kind, JSON.parse(j.payload).head_sha])).toEqual([["verify", "4".repeat(40)]]);
});

it("a refs/for push opens a change titled by its head commit's subject", async () => {
  const { e, repo } = await credentialedRepo("push-for-title");
  const event = pushed("push-for-title", "refs/for/main", "6".repeat(40));
  event.payload.commits = [{ id: "6".repeat(40), message: "Fix the router\n\nIt dropped headers.\n" }];
  // No message on the event: the commit is read from the repo's log.
  e.ARTIFACTS.repos.get("push-for-title").commits.unshift({ sha: "7".repeat(40), message: "Read from the log\n" });
  await worker.queue({ messages: [{ body: event }, { body: pushed("push-for-title", "refs/for/main", "7".repeat(40)) }] }, e);
  const { results } = await env.DB.prepare("SELECT id FROM changes WHERE repo_id = ? ORDER BY created_at").bind(repo.id).all();
  const changes = await Promise.all(results.map(({ id }) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()));
  expect(changes.map((c) => [c.title, c.intent]).sort()).toEqual([["Fix the router", "Fix the router\n\nIt dropped headers."], ["Read from the log", "Read from the log"]]);
});

it("a refs/for push with no commit message keeps the pushed-sha title", async () => {
  const { e, repo } = await credentialedRepo("push-for-notitle");
  await worker.queue({ messages: [{ body: pushed("push-for-notitle", "refs/for/main", "8".repeat(40)) }] }, e);
  const { id } = await env.DB.prepare("SELECT id FROM changes WHERE repo_id = ?").bind(repo.id).first();
  // The log was asked for the commit before the change (its fork) was made with the fallback.
  const calls = e.ARTIFACTS.calls.map((c) => `${c.method} ${c.args.join(" ")}`);
  expect(calls.indexOf(`log push-for-notitle ${"8".repeat(40)}`)).toBeGreaterThan(-1);
  expect(calls.indexOf(`log push-for-notitle ${"8".repeat(40)}`)).toBeLessThan(calls.findIndex((c) => c.startsWith("fork push-for-notitle ")));
  const want = `Pushed ${"8".repeat(40)} to refs/for/main`;
  expect(await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()).toMatchObject({ title: want, intent: want });
});

it("a push to refs/for/main queues a guard job for its commit", async () => {
  const { e, repo } = await credentialedRepo("push-for-guard");
  await worker.queue({ messages: [{ body: pushed("push-for-guard", "refs/for/main", "5".repeat(40)) }] }, e);
  const { id } = await env.DB.prepare("SELECT id FROM changes WHERE repo_id = ?").bind(repo.id).first();
  const guards = (await env.DB.prepare("SELECT payload FROM jobs WHERE kind = 'guard' AND change_id = ?").bind(id).all()).results;
  expect(guards.map((j) => JSON.parse(j.payload))).toMatchObject([{ before: "", after: "5".repeat(40), target: "main" }]);
});

it("after a refs/for/main push opens its change, the ref is deleted so the next push is accepted as a new ref", async () => {
  const name = "push-for-repush";
  const relay = (n) => `${inject("runnerRelay").url}/smart/${n !== name ? `${name}-forks` : n}.git`;
  const fake = fakeArtifacts({ remote: relay });
  const e = { ...env, ARTIFACTS: fake };
  const post = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), e);
  await post("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  expect((await post(`/api/repos/${name}/git-credentials`)).status).toBe(200);
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  await git(["init", "-q", "--bare", "-b", "main", `${name}-forks.git`]);
  const ann = { name: "Ann", email: "ann@x.test" };
  const { sha: base, tree } = await commit(bareRepo(name), { branch: "main", base: null, message: "init", author: ann, changes: [{ path: "README", content: "hi\n" }] });
  const dir = ["--git-dir", `${name}.git`];
  const who = { GIT_AUTHOR_NAME: "Ann", GIT_AUTHOR_EMAIL: "ann@x.test", GIT_COMMITTER_NAME: "Ann", GIT_COMMITTER_EMAIL: "ann@x.test" };
  const push = async (message) => {
    const sha = await git([...dir, "commit-tree", tree, "-p", base, "-m", message], { env: who });
    await git([...dir, "update-ref", "refs/for/main", sha, "0".repeat(40)]);
    await worker.queue({ messages: [{ body: pushed(name, "refs/for/main", sha) }] }, e);
    return sha;
  };
  const first = await push("first");
  expect(await git([...dir, "for-each-ref", "refs/for"])).toBe("");
  expect(await git(["--git-dir", `${name}-forks.git`, "cat-file", "-t", first])).toBe("commit");
  await push("second");
  const { n } = await env.DB.prepare("SELECT COUNT(*) AS n FROM changes c JOIN repos r ON r.id = c.repo_id WHERE r.name = ?").bind(name).first();
  expect(n).toBe(2);
});

it("a person's push moves the change fork's target branch to the pushed commit", async () => {
  const name = "push-for-forkmain";
  const relay = (n) => `${inject("runnerRelay").url}/smart/${n !== name ? `${name}-forks` : n}.git`;
  const fake = fakeArtifacts({ remote: relay });
  const e = { ...env, ARTIFACTS: fake };
  const post = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), e);
  await post("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  expect((await post(`/api/repos/${name}/git-credentials`)).status).toBe(200);
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  await git(["init", "-q", "--bare", "-b", "main", `${name}-forks.git`]);
  const ann = { name: "Ann", email: "ann@x.test" };
  const { sha: base, tree } = await commit(bareRepo(name), { branch: "main", base: null, message: "init", author: ann, changes: [{ path: "README", content: "hi\n" }] });
  const dir = ["--git-dir", `${name}.git`];
  const sha = await git([...dir, "commit-tree", tree, "-p", base, "-m", "mine"],
    { env: { GIT_AUTHOR_NAME: "Ann", GIT_AUTHOR_EMAIL: "ann@x.test", GIT_COMMITTER_NAME: "Ann", GIT_COMMITTER_EMAIL: "ann@x.test" } });
  await git([...dir, "update-ref", "refs/for/main", sha]);
  await worker.queue({ messages: [{ body: pushed(name, "refs/for/main", sha) }] }, e);
  expect(await git(["--git-dir", `${name}-forks.git`, "rev-parse", "refs/heads/main"])).toBe(sha);
});

it("a push to the change branch while in_queue reverifies the new head", async () => {
  const { change, push, verifies } = await headBranchChange("push-in-queue");
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
  expect(await stub.transition("in_queue", { kind: "verify_passed", actor: { type: "system", id: "cinder" }, action: "job.report", target: change.id, result: "done" })).toMatchObject({ state: "in_queue" });
  const sha = await push("late fix");
  expect((await stub.get()).state).toBe("verifying");
  expect(await verifies()).toEqual([sha]);
});

it("a direct push to main during a claimed merge job is rolled back", async () => {
  const name = "push-during-merge";
  const bare = { get: async (n) => bareRepo(n) };
  const e = { ...env, ARTIFACTS: bare };
  expect((await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }), { ...env, ARTIFACTS: fakeArtifacts() })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: bare }; });
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const { sha: base, tree } = await commit(bareRepo(name), { branch: "main", base: null, message: "init", author: { name: "Ann", email: "ann@x.test" }, changes: [{ path: "a", content: "1\n" }] });
  const dir = ["--git-dir", `${name}.git`];
  const repoId = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");
  const changeId = crypto.randomUUID();
  const job = crypto.randomUUID();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, 'main', 'in_queue', ?)").bind(changeId, repoId, new Date().toISOString()),
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'merge', ?, 'claimed', ?, ?)")
      .bind(job, repoId, changeId, new Date().toISOString(), JSON.stringify({ batch: [{ change_id: changeId, tree: "f".repeat(40) }] })),
  ]);
  const push = async (message) => {
    const sha = await git([...dir, "commit-tree", tree, "-p", base, "-m", message]);
    await git([...dir, "update-ref", "refs/heads/main", sha]);
    await worker.queue({ messages: [{ body: { ...pushed(name, "refs/heads/main", sha), payload: { ref: "refs/heads/main", before: base, after: sha, commits: [] } } }] }, e);
    return sha;
  };
  await push("direct");
  expect(await git([...dir, "rev-parse", "refs/heads/main"])).toBe(base);
  // The merge's own commit carries the tree its batch verified: it stays.
  await env.DB.prepare("UPDATE jobs SET payload = ? WHERE id = ?").bind(JSON.stringify({ batch: [{ change_id: changeId, tree }] }), job).run();
  const merged = await push("cinder: merge");
  expect(await git([...dir, "rev-parse", "refs/heads/main"])).toBe(merged);
});

it("a change from head_branch that converges after another merge lands its own commits on main", async () => {
  const name = "push-head-converge";
  // Forks are bare clones, as Artifacts forks carry every branch.
  const bare = { get: async (n) => ({ ...bareRepo(n), fork: async (child) => { await git(["clone", "-q", "--bare", `${n}.git`, `${child}.git`]); return { name: child }; } }) };
  const e = { ...env, ARTIFACTS: bare };
  expect((await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }), { ...env, ARTIFACTS: fakeArtifacts() })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: bare }; });
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const ann = { name: "Ann", email: "ann@x.test" };
  const { sha: base } = await commit(bareRepo(name), { branch: "main", base: null, message: "init", author: ann, changes: [{ path: "a", content: "1\n" }] });
  await git(["--git-dir", `${name}.git`, "update-ref", "refs/heads/feat", base]);
  const { sha: head } = await commit(bareRepo(name), { branch: "feat", base, message: "mine", author: ann, changes: [{ path: "b", content: "2\n" }] });
  const res = await worker.fetch(new Request(`http://cinder.test/api/repos/${name}/changes`, { method: "POST", headers: OWNER, body: JSON.stringify({ intent: "feat", head_branch: "feat" }) }), e);
  expect(res.status).toBe(201);
  const change = await res.json();
  // Another change merges first; converge then rebases the fork's main onto it, so the fork's main must hold the change's commits.
  await commit(bareRepo(name), { branch: "main", base, message: "other", author: ann, changes: [{ path: "c", content: "3\n" }] });
  expect(await git(["--git-dir", `${change.fork}.git`, "rev-parse", "refs/heads/main"])).toBe(head);
});
