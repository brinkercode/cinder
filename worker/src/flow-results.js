// A flow run's actions and results: cancel, re-run, the test suites its runners parsed and the artifacts they uploaded.
// Artifacts live in R2 LOGS at artifacts/<run>/<job_key>/<name>, which an R2 lifecycle rule expires after 30 days
// (deploy/reconcile.sh).
import { leased, runIn } from "./flow-logs.js";
import { advance, cancelJobs } from "./flows.js";
import { maskedJson } from "./keystore.js";
import { error } from "./router.js";

const MAX_ARTIFACT_BYTES = 100 * 1024 * 1024;
const RETENTION_MS = 30 * 864e5;
const ARTIFACT_NAME = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;
const SCOPES = ["all", "failed", "job"];
const count = (v) => Number.isInteger(v) && v >= 0;
const notLeased = (id) => error(403, "forbidden", `flow job ${id} is not leased to this worker`);
const noRun = (name, id) => error(404, "not_found", `no flow run ${id} in ${name}`);

// POST /api/repos/:name/flow-runs/:id/cancel → 202: every queued and running job of the run is cancelled; a runner
// holding one hears cancel on its next heartbeat (work.js).
export async function cancelRun(request, env, { name, id }) {
  if (!(await runIn(env, name, id))) return noRun(name, id);
  await cancelJobs(env, id);
  return new Response(null, { status: 202 });
}

