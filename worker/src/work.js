import { DurableObject } from "cloudflare:workers";
import { AGENTS_REPO, DEFAULT_EGRESS, ensureAgentsRepo, resolveAgent } from "./agents.js";
import { JOB_KINDS } from "./api/contract.js";
import { createArtifacts } from "./artifacts.js";
import { guardChange } from "./guard.js";
import { recordCollisionOutcomes, recordVerdict, scoreSeam } from "./judgments.js";
import { recordScan } from "./findings.js";
import { quarantineFailures, scoreFlakes } from "./flakes.js";
import { recordCollisions, recordEditing } from "./collisions.js";
import { enforceLease, scoreLease } from "./lease.js";
import { maskedJson } from "./keystore.js";
import { flowJobClaimed, flowJobReported } from "./flows.js";
import { enqueue, headsAhead, mergeBatch, QUEUE_HEADS, queueConvergeJob, queueConvergeJobs, queueHistoryJob, queueMergeJob } from "./queue.js";
import { settleLeg } from "./races.js";
import { reacquireLeases } from "./scheduler.js";
import { finishScan, queueScan } from "./scans.js";
import { openThread, threadsOf } from "./threads.js";
import { routeChange } from "./risk.js";
import { DEFAULT_RULE } from "./policy.js";
import { planDeploy } from "./deploy.js";
import { runTick, SLOT_MS } from "./tick.js";
import { autoQueue, awaitsHuman, changeKey, pendingReviewer, PRIORITY_RANK, scheduleIndexed } from "./changes.js";
import { error, runnerOf } from "./router.js";
import { channelAgent } from "./canary.js";
import { notify } from "./webhooks.js";
import { wikiContext } from "./wiki.js";
import { budgetUse } from "./overview.js";
import { forget, NEEDS_FULL_IMAGE, POOL_TAKES, retire, stopIfIdle } from "./workers.js";
import { changedFiles, recordMerge } from "./merges.js";
import { changeFiles } from "./change-checks.js";

const LEASE_SECONDS = 7200;
const MERGE_TOKEN_SECONDS = 600;
// These kinds get fork write + target read (docs/DESIGN.md §4). Only a merge job for its queue's head gets target write.
const FORK_KINDS = ["develop", "resolve", "verify", "converge", "commit"];
// Next change state for a report, per job kind and status (docs/DESIGN.md §6).
const NEXT = {
  develop: { done: "verifying", failed: "failed" },
  resolve: { done: "verifying", failed: "failed" },
  commit: { done: "verifying", failed: "failed" },
  converge: { done: "verifying", failed: "conflict" },
  verify: { done: "in_queue", failed: "needs_fix" },
  // A clean review leaves the change where it is; a blocker sends it back for a fix.
  review: { failed: "needs_fix" },
  // A refused push (the target moved) rebases and re-verifies.
  merge: { done: "merged", failed: "converging" },
};
// The job a change entering a state needs, and the state claiming that job moves the change to.
const QUEUES = { verifying: "verify", conflict: "resolve" };
const CLAIMED = { develop: "developing", resolve: "resolving", commit: "developing" };
// Kinds that run as an agent version; a merge names the version that developed the change.
export const AGENT_KINDS = ["develop", "resolve", "review", "merge"];
// The kinds that run an agent harness (opencode, claude, codex).
export const HARNESS_KINDS = ["develop", "resolve", "review"];
const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
const leaseEnd = () => new Date(Date.now() + LEASE_SECONDS * 1000).toISOString();

// Every claim goes through one instance, one at a time, so no two runners ever get the same job.
export class DispatchDO extends DurableObject {
  // Empties this instance for POST /api/admin/reset (admin.js).
  async wipe() {
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
    await this.ctx.storage.setAlarm((Math.floor(Date.now() / SLOT_MS) + 1) * SLOT_MS + 30_000); // the tick outlives a reset
  }
  // The periodic tick (tick.js): true when the 10-minute slot holding `time` hasn't run yet, which takes it. Keeps the alarm
  // set for the next slot, 30 s after the cron's, so the alarm runs a slot only when the cron didn't.
  async takeSlot(time) {
    const slot = Math.floor(time / SLOT_MS);
    await this.ctx.storage.setAlarm((slot + 1) * SLOT_MS + 30_000);
    if ((await this.ctx.storage.get("slot")) === slot) return false;
    await this.ctx.storage.put("slot", slot);
    return true;
  }
  async arm() {
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }
  async alarm() {
    const time = Math.floor(Date.now() / SLOT_MS) * SLOT_MS;
    if (await this.takeSlot(time)) await runTick(this.env, time);
  }
  // repoId (a managed pool's assignment) limits the claim to that repo's jobs; null claims from any repo.
  // slim (a lite or basic pool worker) skips jobs that need the full image's toolchains.
  // The runner's pool (`me`, managed or BYO) must take the job (POOL_TAKES), and a BYO pool holding max_concurrent live
  // claims takes nothing; a runner outside a BYO pool counts 0 there. A runner already holding its stored `slots` live leases takes nothing.
  // lite (a lite pool worker: 1/16 vCPU, 256 MiB) never takes a harness job: an agent CLI there crawls for hours without a model call.
  async claim(runnerId, kinds, repoId = null, slim = false, slots, lite = false) {
    // At or over the month's token budget no agent job starts, repair rounds included; verify, scan and flow jobs keep running.
    if ((await budgetUse(this.env.DB)).paused) kinds = kinds.filter((k) => !AGENT_KINDS.includes(k));
    if (lite) kinds = kinds.filter((k) => !HARNESS_KINDS.includes(k));
    // Jobs go by their change's priority (P0 first), then their risk priority (job_priorities), then age.
    // Gate jobs (guard, verify, merge, history) are short and hold up a change's delivery, so they go before older long jobs of the same priority.
    // D1 calls don't hold the input gate, so block explicitly; an expired lease makes the job claimable again.
    return this.ctx.blockConcurrencyWhile(() => this.env.DB.prepare(`WITH me AS (SELECT pool_id FROM pool_members WHERE runner_id = ?1 UNION ALL SELECT pool_id FROM byo_members WHERE runner_id = ?1)
      UPDATE jobs SET status = 'claimed', runner_id = ?1, lease_expires_at = ?2
      WHERE id = (SELECT id FROM jobs LEFT JOIN job_priorities ON job_id = id WHERE kind IN (SELECT value FROM json_each(?3))
        AND id NOT IN (SELECT job_id FROM job_cancels) AND (status = 'queued' OR (status = 'claimed' AND lease_expires_at <= ?4))
        AND (SELECT count(*) FROM jobs h WHERE h.runner_id = ?1 AND h.status = 'claimed' AND h.lease_expires_at > ?4) < ?7
        AND (?5 IS NULL OR repo_id = ?5) AND (?6 = 0 OR NOT ${NEEDS_FULL_IMAGE}) AND (kind <> 'merge' OR change_id IN (${QUEUE_HEADS})) AND (kind <> 'scan' OR status = 'queued')
        AND ${POOL_TAKES("(SELECT pool_id FROM me)")} AND (SELECT count(*) FROM jobs c JOIN byo_members b ON b.runner_id = c.runner_id
          WHERE b.pool_id = (SELECT pool_id FROM me) AND c.status = 'claimed' AND c.lease_expires_at > ?4)
          < coalesce((SELECT max_concurrent FROM pool_settings WHERE pool_id = (SELECT pool_id FROM me)), 8)
        AND (kind <> 'develop' OR change_id NOT IN (SELECT id FROM changes WHERE state = 'waiting'))
        AND (kind NOT IN ('develop', 'verify') OR change_id NOT IN (SELECT change_id FROM lease_lapses))
        AND (kind <> 'develop' OR (json_extract(payload, '$.max_parallel') > (SELECT count(*) FROM jobs r WHERE r.kind = 'develop' AND r.status = 'claimed'
          AND r.lease_expires_at > ?4 AND json_extract(r.payload, '$.race') = json_extract(jobs.payload, '$.race'))) IS NOT 0)
        ORDER BY ${PRIORITY_RANK("(SELECT card FROM change_cards k WHERE k.change_id = jobs.change_id)")} DESC, coalesce(priority, 0) DESC, kind IN ('guard', 'verify', 'merge', 'history') DESC, created_at LIMIT 1)
      RETURNING *`).bind(runnerId, leaseEnd(), JSON.stringify(kinds), new Date().toISOString(), repoId, slim ? 1 : 0, slots).first());
  }
}

