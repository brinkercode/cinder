// GET /api/agents/:name/diff?from&to returns this. from/to are a version number or "draft".
// prompt is a line diff: each line starts with " " (kept), "-" (only in from) or "+" (only in to).
export function validateAgentDiff(v) {
  const errors = [];
  for (const k of ["from", "to"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  if (!Array.isArray(v?.fields)) errors.push("fields: expected array");
  else v.fields.forEach((f, i) => {
    if (typeof f?.field !== "string" || !f.field) errors.push(`fields[${i}].field: expected non-empty string`);
    for (const k of ["from", "to"]) if (!Object.hasOwn(f ?? {}, k)) errors.push(`fields[${i}].${k}: required`);
    if (typeof f?.widens !== "boolean") errors.push(`fields[${i}].widens: expected boolean`);
  });
  if (!Array.isArray(v?.prompt) || !v.prompt.every((l) => typeof l === "string" && /^[ +-]/.test(l))) {
    errors.push("prompt: expected array of lines starting with ' ', '-' or '+'");
  }
  return { ok: errors.length === 0, errors };
}
