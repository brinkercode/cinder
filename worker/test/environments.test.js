import { env } from "cloudflare:workers";
import { afterEach, expect, it, vi } from "vitest";
import { validateEnvironment, validateEnvironmentTree, validateBranchDeploy } from "../src/api/shapes.js";
import { reconcileTriggers, parseDeploy } from "../src/deploy.js";
import worker from "../src/index.js";
import { PipelineWorkflow } from "../src/pipeline.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const MANIFEST = "deploy:\n  environments:\n    - { name: staging, branch: develop }\n    - { name: production, branch: main, gradual: [10, 50, 100] }\n  worker: wrangler.jsonc\n  resources:\n    - { type: kv, name: pulse-cache }\n";

it("environments list shows status and live version", async () => {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake };
  const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), e);
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "env-list" }) });
  fake.repos.get("env-list").files[".cinder.yml"] = MANIFEST;
  const sync = async (sha, version, status, step, at) => {
    const id = crypto.randomUUID();
    await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, 'env-list', 'production', ?, ?, ?, ?, 'cinder-pipeline', ?, ?)")
      .bind(id, sha, version, status, JSON.stringify([sha]), at, at).run();
    await env.DB.prepare("INSERT INTO deploy_sync_steps (sync_id, step) VALUES (?, ?)").bind(id, step).run();
  };
  await sync("1".repeat(40), "v1", "Synced", 100, "2026-10-01T00:00:00Z");
  await sync("2".repeat(40), "v2", "Degraded", 10, "2026-10-02T00:00:00Z");
  await env.DB.prepare("INSERT INTO deploy_resources (repo, env, type, name, cf_id) VALUES ('env-list', 'production', 'r2', 'old-bucket', 'b1')").run();

  const res = await call("/api/repos/env-list/environments");
  expect(res.status).toBe(200);
  const list = await res.json();
  for (const item of list) expect(validateEnvironment(item)).toEqual({ ok: true, errors: [] });
  expect(list.map((x) => x.name)).toEqual(["staging", "production"]);
  expect(list[0]).toMatchObject({ status: null, live_version: null, step: null, history: [] });
  expect(list[1]).toMatchObject({
    branch: "main", status: "Degraded", step: 10, live_version: { version_id: "v1", sha: "1".repeat(40) },
    drift: [{ type: "r2", name: "old-bucket" }],
  });
  expect(list[1].history.map((s) => s.version_id)).toEqual(["v2", "v1"]);
});

it("an environment with a deploy row but no version id returns live_version null and passes the contract", async () => {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake };
  const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), e);
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "env-no-version" }) });
  fake.repos.get("env-no-version").files[".cinder.yml"] = MANIFEST;
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, status, changes, actor, started_at, at) VALUES ('s1', 'env-no-version', 'production', ?, 'Synced', '[]', 'owner', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')")
    .bind("1".repeat(40)).run();

  const list = await (await call("/api/repos/env-no-version/environments")).json();
  for (const item of list) expect(validateEnvironment(item)).toEqual({ ok: true, errors: [] });
  expect(list[1]).toMatchObject({ name: "production", status: "Synced", live_version: null, deployed_at: "2026-10-01T00:00:00Z" });
});

it("GET /api/repos/:repo/environments returns 200 with both environments when one branch is missing, marked branch-not-found", async () => {
  const fake = fakeArtifacts();
  const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "env-missing" }) });
  const repo = fake.repos.get("env-missing");
  repo.files[".cinder.yml"] = "deploy:\n  environments:\n    - { name: staging, branch: release/2026.10 }\n    - { name: production, branch: main }\n  worker: wrangler.jsonc\n";
  repo.commits.unshift({ sha: "1".repeat(40) });
  // The binding rejects a ref that doesn't exist.
  const get = fake.get.bind(fake);
  fake.get = async (n) => {
    const cap = await get(n);
    return cap && { ...cap, log: async (o) => (o?.ref === "release/2026.10" ? Promise.reject(new Error("ref not found")) : cap.log(o)) };
  };
  const res = await call("/api/repos/env-missing/environments");
  expect(res.status).toBe(200);
  const list = await res.json();
  for (const item of list) expect(validateEnvironment(item)).toEqual({ ok: true, errors: [] });
  expect(list.map(({ name, branch_missing, desired_sha }) => ({ name, branch_missing, desired_sha }))).toEqual([
    { name: "staging", branch_missing: true, desired_sha: null },
    { name: "production", branch_missing: false, desired_sha: "1".repeat(40) },
  ]);
});

