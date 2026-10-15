// Flow runs: a run (flow_runs) is planned into stages of jobs; each job
// of an unblocked stage is one `flow` job a worker claims (work.js), and its report moves the run on. The worker reports
// each step's status and log tail as it goes.
import { personOf } from "./access.js";
import { ENV_KEY, FLOW_NAME, STEP_STATUSES, TARGET_CONFIG, planFlow, readFlow } from "./api/shapes/flow.js";
import { createArtifacts } from "./artifacts.js";
import { trustOf } from "./calibration.js";
import { cloudflare } from "./deploy.js";
import { manifest } from "./environments.js";
import { SYSTEM_STEPS, appendLog } from "./flow-logs.js";
import { listRefs } from "./git/index.js";
import { maskedJson, unresolved } from "./keystore.js";
import { publish } from "./live.js";
import { mask } from "./mask.js";
import { error, hex, runnerOf, sha256 } from "./router.js";

const MAX_LOG_CHARS = 64 * 1024;
// wrangler.jsonc's cron runs every 10 minutes; each tick queues the cron flows due since the one before.
const TICK_MINUTES = 10;
const FINISHED = { complete: "passed", errored: "failed", terminated: "failed" };
// A stage's or a run's status from its jobs'.
const rollup = (ss) => (ss.includes("failed") ? "failed" : ss.includes("cancelled") ? "cancelled" : ss.every((s) => s === "skipped") ? "skipped"
  : ss.every((s) => s === "passed" || s === "skipped") ? "passed" : ss.every((s) => s === "queued") ? "queued" : "running");
const msSince = (from, to) => (from ? (to ? Date.parse(to) : Date.now()) - Date.parse(from) : 0);
// A flow with no job, matrix, shard, retries, concurrency or stages runs as before: one flow job (id = run id) whose steps are one-step jobs.
const legacy = (def) => !Object.keys(def.stages ?? {}).length && !def.concurrency && def.steps.every((s) => s.job == null && s.matrix == null && s.shard == null && !Number(s.retries));

// The environment of steps' deploy outside Cloudflare: its job reads that environment's Keystore secrets (readJobSecret).
// The environment a step deploys outside Cloudflare (it has an aws, gcp, azure or ssh map), else undefined.
const externalEnv = (s) => (s.deploy && Object.keys(TARGET_CONFIG).some((k) => s[k]) ? s.deploy : undefined);
const deployEnv = (steps) => steps.map(externalEnv).find(Boolean);

// The flow_runs row and one flow_jobs row per step of the legacy flow job id, as the flow_jobs migration backfills.
export const legacyRun = (env, id, actor) => [
  env.DB.prepare(`INSERT OR IGNORE INTO flow_runs (id, repo_id, flow, number, sha, ref, trigger, change_id, actor, status, created_at, started_at, finished_at, payload)
    SELECT id, repo_id, json_extract(payload, '$.flow'), (SELECT coalesce(max(number), 0) + 1 FROM flow_runs r WHERE r.repo_id = jobs.repo_id AND r.flow = json_extract(jobs.payload, '$.flow')),
      json_extract(payload, '$.sha'), json_extract(payload, '$.ref'), json_extract(payload, '$.trigger'), json_extract(payload, '$.change_id'), ?2,
      CASE status WHEN 'claimed' THEN 'running' WHEN 'done' THEN 'passed' ELSE status END, created_at,
      CASE WHEN status <> 'queued' THEN created_at END, CASE WHEN status IN ('done', 'failed') THEN created_at END, payload
    FROM jobs WHERE id = ?1`).bind(id, actor),
  env.DB.prepare(`INSERT OR IGNORE INTO flow_jobs (run_id, key, stage, name, status, job_id)
    SELECT j.id, json_extract(s.value, '$.stage') || '/' || json_extract(s.value, '$.name'), json_extract(s.value, '$.stage'), json_extract(s.value, '$.name'), 'queued', j.id
    FROM jobs j JOIN json_each(j.payload, '$.steps') s WHERE j.id = ?`).bind(id),
];

// Records run id and queues what can run: a legacy flow as its one flow job, otherwise one flow job per job of each stage
// with no unmet needs. Every insert ignores a repeat, so a repeated id queues nothing twice.
async function openRun(env, repoId, id, payload, actor) {
  const now = new Date().toISOString();
  // A change's new head supersedes its older heads' runs of the flow, as concurrency cancel does for any trigger.
  const supersedes = payload.concurrency === "cancel" || payload.trigger === "change";
  const { results: older } = !supersedes ? { results: [] } : await env.DB.prepare(`SELECT id FROM flow_runs WHERE repo_id = ? AND flow = ? AND id <> ?
    AND ref IS ? AND json_extract(payload, '$.fork') IS ? AND status IN ('queued', 'running')`).bind(repoId, payload.flow, id, payload.ref ?? null, payload.fork ?? null).all();
  for (const r of older) await cancelJobs(env, r.id);
  if (legacy(payload)) {
    await env.DB.batch([env.DB.prepare("INSERT OR IGNORE INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'flow', NULL, 'queued', ?, ?)")
      .bind(id, repoId, now, JSON.stringify({ ...payload, environment: deployEnv(payload.steps) })), ...legacyRun(env, id, actor),
    ...(payload.trigger === "manual" ? [env.DB.prepare("INSERT OR IGNORE INTO job_requesters (job_id, person) VALUES (?, ?)").bind(id, actor)] : [])]);
    return;
  }
  await env.DB.batch([env.DB.prepare(`INSERT OR IGNORE INTO flow_runs (id, repo_id, flow, number, sha, ref, trigger, change_id, actor, status, created_at, payload)
    SELECT ?1, ?2, ?3, coalesce(max(number), 0) + 1, ?4, ?5, ?6, ?10, ?7, 'queued', ?8, ?9 FROM flow_runs WHERE repo_id = ?2 AND flow = ?3`)
    .bind(id, repoId, payload.flow, payload.sha, payload.ref ?? null, payload.trigger, actor, now, JSON.stringify(payload), payload.change_id ?? null),
  ...planFlow(payload).stages.flatMap((st) => st.jobs.map((j) => env.DB.prepare(
    "INSERT OR IGNORE INTO flow_jobs (run_id, key, stage, name, leg, status) VALUES (?, ?, ?, ?, ?, 'queued')").bind(id, j.key, st.id, j.name, j.leg ?? null)))]);
  await advance(env, id);
}

