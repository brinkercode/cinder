import { error, holdsJob, runnerOf } from "./router.js";

const MAX_BYTES = 1 << 20;

// POST /api/repos/:name/sarif?sha= (owner, or a runner holding a live job of the repo) → 202 {job}: queues an ingest-sarif job carrying the SARIF log; the
// runner parses it (runner/internal/verify/sarif.go) and its report lands in the findings store as source code.
export async function uploadSarif(request, env, { name }) {
  const sha = new URL(request.url).searchParams.get("sha");
  if (!sha) return error(400, "bad_request", "sha query parameter is required");
  // Content-Length can be absent or wrong, so the bytes read are checked too.
  if (Number(request.headers.get("Content-Length")) > MAX_BYTES) return error(413, "too_large", "SARIF upload is over 1 MiB");
  const sarif = await request.text();
  if (new TextEncoder().encode(sarif).length > MAX_BYTES) return error(413, "too_large", "SARIF upload is over 1 MiB");
  let log = null;
  try { log = JSON.parse(sarif); } catch { /* reported below */ }
  if (!Array.isArray(log?.runs)) return error(400, "bad_request", "body must be a SARIF log with runs");
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  if ((await runnerOf(request, env)) && !(await holdsJob(request, env, repo.id))) return error(403, "forbidden", `this runner holds no job of ${name}`);
  const id = crypto.randomUUID();
  await env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'ingest-sarif', NULL, 'queued', ?, ?)")
    .bind(id, repo.id, new Date().toISOString(), JSON.stringify({ sha, target: repo.default_branch, sarif })).run();
  return Response.json({ job: id }, { status: 202 });
}