it("each deployed version links to its Worker Deployments tab; an AWS target links to the AWS console", async () => {
  const fake = fakeArtifacts();
  const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "env-links" }) });
  Object.assign(fake.repos.get("env-links").files, {
    ".cinder.yml": "deploy:\n  environments:\n    - { name: production, branch: main, auto_sync: true, health: /healthz }\n    - { name: eu-batch, branch: develop, target: AWS }\n  worker: wrangler.jsonc\n",
    "wrangler.jsonc": JSON.stringify({ name: "pulse" }),
  });
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, 'env-links', 'production', ?, 'v1', 'Synced', '[]', 'cinder-pipeline', ?, ?)")
    .bind(crypto.randomUUID(), "1".repeat(40), "2026-10-01T00:00:00Z", "2026-10-01T00:05:00Z").run();

  const list = await (await call("/api/repos/env-links/environments")).json();
  for (const item of list) expect(validateEnvironment(item)).toEqual({ ok: true, errors: [] });
  expect(list.map(({ name, target, console: link, gate, deployed_at }) => ({ name, target, console: link, gate, deployed_at }))).toEqual([
    { name: "production", target: "Cloudflare", console: "https://dash.cloudflare.com/?to=/:account/workers/services/view/pulse-production/production/deployments",
      gate: "auto-sync · health /healthz", deployed_at: "2026-10-01T00:05:00Z" },
    { name: "eu-batch", target: "AWS", console: "https://console.aws.amazon.com/", gate: "manual", deployed_at: null },
  ]);
});

it("each target card links to its console: AWS, Google Cloud and Azure open the deployed resource, SSH names its host", async () => {
  const fake = fakeArtifacts();
  const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "env-targets" }) });
  fake.repos.get("env-targets").files[".cinder.yml"] = "deploy:\n  environments:\n"
    + "    - { name: eu-batch, branch: main, target: AWS, aws: { role_arn: \"arn:aws:iam::412398765001:role/cinder-deploy\", region: eu-west-1, service: lambda, resource: billing-eu } }\n"
    + "    - { name: analytics, branch: main, target: Google Cloud, gcp: { secret: GCP_SA_KEY, region: europe-west1, service: run, name: billing-analytics } }\n"
    + "    - { name: eu-app, branch: main, target: Azure, azure: { subscription: sub-1, resource_group: rg-billing, service: containerapps, app: billing-eu } }\n"
    + "    - { name: on-prem, branch: main, target: SSH, ssh: { host: build-01.internal, user: deploy, key_secret: SSH_DEPLOY_KEY, command: ./deploy.sh, fingerprint: \"SHA256:q3Xb7Kc\" } }\n";
  const list = await (await call("/api/repos/env-targets/environments")).json();
  for (const item of list) expect(validateEnvironment(item)).toEqual({ ok: true, errors: [] });
  expect(list.map(({ name, console: link, host }) => [name, link, host])).toEqual([
    ["eu-batch", "https://eu-west-1.console.aws.amazon.com/lambda/home?region=eu-west-1#/functions/billing-eu", null],
    ["analytics", "https://console.cloud.google.com/run/detail/europe-west1/billing-analytics", null],
    ["eu-app", "https://portal.azure.com/#@/resource/subscriptions/sub-1/resourceGroups/rg-billing/providers/Microsoft.App/containerApps/billing-eu", null],
    ["on-prem", null, "build-01.internal"],
  ]);
});

