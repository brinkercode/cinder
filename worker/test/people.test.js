import { env } from "cloudflare:workers";
import { runInDurableObject } from "cloudflare:test";
import { expect, it, onTestFinished, vi } from "vitest";
import { validateInvite } from "../src/api/contract.js";
import { can } from "../src/people.js";
import worker from "../src/index.js";
import { fakeArtifacts } from "./fakes/artifacts.js";
import { ACCESS, as, serveCerts } from "./helpers/access.js";

it("roles resolve from invites, groups and repo roles only", async () => {
  // A team grant from before the removal: the drop_teams migration turns it into a direct role.
  await env.DB.batch([
    env.DB.prepare("CREATE TABLE IF NOT EXISTS teams (name TEXT PRIMARY KEY, role TEXT NOT NULL)"),
    env.DB.prepare("CREATE TABLE IF NOT EXISTS team_members (team TEXT NOT NULL, person TEXT NOT NULL, PRIMARY KEY (team, person))"),
    env.DB.prepare("INSERT INTO teams VALUES ('ops', 'maintainer')"),
    env.DB.prepare("INSERT INTO team_members VALUES ('ops', 'tm@people.test'), ('ops', 'inv@people.test')"),
    env.DB.prepare("INSERT INTO person_roles VALUES ('inv@people.test', 'viewer')"),
    env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('pr1', 'people-repo', 'main', 'trunk', '{}', '2026-10-08')"),
    env.DB.prepare("INSERT INTO repo_roles VALUES ('pr1', 'rr@people.test', 'maintainer')"),
  ]);
  const migration = env.TEST_MIGRATIONS.find((m) => m.name.endsWith("_drop_teams.sql"));
  for (const q of migration.queries) await env.DB.prepare(q).run();

  const branch = ["PUT", "/api/repos/people-repo/branches/x"];
  expect(await can(env, "tm@people.test", ...branch)).toBe(true); // the team's role, now direct
  expect(await can(env, "inv@people.test", ...branch)).toBe(false); // the invite's own role wins over the team's
  expect(await can(env, "inv@people.test", "GET", "/api/repos/people-repo")).toBe(true);
  expect(await can(env, "rr@people.test", ...branch)).toBe(true); // repo role on this repo
  expect(await can(env, "rr@people.test", "PUT", "/api/repos/other/branches/x")).toBe(false);
  expect(await can(env, "nobody@people.test", "GET", "/api/repos/people-repo")).toBe(false);
});

it("removing the last owner answers 409 last_owner", async () => {
  const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}`, "Content-Type": "application/json" };
  const call = (path, method, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), env);
  await env.DB.prepare("INSERT INTO person_roles VALUES ('own1@people.test', 'owner')").run();
  const removed = await call("/api/people/own1%40people.test", "DELETE");
  expect(removed.status).toBe(409);
  expect((await removed.json()).error.code).toBe("last_owner");
  // Demoting them is refused too; with a second owner both go through.
  expect((await call("/api/people", "POST", { email: "own1@people.test", role: "viewer" })).status).toBe(409);
  await env.DB.prepare("INSERT INTO person_roles VALUES ('own2@people.test', 'owner')").run();
  expect((await call("/api/people", "POST", { email: "own1@people.test", role: "viewer" })).status).toBe(201);
  expect((await call("/api/people/own1%40people.test", "DELETE")).status).toBe(204);
});

it("removing or demoting the last owner is blocked on the server", async () => {
  const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}`, "Content-Type": "application/json" };
  const call = (path, method, body) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), env);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM person_roles WHERE role = 'owner'"),
    env.DB.prepare("INSERT INTO people (email, created_at) VALUES ('solo@people.test', '2026-10-08'), ('next@people.test', '2026-10-08')"),
    env.DB.prepare("INSERT INTO person_roles VALUES ('solo@people.test', 'owner')"),
  ]);
  const demoted = await call("/api/people/solo%40people.test", "PATCH", { role: "maintainer" });
  expect([demoted.status, (await demoted.json()).error.code]).toEqual([409, "last_owner"]);
  expect((await call("/api/people/solo%40people.test", "DELETE")).status).toBe(409);
  expect((await call("/api/invites", "POST", { emails: ["SOLO@people.test"], role: "viewer", repos: [] })).status).toBe(409);
  // Once someone else is an owner, the change goes through.
  expect((await call("/api/people/next%40people.test", "PATCH", { role: "owner" })).status).toBe(200);
  const ok = await call("/api/people/solo%40people.test", "PATCH", { role: "maintainer" });
  expect([ok.status, await ok.json()]).toEqual([200, { email: "solo@people.test", role: "maintainer" }]);
  expect((await call("/api/people/ghost%40people.test", "PATCH", { role: "viewer" })).status).toBe(404);
});

