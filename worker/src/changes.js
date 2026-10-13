import { DurableObject } from "cloudflare:workers";
import { CHANGE_PRIORITIES, canTransition, validateChangeEvent, validateConflictObject, validateStageRecord } from "./api/contract.js";
import { createArtifacts } from "./artifacts.js";
import { changeFiles } from "./change-checks.js";
import { moveRef } from "./git/index.js";
import { guardWhy } from "./merge/blockers.js";
import { DEFAULT_RULE, isAllowedTarget } from "./policy.js";
import { enqueue, headsAhead, mergeBlockers, queueHistoryJob, queueMergeJob, respeculate } from "./queue.js";
import { expandRace, startRace } from "./races.js";
import { importBlocked } from "./repos.js";
import { error } from "./router.js";
import { groupsOf, isOwnerEmail, personOf } from "./access.js";
import { recordVerdict, scoreMerge } from "./judgments.js";
import { predictLease } from "./lease.js";
import { can, EMAIL, peopleWhere } from "./people.js";
import { releaseLease, schedule, unblock } from "./scheduler.js";
import { judgeIntentSplit } from "./split.js";
import { openThread, threadsOf } from "./threads.js";
import { notify } from "./webhooks.js";
import { flagStalePages } from "./wiki.js";
import { issueRefs } from "./issues.js";
import { routesOf } from "./routing.js";
import { resolveAgent } from "./agents.js";
import { channelAgent, settleAgents } from "./canary.js";
import { publishWork } from "./work-board.js";

