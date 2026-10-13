import { env, runInDurableObject } from "cloudflare:test";
import { exports } from "cloudflare:workers";
import { afterEach, describe, expect, it, onTestFinished, vi } from "vitest";
import { JOB_KINDS } from "../src/api/contract.js";
import verifyGo from "../../runner/cmd/cinder-verify/main.go?raw";
import clientGo from "../../runner/internal/api/client.go?raw";
import workJs from "../src/work.js?raw";
import policyJs from "../src/policy.js?raw";
import { commit } from "../src/git/index.js";
import { parseDeploy } from "../src/deploy.js";
import worker from "../src/index.js";
import { isAllowedTarget, parsePolicy } from "../src/policy.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { bareRepo, git } from "./fakes/bare-repo.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const GITFLOW = `# .cinder.yml
branches:
  integration: [develop, main]   # gitflow
  release: ["release/*"]
  promote:
    - { from: develop, to: main }
check: npm test
stack: code@v1
`;

describe("branch policy", () => {
  it("gitflow policy allows develop and main, rejects feature/x as a target", () => {
    const policy = parsePolicy(GITFLOW, "main");
    expect(policy).toEqual({
      integration: ["develop", "main"], release: ["release/*"],
      check: "npm test", defaulted: false, sources: { integration: "repo", release: "repo", check: "repo", rules: "default" },
      rules: [{ branch: "develop", queue: true, judges: 1, risk: 10, route: [] }, { branch: "main", queue: true, judges: 1, risk: 10, route: [] }],
    });
    expect(isAllowedTarget(policy, "develop")).toBe(true);
    expect(isAllowedTarget(policy, "main")).toBe(true);
    expect(isAllowedTarget(policy, "feature/x")).toBe(false);
  });

  it("a .cinder.yml with branches.promote still parses and ignores it", () => {
    const policy = parsePolicy(GITFLOW, "main");
    expect(policy).not.toHaveProperty("promote");
    expect(policy.sources).not.toHaveProperty("promote");
  });

  it("policy ignores stack and routing", () => {
    const policy = parsePolicy("stack: code@v1\nrouting: anything\n", "main");
    expect(policy).not.toHaveProperty("stack");
    expect(policy).not.toHaveProperty("routing");
  });

  it("release glob release/* allows release/2.1", () => {
    const policy = parsePolicy("branches:\n  release:\n    - release/*\n", "main");
    expect(isAllowedTarget(policy, "release/2.1")).toBe(true);
    expect(isAllowedTarget(policy, "release/2.1/hotfix")).toBe(false);
    expect(isAllowedTarget(policy, "main")).toBe(true);
  });

  it("missing file yields defaults and records that it did", async () => {
    const fake = fakeArtifacts();
    await fake.create("app");
    const stub = env.REPO_DO.get(env.REPO_DO.idFromName("app"));
    const policy = (branch) => runInDurableObject(stub, (instance) => {
      instance.env = { ...instance.env, ARTIFACTS: fake };
      return instance.policy("app", branch);
    });
    const defaults = { integration: ["trunk"], release: [], check: "make check", defaulted: true, base_sha: null,
      sources: { integration: "default", release: "default", check: "default", rules: "default" },
      rules: [{ branch: "trunk", queue: true, judges: 1, risk: 10, route: [] }] };
    expect(await policy("trunk")).toEqual(defaults);
    expect(await policy("trunk")).toEqual(defaults);
    expect(fake.calls.filter((c) => c.method === "readFile")).toHaveLength(1);

    // Default branch moves: the cached policy is refreshed.
    fake.repos.get("app").files[".cinder.yml"] = GITFLOW;
    fake.repos.get("app").commits.unshift({ sha: "c2" });
    expect(await policy("trunk")).toMatchObject({ integration: ["develop", "main"], defaulted: false });
  });
});

