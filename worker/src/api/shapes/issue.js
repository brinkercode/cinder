const str = (v) => typeof v === "string" && v.length > 0;
const orNull = (v) => v === null || str(v);

// GET|POST /api/repos/:name/issues, PATCH …/issues/:n: one issue; labels are names, assignee an email or null.
// status is its board column; change (the GET list only) is its newest linked change's id or null.
export function validateIssue(v) {
  const errors = [];
  for (const k of ["id", "repo_id", "title", "author", "created_at", "updated_at"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!Number.isInteger(v?.number) || v.number < 1) errors.push("number: expected integer >= 1");
  if (typeof v?.body !== "string") errors.push("body: expected string");
  if (!["open", "closed"].includes(v?.state)) errors.push("state: expected open|closed");
  if (!Array.isArray(v?.labels) || !v.labels.every(str)) errors.push("labels: expected string[]");
  if (!orNull(v?.assignee)) errors.push("assignee: expected null or non-empty string");
  if (!["backlog", "todo", "progress", "review", "done"].includes(v?.status)) errors.push("status: expected backlog|todo|progress|review|done");
  if (!(v?.priority === null || ["P0", "P1", "P2", "P3"].includes(v?.priority))) errors.push("priority: expected null or P0|P1|P2|P3");
  if (!orNull(v?.iteration)) errors.push("iteration: expected null or non-empty string");
  if (v && "change" in v && !orNull(v.change)) errors.push("change: expected null or non-empty string");
  if ((v?.state === "closed") !== str(v?.closed_at) || !orNull(v?.closed_at)) errors.push("closed_at: expected a time iff closed");
  return { ok: errors.length === 0, errors };
}

// GET /api/repos/:name/issues/:n: the issue with its comments (oldest first) and linked changes [{id, state}].
export function validateIssueDetail(v) {
  const errors = [...validateIssue(v).errors];
  const comment = (c) => ["id", "issue_id", "author", "body", "created_at"].every((k) => str(c?.[k]));
  if (!Array.isArray(v?.comments) || !v.comments.every(comment)) errors.push("comments: expected [{id, issue_id, author, body, created_at}]");
  if (!Array.isArray(v?.changes) || !v.changes.every((c) => str(c?.id) && str(c?.state))) errors.push("changes: expected [{id, state}]");
  return { ok: errors.length === 0, errors };
}