// production declares pulse-db and pulse-cache; cinder provisioned pulse-cache and still tags an old bucket.
async function treeRepo(name) {
  const fake = fakeArtifacts();
  const call = (path) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER }), { ...env, ARTIFACTS: fake });
  await worker.fetch(new Request("http://cinder.test/api/repos", { method: "POST", headers: OWNER, body: JSON.stringify({ name }) }), { ...env, ARTIFACTS: fake });
  Object.assign(fake.repos.get(name).files, {
    ".cinder.yml": "deploy:\n  environments:\n    - { name: production, branch: main }\n  worker: wrangler.jsonc\n  resources:\n    - { type: d1, name: pulse-db }\n    - { type: kv, name: pulse-cache }\n",
    "wrangler.jsonc": JSON.stringify({ name: "pulse" }),
  });
  await env.DB.prepare("INSERT INTO deploy_resources (repo, env, type, name, cf_id) VALUES (?, 'production', 'kv', 'pulse-cache', 'k1'), (?, 'production', 'r2', 'old-bucket', 'b1')")
    .bind(name, name).run();
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, ?, 'production', ?, 'v1', 'Synced', '[]', 'cinder-pipeline', ?, ?)")
    .bind(crypto.randomUUID(), name, "1".repeat(40), "2026-10-01T00:00:00Z", "2026-10-01T00:05:00Z").run();
  const res = await call(`/api/repos/${name}/environments/production/tree`);
  expect(res.status).toBe(200);
  const tree = await res.json();
  expect(validateEnvironmentTree(tree)).toEqual({ ok: true, errors: [] });
  expect((await call(`/api/repos/${name}/environments/nope/tree`)).status).toBe(404);
  return tree;
}

it("the tree lists every declared resource with its binding name", async () => {
  const tree = await treeRepo("env-tree");
  expect(tree.script).toBe("pulse-production");
  expect(tree.live_version).toEqual({ version_id: "v1", sha: "1".repeat(40) });
  expect(tree.bindings.filter((b) => b.binding).map(({ binding, type, resource }) => ({ binding, type, resource }))).toEqual([
    { binding: "PULSE_DB", type: "d1", resource: "pulse-db-production" },
    { binding: "PULSE_CACHE", type: "kv", resource: "pulse-cache-production" },
  ]);
});

it("a drifted resource is flagged", async () => {
  const tree = await treeRepo("env-tree-drift");
  expect(tree.bindings.map(({ resource, drift }) => ({ resource, drift }))).toEqual([
    { resource: "pulse-db-production", drift: true },
    { resource: "pulse-cache-production", drift: false },
    { resource: "old-bucket-production", drift: true },
  ]);
  expect(tree.bindings[2].binding).toBeNull();
});

afterEach(() => vi.restoreAllMocks());

const pruneSetup = async (repo) => {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
  const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), e);
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: repo }) });
  fake.repos.get(repo).files[".cinder.yml"] = MANIFEST;
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, ?, 'staging', ?, 'v1', 'Synced', '[]', 'cinder-pipeline', '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')")
    .bind(crypto.randomUUID(), repo, "1".repeat(40)).run();
  await env.DB.prepare("INSERT INTO deploy_resources (repo, env, type, name, cf_id) VALUES (?, 'staging', 'kv', 'pulse-cache', 'kv1'), (?, 'staging', 'kv', 'old-cache', 'kv2')")
    .bind(repo, repo).run();
  const cf = vi.fn(async () => Response.json({ success: true, result: null }));
  vi.stubGlobal("fetch", cf);
  const prune = (body) => call(`/api/repos/${repo}/environments/staging/prune`, { method: "POST", body: JSON.stringify(body) });
  const tagged = async () => (await env.DB.prepare("SELECT name FROM deploy_resources WHERE repo = ? ORDER BY name").bind(repo).all()).results.map((r) => r.name);
  return { cf, prune, tagged, call };
};
afterEach(() => vi.unstubAllGlobals());