// The only owner is an every-repo Access group mapping; call sends as the OWNER_TOKEN.
async function groupOwnerOnly() {
  await env.DB.batch([
    env.DB.prepare("DELETE FROM person_roles WHERE role = 'owner'"),
    env.DB.prepare("DELETE FROM access_groups WHERE role = 'owner'"),
    env.DB.prepare("INSERT INTO access_groups VALUES ('admins', 'Access group', 'owner', '[]'), ('repo-admins', 'Access group', 'owner', '[\"r\"]')"),
  ]);
  const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}`, "Content-Type": "application/json" };
  return (path, method, body, e = env) => worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: OWNER, body: body && JSON.stringify(body) }), e);
}

// The only owner is the OWNERS email boss@people.test, who also has a People row.
const ownersOnly = { ...env, OWNERS: " Boss@people.test, " };
async function bossOnly() {
  const call = await groupOwnerOnly();
  await env.DB.batch([
    env.DB.prepare("DELETE FROM access_groups WHERE role = 'owner'"),
    env.DB.prepare("INSERT INTO people (email, created_at) VALUES ('boss@people.test', '2026-10-09') ON CONFLICT DO NOTHING"),
  ]);
  return call;
}

it("removing the last owner is refused with last_owner", async () => {
  const call = await groupOwnerOnly();
  const removed = await call("/api/groups/admins", "DELETE");
  expect([removed.status, (await removed.json()).error.code]).toEqual([409, "last_owner"]);
  expect((await env.DB.prepare("SELECT role FROM access_groups WHERE name = 'admins'").first("role"))).toBe("owner");
  expect((await call("/api/groups/repo-admins", "DELETE")).status).toBe(204);
  await bossOnly();
  const boss = await call("/api/people/boss%40people.test", "DELETE", undefined, ownersOnly);
  expect([boss.status, (await boss.json()).error.code]).toEqual([409, "last_owner"]);
  expect(await env.DB.prepare("SELECT 1 FROM people WHERE email = 'boss@people.test'").first()).not.toBeNull();
});

it("demoting the last owner is refused with last_owner", async () => {
  const call = await groupOwnerOnly();
  for (const body of [{ source: "Access group", role: "maintainer", repos: [] }, { source: "Access group", role: "owner", repos: ["r"] }]) {
    const demoted = await call("/api/groups/admins", "PUT", body);
    expect([demoted.status, (await demoted.json()).error.code]).toEqual([409, "last_owner"]);
  }
  expect((await env.DB.prepare("SELECT role FROM access_groups WHERE name = 'admins'").first("role"))).toBe("owner");
  await bossOnly();
  for (const [path, method, body] of [["/api/people/boss%40people.test", "PATCH", { role: "viewer" }], ["/api/people", "POST", { email: "boss@people.test", role: "viewer" }]]) {
    const demoted = await call(path, method, body, ownersOnly);
    expect([demoted.status, (await demoted.json()).error.code]).toEqual([409, "last_owner"]);
  }
  expect(await env.DB.prepare("SELECT 1 FROM person_roles WHERE email = 'boss@people.test'").first()).toBeNull();
});

it("removing an owner when another owner exists succeeds", async () => {
  const call = await groupOwnerOnly();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO people (email, created_at) VALUES ('sole@people.test', '2026-10-09')"),
    env.DB.prepare("INSERT INTO person_roles VALUES ('sole@people.test', 'owner')"),
  ]);
  expect((await call("/api/people/sole%40people.test", "PATCH", { role: "viewer" })).status).toBe(200);
  expect((await call("/api/people/sole%40people.test", "DELETE")).status).toBe(204);
  expect(await env.DB.prepare("SELECT 1 FROM person_roles WHERE email = 'sole@people.test'").first()).toBeNull();
  // An OWNERS email and an Owner person: either can go while the other stays.
  await bossOnly();
  await env.DB.prepare("INSERT INTO person_roles VALUES ('sole@people.test', 'owner')").run();
  expect((await call("/api/people/boss%40people.test", "DELETE", undefined, ownersOnly)).status).toBe(204);
  expect((await call("/api/people/sole%40people.test", "DELETE", undefined, ownersOnly)).status).toBe(204);
});

it("an invite gives each email the role on every repo or only the selected repos", async () => {
  const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}`, "Content-Type": "application/json" };
  const call = (body) => worker.fetch(new Request("http://cinder.test/api/invites", { method: "POST", headers: OWNER, body: JSON.stringify(body) }), env);
  await env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('ir1', 'invite-repo', 'main', 'trunk', '{}', '2026-10-08')").run();
  const all = await call({ emails: ["A@invite.test", "b@invite.test"], role: "maintainer", repos: [] });
  const body = await all.json();
  expect([all.status, validateInvite(body).ok, body.emails]).toEqual([201, true, ["a@invite.test", "b@invite.test"]]);
  expect(await can(env, "a@invite.test", "PUT", "/api/repos/any/branches/x")).toBe(true);
  expect((await call({ emails: ["c@invite.test"], role: "maintainer", repos: ["invite-repo"] })).status).toBe(201);
  expect(await can(env, "c@invite.test", "PUT", "/api/repos/invite-repo/branches/x")).toBe(true);
  expect(await can(env, "c@invite.test", "PUT", "/api/repos/other/branches/x")).toBe(false);
  expect((await call({ emails: ["d@invite.test"], role: "viewer", repos: ["no-such-repo"] })).status).toBe(404);
  expect((await call({ emails: ["not-an-email"], role: "viewer", repos: [] })).status).toBe(400);
});

