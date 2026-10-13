// Accounts and organizations: a repo belongs to one account (repo_accounts), and account_members decides who may do
// what in it (people.js can()). The instance's own account is backfilled by the accounts migration.
import { isOwnerEmail, personOf } from "./access.js";
import { cloudflare } from "./deploy.js";
import { can, EMAIL } from "./people.js";
import { error } from "./router.js";

const INSTANCE_ACCOUNT = "instance";
const GIT_ROLES = ["admin", "maintainer", "contributor", "reader"];
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;

// The caller's active account: the cinder_account cookie, else the instance's own account.
export function activeAccount(request) {
  return /(?:^|;\s*)cinder_account=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1] ?? INSTANCE_ACCOUNT;
}

// Whether the caller may install agents into account: an instance owner, or the same right as creating a repo there (Git Admin).
export function gitAdmin(request, env, account) {
  const person = personOf(request);
  return person === "owner" || isOwnerEmail(env, person) || can(env, person, "POST", "/api/repos", account);
}

// GET /api/accounts → [AccountChoice]: every account, each with whether the caller may install agents into it.
// lazy: one role query per account; fold into one query past a few dozen accounts.
export async function listAccounts(request, env) {
  const { results } = await env.DB.prepare("SELECT id, name, slug FROM accounts ORDER BY name").all();
  return Response.json(await Promise.all(results.map(async (a) => ({ ...a, can_install: await gitAdmin(request, env, a.id) }))));
}

