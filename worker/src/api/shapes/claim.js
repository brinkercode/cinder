import { validateChange, validateJob } from "../contract.js";

// POST /api/work/claim: the job, its kind-specific payload, its change (null for repo jobs), the Artifacts tokens
// already minted for it, the git remotes of the change's fork and target, and the release lock of the agent version
// it runs as (null when none resolves). runner/internal/api decodes the same shape.
// default_agent names the defaults an agent job runs with when no version resolves (agent null), null otherwise.
// egress is the runner's pool egress, which cinder-verify's proxy applies to flow steps.
export function validateClaim(v) {
  const errors = [];
  const nested = (name, r) => errors.push(...r.errors.map((e) => `${name}.${e}`));
  nested("job", validateJob(v?.job));
  if (v?.change !== null) nested("change", validateChange(v?.change));
  if (typeof v?.payload !== "object" || v.payload === null || Array.isArray(v.payload)) errors.push("payload: expected object");
  for (const k of ["token", "read_token", "fork_remote", "target_remote", "default_agent"]) {
    if (!(v?.[k] === null || (typeof v?.[k] === "string" && v[k].length > 0))) errors.push(`${k}: expected non-empty string or null`);
  }
  const a = v?.agent;
  const strs = (l) => Array.isArray(l) && l.every((s) => typeof s === "string" && s);
  if (!(a === null || (typeof a?.agent === "string" && a.agent && Number.isInteger(a.version) && a.version >= 1 &&
    typeof a.harness === "string" && a.harness && typeof a.model === "string" && a.model && strs(a.egress) && ["enforce", "audit"].includes(a.egress_mode) && !("secrets" in a)))) {
    errors.push("agent: expected {agent, version, harness, model, egress, egress_mode: enforce|audit} with no secrets, or null");
  }
  if (!(["allowlist", "none", "open"].includes(v?.egress?.mode) && strs(v.egress.allow))) errors.push("egress: expected {mode: allowlist|none|open, allow: host patterns}");
  if (v?.change && !v.fork_remote) errors.push("fork_remote: required for a change-bound job");
  return { ok: errors.length === 0, errors };
}
