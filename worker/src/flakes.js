import { judge } from "./judgments.js";
import { raiseNeeds } from "./needs.js";
import { error } from "./router.js";

// A run is one sha; it is a flake when an attempt failed and a later attempt passed. Rate is over the last 50 runs.
// quarantined, quarantined_since and quarantined_by are set while the test is held out of the verdict. With ?sha=, result is the
// test's latest status at that sha (null when it didn't run there).
// lazy: rowid stands in for run order (rows are append-only); add a run timestamp once ingestion records one.
export async function listFlakes(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const sha = new URL(request.url).searchParams.get("sha");
  const results = await flakeRates(env.DB, repo.id);
  const held = new Map((await env.DB.prepare("SELECT test, since FROM test_quarantine WHERE repo = ? AND released_at IS NULL").bind(repo.id).all())
    .results.map((q) => [q.test, q.since]));
  const ran = sha && new Map((await env.DB.prepare("SELECT test, status FROM test_runs WHERE repo = ? AND sha = ?").bind(repo.id, sha).all())
    .results.map((t) => [t.test, t.status]));
  return Response.json(results.map((r) => ({ ...r, rate: r.flakes / r.runs, quarantined: held.has(r.test),
    // Only the verifier quarantines a test (quarantineFailures).
    quarantined_since: held.get(r.test) ?? null, quarantined_by: held.has(r.test) ? "verifier" : null, ...(ran && { result: ran.get(r.test) ?? null }) })));
}

async function flakeRates(db, repo) {
  const { results } = await db.prepare(
    "WITH runs AS (SELECT test, MAX(rowid) AS last, " +
    "MIN(CASE WHEN status = 'fail' THEN attempt END) < MAX(CASE WHEN status = 'pass' THEN attempt END) AS flaky " +
    "FROM test_results WHERE repo = ?1 GROUP BY test, sha), " +
    "recent AS (SELECT test, flaky, ROW_NUMBER() OVER (PARTITION BY test ORDER BY last DESC) AS n FROM runs) " +
    "SELECT test, COUNT(*) AS runs, COUNT(CASE WHEN flaky THEN 1 END) AS flakes FROM recent WHERE n <= 50 GROUP BY test ORDER BY test",
  ).bind(repo).all();
  return results;
}

// Quarantines the verify job's failing tests whose flake rate is at or above the repo's threshold (unless the repo turned
// auto-quarantine off), raising one Test quarantined need per newly quarantined test, and returns the failing tests
// classifyFailure calls flaky.
export async function quarantineFailures(env, job, tests) {
  const failing = tests.filter((t) => t.status === "fail").map((t) => t.test);
  if (!failing.length) return [];
  const threshold = (await env.DB.prepare("SELECT flake_quarantine FROM repo_settings WHERE repo = ?").bind(job.repo_id).first("flake_quarantine")) ?? 0.2;
  const off = await env.DB.prepare("SELECT 1 FROM quarantine_off WHERE repo = ?").bind(job.repo_id).first();
  const over = off ? [] : (await flakeRates(env.DB, job.repo_id)).filter((r) => failing.includes(r.test) && r.flakes / r.runs >= threshold);
  const since = new Date().toISOString();
  const added = over.length ? (await env.DB.batch(over.map((r) => env.DB.prepare(
    "INSERT OR IGNORE INTO test_quarantine (repo, test, flake_rate, since) VALUES (?, ?, ?, ?) RETURNING test",
  ).bind(job.repo_id, r.test, r.flakes / r.runs, since)))).flatMap((r) => r.results) : [];
  await raiseNeeds(env.DB, job.repo_id, added.map(({ test }) => ({ kind: "Test quarantined", change: job.change_id,
    text: `${test} is quarantined: its failures no longer fail verify`, actions: ["Release", "Keep"], subject: { test } })));
  const { results } = await env.DB.prepare("SELECT test FROM test_quarantine WHERE repo = ? AND released_at IS NULL AND test IN (SELECT value FROM json_each(?))")
    .bind(job.repo_id, JSON.stringify(failing)).all();
  const flaky = [];
  for (const { test } of results) if ((await classifyFailure(env, job.repo_id, { test, quarantined: true })).kind === "flaky") flaky.push(test);
  // The other failures are asked in shadow: the answer doesn't act yet, but the rerun scores it, so the judge earns trust.
  // ponytail: at most 5 asked per run, so a broken suite costs 5 calls; raise it once judge calls are batched.
  for (const t of tests.filter((t) => t.status === "fail" && !flaky.includes(t.test) && !results.some((r) => r.test === t.test)).slice(0, 5)) {
    await classifyFailure(env, job.repo_id, t, job.change_id);
  }
  return flaky;
}