it("prune deletes a drifted KV namespace and records the actor", async () => {
  const { cf, prune, tagged } = await pruneSetup("prune-ok");
  const res = await prune({ resources: [{ type: "kv", name: "old-cache" }], confirm: "staging" });
  expect(res.status).toBe(204);
  expect(cf).toHaveBeenCalledTimes(1);
  expect(cf.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/accounts/acct/storage/kv/namespaces/kv2");
  expect(cf.mock.calls[0][1].method).toBe("DELETE");
  expect(await tagged()).toEqual(["pulse-cache"]);
  const row = await env.DB.prepare("SELECT actor, status, version_id, reason FROM deploy_syncs JOIN deploy_sync_reasons ON sync_id = id WHERE repo = 'prune-ok'").first();
  expect(row).toEqual({ actor: "owner", status: "Synced", version_id: "v1", reason: "pruned kv:old-cache" });
});

it("a wrong confirm value returns 400 and deletes nothing", async () => {
  const { cf, prune, tagged } = await pruneSetup("prune-confirm");
  const res = await prune({ resources: [{ type: "kv", name: "old-cache" }], confirm: "production" });
  expect(res.status).toBe(400);
  expect(cf).not.toHaveBeenCalled();
  expect(await tagged()).toEqual(["old-cache", "pulse-cache"]);
});

it("a resource that is still declared returns 409", async () => {
  const { cf, prune, tagged } = await pruneSetup("prune-declared");
  const res = await prune({ resources: [{ type: "kv", name: "pulse-cache" }], confirm: "staging" });
  expect(res.status).toBe(409);
  expect(cf).not.toHaveBeenCalled();
  expect(await tagged()).toEqual(["old-cache", "pulse-cache"]);
});

it("a removed route shows as drift and isn't deleted", async () => {
  const { cf, prune, call } = await pruneSetup("route-drift");
  cf.mockImplementation(async () => Response.json({ success: true, result: { id: "rt1" } }));
  const e = { ...env, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
  const withRoute = MANIFEST.replace("branch: develop", "branch: develop, routes: [{ pattern: pulse.example/*, zone: z1 }]");
  await reconcileTriggers(e, "route-drift", parseDeploy(withRoute).environments[0], "pulse-staging", cf);
  expect(cf.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/zones/z1/workers/routes");
  expect(JSON.parse(cf.mock.calls[0][1].body)).toEqual({ pattern: "pulse.example/*", script: "pulse-staging" });

  await reconcileTriggers(e, "route-drift", parseDeploy(MANIFEST).environments[0], "pulse-staging", cf);
  expect(cf).toHaveBeenCalledTimes(1);
  const [staging] = await (await call("/api/repos/route-drift/environments")).json();
  expect(staging.drift).toEqual([{ type: "kv", name: "old-cache" }, { type: "route", name: "pulse.example/*" }]);

  expect((await prune({ resources: [{ type: "route", name: "pulse.example/*" }], confirm: "staging" })).status).toBe(204);
  expect(cf.mock.calls[1][0]).toBe("https://api.cloudflare.com/client/v4/zones/z1/workers/routes/rt1");
  expect(cf.mock.calls[1][1].method).toBe("DELETE");
});

// A repo whose production runs release v1.0.0 (sha 1…, v1) after v0.9.0 (sha 0…, v0), with main moved on to 2…; PIPELINE is faked.
async function releasedEnv(name, gate) {
  const fake = fakeArtifacts();
  const created = [];
  const e = { ...env, ARTIFACTS: fake, PIPELINE: { create: async (o) => { created.push(o); return { id: o.id }; } } };
  const call = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: body ? "POST" : "GET", headers: OWNER, body: body && JSON.stringify(body) }), e);
  await call("/api/repos", { name });
  fake.repos.get(name).files[".cinder.yml"] = `deploy:\n  environments:\n    - { name: production, branch: main${gate} }\n  worker: wrangler.jsonc\n`;
  fake.repos.get(name).commits.unshift({ sha: "2".repeat(40) });
  for (const [i, tag] of ["v0.9.0", "v1.0.0"].entries()) {
    const sha = String(i).repeat(40);
    const at = `2026-10-0${i + 1}T00:00:00Z`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO tags (repo, name, sha, message, tagger, created_at) VALUES (?, ?, ?, '', 'owner', ?)").bind(name, tag, sha, at),
      env.DB.prepare("INSERT INTO releases (id, repo, tag, title, notes, state, author, created_at, published_at) VALUES (?, ?, ?, ?, '', 'published', 'owner', ?, ?)")
        .bind(`${name}-${tag}`, name, tag, tag, at, at),
      env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, ?, 'production', ?, ?, 'Synced', '[]', 'owner', ?, ?)")
        .bind(crypto.randomUUID(), name, sha, `v${i}`, at, at),
    ]);
  }
  return { call, created, e };
}

