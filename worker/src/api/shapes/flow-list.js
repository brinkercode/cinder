import { FLOW_TRIGGERS } from "./flow.js";

const RUN_STATUSES = ["queued", "running", "passed", "failed"];
const str = (v) => typeof v === "string" && v.length > 0;
const count = (v) => Number.isInteger(v) && v >= 0;

// GET /api/repos/:name/flows → [{flow, head, trigger, on, health: {passed, failed, n, trusted}, last_run?}]: head is the
// ref's head sha; trigger is the flow's first of change, push, cron in on (manual when none); health counts its last 30 runs.
// The first entry may carry file: its FlowFile without head (the entry's).
export function validateFlowList(v) {
  const errors = [];
  if (!Array.isArray(v)) return { ok: false, errors: ["expected array"] };
  v.forEach((f, i) => {
    const check = (ok, path, desc) => { if (!ok) errors.push(`[${i}].${path}: expected ${desc}`); };
    check(str(f?.flow), "flow", "non-empty string");
    check(str(f?.head), "head", "non-empty string");
    check(FLOW_TRIGGERS.includes(f?.trigger), "trigger", `one of ${FLOW_TRIGGERS.join(", ")}`);
    // on is as written: a trigger cinder doesn't know is the file's error to show, not a reason to drop the list.
    check(Array.isArray(f?.on) && f.on.every((t) => typeof t === "string"), "on", "list of strings");
    const h = f?.health;
    check(count(h?.passed) && count(h?.failed) && h.n === h.passed + h.failed && typeof h.trusted === "boolean", "health", "{passed, failed, n = passed + failed, trusted}");
    const r = f?.last_run;
    check(r === undefined || (str(r?.id) && RUN_STATUSES.includes(r.status) && Number.isInteger(r.number)), "last_run", "{id, status, number}");
    check(f?.file === undefined || validateFlowFile({ ...f.file, head: f.head }).ok, "file", "FlowFile without head");
  });
  return { ok: errors.length === 0, errors };
}

// GET /api/repos/:name/flows/:flow → {yaml, def, head, last_run_steps: {[step]: {status, ms}}}; def is null with error (every error)
// when the flow doesn't validate (readFlow).
export function validateFlowFile(v) {
  const errors = [];
  const check = (ok, path, desc) => { if (!ok) errors.push(`${path}: expected ${desc}`); };
  check(typeof v?.yaml === "string", "yaml", "string");
  check(str(v?.head), "head", "non-empty string");
  check(v?.def === null ? str(v.error) : typeof v?.def === "object" && v.error === undefined, "def", "object, or null with error");
  check(v?.last_run_steps && typeof v.last_run_steps === "object"
    && Object.values(v.last_run_steps).every((s) => str(s?.status) && count(s.ms)), "last_run_steps", "map of step to {status, ms}");
  return { ok: errors.length === 0, errors };
}
