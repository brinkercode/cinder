import { CHANGE_STATES } from "../contract.js";

export const LEASE_MODES = ["exclusive", "shared", "seam"];

const str = (v) => typeof v === "string" && v.length > 0;
const count = (v) => Number.isInteger(v) && v >= 0;

// GET /api/repos/:name/lease-map returns this: the changes holding leases, their leases, the predicted
// collisions between them (edges) and the repo's conflict rate. Every id it names is one of `changes`.
export function validateLeaseMap(v) {
  const errors = [];
  const check = (ok, path, desc) => { if (!ok) errors.push(`${path}: expected ${desc}`); };
  const each = (key, fn) => (Array.isArray(v?.[key])
    ? v[key].forEach((x, i) => fn(x ?? {}, `${key}[${i}]`))
    : errors.push(`${key}: expected array`));
  const ids = new Set(Array.isArray(v?.changes) ? v.changes.map((c) => c?.id) : []);
  const known = (id, path) => check(ids.has(id), path, "id of a listed change");

  const c = v?.conflicts;
  check(count(c?.merges), "conflicts.merges", "integer >= 0");
  check(count(c?.conflicted) && c.conflicted <= c.merges, "conflicts.conflicted", "integer in [0, merges]");
  check(count(c?.days) && c.days > 0, "conflicts.days", "integer >= 1");
  each("changes", (x, p) => {
    check(str(x.id), `${p}.id`, "non-empty string");
    check(x.key == null || str(x.key), `${p}.key`, "the change's repo key (PULSE-6), when it has one");
    check(CHANGE_STATES.includes(x.state), `${p}.state`, "a change state");
    check(str(x.intent), `${p}.intent`, "non-empty string");
    check(typeof x.seam === "boolean", `${p}.seam`, "boolean");
    if (x.stacked_on !== null) known(x.stacked_on, `${p}.stacked_on`);
  });
  each("leases", (x, p) => {
    check(str(x.symbol), `${p}.symbol`, "non-empty string");
    check(str(x.file), `${p}.file`, "non-empty string");
    known(x.holder, `${p}.holder`);
    check(LEASE_MODES.includes(x.mode), `${p}.mode`, `one of ${LEASE_MODES.join(", ")}`);
    check(x.expires_at === undefined || (str(x.expires_at) && !Number.isNaN(Date.parse(x.expires_at))), `${p}.expires_at`, "ISO time when set");
    if (Array.isArray(x.waiting)) x.waiting.forEach((w, i) => known(w, `${p}.waiting[${i}]`));
    else errors.push(`${p}.waiting: expected array`);
  });
  each("edges", (x, p) => {
    known(x.a, `${p}.a`);
    known(x.b, `${p}.b`);
    check(typeof x.p === "number" && x.p >= 0 && x.p <= 1, `${p}.p`, "number in [0, 1]");
    if (x.calibrated !== undefined) check(typeof x.calibrated === "number" && x.calibrated >= 0 && x.calibrated <= 1, `${p}.calibrated`, "number in [0, 1]");
    check(str(x.judge?.name) && count(x.judge?.count) && typeof x.judge?.trusted === "boolean", `${p}.judge`, "{ name, count, trusted }");
  });
  return { ok: errors.length === 0, errors };
}
