export const FINDING_SOURCES = ["dependency", "secret", "code"];
export const SEVERITIES = ["critical", "high", "medium", "low"];
export const SCAN_STATUSES = ["queued", "running", "passed", "failed"];
// POST /api/findings/:id/dismiss {reason}: the reasons it accepts.
// revoked: a secret's credential was rotated.
export const DISMISS_REASONS = ["false_positive", "risk_accepted", "wont_fix", "not_applicable", "revoked"];
export const FINDING_STATES = ["open", "dismissed", "fixed"];

const str = (v) => typeof v === "string" && v.length > 0;

// GET /api/repos/:name/watchtower[?state=all]: open (or all) findings, scan history (queued, then newest scan first), whether daily scans are
// paused, whether a scan worker is online and the count of open fix changes for dependency findings.
export function validateWatchtower(v) {
  const errors = [];
  const each = (key, ok, desc) => (Array.isArray(v?.[key])
    ? v[key].forEach((x, i) => { if (!ok(x ?? {})) errors.push(`${key}[${i}]: expected ${desc}`); })
    : errors.push(`${key}: expected array`));
  const orNull = (x, ok) => x === null || ok(x);
  each("findings", (f) => str(f.id) && FINDING_SOURCES.includes(f.source) && SEVERITIES.includes(f.severity) && str(f.title) && str(f.location) &&
    FINDING_STATES.includes(f.state) && str(f.rule) && typeof f.path === "string" && orNull(f.line, Number.isInteger) &&
    orNull(f.first_seen, (t) => !Number.isNaN(Date.parse(t))) && orNull(f.dismiss_reason, str) && orNull(f.fix_change, str),
    "{ id, source, severity, title, location, state, rule, path, line|null, first_seen|null, dismiss_reason|null, fix_change|null }");
  each("scans", (s) => str(s.id) && !Number.isNaN(Date.parse(s.ran_at)) && SCAN_STATUSES.includes(s.status) && Number.isInteger(s.findings) && s.findings >= 0,
    "{ id, ran_at, status, findings >= 0 }");
  if (typeof v?.paused !== "boolean") errors.push("paused: expected boolean");
  if (typeof v?.scan_worker_online !== "boolean") errors.push("scan_worker_online: expected boolean");
  if (!Number.isInteger(v?.fix_changes_open) || v.fix_changes_open < 0) errors.push("fix_changes_open: expected integer >= 0");
  return { ok: errors.length === 0, errors };
}
