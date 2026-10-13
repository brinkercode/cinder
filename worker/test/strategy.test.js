import { env, runInDurableObject } from "cloudflare:test";
import { describe, expect, it, vi } from "vitest";
import { commit } from "../src/git/index.js";
import worker from "../src/index.js";
import { parsePolicy, policyForStrategy } from "../src/policy.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";
import { bareRepo, git } from "./fakes/bare-repo.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
// The relay's git helper trims stdout; put the file's last newline back.
const binding = { get: async (name) => ({ ...bareRepo(name), readFile: ({ ref, path }) => git(["--git-dir", `${name}.git`, "show", `${ref}:${path}`]).then((t) => new Blob([`${t}\n`]), () => null) }) };
const call = (artifacts, path, method = "GET", body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), { ...env, ARTIFACTS: artifacts });
const strategyOf = (name) => env.DB.prepare("SELECT strategy FROM repos WHERE name = ?").bind(name).first("strategy");
const fileOf = (name) => git(["--git-dir", `${name}.git`, "show", "main:.cinder.yml"]);

// A repo row with strategy whose RepoDO reads artifacts; with yml, a bare repo whose main holds that .cinder.yml.
async function seed(name, strategy, artifacts, yml) {
  await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, 'main', ?, '{}', ?)")
    .bind(`id-${name}`, name, strategy, new Date().toISOString()).run();
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName(name)), (i) => { i.env = { ...i.env, ARTIFACTS: artifacts }; });
  if (yml === undefined) return;
  await git(["init", "-q", "--bare", "-b", "main", `${name}.git`]);
  await commit(bareRepo(name), { branch: "main", base: null, message: "base", author: { name: "Ann", email: "ann@x.test", time: 1700000000 }, changes: [{ path: ".cinder.yml", content: yml }] });
}

describe("branching strategy", () => {
  it("gitflow produces develop and main as integration branches", () => {
    expect(policyForStrategy("gitflow", "main")).toEqual({ integration: ["develop", "main"], release: [] });
    expect(policyForStrategy("trunk", "main")).toEqual({ integration: ["main"], release: [] });
    expect(policyForStrategy("release", "main")).toEqual({ integration: ["main"], release: ["release/*"] });
    expect(policyForStrategy("custom", "main")).toEqual({});
  });

  it("preview lists the rows a switch to release would change and commits nothing", async () => {
    const fake = fakeArtifacts();
    await fake.create("pv");
    fake.repos.get("pv").files[".cinder.yml"] = "branches:\n  integration: [develop, main]\ncheck: npm test\n";
    fake.repos.get("pv").commits.push({ sha: "c1" });
    await seed("pv", "gitflow", fake);
    const res = await call(fake, "/api/repos/pv/policy/preview?strategy=release");
    expect(res.status).toBe(200);
    const { policy, changes } = await res.json();
    expect(changes).toEqual([{ key: "integration", from: ["develop", "main"], to: ["main"] }, { key: "release", from: [], to: ["release/*"] }]);
    expect(policy).toMatchObject({ integration: ["main"], release: ["release/*"], check: "npm test", rules: [{ branch: "main" }] });
    expect(fake.calls.some((c) => c.method === "createToken")).toBe(false);
    expect(fake.repos.get("pv").commits).toHaveLength(1);
    expect(await strategyOf("pv")).toBe("gitflow");
    expect((await call(fake, "/api/repos/pv/policy/preview?strategy=yolo")).status).toBe(400);
  });

  it("apply commits the produced branches to .cinder.yml", async () => {
    await seed("apply-gf", "trunk", binding, 'check: "npm test"\n');
    expect((await call(binding, "/api/repos/apply-gf/settings", "PUT", { strategy: "gitflow", apply: true })).status).toBe(204);
    expect(parsePolicy(await fileOf("apply-gf"), "main")).toMatchObject({ integration: ["develop", "main"], release: [], check: "npm test" });
    expect(await strategyOf("apply-gf")).toBe("gitflow");
    // Without apply only the strategy is stored.
    expect((await call(binding, "/api/repos/apply-gf/settings", "PUT", { strategy: "release" })).status).toBe(204);
    expect(parsePolicy(await fileOf("apply-gf"), "main").integration).toEqual(["develop", "main"]);
    expect(await strategyOf("apply-gf")).toBe("release");
  });

  it("a contributor's PUT settings {strategy, apply} is refused without branch.write and is never attributed to owner", async () => {
    serveCerts();
    await seed("apply-dev", "trunk", binding, 'check: "npm test"\n');
    await env.DB.prepare("INSERT INTO person_roles VALUES ('dev@x.test', 'developer') ON CONFLICT (email) DO UPDATE SET role = excluded.role").run();
    const res = await worker.fetch(new Request("http://cinder.test/api/repos/apply-dev/settings", { method: "PUT", headers: await as("dev@x.test"),
      body: JSON.stringify({ strategy: "gitflow", apply: true }) }), { ...ACCESS, ARTIFACTS: binding });
    vi.restoreAllMocks();
    expect(res.status).toBe(403);
    expect((await res.json()).error.message).toContain("branch.write");
    expect(await git(["--git-dir", "apply-dev.git", "log", "--format=%an", "main"])).toBe("Ann");
    expect(await strategyOf("apply-dev")).toBe("trunk");
  });

  it("a hand-edited policy marks the strategy custom", async () => {
    await seed("hand", "gitflow", binding, 'branches:\n  integration: ["develop","main"]\n');
    expect((await call(binding, "/api/repos/hand/policy", "PUT", { integration: ["develop", "main"], release: [] })).status).toBe(201);
    expect(await strategyOf("hand")).toBe("gitflow");
    expect((await call(binding, "/api/repos/hand/policy", "PUT", { integration: ["main"] })).status).toBe(201);
    expect(await strategyOf("hand")).toBe("custom");
  });
});