// Moves run runId on after one of its jobs changed: queues the jobs of each stage whose needs all passed, skips those of a
// stage whose needs failed, were cancelled or skipped, rolls the run's status up from its jobs and publishes run.updated
// with each stage's and job's status.
export async function advance(env, runId) {
  const run = await env.DB.prepare("SELECT f.repo_id, f.payload, r.name AS repo FROM flow_runs f JOIN repos r ON r.id = f.repo_id WHERE f.id = ?").bind(runId).first();
  if (!run) return;
  const def = JSON.parse(run.payload);
  const { results: rows } = await env.DB.prepare("SELECT key, stage, status, job_id, attempt FROM flow_jobs WHERE run_id = ?").bind(runId).all();
  const of = (stage) => rows.filter((r) => r.stage === stage).map((r) => r.status);
  const now = new Date().toISOString();
  const writes = [];
  const { stages } = planFlow(def);
  // concurrency queue: nothing of this run starts while an older run of the flow is unfinished.
  const waits = def.concurrency === "queue" && await env.DB.prepare(`SELECT 1 FROM flow_runs WHERE repo_id = ?1 AND flow = ?2 AND status IN ('queued', 'running')
    AND rowid < (SELECT rowid FROM flow_runs WHERE id = ?3)`).bind(run.repo_id, def.flow, runId).first();
  let n = 0;
  for (const [i, st] of stages.entries()) {
    // A stage the flow gives no needs waits on the stage before it.
    const needs = def.stages?.[st.id] || !i ? st.needs : [stages[i - 1].id];
    const blocked = needs.some((id) => ["failed", "cancelled", "skipped"].includes(rollup(of(id))));
    const ready = needs.every((id) => of(id).every((s) => s === "passed"));
    for (const j of st.jobs) {
      // Job ids follow plan order and attempt, so a second caller advancing the same run inserts the same rows and is ignored.
      const row = rows.find((r) => r.key === j.key);
      const jobId = `${runId}-${n++}${row?.attempt > 1 ? `-${row.attempt}` : ""}`;
      if (!row || row.job_id || row.status !== "queued" || !(blocked || ready) || waits) continue;
      if (blocked) {
        row.status = "skipped";
        writes.push(env.DB.prepare("UPDATE flow_jobs SET status = 'skipped', finished_at = ? WHERE run_id = ? AND key = ? AND job_id IS NULL").bind(now, runId, j.key));
        continue;
      }
      const steps = def.steps.filter((s) => j.steps.includes(s.name)).map((s) => ({ ...s, needs: s.needs.filter((x) => j.steps.includes(x)) }));
      writes.push(env.DB.prepare("INSERT OR IGNORE INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'flow', NULL, 'queued', ?, ?)")
        .bind(jobId, run.repo_id, now, JSON.stringify({ ...def, steps, environment: deployEnv(steps), run_id: runId, key: j.key, ...(j.leg && { leg: j.leg }), runs_on: j.runs_on })),
      env.DB.prepare("UPDATE flow_jobs SET job_id = ? WHERE run_id = ? AND key = ?").bind(jobId, runId, j.key),
      // A run someone started by hand uses their model keys; push and cron runs (actor cinder) use the org's.
      env.DB.prepare("INSERT OR IGNORE INTO job_requesters SELECT ?, actor FROM flow_runs WHERE id = ? AND trigger = 'manual'").bind(jobId, runId));
    }
  }
  const all = rows.map((r) => r.status);
  const finished = !all.some((s) => s === "queued" || s === "running");
  writes.push(env.DB.prepare(`UPDATE flow_runs SET status = ?1, started_at = coalesce(started_at, (SELECT min(started_at) FROM flow_jobs WHERE run_id = ?2)),
    finished_at = CASE WHEN ?3 THEN coalesce(finished_at, ?4) END WHERE id = ?2`).bind({ cancelled: "failed" }[rollup(all)] ?? rollup(all), runId, finished ? 1 : 0, now));
  await env.DB.batch(writes);
  const next = finished && def.concurrency === "queue" && await env.DB.prepare(`SELECT id FROM flow_runs WHERE repo_id = ? AND flow = ? AND status = 'queued'
    ORDER BY rowid LIMIT 1`).bind(run.repo_id, def.flow).first("id");
  if (next) await advance(env, next);
  await publish(env, run.repo, "run.updated", { id: runId, stages: stages.map((st) => ({ id: st.id, status: rollup(of(st.id)),
    jobs: rows.filter((r) => r.stage === st.id).map((r) => ({ key: r.key, status: r.status })) })) });
}

