// POST /api/work/edit-check returns this: one diagnostic per symbol and other change. change is the other change (null
// for info about this change's own lease); intent is its intent.
const str = (v) => typeof v === "string" && v.length > 0;

export function validateEditCheck(v) {
  const errors = [];
  if (!Array.isArray(v?.diagnostics)) return { ok: false, errors: ["diagnostics: expected array"] };
  for (const [i, d] of v.diagnostics.entries()) {
    if (!["error", "warning", "info"].includes(d?.severity)) errors.push(`diagnostics[${i}].severity: expected error, warning or info`);
    for (const k of ["file", "symbol", "suggestion"]) if (!str(d?.[k])) errors.push(`diagnostics[${i}].${k}: expected non-empty string`);
    if (d?.change !== null && !str(d?.change)) errors.push(`diagnostics[${i}].change: expected null or non-empty string`);
    if (typeof d?.intent !== "string") errors.push(`diagnostics[${i}].intent: expected string`);
  }
  return { ok: errors.length === 0, errors };
}
