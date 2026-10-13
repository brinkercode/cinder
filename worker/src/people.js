// People and roles, with a capability matrix per role.
import { accessOn, isOwnerEmail, personOf } from "./access.js";
import { AGENTS_REPO } from "./agents.js";
import { cloudflare } from "./deploy.js";
import { error } from "./router.js";

const CAPABILITIES = ["repo.read", "repo.write", "change.approve", "branch.write", "agent.release", "keystore.read", "keystore.write", "people.manage", "org.manage", "repo.archive"];
const MAINTAINER = ["repo.read", "repo.write", "change.approve", "branch.write", "agent.release", "keystore.read", "repo.archive"];
const BUILT_IN = {
  owner: CAPABILITIES, admin: CAPABILITIES, maintainer: MAINTAINER, contributor: ["repo.read", "repo.write"], developer: ["repo.read", "repo.write"], viewer: ["repo.read"],
};
export const EMAIL = /^[^\s@]+@[^\s@]+$/;

// The capability a person needs for a route. Writes outside one repo or change (new repos, runners, findings) are org.manage.
function capabilityOf(method, pathname) {
  if (/^\/api\/(people|invites|service-tokens|roles|groups|repos\/[^/]+\/people)(\/|$)/.test(pathname) && method !== "GET") return "people.manage";
  if (/\/(signing-key|secrets)(\/|$)/.test(pathname)) return method === "GET" ? "keystore.read" : "keystore.write";
  if (method === "GET" && /^\/api\/keystore(\/usage|\/[^/]+\/audit)?$/.test(pathname)) return "keystore.read";
  if (method !== "GET" && /^\/api\/keystore(\/|$)/.test(pathname)) return "keystore.write";
  // Service tokens, people (org-wide and per repo) and webhook URLs (credentials for some receivers) are for their managers only.
  if (method === "GET" && /^\/api\/(service-tokens|people|repos\/[^/]+\/(webhooks|people))$/.test(pathname)) return ["people.manage", "org.manage"];
  if (/^\/api\/repos\/[^/]+\/webhooks(\/|$)/.test(pathname)) return ["people.manage", "org.manage"];
  if (/^\/api\/workers\/byo-pools\/[^/]+\/tokens(\/|$)/.test(pathname)) return "org.manage";
  if (/^\/api\/agents\/[^/]+\/egress$/.test(pathname)) return "org.manage";
  if (/^\/api\/agents\//.test(pathname) && method !== "GET") return "agent.release";
  // A tagged commit to the agents repo is a release, so every write there needs agent.release.
  if ((pathname === `/api/repos/${AGENTS_REPO}` || pathname.startsWith(`/api/repos/${AGENTS_REPO}/`)) && method !== "GET") return "agent.release";
  if (/^\/api\/repos\/[^/]+\/branches(\/|$)/.test(pathname) && method !== "GET") return "branch.write";
  if (/^\/api\/repos\/[^/]+\/archive$/.test(pathname)) return "repo.archive";
  // The branch policy sets judges and approvers, so repo.write is not enough to write it (policy.js, commits.js).
  if (/^\/api\/repos\/[^/]+\/policy$/.test(pathname) && method !== "GET") return "branch.write";
  // review can approve (reviewChange calls approveChange), so it needs approve too; reviewChange lets a comment through on repo.write.
  if (/^\/api\/changes\/[^/]+\/(deps\/approve|review)$/.test(pathname)) return "change.approve";
  if (method === "GET" || pathname === "/api/live-ticket") return "repo.read";
  return /^\/api\/(repos|changes|leases)\/[^/]+(\/|$)/.test(pathname) ? "repo.write" : "org.manage";
}

// Whether email's roles (own, the per-repo override and the account Git role for the route's repo) grant the
// route's capability. account is the caller's active account: creating a repo there needs admin on it (or org.manage).
// groups are the caller's Access groups (groupsOf): their access_groups roles count too, on every repo or the mapping's repos.
export async function can(env, email, method, pathname, account = null, groups = { idp: "", names: [] }) {
  const capabilities = [capabilityOf(method, pathname)].flat();
  // The repo list and pool list name no repo: a role on any repo counts there (listRepos then shows only readable repos).
  const anyRepo = method === "GET" && /^\/api\/(repos|workers\/pools)$/.test(pathname);
  const results = await rolesOf(env, email, pathname, method === "POST" && pathname === "/api/repos" ? account : null, groups, anyRepo);
  return results.some((r) => capabilities.some((c) => (Object.hasOwn(BUILT_IN, r.role) ? BUILT_IN[r.role] : JSON.parse(r.capabilities ?? "[]")).includes(c)));
}

// The roles email holds on the repo or change pathname names (own, per-repo, account Git role, Access groups), each
// {role, capabilities}; target is an account whose membership counts too. A group mapping counts only for the request's
// IdP: its source names that IdP's id in parentheses ("IdP group (<IdP id>)"), or names none when the request has no IdP.
// With anyRepo, a role on any repo counts.
export async function rolesOf(env, email, pathname, target = null, groups = { idp: "", names: [] }, anyRepo = false) {
  const { idp = "", names = [] } = groups; // needs.js passes [] for no groups
  const repo = /^\/api\/repos\/([^/]+)(?:\/|$)/.exec(pathname)?.[1] ?? null;
  const change = /^\/api\/(?:changes|leases)\/([^/]+)(?:\/|$)/.exec(pathname)?.[1] ?? null;
  const repoIds = anyRepo ? "SELECT id FROM repos" : "SELECT id FROM repos WHERE name = ?2 UNION SELECT repo_id FROM changes WHERE id = ?3";
  const { results } = await env.DB.prepare(
    "SELECT r.role, c.capabilities FROM (SELECT role FROM person_roles WHERE email = ?1 " +
    `UNION SELECT role FROM repo_roles WHERE person = ?1 AND repo_id IN (${repoIds}) ` +
    "UNION SELECT CASE git_role WHEN 'reader' THEN 'viewer' ELSE git_role END FROM account_members WHERE person = ?1 " +
    `AND account_id IN (SELECT account_id FROM repo_accounts WHERE repo_id IN (${repoIds}) UNION SELECT ?4) ` +
    "UNION SELECT role FROM access_groups g WHERE name IN (SELECT value FROM json_each(?5)) " +
    "AND CASE ?6 WHEN '' THEN instr(g.source, '(') = 0 ELSE lower(substr(g.source, -length(?6))) = ?6 END AND (repos = '[]' OR EXISTS " +
    `(SELECT 1 FROM json_each(g.repos) j JOIN repos x ON x.name = j.value WHERE x.id IN (${repoIds})))) r ` +
    "LEFT JOIN roles c ON c.name = r.role",
  ).bind(email, repo && decodeURIComponent(repo), change && decodeURIComponent(change), target, JSON.stringify(names), idp && `(${idp.toLowerCase()})`).all();
  return results;
}

// OWNERS and every person with a role (own, per-repo, account member) for whom test(email) holds. Access groups come
// from a request, so a person who is an approver only through a group isn't listed.
// lazy: one test per person with a role; list from one query past a few hundred people.
export async function peopleWhere(env, test) {
  const { results } = await env.DB.prepare("SELECT email AS p FROM person_roles UNION SELECT person FROM repo_roles UNION SELECT person FROM account_members").all();
  const ok = await Promise.all(results.map((r) => test(r.p)));
  const owners = (env.OWNERS ?? "").split(",").map((o) => o.trim().toLowerCase()).filter(Boolean);
  return [...new Set([...owners, ...results.filter((r, i) => ok[i]).map((r) => r.p)])];
}

const isRole = async (env, role) => typeof role === "string" && (Object.hasOwn(BUILT_IN, role) || Boolean(await env.DB.prepare("SELECT 1 FROM roles WHERE name = ?").bind(role).first()));

// Adds or removes email in the Access app's "owners" policy (the one install.sh creates), so a role is also a sign-in.
// An error message when the app or policy is missing. Service tokens and OWNERS are left alone on removal.
// lazy: read-modify-write, two grants in the same instant can drop one; move to a reusable policy if that bites.
async function syncPolicy(env, email, add) {
  if (!accessOn(env) || email.endsWith("@service-token") || (!add && isOwnerEmail(env, email))) return null;
  const apps = `/accounts/${env.CF_ACCOUNT_ID}/access/apps`;
  const app = (await cloudflare(env, apps)).result.find((a) => a.aud === env.ACCESS_AUD);
  const policy = app && (await cloudflare(env, `${apps}/${app.id}/policies`)).result.find((p) => p.name === "owners");
  if (!policy) return "the Access app's owners policy is missing: re-run make up";
  const include = policy.include.filter((r) => r.email?.email?.toLowerCase() !== email);
  if (add) include.push({ email: { email } });
  await cloudflare(env, `${apps}/${app.id}/policies/${policy.id}`, {
    method: "PUT", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: policy.name, decision: policy.decision, include, exclude: policy.exclude ?? [], require: policy.require ?? [] }),
  });
  return null;
}

