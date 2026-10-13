// The live intent box predicts leases from these: an intent naming any of `words` touches `symbols`.
const strs = (v) => Array.isArray(v) && v.length > 0 && v.every((s) => typeof s === "string" && s.length > 0);

export function validateIntentHint(v) {
  const errors = [];
  if (typeof v?.repo_id !== "string" || !v.repo_id) errors.push("repo_id: expected non-empty string");
  if (!strs(v?.words)) errors.push("words: expected non-empty string array");
  if (!strs(v?.symbols)) errors.push("symbols: expected non-empty string array");
  return { ok: errors.length === 0, errors };
}
