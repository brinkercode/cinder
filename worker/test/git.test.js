import { env } from "cloudflare:workers";
import { expect, it, vi } from "vitest";
import { commit, commitObject, copyRef, moveRef, gitObject, packfile, tagObject, treeObject } from "../src/git/index.js";
import { ensureAgentsRepo } from "../src/agents.js";
import worker from "../src/index.js";
import { parsePolicy } from "../src/policy.js";
import { BAKED_IN, agentsFake } from "./fakes/agents-repo.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const text = (s) => new TextEncoder().encode(s);
const ANN = { name: "Ann", email: "ann@x.test", time: 1700000000 };
const ANN_ENV = { GIT_AUTHOR_NAME: "Ann", GIT_AUTHOR_EMAIL: "ann@x.test", GIT_AUTHOR_DATE: "1700000000 +0000",
  GIT_COMMITTER_NAME: "Ann", GIT_COMMITTER_EMAIL: "ann@x.test", GIT_COMMITTER_DATE: "1700000000 +0000" };

it("object hashes match git hash-object and git mktree for known fixtures (blob, nested tree with modes, commit, tag)", async () => {
  await git(["init", "-q", "--bare", "fixtures.git"]);
  const g = (args, opts) => git(["--git-dir", "fixtures.git", ...args], opts);
  const blob = await gitObject("blob", "hello\n");
  expect(blob.sha).toBe(await g(["hash-object", "-w", "--stdin"], { input: text("hello\n") }));
  const dir = await treeObject([{ name: "b.txt", mode: "100644", sha: blob.sha }]);
  expect(dir.sha).toBe(await g(["mktree"], { input: text(`100644 blob ${blob.sha}\tb.txt\n`) }));
  // "dir.txt" sorts before the tree "dir" in git's order ("dir/"), the opposite of plain name order.
  const root = await treeObject([{ name: "run.sh", mode: "100755", sha: blob.sha }, { name: "dir", mode: "40000", sha: dir.sha },
    { name: "dir.txt", mode: "100644", sha: blob.sha }, { name: "a.txt", mode: "100644", sha: blob.sha }]);
  expect(root.sha).toBe(await g(["mktree"], { input: text(`100755 blob ${blob.sha}\trun.sh\n040000 tree ${dir.sha}\tdir\n100644 blob ${blob.sha}\tdir.txt\n100644 blob ${blob.sha}\ta.txt\n`) }));
  const c = await commitObject({ tree: root.sha, author: ANN, message: "first" });
  expect(c.sha).toBe(await g(["commit-tree", root.sha, "-m", "first"], { env: ANN_ENV }));
  const tag = await tagObject({ object: c.sha, tag: "v1", tagger: ANN, message: "v1" });
  await g(["tag", "-a", "v1", "-m", "v1", c.sha], { env: ANN_ENV });
  expect(tag.sha).toBe(await g(["rev-parse", "v1"]));
});

it("a packfile the module writes passes git index-pack --verify", async () => {
  await git(["init", "-q", "--bare", "pack.git"]);
  // A blob over 2 KiB takes a multi-byte object header.
  const big = await gitObject("blob", "x".repeat(5000));
  const small = await gitObject("blob", "hello\n");
  const tree = await treeObject([{ name: "big", mode: "100644", sha: big.sha }, { name: "small", mode: "100755", sha: small.sha }]);
  const c = await commitObject({ tree: tree.sha, author: ANN, message: "packed" });
  const pack = await packfile([big, small, tree, c]);
  const name = (await git(["--git-dir", "pack.git", "index-pack", "--stdin"], { input: pack })).split("\t")[1];
  await git(["index-pack", "--verify", `pack.git/objects/pack/pack-${name}.pack`]);
  expect(await git(["--git-dir", "pack.git", "cat-file", "-p", `${c.sha}:big`])).toBe("x".repeat(5000));
});

it("commit() pushes over smart HTTP: git log shows the author, tree and parent; a stale base is refused", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "pushed.git"]);
  const repo = bareRepo("pushed");
  const first = await commit(repo, { branch: "main", base: null, message: "first", author: ANN,
    changes: [{ path: "a.txt", content: "one\n" }, { path: "bin/run.sh", content: "echo\n", mode: "100755" }] });
  const bob = { name: "Bob", email: "bob@x.test" };
  const second = await commit(repo, { branch: "main", base: first.sha, message: "second", author: bob, tag: "v1", changes: [{ path: "a.txt", content: "two\n" }] });
  expect(await git(["--git-dir", "pushed.git", "log", "-1", "--format=%an <%ae>|%T|%P|%s", "main"])).toBe(`Bob <bob@x.test>|${second.tree}|${first.sha}|second`);
  expect(await git(["--git-dir", "pushed.git", "ls-tree", "-r", "main"])).toBe(
    `100644 blob ${(await gitObject("blob", "two\n")).sha}\ta.txt\n100755 blob ${(await gitObject("blob", "echo\n")).sha}\tbin/run.sh`);
  expect(await git(["--git-dir", "pushed.git", "rev-parse", "v1^{commit}"])).toBe(second.sha);
  await expect(commit(repo, { branch: "main", base: first.sha, message: "stale", author: bob, changes: [{ path: "a.txt", content: "three\n" }] }))
    .rejects.toMatchObject({ code: "conflict" });
  expect(await git(["--git-dir", "pushed.git", "rev-parse", "main"])).toBe(second.sha);
});