it("refuses a viewer listing the keystore", async () => {
  await env.DB.prepare("INSERT INTO person_roles VALUES ('view@keystore.test', 'viewer'), ('maint@keystore.test', 'maintainer')").run();
  for (const path of ["/api/keystore", "/api/keystore/k1/audit", "/api/service-tokens", "/api/people", "/api/repos/any/webhooks"]) {
    expect(await can(env, "view@keystore.test", "GET", path)).toBe(false);
  }
  expect(await can(env, "maint@keystore.test", "GET", "/api/keystore")).toBe(true);
  expect(await can(env, "maint@keystore.test", "GET", "/api/people")).toBe(false);
  expect(await can(env, "view@keystore.test", "GET", "/api/repos/any")).toBe(true);
});

it("a viewer can't list a repo's people", async () => {
  await env.DB.prepare("INSERT INTO person_roles VALUES ('view@rp.test', 'viewer'), ('maint@rp.test', 'maintainer'), ('adm@rp.test', 'admin')").run();
  expect(await can(env, "view@rp.test", "GET", "/api/repos/any/people")).toBe(false);
  expect(await can(env, "maint@rp.test", "GET", "/api/repos/any/people")).toBe(false);
  expect(await can(env, "adm@rp.test", "GET", "/api/repos/any/people")).toBe(true);
});

it("ignores a same-named group from another identity provider", async () => {
  serveCerts();
  onTestFinished(() => vi.restoreAllMocks());
  await env.DB.prepare("INSERT INTO access_groups VALUES ('okta-eng', 'IdP group (okta-1)', 'developer', '[]'), ('cf-eng', 'Access group', 'developer', '[]')").run();
  const repos = async (claims) => (await worker.fetch(new Request("http://cinder.test/api/repos", { headers: await as("idp@people.test", claims) }), ACCESS)).status;
  expect(await repos({ idp: { id: "okta-1", type: "okta" }, groups: ["okta-eng"] })).toBe(200);
  expect(await repos({ idp: { id: "2", type: "github" }, groups: ["okta-eng"] })).toBe(403);
  expect(await repos({ groups: ["okta-eng"] })).toBe(403);
  expect(await repos({ idp: "github", groups: ["cf-eng"] })).toBe(403);
  expect(await repos({ groups: ["cf-eng"] })).toBe(200);
});

it("lets a contributor post a Comment review but not approve", async () => {
  serveCerts();
  const fake = fakeArtifacts();
  const e = { ...ACCESS, ARTIFACTS: fake };
  const call = (path, body, headers) => worker.fetch(new Request(`http://cinder.test${path}`, { method: "POST", headers, body: JSON.stringify(body) }), e);
  const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
  expect((await call("/api/repos", { name: "review-perm" }, OWNER)).status).toBe(201);
  await runInDurableObject(env.REPO_DO.get(env.REPO_DO.idFromName("review-perm")), (i) => { i.env = { ...i.env, ARTIFACTS: fake }; });
  const change = await (await call("/api/repos/review-perm/changes", { intent: "x" }, OWNER)).json();
  await env.DB.prepare("INSERT INTO person_roles VALUES ('contrib@review.test', 'contributor')").run();
  const contributor = await as("contrib@review.test");
  expect((await call(`/api/changes/${change.id}/review`, { verdict: "comment", body: "looks close" }, contributor)).status).toBe(200);
  expect((await call(`/api/changes/${change.id}/review`, { verdict: "approve" }, contributor)).status).toBe(403);
  expect((await call(`/api/changes/${change.id}/review`, { verdict: "request_changes", body: "no" }, contributor)).status).toBe(403);
  vi.restoreAllMocks();
});

