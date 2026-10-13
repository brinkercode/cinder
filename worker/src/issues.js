import { asCaller, personOf } from "./access.js";
import { error } from "./router.js";
import { routesOf } from "./routing.js";
import { claimIssue } from "./work-claim.js";
import { publishWork } from "./work-board.js";

// Issues (create, comment, labels, assignee, open/close, close by number), repo-scoped.
const repoId = (env, name) => env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");
// An issue with its board fields (issue_board). A closed issue is always done, since a merge closes it without touching
// the board; an open one keeps its board status, todo with no board row.
const ISSUE = "SELECT i.*, CASE i.state WHEN 'closed' THEN 'done' ELSE COALESCE(b.status, 'todo') END AS status, b.priority, b.iteration " +
  "FROM issues i LEFT JOIN issue_board b ON b.issue_id = i.id";
const issueIn = (env, name, n) => env.DB.prepare(
  `${ISSUE} JOIN repos r ON r.id = i.repo_id WHERE r.name = ? AND i.number = ?`,
).bind(name, Number(n)).first();
const out = (row) => ({ ...row, labels: JSON.parse(row.labels) });
const text = (v) => typeof v === "string" && v.trim() !== "";

// GET /api/repos/:name/issues → Issue[], newest first, each with change: its newest linked change's id or null.
export async function listIssues(request, env, { name }) {
  const repo = await repoId(env, name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const { results } = await env.DB.prepare("SELECT x.*, (SELECT change_id FROM issue_links l WHERE l.issue_id = x.id ORDER BY l.rowid DESC LIMIT 1) AS change " +
    `FROM (${ISSUE}) x WHERE x.repo_id = ? ORDER BY x.number DESC`).bind(repo).all();
  return Response.json(results.map(out));
}

// POST /api/repos/:name/issues {title, body?} → 201 Issue. The number is taken in the INSERT itself, so two creates never share one.
export async function createIssue(request, env, { name }) {
  const repo = await repoId(env, name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const { title, body = "" } = (await request.json().catch(() => null)) ?? {};
  if (!text(title)) return error(400, "bad_request", "title must be a non-empty string");
  if (typeof body !== "string") return error(400, "bad_request", "body must be a string");
  const at = new Date().toISOString();
  const issue = await env.DB.prepare(
    "INSERT INTO issues (id, repo_id, number, title, body, author, created_at, updated_at) " +
    "SELECT ?1, ?2, COALESCE(MAX(number), 0) + 1, ?3, ?4, ?5, ?6, ?6 FROM issues WHERE repo_id = ?2 RETURNING *",
  ).bind(crypto.randomUUID(), repo, title.trim(), body, personOf(request), at).first();
  await publishWork(env, name, { n: issue.number });
  return Response.json({ ...out(issue), status: "todo", priority: null, iteration: null }, { status: 201 });
}

// GET /api/repos/:name/issues/:n → IssueDetail: the issue, its comments oldest first and its linked changes.
export async function getIssue(request, env, { name, n }) {
  const issue = await issueIn(env, name, n);
  if (!issue) return error(404, "not_found", `no issue #${n}`);
  const [comments, changes] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM issue_comments WHERE issue_id = ? ORDER BY created_at, rowid").bind(issue.id),
    env.DB.prepare("SELECT c.id, c.state FROM issue_links l JOIN changes c ON c.id = l.change_id WHERE l.issue_id = ? ORDER BY c.created_at").bind(issue.id),
  ]);
  return Response.json({ ...out(issue), comments: comments.results, changes: changes.results });
}