// One per change. Acceptance tests live only here, never in the fork (docs/DESIGN.md §4).
export class ChangeDO extends DurableObject {
  // A change stored before the P0–P3 scale moves to it on first load (D1 cards: migrations/202610081500_labels_priority.sql).
  constructor(ctx, env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      const change = await ctx.storage.get("change");
      const p = { low: "P3", normal: "P2", high: "P1", urgent: "P0" }[change?.priority];
      if (p) await this.#save({ change: { ...change, priority: p } });
    });
  }
  // Empties this instance for POST /api/admin/reset (admin.js).
  async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }
  async create(change, acceptance, actor = { type: "human", id: "owner" }) {
    const event = checked({
      id: crypto.randomUUID(), change_id: change.id, kind: "created", from_state: change.state === "draft" ? null : "draft", to_state: change.state, at: change.created_at,
      actor, action: "change.create", target: change.id, result: "ok",
    });
    await this.#save({ change, acceptance, events: [event] });
    trackEvent(this.env, change.repo_id, event);
  }

  // Every write of the change or its stages goes through here, so its D1 card never lags the DO.
  async #save(entries) {
    await this.ctx.storage.put(entries);
    const { change, stages = [], acceptance = [], events = [] } = Object.fromEntries(await this.ctx.storage.get(["change", "stages", "acceptance", "events"]));
    if (!change) return;
    // Until its develop stage reports, the agent is the one its last claim named, else the one chosen at creation.
    const author = stages.findLast((s) => s.stage === "develop")?.agent_version ?? events.findLast((e) => e.kind === "claimed")?.actor.agent_version ?? change.agent_version;
    const [agent, ver] = author ? author.split("@") : ["owner"];
    const tok = [0, 1, 2].map((i) => stages.reduce((sum, s) => sum + (s.tokens?.[i] ?? 0), 0));
    const risk_judge = change.review ? { name: "risk", p: change.review.p, trusted: change.review.trusted } : null;
    // The search rows are rewritten with the card; question rows come with each judgment (recordJudgment).
    // lazy: reindexes every text of the change on each save; diff the rows past ~1k saves per change.
    const texts = [["intent", change.intent], ...acceptance.map((t) => ["acceptance", t.content]),
      ...stages.map((s) => ["summary", s.outputs?.summary])].filter(([, t]) => typeof t === "string");
    const insert = "INSERT INTO change_search (change_id, source, text) VALUES (?, ?, ?)";
    await this.env.DB.batch([
      this.env.DB.prepare("INSERT INTO change_cards (change_id, card) VALUES (?1, ?2) ON CONFLICT (change_id) DO UPDATE SET card = ?2")
        .bind(change.id, JSON.stringify({ ...change, agent, ver: ver || null, tok, risk_judge })),
      this.env.DB.prepare("DELETE FROM change_search WHERE change_id = ? AND source != 'question'").bind(change.id),
      ...texts.map(([source, text]) => this.env.DB.prepare(insert).bind(change.id, source, text)),
      this.env.DB.prepare("INSERT OR IGNORE INTO issue_links (issue_id, change_id) SELECT id, ?1 FROM issues WHERE repo_id = ?2 AND number IN (SELECT value FROM json_each(?3))")
        .bind(change.id, change.repo_id, JSON.stringify(issueRefs(change.intent))),
    ]);
  }

  async get() {
    const { change, events } = Object.fromEntries(await this.ctx.storage.get(["change", "events"]));
    return change ? { ...change, events: events ?? [] } : null;
  }

  // Returns the stored change, or null when the transition is illegal (nothing is written).
  // `patch` sets change fields along with the state (stacked_on). `guard` is either a state the change must currently be in,
  // or a `conflict` ({theirs, files, hunks, collisions?}) recorded on entering conflict.
  async transition(to, event, patch = {}, guard = null) {
    const { change, events = [], conflicts = [] } = Object.fromEntries(await this.ctx.storage.get(["change", "events", "conflicts"]));
    const from = typeof guard === "string" ? guard : null;
    const conflict = typeof guard === "string" ? null : guard;
    if (from && change?.state !== from) return null;
    const next = transition({ ...change, ...patch }, to, event);
    if (!next) return null;
    const at = next.event.at;
    // Resolved conflicts stay on the change as history.
    const kept = to === "verifying" ? conflicts.map((c) => (c.status === "open" ? { ...c, status: "resolved", resolved_at: at } : c)) : conflicts;
    const added = to === "conflict" && conflict ? [{
      id: crypto.randomUUID(), repo_id: change.repo_id, ours: change.id, theirs: conflict.theirs, files: conflict.files, hunks: conflict.hunks,
      ...(conflict.collisions && { collisions: conflict.collisions }), status: "open", detected_at: at, resolved_at: null,
    }] : [];
    const bad = added.flatMap((c) => validateConflictObject(c).errors);
    if (bad.length) throw new Error(`bad ConflictObject: ${bad.join("; ")}`);
    // lazy: events live in one array value; split into per-event keys past ~1k events or 128 KiB.
    await this.#save({ change: next.change, events: [...events, next.event], conflicts: [...kept, ...added] });
    await this.env.DB.prepare("UPDATE changes SET state = ? WHERE id = ?").bind(to, change.id).run();
    if (to === "merged") await scoreMerge(this.env.DB, next.change, at);
    // An ended change has nothing left to decide: every open item about it clears.
    if (to === "merged" || to === "closed") {
      await this.env.DB.prepare("UPDATE needs SET resolution = 'Cleared', resolved_at = ? WHERE change_id = ? AND resolved_at IS NULL").bind(at, change.id).run();
    }
    if (["merged", "failed", "closed"].includes(to)) await settleAgents(this.env, next.change, to);
    if (to === "merged") {
      await this.env.DB.prepare("UPDATE issues SET state = 'closed', closed_at = ?1, updated_at = ?1 WHERE repo_id = ?2 AND state = 'open' AND number IN (SELECT value FROM json_each(?3))")
        .bind(at, change.repo_id, JSON.stringify(issueRefs(change.intent, true))).run();
    }
    // A queued change leaving the queue (a re-verify that fails, a rebase that changes its head) re-speculates the entries
    // behind it. A merge converges the rest itself (target_advanced); a respeculated entry's own followers are already re-verifying.
    // A verifying change still holding its place (rebased after a refused merge) leaves it the same way.
    if (["in_queue", "converging", "verifying"].includes(change.state) && !["merged", "in_queue"].includes(to) && !["target_advanced", "respeculate"].includes(event.kind)) {
      await respeculate(this.env, next.change, event.kind);
    }
    trackEvent(this.env, change.repo_id, next.event);
    const repo = await this.env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first();
    const repoDO = repo && this.env.REPO_DO.get(this.env.REPO_DO.idFromName(repo.name));
    if (repoDO) await repoDO.broadcast(next.event);
    if (repo) await publishWork(this.env, repo.name, { change_id: change.id });
    await notify(this.env, change.repo_id, "change", next.event);
    // The lease holds the symbols the change touched (verify extends it with any outside the prediction); read it before release.
    if (repoDO && to === "merged") await flagStalePages(this.env.DB, change.repo_id, change.id, (await repoDO.leases(change.target_branch))[change.id]?.symbols ?? []);
    if (repoDO && ["merged", "closed", "failed"].includes(to)) await releaseLease(this.env, next.change, to === "failed");
    if ((to === "merged" || to === "closed") && next.change.fork) {
      // A queued job would mint a token for the deleted fork; the history job is queued after this and still runs.
      await this.env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE change_id = ? AND status = 'queued'").bind(change.id).run();
      const deleteFork = async () => createArtifacts(this.env.ARTIFACTS).delete(next.change.fork);
      const log = (err) => console.error(`fork delete for ${change.id}: ${err.message}`);
      await deleteFork().catch((err) => { log(err); return deleteFork(); }).catch(log);
    }
    if (repoDO) await repoDO.touch(change.repo_id, change.target_branch);
    await unblock(this.env, next.change);
    // An agent-driven change back for a fix repairs itself; a person-driven one waits for its driver.
    if (to === "needs_fix" && !next.change.driver && !next.change.head_branch) return this.#repair(next.change, event, repoDO);
    return next.change;
  }

  // Queues one develop job per round, up to the agent version's limits.max_repairs (default 2); past that the change fails.
  async #repair(change, event, repoDO) {
    // A review's unresolved threads (a person's request_changes body becomes one only after this), else the failing log tail.
    const threads = ["changes_requested", "review_failed"].includes(event.kind) ? (await threadsOf(this.env, change.id)).filter((t) => !t.resolved)
      .map((t) => (t.path ? `${t.path}:${t.line}: ` : "") + t.comments.map((c) => c.body).join("\n\n")) : [];
    const failure = [...threads, event.reason].filter(Boolean).join("\n\n");
    const [, name, version] = /^(.+)@v(\d+)$/.exec(change.agent_version ?? "") ?? [];
    const max = (name && await this.env.DB.prepare("SELECT json_extract(limits, '$.max_repairs') AS m FROM agent_versions WHERE name = ? AND version = ?")
      .bind(name, Number(version)).first("m")) ?? 2;
    const round = (change.repair?.round ?? 0) + 1;
    const step = { actor: { type: "system", id: "cinder" }, action: event.action, target: event.target };
    if (round > max) return this.transition("failed", { kind: "repairs_exhausted", ...step, result: "failed", reason: `repairs exhausted (${max} of ${max}): ${failure}` });
    const check = event.kind === "changes_requested" ? "review" : event.kind.replace(/_failed$/, "");
    const started = await this.stageEvent({ kind: "repair_started", round, max, check, ...step, result: "ok" }, { repair: { round, max, check } });
    // A race leg records no agent_version on the change, only on its develop job: the repair names the same agent.
    const agent = change.agent_version ?? JSON.parse(await this.env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'develop' ORDER BY created_at DESC LIMIT 1")
      .bind(change.id).first("payload") ?? "{}").agent;
    if (repoDO) await repoDO.broadcast(started);
    await this.env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) SELECT ?1, ?2, 'develop', ?3, 'queued', ?4, ?5
      WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE change_id = ?3 AND kind = 'develop' AND status IN ('queued', 'claimed') AND id NOT IN (SELECT job_id FROM job_cancels))`)
      // The repair runs on the change's own version, as its first develop did (scheduler.js); without it the claim falls back to the harness default.
      .bind(crypto.randomUUID(), change.repo_id, change.id, started.at, JSON.stringify({ repair: round, max, failure, ...(agent && { agent }) })).run();
    return { ...change, repair: { round, max, check } };
  }

  // A new head supersedes every job still queued or running for the change; the runner kills it on its next heartbeat.
  async moveHead(sha, fork) {
    const change = await this.ctx.storage.get("change");
    if (!change || change.head === sha) return;
    await this.#save({ change: { ...change, head: sha, fork: fork ?? change.fork } });
    await this.env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE change_id = ? AND status IN ('queued', 'claimed')").bind(change.id).run();
  }

  // A stage's run or skip decision; no state change. `patch` sets change fields along with it.
  async stageEvent(event, patch = {}) {
    const { change, events = [] } = Object.fromEntries(await this.ctx.storage.get(["change", "events"]));
    if (!change) throw new Error("no change");
    const at = new Date().toISOString();
    const stored = checked({ id: crypto.randomUUID(), change_id: change.id, ...event, from_state: null, to_state: null, at });
    // The routing decision (risk.js routeChange) is made only once verify passes: a repaired change is no longer repairing.
    // The round stays so a later failure still counts against max_repairs.
    if (event.kind === "routed" && event.action === "stage.decide" && change.repair) patch = { ...patch, repair: { ...change.repair, passed: true } };
    await this.#save({ change: { ...change, ...patch }, events: [...events, stored] });
    trackEvent(this.env, change.repo_id, stored);
    const repo = await this.env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first("name");
    if (repo) await publishWork(this.env, repo, { change_id: change.id });
    return stored;
  }

  async conflicts() {
    return (await this.ctx.storage.get("conflicts")) ?? [];
  }

  async setReview(review) {
    const change = await this.ctx.storage.get("change");
    if (!change) throw new Error("no change to route");
    await this.#save({ change: { ...change, review } });
  }

  async setGuard(guard) {
    const change = await this.ctx.storage.get("change");
    if (!change) throw new Error("no change to guard");
    await this.#save({ change: { ...change, guard } });
  }

  // Records actor's approval of the current head, replacing its earlier one. Returns the change, null when there is
  // no change, false when refused: an agent approval from the develop stage's agent version (or when no develop stage
  // is recorded, so the author is unknown). A human may approve whatever the review route.
  async approve(actor) {
    const { change, stages = [] } = Object.fromEntries(await this.ctx.storage.get(["change", "stages"]));
    if (!change) return null;
    const author = stages.findLast((s) => s.stage === "develop")?.agent_version;
    if (actor.type === "agent" && (!author || !actor.agent_version || actor.agent_version === author)) return false;
    const approval = { actor, head_sha: change.head ?? null, at: new Date().toISOString() };
    const next = { ...change, approvals: [...(change.approvals ?? []).filter((a) => a.actor.id !== actor.id), approval] };
    await this.#save({ change: next });
    return next;
  }

  // reviewer is { person } or { agent_version }; requesting one already requested changes nothing.
  // Returns the change, or null when there is none.
  async requestReviewer(reviewer) {
    const change = await this.ctx.storage.get("change");
    if (!change) return null;
    const reviewers = change.reviewers ?? [];
    if (reviewers.some((r) => r.person === reviewer.person && r.agent_version === reviewer.agent_version)) return change;
    const next = { ...change, reviewers: [...reviewers, reviewer] };
    await this.#save({ change: next });
    return next;
  }

  // actor drops the requested reviewer who (a person or an agent version), recording a reviewer_removed event whose
  // reason names the requested people auto-queue still waits on. Returns the change, or null when there is none.
  async removeReviewer(who, actor) {
    const change = await this.ctx.storage.get("change");
    if (!change) return null;
    const reviewers = (change.reviewers ?? []).filter((r) => (r.person ?? r.agent_version) !== who);
    if (reviewers.length === (change.reviewers ?? []).length) return change;
    const waits = reviewers.filter((r) => r.person && !approvedHead(change, r.person)).map((r) => r.person).join(", ");
    await this.stageEvent({ kind: "reviewer_removed", actor, action: "reviewer.remove", target: who, result: "ok", ...(waits && { reason: waits }) }, { reviewers });
    return this.ctx.storage.get("change");
  }

  // driver is the person editing the change, null while the agent drives. Returns the change, or null when there is none.
  async setDriver(driver) {
    const change = await this.ctx.storage.get("change");
    if (!change) return null;
    const next = { ...change, driver };
    await this.#save({ change: next });
    return next;
  }

  // An owner approves every dependency the last guard found; a new guard result lists them unapproved again.
  async approveDeps() {
    const change = await this.ctx.storage.get("change");
    if (!change) return null;
    const at = new Date().toISOString();
    const deps = (change.guard?.deps ?? []).map((d) => ({ ...d, approved_at: d.approved_at ?? at }));
    const next = { ...change, ...(change.guard && { guard: { ...change.guard, deps } }) };
    await this.#save({ change: next });
    return next;
  }

  // Messages wait here for the agent's next turn; takeMessages hands each one over once.
  async addMessage(message) {
    await this.ctx.storage.put("messages", [...(await this.ctx.storage.get("messages") ?? []), message]);
  }

  async takeMessages() {
    const messages = (await this.ctx.storage.get("messages")) ?? [];
    await this.ctx.storage.delete("messages");
    return messages;
  }

  async proposeSplit(proposal) {
    await this.ctx.storage.put("split", proposal);
  }

  // Each stage report appends its provenance; an invalid record is rejected, never stored.
  async report(record) {
    const { ok, errors } = validateStageRecord(record);
    if (!ok) throw new Error(`bad StageRecord: ${errors.join("; ")}`);
    await this.#save({ stages: [...(await this.ctx.storage.get("stages") ?? []), record] });
    const tokens = Array.isArray(record.tokens) ? record.tokens.reduce((a, b) => a + b, 0) : record.tokens ?? 0;
    const cache_reads = record.cache_reads ?? record.tokens?.[2] ?? 0;
    const change = await this.ctx.storage.get("change");
    // A verify stage is the verdict the merge gate reads, for the head it ran on.
    // lazy: a fork push landing while a verify runs gets its verdict; carry the verified sha in the report if that happens.
    if (change && record.stage === "verify") await this.#save({ change: { ...change, verdict: { sha: change.head ?? null, status: record.verdict, at: new Date().toISOString() } } });
    if (change) track(this.env, change.repo_id, ["stage", change.id, record.stage, record.verdict ?? ""], [Date.parse(record.started_at), record.cost_usd, tokens, cache_reads]);
  }

  // Wiki pages develop claims handed the agent; a re-claim of the same page version isn't listed twice.
  async useWiki(pages) {
    const used = (await this.ctx.storage.get("wiki")) ?? [];
    for (const p of pages) if (!used.some((u) => u.id === p.id && u.sha === p.sha)) used.push(p);
    await this.ctx.storage.put("wiki", used);
  }

  async stages() {
    return (await this.ctx.storage.get("stages")) ?? [];
  }

  // The files a history job commits to refs/cinder/changes/<id> (docs/DESIGN.md §7); events stay in recorded order.
  async history() {
    const { change, acceptance = [], events = [], stages = [], wiki = [] } = Object.fromEntries(await this.ctx.storage.get(["change", "acceptance", "events", "stages", "wiki"]));
    const { results } = await this.env.DB.prepare("SELECT j.*, o.actual, o.correct, o.observed_at FROM judgments j " +
      "LEFT JOIN outcomes o ON o.judgment_id = j.id WHERE j.change_id = ? ORDER BY j.made_at").bind(change.id).all();
    const jsonl = (rows) => rows.map((r) => `${JSON.stringify(r)}\n`).join("");
    return {
      "intent.md": change.intent,
      ...Object.fromEntries(acceptance.map((t) => [`acceptance/${t.path}`, t.content])),
      "events.jsonl": jsonl(events), "judgments.jsonl": jsonl(results), "stages.json": JSON.stringify(stages),
      ...(wiki.length && { "wiki.json": JSON.stringify(wiki) }),
    };
  }
}

// A human-routed change waits for a human approval of its current head before it may queue.
export const awaitsHuman = (change) => change.review?.route === "human" &&
  !change.approvals?.some((a) => a.actor.type === "human" && a.head_sha === (change.head ?? null));

const approvedHead = (change, who) => Boolean(change.approvals?.some((a) =>
  (a.actor.id === who || a.actor.agent_version === who) && a.head_sha === (change.head ?? null)));

// A requested person who hasn't approved the current head holds a verified change out of the queue.
export const pendingReviewer = (change) => (change.reviewers ?? []).some((r) => r.person && !approvedHead(change, r.person));

// Why the change can't join its merge queue, or null when it can: the one rule POST /queue, auto-queue and the page's
// Ready (GET's queue_blocker) share. Verified at the current head, then approved as its route and requested reviewers need.
export async function queueBlocker(env, change) {
  if (change.state !== "verifying") return `Change is ${change.state}`;
  if (!change.review) return "Verifier hasn't passed";
  // review survives a head move (moveHead), so a verify still pending on the new head holds the change until it passes.
  if (await env.DB.prepare("SELECT 1 FROM jobs WHERE change_id = ? AND kind = 'verify' AND status IN ('queued', 'claimed') AND id NOT IN (SELECT job_id FROM job_cancels)")
    .bind(change.id).first()) return "Verifier hasn't passed the head";
  if (!change.head) return "No head pushed";
  if (change.verdict?.sha !== change.head) return "Verifier hasn't passed the head";
  if (change.review.route === "agent") return "Awaiting agent review";
  if (awaitsHuman(change)) return "Awaiting human approval";
  if (pendingReviewer(change)) return "Waiting on requested reviewers";
  return null;
}

// Queues a verified change once nothing holds it: a route that isn't waiting on an agent review, no pending requested
// person or human approval (transition), no verify pending on the head, auto-queue on and the target rule's merge queue on. Returns the queued change or null.
export async function autoQueue(env, id, event) {
  const stub = changeDO(env, id);
  const change = await stub.get();
  if (!change || await queueBlocker(env, change)) return null;
  if ((await env.DB.prepare("SELECT auto_queue FROM change_views WHERE change_id = ?").bind(id).first("auto_queue")) === 0) return null;
  const repo = await env.DB.prepare("SELECT name, default_branch FROM repos WHERE id = ?").bind(change.repo_id).first();
  const rule = (await env.REPO_DO.get(env.REPO_DO.idFromName(repo.name)).policy(repo.name, repo.default_branch)).rules
    .find((r) => r.branch === change.target_branch) ?? DEFAULT_RULE;
  if (!rule.queue) return null;
  const queued = await stub.transition("in_queue", event, {}, "verifying");
  if (!queued) return null;
  await enqueue(env, queued);
  await queueMergeJob(env, queued.repo_id, queued.target_branch);
  return queued;
}

export function transition(change, to, event) {
  if (!canTransition(change.state, to)) return null;
  if (to === "in_queue" && awaitsHuman(change)) return null;
  const at = new Date().toISOString();
  return {
    change: { ...change, state: to, updated_at: at },
    event: checked({ id: crypto.randomUUID(), change_id: change.id, ...event, from_state: change.state, to_state: to, at }),
  };
}

// An event that can't be recorded aborts whatever it records: thrown before anything is written.
function checked(event) {
  const { ok, errors } = validateChangeEvent(event);
  if (!ok) throw new Error(`bad ChangeEvent: ${errors.join("; ")}`);
  return event;
}

// One Analytics Engine point (INSIGHTS) per change event or stage report; GET insights reads them back (insights.js).
// blobs: kind, change id, then from state, to state, actor type, actor id (event) or stage, verdict (stage). doubles: at (ms), cost, tokens, cache reads.
const track = (env, repoId, blobs, doubles) => env.INSIGHTS.writeDataPoint({ indexes: [repoId], blobs, doubles });
const trackEvent = (env, repoId, e) => track(env, repoId, ["event", e.change_id, e.from_state ?? "", e.to_state ?? "", e.actor.type, e.actor.id], [Date.parse(e.at), 0, 0, 0]);

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));

const isAcceptance = (list) => Array.isArray(list) &&
  list.every((t) => typeof t?.path === "string" && t.path !== "" && typeof t.content === "string");

// createChange's and patchChange's check of priority and labels: the 400 for a bad one, else null.
function badFields(priority, labels) {
  if (priority !== undefined && !CHANGE_PRIORITIES.includes(priority)) return error(400, "bad_request", `priority must be one of ${CHANGE_PRIORITIES.join(", ")}`);
  if (labels !== undefined && !(Array.isArray(labels) && labels.every((l) => typeof l === "string" && l))) return error(400, "bad_request", "labels must be a list of non-empty strings");
  return null;
}

// PATCH /api/changes/:id {priority?, labels?, agent_pushes?} → the change, for its author, its driver or repo.write on it;
// agent_pushes only for the driver or an owner. Recorded as an edited event, which publishes work.updated.
export async function patchChange(request, env, { id }) {
  const body = await request.json().catch(() => null);
  if (!body || typeof body !== "object" || Array.isArray(body)) return error(400, "bad_request", "body must be an object");
  const { priority, labels, agent_pushes: agentPushes } = body;
  if (priority === undefined && labels === undefined && agentPushes === undefined) return error(400, "bad_request", "body must set priority, labels or agent_pushes");
  if (agentPushes !== undefined && typeof agentPushes !== "boolean") return error(400, "bad_request", "agent_pushes must be a boolean");
  const bad = badFields(priority, labels);
  if (bad) return bad;
  const stub = changeDO(env, id);
  const current = await stub.get();
  if (!current) return error(404, "not_found", `no change ${id}`);
  const caller = personOf(request);
  const author = current.events.find((e) => e.kind === "created")?.actor.id;
  if (caller !== "owner" && !isOwnerEmail(env, caller) && caller !== author && caller !== current.driver &&
    !(await can(env, caller, "PATCH", new URL(request.url).pathname, null, groupsOf(request)))) return error(403, "forbidden", "only the author, the driver or repo.write may edit a change");
  if (agentPushes !== undefined && caller !== current.driver && caller !== "owner" && !isOwnerEmail(env, caller)) return error(403, "forbidden", "only the driver or an owner may set agent_pushes");
  // Read first, so an invalid .cinder.yml refuses the edit rather than leaving it half applied.
  const repo = labels !== undefined && await env.DB.prepare("SELECT name, default_branch FROM repos WHERE id = ?").bind(current.repo_id).first();
  const routes = repo && await routesOf(env, current.repo_id, (await env.REPO_DO.get(env.REPO_DO.idFromName(repo.name)).policy(repo.name, repo.default_branch)).routes);
  await stub.stageEvent({ kind: "edited", actor: { type: "human", id: caller }, action: "change.edit", target: id, result: "ok" },
    { ...(priority !== undefined && { priority }), ...(labels !== undefined && { labels }), ...(agentPushes !== undefined && { agent_pushes: agentPushes }) });
  if (labels !== undefined) await routeByLabel(env, { ...current, labels }, routes ?? [], current.labels);
  // Allowing agent pushes queues afresh the latest develop job when a commit of it was refused (commits.js); the copy is
  // newer than the refusal, so a second toggle queues nothing.
  const refused = current.events.findLast((e) => e.kind === "agent_push_refused" && e.commits)?.at;
  if (agentPushes === true && current.agent_pushes === false && refused) {
    await env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload)
      SELECT ?1, repo_id, kind, change_id, 'queued', ?2, json_remove(payload, '$.messages') FROM jobs
      WHERE id = (SELECT id FROM jobs WHERE change_id = ?3 AND kind = 'develop' ORDER BY created_at DESC LIMIT 1) AND created_at <= ?4`)
      .bind(crypto.randomUUID(), new Date().toISOString(), id, refused).run();
  }
  return Response.json(await stub.get());
}

