import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { validateChangeCheck, validateChangeCommit, validateDiffFile } from "../src/api/shapes.js";
import { newChange } from "../src/changes.js";
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

it("files: a change with no commits of its own lists no files", async () => {
  const { call, change } = await setup("files-empty-repo");
  expect(await call(`/api/changes/${change.id}/files`)).toEqual([]);
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
