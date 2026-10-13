// POST /api/repos/:name/changes/preview returns one of these. p and risk fields are null when no judge answered.
export function validateChangePreview(v) {
  const errors = [];
  const str = (x) => typeof x === "string" && x.length > 0;
  const prob = (x) => x === null || (typeof x === "number" && x >= 0 && x <= 1);
  for (const k of ["request_id", "target"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  for (const k of ["symbols", "collisions", "agents", "changes"]) if (!Array.isArray(v?.[k])) errors.push(`${k}: expected array`);
  v?.symbols?.forEach?.((s, i) => {
    if (!str(s?.symbol)) errors.push(`symbols[${i}].symbol: expected non-empty string`);
    if (!prob(s?.p)) errors.push(`symbols[${i}].p: expected number in [0, 1] or null`);
  });
  v?.collisions?.forEach?.((c, i) => {
    if (!str(c?.change)) errors.push(`collisions[${i}].change: expected non-empty string`);
    if (!Array.isArray(c?.symbols) || !c.symbols.length || !c.symbols.every(str)) errors.push(`collisions[${i}].symbols: expected non-empty string array`);
  });
  if (!(v?.risk?.answer === null || ["low", "medium", "high"].includes(v?.risk?.answer))) errors.push("risk.answer: expected low, medium, high or null");
  if (!prob(v?.risk?.p)) errors.push("risk.p: expected number in [0, 1] or null");
  if (typeof v?.risk?.trusted !== "boolean") errors.push("risk.trusted: expected boolean");
  v?.agents?.forEach?.((a, i) => {
    if (!str(a?.ref)) errors.push(`agents[${i}].ref: expected non-empty string`);
    if (!(a?.agent_version === null || str(a?.agent_version))) errors.push(`agents[${i}].agent_version: expected non-empty string or null`);
  });
  if (Array.isArray(v?.changes) && !v.changes.every(str)) errors.push("changes: expected non-empty strings");
  return { ok: errors.length === 0, errors };
}
