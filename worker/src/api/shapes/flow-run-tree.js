// GET /api/repos/:name/flow-runs/:id (src/flows.js): a flow run's stages → jobs → steps with status and timings, no logs.
const RUN = ["queued", "running", "passed", "failed"];
const JOB = ["queued", "running", "passed", "failed", "skipped", "cancelled"];
const str = (v) => typeof v === "string" && v.length > 0;
const time = (v) => v === null || !Number.isNaN(Date.parse(v));
const count = (v) => Number.isInteger(v) && v >= 0;

export function validateFlowRunTree(v) {
  const errors = [];
  for (const k of ["id", "flow", "sha", "trigger"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  for (const k of ["ref", "actor"]) if (v?.[k] !== null && typeof v?.[k] !== "string") errors.push(`${k}: expected string or null`);
  if (v?.change !== undefined && (!str(v.change?.id) || (v.change.title !== null && typeof v.change.title !== "string"))) errors.push("change: expected {id, title (null when unknown)}");
  if (!Number.isInteger(v?.number) || v.number < 1) errors.push("number: expected integer >= 1");
  if (!RUN.includes(v?.status)) errors.push(`status: expected one of ${RUN.join(", ")}`);
  if (Number.isNaN(Date.parse(v?.created_at)) || !time(v?.started_at) || !time(v?.finished_at)) errors.push("created_at, started_at, finished_at: expected ISO timestamps (null when not yet)");
  if (!count(v?.wall_ms) || !count(v?.sandbox_ms)) errors.push("wall_ms, sandbox_ms: expected integers >= 0");
  if (!count(v?.annotations_count?.error) || !count(v?.annotations_count?.warning)) errors.push("annotations_count: expected {error, warning} counts");
  if (!Array.isArray(v?.stages) || !v.stages.length) errors.push("stages: expected a non-empty list");
  for (const [i, st] of (Array.isArray(v?.stages) ? v.stages : []).entries()) {
    const at = `stages[${i}]`;
    if (!str(st?.id) || !str(st?.name) || !JOB.includes(st?.status) || !Array.isArray(st?.jobs) || !st.jobs.length) errors.push(`${at}: expected {id, name, status, jobs: [..]}`);
    for (const j of Array.isArray(st?.jobs) ? st.jobs : []) {
      if (!str(j?.key) || !str(j?.name) || (j.leg !== undefined && !str(j.leg)) || !JOB.includes(j.status) || (j.instance !== null && !str(j.instance))
        || !Number.isInteger(j.attempt) || j.attempt < 1 || !time(j.started_at) || !time(j.finished_at)) {
        errors.push(`${at}.jobs.${j?.key}: expected {key, name, leg?, status, instance, attempt, started_at, finished_at, steps}`);
      }
      if (!Array.isArray(j?.steps) || !j.steps.every((s, i, all) => count(s?.idx) && all.findIndex((x) => x?.idx === s.idx) === i && str(s.name) && JOB.includes(s.status) && time(s.started_at) && time(s.finished_at) && count(s.lines))) {
        errors.push(`${at}.jobs.${j?.key}.steps: expected [{idx, name, status, started_at, finished_at, lines}] with distinct idx`);
      }
    }
  }
  return { ok: errors.length === 0, errors };
}

// GET /api/repos/:name/flow-runs/:id/tests (src/flow-results.js): one row per job and junit suite, by suite.
export function validateFlowTests(v) {
  const errors = [];
  if (!Array.isArray(v)) errors.push("expected a list");
  for (const [i, t] of (Array.isArray(v) ? v : []).entries()) {
    if (!str(t?.suite) || !str(t?.job_key) || !count(t?.passed) || !count(t?.failed) || !count(t?.skipped) || !Array.isArray(t?.failures) || !t.failures.every(str)) {
      errors.push(`[${i}]: expected {suite, job_key, passed, failed, skipped, failures: [test names]}`);
    }
  }
  return { ok: errors.length === 0, errors };
}

// GET /api/repos/:name/flow-runs/:id/artifacts (src/flow-results.js): each item; expires_at is 30 days after upload.
export function validateFlowArtifact(v) {
  const errors = [];
  for (const k of ["name", "job_key", "url"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!count(v?.size)) errors.push("size: expected integer >= 0");
  if (Number.isNaN(Date.parse(v?.expires_at))) errors.push("expires_at: expected ISO timestamp");
  return { ok: errors.length === 0, errors };
}
