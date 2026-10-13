// GET /api/repos/:name/symbols?target= returns one of these. symbols is null while the index job for sha is pending;
// sha and symbols are both null when the target has no commits.
export function validateSymbolIndex(v) {
  const errors = [];
  if (v?.sha === null ? v.symbols !== null : typeof v?.sha !== "string" || !v.sha) {
    errors.push("sha: expected non-empty string, or null with null symbols");
  }
  if (v?.symbols !== null && !Array.isArray(v?.symbols)) errors.push("symbols: expected array or null");
  else v.symbols?.forEach((s, i) => {
    for (const k of ["path", "name", "kind"]) {
      if (typeof s?.[k] !== "string" || !s[k]) errors.push(`symbols[${i}].${k}: expected non-empty string`);
    }
    if (!(Number.isInteger(s?.start) && s.start >= 1)) errors.push(`symbols[${i}].start: expected integer >= 1`);
    if (!(Number.isInteger(s?.end) && s.end >= s?.start)) errors.push(`symbols[${i}].end: expected integer >= start`);
    if (typeof s?.exported !== "boolean") errors.push(`symbols[${i}].exported: expected boolean`);
  });
  return { ok: errors.length === 0, errors };
}