// An agent version as name@vN, the version spec resolves to now, so a later promote or rollback moves only new changes;
// null when it resolves to none.
async function pinAgent(env, spec) {
  const id = await resolveAgent(env, spec).catch(() => null);
  const pinned = id && await env.DB.prepare("SELECT name, version FROM agent_versions WHERE id = ?").bind(id).first();
  return pinned ? `${pinned.name}@v${pinned.version}` : null;
}

// Applies the first of the policy's routes whose label the change carries, unless it was already the first match for
// `before` (the labels it had), with a routed event naming the rule. agent pins develop's agent while no develop job has
// been claimed, driver makes it that person's change, reviewer requests them. Returns the change, or null when no rule applied.
async function routeByLabel(env, change, routes = [], before = []) {
  const first = (labels) => routes.find((r) => labels?.includes(r.label));
  const rule = first(change.labels);
  if (!rule || rule === first(before)) return null;
  const stub = changeDO(env, change.id);
  const kind = ["agent", "driver", "reviewer"].find((k) => rule[k]);
  const patch = {};
  if (kind === "agent" && ["draft", "planned", "leased", "waiting"].includes(change.state)) {
    patch.agent_version = (await pinAgent(env, rule.agent)) ?? rule.agent;
    await env.DB.prepare("UPDATE jobs SET payload = json_set(payload, '$.agent', ?) WHERE change_id = ? AND kind = 'develop' AND status = 'queued'")
      .bind(patch.agent_version, change.id).run();
  }
  if (kind === "driver") patch.driver = rule.driver.trim().toLowerCase();
  if (kind === "reviewer") await stub.requestReviewer(EMAIL.test(rule.reviewer) ? { person: rule.reviewer.trim().toLowerCase() } : { agent_version: rule.reviewer });
  await stub.stageEvent({ kind: "routed", actor: { type: "system", id: "cinder" }, action: "change.edit", target: change.id, result: "ok",
    reason: `routes: label ${rule.label} → ${kind} ${rule[kind]}` }, patch);
  return stub.get();
}