// POST /api/repos/:name/flow-runs/:id/rerun {scope: all|failed|job, key?} → 201 {id, attempt}: the run's next attempt
// re-queues every job, those that didn't pass, or the job key. Jobs not re-queued keep their status and logs.
export async function rerunRun(request, env, { name, id }) {
  const b = await request.json().catch(() => null);
  if (!SCOPES.includes(b?.scope) || (b.scope === "job" && !(typeof b.key === "string" && b.key))) {
    return error(400, "bad_request", "body must be {scope: all|failed|job, key?} with the job's key for scope job");
  }
  if (!(await runIn(env, name, id))) return noRun(name, id);
  // A run of a flow with no jobs is one jobs row (id = run id) that can't re-queue part of itself.
  if (await env.DB.prepare("SELECT 1 FROM jobs WHERE id = ?").bind(id).first()) return error(409, "legacy_run", "this run's flow has no jobs to re-run; start a new run");
  // A flow that failed validation (flows.js failValidation) has nothing to run; a fixed file runs on its next push.
  if (await env.DB.prepare("SELECT 1 FROM flow_jobs WHERE run_id = ? AND key = 'validate/Validate flow'").bind(id).first()) return error(409, "invalid_flow", "this flow failed validation; fix the file and push");
  if (await env.DB.prepare("SELECT 1 FROM flow_jobs WHERE run_id = ? AND status IN ('queued', 'running')").bind(id).first()) {
    return error(409, "running", "the run is still going; cancel it or wait for it to finish");
  }
  const pick = { all: "1", failed: "status IN ('failed', 'skipped', 'cancelled')", job: "key = ?2" }[b.scope];
  // Only finished jobs are re-queued, so a second re-run racing this one finds nothing to take.
  const { results } = await env.DB.prepare(`UPDATE flow_jobs SET status = 'queued', attempt = attempt + 1, job_id = NULL, runner_id = NULL, instance = NULL,
    started_at = NULL, finished_at = NULL WHERE run_id = ?1 AND status NOT IN ('queued', 'running') AND ${pick} RETURNING key`).bind(id, ...(b.scope === "job" ? [b.key] : [])).all();
  if (!results.length) return error(b.scope === "job" ? 404 : 409, "nothing_to_rerun", b.scope === "job" ? `no job ${b.key} in run ${id}` : "no job of this run matches the scope");
  const keys = JSON.stringify(results.map((r) => r.key));
  const [attempt] = await env.DB.batch([
    env.DB.prepare("INSERT INTO flow_run_attempts (run_id, attempt) VALUES (?, 2) ON CONFLICT DO UPDATE SET attempt = attempt + 1 RETURNING attempt").bind(id),
    ...["flow_step_runs", "flow_step_logs", "flow_annotations", "flow_tests"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE run_id = ? AND job_key IN (SELECT value FROM json_each(?))`).bind(id, keys)),
  ]);
  await advance(env, id);
  return Response.json({ id, attempt: attempt.results[0].attempt }, { status: 201 });
}

// POST /api/work/jobs/:job/tests {suite, passed, failed, skipped, failures: [test names]} → 204, from the runner holding the job.
export async function postTests(request, env, { job: id }) {
  const job = await leased(request, env, id);
  if (!job) return notLeased(id);
  const b = await maskedJson(request, env, id);
  if (typeof b?.suite !== "string" || !b.suite || !count(b.passed) || !count(b.failed) || !count(b.skipped)
    || !Array.isArray(b.failures) || !b.failures.every((f) => typeof f === "string")) {
    return error(400, "bad_request", "body must be {suite, passed, failed, skipped, failures: [test names]}");
  }
  const [run, key] = job.place(0);
  await env.DB.prepare(`INSERT INTO flow_tests (run_id, job_key, suite, passed, failed, skipped, failures) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
    ON CONFLICT DO UPDATE SET passed = ?4, failed = ?5, skipped = ?6, failures = ?7`).bind(run, key, b.suite, b.passed, b.failed, b.skipped, JSON.stringify(b.failures)).run();
  return new Response(null, { status: 204 });
}

// GET /api/repos/:name/flow-runs/:id/tests → FlowTests: each job's suites, by suite.
export async function listTests(request, env, { name, id }) {
  if (!(await runIn(env, name, id))) return noRun(name, id);
  const { results } = await env.DB.prepare("SELECT suite, job_key, passed, failed, skipped, failures FROM flow_tests WHERE run_id = ? ORDER BY suite, job_key").bind(id).all();
  return Response.json(results.map((t) => ({ ...t, failures: JSON.parse(t.failures) })));
}

// PUT /api/work/jobs/:job/artifacts/:name (≤ 100 MB, Content-Length required) → 204: streamed to R2 as is.
export async function putArtifact(request, env, { job: id, name }) {
  const job = await leased(request, env, id);
  if (!job) return notLeased(id);
  if (!ARTIFACT_NAME.test(name)) return error(400, "bad_request", `artifact name must match ${ARTIFACT_NAME}`);
  const size = Number(request.headers.get("Content-Length"));
  if (!request.headers.get("Content-Length") || !Number.isInteger(size)) return error(411, "length_required", "send Content-Length");
  if (size > MAX_ARTIFACT_BYTES) return error(413, "too_large", `an artifact is at most ${MAX_ARTIFACT_BYTES} bytes`);
  const [run, key] = job.place(0);
  await env.LOGS.put(`artifacts/${run}/${key}/${name}`, request.body);
  return new Response(null, { status: 204 });
}

// The run's artifacts in R2 as FlowArtifact rows without url. A name two jobs uploaded appears once per job.
// lazy: one R2 list page (1000 objects); follow the cursor once a run uploads more.
async function artifactsOf(env, id) {
  const prefix = `artifacts/${id}/`;
  const { objects } = await env.LOGS.list({ prefix });
  return objects.map((o) => {
    const rest = o.key.slice(prefix.length);
    const cut = rest.lastIndexOf("/");
    return { name: rest.slice(cut + 1), job_key: rest.slice(0, cut), size: o.size, expires_at: new Date(o.uploaded.getTime() + RETENTION_MS).toISOString(), key: o.key };
  });
}

// GET /api/repos/:name/flow-runs/:id/artifacts → [FlowArtifact]
export async function listArtifacts(request, env, { name, id }) {
  if (!(await runIn(env, name, id))) return noRun(name, id);
  return Response.json((await artifactsOf(env, id)).map((a) => ({ name: a.name, job_key: a.job_key, size: a.size, expires_at: a.expires_at, url: `/api/repos/${name}/flow-runs/${id}/artifacts/${a.name}` })));
}

// GET /api/repos/:name/flow-runs/:id/artifacts/:artifact → the bytes. A name two jobs uploaded serves the first job's.
export async function getArtifact(request, env, { name, id, artifact }) {
  if (!(await runIn(env, name, id))) return noRun(name, id);
  const found = (await artifactsOf(env, id)).find((a) => a.name === artifact);
  const object = found && (await env.LOGS.get(found.key));
  if (!object) return error(404, "not_found", `no artifact ${artifact} in run ${id}`);
  return new Response(object.body, { headers: { "Content-Type": "application/octet-stream", "Content-Length": String(object.size),
    "Content-Disposition": `attachment; filename="${found.name}"` } });
}