// Every email the cinder Access app's allow policies admit, directly or through an Access group they include, with when that
// policy last changed: people invited in the Cloudflare dashboard as well as from cinder. [] with Access off or unreadable.
// lazy: two to four Cloudflare calls per People load; cache in KV if the page gets slow.
export async function accessEmails(env) {
  if (!accessOn(env)) return [];
  try {
    const base = `/accounts/${env.CF_ACCOUNT_ID}/access`;
    const app = (await cloudflare(env, `${base}/apps`)).result.find((a) => a.aud === env.ACCESS_AUD);
    if (!app) return [];
    const out = new Map();
    for (const p of (await cloudflare(env, `${base}/apps/${app.id}/policies`)).result.filter((p) => p.decision === "allow")) {
      const rules = [...(p.include ?? [])];
      for (const r of p.include ?? []) if (r.group?.id) rules.push(...((await cloudflare(env, `${base}/groups/${r.group.id}`)).result?.include ?? []));
      for (const r of rules) {
        const email = r.email?.email?.toLowerCase();
        if (email && !out.has(email)) out.set(email, p.updated_at ?? p.created_at ?? null);
      }
    }
    return [...out].map(([email, at]) => ({ email, at }));
  } catch {
    return [];
  }
}

// GET /api/people → Person[] (api/shapes/person.js): cinder's people, then everyone else the Access app admits (invited "access").
export async function listPeople(request, env) {
  const [{ results }, admitted] = await Promise.all([env.DB.prepare("SELECT p.email, r.role, p.created_at, s.at AS last_seen FROM people p " +
    "LEFT JOIN person_roles r ON r.email = p.email LEFT JOIN people_seen s ON s.email = p.email ORDER BY p.email").all(), accessEmails(env)]);
  const rows = results.map((p) => ({ email: p.email, owner: isOwnerEmail(env, p.email), role: p.role, created_at: p.created_at, last_seen: p.last_seen }));
  const known = new Set(rows.map((p) => p.email));
  for (const { email, at } of admitted) {
    if (!known.has(email)) rows.push({ email, owner: isOwnerEmail(env, email), role: null, created_at: at ?? new Date().toISOString(), last_seen: null, invited: "access" });
  }
  return Response.json(rows.sort((a, b) => a.email.localeCompare(b.email)));
}

