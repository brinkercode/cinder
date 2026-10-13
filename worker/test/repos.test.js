import { env } from "cloudflare:workers";
import { describe, expect, it, vi } from "vitest";
import { validateFlake, validateRepo } from "../src/api/contract.js";
import worker from "../src/index.js";
import { parsePolicy } from "../src/policy.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

function setup() {
  const fake = fakeArtifacts();
  const call = (path, body) => worker.fetch(
    new Request(`http://cinder.test${path}`, body ? { method: "POST", headers: OWNER, body: JSON.stringify(body) } : { headers: OWNER }),
    { ...env, ARTIFACTS: fake },
  );
  return { fake, call };
}

describe("repos api", () => {
  it("create then get returns default branch", async () => {
    const { fake, call } = setup();
    expect((await call("/api/repos", { name: "app-1" })).status).toBe(201);
    expect(fake.calls).toEqual([{ method: "create", args: ["app-1", undefined] }]);
    const res = await call("/api/repos/app-1");
    expect(res.status).toBe(200);
    const repo = await res.json();
    expect(validateRepo(repo)).toEqual({ ok: true, errors: [] });
    expect(repo).toMatchObject({ name: "app-1", default_branch: "main" });
    expect((await (await call("/api/repos")).json()).map((r) => r.name)).toContain("app-1");
    expect((await call("/api/repos", { name: "app-1" })).status).toBe(409);
  });

  it("a name an earlier install's Artifacts repo still holds answers 409 artifacts_repo_exists, not a Worker exception", async () => {
    const { fake, call } = setup();
    fake.create = async (name) => { throw new Error(`repo already exists: ${name}`); };
    const res = await call("/api/repos", { name: "leftover" });
    expect(res.status).toBe(409);
    expect((await res.json()).error).toMatchObject({ code: "artifacts_repo_exists", message: expect.stringContaining("leftover") });
    expect((await call("/api/repos/leftover")).status).toBe(404);
  });

  it("creating a repo from the panel stores its default branch and strategy", async () => {
    const { call } = setup();
    const res = await call("/api/repos", { name: "panel-new", default_branch: "develop", strategy: "custom" });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ default_branch: "develop", strategy: "custom", branch_policy: { integration: ["develop"] } });
    expect((await call("/api/repos", { name: "panel-bad", strategy: "yolo" })).status).toBe(400);
  });

  it("a new gitflow repo starts with develop and main as integration branches", async () => {
    const binding = { create: async (name) => {
      await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
      return { name, remote: (await bareRepo(name).info()).remote, token: "art_v2_secret?expires=1" };
    } };
    const res = await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "new-gitflow", strategy: "gitflow" }) }), { ...env, ARTIFACTS: binding });
    expect(res.status).toBe(201);
    expect(await res.json()).toMatchObject({ strategy: "gitflow", branch_policy: { integration: ["develop", "main"], release: [] } });
    expect(parsePolicy(await git(["--git-dir", "new-gitflow.git", "show", "main:.cinder.yml"]), "main")).toMatchObject({ integration: ["develop", "main"], release: [] });
  });

  it("importing a repo from the panel adds it with status importing, then ready", async () => {
    const { fake, call } = setup();
    const res = await call("/api/repos", { name: "panel-imp", import: { url: "https://git.example.com/acme/p.git" } });
    expect(res.status).toBe(201);
    const status = async () => (await (await call("/api/repos")).json()).find((r) => r.name === "panel-imp").status;
    expect(await status()).toBe("importing");
    fake.repos.get("panel-imp").commits.push({ hash: "c0ffee", message: "imported" });
    expect(await status()).toBe("ready");
  });

  it("after a commit that changes .cinder.yml integration to [develop, main], GET /api/repos returns that list", async () => {
    const { fake, call } = setup();
    await call("/api/repos", { name: "pol-commit" });
    const integration = async () => (await (await call("/api/repos")).json()).find((r) => r.name === "pol-commit").branch_policy.integration;
    expect(await integration()).toEqual(["main"]);
    // cinder's commit writer moves main and leaves its marker; Artifacts then delivers the push event.
    const sha = "b".repeat(40);
    fake.repos.get("pol-commit").files[".cinder.yml"] = "branches:\n  integration: [develop, main]\n";
    fake.repos.get("pol-commit").commits.unshift({ sha, message: "policy" });
    await env.DB.prepare("INSERT INTO ref_writes (repo, ref, sha) VALUES ('pol-commit', 'refs/heads/main', ?)").bind(sha).run();
    await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "cinder", repoName: "pol-commit" },
      payload: { ref: "refs/heads/main", before: "a".repeat(40), after: sha, commits: [] } } }] }, { ...env, ARTIFACTS: fake });
    expect(await integration()).toEqual(["develop", "main"]);
  });

  it("a repo created with no commit lists as empty, and a push clears it", async () => {
    const { fake, call } = setup();
    await call("/api/repos", { name: "empty-1", strategy: "trunk" });
    const listed = async () => (await (await call("/api/repos")).json()).find((r) => r.name === "empty-1");
    expect(validateRepo(await listed())).toEqual({ ok: true, errors: [] });
    expect((await listed()).empty).toBe(true);
    const sha = "c".repeat(40);
    fake.repos.get("empty-1").commits.unshift({ sha, message: "first" });
    await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { type: "artifacts.repo", namespace: "cinder", repoName: "empty-1" },
      payload: { ref: "refs/heads/main", before: "0".repeat(40), after: sha, commits: [] } } }] }, { ...env, ARTIFACTS: fake });
    expect((await listed()).empty).toBe(false);
  });

  it("GET /api/repos/:name reports an empty repo as empty", async () => {
    const { fake, call } = setup();
    await call("/api/repos", { name: "empty-get", strategy: "trunk" });
    const got = async () => (await call("/api/repos/empty-get")).json();
    expect(validateRepo(await got())).toEqual({ ok: true, errors: [] });
    expect((await got()).empty).toBe(true);
    fake.repos.get("empty-get").commits.unshift({ sha: "d".repeat(40), message: "first" });
    expect((await got()).empty).toBe(false);
  });

  it("after an import whose .cinder.yml lists develop, GET /api/repos includes develop in branch_policy.integration", async () => {
    const url = "https://git.example.com/acme/pol.git";
    const fake = fakeArtifacts({ imports: { [url]: { ".cinder.yml": "branches:\n  integration: [develop, main]\n" } } });
    const call = (path, body) => worker.fetch(
      new Request(`http://cinder.test${path}`, body ? { method: "POST", headers: OWNER, body: JSON.stringify(body) } : { headers: OWNER }),
      { ...env, ARTIFACTS: fake },
    );
    expect((await call("/api/repos", { name: "pol-import", import: { url } })).status).toBe(201);
    const repo = (await (await call("/api/repos")).json()).find((r) => r.name === "pol-import");
    expect(repo.status).toBe("ready");
    expect(repo.branch_policy.integration).toContain("develop");
  });

  it("import passes url and branch", async () => {
    const { fake, call } = setup();
    const res = await call("/api/repos", { name: "imp", import: { url: "https://github.com/acme/imp.git", branch: "develop" } });
    expect(res.status).toBe(201);
    expect(fake.calls).toEqual([{ method: "import", args: ["imp", { url: "https://github.com/acme/imp.git", branch: "develop" }] }]);
    expect((await res.json()).default_branch).toBe("develop");
  });

  it("importing a repo whose default branch is trunk sets default_branch trunk", async () => {
    const { fake, call } = setup();
    const realImport = fake.import;
    fake.import = async (params) => ({ ...(await realImport(params)), defaultBranch: "trunk" });
    const res = await call("/api/repos", { name: "trunky", import: { url: "https://git.example.com/acme/trunky.git" } });
    expect(res.status).toBe(201);
    expect((await res.json()).default_branch).toBe("trunk");
    expect(await env.DB.prepare("SELECT default_branch FROM repos WHERE name = 'trunky'").first("default_branch")).toBe("trunk");
  });

  it("an import whose Artifacts call rejects returns 502 import_failed and creates no repo row", async () => {
    const { fake, call } = setup();
    fake.import = async () => { throw new Error("could not resolve host git.example.com"); };
    const res = await call("/api/repos", { name: "unreachable", import: { url: "https://git.example.com/acme/x.git" } });
    expect(res.status).toBe(502);
    expect((await res.json()).error).toEqual({ code: "import_failed", message: expect.stringContaining("could not resolve host") });
    expect(await env.DB.prepare("SELECT 1 FROM repos WHERE name = 'unreachable'").first()).toBeNull();
  });

  it("bad name → 400, no Artifacts call", async () => {
    const { fake, call } = setup();
    for (const name of ["a", "A-repo", "has_underscore", "x".repeat(64), "", undefined]) {
      const res = await call("/api/repos", { name });
      expect(res.status, String(name)).toBe(400);
    }
    expect((await call("/api/repos", { name: "ok-name", import: { url: "not a url" } })).status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("refuses an http import URL", async () => {
    const { fake, call } = setup();
    const res = await call("/api/repos", { name: "plain", import: { url: "http://git.example.com/acme/p.git", token: "secret" } });
    expect(res.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });

  it("refuses a repo name that contains --c or is reserved", async () => {
    const { fake, call } = setup();
    for (const name of ["app--c1", "app--cabc-x", "cinder-agents", "cinder-wiki"]) {
      const res = await call("/api/repos", { name });
      expect(res.status, name).toBe(400);
    }
    expect(fake.calls).toEqual([]);
  });
});

describe("repo delete", () => {
  it("deleting a repo removes its import token secret", async () => {
    const cf = fakeCloudflare();
    vi.stubGlobal("fetch", cf.fetch);
    const e = { ...env, ...cf.env, ARTIFACTS: fakeArtifacts() };
    const send = (method, path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: JSON.stringify(body) }), e);
    try {
      expect((await send("POST", "/api/repos", { name: "del-token" })).status).toBe(201);
      expect((await send("POST", "/api/keystore", { name: "IMPORT_TOKEN", kind: "import_credential", scope: "repo", repo: "del-token", value: "ghp_import-token" })).status).toBe(201);
      expect([...cf.secrets.values()].some((s) => s.value === "ghp_import-token")).toBe(true);

      expect((await send("DELETE", "/api/repos/del-token", { confirm: "del-token" })).status).toBe(204);
      expect(await env.DB.prepare("SELECT 1 FROM keystore_secrets WHERE repo = 'del-token'").first()).toBeNull();
      expect([...cf.secrets.values()].some((s) => s.value === "ghp_import-token")).toBe(false);
      expect(cf.bound).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe("re-import", () => {
  const POLICY = 'branches:\n  integration: ["main","kept"]\n';
  // A repo whose main holds only cinder's .cinder.yml, which re-import replaces.
  async function policyOnly(fake, name) {
    const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, body ? { method: "POST", headers: OWNER, body: JSON.stringify(body) } : { headers: OWNER }), { ...env, ARTIFACTS: fake });
    expect((await call("/api/repos", { name })).status).toBe(201);
    Object.assign(fake.repos.get(name), { files: { ".cinder.yml": POLICY }, commits: [{ sha: "p1", message: "cinder: branch policy" }], branches: ["main"] });
    const status = async () => (await (await call("/api/repos")).json()).find((r) => r.name === name).status;
    return { reimport: (url) => call(`/api/repos/${name}/import`, { url }), status };
  }

  it("re-import waits for the delete and does not answer repo already exists", async () => {
    const url = "https://git.example.com/acme/race.git";
    const fake = fakeArtifacts({ imports: { [url]: { README: "hi\n" } } });
    const { reimport } = await policyOnly(fake, "reimp-race");
    // get stops finding the repo at once, while import still finds its name taken.
    const imp = fake.import;
    fake.import = async () => { fake.import = imp; throw new Error("repository reimp-race already exists"); };
    expect((await reimport(url)).status).toBe(200);
    expect(fake.calls.filter((c) => c.method === "import")).toHaveLength(1);
  });

  it("re-import sets the default branch from the source and restores the kept policy", async () => {
    const url = "https://git.example.com/acme/master-src.git";
    const dir = `reimp-${crypto.randomUUID()}`;
    await git(["init", "-q", "--bare", "-b", "master", `${dir}.git`]);
    const base = await git(["--git-dir", `${dir}.git`, "commit-tree", "4b825dc642cb6eb9a060e54bf8d69288fbee4904", "-m", "imported"],
      { env: { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x.test", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x.test" } });
    await git(["--git-dir", `${dir}.git`, "update-ref", "refs/heads/master", base]);
    // The source's HEAD is master; the import lands as the bare repo's commit, so the policy commit is pushed for real.
    const remote = (await bareRepo(dir).info()).remote;
    const fake = fakeArtifacts({ remote: () => remote, imports: { [url]: { README: "hi\n" } }, heads: { [url]: "master" } });
    const [get, imp] = [fake.get, fake.import];
    fake.get = async (name) => {
      const cap = await get(name);
      return { ...cap, readCommit: bareRepo(dir).readCommit, readTree: (h) => (h.startsWith("tree:") ? cap.readTree(h) : bareRepo(dir).readTree(h)) };
    };
    fake.import = async (args) => {
      const r = await imp(args);
      r.commits[0].sha = base;
      return r;
    };
    const { reimport, status } = await policyOnly(fake, "reimp-master");
    const res = await reimport(url);
    expect(res.status).toBe(200);
    expect((await res.json()).default_branch).toBe("master");
    expect(await status()).toBe("ready");
    expect(await git(["--git-dir", `${dir}.git`, "show", "master:.cinder.yml"])).toBe(POLICY.trimEnd());
  });

  it("a failed re-import leaves the repo out of importing with an error", async () => {
    const url = "https://git.example.com/acme/gone.git";
    const fake = fakeArtifacts();
    const { reimport, status } = await policyOnly(fake, "reimp-fail");
    fake.import = async () => { throw new Error("could not resolve host git.example.com"); };
    const res = await reimport(url);
    expect(res.status).toBe(502);
    expect((await res.json()).error.message).toContain("could not resolve host");
    expect(await status()).toBe("failed");
  });
});

describe("flakes api", () => {
  async function seed(call, name, rows) {
    await call("/api/repos", { name });
    const { id } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
    const insert = "INSERT INTO test_results (repo, sha, test, attempt, status, duration) VALUES (?, ?, ?, ?, ?, 0)";
    await env.DB.batch(rows.map(([test, sha, attempt, status]) => env.DB.prepare(insert).bind(id, sha, test, attempt, status)));
    const flakes = async () => (await call(`/api/repos/${name}/flakes`)).json();
    return { id, flakes };
  }

  it("fail-then-pass on one sha counts as a flake", async () => {
    const { call } = setup();
    const old = Array.from({ length: 50 }, (_, i) => ["TestOld", `s${i}`, 1, "pass"]);
    const { flakes } = await seed(call, "fl-one", [
      ["TestOld", "old", 1, "fail"], ["TestOld", "old", 2, "pass"], ...old,
      ["TestX", "a", 1, "fail"], ["TestX", "a", 2, "pass"],
      ["TestX", "b", 1, "pass"],
      ["TestX", "c", 1, "pass"], ["TestX", "c", 2, "fail"],
      ["TestX", "d", 1, "fail"],
    ]);
    const got = await flakes();
    for (const f of got) expect(validateFlake(f)).toEqual({ ok: true, errors: [] });
    expect(got).toEqual([
      { test: "TestOld", runs: 50, flakes: 0, rate: 0, quarantined: false, quarantined_since: null, quarantined_by: null },
      { test: "TestX", runs: 4, flakes: 1, rate: 0.25, quarantined: false, quarantined_since: null, quarantined_by: null },
    ]);
    expect((await call("/api/repos/missing/flakes")).status).toBe(404);
  });

  it("flakes quarantined matches the held tests", async () => {
    const { call } = setup();
    const runs = (test, flaky) => Array.from({ length: 5 }, (_, i) => i < flaky
      ? [[test, `s${i}`, 1, "fail"], [test, `s${i}`, 2, "pass"]]
      : [[test, `s${i}`, 1, "pass"]]).flat();
    const { id, flakes } = await seed(call, "fl-two", [...runs("TestA", 1), ...runs("TestB", 2), ...runs("TestC", 0)]);
    const quarantine = "INSERT INTO test_quarantine (repo, test, flake_rate, since, released_at) VALUES (?, ?, 0.2, ?, ?)";
    await env.DB.batch([env.DB.prepare(quarantine).bind(id, "TestA", "2026-10-01T00:00:00Z", null),
      env.DB.prepare(quarantine).bind(id, "TestC", "2026-10-01T00:00:00Z", "2026-10-02T00:00:00Z")]);
    const got = await flakes();
    expect(got.map((f) => [f.test, f.quarantined, f.quarantined_since])).toEqual([
      ["TestA", true, "2026-10-01T00:00:00Z"], ["TestB", false, null], ["TestC", false, null]]);
    for (const f of got) expect(f.quarantined).toBe(f.quarantined_since !== null);
  });
});
