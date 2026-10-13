const str = (v) => typeof v === "string" && v.length > 0;

// GET /api/repos/:name/log?ref&path&page: commits at ref, newest first, a page of 50; only those that changed path when one
// is given. more: a next page exists. total: every commit at ref, without path only. date: the author date, ISO.
export function validateCodeLog(v) {
  const errors = [];
  for (const k of ["ref", "sha"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (typeof v?.path !== "string") errors.push("path: expected string");
  if (typeof v?.more !== "boolean") errors.push("more: expected boolean");
  if (v?.total !== undefined && !(Number.isInteger(v.total) && v.total >= 0)) errors.push("total: expected integer >= 0");
  if (!Array.isArray(v?.commits)) errors.push("commits: expected array");
  else v.commits.forEach((c, i) => errors.push(...validateLogCommit(c).errors.map((e) => `commits[${i}]: ${e}`)));
  return { ok: errors.length === 0, errors };
}

// One CodeLog commit; also GET /api/repos/:name/resolve?sha.
export function validateLogCommit(c) {
  const ok = str(c?.sha) && typeof c.message === "string" && (c.author === null || typeof c.author === "string")
    && (c.date == null || !Number.isNaN(Date.parse(c.date)));
  return { ok, errors: ok ? [] : ["expected {sha, message, author: string | null, date?: ISO timestamp | null}"] };
}

// GET /api/repos/:name/code-search?ref&q: one hit per matching line.
export function validateCodeHit(v) {
  const ok = str(v?.path) && Number.isInteger(v.line) && v.line >= 1 && typeof v.text === "string";
  return { ok, errors: ok ? [] : ["expected {path, line >= 1, text}"] };
}