// POST /api/work/claim {kinds, slots_free} → Claim (api/shapes/claim.js), or 204 when nothing fits.
export async function claimWork(request, env) {
  const runner = await runnerOf(request, env);
  // A worker whose pool token was revoked takes no more work; it is forgotten once it holds no job, so running jobs finish.
  const revoked = await env.DB.prepare(`SELECT 1 FROM byo_member_tokens m WHERE runner_id = ?
    AND NOT EXISTS (SELECT 1 FROM byo_pool_tokens WHERE id = m.pool_token_id)`).bind(runner.runner_id).first();
  if (revoked) {
    if (!(await env.DB.prepare("SELECT 1 FROM jobs WHERE runner_id = ? AND status = 'claimed'").bind(runner.runner_id).first())) await forget(env, runner.runner_id);
    return error(401, "token_revoked", "this worker's pool token was revoked");
  }
  if (!(await env.CLAIM_LIMIT.limit({ key: runner.runner_id })).success) return error(429, "rate_limited", "too many claims from this runner; retry in a minute");
  const body = (await request.json().catch(() => null)) ?? {};
  const allowed = JSON.parse(runner.kinds);
  const kinds = body.kinds ?? allowed;
  const slots = body.slots_free ?? 1;
  if (!Array.isArray(kinds) || !kinds.every((k) => JOB_KINDS.includes(k)) || !Number.isInteger(slots) || slots < 0) {
    return error(400, "bad_request", `body must be {kinds, slots_free} with kinds from: ${JOB_KINDS.join(", ")}`);
  }
  await env.DB.prepare("INSERT INTO runner_heartbeats (runner_id, last_heartbeat_at, slots) VALUES (?, ?, ?) ON CONFLICT DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at, slots = excluded.slots")
    .bind(runner.runner_id, new Date().toISOString(), slots).run();
  const claimable = kinds.filter((k) => allowed.includes(k));
  const pool = await env.DB.prepare("SELECT pool_id, repo_id, draining, coalesce((SELECT size FROM pool_member_sizes s WHERE s.runner_id = pool_members.runner_id), worker_pools.size) AS size FROM pool_members JOIN worker_pools ON id = pool_id WHERE runner_id = ?").bind(runner.runner_id).first();
  if (!slots || !claimable.length || pool?.draining) return new Response(null, { status: 204 });

  await ensureAgentsRepo(env);
  await reacquireLeases(env);
  const dispatch = env.DISPATCH_DO.get(env.DISPATCH_DO.idFromName("global"));
  // Live leases cap at the slots stored for the runner, never the slots_free it sends: a stolen token can't claim more.
  // A pool worker, or a runner registered without slots, runs one claim loop.
  const stored = (await env.DB.prepare("SELECT slots FROM runner_slots WHERE runner_id = ?").bind(runner.runner_id).first("slots")) ?? 1;
  const row = await dispatch.claim(runner.runner_id, claimable, pool?.repo_id ?? null, Boolean(pool) && !pool.size.startsWith("standard-"), stored, pool?.size === "lite");
  if (!row) {
    if (pool) await stopIfIdle(env, runner.runner_id);
    return new Response(null, { status: 204 });
  }
  const { payload, ...job } = row;
  // A re-claim after an expired lease keeps the first start.
  if (pool) await env.DB.prepare("INSERT INTO pool_runs (job_id, pool_id, start_s, started_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
    .bind(job.id, pool.pool_id, (Date.now() - Date.parse(job.created_at)) / 1000, new Date().toISOString()).run();

  const stub = job.change_id && changeDO(env, job.change_id);
  let change = stub ? await stub.get() : null;
  // A quarantined change is never verified: the job fails before any token is minted and the change goes back for a fix.
  if (job.kind === "verify" && ["quarantined", "discarded"].includes(change?.guard?.status)) {
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").bind(job.id).run();
    await stub.transition("needs_fix", {
      kind: "quarantined", actor: { type: "system", id: "cinder" }, action: "job.claim", target: job.id, result: "failed", reason: change.guard.reason,
    });
    return new Response(null, { status: 204 });
  }
  // A closed change's fork is deleted while its queued jobs remain, and a new change's fork may not be listed yet:
  // without this every claim that picked such a job crashed minting the missing fork's token. A finished change's job
  // fails; any other goes back to the queue for a later claim.
  if (change && [...FORK_KINDS, "review", "guard"].includes(job.kind) && !(await createArtifacts(env.ARTIFACTS).get(change.fork))) {
    const finished = ["closed", "merged", "failed"].includes(change.state);
    console.warn(`claim: job ${job.id} (${job.kind}) ${finished ? "failed" : "requeued"}: no fork ${change.fork}`);
    await env.DB.prepare("UPDATE jobs SET status = ?, runner_id = NULL, lease_expires_at = NULL WHERE id = ?").bind(finished ? "failed" : "queued", job.id).run();
    return new Response(null, { status: 204 });
  }
  const agent = change && AGENT_KINDS.includes(job.kind) ? await agentLock(env, change.id, job.kind, JSON.parse(payload)) : null;
  // No recorded version: the runner runs its defaults, named as in the merge trailer.
  const defaultAgent = change && AGENT_KINDS.includes(job.kind) && !agent ? "cinder-agent@v0" : null;
  // A null transition just means the change is already developing/resolving (a re-claim after an expired lease).
  // The claim names the driving agent, so the change card shows it before the develop stage reports.
  if (change && CLAIMED[job.kind]) change = (await stub.transition(CLAIMED[job.kind], {
    kind: "claimed", actor: { type: "system", id: runner.runner_id, runner: runner.runner_id, name: runner.name, ...(AGENT_KINDS.includes(job.kind) && {
      agent_version: agent ? `${agent.agent}@v${agent.version}` : defaultAgent }) }, action: "job.claim", target: job.id, result: "ok",
  })) ?? change;
  // A change-bound job learns where its fork and target live; a verify job also gets the repo's policy check.
  let forkRemote = null;
  let targetRemote = null;
  let check = null;
  let leases = null;
  let wiki = null;
  if (change) {
    const repo = await env.DB.prepare("SELECT name, default_branch FROM repos WHERE id = ?").bind(change.repo_id).first();
    const artifacts = createArtifacts(env.ARTIFACTS);
    forkRemote = (await (await artifacts.get(change.fork))?.info())?.remote ?? null;
    targetRemote = (await (await artifacts.get(repo.name))?.info())?.remote ?? null;
    if (job.kind === "verify") check = (await env.REPO_DO.get(env.REPO_DO.idFromName(repo.name)).policy(repo.name, repo.default_branch)).check;
    // Every lease granted on the target, which the verify logs against the files the change touches.
    if (job.kind === "verify") {
      leases = Object.entries(await env.REPO_DO.get(env.REPO_DO.idFromName(repo.name)).leases(change.target_branch))
        .filter(([, l]) => l.granted).flatMap(([holder, l]) => l.symbols.map((symbol) => ({ symbol, holder })));
    }
    // Flagged wiki pages always go; FTS matches on the intent only with .cinder.yml wiki.context on.
    if (job.kind === "develop") {
      const fts = (await env.REPO_DO.get(env.REPO_DO.idFromName(repo.name)).policy(repo.name, repo.default_branch)).wiki?.context;
      wiki = await wikiContext(env, change.repo_id, fts ? change.intent : "");
    }
  }
  let { token, readToken } = change ? await changeTokens(env, change, job.kind) : { token: null, readToken: null };
  let batch = null;
  if (change && job.kind === "merge") {
    const { name } = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first();
    const artifacts = createArtifacts(env.ARTIFACTS);
    const base = (await artifacts.log(name, change.target_branch))[0]?.sha;
    const forkLog = await artifacts.log(change.fork, change.target_branch);
    batch = await mergeBatch(env, change.repo_id, change.target_branch);
    // Merge refuses unless the fork descends from the target's current head and the head's speculation still holds:
    // no token, back to converging with a converge job that rebases and re-verifies it.
    const refused = base && !forkLog.some((c) => c.sha === base) ? "base_moved" : batch[0]?.change_id !== change.id ? "stale_speculation" : null;
    if (refused) {
      await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").bind(job.id).run();
      await stub.transition("converging", {
        kind: refused, actor: { type: "system", id: "cinder" }, action: "job.claim", target: job.id, result: "failed", reason: refused,
      });
      await queueConvergeJob(env, change);
      await queueMergeJob(env, change.repo_id, change.target_branch);
      return new Response(null, { status: 204 });
    }
    token = (await artifacts.createToken(name, "write", MERGE_TOKEN_SECONDS)).token;
    // The merge fetches each fork's head, so it reads each fork for as long as it writes the target. The batch stops at
    // a fork that's gone; the report merges the same batch, and its tokens only go to the runner.
    const landing = [];
    for (const e of batch) {
      const landed = await changeDO(env, e.change_id).get();
      const fork = landed?.fork;
      const repo = fork && await artifacts.get(fork);
      if (!repo) break;
      // The key and title make the merge commit's subject (PULSE-6: <title>).
      const number = await env.DB.prepare("SELECT number FROM change_numbers WHERE change_id = ?").bind(e.change_id).first("number");
      landing.push({ ...e, key: changeKey(name, number), title: landed.title, remote: (await repo.info()).remote,
        token: (await artifacts.createToken(fork, "read", MERGE_TOKEN_SECONDS)).token });
    }
    batch = landing;
    await env.DB.prepare("UPDATE jobs SET payload = json_set(payload, '$.batch', json(?)) WHERE id = ?")
      .bind(JSON.stringify(batch.map(({ change_id, head_sha, tree, base }) => ({ change_id, head_sha, tree, base }))), job.id).run();
  }
  if (change && job.kind === "history") {
    const { name } = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first();
    token = (await createArtifacts(env.ARTIFACTS).createToken(name, "write", MERGE_TOKEN_SECONDS)).token;
  }
  const jobPayload = JSON.parse(payload);
  if (check) jobPayload.check = check;
  if (leases) jobPayload.leases = leases;
  if (batch) jobPayload.batch = batch;
  // A speculative verify merges each change ahead from its fork. One whose fork is gone has merged (it's on the target)
  // or left the queue; the merge's tree check refuses a tree verified without a change that's still ahead.
  if (change && job.kind === "verify" && jobPayload.ahead?.length) {
    const artifacts = createArtifacts(env.ARTIFACTS);
    const ahead = [];
    for (const a of jobPayload.ahead) {
      const fork = (await changeDO(env, a.change_id).get())?.fork;
      const repo = fork && await artifacts.get(fork);
      if (repo) ahead.push({ ...a, remote: (await repo.info()).remote, token: (await artifacts.createToken(fork, "read", MERGE_TOKEN_SECONDS)).token });
    }
    jobPayload.ahead = ahead;
  }
  // The pages handed to the agent, and their shas, go into the change's provenance (wiki.json in its history).
  if (wiki?.length) {
    jobPayload.wiki = wiki;
    await stub.useWiki(wiki.map(({ id, title, sha }) => ({ id, title, sha })));
    await env.DB.batch(wiki.map((p) => env.DB.prepare("INSERT OR REPLACE INTO job_wiki_context (job_id, page_id, sha) VALUES (?, ?, ?)").bind(job.id, p.id, p.sha)));
  }
  // A person's messages reach the agent on its next turn; they stay on the job so a re-claim after an expired lease keeps them.
  const messages = change && job.kind === "develop" ? await stub.takeMessages() : [];
  if (messages.length) {
    jobPayload.messages = [...(jobPayload.messages ?? []), ...messages];
    await env.DB.prepare("UPDATE jobs SET payload = ? WHERE id = ?").bind(JSON.stringify(jobPayload), job.id).run();
  }
  // Unresolved review threads steer the repair round; read at claim time so a thread resolved meanwhile drops out.
  const threads = change && job.kind === "develop" ? (await threadsOf(env, change.id)).filter((t) => !t.resolved) : [];
  if (threads.length) jobPayload.threads = threads.map(({ path, line, comments }) => ({ path, line, body: comments.map((c) => c.body).join("\n\n") }));
  // A release commits the draft and pushes its tag to the agents repo, so it gets agents-repo write.
  if (job.kind === "release") {
    const artifacts = createArtifacts(env.ARTIFACTS);
    // While cinder-agents isn't ready (missing, or still being created) the job goes back to the queue, not a 500.
    const agents = await artifacts.get(AGENTS_REPO).catch((e) => {
      if (/being created/.test(e?.message)) return null;
      throw e;
    });
    if (!agents) {
      await env.DB.prepare("UPDATE jobs SET status = 'queued', runner_id = NULL, lease_expires_at = NULL WHERE id = ?").bind(job.id).run();
      return new Response(null, { status: 204 });
    }
    token = (await artifacts.createToken(AGENTS_REPO, "write", MERGE_TOKEN_SECONDS)).token;
    jobPayload.remote = (await agents.info()).remote;
  }
  // A scan reads the target's head as of now; its scans row records that sha. A target with no commits has nothing to scan.
  if (job.kind === "scan") {
    const { name, default_branch: branch } = await env.DB.prepare("SELECT name, default_branch FROM repos WHERE id = ?").bind(job.repo_id).first();
    const artifacts = createArtifacts(env.ARTIFACTS);
    jobPayload.sha = (await artifacts.log(name, jobPayload.target))[0]?.sha;
    if (!jobPayload.sha) {
      await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ?").bind(job.id).run();
      return new Response(null, { status: 204 });
    }
    jobPayload.check = (await env.REPO_DO.get(env.REPO_DO.idFromName(name)).policy(name, branch)).check;
    await env.DB.prepare("UPDATE jobs SET payload = ? WHERE id = ?").bind(JSON.stringify(jobPayload), job.id).run();
    await env.DB.prepare("INSERT INTO scans (job_id, repo_id, target, source, sha, started_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(job.id, job.repo_id, jobPayload.target, jobPayload.source, jobPayload.sha, new Date().toISOString()).run();
    // The runner clones once at the start, so the read token needs no longer than a merge's.
    readToken = (await artifacts.createToken(name, "read", MERGE_TOKEN_SECONDS)).token;
    targetRemote = (await (await artifacts.get(name)).info()).remote;
  }
  // A refs job runs one git ls-remote, so its read token gets the binding's minimum ttl.
  if (job.kind === "refs") {
    const { name } = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(job.repo_id).first();
    const artifacts = createArtifacts(env.ARTIFACTS);
    readToken = (await artifacts.createToken(name, "read", 60)).token;
    targetRemote = (await (await artifacts.get(name)).info()).remote;
  }
  // Index, blame and compare clone their store (a change's blame reads its fork) once at the start, then PUT the
  // result to the runner route of payload.repo.
  if (["index", "blame", "compare"].includes(job.kind)) {
    jobPayload.repo = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(job.repo_id).first("name");
    const store = jobPayload.store ?? jobPayload.repo;
    const artifacts = createArtifacts(env.ARTIFACTS);
    readToken = (await artifacts.createToken(store, "read", MERGE_TOKEN_SECONDS)).token;
    targetRemote = (await (await artifacts.get(store)).info()).remote;
  }
  // A flow run clones its repo once at the start, then runs its steps on that checkout.
  if (job.kind === "flow") {
    await flowJobClaimed(env, job.id, runner.runner_id, pool?.size ?? null);
    // A change-triggered run checks out the change's fork, where its sha is.
    const name = jobPayload.fork ?? (await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(job.repo_id).first("name"));
    const artifacts = createArtifacts(env.ARTIFACTS);
    readToken = (await artifacts.createToken(name, "read", MERGE_TOKEN_SECONDS)).token;
    targetRemote = (await (await artifacts.get(name)).info()).remote;
  }
  if (change) delete change.events;
  // The runner's pool egress, for flow steps' proxy; no pool or an empty allow list means the default hosts.
  const net = await env.DB.prepare(`SELECT egress, egress_allow FROM pool_settings WHERE pool_id IN
    (SELECT pool_id FROM pool_members WHERE runner_id = ?1 UNION ALL SELECT pool_id FROM byo_members WHERE runner_id = ?1)`).bind(runner.runner_id).first();
  const allow = JSON.parse(net?.egress_allow ?? "[]");
  return Response.json({ job, payload: jobPayload, change, token, read_token: readToken, fork_remote: forkRemote, target_remote: targetRemote, agent,
    default_agent: defaultAgent, egress: { mode: net?.egress ?? "allowlist", allow: allow.length ? allow : DEFAULT_EGRESS } });
}

// A change job's tokens last MERGE_TOKEN_SECONDS; the runner's heartbeat (every 5 min) gets fresh ones before they expire.
async function changeTokens(env, change, kind) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  // The push guard is read-only: it reads the fork and never gets a write token. The reviewer gets no token at all:
  // it reads its diff from GET /api/work/jobs/:job/diff (review-diff.js).
  if (kind === "guard") return { token: null, readToken: (await artifacts.createToken(change.fork, "read", MERGE_TOKEN_SECONDS)).token };
  if (!FORK_KINDS.includes(kind)) return { token: null, readToken: null };
  const target = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first();
  return {
    token: (await artifacts.createToken(change.fork, "write", MERGE_TOKEN_SECONDS)).token,
    readToken: (await artifacts.createToken(target?.name, "read", MERGE_TOKEN_SECONDS)).token,
  };
}

// An agent's failed develop or resolve job runs once more on another version before its change fails: the agent's other
// channel, else dev-open for the developer. A limit stop (max spend or tokens) never retries: raising a limit is the owner's.
// Returns the change, or null when there's no retry (a person's change, a race leg, a retry already, no other version).
async function retryOnOtherVersion(env, job, payload, detail) {
  const change = await changeDO(env, job.change_id).get();
  const key = payload.agent ? "agent" : "agent_version";
  const [, name, version] = /^(.+)@v(\d+)$/.exec(payload[key] ?? "") ?? [];
  if (!name || !change || change.driver || change.head_branch || payload.race || payload.retry_of || /^max (spend|tokens) reached$/.test(detail ?? "")) return null;
  const other = (n, v) => env.DB.prepare("SELECT version FROM channels WHERE agent_name = ? AND version <> ? ORDER BY channel = 'stable' DESC LIMIT 1").bind(n, v).first("version");
  const alt = await other(name, Number(version)).then((v) => v && `${name}@v${v}`)
    ?? (name === "developer" ? await other("dev-open", 0).then((v) => v && `dev-open@v${v}`) : null);
  if (!alt) return null;
  const at = new Date().toISOString();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, ?, ?, 'queued', ?, ?)")
    .bind(crypto.randomUUID(), job.repo_id, job.kind, job.change_id, at, JSON.stringify({ ...payload, [key]: alt, retry_of: job.id })).run();
  await changeDO(env, job.change_id).stageEvent({ kind: "retry", actor: { type: "system", id: "cinder" }, action: "job.report", target: job.id,
    result: "failed", reason: `${payload[key]} failed; retrying once on ${alt}${detail ? `: ${String(detail).slice(-300)}` : ""}` });
  return changeDO(env, job.change_id).get();
}

