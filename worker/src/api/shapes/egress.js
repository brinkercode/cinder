const VERDICTS = ["allowed", "denied", "would_deny"];

// Per verdict, a CONNECT total >= 0 (the egress proxy's summary counts).
function countsErrors(c, at) {
  return VERDICTS.every((k) => Number.isInteger(c?.[k]) && c[k] >= 0) ? [] : [`${at}.counts: expected {allowed, denied, would_deny} integers >= 0`];
}

// GET /api/repos/:name/egress?window=24h|7d|30d: per agent version (name@vN), its top hosts by CONNECT count per verdict,
// highest first, and its totals per verdict; per job in the window, its totals per verdict.
export function validateEgress(v) {
  const errors = [];
  if (!["24h", "7d", "30d"].includes(v?.window)) errors.push("window: expected 24h, 7d or 30d");
  if (!Array.isArray(v?.versions)) errors.push("versions: expected array");
  else v.versions.forEach((x, i) => {
    if (typeof x?.agent !== "string" || !x.agent) errors.push(`versions[${i}].agent: expected non-empty string`);
    errors.push(...countsErrors(x?.counts, `versions[${i}]`));
    for (const k of VERDICTS) {
      if (!Array.isArray(x?.[k]) || !x[k].every((h) => typeof h?.host === "string" && h.host && Number.isInteger(h.count) && h.count > 0)) {
        errors.push(`versions[${i}].${k}: expected [{host, count > 0}]`);
      }
    }
  });
  if (!Array.isArray(v?.jobs)) errors.push("jobs: expected array");
  else v.jobs.forEach((x, i) => {
    if (typeof x?.job_id !== "string" || !x.job_id || typeof x?.agent !== "string" || !x.agent) errors.push(`jobs[${i}]: expected {job_id, agent} non-empty strings`);
    errors.push(...countsErrors(x?.counts, `jobs[${i}]`));
  });
  return { ok: errors.length === 0, errors };
}
