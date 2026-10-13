import { asCaller, groupsOf, isOwnerEmail, personOf } from "./access.js";
import { queueChange } from "./change-view.js";
import { approveChange, approveDeps, closeChange, createChange, reviewChange } from "./changes.js";
import { fixFinding } from "./findings.js";
import { releaseQuarantine } from "./flakes.js";
import { settleQuarantine } from "./quarantine.js";
import { can, peopleWhere, rolesOf } from "./people.js";
import { accountOf, budgetUse } from "./overview.js";
import { approvePromote } from "./releases.js";
import { error } from "./router.js";
import { driveAs } from "./takeover.js";

const shape = (r) => ({ id: r.id, kind: r.kind, repo: r.repo, change: r.change_id, text: r.text, actions: JSON.parse(r.actions),
  ...(r.agent && { agent: r.agent }), ...(r.page && { page: r.page }) });

// Actions that only navigate (the page does it); they never resolve an item.
const NAVIGATE = ["Open change", "Watchtower", "Open page", "Open Insights", "Edit alerts", "Edit"];

// Actions that run their operation and leave the item open for a further decision.
const KEEP_OPEN = ["Raise budget"];

// The operation behind a decision, keyed by "kind|action" ("Grant to <person>" is "Grant"): [the route it stands for,
// whose capability a person needs, or a function of (need row, subject) giving the full path, and
// run(request, env, need row, subject, request body) → Response]. Any other action only resolves.
const OPS = {
  // Agent work is paused while spend is at or over the budget (DispatchDO.claim); org.manage sets a new one.
  "Budget reached|Raise budget": [() => "/api/account", async (request, env, n, s, { amount }) => {
    if (!(Number.isInteger(amount) && amount > 0)) return error(400, "bad_request", "amount: expected an integer > 0");
    await env.DB.prepare("UPDATE account SET budget_tokens = ? WHERE id = 1").bind(amount).run();
    return new Response(null, { status: 204 });
  }],
  "Budget reached|Resume": [() => "/api/account", async (request, env) => ((await budgetUse(env.DB)).paused
    ? error(409, "over_budget", "this month's spend is at or over the budget; raise it first") : new Response(null, { status: 204 }))],
  "Judges disagree|Merge": ["approve", (request, env, n) => queueChange(request, env, { id: n.change_id }, true)],
  "Judges disagree|Reject": ["close", (request, env, n) => closeChange(request, env, { id: n.change_id })],
  // The person's approval replaces the agent review the untrusted judge asked for.
  "Untrusted judge|Approve change": ["approve", async (request, env, n) => {
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(n.change_id));
    const change = await stub.get();
    if (!change) return error(404, "not_found", `no change ${n.change_id}`);
    await env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE change_id = ? AND kind = 'review' AND status IN ('queued', 'claimed')")
      .bind(n.change_id).run();
    await stub.setReview({ ...change.review, route: "human", reason: "approved over an untrusted judge" });
    const verifying = await env.DB.prepare("SELECT 1 FROM jobs WHERE change_id = ? AND kind = 'verify' AND status IN ('queued', 'claimed') AND id NOT IN (SELECT job_id FROM job_cancels)")
      .bind(n.change_id).first();
    // Verified: approve and queue as Add to merge queue does (queueBlocker only, whatever auto-queue says); held by
    // something else (a requested reviewer), the approval still stands. Still verifying: the passing verify queues it (work.js).
    if (!verifying) {
      const queued = await queueChange(request, env, { id: n.change_id }, true);
      return queued.ok ? queued : approveChange(request, env, { id: n.change_id });
    }
    return Response.json(await stub.approve({ type: "human", id: personOf(request) }));
  }],
  "Change quarantined|Release": ["quarantine", (request, env, n) => settleQuarantine(asCaller(request, request.url, { method: "POST", body: JSON.stringify({ action: "release" }) }), env, { id: n.change_id })],
  "Dependency needs approval|Approve": ["deps/approve", (request, env, n) => approveDeps(request, env, { id: n.change_id })],
  // reason: the person's own words for the author, else the item's text.
  "Dependency needs approval|Reject": ["review", (request, env, n, s, { reason }) => reviewChange(asCaller(request, request.url, { method: "POST", headers: request.headers,
    body: JSON.stringify({ verdict: "request_changes", body: `Dependency rejected: ${typeof reason === "string" && reason.trim() ? reason.trim() : n.text}` }) }), env, { id: n.change_id })],
  "Lease takeover|Grant": ["takeover", (request, env, n, s) => (n.change_id && typeof s.person === "string"
    ? driveAs(env, n.change_id, s.person) : error(409, "no_subject", "this lease takeover names no leased change and person"))],
  // The package's open critical dependency finding is fixed as from Watchtower, reusing its open fix change.
  // lazy: a package with two critical advisories fixes the oldest finding; carry the fingerprint in the subject if that misleads.
  "Critical advisory|Open fix change": [null, async (request, env, n, s) => {
    if (typeof s.package !== "string") return error(409, "no_subject", "this advisory names no package");
    const id = await env.DB.prepare("SELECT f.id FROM findings f JOIN repos r ON r.id = f.repo_id WHERE r.name = ?1 AND f.source = 'dependency' " +
      "AND f.severity = 'critical' AND f.state = 'open' AND substr(f.path, 1, length(?2) + 1) = ?2 || '@' ORDER BY f.id LIMIT 1").bind(n.repo, s.package).first("id");
    if (!id) return error(409, "no_subject", `no open critical finding on ${s.package}`);
    return fixFinding(request, env, { id });
  }],
  "Release approval|Approve": [(n, s) => `/api/repos/${n.repo}/environments/${s.env}/promote`, approvePromote],
  "Test quarantined|Release": [(n, s) => `/api/repos/${n.repo}/quarantine/${encodeURIComponent(s.test)}`,
    (request, env, n, s) => releaseQuarantine(request, env, { name: n.repo, test: encodeURIComponent(s.test) })],
  "Stale wiki page|Mark reviewed": [(n, s) => `/api/repos/${n.repo}/wiki/pages/${s.page}`, async (request, env, n, s) => {
    await env.DB.prepare("DELETE FROM wiki_stale WHERE page_id = ?").bind(s.page ?? null).run();
    return new Response(null, { status: 204 });
  }],
  // agent: the picked agent@version; createChange validates it, and none takes the default developer.
  "Stale wiki page|Hand to agent": [null, (request, env, n, s, { agent }) => {
    const body = JSON.stringify({ intent: `Update wiki page ${s.title}`, ...(agent !== undefined && { agent_version: agent }) });
    return createChange(asCaller(request, request.url, { method: "POST", body }), env, { name: n.repo });
  }],
};