// The release lock a job runs as: a develop job names its agent (and a race leg its model and harness), a merge runs as
// the change's latest develop job, a review or resolve job as the agent_version recorded when it was queued. null when
// nothing resolves, so the harness runs its defaults. limits.tokens_month is the version's gateway tokens this UTC calendar month.
export async function agentLock(env, changeId, kind, payload) {
  const leg = kind === "develop" ? payload : kind === "merge"
    ? JSON.parse((await env.DB.prepare("SELECT payload FROM jobs WHERE change_id = ? AND kind = 'develop' ORDER BY created_at DESC LIMIT 1").bind(changeId).first())?.payload ?? "{}")
    : {};
  // A race's refs aren't checked when it starts, so an unknown one resolves to nothing rather than failing the claim.
  const spec = leg.agent ?? payload.agent_version;
  const id = spec && await resolveAgent(env, spec).catch(() => null);
  const v = id && await env.DB.prepare("SELECT v.name, v.version, v.harness, v.model, r.egress, m.egress_mode, w.web, p.prompt, " +
    "COALESCE(json_extract(v.limits, '$.max_cost_usd'), json_extract(v.limits, '$.max_usd')) AS max_spend, " +
    "json_extract(v.limits, '$.max_repairs') AS max_repairs, json_extract(v.limits, '$.max_tokens') AS max_tokens, " +
    "json_extract(v.limits, '$.max_minutes') AS max_minutes, " +
    "json_extract(v.limits, '$.max_tokens_month') AS max_tokens_month, (SELECT COALESCE(SUM(u.tokens), 0) FROM usage_logs u " +
    "WHERE u.agent_version = v.name || '@v' || v.version AND u.at >= ?) AS tokens_month FROM agent_versions v " +
    "LEFT JOIN agent_releases r ON r.name = v.name AND r.version = v.version " +
    "LEFT JOIN agent_release_prompts p ON p.name = v.name AND p.version = v.version " +
    "LEFT JOIN agent_release_egress_mode m ON m.name = v.name AND m.version = v.version " +
    "LEFT JOIN agent_release_web w ON w.name = v.name AND w.version = v.version WHERE v.id = ?")
    .bind(new Date().toISOString().slice(0, 7), id).first();
  if (!v) return null;
  // Agents never receive keystore secrets, so the lock has no secrets field.
  return { agent: v.name, name: v.name, version: v.version, harness: leg.harness ?? v.harness, model: leg.model ?? v.model,
    egress: v.egress ? JSON.parse(v.egress) : DEFAULT_EGRESS, egress_mode: v.egress_mode ?? "enforce", web: v.web ?? "raw",
    prompt: v.prompt ?? "", limits: { max_spend: v.max_spend, max_repairs: v.max_repairs,
      max_tokens: v.max_tokens, max_tokens_month: v.max_tokens_month, tokens_month: v.tokens_month, max_minutes: v.max_minutes } };
}