const moved = async (env, stmt) => {
  const runId = await stmt.first("run_id");
  if (runId) await advance(env, runId);
};
// A flow job's claim (work.js): its flow_jobs rows run on runnerId, on instance (its pool's size, byo for a BYO runner).
export async function flowJobClaimed(env, jobId, runnerId, size) {
  const instance = size ?? (await env.DB.prepare("SELECT 'byo' AS i FROM byo_members WHERE runner_id = ?").bind(runnerId).first("i"));
  await moved(env, env.DB.prepare(`UPDATE flow_jobs SET status = 'running', runner_id = ?2, instance = ?3, started_at = coalesce(started_at, ?4)
    WHERE job_id = ?1 AND status IN ('queued', 'running') RETURNING run_id`).bind(jobId, runnerId, instance, new Date().toISOString()));
}
// A flow job's report (work.js): its flow_jobs rows still open pass or fail with it. A failed job is queued again as its
// next attempt while that stays within its steps' most retries.
export async function flowJobReported(env, jobId, done) {
  const row = !done && await env.DB.prepare(`SELECT j.run_id, j.key, j.attempt, f.payload FROM flow_jobs j JOIN flow_runs f ON f.id = j.run_id
    WHERE j.job_id = ?1 AND j.job_id <> j.run_id AND j.status IN ('queued', 'running')`).bind(jobId).first();
  if (row) {
    const def = JSON.parse(row.payload);
    const names = planFlow(def).stages.flatMap((st) => st.jobs).find((j) => j.key === row.key)?.steps ?? [];
    if (row.attempt <= Math.max(0, ...def.steps.filter((s) => names.includes(s.name)).map((s) => Number(s.retries) || 0))) {
      await env.DB.batch([
        env.DB.prepare(`UPDATE flow_jobs SET status = 'queued', attempt = attempt + 1, job_id = NULL, runner_id = NULL, instance = NULL, started_at = NULL
          WHERE job_id = ? AND status IN ('queued', 'running')`).bind(jobId),
        ...["flow_step_runs", "flow_step_logs", "flow_annotations", "flow_tests"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE run_id = ? AND job_key = ?`).bind(row.run_id, row.key)),
      ]);
      return advance(env, row.run_id);
    }
  }
  await moved(env, env.DB.prepare("UPDATE flow_jobs SET status = ?2, finished_at = ?3 WHERE job_id = ?1 AND status IN ('queued', 'running') RETURNING run_id")
    .bind(jobId, done ? "passed" : "failed", new Date().toISOString()));
}

// Cancels every queued and running job of run id; a runner holding one hears cancel on its next heartbeat (work.js).
// A legacy run (its one flow job's id is the run id) has no stages to advance, so its row is closed here.
export async function cancelJobs(env, id) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT job_id FROM flow_jobs WHERE run_id = ? AND status IN ('queued', 'running') AND job_id IS NOT NULL").bind(id),
    env.DB.prepare("UPDATE flow_jobs SET status = 'cancelled', finished_at = ? WHERE run_id = ? AND status IN ('queued', 'running')").bind(now, id),
  ]);
  if (await env.DB.prepare("SELECT 1 FROM jobs WHERE id = ?").bind(id).first()) await closeLegacy(env, id, now);
  else await advance(env, id);
}
const closeLegacy = (env, id, at) => env.DB.prepare("UPDATE flow_runs SET status = 'failed', finished_at = coalesce(finished_at, ?) WHERE id = ? AND status IN ('queued', 'running')")
  .bind(at, id).run();

// Runs on the Worker's cron, a backstop to the runner's own job limit: a flow job running past FLOW_JOB_MAX_MS fails as timed
// out and its runner hears cancel on its next heartbeat, which keeps the lease alive however stuck the job is.
const FLOW_JOB_MAX_MS = 2 * 3600_000;
export async function timeOutFlowJobs(env, now = Date.now()) {
  const at = new Date(now).toISOString(), before = new Date(now - FLOW_JOB_MAX_MS).toISOString();
  const { results } = await env.DB.prepare("SELECT DISTINCT run_id, job_id FROM flow_jobs WHERE status = 'running' AND started_at < ?").bind(before).all();
  for (const { run_id: run, job_id: job } of results) {
    await env.DB.batch([
      ...(job ? [env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) VALUES (?)").bind(job)] : []),
      env.DB.prepare("UPDATE flow_jobs SET status = 'failed', finished_at = ? WHERE run_id = ? AND status = 'running' AND started_at < ?").bind(at, run, before),
    ]);
    if (job === run) await closeLegacy(env, run, at);
    else await advance(env, run);
  }
}

// A flow_steps row's logs column holds an R2 key in LOGS ("" when nothing was reported).
const readLog = async (env, key) => (key && (await (await env.LOGS.get(key))?.text())) ?? "";
async function runOf(env, repoId, id) {
  const job = await env.DB.prepare("SELECT status, created_at, payload FROM jobs WHERE id = ? AND repo_id = ? AND kind = 'flow'").bind(id, repoId).first();
  if (!job) return null;
  const { results } = await env.DB.prepare("SELECT f.name, f.status, f.logs, m.secrets AS missing_secrets FROM flow_steps f LEFT JOIN flow_step_missing_secrets m USING (job_id, name) WHERE f.job_id = ?").bind(id).all();
  const seen = Object.fromEntries(results.map((r) => [r.name, r]));
  const { flow, sha, steps } = JSON.parse(job.payload);
  return { id, flow, sha, status: job.status, created_at: job.created_at,
    steps: await Promise.all(steps.map(async (s) => ({ name: s.name, stage: s.stage, status: seen[s.name]?.status ?? "queued", logs: await readLog(env, seen[s.name]?.logs),
      missing_secrets: JSON.parse(seen[s.name]?.missing_secrets ?? "[]") }))) };
}

// POST /api/repos/:name/flows/:flow/runs {ref?} → 201 FlowRun: a manual run of .cinder/flows/<flow>.yml at the head of
// ref, the default branch when the body names none.
export async function startRun(request, env, { name, flow }) {
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const body = await request.json().catch(() => null); // an empty body runs the default branch
  if (body?.ref != null && (typeof body.ref !== "string" || !body.ref)) return error(400, "bad_request", "ref must be a non-empty string");
  const ref = body?.ref ?? repo.default_branch;
  const artifacts = createArtifacts(env.ARTIFACTS);
  // Always the branch, from the ref advertisement: the binding resolves bare names only, and a bare name would let a tag
  // of the same name run as that branch.
  const cap = await artifacts.get(name);
  const sha = cap && (await listRefs(cap)).find((r) => r.kind === "branch" && r.name === ref)?.sha;
  const text = sha && FLOW_NAME.test(flow) ? await artifacts.readFile(name, sha, `.cinder/flows/${flow}.yml`) : null;
  if (!text) return error(404, "not_found", `no flow ${flow} on ${ref}`);
  const { def, errors } = readFlow(text, `.cinder/flows/${flow}.yml`);
  if (errors.length) return error(400, "invalid_flow", errors.map((e) => e.text).join("; "));
  if (!def.on.includes("manual")) return error(400, "invalid_flow", "on: has no manual trigger");
  if (await rejectedHead(env, name, ref, sha)) return error(409, "rejected_push", `${ref} is at ${sha}, a direct push cinder rolled back; no flow runs on it`);
  const id = crypto.randomUUID();
  await openRun(env, repo.id, id, { ...def, flow, sha, ref, trigger: "manual" }, personOf(request));
  return Response.json((await runsOf(env, repo.id, id))[0], { status: 201 });
}

// GET /api/repos/:name/flow-runs/:id → FlowRunTree; a legacy run also carries FlowRun's steps with their log tails for
// one release, and a flow job with no flow_runs row is still served as a FlowRun.
export async function getRun(request, env, { name, id }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  const run = repo && (await env.DB.prepare(`SELECT f.*, json_extract(c.card, '$.title') AS change_title FROM flow_runs f
    LEFT JOIN change_cards c ON c.change_id = f.change_id WHERE f.id = ? AND f.repo_id = ?`).bind(id, repo.id).first());
  const old = repo && (await runOf(env, repo.id, id));
  if (!run) return old ? Response.json(old) : error(404, "not_found", `no flow run ${id} in ${name}`);
  const [{ results: jobs }, { results: steps }, { results: notes }] = await env.DB.batch([
    env.DB.prepare("SELECT * FROM flow_jobs WHERE run_id = ?").bind(id),
    env.DB.prepare("SELECT * FROM flow_step_runs WHERE run_id = ?").bind(id),
    env.DB.prepare("SELECT level, count(*) AS n FROM flow_annotations WHERE run_id = ? GROUP BY level").bind(id),
  ]);
  const count = (level) => notes.find((x) => x.level === level)?.n ?? 0;
  const stages = planFlow(JSON.parse(run.payload)).stages.map((st) => {
    const js = st.jobs.map((p) => {
      const j = jobs.find((x) => x.key === p.key) ?? { status: "queued", attempt: 1 };
      const step = (s, idx, name) => ({ idx, name, status: s?.status ?? "queued", started_at: s?.started_at ?? null, finished_at: s?.finished_at ?? null, lines: s?.lines ?? 0 });
      // The runner's pre and post steps (idx past the job's own) show before and after them once reported.
      const sys = (names) => names.map((n) => steps.find((x) => x.job_key === p.key && x.idx === p.steps.length + SYSTEM_STEPS.indexOf(n))).filter(Boolean).map((s) => step(s, s.idx, s.name));
      return { key: p.key, name: p.name, ...(p.leg && { leg: p.leg }), status: j.status, instance: j.instance ?? null, attempt: j.attempt,
        started_at: j.started_at ?? null, finished_at: j.finished_at ?? null, steps: [...sys(["Set up job", "Checkout"]), ...p.steps.map((name, idx) => step(steps.find((x) => x.job_key === p.key && x.name === name), idx, name)), ...sys(["Upload artifacts", "Complete job"])] };
    });
    return { id: st.id, name: st.id, status: rollup(js.map((j) => j.status)), jobs: js };
  });
  const tree = { id, flow: run.flow, number: run.number, sha: run.sha, ref: run.ref, trigger: run.trigger, ...changeOf(run),
    actor: run.actor, status: run.status, created_at: run.created_at, started_at: run.started_at, finished_at: run.finished_at,
    wall_ms: msSince(run.started_at, run.finished_at), sandbox_ms: jobs.reduce((t, j) => t + msSince(j.started_at, j.finished_at), 0),
    stages, annotations_count: { error: count("error"), warning: count("warning") } };
  return Response.json(old ? { ...tree, steps: old.steps } : tree);
}

// A change-triggered run's change: its title is null until the change's card is written.
const changeOf = (run) => run.change_id && { change: { id: run.change_id, title: run.change_title ?? null } };

// FlowRun[] (all of repoId's runs, or run id only) with number, stage statuses, wall_ms, waiting_approval (an open Flow
// approval need) and step_ms (first step start to last step finish, null until every step finished), from one query. status and
// steps (one per job, no logs) keep FlowRun's shape for one release.
// lazy: the newest 50; page past that when a repo's run history needs it.
async function runsOf(env, repoId, id = null) {
  // A job's missing secrets are those of all its steps; a legacy job (job_id = run_id) holds every step, so its row takes only its own step's.
  const { results } = await env.DB.prepare(`SELECT f.*, (SELECT json_group_array(json_object('name', name, 'leg', leg, 'stage', stage, 'status', status,
        'missing', json((SELECT json_group_array(DISTINCT s.value) FROM (SELECT s.value FROM flow_step_missing_secrets m, json_each(m.secrets) s
          WHERE m.job_id = j.job_id AND (m.name = j.name OR j.job_id <> j.run_id) ORDER BY s.value) s))))
      FROM (SELECT * FROM flow_jobs WHERE run_id = f.id ORDER BY rowid) j) AS jobs,
      -- lazy: matches open Flow approval needs by the job id in their text; give needs a run_id column if this slows.
      EXISTS (SELECT 1 FROM needs n JOIN flow_jobs j ON j.run_id = f.id WHERE n.kind = 'Flow approval' AND n.resolution IS NULL
        AND instr(n.text, ' (run ' || coalesce(j.job_id, f.id) || ') as ')) AS waiting,
      (SELECT json_extract(card, '$.title') FROM change_cards WHERE change_id = f.change_id) AS change_title,
      (SELECT CASE WHEN count(*) = count(finished_at) THEN (julianday(max(finished_at)) - julianday(min(started_at))) * 864e5 END
        FROM flow_step_runs WHERE run_id = f.id HAVING count(*) > 0) AS step_ms
    FROM flow_runs f WHERE f.repo_id = ?1 AND (?2 IS NULL OR f.id = ?2) ORDER BY f.created_at DESC, f.rowid DESC LIMIT 50`).bind(repoId, id).all();
  return results.map((f) => {
    const jobs = JSON.parse(f.jobs);
    const stages = [...new Set(jobs.map((j) => j.stage))].map((s) => ({ id: s, status: rollup(jobs.filter((j) => j.stage === s).map((j) => j.status)) }));
    return { id: f.id, flow: f.flow, sha: f.sha, ref: f.ref, ...changeOf(f), status: { running: "claimed", passed: "done" }[f.status] ?? f.status, created_at: f.created_at,
      number: f.number, stages, wall_ms: msSince(f.started_at, f.finished_at), waiting_approval: f.waiting === 1,
      step_ms: f.step_ms == null ? null : Math.round(f.step_ms),
      steps: jobs.map((j) => ({ name: j.leg ? `${j.name} (${j.leg})` : j.name, stage: j.stage, status: j.status, logs: "", missing_secrets: j.missing })) };
  });
}

// GET /api/repos/:name/flow-runs → FlowRun[], newest first: manual runs and deploy syncs alike.
export async function listRuns(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  return Response.json(await runsOf(env, repo.id));
}

// The repo and the head sha of ?ref= (the default branch when none); sha is undefined when ref has no commit.
async function flowsAt(request, env, name) {
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return { missing: error(404, "not_found", `no repo ${name}`) };
  const artifacts = createArtifacts(env.ARTIFACTS);
  const ref = new URL(request.url).searchParams.get("ref") || repo.default_branch;
  return { repo, artifacts, sha: (await artifacts.log(name, ref))[0]?.sha };
}

// GET /api/repos/:name/flows?ref= → FlowList: every .cinder/flows/*.yml at the head of ref (head), its main trigger, and its
// pass/fail health over its last 30 runs (trusted from the repo's min_outcomes) with its last run. The first flow carries its
// file (as getFlow's), so the Designer opens it without a second request. Server-Timing: head, tree, files (with the D1 reads).
export async function listFlows(request, env, { name }) {
  const start = performance.now();
  const { missing, repo, artifacts, sha } = await flowsAt(request, env, name);
  if (missing) return missing;
  const atHead = performance.now();
  let atTree = atHead;
  const [[{ min_outcomes }, { results: runs }], read] = await Promise.all([Promise.all([trustOf(env.DB, repo.id), env.DB.prepare(`SELECT * FROM (SELECT flow, id, status, number,
      row_number() OVER (PARTITION BY flow ORDER BY created_at DESC, rowid DESC) AS k FROM flow_runs WHERE repo_id = ?) WHERE k <= 30 ORDER BY k`).bind(repo.id).all()]),
  (async () => {
    const files = ((sha && await artifacts.readTree(name, sha, ".cinder/flows")) ?? [])
      .filter((e) => e.type === "blob" && e.name.endsWith(".yml") && FLOW_NAME.test(e.name.slice(0, -4)));
    atTree = performance.now();
    return Promise.all(files.map(async (e, i) => {
      const flow = e.name.slice(0, -4);
      const [yaml, last_run_steps] = await Promise.all([artifacts.readFile(name, sha, e.path), i === 0 && lastSteps(env, repo.id, flow)]);
      // An invalid flow is listed with no triggers; its file says why.
      const { def, errors } = readFlow(yaml ?? "", e.path), bad = errors.map((x) => x.text).join("; ");
      return { flow, on: bad ? [] : def.on, ...(i === 0 && yaml != null && { file: { yaml, def: bad ? null : def, last_run_steps, ...(bad && { error: bad }) } }) };
    }));
  })()]);
  const done = performance.now(), ms = (a, b) => (b - a).toFixed(1);
  return Response.json(read.map(({ flow, on, file }) => {
    const mine = runs.filter((r) => r.flow === flow);
    const passed = mine.filter((r) => r.status === "passed").length, failed = mine.filter((r) => r.status === "failed").length;
    return { flow, head: sha, trigger: ["change", "push", "cron"].find((t) => on.includes(t)) ?? "manual", on,
      health: { passed, failed, n: passed + failed, trusted: passed + failed >= min_outcomes },
      ...(mine[0] && { last_run: { id: mine[0].id, status: mine[0].status, number: mine[0].number } }), ...(file && { file }) };
  }), { headers: { "Server-Timing": `head;dur=${ms(start, atHead)}, tree;dur=${ms(atHead, atTree)}, files;dur=${ms(atTree, done)}` } });
}

// Each step's status and duration in the flow's last run: {[step]: {status, ms}}.
async function lastSteps(env, repoId, flow) {
  const { results } = await env.DB.prepare(`SELECT name, status, started_at, finished_at FROM flow_step_runs WHERE run_id =
    (SELECT id FROM flow_runs WHERE repo_id = ? AND flow = ? ORDER BY created_at DESC, rowid DESC LIMIT 1)`).bind(repoId, flow).all();
  return Object.fromEntries(results.map((s) => [s.name, { status: s.status, ms: msSince(s.started_at, s.finished_at) }]));
}

// GET /api/repos/:name/flows/:flow?ref= → FlowFile: the YAML at the head of ref, its parsed def (null with error when
// it doesn't parse) and each step's status and duration in the flow's last run.
export async function getFlow(request, env, { name, flow }) {
  const { missing, repo, artifacts, sha } = await flowsAt(request, env, name);
  if (missing) return missing;
  const yaml = sha && FLOW_NAME.test(flow) ? await artifacts.readFile(name, sha, `.cinder/flows/${flow}.yml`) : null;
  if (yaml == null) return error(404, "not_found", `no flow ${flow}`);
  const { def, errors } = readFlow(yaml, `.cinder/flows/${flow}.yml`), bad = errors.map((e) => e.text).join("; ");
  return Response.json({ yaml, def: bad ? null : def, head: sha, last_run_steps: await lastSteps(env, repo.id, flow), ...(bad && { error: bad }) });
}

// POST /api/work/jobs/:job/steps {name, status, logs?, missing_secrets?}: the worker holding the flow job records one step.
export async function reportStep(request, env, { job: id }) {
  const runner = await runnerOf(request, env);
  const b = await maskedJson(request, env, id);
  if (typeof b?.name !== "string" || !STEP_STATUSES.includes(b.status) || typeof (b.logs ?? "") !== "string"
    || !(Array.isArray(b.missing_secrets ?? []) && (b.missing_secrets ?? []).every((k) => typeof k === "string" && ENV_KEY.test(k)))) {
    return error(400, "bad_request", `body must be {name, status, logs?, missing_secrets?} with status from: ${STEP_STATUSES.join(", ")}`);
  }
  const job = await env.DB.prepare("SELECT payload FROM jobs WHERE id = ? AND kind = 'flow' AND runner_id = ? AND status = 'claimed'").bind(id, runner.runner_id).first();
  if (!job) return error(403, "forbidden", `flow job ${id} is not leased to this worker`);
  const payload = JSON.parse(job.payload);
  if (!payload.steps.some((s) => s.name === b.name)) return error(400, "bad_request", `no step ${b.name} in this flow`);
  // A skipped step never asks for its secrets, so the ones it would miss are looked up here.
  const step = payload.steps.find((s) => s.name === b.name);
  const missing = b.status === "skipped" && !b.missing_secrets ? await unresolved(env, id, step.secrets ?? []) : b.missing_secrets ?? [];
  await recordStep(env, id, payload, b.name, b.status, b.logs ?? "", missing);
  return new Response(null, { status: 204 });
}

// Records step name of flow job id (payload) in flow_steps, its log tail in R2, any missing secrets and its flow_step_runs row. A legacy job's
// step is a one-step job of the run, so its status is that job's.
async function recordStep(env, id, payload, name, status, logs, missing = []) {
  const key = `flows/${id}/${name}`;
  await env.LOGS.put(key, mask(logs, []).slice(-MAX_LOG_CHARS));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO flow_steps (job_id, name, status, logs) VALUES (?1, ?2, ?3, ?4) ON CONFLICT DO UPDATE SET status = ?3, logs = ?4").bind(id, name, status, key),
    env.DB.prepare("INSERT INTO flow_step_missing_secrets (job_id, name, secrets) VALUES (?1, ?2, ?3) ON CONFLICT DO UPDATE SET secrets = ?3").bind(id, name, JSON.stringify(missing)),
  ]);
  const now = new Date().toISOString();
  const end = ["passed", "failed", "skipped"].includes(status) ? now : null;
  const step = payload.steps.find((s) => s.name === name);
  const [runId, jobKey, idx] = payload.run_id ? [payload.run_id, payload.key, payload.steps.indexOf(step)] : [id, `${step.stage}/${name}`, 0];
  await env.DB.prepare(`INSERT INTO flow_step_runs (run_id, job_key, idx, name, status, started_at, finished_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT DO UPDATE SET status = ?5, finished_at = ?7`).bind(runId, jobKey, idx, name, status, now, end).run();
  if (!payload.run_id) await moved(env, env.DB.prepare("UPDATE flow_jobs SET status = ?1, started_at = coalesce(started_at, ?2), finished_at = ?3 WHERE run_id = ?4 AND key = ?5 RETURNING run_id")
    .bind(status, now, end, id, jobKey));
  // A deploy outside Cloudflare is the environment's sync, so Environments shows it; its version is the commit it deployed.
  const sync = { running: "Progressing", passed: "Synced", failed: "Failed" }[status];
  if (externalEnv(step) && sync) {
    await env.DB.prepare(`INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at)
      SELECT ?1, r.name, ?2, ?3, ?3, ?4, '[]', ?5, ?6, ?6 FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE j.id = ?7
      ON CONFLICT (id) DO UPDATE SET status = ?4, at = ?6`).bind(`${id}/${name}`, step.deploy, payload.sha, sync, `flow:${payload.flow}`, now, id).run();
  }
}

// POST /api/work/jobs/:job/steps/:step/start → {status, logs}: the worker holding the flow job hands cinder a step it
// doesn't run itself (a Cloudflare deploy, a cloudflare/workflow or an approval) and repeats the call until the step
// passes or fails. The first call starts it; a step whose needs haven't all passed is refused, so nothing runs past a
// pending approval.
export async function driveStep(request, env, { job: id, step: name }) {
  const runner = await runnerOf(request, env);
  const job = await env.DB.prepare("SELECT j.payload, r.name AS repo FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE j.id = ? AND j.kind = 'flow' AND j.runner_id = ? AND j.status = 'claimed'")
    .bind(id, runner.runner_id).first();
  if (!job) return error(403, "forbidden", `flow job ${id} is not leased to this worker`);
  const run = JSON.parse(job.payload);
  const s = run.steps.find((x) => x.name === name);
  if (!s || s.run || !(s.deploy || s.approval || s.uses === "cloudflare/workflow")) return error(400, "bad_request", `no deploy, cloudflare/workflow or approval step ${name} in this flow`);
  const { results } = await env.DB.prepare("SELECT name, status FROM flow_steps WHERE job_id = ?").bind(id).all();
  const seen = Object.fromEntries(results.map((r) => [r.name, r.status]));
  const waiting = s.needs.filter((n) => seen[n] !== "passed");
  if (waiting.length) return error(409, "blocked", `step ${name} waits on ${waiting.join(", ")}`);
  // Workflow instance ids allow 100 characters of [A-Za-z0-9_-]; a job id and a step name together can be longer.
  const wf = hex((await sha256(`${id}/${name}`)).slice(0, 16));
  let status = "running";
  let logs;
  if (s.approval) {
    // The Needs you item is the gate: Approve passes the step, Reject or Dismiss fails it.
    const text = `Approve step ${name} of flow ${run.flow} (run ${id}) as ${s.approval}`;
    // Only holders of the step's role resolve it (needs.js); the subject is added only with a new item.
    const need = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT OR IGNORE INTO needs (id, kind, repo, change_id, text, actions, created_at) VALUES (?, 'Flow approval', ?, NULL, ?, ?, ?)")
        .bind(need, job.repo, text, JSON.stringify(["Approve", "Reject"]), new Date().toISOString()),
      env.DB.prepare("INSERT INTO need_subjects (need_id, subject) SELECT id, ? FROM needs WHERE id = ?").bind(JSON.stringify({ approvers: s.approval }), need),
    ]);
    const { resolution } = await env.DB.prepare("SELECT resolution FROM needs WHERE kind = 'Flow approval' AND repo = ? AND text = ?").bind(job.repo, text).first();
    if (resolution) status = resolution === "Approve" ? "passed" : "failed";
    logs = resolution ? `${resolution} on Needs you` : `waiting on Needs you for ${s.approval}`;
  } else if (s.uses) {
    const path = `/accounts/${env.CF_ACCOUNT_ID}/workflows/${s.workflow}/instances`;
    if (!seen[name]) {
      await cloudflare(env, path, { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ instance_id: wf, params: { repo: job.repo, sha: run.sha, flow: run.flow, step: name } }) });
    }
    const { result } = await cloudflare(env, `${path}/${wf}`);
    const steps = result.steps ?? [];
    status = FINISHED[result.status] ?? "running";
    logs = [`${wf} · step ${steps.filter((x) => x.end).length} of ${steps.length}`, ...steps.map((x) => `${x.name} · ${x.end ? "done" : "pending"}`)].join("\n");
  } else if (s.target && s.target !== "Cloudflare") {
    status = "failed";
    logs = `a deploy to ${s.target} runs on the worker: give the step the run command that deploys`;
  } else {
    // A Cloudflare deploy is an environment sync on cinder-pipeline, whose deploy_syncs row (id wf) says how it went.
    const target = (await manifest(env, job.repo))?.environments.find((e) => e.name === s.deploy);
    if (!target?.branch) {
      status = "failed";
      logs = `no branch environment ${s.deploy} in ${job.repo}`;
    } else {
      if (!seen[name]) await env.PIPELINE.create({ id: wf, params: { sync: wf, repo: job.repo, branch: target.branch, sha: run.sha, actor: `flow:${run.flow}` } });
      const sync = await env.DB.prepare("SELECT status FROM deploy_syncs WHERE id = ?").bind(wf).first("status");
      const instance = (await (await env.PIPELINE.get(wf)).status()).status;
      status = sync === "Synced" ? "passed" : sync === "Progressing" || (!sync && !FINISHED[instance]) ? "running" : "failed";
      logs = `${wf} · sync ${sync ?? instance}`;
    }
  }
  await recordStep(env, id, run, name, status, logs);
  return Response.json({ status, logs });
}

// Starts a run of each flow in source's .cinder/flows at sha whose on: lists trigger, in target ({id, name}).
// source is target's name or, for the change trigger, the change's fork. The run id carries key (a pushed sha, a cron
// tick), so a redelivered push or a re-run tick starts nothing twice. change ({change_id, ref}) is the change a push to a fork came from.
export async function enqueueFlows(env, target, source, sha, trigger, key, change) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  for (const e of (await artifacts.readTree(source, sha, ".cinder/flows")) ?? []) {
    const flow = e.name.replace(/\.yml$/, "");
    if (e.type !== "blob" || flow === e.name || !FLOW_NAME.test(flow)) continue;
    const { def, errors } = readFlow(await artifacts.readFile(source, sha, e.path) ?? "", e.path);
    // An invalid flow fails on every push and change, whatever its on says, and on cron only when due.
    if ((!errors.length && !def.on.includes(trigger)) || (trigger === "cron" && !(typeof def?.cron === "string" && cronDue(def.cron, key)))) continue;
    const id = `${trigger}-${target.id}-${flow}-${key}`, payload = { flow, sha, trigger, ...change, ...(source !== target.name && { fork: source }) };
    if (errors.length) await failValidation(env, target, id, payload, e.path, errors);
    else await openRun(env, target.id, id, { ...def, ...payload }, "cinder");
  }
}

// Records run id of an invalid flow (payload without its steps) as failed: one job, Validate flow, whose log lists each error of
// the file at path and holds an error annotation on its line. A repeated id records nothing twice.
async function failValidation(env, target, id, payload, path, errors) {
  const now = new Date().toISOString(), name = "Validate flow", key = `validate/${name}`;
  const [run] = await env.DB.batch([env.DB.prepare(`INSERT OR IGNORE INTO flow_runs (id, repo_id, flow, number, sha, ref, trigger, change_id, actor, status, created_at, started_at, finished_at, payload)
    SELECT ?1, ?2, ?3, coalesce(max(number), 0) + 1, ?4, ?5, ?6, ?7, 'cinder', 'failed', ?8, ?8, ?8, ?9 FROM flow_runs WHERE repo_id = ?2 AND flow = ?3`)
    .bind(id, target.id, payload.flow, payload.sha, payload.ref ?? null, payload.trigger, payload.change_id ?? null, now,
      JSON.stringify({ ...payload, steps: [{ name, stage: "validate", run: "", deploy: "", needs: [] }] })),
  env.DB.prepare("INSERT OR IGNORE INTO flow_jobs (run_id, key, stage, name, status, started_at, finished_at) VALUES (?, ?, 'validate', ?, 'failed', ?, ?)").bind(id, key, name, now, now),
  env.DB.prepare("INSERT OR IGNORE INTO flow_step_runs (run_id, job_key, idx, name, status, started_at, finished_at) VALUES (?, ?, 0, ?, 'failed', ?, ?)").bind(id, key, name, now, now)]);
  if (!run.meta.changes) return;
  await appendLog(env, { repo: target.name, name, run: id, key, idx: 0, job: id,
    ensure: env.DB.prepare("INSERT OR IGNORE INTO flow_step_logs (run_id, job_key, idx, job_id) VALUES (?, ?, 0, ?)").bind(id, key, id) }, null,
  errors.map((e) => ({ at: now, text: e.text })));
  await env.DB.batch(errors.map((e, i) => env.DB.prepare("INSERT INTO flow_annotations (run_id, job_key, step, line, level, message, file, file_line) VALUES (?, ?, ?, ?, 'error', ?, ?, ?)")
    .bind(id, key, name, i, e.text, path, e.line)));
}

// Whether sha on branch of repo is a direct push cinder rolled back, or is still rolling back (pushes.js): a run there
// would hand the org's secrets to commits that never went through a change.
const rejectedHead = (env, repo, branch, sha) => env.DB.prepare("SELECT 1 FROM rejected_pushes WHERE repo = ? AND ref = ? AND sha = ?")
  .bind(repo, `refs/heads/${branch}`, sha).first();

// Runs on the Worker's cron: each repo's cron flows on its default branch head that fell due in the tick just ended.
// lazy: reads every repo's flows each tick; keep a cron index in D1 past ~100 repos.
export async function cronFlows(env, at) {
  const tick = Math.floor(at / 60_000) * 60_000;
  const { results } = await env.DB.prepare("SELECT id, name, default_branch FROM repos").all();
  for (const repo of results) {
    try {
      const sha = (await createArtifacts(env.ARTIFACTS).log(repo.name, repo.default_branch))[0]?.sha;
      if (sha && await rejectedHead(env, repo.name, repo.default_branch, sha)) console.error(`cron flows: ${repo.name}: head ${sha} is a rolled-back direct push`);
      else if (sha) await enqueueFlows(env, repo, repo.name, sha, "cron", tick);
    } catch (e) {
      console.error(`cron flows: ${repo.name}: ${e.message}`); // one unreadable repo doesn't hold back the others
    }
  }
}

// Whether five-field cron (UTC) matches a minute in (tick - TICK_MINUTES, tick].
// lazy: no names (MON, JAN), day 7 or day-of-month/day-of-week OR rule; */n counts from 0 in every field.
function cronDue(cron, tick) {
  const hit = (field, v) => field.split(",").some((part) => {
    const [range, every] = part.split("/");
    const [lo, hi] = range === "*" ? [0, 59] : range.split("-").map(Number);
    return v >= lo && v <= (hi ?? (every ? 59 : lo)) && (v - lo) % (Number(every) || 1) === 0;
  });
  for (let i = 0; i < TICK_MINUTES; i++) {
    const d = new Date(tick - i * 60_000);
    const at = [d.getUTCMinutes(), d.getUTCHours(), d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCDay()];
    if (cron.split(" ").every((f, k) => hit(f, at[k]))) return true;
  }
  return false;
}