// Whether person (or the Access group mapping named group) is the only owner among the OWNERS emails, person_roles
// and the every-repo group mappings.
async function lastOwner(env, person, group = null) {
  const { results } = await env.DB.prepare("SELECT email, NULL AS name FROM person_roles WHERE role = 'owner' " +
    "UNION SELECT lower(trim(value)), NULL FROM json_each(?) WHERE trim(value) != '' " +
    "UNION SELECT NULL, name FROM access_groups WHERE role = 'owner' AND repos = '[]'").bind(JSON.stringify((env.OWNERS ?? "").split(","))).all();
  return results.length === 1 && results[0].email === person && results[0].name === group;
}

// POST /api/people {email, role}: gives them the role in cinder and adds them to the Access policy so they can sign in.
export async function addPerson(request, env) {
  const { email, role } = (await request.json().catch(() => null)) ?? {};
  if (typeof email !== "string" || !EMAIL.test(email) || !(await isRole(env, role))) return error(400, "bad_request", "body must be {email, role: an existing role}");
  const person = email.toLowerCase();
  if (role !== "owner" && (await lastOwner(env, person))) return error(409, "last_owner", `${person} is the last owner`);
  const failed = await syncPolicy(env, person, true);
  if (failed) return error(409, "no_access_policy", failed);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO people (email, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(person, new Date().toISOString()),
    env.DB.prepare("INSERT INTO person_roles VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role").bind(person, role),
  ]);
  return Response.json({ email: person, role }, { status: 201 });
}