export async function createChange(request, env, { name }) {
  if (!(await env.CHANGE_LIMIT.limit({ key: `${personOf(request)} ${name}` })).success) return error(429, "rate_limited", `too many changes on ${name}; retry in a minute`);
  const body = await request.json().catch(() => null);
  const { intent, target_branch: target, head_branch: head, agent_version: agentVersion, acceptance = [], race, author, draft = false, priority, labels, agent_pushes: agentPushes = false } = body ?? {};
  const caller = personOf(request);
  if (author !== undefined && caller !== "owner" && !isOwnerEmail(env, caller)) return error(403, "forbidden", "only the owner may set author");
  if (author !== undefined && (typeof author !== "string" || !EMAIL.test(author.trim()))) return error(400, "bad_request", "author must be an email");
  if (typeof intent !== "string" || !intent.trim()) return error(400, "bad_request", "intent must be a non-empty string");
  if (target !== undefined && (typeof target !== "string" || !target)) return error(400, "bad_request", "target_branch must be a non-empty string");
  if (head !== undefined && (typeof head !== "string" || !head)) return error(400, "bad_request", "head_branch must be a non-empty string");
  if (agentVersion !== undefined && (typeof agentVersion !== "string" || !agentVersion)) return error(400, "bad_request", "agent_version must be a non-empty string");
  const bad = badFields(priority, labels);
  if (bad) return bad;
  if (!isAcceptance(acceptance)) return error(400, "bad_request", "acceptance must be [{path, content}]");
  if (typeof draft !== "boolean") return error(400, "bad_request", "draft must be a boolean");
  if (typeof agentPushes !== "boolean") return error(400, "bad_request", "agent_pushes must be a boolean");
  if (draft && race !== undefined) return error(400, "bad_request", "a race cannot start as a draft");
  if (head !== undefined && race !== undefined) return error(400, "bad_request", "a race cannot start on an existing head_branch");
  const matrix = race === undefined ? null : expandRace(race);
  if (race !== undefined && !matrix) {
    return error(400, "bad_request", "race must be {agent|model|harness: [...], include, exclude, max_parallel} expanding to 2-8 distinct legs");
  }
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const blocked = await importBlocked(env, repo, name);
  if (blocked) return blocked;
  const policy = await env.REPO_DO.get(env.REPO_DO.idFromName(name)).policy(name, repo.default_branch);
  const branch = target ?? policy.integration[0];
  if (!isAllowedTarget(policy, branch)) return error(422, "target_not_allowed", `branch policy does not allow target ${branch}`);
  if (head === branch) return error(400, "bad_request", "head_branch must differ from the target");
  if (head && !(await createArtifacts(env.ARTIFACTS).log(name, head)).length) return error(404, "not_found", `unknown head branch ${head}`);

  const person = author === undefined ? caller : author.trim().toLowerCase();
  if (author !== undefined) {
    await env.DB.prepare("INSERT INTO people (email, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(person, new Date().toISOString()).run();
  }
  // An agent-written change records its version pinned: the one picked, else developer's canary for its share of change
  // ids, else developer's stable. A pick that resolves to no version is kept as given.
  const id = crypto.randomUUID();
  const recorded = (!head && !matrix && (agentVersion ? await pinAgent(env, agentVersion) : (await channelAgent(env, "develop", id)).agent_version)) || agentVersion;
  const create = async () => {
    const change = await newChange(env, name, repo.id, intent, branch, acceptance, "change", person ? { type: "human", id: person } : { type: "system", id: "cinder" }, draft,
      // A change from a branch is the person's: they drive it, and agents push to it only when they allowed it.
      { ...(!matrix && { id }), ...(head && { head_branch: head, driver: person, agent_pushes: agentPushes }), ...(recorded && { agent_version: recorded }), ...(priority && { priority }), ...(labels && { labels }) },
      // The caller requests it, so its jobs run on the caller's model keys, never on the author's.
      caller);
    return (await routeByLabel(env, change, await routesOf(env, repo.id, policy.routes))) ?? change;
  };
  if (matrix) {
    const changes = [];
    while (changes.length < matrix.legs.length) changes.push(await create());
    return Response.json(await startRace(env, changes, matrix), { status: 201 });
  }
  const change = await create();
  if (draft) return Response.json(change, { status: 201 });
  return Response.json(await scheduleNew(env, name, change), { status: 201 });
}

async function scheduleNew(env, name, change) {
  // A change from a branch already carries its commits, so no agent develops it: it verifies on the branch's head.
  if (change.head_branch) {
    const artifacts = createArtifacts(env.ARTIFACTS);
    const sha = (await artifacts.log(change.fork, change.head_branch))[0]?.sha ?? null;
    // Converge, merge and develop work on the fork's target-named branch, so it starts at the head; a failed move
    // throws rather than verify a change whose converge would drop its commits.
    const at = (await artifacts.log(change.fork, change.target_branch))[0]?.sha;
    if (sha && at && at !== sha) await moveRef(await artifacts.get(change.fork), `refs/heads/${change.target_branch}`, at, sha);
    return (await verifyHead(env, change, sha, "planned")) ?? change;
  }
  await judgeIntentSplit(env, change);
  const sha = (await createArtifacts(env.ARTIFACTS).log(name, change.target_branch))[0]?.sha ?? null;
  // An unindexed head would predict an empty lease: the change stays planned until its index lands (scheduleIndexed).
  if (sha && await env.REPO_DO.get(env.REPO_DO.idFromName(name)).awaitIndex(change.repo_id, change.target_branch, sha, change.id)) return change;
  const scheduled = await schedule(env, change.id, await predictLease(env, change.repo_id, sha, change.intent));
  return scheduled ?? change;
}

// Leases the changes that waited for sha's index of repo `name` from it, and starts them. A failed index job
// calls this too: its changes then start from whatever is indexed rather than wait forever.
export async function scheduleIndexed(env, name, sha) {
  for (const id of await env.REPO_DO.get(env.REPO_DO.idFromName(name)).takeIndexWaits(sha)) {
    const change = await changeDO(env, id).get();
    if (change) await schedule(env, id, await predictLease(env, change.repo_id, sha, change.intent));
  }
}

// The states a person's new commit sends back to verifying; verifying itself re-runs on the new head.
export const REVERIFY = ["planned", "leased", "verifying", "needs_fix", "failed"];

// Moves a person's change from `from` to verifying with a verify job on sha, its head (verify is the merge gate,
// whoever wrote the commits); null with no head, a head already verifying (a redelivered push) or when the change had moved on.
export async function verifyHead(env, change, sha, from) {
  if (!sha || (from === "verifying" && change.head === sha)) return null;
  const stub = changeDO(env, change.id);
  const moved = from === "verifying" ? change : await stub.transition("verifying", {
    kind: "verify_queued", actor: { type: "system", id: "cinder" }, action: "change.push", target: change.id, result: "ok",
  }, {}, from);
  if (!moved) return null;
  // Cancels every job still queued or running on the old head, an earlier verify among them.
  await stub.moveHead(sha);
  await env.DB.batch([
    env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?1, ?2) ON CONFLICT DO UPDATE SET head_sha = ?2").bind(change.id, sha),
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(), JSON.stringify({ head_sha: sha, ahead: await headsAhead(env, moved) })),
    // Every head the verifier checks is guarded too: a merge needs a clean guard result for it. A first head has no
    // before, so the runner diffs it from its merge-base with the target.
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'guard', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), change.repo_id, change.id, new Date().toISOString(),
        JSON.stringify({ fork: change.fork, before: change.head ?? "", after: sha, target: change.target_branch })),
  ]);
  return moved;
}

