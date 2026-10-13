import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cloudflare, parseDeploy, parseJsonc, planDeploy, reconcileResources, reconcileTriggers, syncEnvironment } from "../src/deploy.js";
import worker from "../src/index.js";
import { promote } from "../src/releases.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { applyMigrations } from "./helpers/migrations.js";
import wranglerRaw from "../wrangler.jsonc?raw";

describe("deploy module", () => {
  afterEach(() => vi.restoreAllMocks());

  it("refuses to run without the token and never logs it", async () => {
    const fetcher = vi.fn(async () => new Response("{}"));
    await expect(cloudflare({}, "/accounts/a/workers/scripts", {}, fetcher)).rejects.toThrow(/CF_DEPLOY_TOKEN is not set/);
    await expect(cloudflare({ CF_DEPLOY_TOKEN: "" }, "/x", {}, fetcher)).rejects.toThrow(/not set/);
    expect(fetcher).not.toHaveBeenCalled();

    const token = "secret-deploy-token";
    const logged = [];
    for (const m of ["log", "info", "warn", "error", "debug"]) vi.spyOn(console, m).mockImplementation((...a) => logged.push(a));
    const ok = vi.fn(async () => Response.json({ success: true }));
    expect(await cloudflare({ CF_DEPLOY_TOKEN: token }, "/accounts/a/d1/database", {}, ok)).toEqual({ success: true });
    expect(ok.mock.calls[0][1].headers.Authorization).toBe(`Bearer ${token}`);

    const failing = async () => new Response(`bad token ${token}`, { status: 403 });
    const err = await cloudflare({ CF_DEPLOY_TOKEN: token }, "/accounts/a/d1/database", { method: "POST" }, failing).catch((e) => e);
    expect(err.message).toMatch(/403/);
    expect(`${err.message}\n${err.stack}`).not.toContain(token);
    expect(JSON.stringify(logged)).not.toContain(token);
  });
});

const DESIGN_EXAMPLE = `deploy:
  environments:
    - { name: preview,    from: change }                 # every change gets a preview
    - { name: staging,    branch: develop, auto_sync: true }
    - { name: production, branch: main, auto_sync: true, gradual: [10, 50, 100], health: /healthz }
  worker: wrangler.jsonc                                  # the app's own Worker config
  resources:                                              # reconciled per environment
    - { type: d1,    name: pulse-db, migrations: migrations }
    - { type: kv,    name: pulse-cache }
    - { type: queue, name: pulse-checks }
    - { type: r2,    name: pulse-reports }
`;

