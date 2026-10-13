// The per-branch policy the Repo setup page edits.
const str = (v) => typeof v === "string" && v.length > 0;
const int = (v, min, max) => Number.isInteger(v) && v >= min && v <= max;

export function validateRepoPolicy(v) {
  const errors = [];
  const need = (ok, path, desc) => { if (!ok) errors.push(`${path}: expected ${desc}`); };
  need(str(v?.repo_id), "repo_id", "non-empty string");
  need(int(v?.version, 1, Infinity), "version", "integer >= 1");
  need(Array.isArray(v?.branches) && v.branches.every((b) => str(b?.branch) && typeof b.queue === "boolean"
    && int(b.judges, 1, 4) && int(b.risk, 1, 50) && typeof b.route === "string"), "branches",
  "array of { branch, queue, judges 1-4, risk 1-50, route }");
  return { ok: errors.length === 0, errors };
}
