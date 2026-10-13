// One Needs you item (GET /api/needs): a decision only a person can make. change is
// the change it is about, or null (a critical advisory); agent is the agent@version that wrote it, when one did; actions are
// the buttons: decisions resolve the item (needs.js), Open change, Watchtower, Open page and Open Insights only navigate.
// A Flow or Release approval adds approvers (the gate's role, or null: whoever may promote), approver_names (the people who
// are one, by name) and can_resolve (the caller is one).
// page is the wiki page a Wiki comment or Stale wiki page is about; a Budget alert's or Budget reached's repo is "account".
const str = (v) => typeof v === "string" && v.length > 0;

export const NEED_KINDS = ["Judges disagree", "Lease takeover", "Untrusted judge", "Critical advisory", "Flow approval", "Release approval", "Wiki comment", "Stale wiki page", "Budget alert", "Budget reached", "Change quarantined", "Dependency needs approval", "Test quarantined"];

export function validateNeed(v) {
  const errors = [];
  const need = (ok, k, desc) => { if (!ok) errors.push(`${k}: expected ${desc}`); };
  need(NEED_KINDS.includes(v?.kind), "kind", `one of ${NEED_KINDS.join(", ")}`);
  for (const k of ["id", "repo", "text"]) need(str(v?.[k]), k, "non-empty string");
  need(v?.change === null || str(v?.change), "change", "null or non-empty string");
  need(v?.agent === undefined || str(v.agent), "agent", "non-empty string when set");
  need(v?.page === undefined || str(v.page), "page", "non-empty string when set");
  need(v?.approvers === undefined || v.approvers === null || str(v.approvers), "approvers", "null or role name when set");
  need(v?.approver_names === undefined || (Array.isArray(v.approver_names) && v.approver_names.every(str)), "approver_names", "array of non-empty strings when set");
  need(v?.can_resolve === undefined || typeof v.can_resolve === "boolean", "can_resolve", "boolean when set");
  need(Array.isArray(v?.actions) && v.actions.length > 0 && v.actions.every(str), "actions", "non-empty array of non-empty strings");
  return { ok: errors.length === 0, errors };
}
