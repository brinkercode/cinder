import { asCaller, personOf } from "./access.js";
import { createChange } from "./changes.js";
import { DISMISS_REASONS } from "./api/contract.js";
import { error } from "./router.js";

// Upserts a target-branch scan report by fingerprint. A fixed finding seen again reopens; a dismissed one stays
// dismissed. On a full scan, open findings of the same source the report no longer has become fixed at sha.
export async function recordScan(db, { repo, target, source, sha, full, findings }) {
  const upsert = db.prepare(
    "INSERT INTO findings (repo_id, target, source, rule, severity, path, fingerprint, first_sha, last_sha) " +
    "VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8) ON CONFLICT (repo_id, target, source, fingerprint) DO UPDATE SET " +
    "rule = excluded.rule, severity = excluded.severity, path = excluded.path, last_sha = excluded.last_sha, " +
    "state = CASE state WHEN 'fixed' THEN 'open' ELSE state END, fixed_sha = NULL",
  );
  const seen = db.prepare(
    "INSERT INTO finding_seen (finding_id, line, first_seen) SELECT id, ?5, ?6 FROM findings WHERE repo_id = ?1 AND target = ?2 AND source = ?3 " +
    "AND fingerprint = ?4 ON CONFLICT (finding_id) DO UPDATE SET line = excluded.line",
  );
  const now = new Date().toISOString();
  // Lines are 1-based: 0 means the scanner reported none.
  const statements = findings.flatMap((f) => [upsert.bind(repo, target, source, f.rule, f.severity, f.path, f.fingerprint, sha),
    seen.bind(repo, target, source, f.fingerprint, f.line || null, now)]);
  // A finding on a path a change's resembles_vuln judgment judged, seen at that change's head, is that judgment's. A guard
  // report's sha is the change id itself.
  statements.push(db.prepare(
    "INSERT OR IGNORE INTO finding_judgments (finding_id, judgment_id) SELECT f.id, j.id FROM findings f " +
    "JOIN judgment_paths p ON p.path = f.path JOIN judgments j ON j.id = p.judgment_id AND j.repo_id = f.repo_id AND j.kind = 'resembles_vuln' " +
    "WHERE f.repo_id = ?1 AND f.target = ?2 AND f.source = ?3 AND f.last_sha = ?4 " +
    "AND (j.change_id = ?4 OR j.change_id IN (SELECT change_id FROM change_heads WHERE head_sha = ?4))",
  ).bind(repo, target, source, sha));
  if (full) {
    // An uploaded SARIF finding (fingerprint sha256:..., from the runner's Ingest) came from another tool, so a scan's check never fixes it.
    statements.push(db.prepare(
      "UPDATE findings SET state = 'fixed', fixed_sha = ?1 WHERE repo_id = ?2 AND target = ?3 AND source = ?4 AND state = 'open' " +
      "AND fingerprint NOT IN (SELECT value FROM json_each(?5)) AND NOT (source = 'code' AND fingerprint LIKE 'sha256:%')",
    ).bind(sha, repo, target, source, JSON.stringify(findings.map((f) => f.fingerprint))));
  }
  // A fix change is the finding's fix once it has merged and the finding is fixed; a reopened finding loses it.
  statements.push(db.prepare(
    "UPDATE finding_fixes SET fixed_by = CASE WHEN EXISTS (SELECT 1 FROM findings f, changes c WHERE f.id = finding_id AND f.state = 'fixed' " +
    "AND c.id = change_id AND c.state = 'merged') THEN change_id END WHERE finding_id IN " +
    "(SELECT id FROM findings WHERE repo_id = ?1 AND target = ?2 AND source = ?3)",
  ).bind(repo, target, source));
  await db.batch(statements);
}

