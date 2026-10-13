// GET /api/agents/:name/versions returns this: each version, the channel pointing at it (null for none), the canary's
// share of changes (0 otherwise), the changes it ran on that ended: merged of n, trusted once n reaches the threshold, and
// its web setting with the responses its jobs had converted to Markdown and the bytes saved (negative when Markdown ran longer).
export function validateAgentVersions(v) {
  const errors = [];
  const count = (x) => Number.isInteger(x) && x >= 0;
  if (!Array.isArray(v)) errors.push("expected array");
  else v.forEach((x, i) => {
    if (!Number.isInteger(x?.version) || x.version < 1) errors.push(`[${i}].version: expected integer >= 1`);
    if (![null, "stable", "canary"].includes(x?.channel)) errors.push(`[${i}].channel: expected stable, canary or null`);
    if (!Number.isInteger(x?.share) || x.share < 0 || x.share > 100) errors.push(`[${i}].share: expected integer 0-100`);
    if (x?.released_at !== null && Number.isNaN(Date.parse(x?.released_at))) errors.push(`[${i}].released_at: expected ISO timestamp or null`);
    const o = x?.outcomes;
    if (!count(o?.merged) || !count(o?.n) || o.merged > o.n || typeof o.trusted !== "boolean") errors.push(`[${i}].outcomes: expected {merged <= n, n, trusted}`);
    const w = x?.web;
    if (!["markdown", "raw"].includes(w?.mode) || !count(w.converted) || !Number.isInteger(w.saved_bytes)) errors.push(`[${i}].web: expected {mode: markdown|raw, converted, saved_bytes}`);
  });
  return { ok: errors.length === 0, errors };
}
