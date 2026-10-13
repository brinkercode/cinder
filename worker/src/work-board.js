// The work board: every open issue and every live change of a repo once, each in its lane.
import { groupsOf, isOwnerEmail, personOf } from "./access.js";
import { laneOf } from "./api/lanes.js";
import { trustOf } from "./calibration.js";
import { DIFF_OF, diffSummary, failedTests, failureOf } from "./changes.js";
import { can } from "./people.js";
import { publish } from "./live.js";
import { error } from "./router.js";

const WHO = ["all", "agents", "people", "you"];

const PRIORITIES = ["P0", "P1", "P2", "P3"];

// GET /api/repos/:name/work?who=all|agents|people|you&q=&label=&priority=P0..P3&sort=priority|age → {items, tiles}.
// sort=age (the default) keeps board order; priority puts P0 first and items without one last.
export async function listWork(request, env, { name }) {
  const params = new URL(request.url).searchParams;
  const who = params.get("who") ?? "all";
  const [label, priority, sort] = [params.get("label"), params.get("priority"), params.get("sort") ?? "age"];
  if (!WHO.includes(who)) return error(400, "bad_request", "who must be all, agents, people or you");
  if (priority !== null && !PRIORITIES.includes(priority)) return error(400, "bad_request", "priority must be P0, P1, P2 or P3");
  if (!["priority", "age"].includes(sort)) return error(400, "bad_request", "sort must be priority or age");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const [issues, links, cards, [verdicts]] = (await env.DB.batch([
    env.DB.prepare("SELECT i.*, b.priority FROM issues i LEFT JOIN issue_board b ON b.issue_id = i.id WHERE i.repo_id = ? ORDER BY i.number").bind(repo),
    env.DB.prepare("SELECT i.number AS n, l.change_id FROM issue_links l JOIN issues i ON i.id = l.issue_id WHERE i.repo_id = ?").bind(repo),
    env.DB.prepare(`SELECT c.id, k.card, r.person, h.head_sha, ${DIFF_OF} AS diff FROM changes c LEFT JOIN change_cards k ON k.change_id = c.id
      LEFT JOIN change_requesters r ON r.change_id = c.id LEFT JOIN change_heads h ON h.change_id = c.id WHERE c.repo_id = ? ORDER BY c.created_at`).bind(repo),
    // lazy: counts every verify job of the repo; window it if the tile should show recent pass rate.
    env.DB.prepare("SELECT COALESCE(SUM(status = 'done'), 0) AS pass, COUNT(*) AS n FROM jobs WHERE repo_id = ? AND kind = 'verify' AND status IN ('done', 'failed')").bind(repo),
  ])).map((r) => r.results);
  const { min_outcomes } = await trustOf(env.DB, repo);

  const me = personOf(request);
  const needle = (params.get("q") ?? "").trim().toLowerCase();
  const items = [];
  const keep = (item, agent, mine) => (who === "all" || (who === "you" ? mine : (who === "agents") === agent))
    && (!label || item.labels.includes(label)) && (!priority || item.priority === priority)
    && (!needle || [item.title, item.n && `#${item.n}`, item.change_id, item.change_id && `c-${item.change_id}`, item.author, ...item.labels]
      .some((s) => s && s.toLowerCase().includes(needle)));

  // A change linked to several issues carries the lowest n; that issue is not listed on its own.
  const lowest = new Map();
  for (const { n, change_id } of links) if (!(lowest.get(change_id) <= n)) lowest.set(change_id, n);
  const byN = new Map(issues.map((i) => [i.number, i]));
  const carried = new Set();
  for (const { id, card, person, head_sha, diff } of cards) {
    // A change last written before cards existed has none until its next write, so it is read from its DO once.
    const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
    const c = card ? JSON.parse(card) : await stub.get();
    const issue = byN.get(lowest.get(id)) ?? null;
    const lane = c && laneOf(issue, { ...c, head_sha });
    if (!lane) continue;
    if (issue) carried.add(issue.number);
    const failure = c.state === "failed" && failureOf(await stub.get(), await failedTests(env, id));
    const why = c.state === "conflict" ? "Conflicts with its target"
      : c.state === "failed" ? (failure ? `Failed at ${failure.stage}${failure.reason ? `: ${failure.reason}` : ""}` : "Failed") : null;
    const item = { kind: "change", n: issue?.number ?? null, change_id: id, title: c.title, lane, priority: issue?.priority ?? c.priority ?? null,
      labels: [...new Set([...(issue ? JSON.parse(issue.labels) : []), ...(c.labels ?? [])])], author: c.ver ? `${c.agent}@${c.ver}` : person ?? c.agent ?? "owner",
      assignee: issue?.assignee ?? null, why, updated_at: c.updated_at, diff: await diffSummary(env, name, c, head_sha, diff) };
    const mine = [item.author, person, item.assignee].includes(me) || (c.reviewers ?? []).some((r) => r.person === me);
    if (keep(item, Boolean(c.ver || c.agent_version), mine)) items.push(item);
  }
  for (const i of issues) {
    const lane = !carried.has(i.number) && laneOf(i, null);
    if (!lane) continue;
    const item = { kind: "intent", n: i.number, change_id: null, title: i.title, lane, priority: i.priority, labels: JSON.parse(i.labels),
      author: i.author, assignee: i.assignee, why: null, updated_at: i.updated_at };
    // An agent assignee (name@vN) is an intent claimed by an agent.
    if (keep(item, /@v\d+$/.test(i.assignee ?? ""), [i.author, i.assignee].includes(me))) items.push(item);
  }

  const rank = (p) => (p === null ? PRIORITIES.length : PRIORITIES.indexOf(p));
  if (sort === "priority") items.sort((a, b) => rank(a.priority) - rank(b.priority));
  const count = (...lanes) => items.filter((i) => lanes.includes(i.lane)).length;
  // can_write: the caller may claim and release intents (repo.write), so the board enables drag and Hand to agent.
  const can_write = me === "owner" || isOwnerEmail(env, me) || await can(env, me, "POST", `/api/repos/${encodeURIComponent(name)}/issues/1/claim`, null, groupsOf(request));
  // The review lane is exactly the changes awaiting approval plus those with changes requested.
  return Response.json({ items, tiles: { intents: count("intent"), in_flight: count("progress", "verify", "queue"), review: count("review"),
    merged_24h: count("merged"), needs_you: count("review"), verifier: { pass: verdicts.pass, n: verdicts.n, trusted: verdicts.n >= min_outcomes } }, can_write });
}

// Sends work.updated {item} with the board item now carrying the change (or, once it left the board, an issue it links)
// or issue n, and returns it. Issue n no longer on the board (closed) sends work.updated {item: null, n} so open boards drop it;
// a change off the board sends nothing. A failure is logged: the write it reports stands.
// lazy: builds the whole board per update; build the one item past ~500 live changes on a repo.
export async function publishWork(env, name, { change_id = null, n = null }) {
  try {
    const { items } = await (await listWork(new Request(`http://cinder/api/repos/${name}/work`), env, { name })).json();
    const ns = change_id ? (await env.DB.prepare("SELECT i.number FROM issue_links l JOIN issues i ON i.id = l.issue_id WHERE l.change_id = ?")
      .bind(change_id).all()).results.map((r) => r.number) : [n];
    const item = items.find((i) => change_id && i.change_id === change_id) ?? items.find((i) => i.n !== null && ns.includes(i.n));
    if (item) await publish(env, name, "work.updated", { item });
    else if (n !== null) await publish(env, name, "work.updated", { item: null, n });
    return item ?? null;
  } catch (err) {
    console.error(`work.updated on ${name}: ${err.message}`);
    return null;
  }
}
