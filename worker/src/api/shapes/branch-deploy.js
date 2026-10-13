// GET /api/repos/:name/branch-deploys: a branch and the environment a merge onto it deploys to (.cinder.yml deploy.environments).
const str = (v) => typeof v === "string" && v.length > 0;

export function validateBranchDeploy(v) {
  const errors = [];
  if (!str(v?.branch)) errors.push("branch: expected non-empty string");
  if (!str(v?.environment)) errors.push("environment: expected non-empty string");
  return { ok: errors.length === 0, errors };
}
