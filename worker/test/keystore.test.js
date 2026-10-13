import { env } from "cloudflare:workers";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { validateKeystore, validateKeystoreSecret, validateKeystoreUsage } from "../src/api/shapes.js";
import { syncEnvironment } from "../src/deploy.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { fakeCloudflare } from "./fakes/cloudflare.js";

const OWNER = `Bearer ${env.OWNER_TOKEN}`;
const artifacts = fakeArtifacts();
let cf;
// cf.env is read per call: a binding cinder added shows up on the next request, as after Cloudflare rolls the version.
const call = (path, body, auth = OWNER, method = body ? "POST" : "GET") =>
  worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: { Authorization: auth }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: artifacts, ...cf.env });

beforeEach(() => {
  cf = fakeCloudflare();
  vi.stubGlobal("fetch", cf.fetch);
});
afterEach(() => vi.unstubAllGlobals());

// A claimed, leased job (a flow job unless `kind` says otherwise) in `repo` for a fresh runner; returns that runner's bearer header.
async function flowJob(repo, job, payload = { flow: "release", trigger: "push" }, kind = "flow") {
  const { id: runner, token } = await (await call("/api/runners", { name: "lab", kinds: ["flow"] })).json();
  const { id: repoId } = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(repo).first();
  const lease = new Date(Date.now() + 60_000).toISOString();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, runner_id, lease_expires_at, created_at, payload) VALUES (?, ?, ?, 'claimed', ?, ?, ?, ?)")
    .bind(job, repoId, kind, runner, lease, new Date().toISOString(), JSON.stringify({ steps: [], ...payload })).run();
  return `Bearer ${token}`;
}

it("creating an environment secret stores only a reference, adds a binding, and a leased job receives the value; D1 has no ciphertext column", async () => {
  await call("/api/repos", { name: "ks-env" });
  const res = await call("/api/keystore", { name: "STRIPE_KEY", kind: "environment_secret", scope: "environment", repo: "ks-env", environment: "production", value: "sk_live_env_s3cret" });
  expect(res.status).toBe(201);
  const created = await res.json();
  expect(validateKeystoreSecret(created)).toEqual({ ok: true, errors: [] });

  // The value went to the Secrets Store; D1 holds only the reference.
  const row = await env.DB.prepare("SELECT * FROM keystore_secrets WHERE id = ?").bind(created.id).first();
  const [secretId, secret] = [...cf.secrets].find(([, s]) => s.value === "sk_live_env_s3cret");
  expect(row).toMatchObject({ store_id: "store1", store_secret_id: secretId, store_secret_name: secret.name });
  expect(JSON.stringify(row)).not.toContain("sk_live_env_s3cret");
  for (const table of ["keystore_secrets", "model_providers"]) {
    const { results } = await env.DB.prepare(`SELECT name FROM pragma_table_info('${table}')`).all();
    expect(results.map((c) => c.name)).not.toContain("ciphertext");
    expect(results.map((c) => c.name)).not.toContain("iv");
  }

  // One secrets_store_secret binding per secret on cinder-secrets; every other binding is inherited.
  expect(cf.bound).toContain(`KS_${created.id.replaceAll("-", "")}`);
  expect(cf.requests.every((r) => !r.body.includes("sk_live_env_s3cret") || r.url.endsWith("/secrets_store/stores/store1/secrets"))).toBe(true);

  const auth = await flowJob("ks-env", "ks-job-env", { flow: "deploy", environment: "production", trigger: "manual", ref: "main" });
  const read = await call("/api/work/jobs/ks-job-env/secrets/STRIPE_KEY", null, auth);
  expect([read.status, await read.json()]).toEqual([200, { value: "sk_live_env_s3cret" }]);
  const staging = await call("/api/work/jobs/ks-job-stg/secrets/STRIPE_KEY", null, await flowJob("ks-env", "ks-job-stg", { flow: "deploy", environment: "staging", trigger: "manual", ref: "main" }));
  expect(staging.status).toBe(404);
});

it("withholds an environment secret from a flow run of a change fork", async () => {
  await call("/api/repos", { name: "ks-fork" });
  await call("/api/keystore", { name: "PROD_KEY", kind: "environment_secret", scope: "environment", repo: "ks-fork", environment: "production", value: "prod-fork-s3cret" });
  const auth = await flowJob("ks-fork", "ks-job-fork", { flow: "deploy", environment: "production", trigger: "change", sha: "f1", fork: "ks-fork--c1" });
  const res = await call("/api/work/jobs/ks-job-fork/secrets/PROD_KEY", null, auth);
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("prod-fork-s3cret");
});