// POST /api/changes/:id/ready: draft → planned, then scheduled like a new change. Only its author or an owner.
export async function readyChange(request, env, { id }) {
  const stub = changeDO(env, id);
  const current = await stub.get();
  if (!current) return error(404, "not_found", `no change ${id}`);
  const caller = personOf(request);
  const author = current.events.find((e) => e.kind === "created")?.actor.id;
  if (caller !== "owner" && !isOwnerEmail(env, caller) && caller !== author) return error(403, "forbidden", "only the author or an owner may mark a change ready");
  const change = await stub.transition("planned", {
    kind: "ready", actor: { type: "human", id: caller }, action: "stage.decide", target: id, result: "ok",
  }, {}, "draft");
  if (!change) return error(409, "illegal_transition", `cannot mark a ${current.state} change ready`);
  const repo = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first();
  return Response.json(await scheduleNew(env, repo.name, change));
}

// A change's key: its repo's name uppercased without non-alphanumerics, then its number (web-store, 3 → WEBSTORE-3).
const keyPrefix = (name) => name.toUpperCase().replace(/[^A-Z0-9]/g, "");
export const changeKey = (name, number) => (number == null ? null : `${keyPrefix(name)}-${number}`);

export async function newChange(env, name, repoId, intent, branch, acceptance, kind = "change", actor, draft = false, fields = {}, requester = actor?.type === "human" ? actor.id : null) {
  const id = fields.id ?? crypto.randomUUID();
  const now = new Date().toISOString();
  // The number is taken in the insert itself and the unique index refuses a repeat, so changes of a repo never share one. Its key names the fork.
  const { number, fork } = await env.DB.prepare(
    `INSERT INTO change_numbers (change_id, repo_id, number, fork)
     SELECT ?1, ?2, n, ?3 || n FROM (SELECT coalesce(max(number), 0) + 1 AS n FROM change_numbers WHERE repo_id = ?2) RETURNING number, fork`,
  ).bind(id, repoId, `${name}--${keyPrefix(name)}-`).first();
  try {
    await createArtifacts(env.ARTIFACTS).fork(name, fork);
  } catch (err) {
    await env.DB.prepare("DELETE FROM change_numbers WHERE change_id = ?").bind(id).run();
    throw err;
  }
  // A non-draft goes draft → planned on store: nothing runs in between, so the stored record is already planned.
  const change = {
    id, repo_id: repoId, number, key: changeKey(name, number), kind, title: intent.trim().split("\n")[0], intent, target_branch: branch,
    state: draft ? "draft" : "planned", fork, stacked_on: null, risk: null, created_at: now, updated_at: now, ...fields,
  };
  await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).create(change, acceptance, actor);
  await env.DB.prepare("INSERT INTO changes (id, repo_id, target_branch, state, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, repoId, branch, change.state, now).run();
  // Its jobs record this person as their requester (migrations/202610072200_job_requesters.sql).
  if (requester) await env.DB.prepare("INSERT INTO change_requesters VALUES (?, ?)").bind(id, requester).run();
  return change;
}

