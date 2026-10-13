// A change's deploy_plan (GET /api/changes/:id, docs/DESIGN.md §9): what merging it does to each environment.
// `destructive` is why it needs a person (a prune or a DROP), or null.
const str = (v) => typeof v === "string" && v.length > 0;

export function validateDeployPlan(v) {
  const errors = [];
  const need = (ok, k, desc) => { if (!ok) errors.push(`${k}: expected ${desc}`); };
  need(v?.destructive === null || str(v?.destructive), "destructive", "non-empty string or null");
  need(Array.isArray(v?.environments) && v.environments.every((e) => str(e?.name) && Array.isArray(e.steps) && e.steps.every(str)),
    "environments", "list of { name, steps: [string] }");
  return { ok: errors.length === 0, errors };
}
