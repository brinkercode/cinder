import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { afterEach, expect, it, vi } from "vitest";
import worker, { PipelineWorkflow } from "../src/index.js";
import { validateEnvironment, validateFlowRunTree } from "../src/api/shapes.js";
import { syncEnvironment } from "../src/deploy.js";
import { fakeArtifacts } from "./fakes/artifacts.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };

// Same semantics as a Workflow step: step.do(name, [config], fn) retries fn config.retries.limit times; step.sleep
// advances the fake clock `now` instead of waiting.
function fakeStep() {
  const step = {
    now: 0,
    do: async (_, config, fn) => {
      for (let attempt = 0; ; attempt++) {
        try {
          return await (fn ?? config)();
        } catch (err) {
          if (!fn || attempt >= (config.retries?.limit ?? 0)) throw err;
        }
      }
    },
    sleep: async (_, ms) => { step.now += ms; },
  };
  return step;
}

afterEach(() => { vi.restoreAllMocks(); vi.useRealTimers(); });

const SYNC_FILES = {
  ".cinder.yml": "check: npm test\ndeploy:\n  environments:\n    - { name: production, branch: main, auto_sync: true, gradual: [10, 50, 100], health: /healthz }\n  worker: wrangler.jsonc\n  resources:\n    - { type: d1, name: pulse-db, migrations: migrations }\n",
  "wrangler.jsonc": JSON.stringify({ name: "pulse", main: "src/index.js", compatibility_date: "2026-10-01" }),
  "src/index.js": "export default { fetch: () => new Response('ok') };\n",
  "migrations/0001_init.sql": "CREATE TABLE t (id INTEGER);",
};

// main moves from 7… (synced as version v1) to 8…; the fake answers each Cloudflare call and the health probe.
async function branchAdvance(name, onHealth, step = fakeStep(), files = SYNC_FILES, analytics = []) {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
  Object.assign((await fake.create(name)).files, files);
  fake.repos.get(name).commits.push({ sha: "8".repeat(40) }, { sha: "7".repeat(40) });
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, ?, 'production', ?, 'v1', 'Synced', '[]', 'cinder-pipeline', ?, ?)")
    .bind(crypto.randomUUID(), name, "7".repeat(40), "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z").run();
  const cf = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith("/healthz")) return onHealth();
    if (u.endsWith("/graphql")) return Response.json({ data: { viewer: { accounts: [{ workersInvocationsAdaptive: analytics }] } } });
    if (u.endsWith("/query")) return Response.json({ result: [{ results: [] }] });
    if (u.endsWith("/d1/database")) return Response.json({ result: { uuid: "db1" } });
    if (u.endsWith("/versions")) return Response.json({ result: { id: "v2" } });
    return Response.json({ result: { subdomain: "acme" } });
  });
  await syncEnvironment(e, name, "main", "8".repeat(40), step);
  return cf;
}

const syncs = async (name) => (await env.DB.prepare("SELECT s.*, r.reason FROM deploy_syncs s LEFT JOIN deploy_sync_reasons r ON r.sync_id = s.id WHERE repo = ? ORDER BY started_at").bind(name).all()).results;

it("a branch advance walks the gradual steps when health passes", async () => {
  const cf = await branchAdvance("sync-steps", () => new Response("ok"));
  const calls = cf.mock.calls.map(([url, init]) => [String(url), init]);
  const queries = calls.filter(([u]) => u.endsWith("/query")).map(([, init]) => JSON.parse(init.body).sql);
  expect(queries).toContain(SYNC_FILES["migrations/0001_init.sql"]);
  const walk = calls.filter(([u]) => u.endsWith("/deployments") || u.endsWith("/healthz")).map(([u, init]) => (u.endsWith("/healthz")
    ? ["health", u, init.headers["Cloudflare-Workers-Version-Overrides"]]
    : JSON.parse(init.body).versions));
  const health = ["health", "https://pulse-production.acme.workers.dev/healthz", 'pulse-production="v2"'];
  expect(walk).toEqual([
    [{ version_id: "v2", percentage: 10 }, { version_id: "v1", percentage: 90 }], health,
    [{ version_id: "v2", percentage: 50 }, { version_id: "v1", percentage: 50 }], health,
    [{ version_id: "v2", percentage: 100 }], health,
  ]);
  // Migrations run before the version is uploaded.
  expect(calls.findIndex(([u]) => u.endsWith("/query"))).toBeLessThan(calls.findIndex(([u]) => u.endsWith("/versions")));
});

