import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index.js";
import { syncAccounts } from "../src/accounts.js";
import { can } from "../src/people.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
const CF = { ...env, CF_ACCOUNT_ID: "cf-main", CF_DEPLOY_TOKEN: "test-token" };

// The accounts migration's SQL, replayed on rows written as if before it ran.
async function backfill() {
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_accounts.sql"));
  for (const q of migration.queries) await env.DB.prepare(q).run();
}

// A Cloudflare API answering the instance account, and the organization calls with `org` (a status: the call fails with it).
function fakeApi(org) {
  return async (url) => {
    const path = new URL(url).pathname.replace("/client/v4", "");
    const ok = (result) => Response.json({ success: true, result });
    if (path === "/accounts/cf-main") return ok({ id: "cf-main", name: "Main" });
    if (typeof org === "number") return Response.json({ success: false, errors: [{ code: 9109, message: "Unauthorized" }] }, { status: org });
    if (path === "/organizations") return ok([{ id: "org-1", name: "Acme" }]);
    if (path === "/organizations/org-1/accounts") return ok([{ id: "cf-main", name: "Main" }, { id: "cf-two", name: "Two" }]);
    if (path === "/organizations/org-1/members") return ok([{ email: "Boss@Acme.com", role: "admin" }, { email: "dev@acme.com", role: "member" }]);
    return Response.json({ success: false }, { status: 404 });
  };
}