// Approval needs: only the gate's approvers resolve them, by any action.
const GATED = ["Flow approval", "Release approval"];

// Whether person (in Access groups) is an approver of the gated need n with subject s: an owner, or a holder of the role
// s.approvers (the flow step's approval, the environment's approvers). A gate naming no role takes whoever may promote to s.env.
export async function mayApprove(env, person, groups, n, s) {
  if (person === "owner" || isOwnerEmail(env, person)) return true;
  const repo = `/api/repos/${n.repo}`;
  if (!s.approvers) return can(env, person, "POST", `${repo}/environments/${s.env}/promote`, null, groups);
  return (await rolesOf(env, person, repo, null, groups)).some((r) => r.role === s.approvers);
}

// GET /api/needs → [Need]: the open items, oldest first, each with the agent@version that wrote its change (none for a person's)
// and the wiki page it is about. A Judges disagree item shows only while its change is verifying, the one state Merge acts from. An item whose subject names a person ("for") shows only to that person. An approval
// item adds approvers (the gate's role, null for whoever may promote), approver_names (the people who are one) and
// can_resolve (whether the caller is one).
export async function listNeeds(request, env) {
  const { results } = await env.DB.prepare("SELECT n.*, json_extract(c.card, '$.agent') || '@' || json_extract(c.card, '$.ver') AS agent, " +
    "json_extract(s.subject, '$.page') AS page, s.subject FROM needs n LEFT JOIN change_cards c ON c.change_id = n.change_id " +
    "LEFT JOIN need_subjects s ON s.need_id = n.id LEFT JOIN changes ch ON ch.id = n.change_id WHERE n.resolved_at IS NULL " +
    "AND (n.kind <> 'Judges disagree' OR ch.state = 'verifying') AND COALESCE(json_extract(s.subject, '$.for'), ?) = ? " +
    "ORDER BY n.created_at, n.rowid").bind(personOf(request), personOf(request)).all();
  // lazy: one role query per open approval item; batch per repo if approvals pile up.
  return Response.json(await Promise.all(results.map(async (r) => {
    if (!GATED.includes(r.kind)) return shape(r);
    const s = JSON.parse(r.subject ?? "null") ?? {};
    return { ...shape(r), approvers: s.approvers ?? null, approver_names: await peopleWhere(env, (p) => mayApprove(env, p, [], r, s)),
      can_resolve: await mayApprove(env, personOf(request), groupsOf(request), r, s) };
  })));
}

// Raises each need {kind, change, text, actions, subject?} on the repo with id repoId: the same kind, repo and text
// again is the existing item, open or resolved. subject is what a decision acts on beyond the change.
// Its id starts "auto-", so clearNeeds can tell it apart.
export async function raiseNeeds(db, repoId, needs) {
  if (!needs.length) return;
  const at = new Date().toISOString();
  await db.batch(needs.flatMap((n) => {
    const id = `auto-${crypto.randomUUID()}`;
    return [db.prepare("INSERT OR IGNORE INTO needs (id, kind, repo, change_id, text, actions, created_at) SELECT ?, ?, name, ?, ?, ?, ? FROM repos WHERE id = ?")
      .bind(id, n.kind, n.change, n.text, JSON.stringify(n.actions), at, repoId),
    ...(n.subject ? [db.prepare("INSERT INTO need_subjects (need_id, subject) SELECT id, ? FROM needs WHERE id = ?").bind(JSON.stringify(n.subject), id)] : [])];
  }));
}