// A change fork run gets a `scope` secret only when it is marked forks; a withheld one 404s as a missing one does.
async function forkRunSees(scope) {
  const repo = `ks-fork-${scope}`;
  await call("/api/repos", { name: repo });
  await call("/api/keystore", { name: `HIDDEN_${scope}`, kind: "flow_secret", scope, repo, value: `${scope}-fork-s3cret` });
  await call("/api/keystore", { name: `SHARED_${scope}`, kind: "flow_secret", scope, repo, forks: true, value: `${scope}-shared-s3cret` });
  const auth = await flowJob(repo, `ks-job-fork-${scope}`, { flow: "ci", trigger: "change", sha: "f1", fork: `${repo}--c1` });
  const res = await call(`/api/work/jobs/ks-job-fork-${scope}/secrets/HIDDEN_${scope}`, null, auth);
  const missing = await call(`/api/work/jobs/ks-job-fork-${scope}/secrets/NO_SUCH_${scope}`, null, auth);
  expect(res.status).toBe(404);
  expect((await res.json()).error).toEqual({ ...(await missing.json()).error, message: `no secret HIDDEN_${scope} for this job` });
  const shared = await call(`/api/work/jobs/ks-job-fork-${scope}/secrets/SHARED_${scope}`, null, auth);
  expect([shared.status, await shared.json()]).toEqual([200, { value: `${scope}-shared-s3cret` }]);
}
it("withholds a repo secret from a change fork run", () => forkRunSees("repo"));
it("withholds a global secret from a change fork run", () => forkRunSees("global"));

it("withholds an environment secret from a manual run of an unprotected branch", async () => {
  await call("/api/repos", { name: "ks-branch" });
  await call("/api/keystore", { name: "PROD_KEY", kind: "environment_secret", scope: "environment", repo: "ks-branch", environment: "production", value: "prod-branch-s3cret" });
  const auth = await flowJob("ks-branch", "ks-job-branch", { flow: "deploy", environment: "production", trigger: "manual", sha: "b1", ref: "feature/x" });
  const res = await call("/api/work/jobs/ks-job-branch/secrets/PROD_KEY", null, auth);
  expect(res.status).toBe(404);
  expect(await res.text()).not.toContain("prod-branch-s3cret");
});

it("leak test: a job that echoes its secret has the value masked in its log, transcript, Workflow output and every API response", async () => {
  const value = "sk_live_l3ak/me+42";
  await call("/api/repos", { name: "ks-leak" });
  const { id } = await (await call("/api/keystore", { name: "LEAKY", kind: "environment_secret", scope: "environment", repo: "ks-leak", environment: "production", value })).json();
  const auth = await flowJob("ks-leak", "ks-job-leak", { flow: "deploy", environment: "production", trigger: "manual", ref: "main", steps: [{ name: "build", stage: "build" }, { name: "agent", stage: "build" }] });
  expect((await (await call("/api/work/jobs/ks-job-leak/secrets/LEAKY", null, auth)).json()).value).toBe(value);

  const forms = [value, btoa(value).replace(/=+$/, ""), encodeURIComponent(value)];
  const step = (name, logs) => worker.fetch(new Request("http://cinder.test/api/work/jobs/ks-job-leak/steps", { method: "POST", headers: { Authorization: auth },
    body: JSON.stringify({ name, status: "passed", logs }) }), { ...env, ARTIFACTS: artifacts, ...cf.env });
  // The job's log echoes the value raw, base64 and URL-encoded; its agent transcript quotes it inside JSON.
  expect((await step("build", `$ echo $LEAKY\n${forms.join("\n")}\n`)).status).toBe(204);
  expect((await step("agent", JSON.stringify([{ role: "tool", content: `LEAKY=${value}` }]))).status).toBe(204);
  const report = await call("/api/work/jobs/ks-job-leak/report", { status: "failed", detail: `deploy failed with ${value}`, blockers: [{ summary: `token ${value} rejected`, repro: "deploy" }] }, auth);

  const run = await (await call(`/api/repos/ks-leak/flow-runs/ks-job-leak`)).json();
  expect(run.steps.map((s) => s.logs)).toEqual(["$ echo $LEAKY\n***\n***\n***\n", JSON.stringify([{ role: "tool", content: "LEAKY=***" }])]);
  const responses = [report, ...await Promise.all([`/api/repos/ks-leak/flow-runs/ks-job-leak`, "/api/repos/ks-leak/flow-runs", "/api/keystore", `/api/keystore/${id}/audit`, "/api/keystore/usage"].map((p) => call(p))),
    await call("/api/work/jobs/ks-job-leak/secrets/NOPE", null, auth), await call(`/api/keystore/${id}/rotate`, { value: "short" })];
  for (const res of responses) {
    const text = await res.text();
    for (const f of forms) expect(text).not.toContain(f);
  }
});

