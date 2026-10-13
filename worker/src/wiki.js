import { isOwnerEmail, personOf } from "./access.js";
import { lineDiff } from "./agents.js";
import { anchor } from "./api/contract.js";
import { createArtifacts } from "./artifacts.js";
import { commit as gitCommit } from "./git/index.js";
import { raiseNeeds } from "./needs.js";
import { error, hex } from "./router.js";

// The org's one wiki: the Artifacts repo deploy/reconcile.sh creates. A page is the markdown file
// <repo>/<page id>.md; its versions are the main commits whose message carries "Wiki-Page: <id>", oldest v1. D1 only
// indexes pages for the tree, search and comments.
// lazy: files are named by page id so moves and renames keep history; name them by title path once history follows renames.
export const WIKI_REPO = "cinder-wiki";
const fileOf = (name, id) => `${name}/${id}.md`;
const trailer = (id) => `Wiki-Page: ${id}`;
const CINDER = { name: "cinder", email: "cinder@cinder" };
const missing = () => error(503, "wiki_missing", `the org wiki repo ${WIKI_REPO} is missing; run deploy/reconcile.sh`);

// {repo, head} of the org wiki, or null when the repo is missing. Its first use commits every page indexed before it
// existed into its repo's folder, so per-repo pages move into the org wiki.
async function wiki(env) {
  const repo = await createArtifacts(env.ARTIFACTS).get(WIKI_REPO);
  if (!repo) return null;
  let head = (await repo.log({ ref: "main", limit: 1 }))[0]?.hash ?? null;
  if (head) return { repo, head };
  const { results } = await env.DB.prepare("SELECT p.id, p.content, r.name FROM wiki_pages p JOIN repos r ON r.id = p.repo_id WHERE p.type = 'page'").all();
  if (!results.length) return { repo, head };
  try {
    ({ sha: head } = await gitCommit(repo, { branch: "main", base: null, author: CINDER, changes: results.map((p) => ({ path: fileOf(p.name, p.id), content: p.content })),
      message: `Move per-repo wiki pages into the org wiki\n\n${results.map((p) => trailer(p.id)).join("\n")}` }));
  } catch (e) {
    if (e.code !== "conflict") throw e;
    // A concurrent first use migrated them.
    head = (await repo.log({ ref: "main", limit: 1 }))[0]?.hash ?? null;
  }
  return { repo, head };
}

// {head, list}: list[v - 1] is version v's commit.
// lazy: filters the newest 1000 wiki commits (the binding's cap); page through with offset once the wiki passes that.
async function historyOf(repo, id) {
  const log = await repo.log({ ref: "main", limit: 1000 });
  return { head: log[0]?.hash ?? null, list: log.filter((c) => c.message.split("\n").includes(trailer(id))).reverse() };
}

const versionRow = (id, c, i) => ({ page_id: id, version: i + 1, edited_by: c.author.name, created_at: new Date(c.authoredAt * 1000).toISOString(),
  message: c.message.split("\n").filter((l) => !l.startsWith("Wiki-Page: ")).join("\n").trim() });

// Commits content as page id's file in repo name's folder onto main at head; throws {code: "conflict"} when main moved.
function save(wikiRepo, head, request, name, id, content, message) {
  const who = personOf(request);
  return gitCommit(wikiRepo, { branch: "main", base: head, author: { name: who, email: who }, changes: [{ path: fileOf(name, id), content }],
    message: `${message}\n\n${trailer(id)}` });
}