// PATCH /api/people/:email {role}: changes their cinder role; the last owner can't be demoted.
export async function setPersonRole(request, env, { email }) {
  const { role } = (await request.json().catch(() => null)) ?? {};
  if (!(await isRole(env, role))) return error(400, "bad_request", "body must be {role: an existing role}");
  const person = decodeURIComponent(email).toLowerCase();
  if (!(await env.DB.prepare("SELECT 1 FROM people WHERE email = ?").bind(person).first())) {
    // Someone the Access app admits but cinder hasn't seen (invited in the Cloudflare dashboard) becomes a person here.
    if (!(await accessEmails(env)).some((a) => a.email === person)) return error(404, "not_found", `no person ${person}`);
    await env.DB.prepare("INSERT INTO people (email, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(person, new Date().toISOString()).run();
  }
  if (role !== "owner" && (await lastOwner(env, person))) return error(409, "last_owner", `${person} is the last owner`);
  await env.DB.prepare("INSERT INTO person_roles VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role").bind(person, role).run();
  return Response.json({ email: person, role });
}

// POST /api/invites {emails, role, repos} → Invite (api/shapes/invite.js): gives each email the role on every repo
// (repos []) or only on the named repos, and adds them to the Access policy so they can sign in.
export async function addInvites(request, env) {
  const { emails, role, repos } = (await request.json().catch(() => null)) ?? {};
  if (!Array.isArray(emails) || !emails.length || !emails.every((e) => typeof e === "string" && EMAIL.test(e)) || !(await isRole(env, role)) ||
    !Array.isArray(repos) || !repos.every((r) => typeof r === "string" && r)) {
    return error(400, "bad_request", "body must be {emails: [email], role: an existing role, repos: [repo name]}");
  }
  const people = [...new Set(emails.map((e) => e.toLowerCase()))];
  const ids = (await env.DB.prepare("SELECT id FROM repos WHERE name IN (SELECT value FROM json_each(?))").bind(JSON.stringify(repos)).all()).results.map((r) => r.id);
  if (ids.length !== new Set(repos).size) return error(404, "not_found", "a named repo doesn't exist");
  for (const person of people) {
    if (!repos.length && role !== "owner" && (await lastOwner(env, person))) return error(409, "last_owner", `${person} is the last owner`);
  }
  for (const person of people) {
    const failed = await syncPolicy(env, person, true);
    if (failed) return error(409, "no_access_policy", failed);
  }
  const now = new Date().toISOString();
  await env.DB.batch(people.flatMap((person) => [
    env.DB.prepare("INSERT INTO people (email, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(person, now),
    ...(ids.length ? ids.flatMap((id) => [
      env.DB.prepare("INSERT INTO repo_roles VALUES (?, ?, ?) ON CONFLICT (repo_id, person) DO UPDATE SET role = excluded.role").bind(id, person, role),
      env.DB.prepare("INSERT OR REPLACE INTO repo_role_grants (repo_id, person, set_by, at) VALUES (?, ?, ?, ?)").bind(id, person, personOf(request), now),
    ]) : [env.DB.prepare("INSERT INTO person_roles VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET role = excluded.role").bind(person, role)]),
  ]));
  return Response.json({ emails: people, role, repos }, { status: 201 });
}

// DELETE /api/people/:email: their roles in cinder (account Git roles too) and their entry in the Access policy.
export async function removePerson(request, env, { email }) {
  const person = decodeURIComponent(email).toLowerCase();
  if (await lastOwner(env, person)) return error(409, "last_owner", `${person} is the last owner`);
  const failed = await syncPolicy(env, person, false);
  if (failed) return error(409, "no_access_policy", failed);
  await env.DB.batch(["DELETE FROM people WHERE email = ?", "DELETE FROM person_roles WHERE email = ?", "DELETE FROM repo_roles WHERE person = ?", "DELETE FROM repo_role_grants WHERE person = ?",
    "DELETE FROM account_members WHERE person = ?"].map((q) => env.DB.prepare(q).bind(person)));
  return new Response(null, { status: 204 });
}

// PUT /api/roles/:role {capabilities}: a custom role. Built-in roles can't be redefined.
export async function putRole(request, env, { role }) {
  const { capabilities } = (await request.json().catch(() => null)) ?? {};
  if (role in BUILT_IN) return error(409, "built_in_role", `${role} is a built-in role`);
  if (!Array.isArray(capabilities) || !capabilities.every((c) => CAPABILITIES.includes(c))) {
    return error(400, "bad_request", `capabilities must be a list of: ${CAPABILITIES.join(", ")}`);
  }
  await env.DB.prepare("INSERT INTO roles VALUES (?, ?) ON CONFLICT (name) DO UPDATE SET capabilities = excluded.capabilities").bind(role, JSON.stringify(capabilities)).run();
  return Response.json({ name: role, capabilities });
}

// GET /api/roles → [{name, capabilities, built_in}]: the built-in roles, then the custom ones by name.
export async function listRoles(request, env) {
  const { results } = await env.DB.prepare("SELECT name, capabilities FROM roles ORDER BY name").all();
  return Response.json([...Object.entries(BUILT_IN).map(([name, capabilities]) => ({ name, capabilities, built_in: true })),
    ...results.map((r) => ({ name: r.name, capabilities: JSON.parse(r.capabilities), built_in: false }))]);
}

// GET /api/repos/:name/people → [{email, role, set_by, at}] by email; set_by and at are null for roles set before
// they were recorded.
export async function listRepoRoles(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const { results } = await env.DB.prepare(`SELECT r.person AS email, r.role, g.set_by, g.at FROM repo_roles r
    LEFT JOIN repo_role_grants g ON g.repo_id = r.repo_id AND g.person = r.person WHERE r.repo_id = ? ORDER BY r.person`).bind(repo.id).all();
  return Response.json(results);
}

// DELETE /api/repos/:name/people/:email → 204: drops the person's repo role; their own role stays.
export async function deleteRepoRole(request, env, { name, email }) {
  const person = decodeURIComponent(email).toLowerCase();
  await env.DB.batch(["DELETE FROM repo_role_grants", "DELETE FROM repo_roles"].map((q) =>
    env.DB.prepare(`${q} WHERE person = ? AND repo_id = (SELECT id FROM repos WHERE name = ?)`).bind(person, name)));
  return new Response(null, { status: 204 });
}

// PUT /api/repos/:name/people/:email {role}: a per-repo role on top of the person's own, recording who set it and when.
export async function putRepoRole(request, env, { name, email }) {
  const { role } = (await request.json().catch(() => null)) ?? {};
  if (!(await isRole(env, role))) return error(400, "bad_request", "body must be {role: an existing role}");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const person = decodeURIComponent(email).toLowerCase();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO repo_roles VALUES (?, ?, ?) ON CONFLICT (repo_id, person) DO UPDATE SET role = excluded.role").bind(repo.id, person, role),
    env.DB.prepare("INSERT OR REPLACE INTO repo_role_grants (repo_id, person, set_by, at) VALUES (?, ?, ?, ?)").bind(repo.id, person, personOf(request), new Date().toISOString()),
  ]);
  return Response.json({ repo: name, email: person, role });
}