describe("policy api", () => {
  const putPolicy = async (name, body) => {
    await env.DB.prepare("INSERT OR IGNORE INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', ?)")
      .bind(`id-${name}`, name, new Date().toISOString()).run();
    return exports.default.fetch(`http://cinder.test/api/repos/${name}/policy`, {
      method: "PUT", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: JSON.stringify(body),
    });
  };

  it("an invalid policy returns 422 naming the key", async () => {
    const res = await putPolicy("bad-app", { integration: [], release: [], promote: [], check: "make check", stack: "code@v1" });
    expect(res.status).toBe(422);
    expect((await res.json()).error.message).toContain("integration");
    expect((await env.DB.prepare("SELECT 1 FROM jobs WHERE repo_id = 'id-bad-app'").all()).results).toHaveLength(0);
  });

  it("PUT …/policy returns 422 for judges: 5, for risk: 0, and for a rule whose branch isn't in integration", async () => {
    const rule = { branch: "main", queue: true, judges: 1, risk: 10, route: [] };
    for (const [bad, message] of [[{ judges: 5 }, "rules.main.judges"], [{ risk: 0 }, "rules.main.risk"], [{ branch: "dev" }, "rules.dev: branch must be in integration"]]) {
      const res = await putPolicy("bad-rules", { rules: [{ ...rule, ...bad }] });
      expect(res.status).toBe(422);
      expect((await res.json()).error).toMatchObject({ code: "invalid_policy", message: expect.stringContaining(message) });
    }
  });

  it("a YAML syntax error answers 422 with the line", async () => {
    const fake = fakeArtifacts();
    await fake.create("broken-yml");
    fake.repos.get("broken-yml").files[".cinder.yml"] = "check: make check\nbranches:\n  integration: [develop, main\n";
    await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('id-broken-yml', 'broken-yml', 'main', 'trunk', '{}', ?)")
      .bind(new Date().toISOString()).run();
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("broken-yml")), (instance) => { instance.env = { ...instance.env, ARTIFACTS: fake }; });
    const res = await exports.default.fetch("http://cinder.test/api/repos/broken-yml/policy", { headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` } });
    expect(res.status).toBe(422);
    expect((await res.json()).error).toMatchObject({ code: "invalid_policy", message: '.cinder.yml: yaml: line 3: unclosed "["' });
  });
});

it("no 'policy' job kind remains in the contract, worker or runner", () => {
  expect(JOB_KINDS).not.toContain("policy");
  for (const src of [workJs, policyJs, clientGo, verifyGo]) expect(src).not.toContain('"policy"');
});

describe("global and per-repo policy", () => {
  const fake = fakeArtifacts();
  const call = (path, method = "GET", body) => exports.default.fetch(`http://cinder.test${path}`,
    { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) });
  const newRepo = async (name) => {
    await fake.create(name);
    fake.repos.get(name).commits.push({ sha: "c1" });
    await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', ?)")
      .bind(`id-${name}`, name, new Date().toISOString()).run();
    await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  };
  const effective = async (name) => (await call(`/api/repos/${name}/policy`)).json();
  afterEach(() => env.DB.prepare("DELETE FROM global_policy").run());

  it("a new repo inherits the global policy", async () => {
    expect((await call("/api/settings/policy", "PUT", { release: ["release/*"], check: "npm test" })).status).toBe(200);
    expect(await (await call("/api/settings/policy")).json()).toEqual({ release: ["release/*"], check: "npm test" });
    await newRepo("inherits");
    expect(await effective("inherits")).toMatchObject({
      integration: ["main"], release: ["release/*"], check: "npm test", base_sha: "c1",
      sources: { integration: "default", release: "global", check: "global" },
    });
  });

  it("after the policy's integration list changes to develop and main, GET /api/repos returns that list", async () => {
    await newRepo("synced");
    fake.repos.get("synced").files[".cinder.yml"] = GITFLOW;
    fake.repos.get("synced").commits.unshift({ sha: "c2" });
    expect(await effective("synced")).toMatchObject({ integration: ["develop", "main"] });
    const listed = (await (await call("/api/repos")).json()).find((r) => r.name === "synced");
    expect(listed.branch_policy.integration).toEqual(["develop", "main"]);
  });

  it("a repo override changes only that repo, and the effective view shows the source", async () => {
    await call("/api/settings/policy", "PUT", { release: ["release/*"], check: "npm test" });
    await newRepo("overrides");
    await newRepo("neighbour");
    await git(["init", "-q", "--bare", "-b", "main", "overrides.git"]);
    const base = await commit(bareRepo("overrides"), { branch: "main", base: null, message: "base", author: { name: "Ann", email: "ann@x.test", time: 1700000000 }, changes: [{ path: "README", content: "hi\n" }] });
    const put = await worker.fetch(new Request("http://cinder.test/api/repos/overrides/policy", { method: "PUT", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
      body: JSON.stringify({ check: "go test ./..." }) }), { ...env, ARTIFACTS: { get: async (name) => ({ ...bareRepo(name), log: async () => [{ hash: base.sha }] }) } });
    expect(put.status).toBe(201);
    fake.repos.get("overrides").files[".cinder.yml"] = await git(["--git-dir", "overrides.git", "show", "main:.cinder.yml"]);
    fake.repos.get("overrides").commits.unshift({ sha: "c2" });
    expect(await effective("overrides")).toMatchObject({ release: ["release/*"], check: "go test ./...", sources: { release: "global", check: "repo" } });
    expect(await effective("neighbour")).toMatchObject({ release: ["release/*"], check: "npm test", sources: { release: "global", check: "global" } });
  });

  it("PUT …/policy with rules commits YAML that parsePolicy reads back unchanged", async () => {
    await newRepo("rules-yaml");
    await git(["init", "-q", "--bare", "-b", "main", "rules-yaml.git"]);
    const base = await commit(bareRepo("rules-yaml"), { branch: "main", base: null, message: "base", author: { name: "Ann", email: "ann@x.test", time: 1700000000 }, changes: [{ path: "README", content: "hi\n" }] });
    const rules = [{ branch: "develop", queue: false, judges: 2, risk: 25, route: ["db/*", "infra/*.tf"] }, { branch: "main", queue: true, judges: 1, risk: 10, route: [] }];
    const put = await worker.fetch(new Request("http://cinder.test/api/repos/rules-yaml/policy", { method: "PUT", headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` },
      body: JSON.stringify({ integration: ["develop", "main"], rules }) }), { ...env, ARTIFACTS: { get: async (name) => ({ ...bareRepo(name), log: async () => [{ hash: base.sha }] }) } });
    expect(put.status).toBe(201);
    const back = parsePolicy(await git(["--git-dir", "rules-yaml.git", "show", "main:.cinder.yml"]), "main");
    expect(back.rules).toEqual(rules);
    expect(back.sources.rules).toBe("repo");
  });
});

describe("policy save keeps the rest of .cinder.yml", () => {
  const DEPLOY = "deploy:\n  environments:\n    - { name: staging, branch: develop }\n    - { name: production, branch: main }\n  worker: wrangler.jsonc\n";
  // The relay's git helper trims stdout; every file here ends in one newline, so put it back.
  const artifacts = { get: async (name) => ({ ...bareRepo(name), readFile: ({ ref, path }) => git(["--git-dir", `${name}.git`, "show", `${ref}:${path}`]).then((t) => new Blob([`${t}\n`]), () => null) }) };
  const call = (name, path, method = "GET", body) => worker.fetch(new Request(`http://cinder.test/api/repos/${name}${path}`,
    { method, headers: { Authorization: `Bearer ${env.OWNER_TOKEN}` }, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: artifacts });
  const seed = async (name, yml) => {
    await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', 'trunk', '{}', ?)")
      .bind(`id-${name}`, name, new Date().toISOString()).run();
    await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
    return commit(bareRepo(name), { branch: "main", base: null, message: "base", author: { name: "Ann", email: "ann@x.test", time: 1700000000 }, changes: [{ path: ".cinder.yml", content: yml }] });
  };
  const fileOf = (name) => git(["--git-dir", `${name}.git`, "show", "main:.cinder.yml"]);

  const putAs = async (email, name, body) => worker.fetch(new Request(`http://cinder.test/api/repos/${name}/policy`,
    { method: "PUT", headers: await as(email), body: JSON.stringify(body) }), { ...ACCESS, ARTIFACTS: artifacts });

  it("a contributor's policy save is refused with 403", async () => {
    serveCerts();
    onTestFinished(() => vi.restoreAllMocks());
    await seed("contrib-policy", DEPLOY);
    await env.DB.prepare("INSERT INTO person_roles VALUES ('pc@example.com', 'contributor')").run();
    const res = await putAs("pc@example.com", "contrib-policy", { check: "true" });
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toBe("saving the branch policy of contrib-policy needs branch.write");
    expect(`${await fileOf("contrib-policy")}\n`).toBe(DEPLOY);
  });

  it("an admin's policy save succeeds", async () => {
    serveCerts();
    onTestFinished(() => vi.restoreAllMocks());
    await seed("admin-policy", DEPLOY);
    await env.DB.prepare("INSERT INTO repo_roles (repo_id, person, role) VALUES ('id-admin-policy', 'pa@example.com', 'admin')").run();
    expect((await putAs("pa@example.com", "admin-policy", { check: "npm test" })).status).toBe(201);
    expect(`${await fileOf("admin-policy")}\n`).toBe(`check: "npm test"\n${DEPLOY}`);
  });

  it("saving a policy keeps the deploy block and its environments", async () => {
    await seed("keeps-deploy", `check: "make check"\n${DEPLOY}`);
    expect((await call("keeps-deploy", "/policy", "PUT", { check: "go test ./..." })).status).toBe(201);
    expect(`${await fileOf("keeps-deploy")}\n`).toBe(`check: "go test ./..."\n${DEPLOY}`);
    expect((await (await call("keeps-deploy", "/environments")).json()).map((e) => e.name)).toEqual(["staging", "production"]);
  });

  it("a block-map environment with secrets parses like the flow-map form", async () => {
    const flow = "deploy:\n  environments:\n    - { name: production, branch: main, secrets: [API_KEY, DB_URL] }\n";
    const block = "deploy:\n  environments:\n    - name: production\n      branch: main\n      secrets: [API_KEY, DB_URL]\n";
    expect(parseDeploy(block)).toEqual(parseDeploy(flow));
    await seed("block-env", block);
    const res = await call("block-env", "/environments");
    expect(res.status).toBe(200);
    expect((await res.json()).map((e) => e.name)).toEqual(["production"]);
    expect(parsePolicy(block, "main").integration).toEqual(["main"]);
    await seed("bad-env", "deploy:\n  environments:\n    - name: production\n        branch: main\n");
    const bad = await call("bad-env", "/environments");
    expect(bad.status).toBe(422);
    expect((await bad.json()).error.message).toBe('yaml: line 4: unexpected indentation at "branch: main"');
  });

  it("an unknown top-level key survives a policy save", async () => {
    await seed("keeps-unknown", "# repo config\nbranches:\n  integration: [\"main\"]\nfuture_key:\n  nested: { a: 1 }\nstack: \"code@stable\"\n");
    expect((await call("keeps-unknown", "/policy", "PUT", { release: ["release/*"] })).status).toBe(201);
    expect(`${await fileOf("keeps-unknown")}\n`).toBe("# repo config\nbranches:\n  release: [\"release/*\"]\nfuture_key:\n  nested: { a: 1 }\nstack: \"code@stable\"\n");
  });

  it("a policy save with a stale base_sha returns 409", async () => {
    const { sha } = await seed("stale-base", DEPLOY);
    const stale = await call("stale-base", "/policy", "PUT", { check: "npm test", base_sha: "0".repeat(40) });
    expect(stale.status).toBe(409);
    expect((await stale.json()).error.message).toBe("main moved since this page loaded");
    expect(`${await fileOf("stale-base")}\n`).toBe(DEPLOY);
    expect((await call("stale-base", "/policy", "PUT", { check: "npm test", base_sha: sha })).status).toBe(201);
  });

  it("saving the same policy twice makes one commit and returns the head sha", async () => {
    const base = await seed("same-twice", DEPLOY);
    const first = await call("same-twice", "/policy", "PUT", { check: "npm test" });
    expect(first.status).toBe(201);
    const { sha } = await first.json();
    const second = await call("same-twice", "/policy", "PUT", { check: "npm test" });
    expect(second.status).toBe(200);
    expect(await second.json()).toEqual({ sha });
    expect(await git(["--git-dir", "same-twice.git", "rev-list", "--count", "main"])).toBe("2");
    expect(await git(["--git-dir", "same-twice.git", "rev-parse", "main~1"])).toBe(base.sha);
  });
});