// POST /api/findings/:id/fix: an open finding becomes a change on its target, with an intent drafted from it, linked
// back to the finding. A dependency finding is a bump to the version the latest done scan says fixes it. A finding
// whose fix change is still open answers that change (200) instead. autoFix marks a change scans.js opened.
export async function fixFinding(request, env, { id }, autoFix = false) {
  const finding = await env.DB.prepare("SELECT f.*, r.name FROM findings f JOIN repos r ON r.id = f.repo_id WHERE f.id = ?").bind(id).first();
  if (!finding) return error(404, "not_found", `no finding ${id}`);
  if (finding.state !== "open") return error(409, "conflict", `finding ${id} is ${finding.state}, not open`);
  const open = await env.DB.prepare("SELECT x.change_id FROM finding_fixes x JOIN changes c ON c.id = x.change_id " +
    "WHERE x.finding_id = ? AND c.state NOT IN ('merged', 'failed', 'closed')").bind(finding.id).first("change_id");
  if (open) return Response.json(await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(open)).get());
  let intent = `fix ${finding.rule} in ${finding.path} (finding ${finding.id})`;
  if (finding.source === "dependency") {
    const deps = await env.DB.prepare("SELECT d.deps FROM scan_deps d JOIN scans s ON s.job_id = d.job_id WHERE s.repo_id = ? AND s.target = ? " +
      "AND s.status = 'done' ORDER BY s.finished_at DESC, s.rowid DESC LIMIT 1").bind(finding.repo_id, finding.target).first("deps");
    const dep = JSON.parse(deps ?? "[]").find((d) => `${d.name}@${d.version}` === finding.path);
    const fixedIn = dep?.vulns.find((v) => v.id === finding.rule)?.fixed_in;
    if (fixedIn) intent = `bump ${dep.name} ${dep.version} → ${fixedIn} (fixes ${finding.rule}, finding ${finding.id})`;
  }
  const body = JSON.stringify({ intent, target_branch: finding.target });
  const res = await createChange(asCaller(request, request.url, { method: "POST", body }), env, { name: finding.name });
  if (!res.ok) return res;
  const change = await res.json();
  // A retried fix (the first change merged, closed or failed) replaces the link.
  await env.DB.batch([env.DB.prepare("INSERT OR REPLACE INTO finding_fixes (finding_id, change_id) VALUES (?, ?)").bind(finding.id, change.id),
    ...(autoFix ? [env.DB.prepare("INSERT INTO auto_fix_changes (change_id) VALUES (?)").bind(change.id)] : [])]);
  return Response.json(change, { status: 201 });
}

// POST /api/findings/:id/dismiss {reason, note?}: an open finding stops blocking. A false positive on a finding a
// hazard judgment raised is that judgment's "no" outcome, unless it already has one.
export async function dismissFinding(request, env, { id }) {
  const { reason, note = null } = (await request.json().catch(() => null)) ?? {};
  if (!DISMISS_REASONS.includes(reason)) return error(400, "bad_request", `reason must be one of ${DISMISS_REASONS.join(", ")}`);
  if (note !== null && typeof note !== "string") return error(400, "bad_request", "note must be a string");
  const finding = await env.DB.prepare(
    "UPDATE findings SET state = 'dismissed', dismiss_reason = ?2, dismissed_by = ?3 WHERE id = ?1 AND state = 'open' RETURNING *",
  ).bind(id, reason, personOf(request)).first();
  if (!finding) return missingOr409(env, id, "open");
  const writes = note ? [env.DB.prepare("INSERT OR REPLACE INTO finding_notes (finding_id, note) VALUES (?, ?)").bind(finding.id, note)] : [];
  if (reason === "false_positive") {
    writes.push(env.DB.prepare(
      "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT j.id, 'no', j.answer = 'no', ?2 FROM judgments j " +
      "JOIN finding_judgments fj ON fj.judgment_id = j.id WHERE fj.finding_id = ?1 AND j.id NOT IN (SELECT judgment_id FROM outcomes)",
    ).bind(finding.id, new Date().toISOString()));
  }
  if (writes.length) await env.DB.batch(writes);
  return Response.json({ ...finding, note });
}

// POST /api/findings/:id/reopen: a dismissed finding is open, and blocking, again.
export async function reopenFinding(request, env, { id }) {
  const finding = await env.DB.prepare(
    "UPDATE findings SET state = 'open', dismiss_reason = NULL, dismissed_by = NULL WHERE id = ?1 AND state = 'dismissed' RETURNING *",
  ).bind(id).first();
  if (!finding) return missingOr409(env, id, "dismissed");
  await env.DB.prepare("DELETE FROM finding_notes WHERE finding_id = ?").bind(finding.id).run();
  return Response.json({ ...finding, note: null });
}

async function missingOr409(env, id, needed) {
  const state = await env.DB.prepare("SELECT state FROM findings WHERE id = ?").bind(id).first("state");
  return state ? error(409, "conflict", `finding ${id} is ${state}, not ${needed}`) : error(404, "not_found", `no finding ${id}`);
}

// The open findings raised by hazard judgments on a change: each blocks its merge.
export async function openFindings(db, changeId) {
  const { results } = await db.prepare(
    "SELECT f.id, f.rule, f.path FROM findings f JOIN finding_judgments fj ON fj.finding_id = f.id JOIN judgments j ON j.id = fj.judgment_id " +
    "WHERE j.change_id = ? AND f.state = 'open' ORDER BY f.id",
  ).bind(changeId).all();
  return results;
}
