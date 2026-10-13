import { createArtifacts } from "./artifacts.js";
import { COLLISION_GUIDE, collisionQuestion, judge } from "./judgments.js";
import { blockersFor } from "./merge/blockers.js";
import { openFindings } from "./findings.js";
import { parsePolicy } from "./policy.js";
import { error } from "./router.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));

// The head of every (repo, target) queue: its earliest entry whose change is still in_queue.
export const QUEUE_HEADS = `SELECT change_id FROM (SELECT q.change_id, MIN(q.seq) FROM queue_entries q
  JOIN changes c ON c.id = q.change_id AND c.state = 'in_queue' GROUP BY q.repo_id, q.target_branch)`;

// Puts a change that just became in_queue at the back of its target's queue; a seam change, or one a queued entry is
// stacked on, jumps to the front, ahead of the dependents stacked on it (which can't merge before it). A null seq takes
// the next one. An entry already queued keeps its place, so a change that left the queue only to resolve a conflict or
// rebase returns where it was.
export async function enqueue(env, change) {
  // lazy: reads every entry on the target's change; index stacked_on in D1 if queues grow past a few dozen entries.
  const { results } = await env.DB.prepare("SELECT change_id FROM queue_entries WHERE repo_id = ? AND target_branch = ?")
    .bind(change.repo_id, change.target_branch).all();
  const front = change.kind === "seam" || (await Promise.all(results.map((e) => changeDO(env, e.change_id).get()))).some((c) => c?.stacked_on === change.id);
  await env.DB.prepare(`INSERT OR IGNORE INTO queue_entries (seq, change_id, repo_id, target_branch, enqueued_at)
    VALUES (CASE WHEN ?5 THEN (SELECT MIN(seq) - 1 FROM queue_entries) END, ?1, ?2, ?3, ?4)`)
    .bind(change.id, change.repo_id, change.target_branch, new Date().toISOString(), front ? 1 : 0).run();
}

// The one merge gate (blockersFor) on what is stored for change: the verify verdict and guard result for its head, the
// approvals its review route (a person on a human route) and requested people need, its open findings and, when the
// target's .cinder.yml asks, its unresolved threads. Change detail shows these; queueMergeJob enforces them.
export async function mergeBlockers(env, change) {
  const approvals = (change.approvals ?? []).filter((a) => a.actor.type === "human").map((a) => ({ by: a.actor.id, sha: a.head_sha, state: "approved", at: a.at }));
  const policy = { approvals: change.review?.route === "human" ? 1 : 0 };
  const route = { reviewers: (change.reviewers ?? []).filter((r) => r.person).map((r) => r.person) };
  // Outdated threads count until resolved. The target's .cinder.yml is read only when one is open: none can't block.
  // One that can't be read or parsed requires them resolved (fail closed), rather than failing change detail.
  const unresolvedThreads = await env.DB.prepare("SELECT COUNT(*) AS n FROM review_threads WHERE change_id = ? AND resolved = 0").bind(change.id).first("n");
  const repo = unresolvedThreads && await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first("name");
  const requireResolved = !!unresolvedThreads && await createArtifacts(env.ARTIFACTS).readFile(repo, change.target_branch, ".cinder.yml")
    .then((text) => parsePolicy(text, change.target_branch).review?.require_resolved === true).catch(() => true);
  // A guard result for an earlier push is no result for this head.
  const guard = (change.guard?.sha ?? null) === (change.head ?? null) ? change.guard : null;
  const blockers = blockersFor({ change, approvals, verdict: change.verdict, guard, policy, route, findings: await openFindings(env.DB, change.id), requireResolved, unresolvedThreads });
  // A stacked change carries its base's commits, so it merges only after the base has.
  const base = change.stacked_on && await changeDO(env, change.stacked_on).get();
  if (base && base.state !== "merged") blockers.push({ code: "stacked", reason: `stacked on ${base.id}, which merges first`, since: null });
  return blockers;
}

