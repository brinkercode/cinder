const str = (v) => typeof v === "string" && v.length > 0;
const count = (n) => Number.isInteger(n) && n >= 0;

// GET /api/repos/:name/wiki/tree: [{id, parent_id, title, slug, type: page|folder, sort_order, agent_context, children: [...same]}].
export function validateWikiTree(v) {
  const errors = [];
  const walk = (list, at) => {
    if (!Array.isArray(list)) return errors.push(`${at}: expected array`);
    list.forEach((n, i) => {
      for (const k of ["id", "title", "slug"]) if (!str(n?.[k])) errors.push(`${at}[${i}].${k}: expected non-empty string`);
      if (!["page", "folder"].includes(n?.type)) errors.push(`${at}[${i}].type: expected page|folder`);
      if (!Number.isInteger(n?.sort_order)) errors.push(`${at}[${i}].sort_order: expected integer`);
      if (typeof n?.agent_context !== "boolean") errors.push(`${at}[${i}].agent_context: expected boolean`);
      walk(n?.children, `${at}[${i}].children`);
    });
  };
  walk(v, "tree");
  return { ok: errors.length === 0, errors };
}

// A heading's link anchor: the toc (worker/src/wiki.js) and the markdown renderer (web/src/lib/markdown.jsx) share it.
export const anchor = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

// GET /api/repos/:name/wiki/pages/:id: the page row, view_count already including this read, plus agent_context, words,
// read_minutes (>= 1), views (distinct person-days) and toc [{level: 2|3, text, anchor}] from its ## and ### headings.
export function validateWikiPage(v) {
  const errors = [];
  for (const k of ["id", "repo_id", "title", "slug", "created_at", "updated_at"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (v?.parent_id !== null && !str(v?.parent_id)) errors.push("parent_id: expected null or non-empty string");
  if (!["page", "folder"].includes(v?.type)) errors.push("type: expected page|folder");
  if (typeof v?.content !== "string") errors.push("content: expected string");
  if (!Number.isInteger(v?.sort_order)) errors.push("sort_order: expected integer");
  if (!count(v?.view_count)) errors.push("view_count: expected integer >= 0");
  if (typeof v?.agent_context !== "boolean") errors.push("agent_context: expected boolean");
  for (const k of ["words", "views"]) if (!count(v?.[k])) errors.push(`${k}: expected integer >= 0`);
  if (!Number.isInteger(v?.read_minutes) || v.read_minutes < 1) errors.push("read_minutes: expected integer >= 1");
  const heading = (h) => [2, 3].includes(h?.level) && str(h?.text) && typeof h?.anchor === "string";
  if (!Array.isArray(v?.toc) || !v.toc.every(heading)) errors.push("toc: expected [{level: 2|3, text, anchor}]");
  return { ok: errors.length === 0, errors };
}

// GET /api/repos/:name/wiki/pages/:id/history[/:v]: a version row; content only on the single-version read.
export function validateWikiVersion(v) {
  const errors = [];
  for (const k of ["page_id", "edited_by", "created_at"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (!Number.isInteger(v?.version) || v.version < 1) errors.push("version: expected integer >= 1");
  if (typeof v?.message !== "string") errors.push("message: expected string");
  if (v?.content !== undefined && typeof v.content !== "string") errors.push("content: expected string");
  return { ok: errors.length === 0, errors };
}

// GET|POST /api/repos/:name/wiki/pages/:id/comments, PATCH …/comments/:c: one comment row; edited_at null until edited.
export function validateWikiComment(v) {
  const errors = [];
  for (const k of ["id", "page_id", "author", "body", "created_at"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (v?.edited_at !== null && !str(v?.edited_at)) errors.push("edited_at: expected null or non-empty string");
  return { ok: errors.length === 0, errors };
}

// GET /api/repos/:name/wiki/search?q=: [{id, path, title, snippet, matches: [{start, end}]}]. snippet is plain text,
// never HTML; matches are [start, end) offsets of the hits in it.
export function validateWikiSearchHit(v) {
  const errors = [];
  for (const k of ["id", "path", "title"]) if (!str(v?.[k])) errors.push(`${k}: expected non-empty string`);
  if (typeof v?.snippet !== "string") errors.push("snippet: expected string");
  const ok = (m) => count(m?.start) && Number.isInteger(m?.end) && m.start <= m.end && m.end <= (v?.snippet?.length ?? 0);
  if (!Array.isArray(v?.matches) || !v.matches.every(ok)) errors.push("matches: expected [{start, end}] within snippet");
  return { ok: errors.length === 0, errors };
}
