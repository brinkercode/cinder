import { env } from "cloudflare:workers";
import { expect, it } from "vitest";
import { validateEnvironment, validateRelease, validateTag } from "../src/api/shapes.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const MANIFEST = "deploy:\n  environments:\n    - { name: production, branch: main, auto_sync: true }\n  worker: wrangler.jsonc\n";

it("create a tag and a release; promote it to an environment; persists after a reload", async () => {
  const fake = fakeArtifacts();
  let created;
  const PIPELINE = { create: async (opts) => { created = opts; return { id: opts.id }; } };
  const call = async (method, path, body, artifacts = fake) => {
    const res = await worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: artifacts, PIPELINE });
    return { status: res.status, json: await res.json() };
  };
  expect((await call("POST", "/api/repos", { name: "rel-flow" })).status).toBe(201);
  fake.repos.get("rel-flow").files[".cinder.yml"] = MANIFEST;

  // The tag goes through the commit API, which pushes to a real bare repo.
  await git(["init", "-q", "--bare", "-b", "main", "rel-flow.git"]);
  const tagged = { branch: "main", base_sha: null, message: "v1.0.0", tag: "v1.0.0", changes: [{ path: "CHANGELOG.md", content: "# v1.0.0\n" }] };
  const commit = await call("POST", "/api/repos/rel-flow/commits", tagged, { get: async (n) => bareRepo(n) });
  expect(commit.status).toBe(201);
  expect(await git(["--git-dir", "rel-flow.git", "rev-parse", "v1.0.0^{commit}"])).toBe(commit.json.sha);
  expect((await call("POST", "/api/repos/rel-flow/commits", { ...tagged, branch: "other" }, { get: async (n) => bareRepo(n) })).status).toBe(409);

  const at = "/api/repos/rel-flow/releases";
  expect((await call("POST", at, { tag: "v9", title: "Nope" })).status).toBe(404);
  const draft = await call("POST", at, { tag: "v1.0.0", title: "First cut", notes: "Adds the changelog.", draft: true });
  expect(draft.status).toBe(201);
  expect(validateRelease(draft.json)).toEqual({ ok: true, errors: [] });
  expect(draft.json).toMatchObject({ state: "draft", sha: commit.json.sha, environments: [] });
  expect((await call("POST", at, { tag: "v1.0.0", title: "Again" })).status).toBe(409);
  const promote = (release) => call("POST", "/api/repos/rel-flow/environments/production/promote", { release });
  expect((await promote(draft.json.id)).status).toBe(409);
  expect(created).toBeUndefined();

  const published = await call("POST", `${at}/${draft.json.id}/publish`);
  expect(published.status).toBe(200);
  expect(published.json.state).toBe("published");
  expect((await call("POST", `${at}/${draft.json.id}/publish`)).status).toBe(409);
  expect((await call("POST", "/api/repos/rel-flow/environments/staging/promote", { release: draft.json.id })).status).toBe(404);
  const promoted = await promote(draft.json.id);
  expect(promoted.status).toBe(202);
  expect(created.params).toEqual({ sync: promoted.json.id, repo: "rel-flow", env: "production", branch: "main", sha: commit.json.sha, actor: "owner", override: false, all: false });

  // A reload reads everything back from D1.
  const tags = (await call("GET", "/api/repos/rel-flow/tags")).json;
  expect(tags.map((t) => [t.name, t.sha])).toEqual([["v1.0.0", commit.json.sha]]);
  for (const t of tags) expect(validateTag(t)).toEqual({ ok: true, errors: [] });
  const [release] = (await call("GET", at)).json;
  expect(validateRelease(release)).toEqual({ ok: true, errors: [] });
  expect(release).toMatchObject({ tag: "v1.0.0", title: "First cut", notes: "Adds the changelog.", state: "published", environments: [] });
});

it("lists a tag that arrived by push", async () => {
  await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name: "rel-pushed" }) }), { ...env, ARTIFACTS: fakeArtifacts() });
  await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: "rel-pushed" },
    payload: { ref: "refs/tags/v3.0.0", before: "0".repeat(40), after: "e".repeat(40), commits: [{ message: "v3" }] } } }] }, env);
  const tags = await (await worker.fetch(new Request("http://cinder.test/api/repos/rel-pushed/tags", { headers: OWNER }), env)).json();
  expect(tags).toMatchObject([{ name: "v3.0.0", sha: "e".repeat(40), message: "v3" }]);
  expect(validateTag(tags[0])).toEqual({ ok: true, errors: [] });
});