it("POST /commits with a delete and a modify produces the expected tree; a path with .. is rejected", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "api.git"]);
  const repo = bareRepo("api");
  const base = await commit(repo, { branch: "main", base: null, message: "base", author: ANN,
    changes: [{ path: "keep.txt", content: "keep\n" }, { path: "src/old.js", content: "old\n" }, { path: "src/edit.js", content: "v1\n" }] });
  const post = (body) => worker.fetch(new Request("http://cinder.test/api/repos/api/commits", { method: "POST",
    headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify(body) }), { ...env, ARTIFACTS: { get: async (name) => bareRepo(name) } });

  const bad = await post({ branch: "main", base_sha: base.sha, message: "escape", changes: [{ path: "src/../../etc/passwd", content: "x" }] });
  expect(bad.status).toBe(400);
  const res = await post({ branch: "main", base_sha: base.sha, message: "edit", changes: [{ path: "src/old.js", delete: true }, { path: "src/edit.js", content: "v2\n" }] });
  expect(res.status).toBe(201);
  const { sha } = await res.json();
  expect(await git(["--git-dir", "api.git", "rev-parse", "main"])).toBe(sha);
  expect(await git(["--git-dir", "api.git", "ls-tree", "-r", "--format=%(path) %(objectname)", "main"])).toBe(
    `keep.txt ${(await gitObject("blob", "keep\n")).sha}\nsrc/edit.js ${(await gitObject("blob", "v2\n")).sha}`);
});

it("after POST /api/repos/:name/commits adds a file, code-search finds a word from it", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "srch.git"]);
  await commit(bareRepo("srch"), { branch: "main", base: null, message: "base", author: ANN, changes: [{ path: "README", content: "hi\n" }] });
  await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('id-srch', 'srch', 'main', 'trunk', '{}', ?)")
    .bind(new Date().toISOString()).run();
  const call = (path, init) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, ...init }),
    { ...env, ARTIFACTS: { get: async (name) => bareRepo(name) } });
  const res = await call("/api/repos/srch/commits", { method: "POST",
    body: JSON.stringify({ branch: "feat", base_sha: null, message: "add", changes: [{ path: "src/discount.js", content: "const discount = 1;\n" }] }) });
  expect(res.status).toBe(201);
  // Indexed by the commit itself, before any search.
  expect(await env.DB.prepare("SELECT path FROM code_search WHERE store = 'srch' AND sha = ?").bind((await res.json()).sha).all()).toMatchObject({ results: [{ path: "src/discount.js" }] });
  expect(await (await call("/api/repos/srch/code-search?ref=feat&q=discount")).json()).toEqual([{ path: "src/discount.js", line: 1, text: "const discount = 1;" }]);
});

it("PUT policy returns 201 with a sha and the repo's .cinder.yml at that sha holds the policy", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "pol.git"]);
  const base = await commit(bareRepo("pol"), { branch: "main", base: null, message: "base", author: ANN, changes: [{ path: "README", content: "hi\n" }] });
  await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('id-pol', 'pol', 'main', 'trunk', '{}', ?)")
    .bind(new Date().toISOString()).run();
  const policy = { integration: ["develop", "main"], release: ["release/*"], check: "npm test" };
  const put = () => worker.fetch(new Request("http://cinder.test/api/repos/pol/policy", { method: "PUT", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
    body: JSON.stringify(policy) }), { ...env, ARTIFACTS: { get: async (name) => ({ ...bareRepo(name), log: async () => [{ hash: base.sha }] }) } });
  const res = await put();
  expect(res.status).toBe(201);
  const { sha } = await res.json();
  expect(await git(["--git-dir", "pol.git", "rev-parse", "main"])).toBe(sha);
  expect(parsePolicy(await git(["--git-dir", "pol.git", "show", `${sha}:.cinder.yml`]), "main")).toMatchObject({ ...policy, defaulted: false });
  expect(await git(["--git-dir", "pol.git", "log", "-1", "--format=%an|%P", sha])).toBe(`owner|${base.sha}`);
  expect((await put()).status).toBe(409);
});