// A rerun on the same sha (attempt 2 on) settles the failures the earlier attempt was judged on: a test that passes now
// was flaky, one that fails again is code. job is the verify job the tests were reported on.
export async function scoreFlakes(db, change, job, tests) {
  if (!((await db.prepare("SELECT attempt FROM verify_runs WHERE job = ?").bind(job).first("attempt")) > 1)) return;
  const at = new Date().toISOString();
  const settled = tests.filter((t) => t.status === "pass" || t.status === "fail");
  if (settled.length) await db.batch(settled.map((t) => db.prepare(
    "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT id, ?3, answer = ?3, ?4 FROM judgments " +
    "WHERE change_id = ?1 AND kind = 'flake' AND question = ?2 AND id NOT IN (SELECT judgment_id FROM outcomes)",
  ).bind(change, flakeQuestion(t.test), t.status === "pass" ? "flaky" : "code", at)));
}

// GET /api/repos/:name/quarantine → [{test, flake_rate, since}]: the repo's quarantined tests.
export async function listQuarantine(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const { results } = await env.DB.prepare("SELECT test, flake_rate, since FROM test_quarantine WHERE repo = ? AND released_at IS NULL ORDER BY test")
    .bind(repo.id).all();
  return Response.json(results);
}

// DELETE /api/repos/:name/quarantine/:test and POST /api/repos/:name/flakes/:test/release (test URL-encoded) → 204:
// the test's failures count in the verdict again from the next run.
export async function releaseQuarantine(request, env, { name, test }) {
  try {
    test = decodeURIComponent(test);
  } catch {
    return error(400, "bad_request", "test must be URL-encoded");
  }
  const { meta } = await env.DB.prepare("UPDATE test_quarantine SET released_at = ? WHERE repo = (SELECT id FROM repos WHERE name = ?) AND test = ? AND released_at IS NULL")
    .bind(new Date().toISOString(), name, test).run();
  return meta.changes ? new Response(null, { status: 204 }) : error(404, "not_found", `${test} is not quarantined in ${name}`);
}

const ACTIONS = { infra: "requeue", flaky: "rerun", code: "needs_fix" };
// The question names the test, so a rerun's result can score the judgment made on its failure (scoreFlakes).
export const flakeQuestion = (test) => `Is this failure of ${test} infra, flaky or code?`;
const FAILURE = { kind: "choice", options: ["infra", "flaky", "code"],
  guide: "The state is one failed test run: the test, the attempt number and its output, after the deterministic signals (runner error, " +
    "timeout, failing on the target, quarantine) were inconclusive. Decide from the test's name and output.",
  criteria: {
    infra: "The runner or environment failed, not the code: network, DNS, a package registry, out of memory or disk, a container that didn't start, a killed process.",
    flaky: "The test depends on timing, ordering, randomness or shared state, and can pass on a rerun without a code change.",
    code: "The change broke it: a deterministic assertion, a compile or type error, or a failure the diff explains.",
  } };

// failure: { test, attempt (1-based), runner_error, timeout, fails_on_target, quarantined, ... }; the whole object is
// System 1's state. Deterministic signals decide first; System 1 (kind flake) only breaks ties, and an untrusted
// answer falls back to code. A flaky failure reruns once; failing again on the rerun needs a fix.
export async function classifyFailure(env, repo, failure, change) {
  let kind = failure.runner_error || failure.timeout || failure.fails_on_target ? "infra" : failure.quarantined ? "flaky" : null;
  if (!kind) {
    const { answer, trusted } = (await judge(env, repo, "flake", failure, { failure: { ...FAILURE, prompt: flakeQuestion(failure.test) } }, change)).failure;
    kind = trusted && Object.hasOwn(ACTIONS, answer) ? answer : "code";
  }
  return { kind, action: kind === "flaky" && failure.attempt > 1 ? "needs_fix" : ACTIONS[kind] };
}
