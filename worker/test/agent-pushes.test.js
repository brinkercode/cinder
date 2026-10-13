import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { describe, expect, it, onTestFinished } from "vitest";
import { commit } from "../src/git/index.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const ANN = { name: "Ann", email: "ann@x.test", time: 1700000000 };

// A change the owner wrote on feature/pay (agent_pushes off), its fork a real bare repo, and a runner holding an agent's
// develop job on it (none is queued for a person's change, so the test claims one by hand).
async function setup(name) {
  const fake = fakeArtifacts();
  const call = (path, body, { method = "POST", token = env.OWNER_TOKEN } = {}) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }),
    { ...env, ARTIFACTS: fake },
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });
  Object.assign(fake.repos.get(name), { branches: ["main", "feature/pay"], commits: [{ hash: "h1", message: "pay" }] });
  const change = await (await call(`/api/repos/${name}/changes`, { intent: "Accept PayPal", head_branch: "feature/pay" })).json();
  expect(change).toMatchObject({ driver: "owner", agent_pushes: false });
  expect(await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE change_id = ? AND kind = 'develop'").bind(change.id).first("n")).toBe(0);

  await git(["init", "-q", "--bare", "-b", "feature/pay", `${change.fork}.git`]);
  const base = await commit(bareRepo(change.fork), { branch: "feature/pay", base: null, message: "base", author: ANN, changes: [{ path: "README", content: "hi\n" }] });
  const get = fake.get;
  fake.get = async (repo) => (repo === change.fork ? bareRepo(repo) : get(repo));
  const runner = await (await call("/api/runners", { name: "lab", kinds: ["develop"] })).json();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload, runner_id, lease_expires_at) VALUES (?, ?, 'develop', ?, 'claimed', ?, '{}', ?, ?)")
    .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), runner.id, new Date(Date.now() + 600_000).toISOString()).run();
  const agentCommit = () => call(`/api/repos/${change.fork}/commits`,
    { branch: "feature/pay", base_sha: base.sha, message: "agent fix", changes: [{ path: "a.js", content: "1\n" }] }, { token: runner.token });
  return { call, change, agentCommit };
}

describe("agent pushes", () => {
  it("an agent commit to a person's change without agent_pushes is refused with 403", async () => {
    const { agentCommit } = await setup("ap-refuse");
    const res = await agentCommit();
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("agent_push_refused");
  });

  it("a refused push appears in the timeline within one tick, with the agent@version", async () => {
    const { change, agentCommit } = await setup("ap-event");
    await env.DB.prepare("UPDATE jobs SET payload = '{\"agent\":\"developer@v7\"}' WHERE change_id = ?").bind(change.id).run();
    expect((await agentCommit()).status).toBe(403);
    const events = await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)), (i) => i.ctx.storage.get("events"));
    expect(events.at(-1)).toMatchObject({ kind: "agent_push_refused", agent: "developer@v7", commits: 1, result: "refused" });
  });

  it("an @agent message on that change becomes a review comment and a refused event", async () => {
    const { call, change } = await setup("ap-message");
    const res = await call(`/api/changes/${change.id}/messages`, { text: "@agent rename the helper" });
    expect(res.status).toBe(201);
    const threads = await (await call(`/api/changes/${change.id}/threads`, undefined, { method: "GET" })).json();
    expect(threads).toHaveLength(1);
    expect(threads[0].comments[0]).toMatchObject({ actor: "agent", body: expect.stringContaining("@agent rename the helper") });
    const { change: stored, events } = Object.fromEntries(await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)),
      (i) => i.ctx.storage.get(["change", "events", "messages"])));
    expect(events.at(-1)).toMatchObject({ kind: "agent_push_refused", agent: "agent" });
    expect(stored.state).toBe(change.state);
    expect(await env.DB.prepare("SELECT count(*) AS n FROM jobs WHERE change_id = ? AND kind = 'develop' AND status = 'queued'").bind(change.id).first("n")).toBe(0);
  });

  it("the driver turns agent_pushes on and the agent's next commit lands", async () => {
    const { call, change, agentCommit } = await setup("ap-allow");
    expect((await agentCommit()).status).toBe(403);
    expect((await call(`/api/changes/${change.id}`, { agent_pushes: "yes" }, { method: "PATCH" })).status).toBe(400);
    const patched = await call(`/api/changes/${change.id}`, { agent_pushes: true }, { method: "PATCH" });
    expect(patched.status).toBe(200);
    expect((await patched.json()).agent_pushes).toBe(true);
    expect((await agentCommit()).status).toBe(201);
  });
});