// PATCH /api/repos/:name/issues/:n {title?, body?, state?, labels?, assignee?, status?, priority?, iteration?} → Issue; null
// clears assignee, priority, iteration. A status sets the state (done closes); a state alone moves the issue to done or todo.
export async function editIssue(request, env, { name, n }) {
  const issue = await issueIn(env, name, n);
  if (!issue) return error(404, "not_found", `no issue #${n}`);
  const patch = await request.json().catch(() => null);
  if (!patch || typeof patch !== "object" || Array.isArray(patch)) return error(400, "bad_request", "body must be an object");
  const next = { ...out(issue), ...patch };
  if ("status" in patch) next.state = patch.status === "done" ? "closed" : "open";
  else if ("state" in patch && patch.state !== issue.state) next.status = patch.state === "closed" ? "done" : "todo";
  if (!text(next.title)) return error(400, "bad_request", "title must be a non-empty string");
  if (typeof next.body !== "string") return error(400, "bad_request", "body must be a string");
  if (!["open", "closed"].includes(next.state)) return error(400, "bad_request", "state must be open|closed");
  if (!Array.isArray(next.labels) || !next.labels.every(text)) return error(400, "bad_request", "labels must be non-empty strings");
  if (next.assignee !== null && !text(next.assignee)) return error(400, "bad_request", "assignee must be null or a non-empty string");
  if (!["backlog", "todo", "progress", "review", "done"].includes(next.status)) return error(400, "bad_request", "status must be backlog|todo|progress|review|done");
  if (next.priority !== null && !["P0", "P1", "P2", "P3"].includes(next.priority)) return error(400, "bad_request", "priority must be null or P0|P1|P2|P3");
  if (next.iteration !== null && !text(next.iteration)) return error(400, "bad_request", "iteration must be null or a non-empty string");
  // A label that newly makes a Settings rule the first match routes the intent: a driver rule assigns that person,
  // an agent rule claims it below; a reviewer rule waits for the intent's change.
  const routes = "labels" in patch ? await routesOf(env, issue.repo_id) : [];
  const first = (labels) => routes.find((r) => labels.includes(r.label));
  const rule = first(next.labels) !== first(out(issue).labels) && first(next.labels);
  if (rule?.driver) next.assignee = rule.driver;
  const at = new Date().toISOString();
  const closedAt = next.state === "open" ? null : issue.closed_at ?? at;
  const [{ results: [row] }] = await env.DB.batch([env.DB.prepare(
    "UPDATE issues SET title = ?, body = ?, state = ?, labels = ?, assignee = ?, updated_at = ?, closed_at = ? WHERE id = ? RETURNING *",
  ).bind(next.title.trim(), next.body, next.state, JSON.stringify([...new Set(next.labels)]), next.assignee, at, closedAt, issue.id),
  env.DB.prepare("INSERT OR REPLACE INTO issue_board (issue_id, status, priority, iteration) VALUES (?, ?, ?, ?)").bind(issue.id, next.status, next.priority, next.iteration)]);
  await publishWork(env, name, { n: issue.number });
  if (rule?.agent) {
    const res = await claimIssue(asCaller(request, request.url, { method: "POST", body: JSON.stringify({ mode: "agent", agents: [rule.agent] }) }), env, { name, n });
    if (!res.ok) console.error(`routing #${issue.number} to ${rule.agent}: ${(await res.json()).error?.message ?? res.status}`);
  }
  return Response.json({ ...out(row), status: next.status, priority: next.priority, iteration: next.iteration });
}

// POST /api/repos/:name/issues/:n/comments {body} → 201 IssueComment.
export async function addIssueComment(request, env, { name, n }) {
  const issue = await issueIn(env, name, n);
  if (!issue) return error(404, "not_found", `no issue #${n}`);
  const body = (await request.json().catch(() => null))?.body;
  if (!text(body)) return error(400, "bad_request", "body must be a non-empty string");
  const comment = await env.DB.prepare("INSERT INTO issue_comments (id, issue_id, author, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *")
    .bind(crypto.randomUUID(), issue.id, personOf(request), body, new Date().toISOString()).first();
  return Response.json(comment, { status: 201 });
}

// PUT /api/repos/:name/issues/:n/changes/:id → 204: links a change of the same repo to the issue.
export async function linkIssue(request, env, { name, n, id }) {
  const issue = await issueIn(env, name, n);
  if (!issue) return error(404, "not_found", `no issue #${n}`);
  const change = await env.DB.prepare("SELECT id FROM changes WHERE id = ? AND repo_id = ?").bind(id, issue.repo_id).first();
  if (!change) return error(404, "not_found", `no change ${id} in ${name}`);
  await env.DB.prepare("INSERT OR IGNORE INTO issue_links (issue_id, change_id) VALUES (?, ?)").bind(issue.id, id).run();
  return new Response(null, { status: 204 });
}

// The issue numbers a change's intent names: every `#n` links, `fixes #n` also closes on merge.
export const issueRefs = (intent, fixes = false) => [...(intent ?? "").matchAll(fixes ? /\bfixes #(\d+)\b/gi : /#(\d+)\b/g)].map((m) => Number(m[1]));