// Queues a merge job for target's queue head when the merge gate clears it, unless it already has an open one (one
// statement, so two callers can't both add one). Stores why the head is stuck, which the queue shows.
export async function queueMergeJob(env, repoId, target) {
  const id = await env.DB.prepare(`SELECT change_id FROM queue_entries WHERE repo_id = ? AND target_branch = ? AND change_id IN (${QUEUE_HEADS})`)
    .bind(repoId, target).first("change_id");
  if (!id) return;
  const change = await changeDO(env, id).get();
  // A head with nothing pushed has nothing to merge: it goes back for a fix, which pushes one, and leaves the queue.
  if (!change.head && await changeDO(env, id).transition("needs_fix", {
    kind: "no_head", actor: { type: "system", id: "cinder" }, action: "change.converge", target: id, result: "failed", reason: "it has no pushed head",
  }, {}, "in_queue")) return;
  const blockers = await mergeBlockers(env, change);
  // A verdict for an earlier head (cinder's own rebase pushed over it) never clears by itself: the head rebases and verifies again.
  if (change.head && change.verdict?.sha && change.head !== change.verdict.sha && await changeDO(env, id).transition("converging", {
    kind: "stale_verdict", actor: { type: "system", id: "cinder" }, action: "change.converge", target: id, result: "ok", reason: "its verdict is for an earlier head",
  }, {}, "in_queue")) return queueConvergeJob(env, change);
  if (!blockers.length) await env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload)
    SELECT ?1, c.repo_id, 'merge', c.id, 'queued', ?2, json_object('target', c.target_branch, 'mirror_url', m.mirror_url) FROM changes c LEFT JOIN repo_mirrors m ON m.repo_id = c.repo_id
    WHERE c.id = ?3 AND c.id IN (${QUEUE_HEADS})
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE change_id = c.id AND kind = 'merge' AND status IN ('queued', 'claimed'))`)
    .bind(crypto.randomUUID(), new Date().toISOString(), id).run();
  await env.DB.prepare("INSERT OR REPLACE INTO queue_blockers (change_id, reason) VALUES (?, ?)").bind(id, blockers.map((b) => b.reason).join("; ") || null).run();
}

// How many entries one merge lands at most, and how many a change leaving the queue re-verifies: a failure costs at
// most this many re-verifies.
export const SPECULATION_DEPTH = 4;

// target's queued changes (in_queue, or converging while they re-verify or rebase), front first, with their pushed
// heads: what a verify job speculates on.
async function queueHeads(env, repoId, target) {
  const { results } = await env.DB.prepare(`SELECT q.seq, q.change_id, h.head_sha, c.state FROM queue_entries q
    JOIN changes c ON c.id = q.change_id AND c.state IN ('in_queue', 'converging')
    LEFT JOIN change_heads h ON h.change_id = q.change_id WHERE q.repo_id = ? AND q.target_branch = ? ORDER BY q.seq`).bind(repoId, target).all();
  return results;
}

const head = ({ change_id, head_sha }) => ({ change_id, head_sha });

// The ordered heads ahead of a change entering verifying: those before its kept entry, else all (it joins the back).
export async function headsAhead(env, change) {
  const seq = await env.DB.prepare("SELECT seq FROM queue_entries WHERE change_id = ?").bind(change.id).first("seq");
  return (await queueHeads(env, change.repo_id, change.target_branch)).filter((e) => e.change_id !== change.id && (seq === null || e.seq < seq)).map(head);
}

// The event kinds of a queued head refused at merge, and of its rebase finishing: it re-verifies in its place.
const KEEPS_PLACE = ["base_moved", "stale_speculation", "stale_verdict", "merge_failed", "converge_done"];

// A change leaving its queue (other than by merging) re-verifies the SPECULATION_DEPTH entries behind it, each on the
// heads still ahead; one already re-verifying drops its verify job for a new one. Entries further back keep a speculation
// that names the leaver, so mergeBatch never lands them on it. The leaver's entry goes (unless it is resolving a conflict
// or a refused head rebasing); passing again enqueues it anew.
export async function respeculate(env, leaver, kind) {
  const seq = await env.DB.prepare("SELECT seq FROM queue_entries WHERE change_id = ?").bind(leaver.id).first("seq");
  if (seq === null) return;
  // A conflict, or a head whose merge was refused, keeps its entry: once resolved or rebased and re-verified, the change
  // returns to its place (enqueue ignores an entry that exists).
  // lazy: a conflicted change that is then closed or failed leaves an inert entry; enqueue would reuse its place.
  if (leaver.state !== "conflict" && !KEEPS_PLACE.includes(kind)) await env.DB.prepare("DELETE FROM queue_entries WHERE change_id = ?").bind(leaver.id).run();
  const entries = (await queueHeads(env, leaver.repo_id, leaver.target_branch)).filter((e) => e.change_id !== leaver.id);
  for (const e of entries.filter((x) => x.seq > seq).slice(0, SPECULATION_DEPTH)) {
    const moved = e.state === "in_queue" ? await changeDO(env, e.change_id).transition("converging", {
      kind: "respeculate", actor: { type: "system", id: "cinder" }, action: "change.converge", target: e.change_id, result: "ok", reason: `${leaver.id} left the queue`,
    }, {}, "in_queue") : (await env.DB.prepare(`INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE change_id = ? AND kind = 'verify'
      AND status IN ('queued', 'claimed')`).bind(e.change_id).run()).meta.changes; // a converging entry with no verify job is rebasing
    if (!moved) continue;
    await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), leaver.repo_id, e.change_id, new Date().toISOString(), JSON.stringify({ ahead: entries.slice(0, entries.indexOf(e)).map(head) })).run();
  }
}

// What the head's merge job lands, front first: the run of in_queue entries from the head whose last passing verify ran
// on exactly the entries before it in the run (those merged since are on the target already), with its verified tree
// and the target sha that verify merged onto. The runner refuses any entry whose merged tree isn't that tree.
export async function mergeBatch(env, repoId, target) {
  const { results } = await env.DB.prepare(`SELECT q.change_id, h.head_sha, (SELECT payload FROM jobs j WHERE j.change_id = q.change_id AND j.kind = 'verify'
      AND j.status = 'done' AND j.id NOT IN (SELECT job_id FROM job_cancels) ORDER BY j.created_at DESC LIMIT 1) AS verified
    FROM queue_entries q JOIN changes c ON c.id = q.change_id AND c.state = 'in_queue' LEFT JOIN change_heads h ON h.change_id = q.change_id
    WHERE q.repo_id = ? AND q.target_branch = ? ORDER BY q.seq LIMIT ?`).bind(repoId, target, SPECULATION_DEPTH).all();
  const batch = [];
  for (const e of results) {
    const { ahead = [], tree = null, base = null } = JSON.parse(e.verified ?? "{}");
    const { results: merged } = await env.DB.prepare("SELECT id FROM changes WHERE state = 'merged' AND id IN (SELECT value FROM json_each(?))")
      .bind(JSON.stringify(ahead.map((a) => a.change_id))).all();
    const pending = ahead.filter((a) => !merged.some((m) => m.id === a.change_id));
    if (pending.length !== batch.length || pending.some((a, i) => a.change_id !== batch[i].change_id || a.head_sha !== batch[i].head_sha)) break;
    batch.push({ change_id: e.change_id, head_sha: e.head_sha, tree, base });
  }
  return batch;
}

// A change whose merge was refused rebases onto its target and re-verifies; at most one open converge job.
export async function queueConvergeJob(env, change) {
  await env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) SELECT ?1, ?2, 'converge', ?3, 'queued', ?4, ?5
    WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE change_id = ?3 AND kind = 'converge' AND status IN ('queued', 'claimed'))`)
    .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ target: change.target_branch, return_to: "verifying", theirs: [] })).run();
}