describe("deploy manifest", () => {
  it("the DESIGN.md §9 example validates", () => {
    const d = parseDeploy(DESIGN_EXAMPLE);
    expect(d.environments[2]).toEqual({ name: "production", branch: "main", auto_sync: true, gradual: [10, 50, 100], health: "/healthz" });
    expect(d.environments[0]).toEqual({ name: "preview", from: "change" });
    expect(d.worker).toBe("wrangler.jsonc");
    expect(d.resources.map((r) => r.type)).toEqual(["d1", "kv", "queue", "r2"]);
    expect(d.resources[0].migrations).toBe("migrations");
  });

  it("gradual steps must rise and end at 100", () => {
    for (const bad of ["[50, 10, 100]", "[10, 50]", "[10, 10, 100]", "[]"]) {
      expect(() => parseDeploy(DESIGN_EXAMPLE.replace("[10, 50, 100]", bad))).toThrow("deploy.environments[2].gradual");
    }
  });

  it("bake is read as whole seconds", () => {
    expect(parseDeploy(DESIGN_EXAMPLE.replace("health:", "bake: 30, health:")).environments[2].bake).toBe(30);
    expect(() => parseDeploy(DESIGN_EXAMPLE.replace("health:", "bake: soon, health:"))).toThrow("deploy.environments[2].bake");
  });

  it("a wrangler.jsonc with comments and trailing commas parses", () => {
    const text = `{
      // the app's name
      "name": "pulse", /* block
      comment */ "main": "src/index.js",
      "routes": ["https://pulse.example/*", "a,]",],
      "vars": { "NOTE": "// not a comment", "Q": "say \\"hi\\"", },
    }`;
    expect(parseJsonc(text)).toEqual({
      name: "pulse", main: "src/index.js", routes: ["https://pulse.example/*", "a,]"], vars: { NOTE: "// not a comment", Q: 'say "hi"' },
    });
  });

  it("routes, custom_domain and crons are read per environment and rejected with their key path", () => {
    const keys = 'health: /healthz, routes: [{ pattern: "pulse.example/*", zone: z1 }], custom_domain: pulse.example, crons: ["*/5 * * * *"]';
    expect(parseDeploy(DESIGN_EXAMPLE.replace("health: /healthz", keys)).environments[2]).toMatchObject({
      routes: [{ pattern: "pulse.example/*", zone: "z1" }], custom_domain: "pulse.example", crons: ["*/5 * * * *"],
    });
    expect(() => parseDeploy(DESIGN_EXAMPLE.replace("health:", "routes: [{ pattern: x }], health:"))).toThrow("deploy.environments[2].routes");
    expect(() => parseDeploy(DESIGN_EXAMPLE.replace("health:", "custom_domain: [a], health:"))).toThrow("deploy.environments[2].custom_domain");
    expect(() => parseDeploy(DESIGN_EXAMPLE.replace("health:", "crons: \"@daily\", health:"))).toThrow("deploy.environments[2].crons");
  });

  it("per-target config names its credential as a Keystore secret only, and is rejected with its key path", () => {
    const with_ = (cfg) => parseDeploy(DESIGN_EXAMPLE.replace("health:", `${cfg}, health:`));
    expect(with_("target: AWS, aws: { secret: AWS_DEPLOY_KEY, region: eu-west-1, service: ecs, resource: billing }").environments[2].aws)
      .toEqual({ secret: "AWS_DEPLOY_KEY", region: "eu-west-1", service: "ecs", resource: "billing" });
    expect(() => with_("aws: { secret: \"AKIA/raw+key\", region: eu-west-1, service: ecs, resource: billing }")).toThrow("deploy.environments[2].aws.secret");
    expect(() => with_("aws: { role_arn: arn:aws:iam::1:role/x, secret: K, region: eu-west-1, service: ecs, resource: b }")).toThrow("deploy.environments[2].aws.role_arn");
    expect(() => with_("gcp: { provider: p, region: \"eu west\", service: run, name: n }")).toThrow("deploy.environments[2].gcp.region");
    expect(() => with_("azure: { subscription: s, resource_group: g, service: vm, app: a }")).toThrow("deploy.environments[2].azure.service");
    expect(() => with_("ssh: { host: h, user: u, key_secret: K, command: c, fingerprint: abc }")).toThrow("deploy.environments[2].ssh.fingerprint");
  });

  it("unknown resource type is rejected with its key path", () => {
    expect(() => parseDeploy(DESIGN_EXAMPLE.replace("type: queue", "type: s3"))).toThrow("deploy.resources[2].type");
  });
});

