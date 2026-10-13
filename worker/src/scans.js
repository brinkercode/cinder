import { fixFinding, recordScan } from "./findings.js";
import { FINDING_SOURCES, SEVERITIES } from "./api/contract.js";
import { clearNeeds, raiseNeeds } from "./needs.js";
import { checkVulns } from "./osv.js";
import { error } from "./router.js";
import { OFFLINE_MS } from "./runners.js";

const DAY_MS = 86_400_000;

// Queues a full scan of target unless one is already queued: a burst of merges is one scan of the head at claim time.
// A claimed scan doesn't hold the next one back; one whose lease ran out (it crashed) fails here, with its scans row.
export async function queueScan(env, repoId, target, source) {
  const now = new Date().toISOString();
  const expired = "SELECT id FROM jobs WHERE repo_id = ?1 AND kind = 'scan' AND status = 'claimed' AND lease_expires_at <= ?2";
  await env.DB.batch([
    // Also a scan whose job ended without a report (a cancelled one).
    env.DB.prepare("UPDATE scans SET status = 'failed', finished_at = ?2 WHERE status = 'running' AND job_id IN " +
      "(SELECT id FROM jobs WHERE repo_id = ?1 AND kind = 'scan' AND (status <> 'claimed' OR lease_expires_at <= ?2))").bind(repoId, now),
    env.DB.prepare(`UPDATE jobs SET status = 'failed' WHERE id IN (${expired})`).bind(repoId, now),
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) SELECT ?1, ?2, 'scan', 'queued', ?3, ?4 WHERE NOT EXISTS " +
      "(SELECT 1 FROM jobs WHERE repo_id = ?2 AND kind = 'scan' AND status = 'queued' AND json_extract(payload, '$.target') = ?5 " +
      // A cancelled job stays queued but is never claimed, so it covers nothing.
      "AND id NOT IN (SELECT job_id FROM job_cancels))")
      .bind(crypto.randomUUID(), repoId, now, JSON.stringify({ target, source }), target),
  ]);
}

// Cron: each repo's default branch is scanned at least daily; a scan queued in the last day already covers it. Paused
// repos are skipped.
export async function scanDaily(env) {
  const since = new Date(Date.now() - DAY_MS).toISOString();
  const { results } = await env.DB.prepare("SELECT id, default_branch FROM repos r WHERE id NOT IN (SELECT repo_id FROM scan_pauses) AND NOT EXISTS " +
    "(SELECT 1 FROM jobs WHERE repo_id = r.id AND kind = 'scan' AND created_at > ?)").bind(since).all();
  for (const r of results) await queueScan(env, r.id, r.default_branch, "daily");
}