// GET /api/repos/:name/wiki/tree → WikiNode[] (api/shapes/wiki.js): top-level pages, children nested, each level in sort order.
export async function getWikiTree(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.parent_id, p.title, p.slug, p.type, p.sort_order, c.page_id IS NOT NULL AS agent_context
      FROM wiki_pages p LEFT JOIN wiki_agent_context c ON c.page_id = p.id WHERE p.repo_id = ? ORDER BY p.sort_order, p.title`,
  ).bind(repo.id).all();
  const nodes = new Map(results.map((p) => [p.id, { ...p, agent_context: p.agent_context === 1, children: [] }]));
  const roots = [];
  for (const p of results) (p.parent_id ? nodes.get(p.parent_id)?.children ?? roots : roots).push(nodes.get(p.id));
  return Response.json(roots);
}

// The page row plus agent_context, words, read_minutes, views and toc (the ## and ### headings outside code fences).
async function shown(env, page) {
  const [flag, views] = await env.DB.batch([env.DB.prepare("SELECT 1 FROM wiki_agent_context WHERE page_id = ?").bind(page.id),
    env.DB.prepare("SELECT COUNT(*) AS n FROM wiki_views WHERE page_id = ?").bind(page.id)]);
  const words = page.content.split(/\s+/).filter(Boolean).length;
  const toc = [];
  let fence = false;
  for (const l of page.content.split("\n")) {
    if (l.startsWith("```")) fence = !fence;
    const m = !fence && l.match(/^(#{2,3}) +(\S.*)$/);
    if (m) toc.push({ level: m[1].length, text: m[2].trim(), anchor: anchor(m[2]) });
  }
  return { ...page, agent_context: flag.results.length > 0, words, read_minutes: Math.max(1, Math.ceil(words / 200)), views: views.results[0].n, toc };
}

// GET /api/repos/:name/wiki/pages/:id → WikiPage; one UPDATE bumps view_count so concurrent reads don't lose counts, and
// the reader's (person, day) row in wiki_views counts once however often they read.
export async function getWikiPage(request, env, { name, id }) {
  const page = await env.DB.prepare(
    "UPDATE wiki_pages SET view_count = view_count + 1 WHERE id = ? AND repo_id = (SELECT id FROM repos WHERE name = ?) RETURNING *",
  ).bind(id, name).first();
  if (!page) return error(404, "not_found", `no wiki page ${id}`);
  await env.DB.prepare("INSERT OR IGNORE INTO wiki_views (page_id, person, day) VALUES (?, ?, ?)")
    .bind(id, personOf(request), new Date().toISOString().slice(0, 10)).run();
  return Response.json(await shown(env, page));
}

// The repo's agent-context pages in tree order (each level by sort_order, title) as {id, title, path, content}.
async function flagged(env, repoId) {
  const { results } = await env.DB.prepare(`SELECT p.id, p.parent_id, p.title, p.slug, p.type, p.content, c.page_id IS NOT NULL AS flagged
    FROM wiki_pages p LEFT JOIN wiki_agent_context c ON c.page_id = p.id WHERE p.repo_id = ? ORDER BY p.sort_order, p.title`).bind(repoId).all();
  const children = Map.groupBy(results, (p) => p.parent_id);
  const pages = [];
  const walk = (parent, at) => {
    for (const p of children.get(parent) ?? []) {
      if (p.flagged && p.type === "page") pages.push({ id: p.id, title: p.title, path: at + p.slug, content: p.content });
      walk(p.id, `${at}${p.slug}/`);
    }
  };
  walk(null, "");
  return pages;
}

const CONTEXT_TOKENS = 24000;

// GET /api/repos/:name/wiki/context → WikiContext (api/shapes/wiki-context.js): flagged pages in tree order until the
// next would pass 24k tokens (ceil(bytes / 4)); a page is never cut, and truncated says one was left out.
export async function getWikiContext(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const pages = [];
  let bytes = 0, truncated = false;
  for (const page of await flagged(env, repo.id)) {
    const n = new TextEncoder().encode(page.content).length;
    if (Math.ceil((bytes + n) / 4) > CONTEXT_TOKENS) { truncated = true; break; }
    bytes += n;
    pages.push(page);
  }
  return Response.json({ pages, tokens: Math.ceil(bytes / 4), truncated });
}

const pageIn = (env, name, id) => env.DB.prepare(
  "SELECT p.id, p.repo_id, p.title FROM wiki_pages p JOIN repos r ON r.id = p.repo_id WHERE p.id = ? AND r.name = ?",
).bind(id, name).first();

const bodyOf = async (request) => {
  const body = (await request.json().catch(() => null))?.body;
  return typeof body === "string" && body.trim() !== "" ? body : null;
};

// GET /api/repos/:name/wiki/pages/:id/comments → WikiComment[], oldest first (rowid breaks same-millisecond ties).
export async function listWikiComments(request, env, { name, id }) {
  if (!(await pageIn(env, name, id))) return error(404, "not_found", `no wiki page ${id}`);
  const { results } = await env.DB.prepare("SELECT * FROM wiki_page_comments WHERE page_id = ? ORDER BY created_at, rowid").bind(id).all();
  return Response.json(results);
}

// POST /api/repos/:name/wiki/pages/:id/comments {body} → 201 WikiComment. It raises a Wiki comment need for the page's last
// editor, unless they wrote it.
export async function addWikiComment(request, env, { name, id }) {
  const page = await pageIn(env, name, id);
  if (!page) return error(404, "not_found", `no wiki page ${id}`);
  const body = await bodyOf(request);
  if (!body) return error(400, "bad_request", "body must be a non-empty string");
  const comment = await env.DB.prepare(
    "INSERT INTO wiki_page_comments (id, page_id, author, body, created_at) VALUES (?, ?, ?, ?, ?) RETURNING *",
  ).bind(crypto.randomUUID(), id, personOf(request), body, new Date().toISOString()).first();
  const editor = await env.DB.prepare("SELECT edited_by FROM wiki_editors WHERE page_id = ?").bind(id).first("edited_by");
  if (editor && editor !== comment.author) {
    await raiseNeeds(env.DB, page.repo_id, [{ kind: "Wiki comment", change: null, text: `${comment.author} commented on ${page.title}: ${body}`,
      actions: ["Open page", "Resolve"], subject: { page: id, for: editor } }]);
  }
  return Response.json(comment, { status: 201 });
}

// PATCH /api/repos/:name/wiki/pages/:id/comments/:c {body} → WikiComment. Only its author may edit it.
export async function editWikiComment(request, env, { name, id, c }) {
  if (!(await pageIn(env, name, id))) return error(404, "not_found", `no wiki page ${id}`);
  const author = await env.DB.prepare("SELECT author FROM wiki_page_comments WHERE id = ? AND page_id = ?").bind(c, id).first("author");
  if (!author) return error(404, "not_found", `no comment ${c}`);
  if (author !== personOf(request)) return error(403, "forbidden", "only the comment's author may edit it");
  const body = await bodyOf(request);
  if (!body) return error(400, "bad_request", "body must be a non-empty string");
  const comment = await env.DB.prepare("UPDATE wiki_page_comments SET body = ?, edited_at = ? WHERE id = ? RETURNING *")
    .bind(body, new Date().toISOString(), c).first();
  return Response.json(comment);
}

// DELETE /api/repos/:name/wiki/pages/:id/comments/:c → 204. Only its author or an owner may delete it.
export async function deleteWikiComment(request, env, { name, id, c }) {
  if (!(await pageIn(env, name, id))) return error(404, "not_found", `no wiki page ${id}`);
  const author = await env.DB.prepare("SELECT author FROM wiki_page_comments WHERE id = ? AND page_id = ?").bind(c, id).first("author");
  if (!author) return error(404, "not_found", `no comment ${c}`);
  const me = personOf(request);
  if (author !== me && me !== "owner" && !isOwnerEmail(env, me)) return error(403, "forbidden", "only the comment's author or an owner may delete it");
  const { meta } = await env.DB.prepare("DELETE FROM wiki_page_comments WHERE id = ? AND page_id = ?").bind(c, id).run();
  return meta.changes ? new Response(null, { status: 204 }) : error(404, "not_found", `no comment ${c}`);
}

// \x02 and \x03 bracket each hit in snippet(); strip them into [start, end) offsets so the snippet stays plain text.
// lazy: page text holding \x02/\x03 itself shifts the offsets, still only as text.
function plain(marked) {
  let snippet = "", start = 0;
  const matches = [];
  for (const ch of marked) {
    if (ch === "\x02") start = snippet.length;
    else if (ch === "\x03") matches.push({ start, end: snippet.length });
    else snippet += ch;
  }
  return { snippet, matches };
}

// GET /api/repos/:name/wiki/search?q= → WikiSearchHit[] (api/shapes/wiki.js): pages holding every word of q.
export async function searchWiki(request, env, { name }) {
  const words = (new URL(request.url).searchParams.get("q") ?? "").split(/\s+/).filter(Boolean);
  if (!words.length) return error(400, "bad_request", "q must hold at least one word");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  // Each word quoted, so q is never FTS5 syntax.
  const match = words.map((w) => `"${w.replaceAll('"', '""')}"`).join(" ");
  const { results } = await env.DB.prepare(
    `WITH RECURSIVE paths(id, path) AS (
       SELECT id, slug FROM wiki_pages WHERE repo_id = ?1 AND parent_id IS NULL
       UNION ALL SELECT p.id, paths.path || '/' || p.slug FROM wiki_pages p JOIN paths ON p.parent_id = paths.id)
     SELECT s.page_id AS id, paths.path, s.title, snippet(wiki_search, -1, char(2), char(3), '…', 16) AS marked
       FROM wiki_search s JOIN paths ON paths.id = s.page_id WHERE wiki_search MATCH ?2 ORDER BY rank LIMIT 50`,
  ).bind(repo.id, match).all();
  return Response.json(results.map(({ marked, ...r }) => ({ ...r, ...plain(marked) })));
}

const CONTEXT_BYTES = 32 * 1024;

// Develop-claim context: the repo's flagged pages in tree order, then up to 3 pages ranked by FTS match on any word of
// the intent, together within 32 KiB (a page that would pass the cap is skipped, never cut), each with the git blob sha
// of the content handed over. An empty intent hands over the flagged pages only.
export async function wikiContext(env, repoId, intent) {
  const words = intent.match(/[\p{L}\p{N}_]+/gu) ?? [];
  const { results } = words.length ? await env.DB.prepare(`SELECT p.id, p.title, p.content FROM wiki_search s JOIN wiki_pages p ON p.id = s.page_id
    WHERE p.repo_id = ? AND p.type = 'page' AND wiki_search MATCH ? ORDER BY s.rank LIMIT 3`).bind(repoId, words.map((w) => `"${w}"`).join(" OR ")).all() : { results: [] };
  const pages = [];
  let left = CONTEXT_BYTES;
  for (const page of [...await flagged(env, repoId), ...results]) {
    if (pages.some((p) => p.id === page.id)) continue;
    const bytes = new TextEncoder().encode(page.content);
    if (bytes.length > left) continue;
    left -= bytes.length;
    const blob = new Uint8Array([...new TextEncoder().encode(`blob ${bytes.length}\0`), ...bytes]);
    const sha = hex(await crypto.subtle.digest("SHA-1", blob));
    pages.push({ id: page.id, title: page.title, content: page.content, sha });
  }
  return pages;
}

const MAX_CONTENT = 200 * 1024;
const tooBig = (content) => new TextEncoder().encode(content).length > MAX_CONTENT;

// Records the caller as the page's last editor (Wiki comment needs).
const edited = (env, request, id, at) => env.DB.prepare("INSERT OR REPLACE INTO wiki_editors VALUES (?, ?, ?)").bind(id, personOf(request), at);

// The page row, or null.
const pageOf = (env, name, id) => env.DB.prepare(
  "SELECT p.* FROM wiki_pages p JOIN repos r ON r.id = p.repo_id WHERE r.name = ? AND p.id = ?",
).bind(name, id).first();

// A slug from the title, suffixed -2, -3, … until no sibling under parentId (other than selfId) has it.
async function slugFor(env, repoId, parentId, title, selfId = null) {
  const base = title.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "page";
  const { results } = await env.DB.prepare(
    "SELECT slug FROM wiki_pages WHERE repo_id = ? AND COALESCE(parent_id, '') = COALESCE(?, '') AND id IS NOT ?",
  ).bind(repoId, parentId, selfId).all();
  const taken = new Set(results.map((r) => r.slug));
  let slug = base;
  for (let n = 2; taken.has(slug); n++) slug = `${base}-${n}`;
  return slug;
}

// The batch runs as one transaction; a constraint error means a concurrent write won (sibling slug or version taken).
async function commit(env, statements) {
  try {
    return await env.DB.batch(statements);
  } catch (e) {
    if (/UNIQUE constraint/.test(e.message)) return null;
    throw e;
  }
}

// POST /api/repos/:name/wiki/pages {parent_id?, title, content, message?} → 201 WikiPage at version 1.
export async function createWikiPage(request, env, { name }) {
  const body = await request.json().catch(() => null);
  const { parent_id = null, title, content, message = "" } = body ?? {};
  if (typeof title !== "string" || !title.trim()) return error(400, "bad_request", "title must be a non-empty string");
  if (typeof content !== "string" || typeof message !== "string") return error(400, "bad_request", "content and message must be strings");
  if (tooBig(content)) return error(413, "too_large", "content is capped at 200 KiB");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  if (parent_id !== null && !(await pageOf(env, name, parent_id))) return error(400, "bad_request", `no parent page ${parent_id}`);
  const w = await wiki(env);
  if (!w) return missing();
  const id = crypto.randomUUID(), at = new Date().toISOString();
  const ok = await commit(env, [
    env.DB.prepare(`INSERT INTO wiki_pages (id, repo_id, parent_id, title, slug, content, sort_order, created_at, updated_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, COALESCE(MAX(sort_order), 0) + 1, ?7, ?7 FROM wiki_pages WHERE repo_id = ?2 AND COALESCE(parent_id, '') = COALESCE(?3, '')`)
      .bind(id, repo.id, parent_id, title, await slugFor(env, repo.id, parent_id, title), content, at),
    edited(env, request, id, at),
  ]);
  if (!ok) return error(409, "conflict", "a sibling took that slug; retry");
  try {
    await save(w.repo, w.head, request, name, id, content, message);
  } catch (e) {
    await env.DB.prepare("DELETE FROM wiki_pages WHERE id = ?").bind(id).run();
    if (e.code === "conflict") return error(409, "conflict", "the wiki changed while saving; retry");
    throw e;
  }
  return Response.json(await shown(env, await pageOf(env, name, id)), { status: 201 });
}

const flag = (env, id, on) => (on ? env.DB.prepare("INSERT OR IGNORE INTO wiki_agent_context (page_id, flagged_at) VALUES (?, ?)").bind(id, new Date().toISOString())
  : env.DB.prepare("DELETE FROM wiki_agent_context WHERE page_id = ?").bind(id));

// PATCH /api/repos/:name/wiki/pages/:id {title?, content?, message?, base_version, agent_context?}: a direct edit; a
// content change writes version base_version + 1. 409 when base_version is not the current version. A body with only
// agent_context just flags or unflags the page: no base_version, no commit.
export async function editWikiPage(request, env, { name, id }) {
  const body = await request.json().catch(() => null);
  const { title, content, message = "", base_version, agent_context } = body ?? {};
  if (agent_context !== undefined && typeof agent_context !== "boolean") return error(400, "bad_request", "agent_context must be a boolean");
  if (agent_context !== undefined && title === undefined && content === undefined) {
    const page = await pageOf(env, name, id);
    if (!page) return error(404, "not_found", `no wiki page ${id}`);
    await flag(env, id, agent_context).run();
    return Response.json(await shown(env, page));
  }
  if (!Number.isInteger(base_version)) return error(400, "bad_request", "base_version must be an integer");
  if (title !== undefined && (typeof title !== "string" || !title.trim())) return error(400, "bad_request", "title must be a non-empty string");
  if ((content !== undefined && typeof content !== "string") || typeof message !== "string") return error(400, "bad_request", "content and message must be strings");
  if (title === undefined && content === undefined) return error(400, "bad_request", "nothing to edit");
  if (content !== undefined && tooBig(content)) return error(413, "too_large", "content is capped at 200 KiB");
  const page = await pageOf(env, name, id);
  if (!page) return error(404, "not_found", `no wiki page ${id}`);
  const w = await wiki(env);
  if (!w) return missing();
  const { head, list } = await historyOf(w.repo, id);
  if (list.length !== base_version) return error(409, "stale", `page is at version ${list.length}, not ${base_version}`);
  if (content !== undefined) {
    try {
      await save(w.repo, head, request, name, id, content, message);
    } catch (e) {
      if (e.code === "conflict") return error(409, "stale", "the page changed while saving; reload and retry");
      throw e;
    }
  }
  // lazy: the index follows git last-writer-wins; two saves landing in order can index in the other order until the next save.
  const slug = title === undefined ? page.slug : await slugFor(env, page.repo_id, page.parent_id, title, id);
  const at = new Date().toISOString();
  const done = await commit(env, [env.DB.prepare("UPDATE wiki_pages SET title = ?, slug = ?, content = ?, updated_at = ? WHERE id = ?")
    .bind(title ?? page.title, slug, content ?? page.content, at, id), edited(env, request, id, at), ...(agent_context === undefined ? [] : [flag(env, id, agent_context)])]);
  if (!done) return error(409, "conflict", "a sibling took that slug; retry");
  return Response.json(await shown(env, await pageOf(env, name, id)));
}

// PATCH /api/repos/:name/wiki/pages/:id/move {parent_id, sort_order}: parent_id null is the top level; a page can't
// move under itself or its descendants.
export async function moveWikiPage(request, env, { name, id }) {
  const body = await request.json().catch(() => null);
  const { parent_id = null, sort_order } = body ?? {};
  if (!Number.isInteger(sort_order) || (parent_id !== null && typeof parent_id !== "string")) {
    return error(400, "bad_request", "sort_order must be an integer and parent_id a page id or null");
  }
  const page = await pageOf(env, name, id);
  if (!page) return error(404, "not_found", `no wiki page ${id}`);
  if (parent_id !== null) {
    const { results } = await env.DB.prepare(`WITH RECURSIVE up(id, parent_id) AS (
      SELECT id, parent_id FROM wiki_pages WHERE id = ? AND repo_id = ?
      UNION SELECT p.id, p.parent_id FROM wiki_pages p JOIN up ON p.id = up.parent_id) SELECT id FROM up`).bind(parent_id, page.repo_id).all();
    if (results.length === 0) return error(400, "bad_request", `no parent page ${parent_id}`);
    if (results.some((r) => r.id === id)) return error(400, "cycle", "a page can't move under itself or its own children");
  }
  const slug = await slugFor(env, page.repo_id, parent_id, page.title, id);
  const ok = await commit(env, [env.DB.prepare("UPDATE wiki_pages SET parent_id = ?, sort_order = ?, slug = ?, updated_at = ? WHERE id = ?")
    .bind(parent_id, sort_order, slug, new Date().toISOString(), id)]);
  if (!ok) return error(409, "conflict", "a sibling took that slug; retry");
  return Response.json(await shown(env, await pageOf(env, name, id)));
}

// DELETE /api/repos/:name/wiki/pages/:id: children and versions go with it (ON DELETE CASCADE).
export async function deleteWikiPage(request, env, { name, id }) {
  const { meta } = await env.DB.prepare("DELETE FROM wiki_pages WHERE id = ? AND repo_id = (SELECT id FROM repos WHERE name = ?)").bind(id, name).run();
  return meta.changes ? new Response(null, { status: 204 }) : error(404, "not_found", `no wiki page ${id}`);
}

// On change_id's merge: flags the repo's pages whose title or content names one of symbols ("path#name") as stale, and
// raises a Stale wiki page need per page.
export async function flagStalePages(db, repoId, changeId, symbols) {
  const names = [...new Set(symbols.map((s) => s.split("#")[1]).filter(Boolean))];
  if (!names.length) return;
  // Each name quoted, so a symbol is never FTS5 syntax.
  const match = names.map((n) => `"${n.replaceAll('"', '""')}"`).join(" OR ");
  const { results } = await db.prepare(
    "INSERT OR REPLACE INTO wiki_stale (page_id, change_id, flagged_at) SELECT s.page_id, ?1, ?2 FROM wiki_search s " +
    "JOIN wiki_pages p ON p.id = s.page_id WHERE p.repo_id = ?3 AND wiki_search MATCH ?4 RETURNING page_id, (SELECT title FROM wiki_pages WHERE id = page_id) AS title",
  ).bind(changeId, new Date().toISOString(), repoId, match).all();
  await raiseNeeds(db, repoId, results.map((p) => ({ kind: "Stale wiki page", change: changeId, text: `${p.title} names code ${changeId} changed`,
    actions: ["Mark reviewed", "Edit", "Hand to agent"], subject: { page: p.page_id, title: p.title } })));
}

// Version v (as in the URL) of page id in repo name's folder with its content, plus head, the wiki's head; null when either is missing.
async function versionOf(wikiRepo, env, name, id, v) {
  if (!(await pageOf(env, name, id))) return null;
  const { head, list } = await historyOf(wikiRepo, id);
  const c = list[Number(v) - 1];
  if (!c) return null;
  const content = await (await wikiRepo.readFile({ ref: c.hash, path: fileOf(name, id) }))?.text();
  return { ...versionRow(id, c, Number(v) - 1), content: content ?? "", head };
}

// GET /api/repos/:name/wiki/pages/:id/history → WikiVersion[] newest first, without content, from the wiki's git log.
export async function listWikiHistory(request, env, { name, id }) {
  const w = await wiki(env);
  if (!w) return missing();
  if (!(await pageOf(env, name, id))) return error(404, "not_found", `no wiki page ${id}`);
  return Response.json((await historyOf(w.repo, id)).list.map((c, i) => versionRow(id, c, i)).reverse());
}

// GET /api/repos/:name/wiki/pages/:id/diff?from&to → {from, to, lines}: lines as lineDiff (" ", "-", "+" prefixes).
export async function diffWikiPage(request, env, { name, id }) {
  const params = new URL(request.url).searchParams;
  const [from, to] = [params.get("from"), params.get("to")];
  if (!/^\d+$/.test(from ?? "") || !/^\d+$/.test(to ?? "")) return error(400, "bad_request", "from and to must be version numbers");
  const w = await wiki(env);
  if (!w) return missing();
  const [a, b] = [await versionOf(w.repo, env, name, id, from), await versionOf(w.repo, env, name, id, to)];
  if (!a || !b) return error(404, "not_found", `no version ${a ? to : from} of wiki page ${id}`);
  return Response.json({ from: a.version, to: b.version, lines: lineDiff(a.content, b.content) });
}

// POST /api/repos/:name/wiki/pages/:id/restore/:v → WikiPage after a new commit holding v's content; history is kept.
export async function restoreWikiVersion(request, env, { name, id, v }) {
  const w = await wiki(env);
  if (!w) return missing();
  const old = await versionOf(w.repo, env, name, id, v);
  if (!old) return error(404, "not_found", `no version ${v} of wiki page ${id}`);
  try {
    await save(w.repo, old.head, request, name, id, old.content, `Restored to v${old.version}`);
  } catch (e) {
    if (e.code === "conflict") return error(409, "stale", "the page changed while restoring; reload and retry");
    throw e;
  }
  const at = new Date().toISOString();
  await env.DB.batch([env.DB.prepare("UPDATE wiki_pages SET content = ?, updated_at = ? WHERE id = ?").bind(old.content, at, id), edited(env, request, id, at)]);
  return Response.json(await shown(env, await pageOf(env, name, id)));
}