// 404 when the job doesn't exist, 403 when it isn't leased to this runner (anymore).
async function notLeased(env, id) {
  const exists = await env.DB.prepare("SELECT 1 FROM jobs WHERE id = ?").bind(id).first();
  return exists ? error(403, "forbidden", `job ${id} is not leased to this runner`) : error(404, "not_found", `no job ${id}`);
}

export async function heartbeatWork(request, env, { job: id }) {
  const runner = await runnerOf(request, env);
  await env.DB.prepare("INSERT INTO runner_heartbeats (runner_id, last_heartbeat_at) VALUES (?, ?) ON CONFLICT DO UPDATE SET last_heartbeat_at = excluded.last_heartbeat_at")
    .bind(runner.runner_id, new Date().toISOString()).run();
  const row = await env.DB.prepare("UPDATE jobs SET lease_expires_at = ? WHERE id = ? AND runner_id = ? AND status = 'claimed' RETURNING lease_expires_at, kind, change_id, id IN (SELECT job_id FROM job_cancels) AS cancel")
    .bind(leaseEnd(), id, runner.runner_id).first();
  if (!row) return notLeased(env, id);
  // A cancelled job, or one whose change is gone, gets no fresh tokens.
  const change = row.cancel !== 1 && row.change_id && await changeDO(env, row.change_id).get();
  const { token, readToken } = change ? await changeTokens(env, change, row.kind) : { token: null, readToken: null };
  return Response.json({ lease_expires_at: row.lease_expires_at, cancel: row.cancel === 1, token, read_token: readToken });
}

// POST /api/work/jobs/:job/report {status: "done"|"failed"} → {job, change}; moves the job's change to its next state.
// A pool worker is done with its job once the report lands or the job is gone (409), so it retires.
export async function reportWork(request, env, params) {
  const runner = await runnerOf(request, env);
  const res = await report(request, env, params);
  if (runner && (res.ok || res.status === 409)) await retire(env, runner.runner_id);
  return res;
}