it("agent sandboxes never get Keystore values at any scope", async () => {
  await call("/api/repos", { name: "ks-agent" });
  const scopes = [{ scope: "global" }, { scope: "repo", repo: "ks-agent" }, { scope: "environment", repo: "ks-agent", environment: "production" }, { scope: "flow", repo: "ks-agent", flow: "deploy" }];
  for (const [i, s] of scopes.entries()) expect((await call("/api/keystore", { name: `AGENT_${i}`, kind: "api_key", ...s, value: `agent-s3cret-${i}` })).status).toBe(201);
  for (const kind of ["develop", "resolve", "review"]) {
    const auth = await flowJob("ks-agent", `ks-job-${kind}`, { environment: "production", flow: "deploy" }, kind);
    for (const i of scopes.keys()) {
      const res = await call(`/api/work/jobs/ks-job-${kind}/secrets/AGENT_${i}`, null, auth);
      expect(res.status).toBe(403);
      expect(await res.text()).not.toContain("agent-s3cret");
    }
  }
});

it("a duplicate name in the same scope is blocked", async () => {
  await call("/api/repos", { name: "ks-dup" });
  const add = (body) => call("/api/keystore", { name: "DUP_KEY", kind: "environment_secret", scope: "environment", repo: "ks-dup", value: "dup-s3cret", ...body });
  expect((await add({ environment: "production" })).status).toBe(201);
  const stored = cf.secrets.size;
  const again = await add({ environment: "production" });
  expect(again.status).toBe(409);
  expect(cf.secrets.size).toBe(stored); // refused before anything reaches the Secrets Store
  const { results } = await env.DB.prepare("SELECT id FROM keystore_secrets WHERE name = 'DUP_KEY'").all();
  expect(results).toHaveLength(1);
  // The same name in another scope or target is a different secret.
  expect((await add({ environment: "staging" })).status).toBe(201);
  expect((await add({ scope: "repo" })).status).toBe(201);
});

it("create a repo-scoped secret; a flow in that repo reads it and another repo's flow can't", async () => {
  await call("/api/repos", { name: "ks-own" });
  await call("/api/repos", { name: "ks-other" });
  const res = await call("/api/keystore", { name: "NPM_TOKEN", kind: "flow_secret", scope: "repo", repo: "ks-own", owner: "ana@x.dev", value: "npm_s3cret" });
  expect(res.status).toBe(201);

  const own = await call("/api/work/jobs/ks-job-own/secrets/NPM_TOKEN", null, await flowJob("ks-own", "ks-job-own"));
  expect(own.status).toBe(200);
  expect(await own.json()).toEqual({ value: "npm_s3cret" });

  const other = await call("/api/work/jobs/ks-job-other/secrets/NPM_TOKEN", null, await flowJob("ks-other", "ks-job-other"));
  expect(other.status).toBe(404);
  expect(await other.text()).not.toContain("npm_s3cret");
});

it("creating a keystore secret calls the settings PATCH on cinder-secrets and never on cinder", async () => {
  const res = await call("/api/keystore", { name: "PATCH_TARGET", kind: "api_key", scope: "global", value: "patch-target-value" });
  expect(res.status).toBe(201);
  const patches = cf.requests.filter((r) => r.method === "PATCH" && r.url.includes("/workers/scripts/")).map((r) => r.url.split("/workers/scripts/")[1]);
  expect(patches).toEqual(["cinder-secrets/settings"]);
  expect(cf.requests.some((r) => r.url.includes("/workers/scripts/cinder/"))).toBe(false);
});