// A repo with a published release v2.0.0 of a pushed tag at sha, and .cinder.yml declaring environments.
async function released(name, environments) {
  const fake = fakeArtifacts();
  const created = [];
  const PIPELINE = { create: async (opts) => { created.push(opts); return { id: opts.id }; } };
  const call = async (method, path, body) => {
    const res = await worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: fake, PIPELINE });
    return { status: res.status, json: res.status === 204 ? null : await res.json() };
  };
  await call("POST", "/api/repos", { name });
  fake.repos.get(name).files[".cinder.yml"] = `deploy:\n  environments:\n${environments}  worker: wrangler.jsonc\n`;
  const sha = "a".repeat(40);
  await worker.queue({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: name },
    payload: { ref: "refs/tags/v2.0.0", before: "0".repeat(40), after: sha, commits: [{ message: "v2" }] } } }] }, env);
  const release = (await call("POST", `/api/repos/${name}/releases`, { tag: "v2.0.0", title: "Two" })).json;
  const live = async () => (await call("GET", `/api/repos/${name}/releases`)).json[0].environments;
  return { call, created, release, sha, live };
}

it("promoting to a gated environment creates a pending approval and no live status", async () => {
  const { call, created, release, sha, live } = await released("rel-gated", "    - { name: dev, branch: main }\n");
  const promoted = await call("POST", "/api/repos/rel-gated/environments/dev/promote", { release: release.id });
  expect(promoted.status).toBe(202);
  expect(created).toEqual([]);
  const need = (await call("GET", "/api/needs")).json.find((n) => n.id === promoted.json.need);
  expect(need).toMatchObject({ kind: "Release approval", repo: "rel-gated", change: null, actions: ["Approve", "Reject"] });
  expect(await live()).toEqual([]);

  // Approve starts the deploy; the release is still not live until it lands.
  expect((await call("POST", `/api/needs/${need.id}/resolve`, { action: "Approve" })).status).toBe(200);
  expect(created.map((c) => c.params)).toEqual([{ sync: created[0].id, repo: "rel-gated", env: "dev", branch: "main", sha, actor: "owner", override: false, all: false }]);
  expect(await live()).toEqual([]);
});

it("a gated promote all at once lists its pending approval with its age and deploys without gradual steps once approved", async () => {
  const { call, created, release } = await released("rel-all", "    - { name: dev, branch: main }\n");
  expect((await call("POST", "/api/repos/rel-all/environments/dev/promote", { release: release.id, rollout: "some" })).status).toBe(400);
  const { need } = (await call("POST", "/api/repos/rel-all/environments/dev/promote", { release: release.id, rollout: "all" })).json;
  const [dev] = (await call("GET", "/api/repos/rel-all/environments")).json;
  expect(validateEnvironment(dev)).toEqual({ ok: true, errors: [] });
  expect(dev.pending).toMatchObject([{ need, release: "v2.0.0" }]);
  expect(Date.parse(dev.pending[0].at)).toBeGreaterThan(0);
  expect((await call("POST", `/api/needs/${need}/resolve`, { action: "Approve" })).status).toBe(200);
  expect(created.map((c) => c.params.all)).toEqual([true]);
});

it("a release is live in an environment only after a successful deploy of its sha", async () => {
  const { call, created, release, sha, live } = await released("rel-deploy", "    - { name: production, branch: main, auto_sync: true }\n");
  expect((await call("POST", "/api/repos/rel-deploy/environments/production/promote", { release: release.id })).status).toBe(202);
  const [{ id }] = created;
  expect(await live()).toEqual([]);
  // The pipeline records the sync Progressing, then Synced once the deploy succeeds (src/deploy.js).
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, status, changes, actor, started_at, at) VALUES (?, 'rel-deploy', 'production', ?, 'Progressing', '[]', 'owner', ?, ?)")
    .bind(id, sha, "2026-10-07T00:00:00Z", "2026-10-07T00:00:00Z").run();
  expect(await live()).toEqual([]);
  await env.DB.prepare("UPDATE deploy_syncs SET status = 'Synced', at = ? WHERE id = ?").bind("2026-10-07T00:01:00Z", id).run();
  expect(await live()).toEqual(["production"]);
  const [card] = (await call("GET", "/api/repos/rel-deploy/environments")).json;
  expect([card.release, card.deployed_at]).toEqual(["v2.0.0", "2026-10-07T00:01:00Z"]);
});