// Raises a Budget alert on the account for each alert threshold this month's token spend has reached. The month is in
// the text, so each threshold is raised once a month. Model spend at or over the budget raises one Budget reached,
// again only for a new budget or month.
export async function raiseBudgetNeeds(env) {
  const use = await budgetUse(env.DB);
  if (use.paused) {
    await env.DB.prepare("INSERT OR IGNORE INTO needs (id, kind, repo, change_id, text, actions, created_at) VALUES (?, 'Budget reached', 'account', NULL, ?, ?, ?)")
      .bind(`auto-${crypto.randomUUID()}`, `The ${new Date().toISOString().slice(0, 7)} token budget of ${use.tokens} is reached: agent work is paused`,
        JSON.stringify(["Raise budget", "Resume"]), new Date().toISOString()).run();
  }
  const { start, budget } = await accountOf(env);
  const reached = budget.tokens ? budget.alerts.filter((t) => budget.spent * 100 >= t * budget.tokens) : [];
  if (!reached.length) return;
  const at = new Date().toISOString();
  await env.DB.batch(reached.map((t) => env.DB.prepare(
    "INSERT OR IGNORE INTO needs (id, kind, repo, change_id, text, actions, created_at) VALUES (?, 'Budget alert', 'account', NULL, ?, ?, ?)",
  ).bind(`auto-${crypto.randomUUID()}`, `${t}% of the ${start.slice(0, 7)} token budget used`, JSON.stringify(["Raise budget", "Open Insights", "Edit alerts"]), at)));
}

// Resolves as Cleared the open items of kind on the repo with id repoId about change (null: none) whose text isn't
// in keep: their condition no longer holds. Only items raiseNeeds made.
export async function clearNeeds(db, kind, repoId, change, keep = []) {
  await db.prepare("UPDATE needs SET resolution = 'Cleared', resolved_at = ? WHERE kind = ? AND repo = (SELECT name FROM repos WHERE id = ?) " +
    "AND change_id IS ? AND resolved_at IS NULL AND id LIKE 'auto-%' AND text NOT IN (SELECT value FROM json_each(?))")
    .bind(new Date().toISOString(), kind, repoId, change, JSON.stringify(keep)).run();
}

// POST /api/needs/:id/resolve {action} → Need: runs the action's operation (OPS) and resolves the item only when it
// succeeds; a failure answers the operation's error and leaves it open. Open fix change answers with change = the fix.
export async function resolveNeed(request, env, { id }) {
  const row = await env.DB.prepare("SELECT n.*, s.subject FROM needs n LEFT JOIN need_subjects s ON s.need_id = n.id WHERE n.id = ?").bind(id).first();
  if (!row) return error(404, "not_found", `no need ${id}`);
  const body = (await request.json().catch(() => null)) ?? {};
  const { action } = body;
  if (NAVIGATE.includes(action) || ![...JSON.parse(row.actions), "Dismiss"].includes(action)) {
    return error(400, "bad_request", "action must be one of the item's decisions or Dismiss; navigation actions don't resolve");
  }
  if (row.resolved_at) return error(409, "resolved", `need ${id} is already resolved`);
  const subject = JSON.parse(row.subject ?? "null") ?? {};
  const gated = GATED.includes(row.kind);
  const person = personOf(request);
  const owner = person === "owner" || isOwnerEmail(env, person);
  // The router lets a person through to here; any other item needs what the route needs (org.manage).
  if (!gated && !owner && !(await can(env, person, "POST", new URL(request.url).pathname, null, groupsOf(request)))) {
    return error(403, "forbidden", "resolving this item needs org.manage");
  }
  if (gated && !(await mayApprove(env, person, groupsOf(request), row, subject))) {
    return error(403, "not_an_approver", `only ${subject.approvers ?? `people who may promote to ${subject.env}`} resolve this ${row.kind}`);
  }
  const [route, run] = OPS[`${row.kind}|${action.startsWith("Grant to ") ? "Grant" : action}`] ?? [];
  let change = row.change_id;
  if (run) {
    // The router checked the resolve route; a person also needs the operation's own capability.
    const path = typeof route === "function" ? route(row, subject) : route ? `/api/changes/${row.change_id}/${route}` : `/api/repos/${row.repo}/changes`;
    if (!gated && !owner && !(await can(env, person, "POST", path, null, groupsOf(request)))) return error(403, "forbidden", `${action} needs the capability for POST ${path}`);
    const res = await run(request, env, row, subject, body);
    if (!res.ok) return res;
    if (KEEP_OPEN.includes(action)) return Response.json({ ...shape(row), change });
    if (!route) change = (await res.json()).id;
  }
  // The operation itself can clear the condition (a granted lease, a merge's approval); the decision still records.
  const { meta } = await env.DB.prepare("UPDATE needs SET resolution = ?, resolved_at = ? WHERE id = ? AND (resolved_at IS NULL OR resolution = 'Cleared')")
    .bind(action, new Date().toISOString(), id).run();
  if (!meta.changes) return error(409, "resolved", `need ${id} is already resolved`);
  return Response.json({ ...shape(row), change });
}
