// The one merge gate: the queue, the merge job and the API all call this. Fail-closed: a missing,
// undefined or unrecognised input is a blocker, never a pass.
// change: { head, state }; policy: { approvals } (count required); verdict: { sha, status, at };
// approvals: each reviewer's latest review [{ by, sha, state: "approved" | "rejected", at }];
// findings: open findings raised on the change [{ id, rule, path }] (dismissed ones are left out);
// requireResolved: the target's `review.require_resolved`; unresolvedThreads: count of the change's unresolved threads;
// guard: { status: "clear" | "quarantined", at, deps: [{ ecosystem, name, version, license, class, approved_at, osv, vulns: [{ id, severity }] }] }; route: { reviewers } (who must approve).
export function blockersFor({ change, policy, verdict, approvals, guard, route, findings, requireResolved, unresolvedThreads } = {}) {
  const blockers = [];
  const block = (code, reason, since) => blockers.push({ code, reason, since: since ?? null });
  const head = change?.head;

  if (!verdict) block("no_verdict", "no verify verdict");
  else {
    if (verdict.status !== "pass") block("verdict_failed", `verdict is ${verdict.status}`, verdict.at);
    if (!head || verdict.sha !== head) block("stale_verdict", `verdict is for ${verdict.sha}, head is ${head}`, verdict.at);
    for (const f of Array.isArray(verdict.findings) ? verdict.findings : []) {
      block("sarif_finding", `${f.rule} at ${f.file}:${f.line}`, verdict.at);
    }
  }
  if (!change || change.state === "conflict" || change.state === "resolving") {
    block("conflict", change ? `change is in ${change.state}` : "change unknown");
  }
  if (guard?.status !== "clear") block("guard_quarantined", guard ? `guard is ${guard.status}` : "no guard result", guard?.at);
  for (const d of guard?.deps ?? []) {
    for (const v of d.vulns ?? []) {
      if (v.severity === "high" || v.severity === "critical") block("dependency_vulnerable", `${d.ecosystem} dependency ${d.name}@${d.version} has ${v.severity} ${v.id}`, guard.at);
    }
    if (!d.approved_at) block("dependency_unapproved", `${d.class === "copyleft" ? "copyleft " : ""}${d.ecosystem} dependency ${d.name}@${d.version} (${d.license || "no license"}) needs owner approval`, guard.at);
  }

  for (const f of findings ?? []) block("finding_open", `finding ${f.id}: ${f.rule} in ${f.path}`);
  if (requireResolved && unresolvedThreads !== 0) block("threads_unresolved", `${unresolvedThreads ?? "unknown"} unresolved review thread(s)`);

  const fresh = new Set();
  for (const a of Array.isArray(approvals) ? approvals : []) {
    if (a.state === "rejected") block("review_rejected", `${a.by} rejected the change`, a.at);
    else if (!head || a.sha !== head) block("approval_stale", `${a.by} reviewed ${a.sha}, head is ${head}`, a.at);
    else if (a.state === "approved") fresh.add(a.by);
  }
  if (!Array.isArray(approvals) || !Number.isInteger(policy?.approvals) || !Array.isArray(route?.reviewers)) {
    block("approval_missing", "approvals, approval policy or review route unknown");
    return blockers;
  }
  const missing = route.reviewers.filter((r) => !fresh.has(r));
  if (fresh.size < policy.approvals || missing.length) {
    block("approval_missing", `${fresh.size}/${policy.approvals} approvals${missing.length ? `, waiting on ${missing.join(", ")}` : ""}`);
  }
  return blockers;
}

// The why a guard result blocks the merge, worded once for the board card, the readiness row and Needs you:
// [quarantine, unapproved dependencies], each null when it doesn't block.
export function guardWhy(guard) {
  const deps = (guard?.deps ?? []).filter((d) => !d.approved_at).map((d) => `${d.name} ${d.version}`);
  return [guard?.status === "quarantined" ? `Blocked: quarantined (${guard.reason})` : null,
    deps.length ? `Blocked: new ${deps.length > 1 ? "dependencies" : "dependency"} ${deps.join(", ")} ${deps.length > 1 ? "need" : "needs"} approval` : null];
}