it("a sync all at once deploys at 100% without the gradual steps", async () => {
  const name = "sync-all";
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
  Object.assign((await fake.create(name)).files, SYNC_FILES);
  fake.repos.get(name).commits.push({ sha: "8".repeat(40) }, { sha: "7".repeat(40) });
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, ?, 'production', ?, 'v1', 'Synced', '[]', 'cinder-pipeline', ?, ?)")
    .bind(crypto.randomUUID(), name, "7".repeat(40), "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z").run();
  const cf = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => Response.json(String(url).endsWith("/versions") ? { result: { id: "v2" } }
    : String(url).endsWith("/d1/database") ? { result: { uuid: "db1" } } : String(url).endsWith("/query") ? { result: [{ results: [] }] } : { result: { subdomain: "acme" } }));
  const sync = crypto.randomUUID();
  await PipelineWorkflow.prototype.run.call({ env: e }, { payload: { sync, repo: name, branch: "main", sha: "8".repeat(40), actor: "owner", override: false, all: true } }, fakeStep());
  const walk = cf.mock.calls.filter(([u]) => String(u).endsWith("/deployments")).map(([, init]) => JSON.parse(init.body).versions);
  expect(walk).toEqual([[{ version_id: "v2", percentage: 100 }]]);
  expect((await syncs(name)).at(-1)).toMatchObject({ id: sync, status: "Synced" });
});

it("status is Progressing during the rollout and Synced at 100%", async () => {
  const seen = [];
  await branchAdvance("sync-status", async () => {
    seen.push((await syncs("sync-status")).at(-1).status);
    return new Response("ok");
  });
  expect(seen).toEqual(["Progressing", "Progressing", "Progressing"]);
  expect((await syncs("sync-status")).at(-1)).toMatchObject({
    env: "production", sha: "8".repeat(40), version_id: "v2", status: "Synced", changes: JSON.stringify(["8".repeat(40)]), actor: "cinder-pipeline",
  });
});

it("a health failure at 10% rolls back to the previous version", async () => {
  const cf = await branchAdvance("sync-rollback", () => new Response("down", { status: 503 }));
  const deploys = cf.mock.calls.filter(([u]) => String(u).endsWith("/deployments")).map(([, init]) => JSON.parse(init.body).versions);
  // The first attempt and 3 retries, then the rollback.
  expect(deploys).toEqual([
    ...Array(4).fill([{ version_id: "v2", percentage: 10 }, { version_id: "v1", percentage: 90 }]),
    [{ version_id: "v1", percentage: 100 }],
  ]);
  expect((await syncs("sync-rollback")).at(-1)).toMatchObject({
    version_id: "v2", status: "Degraded", reason: "health check /healthz failed at 10%: 503; rolled back to v1",
  });
});

it("a probe that fails once and then passes does not roll back", async () => {
  let probes = 0;
  const cf = await branchAdvance("sync-probe-retry", () => new Response("", { status: ++probes === 1 ? 503 : 200 }));
  const deploys = cf.mock.calls.filter(([u]) => String(u).endsWith("/deployments")).map(([, init]) => JSON.parse(init.body).versions[0].percentage);
  expect(deploys).toEqual([10, 10, 50, 100]);
  expect((await syncs("sync-probe-retry")).at(-1)).toMatchObject({ status: "Synced", reason: null });
});

it("a sync with an unset declared secret fails naming it", async () => {
  const files = { ...SYNC_FILES, ".cinder.yml": SYNC_FILES[".cinder.yml"].replace("health:", "secrets: [STRIPE_KEY, MAIL_KEY], health:") };
  await env.DB.prepare(`INSERT INTO keystore_secrets (id, name, kind, scope, repo, environment, owner, store_id, store_secret_id, store_secret_name, created_at)
    VALUES ('ks-sync', 'STRIPE_KEY', 'environment_secret', 'environment', 'sync-secrets', 'production', 'owner', 's', 'x', 'x', '2026-10-01T00:00:00Z')`).run();
  const err = await branchAdvance("sync-secrets", () => new Response("ok"), fakeStep(), files).catch((e) => e);
  expect(err.message).toBe("deploy: unset secrets MAIL_KEY in production");
  expect((await syncs("sync-secrets")).at(-1)).toMatchObject({ sha: "8".repeat(40), status: "Failed" });
});

