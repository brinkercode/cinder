const STATUSES = ["vulnerable", "outdated", "unchecked", "current"];

// GET /api/repos/:name/dependencies returns a list of these; auto_fix is set by PATCH /api/repos/:name/dependencies. also_fixes counts the dep's other vulns a bump to fixed_in fixes.
export function validateDependency(v) {
  const errors = [];
  for (const k of ["ecosystem", "name", "version"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  if (typeof v?.license !== "string") errors.push("license: expected string");
  if (typeof v?.direct !== "boolean") errors.push("direct: expected boolean");
  if (typeof v?.auto_fix !== "boolean") errors.push("auto_fix: expected boolean");
  if (!STATUSES.includes(v?.status)) errors.push(`status: expected one of ${STATUSES.join(", ")}`);
  if (!Array.isArray(v?.vulns)) errors.push("vulns: expected list");
  (Array.isArray(v?.vulns) ? v.vulns : []).forEach((x, i) => {
    if (typeof x?.id !== "string" || !x.id) errors.push(`vulns[${i}].id: expected non-empty string`);
    if (typeof x?.severity !== "string" || !x.severity) errors.push(`vulns[${i}].severity: expected non-empty string`);
    if (x?.fixed_in !== null && (typeof x?.fixed_in !== "string" || !x.fixed_in)) errors.push(`vulns[${i}].fixed_in: expected non-empty string or null`);
    if (!Number.isInteger(x?.also_fixes) || x.also_fixes < 0) errors.push(`vulns[${i}].also_fixes: expected integer >= 0`);
  });
  return { ok: errors.length === 0, errors };
}
