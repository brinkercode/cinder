// GET /api/repos/:name/environments/:env/tree: the environment's script, live version, and each binding with its resource and drift flag.
const str = (v) => typeof v === "string" && v.length > 0;

export function validateEnvironmentTree(v) {
  const errors = [];
  const need = (ok, k, desc) => { if (!ok) errors.push(`${k}: expected ${desc}`); };
  need(v?.script === null || str(v?.script), "script", "null or the Worker script name");
  need(v?.live_version === null || (str(v?.live_version?.version_id) && str(v.live_version.sha)), "live_version", "null or { version_id, sha }");
  need(Array.isArray(v?.bindings) && v.bindings.every((b) => (b?.binding === null || str(b?.binding)) && str(b?.type) && str(b?.resource)
    && typeof b?.drift === "boolean"), "bindings", "list of { binding, type, resource, drift }");
  return { ok: errors.length === 0, errors };
}