// Queues the job that writes a merged or closed change's history to refs/cinder/changes/<id> on its target.
// lazy: the files ride in the job payload; move them to storage if a change's history nears D1's 1 MB row limit.
export async function queueHistoryJob(env, change) {
  const files = await changeDO(env, change.id).history();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'history', ?, 'queued', ?, ?)")
    .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ ref: `refs/cinder/changes/${change.id}`, files })).run();
}

// After a merge to target, each active change on it the merge can affect converges onto the new head and returns to its
// state when clean: its lease or written symbols touch the merge's writes, or it reads a symbol whose signature the
// merge changed. The rest are marked behind: the merge claim's base check rebases one at the queue head, and its next
// push converges (work.js). A merge with no recorded writes converges every one.
// Developing changes are skipped until they push; a verifying one has a verify job in flight on its fork, and the
// merge claim's base check sends it to converging if it lands stale. Converging ones (base_moved) re-verify.
// The divergence budget: System 1 scores each change's conflict risk from its commits behind target and its lease's
// overlap with the merged change's, and the riskier converge job is claimed first. No answer leaves priority 0 (FIFO).
// lazy: theirs names only the merge that queued the job; a merge landing while it is queued goes unnamed. Only the
// batch head's writes scope the converge; the rest of a batch reaches a behind change at its queue head.
export async function queueConvergeJobs(env, repoId, target, merged) {
  const { results } = await env.DB.prepare(`SELECT id, state FROM changes c WHERE repo_id = ? AND target_branch = ?
    AND state IN ('needs_fix', 'in_queue', 'converging')
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE change_id = c.id AND kind = 'converge' AND status IN ('queued', 'claimed'))`)
    .bind(repoId, target).all();
  const theirs = [{ id: merged, intent: (await changeDO(env, merged).get())?.intent ?? "" }];
  const lease = async (id) => JSON.parse((await env.DB.prepare("SELECT json_extract(payload, '$.lease') AS l FROM jobs WHERE change_id = ? AND kind = 'develop' ORDER BY created_at DESC LIMIT 1")
    .bind(id).first("l")) ?? "[]");
  const mergedLease = await lease(merged);
  const symbolsOf = async (table, id) => (await env.DB.prepare(`SELECT symbol FROM ${table} WHERE change_id = ?`).bind(id).all()).results.map((r) => r.symbol);
  const { results: writes } = await env.DB.prepare("SELECT symbol, kind FROM change_writes WHERE change_id = ?").bind(merged).all();
  // A lease may name a whole file: it touches every symbol in it.
  const touches = (a, b) => a === b || a === b.split("#")[0] || b === a.split("#")[0];
  const { name } = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(repoId).first();
  const artifacts = createArtifacts(env.ARTIFACTS);
  const targetLog = await artifacts.log(name, target);
  for (const { id, state } of results) {
    const touched = [...await lease(id), ...await symbolsOf("change_writes", id)];
    const reads = await symbolsOf("change_reads", id);
    const symbols = writes.filter((w) => touched.some((s) => touches(s, w.symbol)) || (w.kind === "signature" && reads.some((s) => touches(s, w.symbol))))
      .map((w) => w.symbol);
    if (writes.length && !symbols.length) {
      await env.DB.prepare("INSERT OR IGNORE INTO change_behind (change_id) VALUES (?)").bind(id).run();
      continue;
    }
    // null: the change moved on since the select, so it doesn't converge now.
    const change = state === "converging" ? await changeDO(env, id).get() : await changeDO(env, id).transition("converging", {
      kind: "target_advanced", actor: { type: "system", id: "cinder" }, action: "change.converge", target: id, result: "ok", reason: "target_advanced",
    });
    if (!change) continue;
    const forkShas = new Set((await artifacts.log(change.fork, target)).map((c) => c.sha));
    const behind = targetLog.findIndex((c) => forkShas.has(c.sha));
    const overlap = (await lease(id)).filter((s) => mergedLease.includes(s));
    const { collision } = await judge(env, repoId, "collision", { intent: change.intent, commits_behind: behind < 0 ? targetLog.length : behind, overlap },
      { collision: { kind: "score", prompt: collisionQuestion(merged), guide: COLLISION_GUIDE } }, id);
    const risk = collision.answer === null ? 0 : collision.answer === "yes" ? collision.p : 1 - collision.p;
    const job = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'converge', ?, 'queued', ?, ?)")
        .bind(job, repoId, id, new Date().toISOString(), JSON.stringify({ target, return_to: state === "converging" ? "verifying" : state, theirs, ...(symbols.length && { symbols }) })),
      env.DB.prepare("INSERT INTO job_priorities (job_id, priority) VALUES (?, ?)").bind(job, Math.round(risk * 1000)),
    ]);
  }
}

// GET /api/repos/:name/queue?target= → [QueueEntry], head first.
export async function getQueue(request, env, { name }) {
  const target = new URL(request.url).searchParams.get("target");
  if (!target) return error(400, "bad_request", "target is required");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const { results } = await env.DB.prepare(`SELECT q.repo_id, q.target_branch, q.change_id, q.enqueued_at, b.reason AS blocker FROM queue_entries q
    JOIN changes c ON c.id = q.change_id AND c.state = 'in_queue' LEFT JOIN queue_blockers b ON b.change_id = q.change_id WHERE q.repo_id = ? AND q.target_branch = ? ORDER BY q.seq`)
    .bind(repo.id, target).all();
  return Response.json(results.map((e, position) => ({ ...e, position, speculative_base: null })));
}