it("readJobSecret returns the value through the SECRETS service binding", async () => {
  await call("/api/repos", { name: "ks-svc" });
  const { id } = await (await call("/api/keystore", { name: "SVC_KEY", kind: "api_key", scope: "repo", repo: "ks-svc", value: "svc-bound-value" })).json();
  const auth = await flowJob("ks-svc", "ks-job-svc");
  const asked = [];
  const SECRETS = { read: async (name) => (asked.push(name), name === `KS_${id.replaceAll("-", "")}` ? "svc-bound-value" : null) };
  const res = await worker.fetch(new Request("http://cinder.test/api/work/jobs/ks-job-svc/secrets/SVC_KEY", { headers: { Authorization: auth } }),
    { ...env, ARTIFACTS: artifacts, ...cf.env, SECRETS });
  expect([res.status, await res.json()]).toEqual([200, { value: "svc-bound-value" }]);
  expect(asked).toEqual([`KS_${id.replaceAll("-", "")}`]);
});

it("the value is never returned by any GET; rotate replaces it, remove deletes it, and the audit records who and when", async () => {
  await call("/api/repos", { name: "ks-rot" });
  const created = await (await call("/api/keystore", { name: "DEPLOY", kind: "deploy_token", scope: "repo", repo: "ks-rot", owner: "ana@x.dev", value: "first-value" })).json();
  expect(validateKeystoreSecret(created)).toEqual({ ok: true, errors: [] });

  const rotated = await call(`/api/keystore/${created.id}/rotate`, { value: "second-value" });
  expect(rotated.status).toBe(200);
  expect((await rotated.json()).rotated_at).toEqual(expect.any(String));

  for (const path of ["/api/keystore", `/api/keystore/${created.id}/audit`]) {
    const text = await (await call(path)).text();
    expect(text).not.toMatch(/first-value|second-value/);
  }
  expect(validateKeystore(await (await call("/api/keystore")).json())).toEqual({ ok: true, errors: [] });

  const read = await call("/api/work/jobs/ks-job-rot/secrets/DEPLOY", null, await flowJob("ks-rot", "ks-job-rot"));
  expect(await read.json()).toEqual({ value: "second-value" });

  expect((await call(`/api/keystore/${created.id}`, null, OWNER, "DELETE")).status).toBe(204);
  expect([...cf.secrets.values()].map((s) => s.value)).not.toContain("second-value");
  expect(cf.bound).not.toContain(`KS_${created.id.replaceAll("-", "")}`);
  const log = await (await call(`/api/keystore/${created.id}/audit`)).json();
  expect(log.map((a) => a.action)).toEqual(["create", "rotate", "read", "remove"]);
  expect(log[1].actor).toBe("owner");
  expect(Object.keys(log[0])).toEqual(["action", "actor", "at"]);
});

it("Settings › Keystore usage counts the Secrets Store's secrets, and a new secret near the 100 cap is refused with no fallback", async () => {
  cf = fakeCloudflare({ used: 95 });
  vi.stubGlobal("fetch", cf.fetch);
  const usage = await (await call("/api/keystore/usage")).json();
  expect(usage).toEqual({ used: 95, limit: 100 });
  expect(validateKeystoreUsage(usage)).toEqual({ ok: true, errors: [] });
  const res = await call("/api/keystore", { name: "ONE_MORE", kind: "api_key", scope: "global", value: "one-more-value" });
  expect(res.status).toBe(409);
  expect((await res.json()).error.message).toMatch(/95 of its 100 secrets/);
  expect(await env.DB.prepare("SELECT 1 FROM keystore_secrets WHERE name = 'ONE_MORE'").first()).toBeNull();
});

