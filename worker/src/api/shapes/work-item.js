const str = (v) => typeof v === "string" && v.length > 0;
const orNull = (v) => v === null || str(v);
const count = (v) => Number.isInteger(v) && v >= 0;
const LANES = ["intent", "progress", "verify", "review", "queue", "merged"];

// GET /api/repos/:name/work: one board item, an open issue (intent) or a change carrying its lowest linked issue's n.
export function validateWorkItem(v) {
  const errors = [];
  if (!["intent", "change"].includes(v?.kind)) errors.push("kind: expected intent|change");
  if (!(v?.n === null || (Number.isInteger(v?.n) && v.n >= 1))) errors.push("n: expected null or integer >= 1");
  if (!orNull(v?.change_id) || (v?.kind === "change") !== str(v?.change_id)) errors.push("change_id: expected a change id iff kind is change");
  if (v?.kind === "intent" && v.n === null) errors.push("n: expected an issue number on an intent");
  for (const k of ["title", "author", "updated_at"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!LANES.includes(v?.lane)) errors.push(`lane: expected ${LANES.join("|")}`);
  if (!(v?.priority === null || ["P0", "P1", "P2", "P3"].includes(v?.priority))) errors.push("priority: expected null or P0|P1|P2|P3");
  if (!Array.isArray(v?.labels) || !v.labels.every(str)) errors.push("labels: expected string[]");
  for (const k of ["assignee", "why"]) if (!orNull(v?.[k])) errors.push(`${k}: expected null or non-empty string`);
  // diff: a change's diff summary, null until its head has one; ahead and behind are null until a compare reports them.
  const d = v?.diff;
  if (d != null && !(["files_changed", "additions", "deletions"].every((k) => count(d[k])) && ["ahead", "behind"].every((k) => d[k] === null || count(d[k])))) {
    errors.push("diff: expected null or {files_changed, additions, deletions, ahead, behind}");
  }
  return { ok: errors.length === 0, errors };
}

// {items, tiles}: tiles count the listed items per lane, needs_you is approval plus requested (the review lane),
// verifier is the repo's verify-job outcomes, trusted from its trustOf() min_outcomes; can_write is whether the caller may
// claim and release intents.
export function validateWorkBoard(v) {
  const errors = [];
  if (!Array.isArray(v?.items)) errors.push("items: expected array");
  else v.items.forEach((item, i) => errors.push(...validateWorkItem(item).errors.map((e) => `items[${i}].${e}`)));
  const t = v?.tiles;
  for (const k of ["intents", "in_flight", "review", "merged_24h", "needs_you"]) if (!count(t?.[k])) errors.push(`tiles.${k}: expected integer >= 0`);
  if (!count(t?.verifier?.pass) || !count(t?.verifier?.n) || t.verifier.pass > t.verifier.n || typeof t.verifier.trusted !== "boolean") {
    errors.push("tiles.verifier: expected {pass <= n, n, trusted}");
  }
  if (typeof v?.can_write !== "boolean") errors.push("can_write: expected boolean");
  return { ok: errors.length === 0, errors };
}
