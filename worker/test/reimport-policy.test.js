// The live checkout-js holds only cinder's .cinder.yml policy commits, so a re-import must treat it as empty.
// Its own file: storage is shared within a file, and the other seed files need checkout-js imported fresh.
import { env } from "cloudflare:workers";
import { afterAll, beforeAll, expect, inject, it } from "vitest";
import { client } from "../../seed/seed.mjs";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";
import { SEED_IMPORTS } from "./fakes/seed.js";

const dir = `reimport-${crypto.randomUUID()}`;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904";
const GIT_ENV = { GIT_AUTHOR_NAME: "a", GIT_AUTHOR_EMAIL: "a@x.test", GIT_COMMITTER_NAME: "a", GIT_COMMITTER_EMAIL: "a@x.test" };
// Every repo's remote is one relay bare repo, so the re-applied policy commit lands for real.
const fake = fakeArtifacts({ remote: () => `${inject("runnerRelay").url}/smart/${dir}.git`, imports: SEED_IMPORTS });
const api = client({ url: "http://cinder.test", token: env.OWNER_TOKEN, fetch: (url, init) => worker.fetch(new Request(url, init), { ...env, ARTIFACTS: fake }) });
let base;

beforeAll(async () => {
  env.ARTIFACTS = fake;
  await git(["init", "-q", "--bare", "-b", "main", `${dir}.git`]);
  base = await git(["--git-dir", `${dir}.git`, "commit-tree", EMPTY_TREE, "-m", "imported"], { env: GIT_ENV });
  await git(["--git-dir", `${dir}.git`, "update-ref", "refs/heads/main", base]);
  // The import lands as the bare repo's commit, whose tree commit() reads from git; the fake's own "tree:" hashes stay fake.
  const [get, imp] = [fake.get.bind(fake), fake.import.bind(fake)];
  fake.get = async (name) => {
    const cap = await get(name);
    return { ...cap, readCommit: bareRepo(dir).readCommit, readTree: (h) => (h.startsWith("tree:") ? cap.readTree(h) : bareRepo(dir).readTree(h)) };
  };
  fake.import = async (args) => {
    const r = await imp(args);
    r.commits[0].sha = base;
    return r;
  };
});
afterAll(() => { delete env.ARTIFACTS; });

const policyOnly = async (name, files) => {
  await api("POST", "/api/repos", { name });
  Object.assign(fake.repos.get(name), { files, commits: [{ sha: "p2", message: "cinder: update branch policy" }, { sha: "p1", message: "cinder: update branch policy" }], branches: ["main"] });
};
const reimport = (name) => worker.fetch(new Request(`http://cinder.test/api/repos/${name}/import`, { method: "POST",
  headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify({ url: "https://github.com/octocat/Hello-World.git" }) }), { ...env, ARTIFACTS: fake });

it("re-imports a repo with only policy commits on main and keeps its policy", async () => {
  await policyOnly("policy-only", { ".cinder.yml": 'branches:\n  integration: ["main","next"]\n' });
  expect((await reimport("policy-only")).status).toBe(200);
  // Listing finds the import landed, which re-applies the kept policy.
  await api("GET", "/api/repos");
  expect(await git(["--git-dir", `${dir}.git`, "show", "main:.cinder.yml"])).toBe('branches:\n  integration: ["main","next"]');
  expect(await git(["--git-dir", `${dir}.git`, "rev-parse", "main^"])).toBe(base);
});

it("refuses to re-import a repo with one file besides .cinder.yml", async () => {
  await policyOnly("one-file", { ".cinder.yml": 'branches:\n  integration: ["main"]\n', "src/index.js": "export {};\n" });
  expect((await reimport("one-file")).status).toBe(409);
  expect(fake.calls.filter((c) => c.method === "delete" && c.args[0] === "one-file")).toHaveLength(0);
});

it("a failed re-import keeps .cinder.yml policy and leaves the repo retryable", async () => {
  await git(["--git-dir", `${dir}.git`, "update-ref", "refs/heads/main", base]);
  await policyOnly("retry-import", { ".cinder.yml": 'branches:\n  integration: ["main","retry"]\n' });
  const imp = fake.import;
  fake.import = async () => { fake.import = imp; throw new Error("connection reset"); };
  expect((await reimport("retry-import")).status).toBe(502);
  expect((await reimport("retry-import")).status).toBe(200);
  await api("GET", "/api/repos");
  expect(await git(["--git-dir", `${dir}.git`, "show", "main:.cinder.yml"])).toBe('branches:\n  integration: ["main","retry"]');
});
