// Everything the Change detail page shows beyond the change itself.
// Lists may be missing: a change fills them in as it moves through its stages.
import { validateReviewThread } from "./review-thread.js";

const TIMELINE_KINDS = ["event", "judge", "stage"];
const OUTCOMES = ["correct", "wrong", "pending"];
const str = (v) => typeof v === "string" && v.length > 0;

export function validateChangePage(v) {
  const errors = [];
  const need = (ok, path, desc) => { if (!ok) errors.push(`${path}: expected ${desc}`); };
  const list = (k, check) => { if (v?.[k] !== undefined) need(Array.isArray(v[k]) && v[k].every(check), k, "array of valid items"); };
  need(str(v?.id), "id", "non-empty string");
  need(str(v?.agent), "agent", "non-empty string");
  need(v?.ver === null || str(v?.ver), "ver", "non-empty string or null (person)");
  need(Array.isArray(v?.tok) && v.tok.length === 3 && v.tok.every((n) => Number.isInteger(n) && n >= 0), "tok", "[in, out, cache] integers >= 0");
  need(v?.driver === null || str(v?.driver), "driver", "non-empty string or null");
  need(str(v?.head), "head", "non-empty string");
  need(Array.isArray(v?.lease) && v.lease.length === 2 && v.lease.every(str), "lease", "[tone, text]");
  need(str(v?.intent_by), "intent_by", "non-empty string");
  const judges = v?.judges ?? {};
  need(Object.values(judges).every((j) => str(j?.name) && Number.isInteger(j.count)), "judges", "map of { name, count }");
  list("timeline", (e) => str(e?.t) && TIMELINE_KINDS.includes(e.kind) && (e.kind !== "judge" || (judges[e.judge] && OUTCOMES.includes(e.outcome))));
  list("transcript", (r) => Array.isArray(r) && r.length === 4 && r.every((x) => typeof x === "string"));
  list("provenance", (f) => str(f?.file) && Array.isArray(f.shares) && f.shares.every(([who, pct]) => str(who) && pct > 0 && pct <= 100));
  list("approvals", (a) => str(a?.who) && str(a.sha) && (a.judge === undefined || judges[a.judge]));
  list("blockers", (b) => str(b?.title) && str(b.reason) && (b.to === undefined || str(b.link)));
  list("threads", (t) => validateReviewThread(t).ok);
  if (v?.diff !== undefined) need(str(v.diff?.file) && Array.isArray(v.diff.lines) && v.diff.lines.every((l) => ["h", "c", "a", "d"].includes(l?.[0]) && l.length === 5), "diff", "{ file, lines: [kind, old, new, author, text] }");
  if (v?.conflict !== undefined) need(str(v.conflict?.where) && str(v.conflict.resolved_head) && v.conflict.sides?.length === 3 && judges.resolv, "conflict", "{ where, resolved_head, sides[3] } with a resolv judge");
  return { ok: errors.length === 0, errors };
}
