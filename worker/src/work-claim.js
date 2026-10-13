// Board writes on an issue: hand it to an agent or a race, keep it for a person, or drag it back to the intents.
import { asCaller, personOf } from "./access.js";
import { trustOf } from "./calibration.js";
import { createChange } from "./changes.js";
import { queueHistoryJob } from "./queue.js";
import { error, runnerOf } from "./router.js";
import { publishWork } from "./work-board.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
const issueIn = (env, name, n) => env.DB.prepare("SELECT i.id, i.number, i.title, i.state FROM issues i JOIN repos r ON r.id = i.repo_id " +
  "WHERE r.name = ? AND i.number = ?").bind(name, Number(n)).first();
// The issue's linked changes still open, each with its head commit (null before the first).
const openLinks = async (env, issueId) => (await env.DB.prepare("SELECT c.id, h.head_sha FROM issue_links l JOIN changes c ON c.id = l.change_id " +
  "LEFT JOIN change_heads h ON h.change_id = c.id WHERE l.issue_id = ? AND c.state NOT IN ('closed', 'merged')").bind(issueId).all()).results;

// POST /api/repos/:name/issues/:n/claim {mode: agent|race|human, agents?} → 201 WorkItem. agent creates a change for
// "#n <title>" written by agents[0] (developer's stable without one), race a race of the two agents; human writes
// nothing and answers {redirect} to the new-change page for the issue.
export async function claimIssue(request, env, { name, n }) {
  const { mode, agents } = (await request.json().catch(() => null)) ?? {};
  if (!["agent", "race", "human"].includes(mode)) return error(400, "bad_request", "mode must be agent, race or human");
  if (agents !== undefined && !(Array.isArray(agents) && agents.every((a) => typeof a === "string" && a))) return error(400, "bad_request", "agents must be a list of agent versions");
  if (mode === "race" && agents?.length !== 2) return error(400, "bad_request", "a race needs two agents");
  const issue = await issueIn(env, name, n);
  if (!issue) return error(404, "not_found", `no issue #${n} in ${name}`);
  if (issue.state !== "open") return error(409, "issue_closed", `#${issue.number} is closed`);
  if (mode === "human") return Response.json({ redirect: `/${name}/changes/new?issue=${issue.number}` });
  // The repo's RepoDO holds the issue's claim lock until the change is linked, so a second claim meanwhile is already_claimed.
  const repo = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  if (!(await repo.lockClaim(issue.id))) return error(409, "already_claimed", `#${issue.number} is being claimed`);
  try {
    if ((await openLinks(env, issue.id)).length) return error(409, "already_claimed", `#${issue.number} already has an open change`);
    const body = { intent: `#${issue.number} ${issue.title}`,
      ...(mode === "race" ? { race: agents } : agents && { agent_version: agents[0] }) };
    const res = await createChange(asCaller(request, request.url, { method: "POST", body: JSON.stringify(body) }), env, { name });
    if (!res.ok) return res;
    const created = await res.json();
    const item = await publishWork(env, name, { change_id: (created.changes?.[0] ?? created).id });
    return item ? Response.json(item, { status: 201 }) : error(500, "internal", `the change for #${issue.number} is not on the board`);
  } finally {
    await repo.unlockClaim(issue.id);
  }
}

// DELETE /api/repos/:name/issues/:n/claim → 204: closes the issue's open changes while none has a commit; after one,
// the verifier owns the change (409 verifier_owned).
export async function unclaimIssue(request, env, { name, n }) {
  const issue = await issueIn(env, name, n);
  if (!issue) return error(404, "not_found", `no issue #${n} in ${name}`);
  const links = await openLinks(env, issue.id);
  if (!links.length) return error(404, "not_found", `#${issue.number} is not claimed`);
  if (links.some((c) => c.head_sha)) return error(409, "verifier_owned", `#${issue.number}'s change has a commit; the verifier owns it now`);
  const by = personOf(request);
  for (const { id } of links) {
    const change = await changeDO(env, id).transition("closed", {
      kind: "closed", actor: { type: "human", id: by }, action: "change.close", target: id, result: "ok", reason: "unclaimed",
    }, { closed_by: by, closed_at: new Date().toISOString(), close_reason: "unclaimed" });
    if (!change) return error(409, "illegal_transition", `change ${id} cannot be closed`);
    await queueHistoryJob(env, change);
  }
  return new Response(null, { status: 204 });
}

// GET /api/repos/:name/agents/suggest?issue=n → [{agent, p_merge, n, trusted}]: every agent version by its merge rate
// over its changes on this repo that ended, best first; p_merge null with no outcomes, trusted from the repo's min_outcomes.
export async function suggestAgents(request, env, { name }) {
  const n = new URL(request.url).searchParams.get("issue");
  if (!/^[1-9]\d*$/.test(n ?? "")) return error(400, "bad_request", "issue: expected an issue number");
  const repo = await env.DB.prepare("SELECT r.id FROM repos r JOIN issues i ON i.repo_id = r.id WHERE r.name = ? AND i.number = ?").bind(name, Number(n)).first("id");
  if (!repo) return error(404, "not_found", `no issue #${n} in ${name}`);
  const { min_outcomes } = await trustOf(env.DB, repo);
  const { results } = await env.DB.prepare("SELECT v.name || '@v' || v.version AS agent, COALESCE(SUM(o.outcome = 'merged'), 0) AS merged, COUNT(o.id) AS n " +
    "FROM agent_versions v LEFT JOIN agent_outcomes o ON o.agent_version = v.name || '@v' || v.version AND o.outcome IN ('merged', 'failed', 'closed') " +
    "AND o.change_id IN (SELECT id FROM changes WHERE repo_id = ?) GROUP BY v.name, v.version").bind(repo).all();
  return Response.json(results.map((r) => ({ agent: r.agent, p_merge: r.n ? r.merged / r.n : null, n: r.n, trusted: r.n >= min_outcomes }))
    .toSorted((a, b) => (b.p_merge ?? -1) - (a.p_merge ?? -1)));
}

// POST /api/work/jobs/:job/activity {activity, path?} → 204: what the agent on the runner's leased job is doing now,
// sent to the repo's sockets as work.activity at most once a second per change (RepoDO.activity).
export async function postActivity(request, env, { job: id }) {
  const runner = await runnerOf(request, env);
  const job = await env.DB.prepare("SELECT j.change_id, r.name FROM jobs j JOIN repos r ON r.id = j.repo_id " +
    "WHERE j.id = ? AND j.runner_id = ? AND j.status = 'claimed' AND j.change_id IS NOT NULL").bind(id, runner.runner_id).first();
  if (!job) return error(403, "forbidden", `job ${id} is not leased to this runner`);
  const { activity, path = null } = (await request.json().catch(() => null)) ?? {};
  if (typeof activity !== "string" || !activity || activity.length > 500) return error(400, "bad_request", "activity must be a string of 1-500 characters");
  if (path !== null && (typeof path !== "string" || !path)) return error(400, "bad_request", "path must be null or a non-empty string");
  await env.REPO_DO.get(env.REPO_DO.idFromName(job.name)).activity({
    kind: "work.activity", repo: job.name, at: new Date().toISOString(), change_id: job.change_id, activity, path,
  });
  return new Response(null, { status: 204 });
}