it("sync now re-deploys the environment's current release", async () => {
  const { call, created } = await releasedEnv("env-sync", ", auto_sync: true");
  const res = await call("/api/repos/env-sync/environments/production/sync", {});
  expect(res.status).toBe(202);
  const { id } = await res.json();
  expect(created).toEqual([{ id, params: { sync: id, repo: "env-sync", env: "production", branch: "main", sha: "1".repeat(40), actor: "owner", override: false, all: false } }]);
});

it("a promote to a non-Cloudflare environment records history on that environment", async () => {
  const { call, created, e } = await releasedEnv("env-promote-ext", ", auto_sync: true }\n    - { name: aws-stg, branch: main, target: AWS }\n    - { name: azure-1, branch: main, target: Azure, auto_sync: true");
  expect((await call("/api/repos/env-promote-ext/environments/azure-1/promote", { release: "env-promote-ext-v1.0.0" })).status).toBe(202);
  const workflow = Object.assign(Object.create(PipelineWorkflow.prototype), { env: e });
  expect(await PipelineWorkflow.prototype.run.call(workflow, { payload: created[0].params }, { do: (_name, fn) => fn() })).toBe("OutOfSync");
  const list = await (await call("/api/repos/env-promote-ext/environments")).json();
  expect(list.find((x) => x.name === "azure-1").history).toMatchObject([{ sha: "1".repeat(40), status: "OutOfSync" }]);
  expect(list.find((x) => x.name === "aws-stg").history).toEqual([]);
});

it("a gated sync answers 202 with the approval need", async () => {
  const { call, created } = await releasedEnv("env-sync-gated", "");
  const res = await call("/api/repos/env-sync-gated/environments/production/sync", {});
  expect(res.status).toBe(202);
  const { name, need } = await res.json();
  expect(name).toBe("production");
  expect(created).toEqual([]);
  expect((await (await call("/api/needs")).json()).find((n) => n.id === need)).toMatchObject({ kind: "Release approval", repo: "env-sync-gated" });
});

it("GET environments lists the open release approval with its approvers and the previous release", async () => {
  const { call } = await releasedEnv("env-pending", "");
  await env.DB.prepare("INSERT INTO person_roles VALUES ('maint@env.test', 'maintainer'), ('view@env.test', 'viewer')").run();
  const { need } = await (await call("/api/repos/env-pending/environments/production/sync", {})).json();
  const [production] = await (await call("/api/repos/env-pending/environments")).json();
  expect(validateEnvironment(production)).toEqual({ ok: true, errors: [] });
  expect(production).toMatchObject({ release: "v1.0.0", previous: "v0.9.0", pending: [{ need, release: "v1.0.0", gate: "manual", can_resolve: true }] });
  expect(production.pending[0].approvers).toContain("maint@env.test");
  expect(production.pending[0].approvers).not.toContain("view@env.test");
});

it("pending approvers are the gate's approvers", async () => {
  const { call } = await releasedEnv("env-gate-role", ", approvers: release-team");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO roles VALUES ('release-team', '[\"repo.read\"]')"),
    env.DB.prepare("INSERT INTO person_roles VALUES ('rel@gate.test', 'release-team'), ('maint@gate.test', 'maintainer')"),
  ]);
  await call("/api/repos/env-gate-role/environments/production/sync", {});
  const [production] = await (await call("/api/repos/env-gate-role/environments")).json();
  expect(production.pending[0].approvers).toContain("rel@gate.test");
  expect(production.pending[0].approvers).not.toContain("maint@gate.test");
});

