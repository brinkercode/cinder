// GET /api/agents/:name/history returns these, newest first: released (a version recorded, by null), promoted or rolled_back
// (stable moved up or down) and canary (the canary pointed at a version with its traffic share), each with who and when.
export function validateAgentHistory(e) {
  const errors = [];
  if (!["released", "promoted", "rolled_back", "canary"].includes(e?.kind)) errors.push("kind: expected released, promoted, rolled_back or canary");
  if (!Number.isInteger(e?.version) || e.version < 1) errors.push("version: expected integer >= 1");
  if (e?.share !== null && (!Number.isInteger(e?.share) || e.share < 0 || e.share > 100)) errors.push("share: expected integer 0-100 or null");
  if (e?.by !== null && typeof e?.by !== "string") errors.push("by: expected string or null");
  if (Number.isNaN(Date.parse(e?.at))) errors.push("at: expected ISO timestamp");
  return { ok: errors.length === 0, errors };
}
