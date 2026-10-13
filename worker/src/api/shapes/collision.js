export const COLLISION_ACTIONS = ["stack", "seam", "handover", "reprioritize"];

const str = (v) => typeof v === "string" && v.length > 0;
const time = (v) => str(v) && !Number.isNaN(Date.parse(v));

// GET /api/repos/:name/collisions returns this: feed is the collision diagnostics sent to agents in the last 7 days,
// newest first; editing is the symbols a change wrote in the last 10 minutes. suggested is what cinder advised the person
// on a person-driven change's collision (null: no advice); resolved_by is who resolved it (null: unknown or open).
export function validateCollisions(v) {
  const errors = [];
  const check = (ok, path, desc) => { if (!ok) errors.push(`${path}: expected ${desc}`); };
  const each = (key, fn) => (Array.isArray(v?.[key])
    ? v[key].forEach((x, i) => fn(x ?? {}, `${key}[${i}]`))
    : errors.push(`${key}: expected array`));
  each("feed", (x, p) => {
    for (const k of ["id", "conflict_id", "ours", "theirs", "symbol", "message", "action"]) check(str(x[k]), `${p}.${k}`, "non-empty string");
    check(["signature", "body"].includes(x.kind), `${p}.kind`, "signature or body");
    check(["low", "high"].includes(x.severity), `${p}.severity`, "low or high");
    check(typeof x.p === "number" && x.p >= 0 && x.p <= 1, `${p}.p`, "number in [0, 1]");
    check(time(x.detected_at), `${p}.detected_at`, "a timestamp");
    check(x.resolution === null || COLLISION_ACTIONS.includes(x.resolution), `${p}.resolution`, `null or one of ${COLLISION_ACTIONS.join(", ")}`);
    check(x.resolved_at === null || time(x.resolved_at), `${p}.resolved_at`, "null or a timestamp");
    const s = x.suggested;
    check(s == null || (COLLISION_ACTIONS.includes(s.action) && str(s.why) && (s.p === undefined || (typeof s.p === "number" && s.p >= 0 && s.p <= 1))),
      `${p}.suggested`, "null or {action, why, p?}");
    const r = x.resolved_by;
    check(r == null || (["human", "system"].includes(r.type) && str(r.id)), `${p}.resolved_by`, "null or {type: human or system, id}");
  });
  each("editing", (x, p) => {
    check(str(x.symbol), `${p}.symbol`, "non-empty string");
    check(str(x.change_id), `${p}.change_id`, "non-empty string");
    check(["signature", "body"].includes(x.kind), `${p}.kind`, "signature or body");
    check(time(x.at), `${p}.at`, "a timestamp");
  });
  return { ok: errors.length === 0, errors };
}
