import { createArtifacts } from "./artifacts.js";
import { error, holdsJob } from "./router.js";

const MAX_FILES = 200;
const MAX_LINES = 5000;

// GET /api/repos/:name/compare?base&head → Compare (api/shapes/compare.js): 200 once the compare job for the sha pair
// reported, 202 (diff null) once it is queued.
export async function getCompare(request, env, { name }) {
  const url = new URL(request.url);
  const base = url.searchParams.get("base");
  const head = url.searchParams.get("head");
  if (!base || !head) return error(400, "bad_request", "base and head query parameters are required");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const artifacts = createArtifacts(env.ARTIFACTS);
  const [baseSha, headSha] = await Promise.all([base, head].map(async (ref) => (await artifacts.log(name, ref))[0]?.sha));
  if (!baseSha || !headSha) return error(404, "not_found", `unknown ref ${baseSha ? head : base}`);
  const at = { base, head, base_sha: baseSha, head_sha: headSha };
  const row = await env.DB.prepare("SELECT result FROM compares WHERE repo_id = ? AND base_sha = ? AND head_sha = ?").bind(repo.id, baseSha, headSha).first();
  if (row) return Response.json({ ...at, diff: JSON.parse(row.result) });
  const payload = JSON.stringify({ store: name, base: baseSha, head: headSha });
  await env.DB.prepare(
    "INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) SELECT ?1, ?2, 'compare', 'queued', ?3, ?4 " +
    "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE repo_id = ?2 AND kind = 'compare' AND status IN ('queued', 'claimed') AND payload = ?4)",
  ).bind(crypto.randomUUID(), repo.id, new Date().toISOString(), payload).run();
  return Response.json({ ...at, diff: null }, { status: 202 });
}

// Runner route: the compare job's result for :base...:head, {ahead, behind, commits: [{sha, message}],
// files: [{path, status, additions, deletions, patch}]}. Files past 200 or 5k changed lines are dropped; stats keep the full counts.
export async function putCompare(request, env, { name, base, head }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  if (!(await holdsJob(request, env, repo.id, "compare"))) return error(403, "forbidden", `this runner holds no compare job of ${name}`);
  const b = await request.json().catch(() => null);
  const count = (n) => Number.isInteger(n) && n >= 0;
  const ok = count(b?.ahead) && count(b?.behind)
    && Array.isArray(b.commits) && b.commits.every((c) => typeof c?.sha === "string" && c.sha && typeof c.message === "string")
    && Array.isArray(b.files) && b.files.every((f) => typeof f?.path === "string" && f.path && typeof f.status === "string"
      && count(f.additions) && count(f.deletions) && typeof f.patch === "string");
  if (!ok) return error(400, "bad_request", "body: expected {ahead, behind, commits: [{sha, message}], files: [{path, status, additions, deletions, patch}]}");
  const stats = { files_changed: b.files.length, additions: 0, deletions: 0 };
  const files = [];
  for (const f of b.files) {
    stats.additions += f.additions;
    stats.deletions += f.deletions;
    if (files.length < MAX_FILES && stats.additions + stats.deletions <= MAX_LINES) files.push(f);
  }
  const result = { ahead: b.ahead, behind: b.behind, commits: b.commits, files, truncated: files.length < b.files.length, stats };
  await env.DB.prepare("INSERT OR REPLACE INTO compares VALUES (?, ?, ?, ?)").bind(repo.id, base, head, JSON.stringify(result)).run();
  return new Response(null, { status: 204 });
}