// Hourly (index.js scheduled): records the instance's Cloudflare account id, then, when the token can read an
// organization, upserts it, its accounts and its members. Org members get source='org' rows on every child account,
// replaced each run so a removed member loses them; direct rows are left alone. A token without the Organizations
// permission (403) or a plan without Organizations (404) skips that part quietly.
export async function syncAccounts(env, fetcher = fetch) {
  const { result: own } = await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}`, {}, fetcher);
  await env.DB.prepare("UPDATE accounts SET cf_account_id = ? WHERE id = ? AND cf_account_id IS NULL").bind(own.id, INSTANCE_ACCOUNT).run();
  let orgs;
  try {
    ({ result: orgs } = await cloudflare(env, "/organizations", {}, fetcher));
  } catch (e) {
    if (e.status === 403 || e.status === 404) return;
    throw e;
  }
  const at = new Date().toISOString();
  for (const org of orgs) {
    const [{ result: accounts }, { result: members }] = await Promise.all([
      cloudflare(env, `/organizations/${org.id}/accounts`, {}, fetcher), cloudflare(env, `/organizations/${org.id}/members`, {}, fetcher)]);
    // An account already known by its Cloudflare id (the instance's own) keeps its cinder id; a new one takes the Cloudflare id.
    const ids = `(SELECT id FROM accounts WHERE cf_account_id IN (SELECT value FROM json_each(?)))`;
    await env.DB.batch([
      env.DB.prepare("INSERT INTO organizations (id, name, cf_org_id) VALUES (?1, ?2, ?1) ON CONFLICT (cf_org_id) DO UPDATE SET name = excluded.name").bind(org.id, org.name),
      ...accounts.map((a) => env.DB.prepare("INSERT INTO accounts (id, name, slug, org_id, cf_account_id, created_at) VALUES (?1, ?2, ?1, (SELECT id FROM organizations WHERE cf_org_id = ?3), ?1, ?4) " +
        "ON CONFLICT (cf_account_id) DO UPDATE SET name = excluded.name, org_id = excluded.org_id").bind(a.id, a.name, org.id, at)),
      env.DB.prepare(`DELETE FROM account_members WHERE source = 'org' AND account_id IN ${ids}`).bind(JSON.stringify(accounts.map((a) => a.id))),
      ...members.filter((m) => EMAIL.test(m.email ?? "")).map((m) => env.DB.prepare(`INSERT INTO account_members (account_id, person, git_role, source) SELECT id, ?, ?, 'org' FROM ${ids} WHERE true ` +
        "ON CONFLICT (account_id, person) DO NOTHING").bind(m.email.toLowerCase(), m.role === "admin" ? "admin" : "reader", JSON.stringify(accounts.map((a) => a.id)))),
    ]);
  }
}

// POST /api/accounts {name, slug, organization?} → 201 {id, name, slug, org_id}: a hand-added account, in a new or
// existing organization named `organization`.
export async function createAccount(request, env) {
  const { name, slug, organization } = (await request.json().catch(() => null)) ?? {};
  if (typeof name !== "string" || !name.trim() || typeof slug !== "string" || !SLUG.test(slug) || (organization !== undefined && (typeof organization !== "string" || !organization.trim()))) {
    return error(400, "bad_request", "body must be {name, slug: [a-z0-9-], organization?: name}");
  }
  if (await env.DB.prepare("SELECT 1 FROM accounts WHERE slug = ?").bind(slug).first()) return error(409, "conflict", `account ${slug} exists`);
  const id = crypto.randomUUID();
  const org = organization?.trim() ?? null;
  const orgId = org && ((await env.DB.prepare("SELECT id FROM organizations WHERE name = ?").bind(org).first("id")) ?? crypto.randomUUID());
  await env.DB.batch([
    ...(org ? [env.DB.prepare("INSERT OR IGNORE INTO organizations (id, name) VALUES (?, ?)").bind(orgId, org)] : []),
    env.DB.prepare("INSERT INTO accounts (id, name, slug, org_id, created_at) VALUES (?, ?, ?, ?, ?)").bind(id, name.trim(), slug, orgId, new Date().toISOString()),
  ]);
  return Response.json({ id, name: name.trim(), slug, org_id: orgId }, { status: 201 });
}

// POST /api/accounts/:id/members {person, git_role} → 204: a direct member, replacing any role they had there.
export async function addAccountMember(request, env, { id }) {
  const { person, git_role: role } = (await request.json().catch(() => null)) ?? {};
  if (typeof person !== "string" || !EMAIL.test(person) || !GIT_ROLES.includes(role)) {
    return error(400, "bad_request", `body must be {person: email, git_role: one of ${GIT_ROLES.join(", ")}}`);
  }
  if (!(await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(id).first())) return error(404, "not_found", `no account ${id}`);
  await env.DB.prepare("INSERT INTO account_members VALUES (?, ?, ?, 'direct') ON CONFLICT (account_id, person) DO UPDATE SET git_role = excluded.git_role, source = 'direct'")
    .bind(id, person.toLowerCase(), role).run();
  return new Response(null, { status: 204 });
}

// The accounts person reaches, each with their Git role, whether it comes through the organization, and its repo
// count. An instance owner reaches every account as admin.
async function reachable(env, person, owner) {
  const { results } = await env.DB.prepare(
    "SELECT a.id, a.name, a.slug, a.org_id, o.name AS org, a.personal_of, m.git_role, m.source, " +
    "(SELECT count(*) FROM repo_accounts WHERE account_id = a.id) AS repos FROM accounts a LEFT JOIN organizations o ON o.id = a.org_id " +
    "LEFT JOIN account_members m ON m.account_id = a.id AND m.person = ?1 WHERE m.person IS NOT NULL OR ?2 ORDER BY a.name",
  ).bind(person, owner ? 1 : 0).all();
  return results;
}

// GET /api/me/accounts → AccountList: the caller's organization and its accounts, then the account outside it.
// lazy: shows one organization and one account outside it; list every one when a person reaches several.
export async function myAccounts(request, env) {
  const person = personOf(request);
  const rows = await reachable(env, person, person === "owner" || isOwnerEmail(env, person));
  const current = activeAccount(request);
  const json = (a) => {
    const role = a.git_role ?? "admin";
    return { id: a.id, name: a.name, slug: a.slug, git_role: role, implicit: a.source === "org", repos: a.repos, can_create: role === "admin", current: a.id === current };
  };
  const org = (rows.find((a) => a.id === current && a.org_id) ?? rows.find((a) => a.org_id))?.org_id;
  const outside = rows.filter((a) => a.org_id !== org).sort((a, b) => (b.personal_of === person) - (a.personal_of === person));
  return Response.json({
    ...(org && { organization: { id: org, name: rows.find((a) => a.org_id === org).org } }),
    accounts: rows.filter((a) => !org || a.org_id === org).map(json),
    ...(org && outside.length && { personal: json(outside[0]) }),
  });
}

// POST /api/me/accounts/:id/switch → 204: makes id the caller's active account (the cinder_account cookie), only
// for an account they reach.
export async function switchAccount(request, env, { id }) {
  const person = personOf(request);
  if (!(await reachable(env, person, person === "owner" || isOwnerEmail(env, person))).some((a) => a.id === id)) {
    return error(403, "forbidden", `you are not a member of account ${id}`);
  }
  return new Response(null, { status: 204, headers: { "Set-Cookie": `cinder_account=${id}; Path=/; HttpOnly; SameSite=Lax; Secure` } });
}