it("the bake time is honoured between steps (fake clock)", async () => {
  const step = fakeStep();
  const probedAt = [];
  const files = { ...SYNC_FILES, ".cinder.yml": SYNC_FILES[".cinder.yml"].replace("health:", "bake: 30, health:") };
  await branchAdvance("sync-bake", () => { probedAt.push(step.now); return new Response("ok"); }, step, files);
  expect(probedAt).toEqual([0, 30_000, 60_000]);
});

const GATED_FILES = { ...SYNC_FILES, ".cinder.yml": SYNC_FILES[".cinder.yml"].replace("health:", "max_error_rate: 0.02, health:") };

it("a 5% error rate over a 2% limit rolls back and records the reason", async () => {
  const cf = await branchAdvance("sync-error-rate", () => new Response("ok"), fakeStep(), GATED_FILES, [{ sum: { requests: 200, errors: 10 } }]);
  const query = cf.mock.calls.find(([u]) => String(u).endsWith("/graphql"));
  expect(JSON.parse(query[1].body).variables).toMatchObject({ account: "acct", script: "pulse-production", version: "v2" });
  const deploys = cf.mock.calls.filter(([u]) => String(u).endsWith("/deployments")).map(([, init]) => JSON.parse(init.body).versions);
  expect(deploys).toEqual([
    [{ version_id: "v2", percentage: 10 }, { version_id: "v1", percentage: 90 }],
    [{ version_id: "v1", percentage: 100 }],
  ]);
  expect((await syncs("sync-error-rate")).at(-1)).toMatchObject({
    status: "Degraded", reason: "error rate 0.05 over 0.02 before 50%; rolled back to v1",
  });
});

it("zero requests passes with \"no traffic\" recorded", async () => {
  await branchAdvance("sync-no-traffic", () => new Response("ok"), fakeStep(), GATED_FILES, []);
  expect((await syncs("sync-no-traffic")).at(-1)).toMatchObject({
    status: "Synced", reason: "no traffic in the bake before 50%; error rate gate passed; no traffic in the bake before 100%; error rate gate passed",
  });
});

it("manual rollback records who and why", async () => {
  await branchAdvance("manual-rollback", () => new Response("ok"));
  const fake = fakeArtifacts();
  Object.assign((await fake.create("manual-rollback")).files, SYNC_FILES);
  const cf = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ result: {} }));
  const res = await worker.fetch(new Request("http://cinder.test/api/repos/manual-rollback/environments/production/rollback", {
    method: "POST", headers: OWNER, body: JSON.stringify({ reason: "checkout errors spiking" }),
  }), { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" });
  expect(res.status).toBe(202);
  const [url, init] = cf.mock.calls.at(-1);
  expect(String(url)).toBe("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/pulse-production/deployments");
  expect(JSON.parse(init.body).versions).toEqual([{ version_id: "v1", percentage: 100 }]);
  const rows = await syncs("manual-rollback");
  expect(rows.at(-2)).toMatchObject({ version_id: "v2", status: "Degraded", reason: "checkout errors spiking" });
  expect(rows.at(-1)).toMatchObject({ sha: "7".repeat(40), version_id: "v1", status: "Synced", actor: "owner", reason: "checkout errors spiking" });
  expect(await res.json()).toEqual({ name: "production", id: rows.at(-1).id });
});

// main moves from 7… (synced as v1) to log (the changes' heads unless given) with the given reviews; Cloudflare and health are faked.
async function deployOfChanges(name, review, heads, log = heads, files = SYNC_FILES) {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
  const post = async (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: OWNER, body: JSON.stringify(body) }), e);
  await post("/api/repos", { name });
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const ids = [];
  for (const head of heads) {
    const { id } = await (await post(`/api/repos/${name}/changes`, { intent: "x" })).json();
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).setReview(review);
    await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?, ?)").bind(id, head).run();
    ids.push(id);
  }
  Object.assign(fake.repos.get(name).files, files);
  fake.repos.get(name).commits.push(...log.map((sha) => ({ sha })), { sha: "7".repeat(40) });
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, ?, 'production', ?, 'v1', 'Synced', '[]', 'cinder-pipeline', ?, ?)")
    .bind(crypto.randomUUID(), name, "7".repeat(40), "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z").run();
  const cf = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith("/query")) return Response.json({ result: [{ results: [] }] });
    if (u.endsWith("/d1/database")) return Response.json({ result: { uuid: "db1" } });
    if (u.endsWith("/versions")) return Response.json({ result: { id: "v2" } });
    return Response.json({ result: { subdomain: "acme" } });
  });
  await syncEnvironment(e, name, "main", log[0], fakeStep());
  return { e, post, ids, cf };
}

