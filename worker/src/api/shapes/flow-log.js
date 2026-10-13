// A flow job step's log page and a flow run's annotations (src/flow-logs.js).
const LEVELS = ["error", "warning", "notice"];
const count = (v) => Number.isInteger(v) && v >= 0;
const str = (v) => typeof v === "string" && v.length > 0;

// GET /api/repos/:name/flow-runs/:id/jobs/:key/log → {step, from, lines: [{n, at, text}], next?}, lines numbered from from.
export function validateFlowLogPage(v) {
  const errors = [];
  if (!count(v?.step) || !count(v?.from)) errors.push("step, from: expected integers >= 0");
  if (!Array.isArray(v?.lines) || !v.lines.every((l, i) => l?.n === v.from + i && str(l.at) && typeof l.text === "string")) {
    errors.push("lines: expected [{n, at, text}] numbered from from");
  }
  if (v?.next !== undefined && !(Number.isInteger(v.next) && v.next === v.from + (v.lines?.length ?? 0))) errors.push("next: expected from + lines.length when present");
  return { ok: errors.length === 0, errors };
}

// GET /api/repos/:name/flow-runs/:id/annotations → [FlowAnnotation]
export function validateFlowAnnotation(v) {
  const errors = [];
  for (const k of ["job_key", "step", "message"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!count(v?.line)) errors.push("line: expected integer >= 0");
  if (!LEVELS.includes(v?.level)) errors.push(`level: expected one of ${LEVELS.join(", ")}`);
  if (v?.file !== undefined && !str(v.file)) errors.push("file: expected non-empty string when present");
  if (v?.file_line !== undefined && !(Number.isInteger(v.file_line) && v.file_line >= 1)) errors.push("file_line: expected integer >= 1 when present");
  return { ok: errors.length === 0, errors };
}
