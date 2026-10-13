import { env, runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import { validateChangeCheck, validateChangeCommit, validateDiffFile } from "../src/api/shapes.js";
import { diffSummary, newChange } from "../src/changes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

async function setup(name) {
  const fake = fakeArtifacts();
  const call = async (path, body) => (await worker.fetch(new Request(`http://cinder.test${path}`,
    { method: body ? "POST" : "GET", headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake })).json();
  await call("/api/repos", { name });
  fake.repos.get(name).commits.push({ hash: "base1", message: "base" });
  const repoId = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");
  const change = await newChange({ ...env, ARTIFACTS: fake }, name, repoId, "x", "main", []);
  return { fake, call, change };
}

it("commits lists the fork commits newest first, with trailers parsed", async () => {
  const { fake, call, change } = await setup("commits-repo");
  const author = { name: "patch", email: "patch@cinder" };
  fake.repos.get(change.fork).commits.unshift(
    { hash: "c2", author, message: "fix: second\n\nbody text\n\nCinder-Change: c-7\nCinder-Agent: patch@v3" },
    { hash: "c1", author, message: "feat: first" },
  );
  const got = await call(`/api/changes/${change.id}/commits`);
  expect(got).toEqual([
    { sha: "c2", author, message: "fix: second\n\nbody text\n\nCinder-Change: c-7\nCinder-Agent: patch@v3",
      trailers: [{ key: "Cinder-Change", value: "c-7" }, { key: "Cinder-Agent", value: "patch@v3" }] },
    { sha: "c1", author, message: "feat: first", trailers: [] },
  ]);
  for (const c of got) expect(validateChangeCommit(c).errors).toEqual([]);
});

it("files: a change with no head branch and one commit touching 3 files reports 3 files with their +/- counts", async () => {
  const { fake, call, change } = await setup("files-repo");
  const fork = fake.repos.get(change.fork);
  Object.assign(fork.files, { "a.md": "one\ntwo", "b.md": "keep\nnew", "c.md": "" });
  fork.commits.unshift({ hash: "c1", message: "Submit" });
  fork.at = { base1: { "b.md": "keep\nold", "c.md": "gone" }, c1: fork.files };
  expect(change.head_branch).toBeUndefined();
  const got = await call(`/api/changes/${change.id}/files`);
  const count = (f, k) => f.lines.filter((l) => l[0] === k).length;
  expect(got.map((f) => [f.path, f.status, count(f, "+"), count(f, "-")])).toEqual([["a.md", "added", 2, 0], ["b.md", "modified", 1, 1], ["c.md", "modified", 0, 1]]);
  for (const f of got) expect(validateDiffFile(f).errors).toEqual([]);
});

it("a change pushed to refs/for/<target> lists its files and commits from the fork's target branch", async () => {
  const { fake, call, change } = await setup("pushed-for-repo");
  const fork = fake.repos.get(change.fork);
  Object.assign(fork.files, { "a.md": "new" });
  fork.commits.unshift({ hash: "p1", message: "Say what a failed check records" });
  fork.at = { base1: { "a.md": "old" }, p1: fork.files };
  await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)), async (i) => {
    await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), head_branch: "refs/for/main", driver: "ana@example.com" });
  });
  expect((await call(`/api/changes/${change.id}/files`)).map((f) => [f.path, f.status])).toEqual([["a.md", "modified"]]);
  expect((await call(`/api/changes/${change.id}/commits`)).map((c) => c.sha)).toEqual(["p1"]);
});

it("an empty diff summary isn't cached, so a head is recounted once its fork can be read", async () => {
  const { fake, change } = await setup("empty-diff-repo");
  const e = { ...env, ARTIFACTS: fake };
  expect(await diffSummary(e, "empty-diff-repo", change, "h-empty", null)).toMatchObject({ files_changed: 0 });
  expect(await env.DB.prepare("SELECT 1 FROM head_diffs WHERE head_sha = 'h-empty'").first()).toBeNull();
});

it("files: a change with no commits of its own lists no files", async () => {
  const { call, change } = await setup("files-empty-repo");
  expect(await call(`/api/changes/${change.id}/files`)).toEqual([]);
});

// The change's head c1 merged onto main as m1; the fork is deleted, as the merge transition does.
async function mergeAndDeleteFork(fake, name, change) {
  const repo = fake.repos.get(name);
  const author = { name: "patch", email: "patch@cinder" };
  repo.refs = { "change-head": [{ hash: "c1", author, message: "feat: first" }, { hash: "base1", message: "base" }] };
  repo.commits.unshift({ hash: "m1", message: `merge\n\nCinder-Change: ${change.id}` });
  repo.at = { base1: { "a.md": "old" }, c1: { "a.md": "new", "b.md": "added" } };
  fake.repos.delete(change.fork);
  await runInDurableObject(env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id)), async (i) => {
    await i.ctx.storage.put("change", { ...(await i.ctx.storage.get("change")), state: "merged", head: "c1" });
  });
}

it("a merged change lists its files from the merge commit after its fork is deleted", async () => {
  const { fake, call, change } = await setup("merged-files-repo");
  await mergeAndDeleteFork(fake, "merged-files-repo", change);
  const got = await call(`/api/changes/${change.id}/files`);
  expect(got.map((f) => [f.path, f.status])).toEqual([["a.md", "modified"], ["b.md", "added"]]);
});

it("a merged change lists its commits after its fork is deleted", async () => {
  const { fake, call, change } = await setup("merged-commits-repo");
  await mergeAndDeleteFork(fake, "merged-commits-repo", change);
  const got = await call(`/api/changes/${change.id}/commits`);
  expect(got.map((c) => [c.sha, c.message])).toEqual([["c1", "feat: first"]]);
});

it("checks merges verify and guard results for the head sha", async () => {
  const { call, change } = await setup("checks-repo");
  const head = "h".repeat(40);
  await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, ?)").bind(change.id, head).run();
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(change.id));
  await stub.report({ change_id: change.id, stage: "verify", agent_version: "cinder-verify@v1", harness: "claude-code", model: "m", cost_usd: 0,
    duration_ms: 4200, session: "s", verdict: "fail", dirty: false, started_at: "2026-10-05T00:01:00Z" });
  await stub.setGuard({ status: "quarantined", reason: "deterministic: secret", at: "2026-10-05T00:02:00Z", deps: [] });
  const got = await call(`/api/changes/${change.id}/checks`);
  expect(got).toEqual([
    { kind: "verify", name: "cinder-verify@v1", status: "fail", sha: head, duration_ms: 4200, log_url: null },
    { kind: "guard", name: "guard", status: "fail", sha: head, duration_ms: null, log_url: null },
  ]);
  for (const c of got) expect(validateChangeCheck(c).errors).toEqual([]);
});