it("a release whose sha matches staging's current deploy reads Live in staging", async () => {
  const { sha, live } = await released("rel-staging", "    - { name: staging, branch: main }\n");
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, status, changes, actor, started_at, at) VALUES ('rel-staging:0', 'rel-staging', 'staging', ?, 'Synced', '[]', 'cinder-pipeline', ?, ?)")
    .bind(sha, "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z").run();
  expect(await live()).toEqual(["staging"]);
});

it("POST /api/repos/:name/seed/deployments is not a route", async () => {
  const { call } = await released("rel-noseed", "    - { name: staging, branch: main }\n");
  expect((await call("POST", "/api/repos/rel-noseed/seed/deployments", [])).status).toBe(404);
});

it("GET tags?limit=1 returns only the newest tag", async () => {
  await env.DB.batch(["2026-10-01T00:00:00Z", "2026-10-03T00:00:00Z", "2026-10-02T00:00:00Z"].map((at, i) =>
    env.DB.prepare("INSERT INTO tags (repo, name, sha, message, tagger, created_at) VALUES ('rel-limit', ?, ?, '', 'owner', ?)").bind(`v${i}`, String(i).repeat(40), at)));
  const get = (q) => worker.fetch(new Request(`http://cinder.test/api/repos/rel-limit/tags${q}`, { headers: OWNER }), env);
  expect((await (await get("?limit=1")).json()).map((t) => t.name)).toEqual(["v1"]);
  expect((await (await get("")).json()).map((t) => t.name)).toEqual(["v1", "v2", "v0"]);
  for (const q of ["?limit=0", "?limit=101", "?limit=x", "?limit=1.5", "?limit="]) expect((await get(q)).status, q).toBe(400);
});

it("promotes the sha a release was published at after its tag moves", async () => {
  const { call, created, release, sha } = await released("rel-pinned", "    - { name: production, branch: main, auto_sync: true }\n    - { name: dev, branch: main }\n");
  // The release was published while its tag was at sha; the tag then moves.
  await env.DB.prepare("UPDATE tags SET sha = ? WHERE repo = 'rel-pinned' AND name = 'v2.0.0'").bind("b".repeat(40)).run();
  expect((await call("GET", "/api/repos/rel-pinned/releases")).json[0].sha).toBe(sha);
  expect((await call("POST", "/api/repos/rel-pinned/environments/production/promote", { release: release.id })).status).toBe(202);
  const { need } = (await call("POST", "/api/repos/rel-pinned/environments/dev/promote", { release: release.id })).json;
  expect((await call("POST", `/api/needs/${need}/resolve`, { action: "Approve" })).status).toBe(200);
  expect(created.map((c) => c.params.sha)).toEqual([sha, sha]);

  // A draft published after its tag moved deploys the sha it was published at.
  await env.DB.prepare("INSERT INTO tags (repo, name, sha, message, tagger, created_at) VALUES ('rel-pinned', 'v3', ?, 'v3', 'push', ?)").bind("c".repeat(40), "2026-10-09T00:00:00Z").run();
  const v3 = (await call("POST", "/api/repos/rel-pinned/releases", { tag: "v3", title: "Three", draft: true })).json;
  await env.DB.prepare("UPDATE tags SET sha = ? WHERE repo = 'rel-pinned' AND name = 'v3'").bind("d".repeat(40)).run();
  expect((await call("POST", `/api/repos/rel-pinned/releases/${v3.id}/publish`)).json.sha).toBe("d".repeat(40));
  await env.DB.prepare("UPDATE tags SET sha = ? WHERE repo = 'rel-pinned' AND name = 'v3'").bind("e".repeat(40)).run();
  expect((await call("POST", "/api/repos/rel-pinned/environments/production/promote", { release: v3.id })).status).toBe(202);
  expect(created.at(-1).params.sha).toBe("d".repeat(40));
});