describe("accounts", () => {
  it("every existing repo stays reachable for its existing people after the backfill", async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('acc-old', 'acc-old', 'main', 'trunk', '{}', '2026-10-01T00:00:00Z')"),
      env.DB.prepare("INSERT INTO person_roles VALUES ('m@old.com', 'maintainer'), ('d@old.com', 'developer'), ('v@old.com', 'viewer')"),
    ]);
    await backfill();
    // The roles go; the account membership the backfill gave them still reaches the repo.
    await env.DB.prepare("DELETE FROM person_roles").run();
    expect(await can(env, "m@old.com", "POST", "/api/repos/acc-old/branches")).toBe(true);
    expect(await can(env, "d@old.com", "POST", "/api/repos/acc-old/commits-x")).toBe(true);
    expect(await can(env, "v@old.com", "GET", "/api/repos/acc-old")).toBe(true);
    expect(await can(env, "v@old.com", "POST", "/api/repos/acc-old/commits-x")).toBe(false);
    expect(await can(env, "stranger@old.com", "GET", "/api/repos/acc-old")).toBe(false);
  });

  it("the sync upserts an organization, its accounts and implicit org members", async () => {
    await env.DB.batch([
      // An earlier sync's row, renamed since.
      env.DB.prepare("INSERT INTO accounts (id, name, slug, cf_account_id, created_at) VALUES ('cf-two', 'Old name', 'cf-two', 'cf-two', '2026-10-01')"),
      // A direct role is kept; an org row for someone no longer in the org goes.
      env.DB.prepare("INSERT INTO account_members VALUES ('cf-two', 'dev@acme.com', 'maintainer', 'direct'), ('cf-two', 'gone@acme.com', 'reader', 'org')"),
    ]);
    await syncAccounts(CF, fakeApi());
    expect(await env.DB.prepare("SELECT id, name, cf_org_id FROM organizations").all()).toMatchObject({ results: [{ id: "org-1", name: "Acme", cf_org_id: "org-1" }] });
    const { results: accounts } = await env.DB.prepare("SELECT id, name, org_id, cf_account_id FROM accounts ORDER BY id").all();
    expect(accounts).toEqual([
      { id: "cf-two", name: "Two", org_id: "org-1", cf_account_id: "cf-two" },
      { id: "instance", name: "Main", org_id: "org-1", cf_account_id: "cf-main" },
    ]);
    const { results: members } = await env.DB.prepare("SELECT account_id, person, git_role, source FROM account_members WHERE person LIKE '%@acme.com' ORDER BY account_id, person").all();
    expect(members).toEqual([
      { account_id: "cf-two", person: "boss@acme.com", git_role: "admin", source: "org" },
      { account_id: "cf-two", person: "dev@acme.com", git_role: "maintainer", source: "direct" },
      { account_id: "instance", person: "boss@acme.com", git_role: "admin", source: "org" },
      { account_id: "instance", person: "dev@acme.com", git_role: "reader", source: "org" },
    ]);
  });

  it("the sync skips organizations quietly when the token can't read them", async () => {
    await env.DB.prepare("UPDATE accounts SET cf_account_id = NULL WHERE id = 'instance'").run();
    const orgs = await env.DB.prepare("SELECT count(*) AS n FROM organizations").first("n");
    const logged = vi.spyOn(console, "error");
    for (const status of [403, 404]) await expect(syncAccounts(CF, fakeApi(status))).resolves.toBeUndefined();
    expect(logged).not.toHaveBeenCalled();
    expect(await env.DB.prepare("SELECT cf_account_id FROM accounts WHERE id = 'instance'").first("cf_account_id")).toBe("cf-main");
    expect(await env.DB.prepare("SELECT count(*) AS n FROM organizations").first("n")).toBe(orgs);
    // Any other failure is not swallowed.
    await expect(syncAccounts(CF, fakeApi(500))).rejects.toThrow(/500/);
  });

  it("a hand-added account and member need org.manage", async () => {
    const call = (path, body, headers = OWNER) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }),
      { ...env, ARTIFACTS: fakeArtifacts() });
    const res = await call("/api/accounts", { name: "Labs", slug: "labs", organization: "Acme" });
    expect(res.status).toBe(201);
    const { id, org_id: org } = await res.json();
    expect(await env.DB.prepare("SELECT name FROM organizations WHERE id = ?").bind(org).first("name")).toBe("Acme");
    expect((await call("/api/accounts", { name: "Labs", slug: "labs" })).status).toBe(409);
    expect((await call(`/api/accounts/${id}/members`, { person: "Ana@Labs.com", git_role: "maintainer" })).status).toBe(204);
    expect((await call(`/api/accounts/${id}/members`, { person: "ana@labs.com", git_role: "owner" })).status).toBe(400);
    expect((await call("/api/accounts/nope/members", { person: "ana@labs.com", git_role: "reader" })).status).toBe(404);
    expect(await env.DB.prepare("SELECT git_role, source FROM account_members WHERE account_id = ? AND person = 'ana@labs.com'").bind(id).first())
      .toEqual({ git_role: "maintainer", source: "direct" });
    // A repo made with that account active belongs to it.
    expect((await call("/api/repos", { name: "labs-app" }, { ...OWNER, Cookie: `cinder_account=${id}` })).status).toBe(201);
    expect(await env.DB.prepare("SELECT account_id FROM repo_accounts JOIN repos ON repos.id = repo_id WHERE name = 'labs-app'").first("account_id")).toBe(id);
    await env.DB.prepare("INSERT INTO person_roles VALUES ('admin@labs.com', 'admin'), ('maint@labs.com', 'maintainer')").run();
    for (const path of ["/api/accounts", `/api/accounts/${id}/members`]) {
      expect(await can(env, "admin@labs.com", "POST", path)).toBe(true);
      expect(await can(env, "ana@labs.com", "POST", path)).toBe(false);
      expect(await can(env, "maint@labs.com", "POST", path)).toBe(false);
    }
  });

  // Acme with three accounts: pat is a direct admin on Team, an org reader on Labs and a contributor on Staging.
  // The file's tests share one database, so the rows go in once.
  let seeded;
  const acme = () => (seeded ??= env.DB.batch([
    env.DB.prepare("INSERT INTO organizations (id, name) VALUES ('org-acme', 'Acme')"),
    env.DB.prepare("INSERT INTO accounts (id, name, slug, org_id, created_at) VALUES ('a-team', 'Acme Team', 'acme-team', 'org-acme', '2026-10-01'), " +
      "('a-labs', 'Acme Labs', 'acme-labs', 'org-acme', '2026-10-01'), ('a-staging', 'Acme Staging', 'acme-staging', 'org-acme', '2026-10-01')"),
    env.DB.prepare("INSERT INTO account_members VALUES ('a-team', 'pat@acme.com', 'admin', 'direct'), ('a-labs', 'pat@acme.com', 'reader', 'org'), " +
      "('a-staging', 'pat@acme.com', 'contributor', 'direct'), ('instance', 'pat@acme.com', 'maintainer', 'direct')"),
    env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('r-team', 'acme-team-app', 'main', 'trunk', '{}', '2026-10-01'), " +
      "('r-labs', 'acme-labs-app', 'main', 'trunk', '{}', '2026-10-01')"),
    env.DB.prepare("INSERT INTO repo_accounts VALUES ('r-team', 'a-team'), ('r-labs', 'a-labs')"),
  ]));
  const asPat = async (path, init = {}) => {
    serveCerts();
    return worker.fetch(new Request(`http://cinder.test${path}`, { ...init, headers: { ...(await as("pat@acme.com")), ...init.headers } }), { ...ACCESS, ARTIFACTS: fakeArtifacts() });
  };
  afterEach(() => vi.restoreAllMocks());

  it("me/accounts groups accounts under the organization and marks implicit access", async () => {
    await acme();
    const res = await asPat("/api/me/accounts", { headers: { Cookie: "cinder_account=a-team" } });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.organization).toEqual({ id: "org-acme", name: "Acme" });
    expect(body.accounts.map((a) => [a.name, a.git_role, a.implicit, a.repos, a.current])).toEqual([
      ["Acme Labs", "reader", true, 1, false], ["Acme Staging", "contributor", false, 0, false], ["Acme Team", "admin", false, 1, true]]);
    expect(body.personal).toMatchObject({ id: "instance", git_role: "maintainer", implicit: false, current: false });
  });

  it("a contributor's can_create is false", async () => {
    await acme();
    const { accounts } = await (await asPat("/api/me/accounts", { headers: { Cookie: "cinder_account=a-staging" } })).json();
    expect(Object.fromEntries(accounts.map((a) => [a.git_role, a.can_create]))).toEqual({ admin: true, reader: false, contributor: false });
  });

  it("switching to an account you're not a member of answers 403", async () => {
    await acme();
    await env.DB.prepare("INSERT INTO accounts (id, name, slug, created_at) VALUES ('a-other', 'Other', 'other', '2026-10-01')").run();
    const res = await asPat("/api/me/accounts/a-other/switch", { method: "POST" });
    expect(res.status).toBe(403);
    expect(res.headers.get("Set-Cookie")).toBeNull();
    const ok = await asPat("/api/me/accounts/a-labs/switch", { method: "POST" });
    expect(ok.status).toBe(204);
    expect(ok.headers.get("Set-Cookie")).toBe("cinder_account=a-labs; Path=/; HttpOnly; SameSite=Lax; Secure");
  });

  it("after a switch, GET /api/repos lists only the active account's repos", async () => {
    await acme();
    const call = (path, init = {}) => worker.fetch(new Request(`http://cinder.test${path}`, { ...init, headers: { ...OWNER, ...init.headers } }), { ...env, ARTIFACTS: fakeArtifacts() });
    const names = async (headers) => (await (await call("/api/repos", { headers })).json()).map((r) => r.name);
    expect(await names()).toEqual(expect.arrayContaining(["acme-labs-app", "acme-team-app"]));
    const res = await call("/api/me/accounts/a-labs/switch", { method: "POST" });
    expect(res.status).toBe(204);
    expect(await names({ Cookie: res.headers.get("Set-Cookie").split(";")[0] })).toEqual(["acme-labs-app"]);
  });
});