// SQL for a change card's priority rank (CHANGE_PRIORITIES order, P2 when unset); higher goes first.
export const PRIORITY_RANK = (card) => `(SELECT key FROM json_each('${JSON.stringify(CHANGE_PRIORITIES)}') WHERE value = coalesce(json_extract(${card}, '$.priority'), 'P2'))`;

// GET /api/repos/:name/changes?target=&state=&label=&priority=&sort=priority|age; sort applies to the open list (age: oldest first).
export async function listChanges(request, env, { name }) {
  const params = new URL(request.url).searchParams;
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  // Ended changes are paged newest first: 50 per page, `next` is the last row's "at,id".
  const paged = ["failed", "closed", "merged"].includes(params.get("state"));
  const since = paged && params.get("since") ? new Date(params.get("since")) : null;
  const cursor = paged ? params.get("cursor") : null;
  const cut = cursor?.indexOf(",") ?? -1;
  if (Number.isNaN(since?.getTime()) || (cursor !== null && cut < 1)) return error(400, "bad_request", "since must be a timestamp and cursor a next value from this list");
  const priority = params.get("priority");
  const sort = params.get("sort") ?? "age";
  if (priority !== null && !CHANGE_PRIORITIES.includes(priority)) return error(400, "bad_request", `priority must be one of ${CHANGE_PRIORITIES.join(", ")}`);
  if (!["priority", "age"].includes(sort)) return error(400, "bad_request", "sort must be priority or age");
  // lease_n: the symbols the change's latest develop job leases. diff: the change head's cached summary (DIFF_OF).
  const start = Date.now();
  const { results } = await env.DB.prepare(
    `SELECT c.id, n.number, h.head_sha, k.card, (SELECT json_array_length(j.payload, '$.lease') FROM jobs j WHERE j.change_id = c.id AND j.kind = 'develop'
      ORDER BY j.created_at DESC LIMIT 1) AS lease_n, ${DIFF_OF} AS diff, COALESCE(m.merged_at, c.created_at) AS at FROM changes c LEFT JOIN change_heads h ON h.change_id = c.id
      LEFT JOIN change_numbers n ON n.change_id = c.id LEFT JOIN change_cards k ON k.change_id = c.id LEFT JOIN change_merges m ON m.change_id = c.id
      WHERE c.repo_id = ?1 AND (?2 IS NULL OR c.target_branch = ?2) AND (?3 IS NULL OR c.state = ?3) AND (?4 IS NULL OR at >= ?4) AND (?5 IS NULL OR (at, c.id) < (?5, ?6))
      AND (?7 IS NULL OR ?7 IN (SELECT value FROM json_each(k.card, '$.labels'))) AND (?8 IS NULL OR coalesce(json_extract(k.card, '$.priority'), 'P2') = ?8)
      ORDER BY ${paged ? "at DESC, c.id DESC LIMIT 51" : sort === "priority" ? `${PRIORITY_RANK("k.card")} DESC, c.created_at` : "c.created_at"}`,
  ).bind(repo.id, params.get("target"), params.get("state"), since?.toISOString() ?? null, cursor && cursor.slice(0, cut), cursor && cursor.slice(cut + 1),
    params.get("label"), priority).all();
  // lazy: failed and closed changes sort by created_at, since D1 keeps no end time for them; store one if "newest" must mean newest ended.
  const page = paged ? results.slice(0, 50) : results;
  const db = Date.now() - start;
  const changes = await Promise.all(page.map(async ({ id, number, head_sha, card, lease_n, diff }) => {
    // A change last written before cards existed has none until its next write, so it is read from its DO once.
    const change = card ? JSON.parse(card) : await changeDO(env, id).get();
    delete change.events;
    const kind = ["draft", "planned"].includes(change.state) ? "none" : change.state === "waiting" ? "pending"
      : ["merged", "closed", "failed"].includes(change.state) ? "released" : change.kind === "seam" ? "seam" : "held";
    const { additions = null, deletions = null } = (await diffSummary(env, name, change, head_sha, diff)) ?? {};
    // lazy: one DO read per failed change; store the failure on the card if failed changes pile up.
    const failure = change.state === "failed" && failureOf(await changeDO(env, id).get(), await failedTests(env, id));
    return { ...change, number, key: changeKey(name, number), head_sha, adds: additions, dels: deletions, lease: { kind, n: kind === "none" ? null : lease_n ?? null }, ...(failure && { failure }), ...blockedOf(change) };
  }));
  // Server-Timing: the list query, then the cards (DO reads, diff summaries not cached yet, failures).
  const headers = { "Server-Timing": `db;dur=${db}, cards;dur=${Date.now() - start - db}` };
  if (!paged) return Response.json(changes, { headers });
  return Response.json({ changes, next: results.length > 50 ? `${page.at(-1).at},${page.at(-1).id}` : null }, { headers });
}

