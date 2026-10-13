import { validateLogCommit } from "../../../worker/src/api/contract.js";
import { validateTag } from "../../../worker/src/api/shapes.js";
import { checked, fetchJson, fixtures } from "../client.js";

// GET /api/repos/:name/resolve?sha → the one commit in the repo whose sha starts with sha. Fixture mode has no commits.
export async function resolveSha(repo, sha) {
  if (fixtures()) throw Object.assign(new Error(`No commit ${sha}`), { status: 404 });
  const path = `/api/repos/${encodeURIComponent(repo)}/resolve?sha=${encodeURIComponent(sha)}`;
  const body = await fetchJson(path);
  const { ok, errors } = validateLogCommit(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// GET /api/repos/:name/tags?limit=1 → the newest tag, or null when the repo has none (fixture mode has none).
export async function latestTag(repo) {
  if (fixtures()) return null;
  const path = `/api/repos/${encodeURIComponent(repo)}/tags?limit=1`;
  return checked(path, await fetchJson(path), validateTag)[0] ?? null;
}
