import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it } from "vitest";
import worker from "../src/index.js";
import { validateReviewThread } from "../src/api/contract.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const [A, B] = ["a".repeat(40), "b".repeat(40)];
const file = (lines) => lines.join("\n");
const ORIGINAL = Array.from({ length: 20 }, (_, i) => `line ${i + 1}`);

async function setup(name) {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake };
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), e);
    return res.json();
  };
  await call("POST", "/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await call("POST", `/api/repos/${name}/changes`, { intent: "x" });
  const push = (before, after) => worker.queue({ messages: [{ body: {
    type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "cinder", repoName: change.fork },
    payload: { ref: "refs/heads/main", before, after, commits: [] },
  } }] }, e);
  const at = (sha, files) => { fake.repos.get(change.fork).at = { ...fake.repos.get(change.fork).at, [sha]: files }; };
  return { change, call, push, at, e };
}

it("a comment on line 12 stays on the same code after an unrelated hunk above moves it", async () => {
  const { change, call, push, at } = await setup("threads-move");
  at(A, { "src/a.js": file(ORIGINAL) });
  at(B, { "src/a.js": file(["// new header", "// another", ...ORIGINAL.slice(0, 3), ...ORIGINAL.slice(4)]) });
  await push("0".repeat(40), A);
  const thread = await call("POST", `/api/changes/${change.id}/threads`, { path: "src/a.js", side: "new", line: 12, body: "why?" });
  expect(thread).toMatchObject({ line: 12, head_sha: A, original_lines: ["line 12"], outdated: false });
  await push(A, B);
  const [moved] = await call("GET", `/api/changes/${change.id}/threads`);
  // Two lines added above, one removed above: line 12 is now line 13, still the same text.
  expect(moved).toMatchObject({ id: thread.id, line: 13, head_sha: B, outdated: false });
  expect(file(["// new header", "// another", ...ORIGINAL.slice(0, 3), ...ORIGINAL.slice(4)]).split("\n")[moved.line - 1]).toBe("line 12");
  expect(validateReviewThread(moved).errors).toEqual([]);
});

it("a thread whose lines changed becomes outdated", async () => {
  const { change, call, push, at } = await setup("threads-outdated");
  at(A, { "src/a.js": file(ORIGINAL) });
  at(B, { "src/a.js": file(ORIGINAL.map((l, i) => (i === 11 ? "line 12 rewritten" : l))) });
  await push("0".repeat(40), A);
  const thread = await call("POST", `/api/changes/${change.id}/threads`, { path: "src/a.js", side: "new", line: 12, body: "why?" });
  const general = await call("POST", `/api/changes/${change.id}/threads`, { body: "overall fine" });
  await push(A, B);
  const threads = await call("GET", `/api/changes/${change.id}/threads`);
  expect(threads.find((t) => t.id === thread.id)).toMatchObject({ outdated: true, line: 12, head_sha: A });
  expect(threads.find((t) => t.id === general.id)).toMatchObject({ path: null, line: null, outdated: false });
});

it("resolve and reopen record the actor", async () => {
  const { change, call } = await setup("threads-resolve");
  const thread = await call("POST", `/api/changes/${change.id}/threads`, { body: "overall fine" });
  await call("POST", `/api/changes/${change.id}/threads/${thread.id}/comments`, { body: "agreed" });
  const resolved = await call("POST", `/api/changes/${change.id}/threads/${thread.id}/resolve`);
  expect(resolved).toMatchObject({ resolved: true, state_by: "owner" });
  expect(resolved.state_at).toEqual(expect.any(String));
  expect(resolved.comments.map((c) => [c.actor, c.body])).toEqual([["owner", "overall fine"], ["owner", "agreed"]]);
  const reopened = await call("POST", `/api/changes/${change.id}/threads/${thread.id}/reopen`);
  expect(reopened).toMatchObject({ resolved: false, state_by: "owner" });
  expect(reopened.state_at >= resolved.state_at).toBe(true);
  expect(validateReviewThread(reopened).errors).toEqual([]);
});

const SUGGEST = "try this:\n```suggestion\nline twelve\nline twelve b\n```";
const apply = async (e, change, t) => worker.fetch(new Request(`http://cinder.test/api/changes/${change.id}/threads/${t}/apply`, { method: "POST", headers: OWNER }), e);

