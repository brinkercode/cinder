const str = (v) => typeof v === "string" && v.length > 0;
const sha = (v) => typeof v === "string" && /^[0-9a-f]{40}$/.test(v);

// GET /api/repos/:name/tags: one tag the commit API pushed, at commit sha.
export function validateTag(v) {
  const errors = [];
  for (const k of ["name", "message", "tagger", "created_at"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!sha(v?.sha)) errors.push("sha: expected 40-char commit sha");
  return { ok: errors.length === 0, errors };
}

// GET|POST /api/repos/:name/releases, POST …/releases/:id/publish: a release of one tag; environments it was promoted to.
export function validateRelease(v) {
  const errors = [];
  for (const k of ["id", "repo", "tag", "title", "author", "created_at"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!sha(v?.sha)) errors.push("sha: expected 40-char commit sha");
  if (typeof v?.notes !== "string") errors.push("notes: expected string");
  if (!["draft", "published"].includes(v?.state)) errors.push("state: expected draft|published");
  if ((v?.state === "published") !== str(v?.published_at)) errors.push("published_at: expected a time iff published");
  if (!Array.isArray(v?.environments) || !v.environments.every(str)) errors.push("environments: expected string[]");
  return { ok: errors.length === 0, errors };
}