// GET /api/groups → Group[] (api/shapes/group.js): each group's source, role and repos ([] is every repo).
export async function listGroups(request, env) {
  const { results } = await env.DB.prepare("SELECT name, source, role, repos FROM access_groups ORDER BY name").all();
  return Response.json(results.map((g) => ({ ...g, repos: JSON.parse(g.repos) })));
}

// PUT /api/groups/:group {source, role, repos}, or POST /api/groups {name, source, role, repos}: maps a group to a
// cinder role. Members get it from their next request, since groups come from each request's Access JWT.
export async function putGroup(request, env, { group }) {
  const body = (await request.json().catch(() => null)) ?? {};
  const { source, role, repos } = body;
  const name = group ? decodeURIComponent(group) : body.name;
  if (typeof name !== "string" || !name || typeof source !== "string" || !source.trim() || !(await isRole(env, role)) || !Array.isArray(repos) || !repos.every((r) => typeof r === "string" && r)) {
    return error(400, "bad_request", "body must be {name, source, role: an existing role, repos: [repo name]}");
  }
  if ((role !== "owner" || repos.length) && (await lastOwner(env, null, name))) return error(409, "last_owner", `${name} grants the last owner`);
  await env.DB.prepare("INSERT INTO access_groups VALUES (?, ?, ?, ?) ON CONFLICT (name) DO UPDATE SET source = excluded.source, role = excluded.role, repos = excluded.repos")
    .bind(name, source.trim(), role, JSON.stringify(repos)).run();
  return Response.json({ name, source: source.trim(), role, repos });
}

// DELETE /api/groups/:group: the mapping that grants the last owner can't be removed.
export async function deleteGroup(request, env, { group }) {
  const name = decodeURIComponent(group);
  if (await lastOwner(env, null, name)) return error(409, "last_owner", `${name} grants the last owner`);
  await env.DB.prepare("DELETE FROM access_groups WHERE name = ?").bind(name).run();
  return new Response(null, { status: 204 });
}