it("a role with only org.manage gets 403 on DELETE /api/keystore/:id; a role with keystore.write can POST /api/keystore", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO roles VALUES ('org-only', '[\"org.manage\"]'), ('keys', '[\"keystore.write\"]')"),
    env.DB.prepare("INSERT INTO person_roles VALUES ('org@ks.test', 'org-only'), ('keys@ks.test', 'keys')"),
  ]);
  serveCerts();
  onTestFinished(() => vi.restoreAllMocks());
  const status = async (who, method, path) => (await worker.fetch(new Request(`http://cinder.test${path}`, { method, headers: await as(who) }), ACCESS)).status;
  expect(await status("org@ks.test", "DELETE", "/api/keystore/k1")).toBe(403);
  expect(await can(env, "keys@ks.test", "POST", "/api/keystore")).toBe(true);
  expect(await can(env, "keys@ks.test", "GET", "/api/keystore/usage")).toBe(false);
});

it("after DELETE /api/people/:email the person has no account git role", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO accounts (id, name, slug, created_at) VALUES ('a-gone', 'Gone', 'gone', '2026-10-12')"),
    env.DB.prepare("INSERT INTO people (email, created_at) VALUES ('gone@people.test', '2026-10-12')"),
    env.DB.prepare("INSERT INTO account_members VALUES ('a-gone', 'gone@people.test', 'maintainer', 'direct')"),
  ]);
  const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}` };
  expect((await worker.fetch(new Request("http://cinder.test/api/people/gone%40people.test", { method: "DELETE", headers: OWNER }), env)).status).toBe(204);
  expect(await env.DB.prepare("SELECT 1 FROM account_members WHERE person = 'gone@people.test'").first()).toBeNull();
});

it("PATCH /api/people/:email {role:\"toString\"} answers 400", async () => {
  await env.DB.prepare("INSERT INTO people (email, created_at) VALUES ('ts@people.test', '2026-10-12')").run();
  const OWNER = { Authorization: `Bearer ${env.OWNER_TOKEN}`, "Content-Type": "application/json" };
  const res = await worker.fetch(new Request("http://cinder.test/api/people/ts%40people.test", { method: "PATCH", headers: OWNER, body: JSON.stringify({ role: "toString" }) }), env);
  expect(res.status).toBe(400);
});

it("a person invited as contributor to only repo A gets 200 on GET /api/repos listing only A", async () => {
  serveCerts();
  onTestFinished(() => vi.restoreAllMocks());
  await env.DB.batch([
    env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('sel-a', 'sel-a', 'main', 'trunk', '{}', '2026-10-12'), ('sel-b', 'sel-b', 'main', 'trunk', '{}', '2026-10-12')"),
    env.DB.prepare("INSERT INTO repo_roles VALUES ('sel-a', 'sel@people.test', 'contributor')"),
  ]);
  const get = async (path) => worker.fetch(new Request(`http://cinder.test${path}`, { headers: await as("sel@people.test") }), ACCESS);
  const res = await get("/api/repos");
  expect(res.status).toBe(200);
  expect((await res.json()).map((r) => r.name)).toEqual(["sel-a"]);
  expect((await get("/api/workers/pools")).status).toBe(200);
});

it("writing a repo's judges or airlock needs branch.write, not repo.write", async () => {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES ('jr1', 'judge-roles', 'main', 'trunk', '{}', '2026-10-14')"),
    env.DB.prepare("INSERT INTO repo_roles VALUES ('jr1', 'dev@judges.test', 'developer'), ('jr1', 'mt@judges.test', 'maintainer')"),
  ]);
  for (const path of ["/api/repos/judge-roles/judges/risk", "/api/repos/judge-roles/judges/risk/airlock", "/api/repos/judge-roles/airlock"]) {
    expect(await can(env, "dev@judges.test", "PUT", path)).toBe(false);
    expect(await can(env, "mt@judges.test", "PUT", path)).toBe(true);
  }
  expect(await can(env, "dev@judges.test", "GET", "/api/repos/judge-roles/judges")).toBe(true);
});