// POSTs a manual sync with a fake PIPELINE binding, then runs the Workflow instance it would have started.
async function manualSync(e, name, environment, body) {
  let created;
  const PIPELINE = { create: async (opts) => { created = opts; return { id: opts.id }; } };
  const res = await worker.fetch(new Request(`http://cinder.test/api/repos/${name}/environments/${environment}/sync`, { method: "POST", headers: OWNER, body: body && JSON.stringify(body) }), { ...e, PIPELINE });
  if (created) await PipelineWorkflow.prototype.run.call({ env: e }, { payload: created.params }, fakeStep());
  return { res, created };
}

it("a rollback adds outcomes for each included change", async () => {
  const { post, ids } = await deployOfChanges("risk-rollback", { route: "auto", reason: "risk low, judge trusted", p: 0.1, trusted: true }, ["a".repeat(40), "b".repeat(40)]);
  expect((await syncs("risk-rollback")).at(-1).status).toBe("Synced");
  for (const id of ids) expect((await post(`/api/changes/${id}/review`, { verdict: "approve" })).status).toBe(200);
  expect((await post("/api/repos/risk-rollback/environments/production/rollback", { reason: "errors spiking" })).status).toBe(202);
  const { results } = await env.DB.prepare("SELECT j.change_id, o.actual FROM judgments j JOIN outcomes o ON o.judgment_id = j.id WHERE j.kind = 'risk' AND j.change_id IN (?, ?) ORDER BY j.change_id")
    .bind(...ids).all();
  expect(results).toEqual(ids.toSorted().map((change_id) => ({ change_id, actual: "yes" })));
});

it("a squash-merged change is found by its merged sha and gets the rollback outcome", async () => {
  const squash = "c".repeat(40);
  const { e, post, ids: [id] } = await deployOfChanges("risk-squash", { route: "auto", reason: "risk low, judge trusted", p: 0.1, trusted: true }, ["f".repeat(40)], [squash]);
  expect((await post(`/api/changes/${id}/review`, { verdict: "approve" })).status).toBe(200);
  // The change's merge job reports the squash commit, which is not its head.
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
  await stub.stageEvent({ kind: "pushed", actor: { type: "system", id: "test" }, action: "change.push", target: id, result: "ok" }, { head: "f".repeat(40) });
  for (const s of ["leased", "developing", "verifying", "in_queue"]) await stub.transition(s, {
    kind: s, actor: { type: "system", id: "test" }, action: "change.lease", target: id, result: "ok",
  });
  const { repo_id, fork } = await stub.get();
  // The fork descends from the target's head, else the claim sends the change back to converge.
  e.ARTIFACTS.repos.get(fork).commits.push(...e.ARTIFACTS.repos.get("risk-squash").commits);
  await env.DB.prepare("INSERT INTO queue_entries (change_id, repo_id, target_branch, enqueued_at) VALUES (?, ?, 'main', ?)").bind(id, repo_id, new Date().toISOString()).run();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'merge', ?, 'queued', ?, '{}')")
    .bind(crypto.randomUUID(), repo_id, id, new Date().toISOString()).run();
  const runner = (await (await post("/api/runners", { name: "lab", kinds: ["merge"] })).json()).token;
  const work = (path, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers: { Authorization: `Bearer ${runner}` }, body: JSON.stringify(body) }), e);
  const merge = await (await work("/api/work/claim", { kinds: ["merge"] })).json();
  expect(merge.change.id).toBe(id);
  expect((await (await work(`/api/work/jobs/${merge.job.id}/report`, { status: "done", merged_sha: squash })).json()).change.state).toBe("merged");
  expect((await post("/api/repos/risk-squash/environments/production/rollback", { reason: "errors spiking" })).status).toBe(202);
  const { results } = await env.DB.prepare("SELECT o.actual FROM judgments j JOIN outcomes o ON o.judgment_id = j.id WHERE j.kind = 'risk' AND j.change_id = ?").bind(id).all();
  expect(results).toEqual([{ actual: "yes" }]);
});