async function report(request, env, { job: id }) {
  const runner = await runnerOf(request, env);
  const cancelled = await env.DB.prepare("SELECT 1 FROM job_cancels JOIN jobs ON jobs.id = job_id WHERE job_id = ? AND runner_id = ?").bind(id, runner.runner_id).first();
  if (cancelled) {
    // Release the job so it isn't left claimed; cancelled jobs never count as verify failures.
    await env.DB.prepare("UPDATE jobs SET status = 'failed' WHERE id = ? AND status = 'claimed'").bind(id).run();
    return error(409, "cancelled", `job ${id} was cancelled; its report is discarded`);
  }
  const body = await maskedJson(request, env, id);
  if (!["done", "failed"].includes(body?.status)) return error(400, "bad_request", "status must be done or failed");
  const blockers = body.blockers ?? [];
  if (!Array.isArray(blockers) || !blockers.every((b) => typeof b?.summary === "string" && b.summary && typeof b.repro === "string" && b.repro)) {
    return error(400, "bad_request", "blockers must be [{summary, repro}] with non-empty strings");
  }
  const c = body.conflict;
  for (const [k, ok] of [["cost_usd", (v) => typeof v === "number" && v >= 0], ["changed_lines", (v) => Number.isInteger(v) && v >= 0],
    ["new_deps", (v) => Number.isInteger(v) && v >= 0], ["review_findings", (v) => Number.isInteger(v) && v >= 0], ["duration_ms", (v) => Number.isInteger(v) && v >= 0],
    ["tokens", (v) => Array.isArray(v) && v.length === 3 && v.every((n) => Number.isInteger(n) && n >= 0)]]) {
    if (body[k] !== undefined && !ok(body[k])) return error(400, "bad_request", k === "tokens" ? "tokens must be [in, out, cache] integers >= 0" : `${k} must be a number >= 0`);
  }
  if (c !== undefined && !(Array.isArray(c?.files) && c.files.length && c.files.every((f) => typeof f === "string" && f)
    && Array.isArray(c.hunks) && c.hunks.every((h) => typeof h?.file === "string" && h.file))) {
    return error(400, "bad_request", "conflict must be {files: [path, ...], hunks: [{file, ...}]}");
  }
  const findings = body.findings ?? [];
  const kind = Array.isArray(findings) && findings.length ? await env.DB.prepare("SELECT kind FROM jobs WHERE id = ?").bind(id).first("kind") : null;
  // A reviewer agent's findings are line comments, each opened as a thread.
  if (kind === "review" && !findings.every((f) => typeof f?.path === "string" && f.path && Number.isInteger(f.line) && f.line >= 1
    && typeof f.body === "string" && f.body.trim() && (f.suggestion === undefined || typeof f.suggestion === "string"))) {
    return error(400, "bad_request", "review findings must be [{path, line >= 1, body, suggestion?}] with non-empty strings");
  }
  if (kind !== "review" && (!Array.isArray(findings) || !findings.every((f) => typeof f?.rule === "string" && f.rule)) || (body.diff !== undefined && typeof body.diff !== "string")) {
    return error(400, "bad_request", "findings must be [{rule, ...}] with a non-empty rule; diff must be a string");
  }
  // An ingest-sarif report feeds the findings store, which needs every column.
  if (kind === "ingest-sarif"
    && !findings.every((f) => ["critical", "high", "medium", "low"].includes(f.severity) && typeof f.file === "string" && f.file
      && typeof f.fingerprint === "string" && f.fingerprint)) {
    return error(400, "bad_request", "ingest-sarif findings must be [{rule, file, severity: critical|high|medium|low, fingerprint}]");
  }
  const deps = body.deps ?? [];
  if (!Array.isArray(deps) || !deps.every((d) => ["ecosystem", "name", "version", "license"].every((k) => typeof d?.[k] === "string")
    && d.name && ["permissive", "copyleft", "unknown"].includes(d.class))) {
    return error(400, "bad_request", "deps must be [{ecosystem, name, version, license, class: permissive|copyleft|unknown}]");
  }
  // egress: {allowed: {host: count}, denied: {host: count}, would_deny?: {host: count}} from the job's egress proxy.
  const hostCounts = (m) => m !== null && typeof m === "object" && !Array.isArray(m) && Object.entries(m).every(([h, n]) => h && Number.isInteger(n) && n > 0);
  if (body.egress !== undefined && !(hostCounts(body.egress?.allowed) && hostCounts(body.egress?.denied) && hostCounts(body.egress?.would_deny ?? {}))) {
    return error(400, "bad_request", "egress must be {allowed: {host: count}, denied: {host: count}, would_deny?: {host: count}} with counts > 0");
  }
  const secrets = body.secrets ?? [];
  if (!Array.isArray(secrets) || !secrets.every((s) => ["rule", "path", "fingerprint"].every((k) => typeof s?.[k] === "string" && s[k]))) {
    return error(400, "bad_request", "secrets must be [{rule, path, fingerprint}] with non-empty strings");
  }
  // writes and reads: the symbols a push (develop, commit, resolve) or a verify's final diff wrote and read.
  const { writes, reads } = body;
  if (writes !== undefined && !(Array.isArray(writes) && writes.every((w) => typeof w?.symbol === "string" && w.symbol && ["signature", "body"].includes(w.kind)
    && (w.lines === undefined || (typeof w.lines === "string" && /^\d+-\d+(,\d+-\d+)*$/.test(w.lines)))))) {
    return error(400, "bad_request", "writes must be [{symbol: path#name, kind: signature|body, lines?: \"first-last,…\"}]");
  }
  if (reads !== undefined && !(Array.isArray(reads) && reads.every((s) => typeof s === "string" && s))) {
    return error(400, "bad_request", "reads must be a list of symbols (path#name)");
  }
  const touched = writes?.map((w) => w.symbol);
  const { resolutions } = body;
  if (resolutions !== undefined && !(Array.isArray(resolutions) && resolutions.every((s) => typeof s === "string" && s))) {
    return error(400, "bad_request", "resolutions must be a list of symbols (path#name)");
  }
  const { refs } = body;
  if (refs !== undefined && !(Array.isArray(refs) && refs.every((r) => typeof r === "string" && r))) {
    return error(400, "bad_request", "refs must be a list of branch names");
  }
  // A verify's per-test results (runner api.TestResult); names are unique so each gets one attempt per report.
  const tests = body.tests ?? [];
  if (!Array.isArray(tests) || tests.length > 5000 || new Set(tests.map((t) => t?.test)).size !== tests.length
    || !tests.every((t) => typeof t?.test === "string" && t.test && ["pass", "fail", "skip"].includes(t.status) && Number.isFinite(t.duration) && t.duration >= 0)) {
    return error(400, "bad_request", "tests must be at most 5000 [{test, status: pass|fail|skip, duration >= 0}] with unique non-empty names");
  }
  const row = await env.DB.prepare(`UPDATE jobs SET status = ? WHERE id = ? AND runner_id = ? AND status = 'claimed' AND id NOT IN (SELECT job_id FROM job_cancels)
    RETURNING id, repo_id, kind, change_id, status, runner_id, lease_expires_at, created_at, payload`).bind(body.status, id, runner.runner_id).first();
  if (!row) {
    const held = await env.DB.prepare("SELECT runner_id FROM jobs WHERE id = ?").bind(id).first();
    if (!held) return error(404, "not_found", `no job ${id}`);
    return held.runner_id === runner.runner_id ? error(409, "already_reported", `job ${id} was already reported`)
      : error(409, "lease_lost", `job ${id} is no longer leased to this runner`);
  }
  const { payload, ...job } = row;
  // A verify whose only failing tests are quarantined passes.
  // lazy: a runner failure outside the tests isn't reported apart from them; have cinder-verify report it if one hides here.
  const quarantined = job.kind === "verify" && job.status === "failed" ? await quarantineFailures(env, job, tests) : [];
  if (quarantined.length && quarantined.length === tests.filter((t) => t.status === "fail").length) {
    await env.DB.prepare("UPDATE jobs SET status = 'done' WHERE id = ?").bind(job.id).run();
    job.status = "done";
  }
  const lock = (body.egress || AGENT_KINDS.includes(job.kind)) && job.change_id && await agentLock(env, job.change_id, job.kind, JSON.parse(payload));
  // No resolved version means the runner ran its defaults, which the merge trailer also names cinder-agent@v0.
  const agent = lock ? `${lock.agent}@v${lock.version}` : "cinder-agent@v0";
  // Every finished job of a change is one of its stages; duration and tokens are what the runner reported, else 0 and none.
  if (job.change_id) {
    const duration = body.duration_ms ?? 0;
    await changeDO(env, job.change_id).report({
      change_id: job.change_id, stage: job.kind, agent_version: agent, harness: lock?.harness ?? "claude-code", model: lock?.model ?? "default",
      cost_usd: body.cost_usd ?? 0, duration_ms: duration, session: job.id, verdict: job.status === "done" ? "pass" : "fail", dirty: false,
      started_at: new Date(Date.now() - duration).toISOString(), ...(body.tokens && { tokens: body.tokens }),
    });
  }
  if (body.egress) {
    const at = new Date().toISOString();
    const rows = ["allowed", "denied", "would_deny"].flatMap((verdict) => Object.entries(body.egress[verdict] ?? {}).map(([h, n]) => [h, verdict, n]));
    if (rows.length) await env.DB.batch(rows.map(([host, verdict, n]) => env.DB.prepare("INSERT INTO job_egress_verdicts (job_id, repo_id, agent, host, verdict, count, at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(job.id, job.repo_id, agent, host, verdict, n, at)));
  }
  if (job.kind === "flow") await flowJobReported(env, job.id, job.status === "done");
  if (job.kind === "verify" && job.change_id) await notify(env, job.repo_id, "verdict", { change_id: job.change_id, job: job.id, status: job.status });
  // A failed scan with no findings proves nothing, so it leaves the change unguarded rather than asking System 1.
  if (job.kind === "guard" && job.change_id && (job.status === "done" || findings.length)) {
    await guardChange(env, { id: job.change_id, repo_id: job.repo_id, head: JSON.parse(payload).after }, {
      findings, diff: body.diff ?? "",
      // Only these fields: a runner must never set approved_at and approve its own dependencies.
      deps: deps.map(({ ecosystem, name, version, license, class: c }) => ({ ecosystem, name, version, license, class: c })),
    });
  }
  // A guard that failed without findings left the change with no result for its head, which blocks its merge: its reason
  // goes on the timeline and it runs once more (a second failure stays visible there).
  if (job.kind === "guard" && job.change_id && job.status === "failed" && !findings.length) {
    const retry = JSON.parse(payload);
    await changeDO(env, job.change_id).stageEvent({ kind: "guard_failed", actor: { type: "system", id: runner.runner_id, runner: runner.runner_id, name: runner.name },
      action: "job.report", target: job.id, result: "failed", reason: String(body.detail ?? "no detail").slice(-2000) });
    if (!retry.retry) await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'guard', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), job.repo_id, job.change_id, new Date().toISOString(), JSON.stringify({ ...retry, retry: true })).run();
  }
  if (job.kind === "ingest-sarif" && job.status === "done") {
    const { sha, target } = JSON.parse(payload);
    // lazy: never a full scan, so no upload marks a finding fixed (scanners share source code); key full scans by tool when fixed state is needed.
    await recordScan(env.DB, { repo: job.repo_id, target, source: "code", sha, full: false,
      findings: findings.map((f) => ({ rule: f.rule, severity: f.severity, path: f.file, line: f.line, fingerprint: f.fingerprint })) });
  }
  if (job.kind === "refs" && job.status === "done") {
    await env.DB.batch([env.DB.prepare("DELETE FROM repo_refs WHERE repo_id = ?").bind(job.repo_id),
      ...(refs ?? []).map((r) => env.DB.prepare("INSERT INTO repo_refs (repo_id, name) VALUES (?, ?)").bind(job.repo_id, r))]);
  }
  if (job.kind === "scan") await finishScan(env, job, JSON.parse(payload), { secrets, deps, findings });
  if (job.kind === "index" && job.status === "failed") {
    await scheduleIndexed(env, await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(job.repo_id).first("name"), JSON.parse(payload).sha);
  }
  // A converge is a probe against the target: clean scores its pairs "no", a reported conflict "yes".
  if (job.kind === "converge" && job.change_id && (job.status === "done" || c)) {
    await recordCollisionOutcomes(env.DB, job.change_id, (JSON.parse(payload).theirs ?? []).map((t) => t.id), job.status === "done" ? "no" : "yes", new Date().toISOString());
  }
  // A converge (clean or conflicted, which the resolver merges the target into) brings a behind change current.
  if (job.kind === "converge" && job.change_id) await env.DB.prepare("DELETE FROM change_behind WHERE change_id = ?").bind(job.change_id).run();
  // Structured-merge resolutions are stored; another change touching one within 7 days marks it a wrong merge.
  if (job.kind === "converge" && job.change_id && job.status === "done" && resolutions?.length) {
    await env.DB.prepare("INSERT INTO merge_resolutions (repo_id, target_branch, change_id, symbol, resolved_at) " +
      "SELECT c.repo_id, c.target_branch, c.id, j.value, ?3 FROM changes c, json_each(?2) j WHERE c.id = ?1")
      .bind(job.change_id, JSON.stringify(resolutions), new Date().toISOString()).run();
  }
  // The tree a passing verify checked (its speculative tree) and the target sha it merged onto; a merge lands only that
  // tree, onto that sha (queue.js mergeBatch).
  if (job.kind === "verify" && job.status === "done" && /^[0-9a-f]{40}$/.test(body.tree)) {
    await env.DB.prepare("UPDATE jobs SET payload = json_set(payload, '$.tree', ?, '$.base', ?) WHERE id = ?")
      .bind(body.tree, /^[0-9a-f]{40}$/.test(body.base) ? body.base : null, job.id).run();
  }
  if (job.kind === "verify" && job.change_id && job.status === "done" && touched?.length) {
    const now = new Date();
    await env.DB.prepare("UPDATE merge_resolutions SET wrong_at = ?3 FROM changes c WHERE c.id = ?1 AND merge_resolutions.repo_id = c.repo_id " +
      "AND merge_resolutions.target_branch = c.target_branch AND merge_resolutions.change_id != c.id AND wrong_at IS NULL " +
      "AND resolved_at >= ?4 AND symbol IN (SELECT value FROM json_each(?2))")
      .bind(job.change_id, JSON.stringify(touched), now.toISOString(), new Date(now - 7 * 864e5).toISOString()).run();
  }
  // A rerun on the same sha is the next attempt, so a fail then a pass there counts as a flake (flakes.js).
  const sha = job.kind === "verify" && job.change_id && tests.length
    && await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(job.change_id).first("head_sha");
  if (sha) {
    const json = JSON.stringify(tests);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO verify_runs (job, repo, change_id, sha, attempt) SELECT ?1, ?2, ?3, ?4, COUNT(*) + 1 FROM verify_runs WHERE repo = ?2 AND sha = ?4")
        .bind(job.id, job.repo_id, job.change_id, sha),
      env.DB.prepare("INSERT INTO test_results (repo, sha, test, attempt, status, duration) SELECT ?1, ?2, value->>'test', " +
        "(SELECT attempt FROM verify_runs WHERE job = ?4), value->>'status', value->>'duration' FROM json_each(?3)").bind(job.repo_id, sha, json, job.id),
      // test_runs keeps the latest result per test per sha.
      env.DB.prepare("INSERT INTO test_runs (repo, sha, test, status, duration) SELECT ?1, ?2, value->>'test', value->>'status', value->>'duration' " +
        "FROM json_each(?3) WHERE true ON CONFLICT (repo, sha, test) DO UPDATE SET status = excluded.status, duration = excluded.duration").bind(job.repo_id, sha, json),
    ]);
    await scoreFlakes(env.DB, job.change_id, job.id, tests);
  }
  // Opened before the change moves, so the repair round's develop claim already sees them as unresolved threads.
  if (kind === "review" && job.change_id) {
    const change = await changeDO(env, job.change_id).get();
    for (const f of findings) {
      const body = f.suggestion === undefined ? f.body : `${f.body}\n\n\`\`\`suggestion\n${f.suggestion}\n\`\`\``;
      const opened = await openThread(env, change, { path: f.path, side: "new", line: f.line, body }, `agent:${agent}`);
      // A line the head lacks (or no head yet) still reaches the repair round, as a change-level thread.
      if (!opened.ok) await openThread(env, change, { body: `${f.path}:${f.line}: ${body}` }, `agent:${agent}`);
    }
  }
  // The reviewer agent's call is a risk judgment like a person's, so its review also scores the risk judge. Only a
  // decided review is a call: one that crashed before its verdict judged nothing.
  if (job.kind === "review" && job.change_id && ["pass", "fail"].includes(body.verdict)) {
    await recordVerdict(env.DB, { id: job.change_id, repo_id: job.repo_id },
      { agent: lock?.agent ?? "cinder-agent", version: `v${lock?.version ?? 0}`, verdict: body.verdict });
  }
  let to = job.change_id && NEXT[job.kind]?.[job.status];
  if (to === "failed" && ["develop", "resolve"].includes(job.kind)) {
    const retried = await retryOnOtherVersion(env, job, JSON.parse(payload), body.detail);
    if (retried) return Response.json({ job, change: retried });
  }
  // The agent pushed before it reported, but that push's event can land after the verify this starts, leaving a verdict
  // for no head that the queue never merges. So the fork's head is the change's head from here, before verify is queued.
  if (["develop", "commit", "resolve"].includes(job.kind) && job.status === "done" && to === "verifying") {
    const now = await changeDO(env, job.change_id).get();
    const head = now?.fork && (await createArtifacts(env.ARTIFACTS).log(now.fork, now.target_branch))[0]?.sha;
    if (head && head !== now.head) {
      await changeDO(env, job.change_id).moveHead(head);
      await env.DB.prepare("INSERT INTO change_heads (change_id, head_sha) VALUES (?1, ?2) ON CONFLICT DO UPDATE SET head_sha = ?2").bind(job.change_id, head).run();
    }
  }
  // A verify that couldn't merge the head onto a target that moved under it (queueConvergeJobs skips a verifying change)
  // is not the agent's to repair: the change converges, and a real conflict there goes to the resolver with its hunks.
  // lazy: read from git's message in the log; a typed report field would be exact.
  if (job.kind === "verify" && job.status === "failed" && /^CONFLICT \(/m.test(body.detail ?? "")) {
    // A clean converge just before it already rebased onto the target, so the conflict is with the changes merged ahead of
    // it in the queue: converging again would loop verify and converge forever. It goes to conflict, for the resolver.
    const prev = await env.DB.prepare("SELECT kind, status FROM jobs WHERE change_id = ? AND id <> ? ORDER BY created_at DESC LIMIT 1")
      .bind(job.change_id, job.id).first();
    to = prev?.kind === "converge" && prev.status === "done" ? "conflict" : "converging";
  }
  // A behind change's next push converges onto its target before it verifies (queue.js queueConvergeJobs).
  if (["develop", "commit"].includes(job.kind) && to === "verifying"
    && await env.DB.prepare("SELECT 1 FROM change_behind WHERE change_id = ?").bind(job.change_id).first()) to = "converging";
  // ...unless the change's risk route is waiting on that review.
  // A requested person who hasn't approved the head still holds it: the passed review no longer does, so their approval
  // queues it (autoQueue).
  const reviewed = job.kind === "review" && job.status === "done" && await changeDO(env, job.change_id).get();
  if (reviewed?.review?.route === "agent") {
    if (!pendingReviewer(reviewed)) to = "in_queue";
    else await changeDO(env, job.change_id).setReview({ ...reviewed.review, route: "auto", reason: `agent review passed, ${reviewed.review.reason}` });
  }
  // A clean converge returns the change to the state it converged from; a queued one re-verifies its new tree first.
  if (to && job.kind === "converge" && job.status === "done") {
    to = JSON.parse(payload).return_to ?? to;
    if (to === "in_queue") to = "verifying";
  }
  if (!to) return Response.json({ job, change: null });
  // A push, or a passing verify's final diff, writing symbols another change holds goes to conflict (the push stays on
  // the fork) instead of verify or the queue; written symbols no one holds extend the change's lease.
  // An undecided race's legs take no lease (races.js).
  const pushed = ["develop", "commit", "resolve", "verify"].includes(job.kind) && job.status === "done" && writes && !(await env.DB.prepare(
    "SELECT 1 FROM race_legs l WHERE change_id = ? AND NOT EXISTS (SELECT 1 FROM race_legs w WHERE w.race_id = l.race_id AND w.won IS NOT NULL)",
  ).bind(job.change_id).first());
  if (job.kind === "verify" && pushed) await scoreLease(env, { id: job.change_id }, touched);
  // The final diff's writes and reads, for the edit checks of changes based before it lands (edit-check.js) and the
  // converge scope of later merges (queue.js queueConvergeJobs).
  if (job.kind === "verify" && pushed) {
    await env.DB.batch([env.DB.prepare("DELETE FROM change_writes WHERE change_id = ?").bind(job.change_id),
      ...writes.map((w) => env.DB.prepare("INSERT OR REPLACE INTO change_writes VALUES (?, ?, ?)").bind(job.change_id, w.symbol, w.kind)),
      env.DB.prepare("DELETE FROM change_write_lines WHERE change_id = ?").bind(job.change_id),
      ...writes.filter((w) => w.lines).map((w) => env.DB.prepare("INSERT OR REPLACE INTO change_write_lines VALUES (?, ?, ?)").bind(job.change_id, w.symbol, w.lines)),
      env.DB.prepare("DELETE FROM change_reads WHERE change_id = ?").bind(job.change_id),
      ...(reads ?? []).map((r) => env.DB.prepare("INSERT OR IGNORE INTO change_reads VALUES (?, ?)").bind(job.change_id, r))]);
    await scoreSeam(env.DB, job.change_id, new Date().toISOString());
  }
  const held = pushed ? await enforceLease(env, await changeDO(env, job.change_id).get(), writes) : null;
  if (pushed && writes.length) await recordEditing(env, job.repo_id, job.change_id, writes);
  if (held) to = "conflict";
  // A verified change is routed by risk before it queues: agent review and a person's approval of its head hold it in verifying.
  const current = job.kind === "verify" && to === "in_queue" ? await changeDO(env, job.change_id).get() : null;
  if (current) {
    // The target branch's merge rule (.cinder.yml `rules`); a release branch has none and gets the defaults.
    const repo = await env.DB.prepare("SELECT name, default_branch FROM repos WHERE id = ?").bind(job.repo_id).first();
    const rule = (await env.REPO_DO.get(env.REPO_DO.idFromName(repo.name)).policy(repo.name, repo.default_branch)).rules
      .find((r) => r.branch === current.target_branch) ?? DEFAULT_RULE;
    let review = await routeChange(env, job.repo_id, job.change_id, {
      // lazy: verify reports carry no diff stats yet, so risk sees only the touched files; send stats once cinder-verify has them.
      files: [...new Set((touched ?? []).map((s) => s.split("#")[0]))].map((path) => ({ path, added: 0, removed: 0 })),
      intent: current.intent, test_delta: 0, lease_overlaps: 0,
      // The head's line diff, for comment- and documentation-only routing; an unreadable one routes as code.
      diff: await changeFiles(createArtifacts(env.ARTIFACTS), repo.name, current).catch(() => null),
      // A manifest cinder can't read could do anything, so it goes to a person rather than failing the report.
      deploy_plan: await planDeploy(env, repo.name, current).catch((err) => ({ destructive: `unreadable: ${err.message}`, environments: [] })),
    }, rule);
    // A person approved this head over an untrusted judge (needs.js): that approval stands in for the agent review.
    if (review.route === "agent" && current.review?.route === "human" && !awaitsHuman(current)) await changeDO(env, job.change_id).setReview(review = current.review);
    if (review.route === "agent") await env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload)
      SELECT ?1, ?2, 'review', ?3, 'queued', ?4, ?5 WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE change_id = ?3 AND kind = 'review' AND status IN ('queued', 'claimed'))`)
      // base is the target sha the verify ran on, which the reviewer diffs the fork's head against.
      .bind(crypto.randomUUID(), job.repo_id, job.change_id, new Date().toISOString(),
        JSON.stringify({ ...await channelAgent(env, "review", job.change_id), base: /^[0-9a-f]{40}$/.test(body.base) ? body.base : null })).run();
    // A respeculated change that passed but can't queue itself here leaves converging, to wait in verifying like any other.
    const leaveConverging = () => current.state === "converging" && changeDO(env, job.change_id).transition("verifying", {
      kind: "verify_done", action: "job.report", target: job.id, result: "done", actor: { type: "verifier", id: runner.runner_id, runner: runner.runner_id, name: runner.name },
    }, {}, "converging");
    if (review.route === "agent" || awaitsHuman({ ...current, review }) || pendingReviewer(current)) {
      await leaveConverging();
      // current was read before the risk judge ran; an approval that landed meanwhile found no review yet and couldn't
      // queue, so the change queues now if it has one (autoQueue re-reads it).
      const queued = review.route !== "agent" && await autoQueue(env, job.change_id, { kind: "approved", actor: { type: "system", id: "cinder" },
        action: "job.report", target: job.id, result: "ok" });
      return Response.json({ job, change: queued || await changeDO(env, job.change_id).get() });
    }
    // Auto-queue off (change-view.js) or the rule's merge queue off: the verified change waits in verifying for a person's POST /queue.
    if (!rule.queue || (await env.DB.prepare("SELECT auto_queue FROM change_views WHERE change_id = ?").bind(job.change_id).first("auto_queue")) === 0) {
      await leaveConverging();
      return Response.json({ job, change: await changeDO(env, job.change_id).get() });
    }
  }
  const mergedFiles = job.kind === "merge" && to === "merged" ? await changedFiles(env, job.change_id) : null;
  const conflict = held ?? (to === "conflict" && c ? { theirs: (JSON.parse(payload).theirs ?? []).map((t) => t.id), files: c.files, hunks: c.hunks } : null);
  // A failed job's detail is the runner's log (already masked): a verify's Fetch change and Check leases steps first, then
  // the output whose tail is where the cause shows.
  const why = job.status === "failed" && typeof body.detail === "string"
    ? body.detail.replace(/^##\[group\]Fetch change\n[\s\S]*?##\[endgroup\]\n##\[group\]Check leases\n[\s\S]*?##\[endgroup\]\n/, "").trim() : "";
  let change = await changeDO(env, job.change_id).transition(to, {
    kind: `${job.kind}_${job.status}`, action: "job.report", target: job.id, result: job.status,
    ...(blockers.length ? { reason: blockers.map((b) => `${b.summary} (repro: ${b.repro})`).join("; ") }
      : job.status === "done" && quarantined.length ? { reason: `quarantined: ${quarantined.join(", ")}` }
      : why && { reason: why.slice(-2000) }),
    // Jobs carry no agent version yet, so only verify reports get a specific actor type.
    actor: { type: job.kind === "verify" ? "verifier" : "system", id: runner.runner_id, runner: runner.runner_id, name: runner.name },
  }, {}, conflict);
  if (!change) return error(409, "change_moved", `change ${job.change_id} is no longer in a state that can move to ${to}`);
  // cinder settles a lease collision itself (stacked or a seam), so it queues no resolve job.
  if (held) change = (await recordCollisions(env, change)) ?? change;
  const raced = job.kind === "verify" && await settleLeg(env, change, job.status === "done", body);
  // A change back from converging keeps its place in the queue.
  if (to === "in_queue" && (job.kind === "verify" || job.kind === "review") && !raced) await enqueue(env, change);
  // A failed mirror push is recorded, but the merge stands.
  if (job.kind === "merge" && to === "merged" && body.mirror_failed === true) await changeDO(env, job.change_id).stageEvent({
    kind: "mirror_failed", action: "job.report", target: job.id, result: "failed", reason: "mirror_failed",
    actor: { type: "system", id: runner.runner_id, runner: runner.runner_id, name: runner.name },
  });
  // A merge the Worker couldn't sign (no MERGE_SIGNING_KEY binding yet) is flagged on the change and in its timeline.
  if (job.kind === "merge" && to === "merged" && body.unsigned === true) await changeDO(env, job.change_id).stageEvent({
    kind: "merge_unsigned", action: "job.report", target: job.id, result: "unsigned", reason: "no_signing_key",
    actor: { type: "system", id: runner.runner_id, runner: runner.runner_id, name: runner.name },
  }, { unsigned: true });
  // A runner's sha is only stored when it is one; a squash merge lands a commit that is not the change's head.
  if (job.kind === "merge" && to === "merged" && /^[0-9a-f]{40}$/.test(body.merged_sha)) await env.DB.prepare("INSERT OR REPLACE INTO change_merged_shas (change_id, merged_sha) VALUES (?, ?)")
    .bind(change.id, body.merged_sha).run();
  if (mergedFiles) await recordMerge(env, change.id, /^[0-9a-f]{40}$/.test(body.merged_sha) ? body.merged_sha : null, mergedFiles);
  // The rest of the batch landed with the head, in queue order; they're merged before anything converges on the new target.
  for (const { change_id } of job.kind === "merge" && to === "merged" ? (JSON.parse(payload).batch ?? []).slice(1) : []) {
    const merged = await changeDO(env, change_id).transition("merged", {
      kind: "merge_done", action: "job.report", target: job.id, result: "done", actor: { type: "system", id: runner.runner_id, runner: runner.runner_id, name: runner.name },
    });
    if (merged) await queueHistoryJob(env, merged);
    else console.error(`merge ${job.id}: ${change_id} landed but could not move to merged`);
  }
  if (job.kind === "merge" && to === "merged") await queueConvergeJobs(env, change.repo_id, change.target_branch, change.id);
  // A refused merge, or a behind change's push, rebases and re-verifies.
  if (to === "converging") await queueConvergeJob(env, change);
  if (job.kind === "merge" && to === "merged") await queueScan(env, change.repo_id, change.target_branch, "merge");
  if (to === "merged") await queueHistoryJob(env, change);
  // A resolve job carries both intents, the hunks and the conflicting symbols (a lease collision's, or those the
  // converge was scoped to); the runner diffs the target for their change's diff.
  const queued = change.state === "conflict" ? {
    ...await channelAgent(env, "resolve", change.id), intent: change.intent, hunks: conflict?.hunks ?? [],
    symbols: held ? held.collisions.map((x) => x.symbol) : JSON.parse(payload).symbols ?? [],
    theirs: await Promise.all((conflict?.theirs ?? []).map(async (id) => ({ id, intent: (await changeDO(env, id).get())?.intent ?? null }))),
  } : {};
  // A verify job speculates on the changes queued ahead of it.
  if (change.state === "verifying") queued.ahead = await headsAhead(env, change);
  // One statement, so a repeated report can't add a second open job of the kind.
  // A person's change held by another's lease waits for its person (collisions.js); no resolve job works on it. Nor
  // on a conflict of one whose driver turned agent pushes off: the person resolves it.
  const personHeld = (held && (change.driver || change.head_branch)) || (change.state === "conflict" && change.driver && change.agent_pushes === false);
  if (QUEUES[change.state] && !personHeld) await env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload)
    SELECT ?1, ?2, ?3, ?4, 'queued', ?5, ?6 WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE change_id = ?4 AND kind = ?3 AND status IN ('queued', 'claimed'))`)
    .bind(crypto.randomUUID(), change.repo_id, QUEUES[change.state], change.id, new Date().toISOString(), JSON.stringify(queued)).run();
  if (to === "in_queue" || job.kind === "merge") await queueMergeJob(env, change.repo_id, change.target_branch);
  return Response.json({ job, change });
}
