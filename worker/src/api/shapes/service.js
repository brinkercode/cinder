import { FLOW_NAME, parseFlow, validateFlow } from "./flow.js";

// GET /api/repos/:name/services returns {ref, sha, services: [these]}: a deployable unit found in the repo's tree, the
// Cloudflare resources cinder suggests for it (never created) and a dry-run flow. `id` is `<kind>:<path>`, `.` the root.
export const SERVICE_KINDS = ["worker", "container", "terraform"];
const str = (v) => typeof v === "string" && v.length > 0;

export function validateService(v) {
  const errors = [];
  const need = (ok, k, desc) => { if (!ok) errors.push(`${k}: expected ${desc}`); };
  need(SERVICE_KINDS.includes(v?.kind), "kind", SERVICE_KINDS.join(", "));
  need(str(v?.path), "path", "the service's directory, . for the root");
  need(v?.id === `${v?.kind}:${v?.path}`, "id", "<kind>:<path>");
  need(str(v?.name), "name", "non-empty string");
  need(Array.isArray(v?.resources) && v.resources.every((r) => str(r?.type) && str(r?.name)), "resources", "list of { type, name }");
  need(FLOW_NAME.test(v?.flow?.name ?? "") && str(v?.flow?.yaml) && validateFlow(parseFlow(v.flow.yaml)).ok, "flow", "{ name, yaml } of a valid flow");
  return { ok: errors.length === 0, errors };
}
