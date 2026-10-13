import { createArtifacts } from "./artifacts.js";
import { diffFiles } from "./code.js";
import { error } from "./router.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));

// A commit message's trailers: its last paragraph, when every line of it is `Key: value` (git's rule).
function trailers(message = "") {
  const paragraphs = message.trim().split(/\n\s*\n/);
  // The only paragraph is the subject, never trailers.
  if (paragraphs.length < 2) return [];
  const pairs = paragraphs.at(-1).split("\n").map((l) => /^([A-Za-z0-9-]+):\s*(.+)$/.exec(l.trim()));
  if (pairs.some((m) => !m)) return [];
  return pairs.map(([, key, value]) => ({ key, value }));
}

// GET /api/changes/:id/commits → [ChangeCommit], newest first: the fork's commits not on the target branch.
export async function listCommits(request, env, { id }) {
  const change = await changeDO(env, id).get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const name = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first("name");
  const artifacts = createArtifacts(env.ARTIFACTS);
  const base = new Set((await artifacts.log(name, change.target_branch)).map((c) => c.sha));
  const commits = (await changeLog(artifacts, name, change)).filter((c) => !base.has(c.sha));
  return Response.json(commits.map(({ sha, message = "", author = null }) => ({ sha, message, author, trailers: trailers(message) })));
}

// GET /api/changes/:id/files → CommitDiff files: the fork's head (the commits /commits lists) against the newest commit it
// shares with the target branch. No commits of its own, no files.
export async function listFiles(request, env, { id }) {
  const change = await changeDO(env, id).get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const name = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first("name");
  return Response.json(await changeFiles(createArtifacts(env.ARTIFACTS), name, change));
}

// The change's history, newest first: its fork's branch, or once merged (the fork is deleted) its head in repo name,
// which the merge brought in. Its own commits are the ones not on the target's log (Artifacts logs first parents only).
async function changeLog(artifacts, name, change) {
  if (change.state !== "merged") return artifacts.log(change.fork, change.head_branch ?? change.target_branch);
  return change.head ? artifacts.log(name, change.head) : [];
}

// The change's files as listFiles returns them; name is its repo.
export async function changeFiles(artifacts, name, change) {
  const base = new Set((await artifacts.log(name, change.target_branch)).map((c) => c.sha));
  const log = await changeLog(artifacts, name, change);
  if (!log.length || base.has(log[0].sha)) return [];
  const store = change.state === "merged" ? name : change.fork;
  return diffFiles(artifacts, store, log.find((c) => base.has(c.sha))?.sha ?? null, log[0].sha);
}

// GET /api/changes/:id/checks → [ChangeCheck] for the change's head: verify stages, guard and SARIF findings.
export async function listChecks(request, env, { id }) {
  const stub = changeDO(env, id);
  const change = await stub.get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const sha = await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(id).first("head_sha");
  if (!sha) return Response.json([]);
  const checks = [];
  // lazy: stage records and the guard result carry no sha; a new head cancels running jobs, so they're shown against the head.
  for (const s of (await stub.stages()).filter((r) => r.stage === "verify")) {
    checks.push({ kind: "verify", name: s.agent_version, status: s.verdict ?? "pending", sha, duration_ms: s.duration_ms, log_url: null });
  }
  if (change.guard) checks.push({ kind: "guard", name: "guard", status: change.guard.status === "clear" ? "pass" : "fail", sha, duration_ms: null, log_url: null });
  const { results } = await env.DB.prepare("SELECT rule, state FROM findings WHERE repo_id = ? AND source = 'code' AND last_sha = ?").bind(change.repo_id, sha).all();
  for (const f of results) checks.push({ kind: "sarif", name: f.rule, status: f.state === "open" ? "fail" : "pass", sha, duration_ms: null, log_url: null });
  // A test failing at the head while quarantined is marked, as its failure no longer fails verify.
  const quarantined = await env.DB.prepare("SELECT q.test, q.flake_rate, q.since FROM test_runs t JOIN test_quarantine q ON q.repo = t.repo AND q.test = t.test " +
    "WHERE t.repo = ? AND t.sha = ? AND t.status = 'fail' AND q.released_at IS NULL ORDER BY q.test").bind(change.repo_id, sha).all();
  // A flow run of the head (one per flow, the latest) is a check, as is the failed run of a flow that doesn't validate.
  const runs = await env.DB.prepare("SELECT flow, status FROM flow_runs WHERE change_id = ? AND sha = ? ORDER BY rowid").bind(id, sha).all();
  for (const [flow, status] of new Map(runs.results.map((r) => [r.flow, r.status]))) {
    checks.push({ kind: "flow", name: flow, status: { passed: "pass", failed: "fail" }[status] ?? "pending", sha, duration_ms: null, log_url: null });
  }
  for (const q of quarantined.results) checks.push({ kind: "test", name: q.test, status: "quarantined", flake_rate: q.flake_rate, since: q.since, sha, duration_ms: null, log_url: null });
  return Response.json(checks);
}
