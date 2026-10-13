import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, onTestFinished } from "vitest";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const SHA = "d".repeat(40);

// A repo with a change by `author`, developed by dev@v1, leasing `symbols`; mergeChange takes it through a merge job report.
async function repoWithChange(name, author, symbols) {
  const fake = fakeArtifacts();
  env.ARTIFACTS = fake;
  onTestFinished(() => { delete env.ARTIFACTS; });
  const e = { ...env, ARTIFACTS: fake };
  const call = (path, body, method = "POST", token = env.OWNER_TOKEN) => worker.fetch(
    new Request(`http://cinder.test${path}`, { method, headers: { Authorization: `Bearer ${token}` }, body: body && JSON.stringify(body) }), e,
  );
  expect((await call("/api/repos", { name })).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = async (who, leased) => {
    const { id, repo_id, target_branch, fork } = await (await call(`/api/repos/${name}/changes`, { intent: "add retries", author: who })).json();
    await env.REPO_DO.get(env.REPO_DO.idFromName(name)).grant(target_branch, id, leased);
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).report({
      change_id: id, stage: "develop", agent_version: "dev@v1", harness: "claude-code", model: "m", cost_usd: 0,
      duration_ms: 1, session: "s", verdict: "pass", dirty: false, started_at: "2026-10-05T00:00:00Z",
    });
    return { id, repo_id, target_branch, fork };
  };
  const merge = async ({ id, repo_id, fork }) => {
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    await stub.stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: id, result: "ok" }, { head: "h1" });
    for (const s of ["leased", "developing", "verifying", "in_queue"]) await stub.transition(s, { kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: id, result: "ok" });
    fake.repos.get(fork).commits.push(...fake.repos.get(name).commits);
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE status IN ('queued', 'claimed')").run();
    await env.DB.prepare("INSERT INTO queue_entries (change_id, repo_id, target_branch, enqueued_at) VALUES (?, ?, 'main', ?)").bind(id, repo_id, new Date().toISOString()).run();
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'merge', ?, 'queued', ?, '{}')")
      .bind(crypto.randomUUID(), repo_id, id, new Date().toISOString()).run();
    const runner = (await (await call("/api/runners", { name: "lab", kinds: ["merge"] })).json()).token;
    const claim = await (await call("/api/work/claim", { kinds: ["merge"] }, "POST", runner)).json();
    expect(claim.change.id).toBe(id);
    const r = await call(`/api/work/jobs/${claim.job.id}/report`, { status: "done", merged_sha: SHA }, "POST", runner);
    expect((await r.json()).change.state).toBe("merged");
  };
  return { call, first: await change(author, symbols), change, merge };
}

it("a merge writes a merges row with its files", async () => {
  const { first, merge } = await repoWithChange("merges-row", "ana@example.com", ["src/a.js#fetch", "src/a.js#retry", "src/b.js#x"]);
  await merge(first);
  const { results } = await env.DB.prepare("SELECT change_id, sha, target_branch, paths FROM merges WHERE repo_id = ?").bind(first.repo_id).all();
  expect(results).toEqual([{ change_id: first.id, sha: SHA, target_branch: "main", paths: JSON.stringify(["src/a.js", "src/b.js"]) }]);
});

it("after a merge the author is the suggested reviewer for the touched path", async () => {
  const { first, change, merge, call } = await repoWithChange("merges-owner", "ana@example.com", ["src/a.js#fetch"]);
  await merge(first);
  const next = await change("bo@example.com", ["src/a.js#retry"]);
  const res = await call(`/api/changes/${next.id}/reviewers/suggested`, undefined, "GET");
  expect(res.status).toBe(200);
  // dev@v1 developed both changes, so it is an author of the new one and not suggested.
  expect(await res.json()).toEqual([{ owner: "ana@example.com", weight: 1, owns: 1, touched: 2 }]);
});

it("an older owner's weight decays by half after 90 days", async () => {
  const { first, merge } = await repoWithChange("merges-decay", "ana@example.com", ["src/a.js#fetch"]);
  const old = new Date(Date.now() - 90 * 864e5).toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO owners (repo, path, owner, weight) VALUES (?1, 'src/a.js', 'cy', 4), (?1, 'src/a.js', 'ana@example.com', 2)").bind(first.repo_id),
    env.DB.prepare("INSERT INTO owner_decays (repo, path, decayed_at) VALUES (?, 'src/a.js', ?)").bind(first.repo_id, old),
  ]);
  await merge(first);
  const { results } = await env.DB.prepare("SELECT owner, round(weight, 3) AS weight FROM owners WHERE repo = ? ORDER BY owner").bind(first.repo_id).all();
  expect(results).toEqual([{ owner: "ana@example.com", weight: 2 }, { owner: "cy", weight: 2 }, { owner: "dev@v1", weight: 1 }]);
});

it("owners come from changed files not lease paths", async () => {
  // The lease predicted src/b.js, but the verified diff only wrote src/a.js.
  const { first, merge } = await repoWithChange("merges-written", "ana@example.com", ["src/a.js#fetch", "src/b.js#x"]);
  await env.DB.prepare("INSERT INTO change_writes VALUES (?, 'src/a.js#fetch', 'body')").bind(first.id).run();
  await merge(first);
  const { results } = await env.DB.prepare("SELECT DISTINCT path FROM owners WHERE repo = ?").bind(first.repo_id).all();
  expect(results).toEqual([{ path: "src/a.js" }]);
  expect(await env.DB.prepare("SELECT paths FROM merges WHERE change_id = ?").bind(first.id).first("paths")).toBe(JSON.stringify(["src/a.js"]));
});