it("a fresh deploy's first claim finds cinder-agents with default agent versions recorded", async () => {
  const fake = await agentsFake("cinder-agents");
  const call = (path, body, token = env.OWNER_TOKEN) => worker.fetch(new Request(`http://cinder.test${path}`,
    { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: JSON.stringify(body) }), { ...env, ARTIFACTS: fake });
  expect(await env.DB.prepare("SELECT 1 FROM agent_versions").first()).toBeNull();
  const { token } = await (await call("/api/runners", { name: "fresh", kinds: ["develop"] })).json();
  await call("/api/work/claim", { kinds: ["develop"] }, token);
  expect(fake.repos.has("cinder-agents")).toBe(true);
  expect(await git(["--git-dir", "cinder-agents.git", "show", "agent/developer/v1:agents/developer/prompt.md"])).toMatch(/cinder's developer/);
  expect(await env.DB.prepare("SELECT name, version FROM agent_versions ORDER BY name").all()).toMatchObject({ results: BAKED_IN.map((name) => ({ name, version: 1 })) });
  expect(await env.DB.prepare("SELECT version FROM channels WHERE agent_name = 'developer' AND channel = 'stable'").first("version")).toBe(1);
});

it("with a fake whose get() rejects \"Repository not found\", ensureAgentsRepo creates the repo and records 5 agent versions", async () => {
  await env.DB.batch(["agent_releases", "channels", "agent_versions"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));
  const fake = await agentsFake("agents-not-found");
  await expect(fake.get("cinder-agents")).rejects.toThrow("Repository not found: cinder-agents.");
  await ensureAgentsRepo({ ...env, ARTIFACTS: fake });
  expect(fake.repos.has("cinder-agents")).toBe(true);
  expect(await env.DB.prepare("SELECT name, version FROM agent_versions ORDER BY name").all()).toMatchObject({ results: BAKED_IN.map((name) => ({ name, version: 1 })) });
});

const clearAgents = () => env.DB.batch(["agent_releases", "channels", "agent_versions", "agents_bootstrap"].map((t) => env.DB.prepare(`DELETE FROM ${t}`)));

it("create returns but get answers \"being created\" twice, then ready; bootstrap waits and commits the 3 agents once", async () => {
  await clearAgents();
  const fake = await agentsFake("agents-creating");
  fake.creating = 2;
  await ensureAgentsRepo({ ...env, ARTIFACTS: fake });
  expect(fake.calls.filter((c) => c.method === "create")).toHaveLength(1);
  expect(await git(["--git-dir", "agents-creating.git", "rev-list", "--count", "main"])).toBe(String(BAKED_IN.length));
  expect(await env.DB.prepare("SELECT name, version FROM agent_versions ORDER BY name").all()).toMatchObject({ results: BAKED_IN.map((name) => ({ name, version: 1 })) });
});

it("a repo stuck in creating past the threshold is deleted and recreated", async () => {
  await clearAgents();
  const fake = await agentsFake("agents-stuck");
  fake.creating = Infinity;
  await fake.create("cinder-agents");
  fake.creating = 0;
  const e = { ...env, ARTIFACTS: fake };
  // First seen creating: not yet past the threshold, so nothing is deleted.
  await ensureAgentsRepo(e);
  expect(fake.calls.filter((c) => c.method === "delete")).toHaveLength(0);
  await env.DB.prepare("UPDATE agents_bootstrap SET created_at = ?").bind(Date.now() - 11 * 60_000).run();
  const warn = vi.spyOn(console, "warn");
  await ensureAgentsRepo(e);
  expect(fake.calls.filter((c) => ["delete", "create"].includes(c.method)).map((c) => c.method)).toEqual(["create", "delete", "create"]);
  expect(warn).toHaveBeenCalledWith(expect.stringMatching(/cinder-agents stuck creating since .*deleting and recreating/));
  warn.mockRestore();
  expect(await env.DB.prepare("SELECT count(*) AS n FROM agent_versions").first("n")).toBe(BAKED_IN.length);
});

const advertisementFetches = () => vi.spyOn(globalThis, "fetch");
const advertised = (spy) => spy.mock.calls.filter(([url]) => String(url?.url ?? url).includes("/info/refs"));

it("a commit pushes without fetching the ref advertisement", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "noadv.git"]);
  const spy = advertisementFetches();
  const res = await commit(bareRepo("noadv"), { branch: "main", base: null, message: "m", author: ANN, changes: [{ path: "a.txt", content: "a\n" }] });
  expect(await git(["--git-dir", "noadv.git", "rev-parse", "main"])).toBe(res.sha);
  expect(advertised(spy)).toEqual([]);
  spy.mockRestore();
});

