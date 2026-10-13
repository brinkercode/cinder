import { DONE_STATES } from "./api/contract.js";
import { createArtifacts } from "./artifacts.js";
import { BRANCH } from "./commits.js";
import { setBranch } from "./git/index.js";
import { error } from "./router.js";

// GET /api/repos/:name/branches → [Branch] (api/shapes/branch.js): every branch, then every tag, as git advertises them.
// The refs, their commit data and roles come from the repo's Durable Object, cached per refs epoch (RepoDO.branches);
// only open_changes is read per request. Server-Timing: repo lookup, refs (the Durable Object), open counts.
export async function listBranches(request, env, { name }) {
  const ms = {};
  const lap = (key, p) => {
    const start = performance.now();
    return p.finally(() => { ms[key] = performance.now() - start; });
  };
  const repo = await lap("repo", env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first());
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const [heads, { results: open }] = await Promise.all([
    lap("refs", env.REPO_DO.get(env.REPO_DO.idFromName(name)).branches(name, repo.default_branch)),
    lap("open", env.DB.prepare(`SELECT target_branch, COUNT(*) AS n FROM changes
    WHERE repo_id = ? AND state NOT IN (SELECT value FROM json_each(?)) GROUP BY target_branch`).bind(repo.id, JSON.stringify(DONE_STATES)).all()),
  ]);
  if (!heads) return error(404, "not_found", `no repo ${name}`);
  const timing = Object.entries(ms).map(([k, d]) => `${k};dur=${d.toFixed(1)}`).join(", ");
  return Response.json(heads.map((b) => ({ ...b, open_changes: open.find((o) => o.target_branch === b.name)?.n ?? 0 })),
    { headers: { "Server-Timing": timing } });
}

// Each ref's Branch fields read from git: default, head_sha, ahead/behind the default branch and last_commit.
// lazy: ahead/behind compare whole logs as the binding returns them; ask a runner for rev-list counts if logs get paged.
export async function branchHeads(env, name, defaultBranch, refs) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  const base = await artifacts.log(name, defaultBranch);
  const baseShas = new Set(base.map((c) => c.sha));
  return Promise.all(refs.map(async ({ name: ref, kind, sha }) => {
    const log = await artifacts.log(name, sha);
    const shas = new Set(log.map((c) => c.sha));
    const last = log[0];
    return {
      name: ref, kind, default: kind === "branch" && ref === defaultBranch, head_sha: sha,
      ahead: log.filter((c) => !baseShas.has(c.sha)).length, behind: base.filter((c) => !shas.has(c.sha)).length,
      last_commit: last ? { sha: last.sha, message: last.message ?? "", author: last.author ?? null } : null,
    };
  }));
}

// Creates (from: a branch name) or deletes (from: null) branch on the repo's remote, then keeps repo_refs in step so the
// list shows it before the next refs job reports. 409 when the remote refuses (see setBranch).
async function writeBranch(env, repo, name, branch, from) {
  const cap = await createArtifacts(env.ARTIFACTS).get(name);
  if (!cap) return error(404, "not_found", `no repo ${name}`);
  try {
    await setBranch(cap, branch, from);
  } catch (e) {
    if (e.code === "conflict") return error(409, "conflict", e.message);
    throw e;
  }
  await env.DB.prepare(from ? "INSERT OR IGNORE INTO repo_refs (repo_id, name) VALUES (?, ?)" : "DELETE FROM repo_refs WHERE repo_id = ? AND name = ?")
    .bind(repo.id, branch).run();
  return from ? Response.json({ name: branch }, { status: 201 }) : new Response(null, { status: 204 });
}

// POST /api/repos/:name/branches {name, from?} → 201 {name}: a new branch at from's head (default: the default branch).
export async function createBranch(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const { name: branch, from = repo.default_branch } = (await request.json().catch(() => null)) ?? {};
  for (const b of [branch, from]) if (typeof b !== "string" || !BRANCH.test(b) || b.includes("..")) return error(400, "bad_request", "name and from must be valid branch names");
  return writeBranch(env, repo, name, branch, from);
}

// DELETE /api/repos/:name/branches/:branch (URL-encoded) → 204. The default branch can't be deleted.
export async function deleteBranch(request, env, { name, branch }) {
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  // Only "/" needs encoding in a valid name; any other escape fails the name check below instead of throwing.
  branch = branch.replace(/%2F/gi, "/");
  if (branch === repo.default_branch) return error(409, "conflict", "the default branch can't be deleted");
  if (!BRANCH.test(branch) || branch.includes("..")) return error(400, "bad_request", "branch must be a valid branch name");
  return writeBranch(env, repo, name, branch, null);
}
