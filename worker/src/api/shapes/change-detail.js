import { validateChange, validateChangeEvent } from "../contract.js";

export const BLOCKER_CODES = [
  "no_verdict", "verdict_failed", "stale_verdict", "conflict",
  "guard_quarantined", "approval_missing", "approval_stale", "review_rejected", "sarif_finding",
  "dependency_unapproved", "dependency_vulnerable", "finding_open", "threads_unresolved", "stacked",
];

// GET /api/changes/:id returns this: the change, its events and its merge blockers (merge/blockers.js).
export function validateChangeDetail(v) {
  const errors = [...validateChange(v).errors];
  if (!Array.isArray(v?.events)) errors.push("events: expected array");
  else v.events.forEach((e, i) => errors.push(...validateChangeEvent(e).errors.map((m) => `events[${i}].${m}`)));
  if (!Array.isArray(v?.blockers)) errors.push("blockers: expected array");
  else v.blockers.forEach((b, i) => {
    if (!BLOCKER_CODES.includes(b?.code)) errors.push(`blockers[${i}].code: expected one of ${BLOCKER_CODES.join(", ")}`);
    if (typeof b?.reason !== "string" || !b.reason) errors.push(`blockers[${i}].reason: expected non-empty string`);
    if (b?.since !== null && (typeof b?.since !== "string" || Number.isNaN(Date.parse(b.since)))) errors.push(`blockers[${i}].since: expected ISO timestamp or null`);
  });
  // A verified change's review names each requested reviewer and whether they approved its head.
  const requested = v?.review?.requested;
  if (requested !== undefined && !(Array.isArray(requested) && requested.every((r) => typeof r?.who === "string" && r.who && ["pending", "approved"].includes(r.state)))) {
    errors.push("review.requested: expected array of { who, state: pending|approved }");
  }
  // can_approve: the caller may approve or request changes; approvers: who may, by name.
  if (v?.can_approve !== undefined && typeof v.can_approve !== "boolean") errors.push("can_approve: expected boolean");
  if (v?.approvers !== undefined && !(Array.isArray(v.approvers) && v.approvers.every((a) => typeof a === "string" && a))) errors.push("approvers: expected array of non-empty strings");
  // queue_blocker: why the change can't join its merge queue now, null when it can (changes.js queueBlocker).
  if (v?.queue_blocker !== undefined && v.queue_blocker !== null && (typeof v.queue_blocker !== "string" || !v.queue_blocker)) errors.push("queue_blocker: expected non-empty string or null");
  return { ok: errors.length === 0, errors };
}