it("applying a suggestion commits exactly the anchored lines", async () => {
  const { change, call, push, at, e } = await setup("threads-apply");
  at(A, { "src/a.js": file(ORIGINAL) });
  await push("0".repeat(40), A);
  const thread = await call("POST", `/api/changes/${change.id}/threads`, { path: "src/a.js", side: "new", line: 12, body: SUGGEST });
  await call("POST", `/api/changes/${change.id}/takeover`);
  const res = await apply(e, change, thread.id);
  expect(res.status).toBe(202);
  expect(await res.json()).toMatchObject({ id: thread.id, resolved: true, state_by: "owner" });
  const job = await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'commit'").bind(change.id).first();
  expect(JSON.parse(job.payload)).toEqual({
    lease: [], path: "src/a.js", base_sha: A, thread: thread.id,
    content: file([...ORIGINAL.slice(0, 11), "line twelve", "line twelve b", ...ORIGINAL.slice(12)]),
  });
});

it("applying an outdated suggestion returns 409", async () => {
  const { change, call, push, at, e } = await setup("threads-apply-outdated");
  at(A, { "src/a.js": file(ORIGINAL) });
  at(B, { "src/a.js": file(ORIGINAL.map((l, i) => (i === 11 ? "line 12 rewritten" : l))) });
  await push("0".repeat(40), A);
  const thread = await call("POST", `/api/changes/${change.id}/threads`, { path: "src/a.js", side: "new", line: 12, body: SUGGEST });
  await push(A, B);
  await call("POST", `/api/changes/${change.id}/takeover`);
  const res = await apply(e, change, thread.id);
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe("outdated");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE change_id = ? AND kind = 'commit'").bind(change.id).first("n")).toBe(0);
});

it("applying while the agent drives returns 409", async () => {
  const { change, call, push, at, e } = await setup("threads-apply-agent");
  at(A, { "src/a.js": file(ORIGINAL) });
  await push("0".repeat(40), A);
  const thread = await call("POST", `/api/changes/${change.id}/threads`, { path: "src/a.js", side: "new", line: 12, body: SUGGEST });
  const res = await apply(e, change, thread.id);
  expect(res.status).toBe(409);
  expect((await res.json()).error.code).toBe("not_driving");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE change_id = ? AND kind = 'commit'").bind(change.id).first("n")).toBe(0);
});

it("apply suggestion: one commit job on the head, the thread names the commit it landed as, and the verifier re-runs", async () => {
  const { change, call, push, at, e } = await setup("threads-apply-commit");
  at(A, { "src/a.js": file(ORIGINAL) });
  at(B, { "src/a.js": file([...ORIGINAL.slice(0, 11), "line twelve", "line twelve b", ...ORIGINAL.slice(12)]) });
  await push("0".repeat(40), A);
  const thread = await call("POST", `/api/changes/${change.id}/threads`, { path: "src/a.js", side: "new", line: 12, body: SUGGEST });
  expect(thread.suggestion).toEqual({ from: "line 12", to: "line twelve\nline twelve b" });
  await call("POST", `/api/changes/${change.id}/takeover`);
  await apply(e, change, thread.id);
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE change_id = ? AND kind = 'commit'").bind(change.id).first("n")).toBe(1);
  const { token } = await call("POST", "/api/runners", { name: "applier", kinds: ["commit"] });
  const runner = async (path, body) => (await worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), e)).json();
  // Earlier tests left their commit jobs queued on repos this fake doesn't have.
  await env.DB.prepare("DELETE FROM jobs WHERE kind = 'commit' AND change_id != ?").bind(change.id).run();
  const claim = await runner("/api/work/claim", { kinds: ["commit"], slots_free: 1 });
  await push(A, B);
  expect((await call("GET", `/api/changes/${change.id}/threads`))[0]).toMatchObject({ resolved: true, applied_sha: B });
  await runner(`/api/work/jobs/${claim.job.id}/report`, { status: "done" });
  expect((await call("GET", `/api/changes/${change.id}`)).state).toBe("verifying");
  expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM jobs WHERE change_id = ? AND kind = 'verify'").bind(change.id).first("n")).toBe(1);
});