it("a group-granted approver is listed", async () => {
  serveCerts();
  const { call, e } = await releasedEnv("env-gate-group", ", approvers: release-group");
  await env.DB.batch([
    env.DB.prepare("INSERT INTO roles VALUES ('release-group', '[\"repo.read\"]')"),
    env.DB.prepare("INSERT INTO access_groups VALUES ('releasers', 'Access group', 'release-group', '[]')"),
  ]);
  await call("/api/repos/env-gate-group/environments/production/sync", {});
  const headers = await as("grp@gate.test", { groups: ["releasers"] });
  const res = await worker.fetch(new Request("http://cinder.test/api/repos/env-gate-group/environments", { headers }), { ...e, ...ACCESS, ARTIFACTS: e.ARTIFACTS });
  const [production] = await res.json();
  expect(production.pending[0]).toMatchObject({ can_resolve: true });
  expect(production.pending[0].approvers).toContain("grp@gate.test");
});

it("branch deploys list the environment each branch deploys to, from .cinder.yml", async () => {
  const fake = fakeArtifacts();
  const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "promo" }) });
  fake.repos.get("promo").files[".cinder.yml"] = "deploy:\n  environments:\n    - { name: preview, from: change }\n    - { name: staging, branch: develop }\n    - { name: production, branch: main }\n  worker: wrangler.jsonc\n";
  const list = await (await call("/api/repos/promo/branch-deploys")).json();
  expect(list).toEqual([{ branch: "develop", environment: "staging" }, { branch: "main", environment: "production" }]);
  for (const p of list) expect(validateBranchDeploy(p).ok).toBe(true);
  expect((await call("/api/repos/nope/branch-deploys")).status).toBe(404);
});

it("each environment carries the count of Keystore secrets scoped to it", async () => {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake };
  const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), e);
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "env-secrets" }) });
  fake.repos.get("env-secrets").files[".cinder.yml"] = MANIFEST;
  const secret = (id, scope, environment) => env.DB.prepare("INSERT INTO keystore_secrets (id, name, kind, scope, repo, environment, owner, store_id, store_secret_id, store_secret_name, created_at) VALUES (?, ?, 'environment_secret', ?, 'env-secrets', ?, 'owner', 's', ?, ?, '2026-10-01T00:00:00Z')")
    .bind(id, id, scope, environment, id, id).run();
  await secret("ES_A", "environment", "production");
  await secret("ES_B", "environment", "production");
  await secret("ES_C", "repo", null);

  const list = await (await call("/api/repos/env-secrets/environments")).json();
  for (const item of list) expect(validateEnvironment(item)).toEqual({ ok: true, errors: [] });
  expect(list.map((x) => [x.name, x.secrets])).toEqual([["staging", 0], ["production", 2]]);
});

it("the environments response carries Server-Timing and reads each environment's state concurrently", async () => {
  const fake = fakeArtifacts();
  const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), { ...env, ARTIFACTS: fake });
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name: "env-fast" }) });
  Object.assign(fake.repos.get("env-fast").files, { ".cinder.yml": MANIFEST, "wrangler.jsonc": JSON.stringify({ name: "pulse" }) });
  // Each branch head and the wrangler config read is slow; count how many are in flight at once.
  let open = 0, most = 0;
  const slow = (fn) => async (...a) => { most = Math.max(most, ++open); await new Promise((r) => setTimeout(r, 20)); open--; return fn(...a); };
  const get = fake.get.bind(fake);
  fake.get = async (n) => {
    const cap = await get(n);
    return cap && { ...cap, log: slow(cap.log), readFile: (o) => (o.path === "wrangler.jsonc" ? slow(cap.readFile)(o) : cap.readFile(o)) };
  };
  const res = await call("/api/repos/env-fast/environments");
  expect(res.status).toBe(200);
  expect(res.headers.get("Server-Timing")).toMatch(/^manifest;dur=[\d.]+, state;dur=[\d.]+$/);
  expect((await res.json()).map((e) => e.console)).toEqual([0, 1].map(() => expect.stringContaining("pulse-")));
  // Both environments' heads and the Worker script name are read together, not one after another.
  expect(most).toBe(3);
});