it("a high-risk change pauses for approval before production", async () => {
  const { e, cf } = await deployOfChanges("risk-hold", { route: "human", reason: "risk high", p: 0.9, trusted: true }, ["c".repeat(40), "d".repeat(40)]);
  const deploys = () => cf.mock.calls.filter(([u]) => String(u).endsWith("/deployments")).map(([, init]) => JSON.parse(init.body).versions[0].percentage);
  expect(deploys()).toEqual([]);
  expect((await syncs("risk-hold")).at(-1)).toMatchObject({ status: "OutOfSync", reason: "awaiting a person's approval: high risk" });

  // A person's sync is the approval; the rollout then starts with a 1% canary.
  expect((await manualSync(e, "risk-hold", "production")).res.status).toBe(202);
  expect(deploys()).toEqual([1, 10, 50, 100]);
});

it("approving a held sync syncs the environment and records the person", async () => {
  const { e } = await deployOfChanges("inbox-approve", { route: "human", reason: "risk high", p: 0.9, trusted: true }, ["9".repeat(40)]);
  const { res, created } = await manualSync(e, "inbox-approve", "production");
  expect(res.status).toBe(202);
  expect(created.params.actor).toBe("owner");
  expect((await syncs("inbox-approve")).at(-1)).toMatchObject({ status: "Synced", actor: "owner" });
});

it("a manual sync returns 202 and the workflow ends Synced", async () => {
  const { e } = await deployOfChanges("manual-sync", { route: "human", reason: "risk high", p: 0.9, trusted: true }, ["e".repeat(40)]);
  const { res, created } = await manualSync(e, "manual-sync", "production");
  expect(res.status).toBe(202);
  const { id } = await res.json();
  expect(created).toMatchObject({ id, params: { sync: id, repo: "manual-sync", branch: "main", sha: "e".repeat(40) } });
  expect((await syncs("manual-sync")).at(-1)).toMatchObject({ id, status: "Synced", actor: "owner" });
});

// Production frozen Fri 17:00-Mon 09:00 Chicago time; the fake clock is Friday 18:00 there.
const FROZEN_FILES = { ...SYNC_FILES, ".cinder.yml": SYNC_FILES[".cinder.yml"].replace("health: /healthz }", 'health: /healthz, windows: [{deny: "Fri 17:00-Mon 09:00", tz: America/Chicago}] }') };
const freeze = () => { vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-10-09T23:00:00Z")); };

it("an auto-sync inside a deny window is held with that reason", async () => {
  freeze();
  const cf = await branchAdvance("window-held", () => new Response("ok"), fakeStep(), FROZEN_FILES);
  expect(cf.mock.calls.filter(([u]) => String(u).endsWith("/deployments"))).toEqual([]);
  expect((await syncs("window-held")).at(-1)).toMatchObject({ sha: "8".repeat(40), status: "OutOfSync", actor: "cinder-pipeline", reason: "sync window" });
});

it("a manual sync with override deploys and records the override", async () => {
  freeze();
  const { e, cf } = await deployOfChanges("window-override", { route: "auto", reason: "risk low, judge trusted", p: 0.1, trusted: true }, ["f".repeat(40)], undefined, FROZEN_FILES);
  const deploys = () => cf.mock.calls.filter(([u]) => String(u).endsWith("/deployments"));
  expect((await syncs("window-override")).at(-1)).toMatchObject({ status: "OutOfSync", reason: "sync window" });

  // Without override a manual sync is held too.
  await manualSync(e, "window-override", "production");
  expect(deploys()).toEqual([]);
  expect((await syncs("window-override")).at(-1)).toMatchObject({ status: "OutOfSync", actor: "owner", reason: "sync window" });

  const { res } = await manualSync(e, "window-override", "production", { override: true });
  expect(res.status).toBe(202);
  expect(deploys().length).toBeGreaterThan(0);
  expect((await syncs("window-override")).at(-1)).toMatchObject({ id: (await res.json()).id, status: "Synced", actor: "owner", reason: "sync window overridden by owner" });
});

it("a declared cron is set on the environment's script", async () => {
  const yml = SYNC_FILES[".cinder.yml"].replace("health: /healthz", 'health: /healthz, crons: ["0,30 * * * *", "@daily"]');
  const cf = await branchAdvance("sync-cron", () => new Response("ok"), fakeStep(), { ...SYNC_FILES, ".cinder.yml": yml });
  const put = cf.mock.calls.find(([url]) => String(url).endsWith("/workers/scripts/pulse-production/schedules"));
  expect(put[1].method).toBe("PUT");
  expect(JSON.parse(put[1].body)).toEqual([{ cron: "0,30 * * * *" }, { cron: "@daily" }]);
  const tagged = await env.DB.prepare("SELECT name, cf_id FROM deploy_resources WHERE repo = 'sync-cron' AND type = 'cron' ORDER BY name").all();
  expect(tagged.results).toEqual([{ name: "0,30 * * * *", cf_id: "pulse-production" }, { name: "@daily", cf_id: "pulse-production" }]);
});

// A registered repo whose production (main, auto_sync) runs v1 at 7…; merge() moves main to 8… and runs the pipeline.
async function gitopsRepo(name) {
  const fake = fakeArtifacts();
  const e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
  const call = async (path, init = {}) => (await worker.fetch(new Request(`http://cinder.test${path}`, { headers: OWNER, ...init }), e)).json().catch(() => null);
  await call("/api/repos", { method: "POST", body: JSON.stringify({ name }) });
  Object.assign(fake.repos.get(name).files, SYNC_FILES);
  fake.repos.get(name).commits.push({ sha: "7".repeat(40) });
  await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, ?, 'production', ?, 'v1', 'Synced', '[]', 'cinder-pipeline', ?, ?)")
    .bind(crypto.randomUUID(), name, "7".repeat(40), "2026-10-01T00:00:00Z", "2026-10-01T00:00:00Z").run();
  const cf = vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
    const u = String(url);
    if (u.endsWith("/query")) return Response.json({ result: [{ results: [] }] });
    if (u.endsWith("/d1/database")) return Response.json({ result: { uuid: "db1" } });
    if (u.endsWith("/versions")) return Response.json({ result: { id: "v2" } });
    return u.endsWith("/healthz") ? new Response("ok") : Response.json({ result: { subdomain: "acme" } });
  });
  const merge = async () => {
    fake.repos.get(name).commits.unshift({ sha: "8".repeat(40) });
    const production = async () => (await call(`/api/repos/${name}/environments`)).find((x) => x.name === "production");
    const before = await production();
    await syncEnvironment(e, name, "main", "8".repeat(40), fakeStep());
    return { before, after: await production() };
  };
  return { call, cf, merge };
}