it("usage for every secret is read in one query", async () => {
  cf = fakeCloudflare({ used: 7 });
  vi.stubGlobal("fetch", cf.fetch);
  const res = await call("/api/keystore/usage");
  expect(await res.json()).toEqual({ used: 7, limit: 100 });
  expect(cf.requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET https://api.cloudflare.com/client/v4/accounts/acct/secrets_store/quota"]);
  expect(res.headers.get("Server-Timing")).toMatch(/^secrets-store;dur=\d+$/);
});

it("without Secrets Store: Edit on cinder's token, adding, replacing and usage answer 503 naming the permission; nothing is stored", async () => {
  await call("/api/repos", { name: "ks-deny" });
  const { id } = await (await call("/api/keystore", { name: "BEFORE", kind: "api_key", scope: "repo", repo: "ks-deny", value: "before-value" })).json();
  cf = fakeCloudflare({ deny: ["/secrets_store"] });
  vi.stubGlobal("fetch", cf.fetch);
  for (const res of [await call("/api/keystore", { name: "DENIED", kind: "api_key", scope: "global", value: "denied-value" }),
    await call(`/api/keystore/${id}/rotate`, { value: "rotated-value" }), await call("/api/keystore/usage")]) {
    expect(res.status).toBe(503);
    expect((await res.json()).error.message).toBe("cinder's Cloudflare API token needs Secrets Store: Edit");
  }
  expect(await env.DB.prepare("SELECT 1 FROM keystore_secrets WHERE name = 'DENIED'").first()).toBeNull();
  expect(await env.DB.prepare("SELECT rotated_at FROM keystore_secrets WHERE id = ?").bind(id).first("rotated_at")).toBeNull();
});

// A flow job in `repo` whose step ship failed reporting AWS_KEY missing.
async function failedShip(repo, job) {
  await call("/api/repos", { name: repo });
  const auth = await flowJob(repo, job, { flow: "deploy", steps: [{ name: "ship", stage: "deploy" }] });
  expect((await call(`/api/work/jobs/${job}/steps`, { name: "ship", status: "failed", logs: "missing secret AWS_KEY\n", missing_secrets: ["AWS_KEY"] }, auth)).status).toBe(204);
}
const wantedIn = async (repo) => {
  const body = await (await call("/api/keystore")).json();
  expect(validateKeystore(body)).toEqual({ ok: true, errors: [] });
  return body.wanted.filter((w) => w.repo === repo);
};

it("a secret a failed step reported missing is listed as wanted with its run", async () => {
  await failedShip("ks-want", "ks-job-want");
  expect(await wantedIn("ks-want")).toEqual([{ name: "AWS_KEY", repo: "ks-want", flow: "deploy", step: "ship", run_id: "ks-job-want" }]);
});

it("a wanted secret drops off once it is saved", async () => {
  await failedShip("ks-saved", "ks-job-saved");
  expect(await wantedIn("ks-saved")).toHaveLength(1);
  expect((await call("/api/keystore", { name: "AWS_KEY", kind: "flow_secret", scope: "repo", repo: "ks-saved", value: "aws-s3cret-value" })).status).toBe(201);
  expect(await wantedIn("ks-saved")).toEqual([]);
});

it("adding an agent_secret answers 400", async () => {
  await env.DB.prepare("INSERT INTO keystore_secrets (id, name, kind, scope, owner, store_id, store_secret_id, store_secret_name, created_at) " +
    "VALUES ('ks-old-agent', 'OLD_AGENT_KEY', 'agent_secret', 'global', 'ana@x.dev', 's', 'i', 'n', '2026-10-01T00:00:00Z')").run();
  const res = await call("/api/keystore", { name: "AGENT_KEY", kind: "agent_secret", scope: "global", owner: "ana@x.dev", value: "agent-value" });
  expect(res.status).toBe(400);
  expect(cf.secrets.size).toBe(0);
  const { secrets } = await (await call("/api/keystore")).json();
  expect(secrets.map((s) => s.name)).toContain("OLD_AGENT_KEY");
  expect(secrets.map((s) => s.name)).not.toContain("AGENT_KEY");
});

it("rebind after deploy restores KS_ bindings before the first read", async () => {
  await call("/api/repos", { name: "ks-deploy" });
  await call("/api/keystore", { name: "DEPLOY_KEY", kind: "flow_secret", scope: "repo", repo: "ks-deploy", value: "deploy-s3cret" });
  // A wrangler deploy of cinder-secrets keeps only the bindings in its config.
  const form = new FormData();
  form.set("settings", new Blob([JSON.stringify({ bindings: [{ type: "d1", name: "DB" }] })]));
  await cf.fetch("https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/cinder-secrets/settings", { method: "PATCH", body: form });
  expect(cf.bound).toEqual([]);

  expect((await call("/api/keystore/rebind", null, OWNER, "POST")).status).toBe(204);
  const read = await call("/api/work/jobs/ks-job-deploy/secrets/DEPLOY_KEY", null, await flowJob("ks-deploy", "ks-job-deploy"));
  expect([read.status, await read.json()]).toEqual([200, { value: "deploy-s3cret" }]);
});

it("a deploy's secret read sets last_used", async () => {
  await call("/api/repos", { name: "ks-sync" });
  const { id } = await (await call("/api/keystore", { name: "SYNC_KEY", kind: "environment_secret", scope: "environment", repo: "ks-sync", environment: "production", value: "sync-s3cret" })).json();
  const repo = artifacts.repos.get("ks-sync");
  Object.assign(repo.files, {
    ".cinder.yml": "deploy:\n  environments:\n    - { name: production, branch: main, auto_sync: true, secrets: [SYNC_KEY] }\n  worker: wrangler.jsonc\n",
    "wrangler.jsonc": JSON.stringify({ name: "pulse", main: "src/index.js", compatibility_date: "2026-10-01" }),
    "src/index.js": "export default {};\n",
  });
  repo.commits.push({ sha: "7".repeat(40) });
  const step = { do: async (_, config, fn) => (fn ?? config)(), sleep: async () => {} };
  const upload = async () => Response.json({ result: { id: "v1" } });
  expect(await syncEnvironment({ ...env, ARTIFACTS: artifacts, ...cf.env }, "ks-sync", "main", "7".repeat(40), step, { id: "sync-ks" }, upload)).toBe("Synced");

  const { secrets } = await (await call("/api/keystore")).json();
  expect(secrets.find((s) => s.id === id).last_used).toBeTruthy();
  const rows = await (await call(`/api/keystore/${id}/audit`)).json();
  expect(rows.at(-1)).toMatchObject({ action: "read", actor: "sync:sync-ks" });
});

const HOUR_AGO = () => new Date(Date.now() - 3_600_000).toISOString(); // past the sweep's settle window

it("a save aborted after the Secrets Store write leaves no orphan once the next save runs", async () => {
  // The store write lands, then the request dies before the row is written.
  vi.stubGlobal("fetch", async (input, init) => {
    const res = await cf.fetch(input, init);
    if (init?.method === "POST" && String(input).endsWith("/secrets_store/stores/store1/secrets")) throw new Error("aborted");
    return res;
  });
  await expect(call("/api/keystore", { name: "ABORTED", kind: "api_key", scope: "global", value: "aborted-s3cret" })).rejects.toThrow("aborted");
  const [[orphanId, orphan]] = [...cf.secrets];
  orphan.created = HOUR_AGO();
  vi.stubGlobal("fetch", cf.fetch);
  expect((await call("/api/keystore", { name: "SAVED", kind: "api_key", scope: "global", value: "saved-s3cret" })).status).toBe(201);
  expect(cf.secrets.has(orphanId)).toBe(false);
  expect([...cf.secrets.values()].map((s) => s.value)).toEqual(["saved-s3cret"]);
});

it("the orphan sweep removes only cinder-created secrets with no row", async () => {
  expect((await call("/api/keystore", { name: "KEPT", kind: "api_key", scope: "global", value: "kept-s3cret" })).status).toBe(201);
  const seed = { orphan: "cinder_0a1b2c3d_0a1b_0a1b_0a1b_0a1b2c3d4e5f", key: "cinder_openai_p-0123456789abcdef", foreign: "stripe_live", infra: "cinder_merge_signing_key" };
  for (const [id, name] of Object.entries(seed)) cf.secrets.set(id, { name, value: "" });
  for (const s of cf.secrets.values()) s.created = HOUR_AGO();
  // One written a moment ago may belong to a save still writing its row.
  cf.secrets.set("young", { name: "cinder_9a1b2c3d_0a1b_0a1b_0a1b_0a1b2c3d4e5f", value: "", created: new Date().toISOString() });
  expect((await call("/api/keystore", { name: "NEXT", kind: "api_key", scope: "global", value: "next-s3cret" })).status).toBe(201);
  const left = [...cf.secrets.values()].map((s) => s.value || s.name);
  expect(left.sort()).toEqual(["cinder_9a1b2c3d_0a1b_0a1b_0a1b_0a1b2c3d4e5f", "cinder_merge_signing_key", "kept-s3cret", "next-s3cret", "stripe_live"]);
});
