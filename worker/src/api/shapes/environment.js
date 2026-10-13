// GET /api/repos/:name/environments: one deploy environment's state (docs/DESIGN.md §9).
const STATUSES = ["Synced", "OutOfSync", "Progressing", "Degraded", "Failed"];
const str = (v) => typeof v === "string" && v.length > 0;
const step = (v) => v === null || (Number.isInteger(v) && v > 0 && v <= 100);

export function validateEnvironment(v) {
  const errors = [];
  const need = (ok, k, desc) => { if (!ok) errors.push(`${k}: expected ${desc}`); };
  need(str(v?.name), "name", "non-empty string");
  need(v?.branch === null || str(v?.branch), "branch", "non-empty string or null");
  need(v?.branch_missing == null || typeof v.branch_missing === "boolean", "branch_missing", "true when the branch doesn't exist");
  need(v?.desired_sha === null || str(v?.desired_sha), "desired_sha", "null or the branch head sha");
  need(v?.status === null || STATUSES.includes(v?.status), "status", `null or one of ${STATUSES.join(", ")}`);
  need(v?.live_version === null || (str(v?.live_version?.version_id) && str(v.live_version.sha)), "live_version", "null or { version_id, sha }");
  need(step(v?.step), "step", "null or integer percentage");
  need(Array.isArray(v?.drift) && v.drift.every((r) => str(r?.type) && str(r?.name)), "drift", "list of { type, name }");
  need(Array.isArray(v?.history), "history", "list");
  need(v?.release == null || str(v.release), "release", "null or the tag of the release last promoted here");
  need(v?.target == null || str(v.target), "target", "null or the target cloud");
  need(v?.console == null || (str(v.console) && v.console.startsWith("https://")), "console", "null or the https URL of its Worker Deployments tab or provider console");
  need(v?.host == null || str(v.host), "host", "null or the host an SSH target deploys to");
  need(v?.gate == null || str(v.gate), "gate", "null or the gate before a deploy");
  need(v?.deployed_at == null || str(v.deployed_at), "deployed_at", "null or when it was last deployed or promoted");
  need(v?.pending == null || (Array.isArray(v.pending) && v.pending.every((p) => str(p?.need) && str(p?.release) && str(p?.gate)
    && Array.isArray(p?.approvers) && p.approvers.every(str) && (p.at == null || str(p.at))
    && (p.can_resolve == null || typeof p.can_resolve === "boolean"))), "pending", "list of open release approvals { need, release, gate, approvers, at, can_resolve }");
  need(Number.isInteger(v?.secrets) && v.secrets >= 0, "secrets", "integer >= 0: Keystore secrets scoped to the environment");
  need(v?.previous == null || str(v.previous), "previous", "null or the tag of the release a rollback would restore");
  (Array.isArray(v?.history) ? v.history : []).forEach((s, i) => {
    need(STATUSES.includes(s?.status) && str(s?.sha) && str(s?.actor) && str(s?.started_at) && str(s?.at)
      && (s.version_id === null || str(s.version_id)) && step(s.step) && Array.isArray(s.changes)
      && (s.run === null || str(s.run)) && (s.reason == null || str(s.reason)), `history[${i}]`, "a sync record");
  });
  return { ok: errors.length === 0, errors };
}