// SQL for a change head's diff summary {files_changed, additions, deletions, ahead, behind} over aliases c (changes) and
// h (change_heads): the newest compare reported for the head, else its head_diffs row; NULL when neither has it yet.
export const DIFF_OF = `COALESCE((SELECT json_set(json_extract(p.result, '$.stats'), '$.ahead', json_extract(p.result, '$.ahead'),
  '$.behind', json_extract(p.result, '$.behind')) FROM compares p WHERE p.repo_id = c.repo_id AND p.head_sha = h.head_sha ORDER BY p.rowid DESC LIMIT 1),
  (SELECT d.summary FROM head_diffs d WHERE d.repo_id = c.repo_id AND d.head_sha = h.head_sha))`;

// A change's diff summary from cached (its DIFF_OF column), null without a head. A head neither has is counted once from
// the lines its Files changed tab shows and kept in head_diffs; ahead and behind stay null until a compare reports them.
// A fork Artifacts can't read (deleted, unreachable) is logged and shows no diff; the next list tries again.
export async function diffSummary(env, name, change, head_sha, cached) {
  if (cached) return JSON.parse(cached);
  if (!head_sha) return null;
  let files;
  try {
    files = await changeFiles(createArtifacts(env.ARTIFACTS), name, change);
  } catch (err) {
    console.error(`diff of ${change.id}@${head_sha}: ${err.message}`);
    return null;
  }
  const lines = files.flatMap((f) => f.lines ?? []);
  const summary = { files_changed: files.length, additions: lines.filter((l) => l[0] === "+").length, deletions: lines.filter((l) => l[0] === "-").length, ahead: null, behind: null };
  // An empty diff isn't kept: a head with no files is almost always one its fork couldn't be read at yet, and recounting is cheap.
  if (files.length) await env.DB.prepare("INSERT OR IGNORE INTO head_diffs VALUES (?, ?, ?)").bind(change.repo_id, head_sha, JSON.stringify(summary)).run();
  return summary;
}

// The tests failing at a change's head (test_runs keeps the latest result per test per sha).
export async function failedTests(env, id) {
  const { results } = await env.DB.prepare("SELECT t.test FROM change_heads h JOIN changes c ON c.id = h.change_id JOIN test_runs t ON t.repo = c.repo_id " +
    "AND t.sha = h.head_sha WHERE h.change_id = ? AND t.status = 'fail' ORDER BY t.test").bind(id).all();
  return results.map((r) => r.test);
}

// An open change's guard blocker as its why-line, the same text as its Needs you item.
function blockedOf(change) {
  const why = !["merged", "closed"].includes(change.state) && guardWhy(change.guard).find(Boolean);
  return why ? { blocked: why } : {};
}

// A failed change's guard blocker (quarantine, then unapproved dependencies), else its last failed step, its reason
// and the tests failing at its head, from the event that moved it to failed.
export function failureOf(change, tests) {
  if (change?.guard?.status === "quarantined") return { stage: "guard", reason: `quarantined: ${change.guard.reason}` };
  const unapproved = (change?.guard?.deps ?? []).filter((d) => !d.approved_at).map((d) => `${d.ecosystem} ${d.name}@${d.version}`);
  if (unapproved.length) return { stage: "guard", reason: `dependency needs approval: ${unapproved.join(", ")}` };
  const failed = change?.events.findLast((e) => e.to_state === "failed");
  return failed && { stage: failed.kind === "repairs_exhausted" ? "repair limit" : failed.kind.replace(/_failed$/, ""), reason: failed.reason ?? null, ...(tests.length && { check: tests.join(", ") }) };
}

