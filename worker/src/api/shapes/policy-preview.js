import { validateBranchPolicy } from "../contract.js";

// GET /api/repos/:name/policy/preview?strategy= returns one of these: the policy a strategy switch would produce,
// with one rule per integration branch, and the branch keys it changes.
export function validatePolicyPreview(v) {
  const errors = [...validateBranchPolicy(v?.policy).errors.map((e) => `policy.${e}`)];
  const str = (x) => typeof x === "string" && x.length > 0;
  const strs = (x) => Array.isArray(x) && x.every(str);
  const int = (x, min, max) => Number.isInteger(x) && x >= min && x <= max;
  const rules = v?.policy?.rules;
  if (!Array.isArray(rules) || !rules.every((r) => str(r?.branch) && typeof r.queue === "boolean" && int(r.judges, 1, 4) && int(r.risk, 1, 50) && strs(r.route))) {
    errors.push("policy.rules: expected array of { branch, queue, judges 1-4, risk 1-50, route: string[] }");
  }
  if (!Array.isArray(v?.changes) || !v.changes.every((c) => ["integration", "release"].includes(c?.key) && strs(c.from) && strs(c.to))) {
    errors.push("changes: expected array of { key: integration|release, from: string[], to: string[] }");
  }
  return { ok: errors.length === 0, errors };
}