it("a merge to the tracked branch shows OutOfSync and auto-sync runs the deploy flow to Synced", async () => {
  const { call, merge } = await gitopsRepo("gitops-merge");
  const { before, after } = await merge();
  expect(validateEnvironment(before)).toEqual({ ok: true, errors: [] });
  expect(before).toMatchObject({ status: "OutOfSync", desired_sha: "8".repeat(40), live_version: { version_id: "v1", sha: "7".repeat(40) } });
  expect(validateEnvironment(after)).toEqual({ ok: true, errors: [] });
  expect(after).toMatchObject({ status: "Synced", desired_sha: "8".repeat(40), live_version: { version_id: "v2", sha: "8".repeat(40) } });
  const run = await call(`/api/repos/gitops-merge/flow-runs/${after.history[0].run}`);
  expect(validateFlowRunTree(run)).toEqual({ ok: true, errors: [] });
  expect(run).toMatchObject({ flow: "deploy-production", sha: "8".repeat(40), status: "passed" });
  expect(run.steps.map((s) => [s.name, s.stage, s.status])).toEqual([
    ["deploy 10%", "rollout", "passed"], ["deploy 50%", "rollout", "passed"], ["deploy 100%", "rollout", "passed"],
  ]);
});

it("rollback redeploys the previous release and records it in history", async () => {
  const { call, cf, merge } = await gitopsRepo("gitops-rollback");
  await merge();
  await call("/api/repos/gitops-rollback/environments/production/rollback", { method: "POST", body: JSON.stringify({ reason: "bad release" }) });
  const [url, init] = cf.mock.calls.at(-1);
  expect(String(url)).toBe("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/pulse-production/deployments");
  expect(JSON.parse(init.body).versions).toEqual([{ version_id: "v1", percentage: 100 }]);
  const production = (await call("/api/repos/gitops-rollback/environments")).find((x) => x.name === "production");
  expect(validateEnvironment(production)).toEqual({ ok: true, errors: [] });
  expect(production.history.map((h) => [h.sha[0], h.version_id, h.status, h.actor])).toEqual([
    ["7", "v1", "Synced", "owner"], ["8", "v2", "Degraded", "cinder-pipeline"], ["7", "v1", "Synced", "cinder-pipeline"],
  ]);
  const run = await call(`/api/repos/gitops-rollback/flow-runs/${production.history[0].run}`);
  expect(run).toMatchObject({ flow: "deploy-production", sha: "7".repeat(40), status: "passed", steps: [{ name: "deploy 100%", status: "passed" }] });
});