it("a commit whose base moved answers conflict from the push's refusal", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "moved.git"]);
  const repo = bareRepo("moved");
  const first = await commit(repo, { branch: "main", base: null, message: "one", author: ANN, changes: [{ path: "a.txt", content: "1\n" }] });
  await commit(repo, { branch: "main", base: first.sha, message: "two", author: ANN, changes: [{ path: "a.txt", content: "2\n" }] });
  await expect(commit(repo, { branch: "main", base: first.sha, message: "stale", author: ANN, changes: [{ path: "a.txt", content: "3\n" }] }))
    .rejects.toMatchObject({ code: "conflict", message: expect.stringContaining("ng refs/heads/main") });
});

it("a commit touching two directories reads their trees concurrently", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "conc.git"]);
  const repo = bareRepo("conc");
  const base = await commit(repo, { branch: "main", base: null, message: "base", author: ANN,
    changes: [{ path: "src/a.js", content: "a\n" }, { path: "lib/b.js", content: "b\n" }] });
  let live = 0;
  let peak = 0;
  const readTree = repo.readTree;
  repo.readTree = async (sha) => {
    peak = Math.max(peak, ++live);
    try { return await readTree(sha); } finally { live--; }
  };
  await commit(repo, { branch: "main", base: base.sha, message: "two dirs", author: ANN,
    changes: [{ path: "src/a.js", content: "a2\n" }, { path: "lib/b.js", content: "b2\n" }] });
  expect(peak).toBe(2);
});

it("a push whose first response is lost and whose branch already moved to our sha succeeds", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "lost.git"]);
  const repo = bareRepo("lost");
  const base = await commit(repo, { branch: "main", base: null, message: "base", author: ANN, changes: [{ path: "a", content: "1\n" }] });
  const real = globalThis.fetch;
  let lost = false;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    const res = await real(url, init);
    if (!lost && String(url).endsWith("/git-receive-pack")) {
      lost = true;
      throw new TypeError("connection lost");
    }
    return res;
  });
  try {
    const moved = await commit(repo, { branch: "main", base: base.sha, message: "two", author: ANN, changes: [{ path: "a", content: "2\n" }] });
    expect(lost).toBe(true);
    expect(await git(["--git-dir", "lost.git", "rev-parse", "main"])).toBe(moved.sha);
  } finally { spy.mockRestore(); }
});

it("a push answered with a refusal is not retried", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "refused.git"]);
  const repo = bareRepo("refused");
  const base = await commit(repo, { branch: "main", base: null, message: "base", author: ANN, changes: [{ path: "a", content: "1\n" }] });
  const real = globalThis.fetch;
  let pushes = 0;
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation((url, init) => {
    if (String(url).endsWith("/git-receive-pack")) pushes++;
    return real(url, init);
  });
  try {
    // "from" is not where main is, so the remote refuses the update.
    await expect(moveRef(repo, "refs/heads/main", "1".repeat(40), base.sha)).rejects.toMatchObject({ code: "conflict" });
    expect(pushes).toBe(1);
  } finally { spy.mockRestore(); }
});

it("copyRef drops the flush-pkt Artifacts sends after the pack", async () => {
  await git(["init", "-q", "--bare", "-b", "main", "cp-flush-src.git"]);
  await git(["init", "-q", "--bare", "-b", "main", "cp-flush-dst.git"]);
  const { sha } = await commit(bareRepo("cp-flush-src"), { branch: "main", base: null, message: "init", author: ANN, changes: [{ path: "README", content: "hi\n" }] });
  const real = globalThis.fetch;
  let pack = null;
  let sent = null;
  // Artifacts' upload-pack answer ends with "0000" after the pack (git http-backend's doesn't); receive-pack there 500s on it.
  const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (url, init) => {
    if (String(url).endsWith("/cp-flush-dst.git/git-receive-pack")) {
      sent = new Uint8Array(await new Response(init.body).arrayBuffer());
      return real(url, { ...init, body: sent, duplex: undefined });
    }
    const res = await real(url, init);
    if (!String(url).endsWith("/cp-flush-src.git/git-upload-pack")) return res;
    const body = new Uint8Array(await res.arrayBuffer());
    pack = body.subarray(8);
    return new Response(new Uint8Array([...body, ...text("0000")]), { status: res.status, headers: res.headers });
  });
  try {
    await copyRef(bareRepo("cp-flush-src"), bareRepo("cp-flush-dst"), "refs/for/main", sha, ["refs/heads/main"]);
  } finally {
    spy.mockRestore();
  }
  expect([...sent.subarray(sent.length - pack.length)]).toEqual([...pack]);
  expect(await git(["--git-dir", "cp-flush-dst.git", "rev-parse", "refs/for/main", "refs/heads/main"])).toBe(`${sha}\n${sha}`);
});