export async function getChange(request, env, params) {
  const start = Date.now();
  // With ?repo=<name>, :id may be the change's key in that repo (PULSE-6).
  const repo = new URL(request.url).searchParams.get("repo");
  const number = repo && /^[A-Z0-9]+-(\d+)$/.exec(params.id)?.[1];
  const keyed = number && changeKey(repo, Number(number)) === params.id && await env.DB.prepare(
    "SELECT n.change_id FROM change_numbers n JOIN repos r ON r.id = n.repo_id WHERE r.name = ? AND n.number = ?").bind(repo, Number(number)).first("change_id");
  const id = keyed || params.id;
  const change = await changeDO(env, id).get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const got = Date.now();
  const requested = (change.reviewers ?? []).map((r) => r.person ?? r.agent_version).map((who) => ({ who, state: approvedHead(change, who) ? "approved" : "pending" }));
  // Approve and request changes post to review, which needs change.approve (people.js); the router lets owners through.
  const review = `/api/changes/${id}/review`;
  const person = personOf(request);
  // The reads below are independent of each other, so they run at once.
  const [numbered, head_sha, auto, job, can_approve, { results: wiki_context }, approvers, blockers, failed, queue_blocker] = await Promise.all([
    env.DB.prepare("SELECT n.number, r.name FROM changes c JOIN repos r ON r.id = c.repo_id LEFT JOIN change_numbers n ON n.change_id = c.id WHERE c.id = ?").bind(id).first(),
    env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(id).first("head_sha"),
    env.DB.prepare("SELECT auto_queue FROM change_views WHERE change_id = ?").bind(id).first("auto_queue"),
    // The latest commit job (an edit from Code, edit.js) until it lands; the page shows it while head_sha is still missing.
    env.DB.prepare("SELECT status, json_extract(payload, '$.path') AS path FROM jobs WHERE change_id = ? AND kind = 'commit' AND id NOT IN (SELECT job_id FROM job_cancels) ORDER BY created_at DESC, rowid DESC LIMIT 1")
      .bind(id).first(),
    person === "owner" || isOwnerEmail(env, person) || can(env, person, "POST", review, null, groupsOf(request)),
    // The wiki pages (at the sha handed over) its develop claims gave the agent, first use first.
    env.DB.prepare(`SELECT p.id, p.title, c.sha FROM job_wiki_context c JOIN jobs j ON j.id = c.job_id
    JOIN wiki_pages p ON p.id = c.page_id WHERE j.change_id = ? AND j.kind = 'develop' GROUP BY p.id, c.sha ORDER BY MIN(j.rowid)`).bind(id).all(),
    peopleWhere(env, (p) => can(env, p, "POST", review)),
    mergeBlockers(env, change),
    change.state === "failed" ? failedTests(env, id) : null,
    queueBlocker(env, change),
  ]);
  // Server-Timing: the change's Durable Object read, then the D1 and access reads.
  const headers = { "Server-Timing": `do;dur=${got - start}, db;dur=${Date.now() - got}` };
  return Response.json({ ...change, number: numbered?.number ?? null, key: numbered && changeKey(numbered.name, numbered.number), can_approve, wiki_context, approvers, ...(change.review && { review: { ...change.review, requested } }), head_sha, commit_job: job?.status === "done" ? null : job, blockers,
    auto_queue: auto !== 0, queue_blocker, ...(change.state === "failed" && { failure: failureOf(change, failed) }), ...blockedOf(change) }, { headers });
}

// Only owners reach this route (router.js): the OWNER_TOKEN or an OWNERS person. Body: optional {reason}.
export async function closeChange(request, env, { id }) {
  const { reason = "" } = (await request.json().catch(() => null)) ?? {};
  if (typeof reason !== "string" || reason.length > 500) return error(400, "bad_request", "reason must be a string of at most 500 characters");
  const stub = changeDO(env, id);
  const current = await stub.get();
  if (!current) return error(404, "not_found", `no change ${id}`);
  const by = personOf(request), why = reason.trim();
  const change = await stub.transition("closed", {
    kind: "closed", actor: { type: "human", id: by }, action: "change.close", target: id, result: "ok", ...(why && { reason: why }),
  }, { closed_by: by, closed_at: new Date().toISOString(), ...(why && { close_reason: why }) });
  if (!change) return error(409, "illegal_transition", `cannot close a ${current.state} change`);
  await queueHistoryJob(env, change);
  return Response.json(change);
}

// POST /api/changes/:id/retry (repo.write): a failed change goes back to verifying with one verify job on its head,
// which re-runs only the tests failing at the head (all of them when none failed); the event's reason names them.
export async function retryChange(request, env, { id }) {
  const only = await failedTests(env, id);
  const change = await changeDO(env, id).transition("verifying", {
    kind: "retried", actor: { type: "human", id: personOf(request) }, action: "stage.decide", target: id, result: "ok", ...(only.length && { reason: only.join(", ") }),
  }, {}, "failed");
  if (!change) {
    const current = await changeDO(env, id).get();
    return current ? error(409, "not_failed", `change ${id} is ${current.state}, not failed`) : error(404, "not_found", `no change ${id}`);
  }
  // The repair count is the change's uncancelled failed verify jobs (work.js MAX_VERIFY_FAILURES); cancelling them resets it.
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE change_id = ? AND kind = 'verify' AND status = 'failed'").bind(id),
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'verify', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), change.repo_id, id, new Date().toISOString(), JSON.stringify({ ahead: await headsAhead(env, change), ...(only.length && { only }) })),
  ]);
  return Response.json(change, { status: 202 });
}

// Only owners reach this route (router.js): the human approval a human review route waits for. An approval of the
// head releases a verified change into the merge queue.
export async function approveChange(request, env, { id }) {
  const actor = { type: "human", id: personOf(request) };
  const change = await changeDO(env, id).approve(actor);
  if (change === null) return error(404, "not_found", `no change ${id}`);
  // A verified change this approval releases (the human route's approval, or the last requested person's) queues.
  return Response.json(await autoQueue(env, id, { kind: "approved", actor, action: "stage.decide", target: id, result: "ok" }) ?? change);
}

// POST /api/changes/:id/review {verdict: approve|request_changes|comment, body}. Approve is approveChange; request_changes
// sends the change back for a fix. A non-approve body opens an unresolved thread, so it reaches the next develop claim.
export async function reviewChange(request, env, params) {
  const { verdict, body = "" } = (await request.json().catch(() => null)) ?? {};
  if (!["approve", "request_changes", "comment"].includes(verdict) || typeof body !== "string") {
    return error(400, "bad_request", "body must be {verdict: approve|request_changes|comment, body: string}");
  }
  const change = await changeDO(env, params.id).get();
  if (!change) return error(404, "not_found", `no change ${params.id}`);
  const person = personOf(request);
  // The router lets any person through: a comment needs repo.write (a thread), approve and request_changes change.approve.
  const path = `/api/changes/${params.id}/${verdict === "comment" ? "threads" : "review"}`;
  if (person !== "owner" && !isOwnerEmail(env, person) && !(await can(env, person, "POST", path, null, groupsOf(request)))) {
    return error(403, "forbidden", `a ${verdict} review needs ${verdict === "comment" ? "repo.write" : "change.approve"}`);
  }
  let res = null;
  if (verdict === "approve") {
    res = await approveChange(request, env, params);
    if (!res.ok) return res;
  }
  if (verdict === "request_changes") {
    const moved = await changeDO(env, params.id).transition("needs_fix", {
      kind: "changes_requested", actor: { type: "human", id: person }, action: "stage.decide", target: params.id, result: "failed", ...(body && { reason: body }),
    });
    if (!moved) return error(409, "bad_state", `change ${params.id} is ${change.state}, which can't go back for a fix`);
  }
  if (verdict !== "approve" && (verdict === "comment" || body.trim())) {
    if (!body.trim()) return error(400, "bad_request", "body must be a non-empty string");
    const thread = await openThread(env, change, { body }, person);
    if (!thread.ok) return thread;
  }
  // A comment carries no pass or fail, so only approve and request_changes are judgments.
  if (verdict !== "comment") await recordVerdict(env.DB, change, { person, verdict: verdict === "approve" ? "pass" : "fail" });
  return res ?? Response.json(await changeDO(env, params.id).get());
}

// Only owners reach this route (router.js): approves the dependencies the change adds.
export async function approveDeps(request, env, { id }) {
  const change = await changeDO(env, id).approveDeps();
  return change ? Response.json(change) : error(404, "not_found", `no change ${id}`);
}