describe("resource reconcile", () => {
  beforeEach(() => applyMigrations(env));
  const cfEnv = { ...env, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
  const fakeCloudflare = () => vi.fn(async (url, init) => Response.json({ success: true, result: init.method === "POST" ? { uuid: `uuid-${JSON.parse(init.body).name}` } : null }));
  const manifest = (...resources) => ({ resources });

  it("a new d1 resource is created once and reused", async () => {
    const cf = fakeCloudflare();
    const deploy = manifest({ type: "d1", name: "pulse-db" });
    const first = await reconcileResources(cfEnv, "r1", deploy, "staging", {}, cf);
    const second = await reconcileResources(cfEnv, "r1", deploy, "staging", {}, cf);
    expect(cf).toHaveBeenCalledTimes(1);
    expect(cf.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/accounts/acct/d1/database");
    expect(JSON.parse(cf.mock.calls[0][1].body)).toEqual({ name: "pulse-db-staging" });
    expect(second).toEqual(first);
    expect(second).toEqual({ status: "Synced", drift: [], bindings: [{ name: "PULSE_DB", type: "d1", id: "uuid-pulse-db-staging" }] });
  });

  it("a removed resource shows as drift and isn't deleted without confirmation", async () => {
    const cf = fakeCloudflare();
    await reconcileResources(cfEnv, "r1", manifest({ type: "d1", name: "pulse-db" }), "staging", {}, cf);
    const out = await reconcileResources(cfEnv, "r1", manifest(), "staging", {}, cf);
    expect(out.status).toBe("OutOfSync");
    expect(out.drift).toEqual([{ type: "d1", name: "pulse-db", cf_id: "uuid-pulse-db-staging" }]);
    expect(cf.mock.calls.some(([, init]) => init.method === "DELETE")).toBe(false);

    const pruned = await reconcileResources(cfEnv, "r1", manifest(), "staging", { prune: true }, cf);
    expect(pruned.status).toBe("Synced");
    expect(cf.mock.calls.at(-1)[0]).toBe("https://api.cloudflare.com/client/v4/accounts/acct/d1/database/uuid-pulse-db-staging");
    expect(cf.mock.calls.at(-1)[1].method).toBe("DELETE");
    expect((await reconcileResources(cfEnv, "r1", manifest(), "staging", {}, cf)).drift).toEqual([]);
  });
});

describe("trigger reconcile", () => {
  beforeEach(() => applyMigrations(env));
  const cfEnv = { ...env, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };

  it("a declared custom domain is attached to the environment's script once", async () => {
    const cf = vi.fn(async () => Response.json({ success: true, result: { id: "dom1" } }));
    const target = { name: "production", custom_domain: "pulse.example" };
    await reconcileTriggers(cfEnv, "r1", target, "pulse-production", cf);
    await reconcileTriggers(cfEnv, "r1", target, "pulse-production", cf);
    expect(cf).toHaveBeenCalledTimes(1);
    expect(cf.mock.calls[0][0]).toBe("https://api.cloudflare.com/client/v4/accounts/acct/workers/domains");
    expect(cf.mock.calls[0][1].method).toBe("PUT");
    expect(JSON.parse(cf.mock.calls[0][1].body)).toEqual({ hostname: "pulse.example", service: "pulse-production" });
  });
});

describe("deploy secrets", () => {
  beforeEach(() => applyMigrations(env));

  it("a production deploy receives the secret scoped to production in Keystore", async () => {
    const repo = "ks-deploy";
    const fake = fakeArtifacts();
    Object.assign((await fake.create(repo)).files, {
      ".cinder.yml": "deploy:\n  environments:\n    - { name: production, branch: main, auto_sync: true, secrets: [STRIPE_KEY] }\n  worker: wrangler.jsonc\n",
      "wrangler.jsonc": JSON.stringify({ name: "pulse", main: "src/index.js", compatibility_date: "2026-10-01" }),
      "src/index.js": "export default {};\n",
    });
    fake.repos.get(repo).commits.push({ sha: "8".repeat(40) });
    const row = (id, scope, environment) => env.DB.prepare(`INSERT INTO keystore_secrets (id, name, kind, scope, repo, environment, owner, store_id, store_secret_id, store_secret_name, created_at)
      VALUES (?, 'STRIPE_KEY', 'environment_secret', ?, ?, ?, 'owner', 's', ?, ?, '2026-10-01T00:00:00Z')`).bind(id, scope, repo, environment, id, id).run();
    await row("ks-prod", "environment", "production");
    await row("ks-stg", "environment", "staging");
    await row("ks-repo", "repo", null);
    const SECRETS = { read: async (name) => ({ KS_ksprod: "sk_live_production", KS_ksstg: "sk_live_staging", KS_ksrepo: "sk_live_repo" })[name] ?? null };
    let metadata;
    const fetcher = async (url, init = {}) => {
      if (String(url).endsWith("/versions")) metadata = JSON.parse(init.body.get("metadata"));
      return Response.json({ result: { id: "v1" } });
    };
    const step = { do: async (_, config, fn) => (fn ?? config)(), sleep: async () => {} };
    const e = { ...env, ARTIFACTS: fake, SECRETS, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
    expect(await syncEnvironment(e, repo, "main", "8".repeat(40), step, {}, fetcher)).toBe("Synced");
    expect(metadata.bindings).toContainEqual({ type: "secret_text", name: "STRIPE_KEY", text: "sk_live_production" });
    expect(metadata.bindings.filter((b) => b.name === "STRIPE_KEY")).toHaveLength(1);
  });
});

describe("deploy targets", () => {
  beforeEach(() => applyMigrations(env));

  it("promoting to an AWS environment records it without a Worker upload", async () => {
    const repo = "aws-deploy";
    const sha = "9".repeat(40);
    const fake = fakeArtifacts();
    Object.assign((await fake.create(repo)).files, {
      ".cinder.yml": "deploy:\n  environments:\n    - { name: production, branch: main, auto_sync: true, target: AWS }\n  worker: wrangler.jsonc\n",
      "wrangler.jsonc": JSON.stringify({ name: "pulse", main: "src/index.js", compatibility_date: "2026-10-01" }),
      "src/index.js": "export default {};\n",
    });
    fake.repos.get(repo).commits.push({ sha });
    const fetcher = vi.fn(async () => Response.json({ result: { id: "v1" } }));
    const step = { do: async (_, config, fn) => (fn ?? config)(), sleep: async () => {} };
    const e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
    // A promote runs as a manual sync with the request's id (pipeline.js).
    expect(await syncEnvironment(e, repo, "main", sha, step, { manual: true, id: "promote-1", actor: "owner" }, fetcher)).toBe("OutOfSync");
    expect(fetcher).not.toHaveBeenCalled();
    const row = await env.DB.prepare("SELECT env, sha, status, actor, version_id FROM deploy_syncs WHERE id = 'promote-1'").first();
    expect(row).toEqual({ env: "production", sha, status: "OutOfSync", actor: "owner", version_id: null });
    expect(await env.DB.prepare("SELECT reason FROM deploy_sync_reasons WHERE sync_id = 'promote-1'").first("reason")).toMatch(/AWS/);
  });
});

describe("first deploy", () => {
  beforeEach(() => applyMigrations(env));
  const WORKER = { "wrangler.jsonc": JSON.stringify({ name: "web-store", main: "src/index.js", compatibility_date: "2026-10-01" }) };
  const MANIFEST = "deploy:\n  environments:\n    - { name: staging, branch: develop, auto_sync: true }\n  worker: wrangler.jsonc\n";

  it("the first deploy to an environment creates its Worker", async () => {
    const fake = fakeArtifacts();
    Object.assign((await fake.create("fd")).files, { ".cinder.yml": MANIFEST, ...WORKER, "src/index.js": "export default {};\n" });
    fake.repos.get("fd").commits.push({ sha: "1".repeat(40) });
    const step = { do: async (_, config, fn) => (fn ?? config)(), sleep: async () => {} };
    const e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
    const script = "https://api.cloudflare.com/client/v4/accounts/acct/workers/scripts/web-store-staging";
    // Cloudflare answers a version upload for an unknown script with 404 until the script exists.
    const cf = (putStatus) => {
      let exists = false;
      return vi.fn(async (url, init) => {
        if (url === script && init.method === "PUT") {
          exists = putStatus === 200;
          return Response.json({ errors: [{ code: 10000, message: "Authentication error" }] }, { status: putStatus });
        }
        if (url === `${script}/versions` && !exists) return Response.json({ errors: [{ code: 10007, message: "Worker does not exist" }] }, { status: 404 });
        return Response.json({ result: { id: "v1" } });
      });
    };
    const ok = cf(200);
    expect(await syncEnvironment(e, "fd", "develop", "1".repeat(40), step, {}, ok)).toBe("Synced");
    expect(ok.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      [`${script}/versions`, "POST"], [script, "PUT"], [`${script}/versions`, "POST"], [`${script}/subdomain`, "POST"], [`${script}/deployments`, "POST"],
    ]);
    // The new Worker answers on workers.dev, where its health path is probed.
    expect(JSON.parse(ok.mock.calls[3][1].body)).toEqual({ enabled: true, previews_enabled: false });
    expect(JSON.parse(ok.mock.calls[1][1].body.get("metadata")).main_module).toBe("src/index.js");

    await expect(syncEnvironment(e, "fd", "develop", "1".repeat(40), step, {}, cf(403))).rejects.toThrow(/token cannot create Worker web-store-staging/);
  });

  it("a sync's run shows Set up job, its rollout step and Complete job, each passed with its own log", async () => {
    const fake = fakeArtifacts();
    Object.assign((await fake.create("fdlog")).files, { ".cinder.yml": MANIFEST, ...WORKER, "src/index.js": "export default {};\n" });
    fake.repos.get("fdlog").commits.push({ sha: "2".repeat(40) });
    await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('id-fdlog', 'fdlog', 'develop', 'trunk', '{}', ?)").bind(new Date().toISOString()).run();
    const step = { do: async (_, config, fn) => (fn ?? config)(), sleep: async () => {} };
    const e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
    expect(await syncEnvironment(e, "fdlog", "develop", "2".repeat(40), step, {}, vi.fn(async () => Response.json({ result: { id: "v9" } })))).toBe("Synced");
    const id = await env.DB.prepare("SELECT id FROM flow_runs WHERE repo_id = 'id-fdlog'").first("id");
    const get = async (path) => (await worker.fetch(new Request(`https://cinder.test${path}`, { headers: { authorization: `Bearer ${env.OWNER_TOKEN}` } }), env, {})).json();
    const run = await get(`/api/repos/fdlog/flow-runs/${id}`);
    const steps = run.stages[0].jobs[0].steps;
    expect(steps.map((s) => [s.name, s.status])).toEqual([["Set up job", "passed"], ["deploy 100%", "passed"], ["Complete job", "passed"]]);
    expect(steps.every((s) => s.lines > 0)).toBe(true);
    const texts = async (idx) => (await get(`/api/repos/fdlog/flow-runs/${id}/jobs/${encodeURIComponent("rollout/deploy 100%")}/log?step=${idx}`)).lines.map((l) => l.text);
    const [setup, deploy, done] = await Promise.all(steps.map((s) => texts(s.idx)));
    expect(setup[0]).toMatch(/^sync 2222222 to staging/);
    expect(setup).toContain("uploaded version v9 of web-store-staging");
    expect(deploy[0]).toMatch(/^deployed: v9 at 100%/);
    expect(done).toEqual(["triggers reconciled; staging synced to 2222222"]);
  });

  const healthFails = async (repo) => {
    const fake = fakeArtifacts();
    Object.assign((await fake.create(repo)).files, { ".cinder.yml": "deploy:\n  environments:\n    - { name: production, branch: main, auto_sync: true, health: /health }\n  worker: wrangler.jsonc\n", ...WORKER, "src/index.js": "export default {};\n" });
    fake.repos.get(repo).commits.push({ sha: "3".repeat(40) });
    await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', ?)").bind(`id-${repo}`, repo, new Date().toISOString()).run();
    const step = { do: async (_, config, fn) => (fn ?? config)(), sleep: async () => {} };
    const e = { ...env, ARTIFACTS: fake, CF_DEPLOY_TOKEN: "t", CF_ACCOUNT_ID: "acct" };
    const cf = vi.fn(async (url) => (url.includes("workers.dev") ? new Response("down", { status: 503 }) : Response.json({ result: { id: "v9", subdomain: "acct" } })));
    expect(await syncEnvironment(e, repo, "main", "3".repeat(40), step, {}, cf)).toBe("Degraded");
    return async (path) => (await worker.fetch(new Request(`https://cinder.test${path}`, { headers: { authorization: `Bearer ${env.OWNER_TOKEN}` } }), e, {})).json();
  };

  it("an environment whose last sync rolled back on health shows that reason in its history", async () => {
    const get = await healthFails("fdhealth");
    const [prod] = await get("/api/repos/fdhealth/environments");
    expect(prod.history[0]).toMatchObject({ status: "Degraded", reason: "health check /health failed at 100%: 503; rolled back to nothing" });
  });

  it("a new sync's flow run shows its rollout step's status and log lines through the flow-run routes", async () => {
    const get = await healthFails("fdhealthrun");
    const id = await env.DB.prepare("SELECT id FROM flow_runs WHERE repo_id = 'id-fdhealthrun'").first("id");
    const run = await get(`/api/repos/fdhealthrun/flow-runs/${id}`);
    expect(run.status).toBe("failed");
    const deploy = run.stages[0].jobs[0].steps.find((s) => s.name === "deploy 100%");
    expect(deploy).toMatchObject({ status: "failed" });
    const { lines } = await get(`/api/repos/fdhealthrun/flow-runs/${id}/jobs/${encodeURIComponent("rollout/deploy 100%")}/log?step=${deploy.idx}`);
    expect(lines.length).toBe(deploy.lines);
    expect(lines.at(-1).text).toBe("##[error]health check /health failed at 100%: 503");
  });

  it("promoting a release with no entry point is refused with the missing path", async () => {
    const sha = "01ecdb08".padEnd(40, "0");
    const fake = fakeArtifacts();
    Object.assign((await fake.create("seeded")).files, { ".cinder.yml": MANIFEST, ...WORKER });
    await env.DB.batch([
      env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('sd', 'seeded', 'main', 'trunk', '{}', '2026-10-10T00:00:00Z')"),
      env.DB.prepare("INSERT INTO tags (repo, name, sha, message, tagger, created_at) VALUES ('seeded', 'v1.0.0', ?, 'v1.0.0', 'owner', '2026-10-10T00:00:00Z')").bind(sha),
      env.DB.prepare("INSERT INTO releases (id, repo, tag, title, state, author, created_at) VALUES ('rel1', 'seeded', 'v1.0.0', 'v1', 'published', 'owner', '2026-10-10T00:00:00Z')"),
    ]);
    const PIPELINE = { create: vi.fn() };
    const res = await promote({ ...env, ARTIFACTS: fake, PIPELINE }, "seeded", "staging", "rel1", "owner", false);
    expect(res.status).toBe(409);
    expect((await res.json()).error.message).toBe(`release v1.0.0 cannot deploy: src/index.js is missing at ${sha}`);
    expect(PIPELINE.create).not.toHaveBeenCalled();
  });
});

describe("deploy plan", () => {
  beforeEach(() => applyMigrations(env));
  afterEach(() => vi.restoreAllMocks());

  it("an unreadable plan records a readable review reason", async () => {
    const fake = fakeArtifacts();
    await fake.create("plan-repo");
    // The raw storage error a change page once showed as the review reason.
    const ARTIFACTS = { get: async (n) => ({ ...await fake.get(n), readFile: async () => { throw new Error("Invalid ref: ref required."); } }) };
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    const plan = await planDeploy({ ...env, ARTIFACTS }, "plan-repo", { id: "c1", fork: "plan-repo", head: "a".repeat(40), target_branch: "main" });
    expect(plan).toEqual({ destructive: "could not be read: the deploy files at the target branch or the change head are unavailable", environments: [] });
    expect(String(logged.mock.calls[0])).toMatch(/Invalid ref/);
  });
});

describe("wrangler config", () => {
  it("wrangler config turns off preview URLs", () => {
    expect(parseJsonc(wranglerRaw).preview_urls).toBe(false);
  });
});
