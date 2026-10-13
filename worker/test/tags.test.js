import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { validateCodeLog, validateLogCommit, validateTag } from "../src/api/shapes.js";
import { syncEnvironment } from "../src/deploy.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const MANIFEST = "deploy:\n  environments:\n    - { name: production, branch: main, auto_sync: true }\n  worker: wrangler.jsonc\n";

// A repo whose Artifacts storage is a real bare repo with one commit on main holding files; returns its call() and the commit's sha.
async function repoWith(name, files) {
  const ARTIFACTS = { get: async (n) => bareRepo(n) };
  const created = [];
  const PIPELINE = { create: async (opts) => { created.push(opts); return { id: opts.id }; } };
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS, PIPELINE });
    return { status: res.status, json: await res.json() };
  };
  await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }), { ...env, ARTIFACTS: fakeArtifacts() });
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  const changes = Object.entries(files).map(([path, content]) => ({ path, content }));
  const { json } = await call("POST", `/api/repos/${name}/commits`, { branch: "main", base_sha: null, message: "init", changes });
  return { call, created, sha: json.sha, ARTIFACTS };
}

it("a tag on an existing sha points at that commit and creates no branch", async () => {
  const { call, sha } = await repoWith("tag-sha", { "README.md": "hi\n" });
  const res = await call("POST", "/api/repos/tag-sha/tags", { tag: "v1.0.0", sha, message: "first" });
  expect(res.status).toBe(201);
  expect(await git(["--git-dir", "tag-sha.git", "rev-parse", "v1.0.0^{commit}"])).toBe(sha);
  expect(await git(["--git-dir", "tag-sha.git", "for-each-ref", "--format=%(refname)", "refs/heads"])).toBe("refs/heads/main");
  expect(await git(["--git-dir", "tag-sha.git", "rev-parse", "main"])).toBe(sha);
  const tags = (await call("GET", "/api/repos/tag-sha/tags")).json;
  expect(tags.map((t) => [t.name, t.sha, t.message])).toEqual([["v1.0.0", sha, "first"]]);
  expect(validateTag(tags[0])).toEqual({ ok: true, errors: [] });
  expect((await call("POST", "/api/repos/tag-sha/tags", { tag: "v1.0.1", ref: "nope" })).status).toBe(404);
  expect((await call("POST", "/api/repos/tag-sha/tags", { tag: "v1.lock", sha })).status).toBe(400);
});

it("tagging an existing tag name answers 409 tag_exists", async () => {
  const { call, sha } = await repoWith("tag-twice", { "README.md": "hi\n" });
  expect((await call("POST", "/api/repos/tag-twice/tags", { tag: "v1", ref: "main" })).status).toBe(201);
  const again = await call("POST", "/api/repos/tag-twice/tags", { tag: "v1", sha });
  expect(again.status).toBe(409);
  expect(again.json.error.code).toBe("tag_exists");
});

it("promoting a release from a new tag reads .cinder.yml at the tagged commit", async () => {
  const { call, created, sha, ARTIFACTS } = await repoWith("tag-promote", { ".cinder.yml": MANIFEST });
  expect((await call("POST", "/api/repos/tag-promote/tags", { tag: "v2", ref: "main" })).status).toBe(201);
  const release = (await call("POST", "/api/repos/tag-promote/releases", { tag: "v2", title: "Two" })).json;
  expect((await call("POST", "/api/repos/tag-promote/environments/production/promote", { release: release.id })).status).toBe(202);
  const [{ params }] = created;
  expect(params.sha).toBe(sha);
  // The sync's plan reads .cinder.yml at the promoted sha; the deploy steps after it are not this test's.
  let plan;
  const stop = new Error("stop after plan");
  const step = { do: async (name, fn) => { if (name !== "plan sync") throw stop; return plan = await fn(); } };
  await expect(syncEnvironment({ ...env, ARTIFACTS }, params.repo, params.branch, params.sha, step, { manual: true, id: params.sync })).rejects.toBe(stop);
  expect(plan.target.name).toBe("production");
});

it("a short SHA resolves to a commit in this repo, or errors", async () => {
  const { call, sha } = await repoWith("tag-resolve", { "README.md": "hi\n" });
  const found = await call("GET", `/api/repos/tag-resolve/resolve?sha=${sha.slice(0, 7)}`);
  expect(found.status).toBe(200);
  expect(found.json).toMatchObject({ sha, message: "init" });
  expect(validateLogCommit(found.json)).toEqual({ ok: true, errors: [] });
  const other = sha.startsWith("0000000") ? "1111111" : "0000000";
  expect((await call("GET", `/api/repos/tag-resolve/resolve?sha=${other}`)).status).toBe(404);
  expect((await call("GET", "/api/repos/tag-resolve/resolve?sha=zz12345")).status).toBe(400);
  const log = await call("GET", "/api/repos/tag-resolve/log?ref=main");
  expect(log.json.commits.map((c) => c.sha)).toEqual([sha]);
  expect(validateCodeLog(log.json)).toEqual({ ok: true, errors: [] });
});