// A scan report goes into the findings store, each source as a full scan of payload.sha, and closes the scans row.
// A failed scan records nothing: it proves nothing about what is fixed.
export async function finishScan(env, job, payload, { secrets, deps, findings }) {
  let counts = null;
  let fixable = [];
  if (job.status === "done") {
    const scan = { repo: job.repo_id, target: payload.target, sha: payload.sha, full: true };
    const secret = secrets.map((s) => ({ rule: s.rule, severity: "high", path: s.path, line: s.line, fingerprint: s.fingerprint }));
    const checked = await checkVulns(deps);
    const dependency = checked.flatMap((d) => d.vulns.map((v) => ({
      rule: v.id, severity: v.severity, path: `${d.name}@${d.version}`, fingerprint: `${d.ecosystem}|${d.name}|${v.id}`,
    })));
    // lazy: SARIF results carry no fingerprint, so one rule's results in one file are one finding; hash the snippet if that hides too much.
    const code = findings.map((f) => ({ rule: f.rule, severity: "unknown", path: f.file ?? "", line: f.line, fingerprint: `${f.rule}|${f.file ?? ""}` }));
    await recordScan(env.DB, { ...scan, source: "secret", findings: secret });
    // An unreachable OSV proves nothing, so it fixes no dependency finding.
    await recordScan(env.DB, { ...scan, source: "dependency", findings: dependency, full: checked.every((d) => d.osv !== "unchecked") });
    await recordScan(env.DB, { ...scan, source: "code", findings: code, full: Boolean(payload.check) });
    counts = JSON.stringify({ secret: secret.length, dependency: dependency.length, code: code.length });
    // latest is the newest published version, when the runner reports one: it marks a dep outdated.
    const inventory = checked.map((d) => ({ ecosystem: d.ecosystem, name: d.name, version: d.version, license: d.license,
      direct: d.direct === true, latest: typeof d.latest === "string" ? d.latest : null, osv: d.osv, vulns: d.vulns }));
    await env.DB.prepare("INSERT OR REPLACE INTO scan_deps (job_id, deps) VALUES (?, ?)").bind(job.id, JSON.stringify(inventory)).run();
    // Each critical advisory asks a person; one a fully checked scan no longer reports is cleared.
    // lazy: any target's scan syncs the repo's advisories; key them by target once release branches are scanned.
    const critical = checked.flatMap((d) => d.vulns.filter((v) => v.severity === "critical").map((v) => ({ kind: "Critical advisory", change: null,
      text: `${d.name} ${d.version} has critical advisory ${v.id}.`, actions: ["Open fix change", "Watchtower"], subject: { package: d.name } })));
    if (checked.every((d) => d.osv !== "unchecked")) await clearNeeds(env.DB, "Critical advisory", job.repo_id, null, critical.map((n) => n.text));
    await raiseNeeds(env.DB, job.repo_id, critical);
    // A finding on an auto-fix package with a fixed version gets one fix change once the scan is done (below).
    const auto = new Set((await env.DB.prepare("SELECT ecosystem || '|' || name AS k FROM dep_auto_fix WHERE repo_id = ?").bind(job.repo_id).all())
      .results.map((r) => r.k));
    fixable = checked.flatMap((d) => (auto.has(`${d.ecosystem}|${d.name}`) ? d.vulns.filter((v) => v.fixed_in) : [])
      .map((v) => `${d.ecosystem}|${d.name}|${v.id}`));
  }
  const risky = job.status === "done" ? deps.filter((d) => d.class !== "permissive") : [];
  await env.DB.batch([
    env.DB.prepare("UPDATE scans SET status = ?, counts = ?, finished_at = ? WHERE job_id = ?")
      .bind(job.status, counts, new Date().toISOString(), job.id),
    ...risky.map((d) => env.DB.prepare("INSERT INTO scan_licenses (job_id, ecosystem, name, version, license, class) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(job.id, d.ecosystem, d.name, d.version, d.license, d.class)),
  ]);
  // After the scans row is done: fixFinding reads the fixed version from the latest done scan.
  const { results } = await env.DB.prepare("SELECT id FROM findings WHERE repo_id = ? AND target = ? AND source = 'dependency' AND state = 'open' " +
    "AND fingerprint IN (SELECT value FROM json_each(?)) AND id NOT IN (SELECT finding_id FROM finding_fixes)").bind(job.repo_id, payload.target, JSON.stringify(fixable)).all();
  for (const f of results) {
    const res = await fixFinding(new Request("https://cinder.internal/api/findings/fix", { method: "POST" }), env, { id: f.id }, true);
    if (!res.ok) console.error(`auto-fix of finding ${f.id} failed: ${res.status} ${await res.text()}`);
  }
}

const scanJson = (s) => ({ ...s, counts: s.counts && JSON.parse(s.counts) });

// A queued scan job has no scans row until a runner claims it; it is listed first, as a scan in state queued.
const queuedScans = (db, repoId) => db.prepare("SELECT id AS job_id, repo_id, json_extract(payload, '$.target') AS target, " +
  "json_extract(payload, '$.source') AS source, NULL AS sha, 'queued' AS status, NULL AS counts, created_at AS started_at, NULL AS finished_at " +
  "FROM jobs WHERE repo_id = ? AND kind = 'scan' AND status = 'queued' AND id NOT IN (SELECT job_id FROM job_cancels) ORDER BY created_at DESC").bind(repoId);

// GET /api/repos/:name/scans: the scan history, newest first.
// lazy: the last 100 scans with no paging; add a cursor once the cockpit pages history.
export async function listScans(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const [queued, scans] = await env.DB.batch([
    queuedScans(env.DB, repo.id),
    env.DB.prepare("SELECT * FROM scans WHERE repo_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 100").bind(repo.id),
  ]);
  return Response.json([...queued.results, ...scans.results].map(scanJson));
}

// GET /api/repos/:name/watchtower[?state=all]: open findings (every state with ?state=all) with their live fix change,
// scan history (queued, then newest first), whether daily scans are paused, whether a scan worker is online and how many
// changes auto-fix opened are open.
// The shape has no unknown/none severity (code findings carry no severity), so those show as low.
export async function getWatchtower(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const all = new URL(request.url).searchParams.get("state") === "all";
  const [open, queued, history, paused, runner, fixes] = await env.DB.batch([
    // A closed or failed fix change is no fix: the finding can be fixed again.
    env.DB.prepare("SELECT f.*, s.line, s.first_seen, c.id AS change_id FROM findings f LEFT JOIN finding_seen s ON s.finding_id = f.id " +
      "LEFT JOIN finding_fixes x ON x.finding_id = f.id " +
      "LEFT JOIN changes c ON c.id = x.change_id AND c.state NOT IN ('failed', 'closed') " +
      `WHERE f.repo_id = ? ${all ? "" : "AND f.state = 'open' "}ORDER BY f.id`).bind(repo.id),
    queuedScans(env.DB, repo.id),
    env.DB.prepare("SELECT * FROM scans WHERE repo_id = ? ORDER BY started_at DESC, rowid DESC LIMIT 100").bind(repo.id),
    env.DB.prepare("SELECT 1 FROM scan_pauses WHERE repo_id = ?").bind(repo.id),
    env.DB.prepare("SELECT 1 FROM runner_tokens t JOIN runner_heartbeats h ON h.runner_id = t.runner_id " +
      "WHERE h.last_heartbeat_at > ? AND EXISTS (SELECT 1 FROM json_each(t.kinds) WHERE value = 'scan') LIMIT 1")
      .bind(new Date(Date.now() - OFFLINE_MS).toISOString()),
    env.DB.prepare("SELECT count(DISTINCT c.id) AS n FROM finding_fixes x JOIN findings f ON f.id = x.finding_id JOIN changes c ON c.id = x.change_id " +
      "WHERE f.repo_id = ? AND c.id IN (SELECT change_id FROM auto_fix_changes) AND c.state NOT IN ('merged', 'failed', 'closed')").bind(repo.id),
  ]);
  const findings = open.results.filter((f) => FINDING_SOURCES.includes(f.source)).map((f) => ({
    id: String(f.id), source: f.source, severity: SEVERITIES.includes(f.severity) ? f.severity : "low", title: f.rule, location: f.path || f.target,
    state: f.state, rule: f.rule, path: f.path, line: f.line, first_seen: f.first_seen, dismiss_reason: f.dismiss_reason, fix_change: f.change_id,
  }));
  const scans = [...queued.results, ...history.results].map((s) => ({
    id: s.job_id, ran_at: s.started_at, status: s.status === "done" ? "passed" : s.status,
    findings: Object.values(JSON.parse(s.counts ?? "{}")).reduce((a, n) => a + n, 0),
  }));
  return Response.json({ findings, scans, paused: paused.results.length > 0, scan_worker_online: runner.results.length > 0,
    fix_changes_open: fixes.results[0].n });
}

// POST /api/repos/:name/watchtower/scans: Scan now queues a full scan of the default branch, as the daily one does.
export async function startScan(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  await queueScan(env, repo.id, repo.default_branch, "daily");
  return new Response(null, { status: 202 });
}
