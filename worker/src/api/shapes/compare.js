// GET /api/repos/:name/compare?base&head: head's commits and per-file diffs against base. diff is null (202) until the
// compare job reports; truncated diffs keep the first files within 200 files / 5k lines, and stats count them all.
export function validateCompare(v) {
  const errors = [];
  for (const k of ["base", "head", "base_sha", "head_sha"]) if (typeof v?.[k] !== "string" || !v[k]) errors.push(`${k}: expected non-empty string`);
  const d = v?.diff;
  const count = (n) => Number.isInteger(n) && n >= 0;
  if (d === null) return { ok: errors.length === 0, errors };
  for (const k of ["ahead", "behind"]) if (!count(d?.[k])) errors.push(`diff.${k}: expected integer >= 0`);
  for (const k of ["files_changed", "additions", "deletions"]) if (!count(d?.stats?.[k])) errors.push(`diff.stats.${k}: expected integer >= 0`);
  if (typeof d?.truncated !== "boolean") errors.push("diff.truncated: expected boolean");
  if (!Array.isArray(d?.commits)) errors.push("diff.commits: expected array");
  else d.commits.forEach((c, i) => {
    if (typeof c?.sha !== "string" || !c.sha) errors.push(`diff.commits[${i}].sha: expected non-empty string`);
    if (typeof c?.message !== "string") errors.push(`diff.commits[${i}].message: expected string`);
  });
  if (!Array.isArray(d?.files)) errors.push("diff.files: expected array");
  else d.files.forEach((f, i) => {
    for (const k of ["path", "status"]) if (typeof f?.[k] !== "string" || !f[k]) errors.push(`diff.files[${i}].${k}: expected non-empty string`);
    for (const k of ["additions", "deletions"]) if (!count(f?.[k])) errors.push(`diff.files[${i}].${k}: expected integer >= 0`);
    if (typeof f?.patch !== "string") errors.push(`diff.files[${i}].patch: expected string`);
  });
  return { ok: errors.length === 0, errors };
}
