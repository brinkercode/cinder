// GET /api/repos/:name/wiki/context: {pages: [{id, title, path, content}], tokens, truncated}. The repo's agent-context
// pages in tree order; tokens is ceil(bytes / 4) of their content; truncated when a page was left out to stay under 24k.
export function validateWikiContext(v) {
  const errors = [];
  const page = (p) => ["id", "title", "path"].every((k) => typeof p?.[k] === "string" && p[k] !== "") && typeof p?.content === "string";
  if (!Array.isArray(v?.pages) || !v.pages.every(page)) errors.push("pages: expected [{id, title, path, content}]");
  if (!Number.isInteger(v?.tokens) || v.tokens < 0) errors.push("tokens: expected integer >= 0");
  if (typeof v?.truncated !== "boolean") errors.push("truncated: expected boolean");
  return { ok: errors.length === 0, errors };
}
