import { lineDiff } from "./agents.js";
import { createArtifacts } from "./artifacts.js";
import { error, holdsJob } from "./router.js";

const MAX_FILE_BYTES = 1024 * 1024;
const LOG_PAGE = 50;
const MAX_DIFF_LINES = 2000;

// :ref is an integration branch, or a change id that resolves to its fork at the fork's current head.
// ?sha pins the commit: no head lookup, and tree, file and log answers carry an immutable Cache-Control.
export async function resolve(request, env, name) {
  const url = new URL(request.url);
  const ref = url.searchParams.get("ref");
  const path = url.searchParams.get("path") ?? "";
  const pinned = url.searchParams.get("sha");
  if (!ref) return { res: error(400, "bad_request", "ref query parameter is required") };
  if (pinned !== null && !/^[0-9a-f]{40,64}$/.test(pinned)) return { res: error(400, "bad_request", "sha must be a commit sha") };
  const repo = await env.DB.prepare("SELECT r.id, r.default_branch, c.id AS change_id, n.fork, c.target_branch FROM repos r LEFT JOIN changes c ON c.id = ?2 AND c.repo_id = r.id LEFT JOIN change_numbers n ON n.change_id = c.id WHERE r.name = ?1")
    .bind(name, ref).first();
  if (!repo) return { res: error(404, "not_found", `no repo ${name}`) };
  // The fork name newChange (changes.js) stored.
  const store = repo.change_id ? repo.fork : name;
  const branch = repo.change_id ? repo.target_branch : ref;
  const artifacts = createArtifacts(env.ARTIFACTS);
  const cache = env.REPO_DO.get(env.REPO_DO.idFromName(store));
  let sha = pinned;
  if (!sha) {
    const heads = await cache.heads();
    sha = heads.refs.get(branch);
    if (!sha) {
      sha = (await artifacts.log(store, branch))[0]?.sha;
      if (sha) await cache.setHead(heads.epoch, branch, sha);
    }
  }
  if (!sha) {
    // No commits on the default branch means nothing is pushed yet, so every ref is empty rather than unknown.
    if ((await artifacts.log(store, repo.default_branch)).length) return { res: error(404, "ref_not_found", `unknown ref ${ref}`) };
    return { res: error(404, "not_found", `no commits at ${ref}`), empty: true, ref, path };
  }
  return { repo, artifacts, cache, store, ref, sha, path, branch, pinned: !!pinned };
}

const immutable = (r) => (r.pinned ? { headers: { "Cache-Control": "private, max-age=31536000, immutable" } } : undefined);

// An answer addressed by r.sha, from the store's Durable Object, else load()ed and kept there unless null.
async function atSha(r, key, load) {
  const hit = await r.cache.cached(key);
  if (hit !== undefined) return hit;
  const value = await load();
  // An answer over the storage's value size isn't kept; the next read loads it again.
  if (value) await r.cache.cache(key, value).catch((e) => console.error(`code: caching ${key} failed: ${e.message}`));
  return value;
}

export async function getTree(request, env, { name }) {
  const start = performance.now();
  const r = await resolve(request, env, name);
  // resolve: the repo row and the ref's head (the store's Durable Object, else an Artifacts log read).
  const resolved = `resolve;dur=${(performance.now() - start).toFixed(1)}`;
  // The root listing carries the repo's clone URL for the Code page's Clone button and Quick setup; never a token.
  const remoteOf = async () => (r.path ? undefined : (await (await createArtifacts(env.ARTIFACTS).get(name))?.info())?.remote);
  if (r.empty) return Response.json({ ref: r.ref, sha: null, path: r.path, entries: [], empty: true, remote: await remoteOf() });
  if (r.res) return r.res;
  // ?recursive lists every entry of the commit in one answer.
  const all = new URL(request.url).searchParams.has("recursive");
  if (all && r.path) return error(400, "bad_request", "recursive lists the whole tree; path must be empty");
  const tree = await atSha(r, `tree:${r.sha}:${all}:${r.path}`, async () => {
    const entries = all ? await r.artifacts.listTree(r.store, r.sha) : await r.artifacts.readTree(r.store, r.sha, r.path);
    if (!entries?.length) return null;
    return { entries, remote: await remoteOf() };
  });
  if (!tree) return error(404, "not_found", `no directory ${r.path || "/"} at ${r.ref}`);
  return Response.json({ ref: r.ref, sha: r.sha, path: r.path, ...tree },
    { headers: { ...immutable(r)?.headers, "Server-Timing": `${resolved}, total;dur=${(performance.now() - start).toFixed(1)}` } });
}

export async function getFile(request, env, { name }) {
  const r = await resolve(request, env, name);
  if (r.res) return r.res;
  const file = await atSha(r, `file:${r.sha}:${r.path}`, async () => {
    const text = await r.artifacts.readFile(r.store, r.sha, r.path);
    if (text == null) return null;
    // lazy: reads the whole blob to size it; ask the binding for size alone if large files get common.
    const size = new Blob([text]).size;
    return { size, content: size > MAX_FILE_BYTES ? null : text };
  });
  if (!file) return error(404, "not_found", `no file ${r.path} at ${r.ref}`);
  return Response.json({ ref: r.ref, sha: r.sha, path: r.path, ...file }, immutable(r));
}

const IMAGE = { png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp", avif: "image/avif", svg: "image/svg+xml", ico: "image/x-icon" };

// ?path's bytes at ?ref, for a README's relative images. Only image types are named; anything else is a download. The API's
// own CSP (default-src 'none') keeps an SVG's scripts from running even when it is opened directly.
export async function getRaw(request, env, { name }) {
  const r = await resolve(request, env, name);
  if (r.res) return r.res;
  const blob = await r.artifacts.readBlob(r.store, r.sha, r.path);
  if (!blob) return error(404, "not_found", `no file ${r.path} at ${r.ref}`);
  return new Response(blob.stream(), { headers: { "Content-Type": IMAGE[r.path.split(".").at(-1).toLowerCase()] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff", ...immutable(r)?.headers } });
}

// Who wrote each line of ?path at ?ref: 200 once blamed at the ref's head, 202 (lines null) once its blame job is queued.
export async function getAuthorship(request, env, { name }) {
  const r = await resolve(request, env, name);
  if (r.res) return r.res;
  if (!r.path) return error(400, "bad_request", "path query parameter is required");
  const lines = await blame(env, r);
  return Response.json({ ref: r.ref, sha: r.sha, path: r.path, lines }, { status: lines ? 200 : 202 });
}

// The blame of r.path at r.sha, or null once its blame job is queued.
async function blame(env, r) {
  const row = await env.DB.prepare("SELECT lines FROM authorship WHERE repo_id = ? AND sha = ? AND path = ?").bind(r.repo.id, r.sha, r.path).first();
  if (row) return JSON.parse(row.lines);
  await env.DB.prepare(
    "INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) SELECT ?1, ?2, 'blame', 'queued', ?3, ?4 " +
    "WHERE NOT EXISTS (SELECT 1 FROM jobs WHERE repo_id = ?2 AND kind = 'blame' AND status IN ('queued', 'claimed') AND payload = ?4)",
  ).bind(crypto.randomUUID(), r.repo.id, new Date().toISOString(), JSON.stringify({ store: r.store, sha: r.sha, path: r.path })).run();
  return null;
}

// Runner route: the blame job's result for ?path at :sha, `cinder-verify blame` output.
export async function putAuthorship(request, env, { name, sha }) {
  const path = new URL(request.url).searchParams.get("path");
  if (!path) return error(400, "bad_request", "path query parameter is required");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  if (!(await holdsJob(request, env, repo.id, "blame"))) return error(403, "forbidden", `this runner holds no blame job of ${name}`);
  const lines = await request.json().catch(() => null);
  const bad = !Array.isArray(lines) ? -1 : lines.findIndex((l) => typeof l?.commit !== "string" || !l.commit
    || !(typeof l.agent === "string" && l.agent) === !(typeof l.person === "string" && l.person)
    || (l.change !== undefined && typeof l.change !== "string"));
  if (bad !== -1) return error(400, "bad_request", `body${bad < 0 ? "" : `[${bad}]`}: expected a list of {commit, change?, agent | person}`);
  await env.DB.prepare("INSERT OR REPLACE INTO authorship VALUES (?, ?, ?, ?)").bind(repo.id, sha, path, JSON.stringify(lines)).run();
  return new Response(null, { status: 204 });
}

const authorOf = (c) => (typeof c.author === "string" ? c.author : c.author?.name ?? null);
// A log commit as CodeLog lists it (api/shapes/code-log.js).
export const logEntry = (c) => ({ sha: c.sha, message: c.message ?? "", author: authorOf(c), date: c.authoredAt ? new Date(c.authoredAt * 1000).toISOString() : null });

// GET ?ref&path&page: the commits at ref, newest first, 50 a page from page 1; more says a next page exists.
// With a path, only those that changed it (file history).
// lazy: one file read per commit, 50 a page; ask a runner for `git log -- path` once histories get long.
export async function getLog(request, env, { name }) {
  const r = await resolve(request, env, name);
  if (r.res) return r.res;
  const page = Number(new URL(request.url).searchParams.get("page") ?? 1);
  if (!Number.isInteger(page) || page < 1) return error(400, "bad_request", "page must be a whole number from 1");
  const history = await atSha(r, `log:${r.sha}:${page}:${r.path}`, async () => {
    const all = await r.artifacts.log(r.store, r.sha);
    const log = all.slice((page - 1) * LOG_PAGE, page * LOG_PAGE + 1);
    const texts = r.path ? await Promise.all(log.map((c) => r.artifacts.readFile(r.store, c.sha, r.path))) : [];
    const commits = log.slice(0, LOG_PAGE).filter((c, i) => !r.path || texts[i] !== (texts[i + 1] ?? null))
      .map(logEntry);
    return { commits, more: log.length > LOG_PAGE, ...(!r.path && { total: all.length }) };
  });
  return Response.json({ ref: r.ref, sha: r.sha, path: r.path, ...history, commits: history.commits }, immutable(r));
}

// GET /commits/:sha?ref → CommitDiff (api/shapes/commit-diff.js): the commit in ref's store and, per changed file, a
// line diff (lineDiff's prefixes) against the commit log lists next; lines is null past 2000 lines a side.
// lazy: a merge diffs against whichever parent log lists next; ask a runner for `git show` once merges matter.
export async function getCommit(request, env, { name, sha }) {
  const r = await resolve(request, env, name);
  if (r.res) return r.res;
  const [c, parent] = await r.artifacts.log(r.store, sha);
  if (c?.sha !== sha) return error(404, "not_found", `no commit ${sha}`);
  const files = await diffFiles(r.artifacts, r.store, parent?.sha ?? null, sha);
  return Response.json({ sha, parent: parent?.sha ?? null, message: c.message ?? "", author: authorOf(c), files });
}

// The files that differ between commits base (null: none) and head in store, as CommitDiff files. Trees are compared
// by hash, so only differing subtrees are walked and only differing blobs read; the result is cached per sha pair.
export async function diffFiles(artifacts, store, base, head) {
  // Commits are immutable, so a pair's diff never changes; store keeps one repo's cache entry from serving another.
  const key = new Request(`https://cinder.cache/diff/${encodeURIComponent(store)}/${base ?? "-"}/${head}`);
  const hit = await caches.default.match(key);
  if (hit) return hit.json();
  const changed = [];
  const walk = async (a, b, dir) => {
    const [ea, eb] = await Promise.all([a ? artifacts.readTreeHash(store, a) : null, b ? artifacts.readTreeHash(store, b) : null]);
    const before = new Map((ea ?? []).map((e) => [e.name, e]));
    const after = new Map((eb ?? []).map((e) => [e.name, e]));
    for (const n of new Set([...before.keys(), ...after.keys()])) {
      const [x, y] = [before.get(n), after.get(n)];
      if (x?.hash === y?.hash) continue;
      const path = dir ? `${dir}/${n}` : n;
      const [xt, yt] = [x?.type === "tree", y?.type === "tree"];
      if (xt || yt) await walk(xt ? x.hash : null, yt ? y.hash : null, path);
      if ((x && !xt) || (y && !yt)) changed.push({ path, a: x && !xt, b: y && !yt });
    }
  };
  await walk(base && await artifacts.rootTree(store, base), await artifacts.rootTree(store, head), "");
  const files = [];
  for (const f of changed.sort((x, y) => (x.path < y.path ? -1 : 1))) {
    const [a, b] = await Promise.all([f.a ? artifacts.readFile(store, base, f.path) : null, f.b ? artifacts.readFile(store, head, f.path) : null]);
    if (a === b) continue;
    const big = [a, b].some((t) => t?.split("\n").length > MAX_DIFF_LINES);
    const lines = big ? null : lineDiff(a ?? "", b ?? "");
    files.push({ path: f.path, status: a === null ? "added" : b === null ? "deleted" : "modified", lines });
  }
  await caches.default.put(key, Response.json(files, { headers: { "Cache-Control": "max-age=31536000, immutable" } }));
  return files;
}

// Replaces store's code search index of branch with the files at sha: on every push (pushes.js), API commit (commits.js),
// and on search when the ref's head has no index yet (imports, branch creates).
// lazy: reads every file per push into one D1 batch; have the runner index job send contents past ~1k files.
export async function indexCode(env, store, branch, sha) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  const stmts = [env.DB.prepare("DELETE FROM code_search WHERE store = ? AND ref = ?").bind(store, branch)];
  const walk = async (dir) => {
    for (const e of (await artifacts.readTree(store, sha, dir)) ?? []) {
      if (e.type === "tree") await walk(e.path);
      else {
        const text = await artifacts.readFile(store, sha, e.path);
        if (text != null && text.length <= MAX_FILE_BYTES) {
          stmts.push(env.DB.prepare("INSERT INTO code_search (store, ref, sha, path, content) VALUES (?, ?, ?, ?, ?)").bind(store, branch, sha, e.path, text));
        }
      }
    }
  };
  // A deleted branch (zero sha) only clears its index.
  if (!/^0+$/.test(sha)) await walk("");
  await env.DB.batch(stmts);
}

// GET ?ref&q: lines holding q (any case) in the files at ref, at most 200, from the index of ref's head, built first if missing.
export async function searchCode(request, env, { name }) {
  const r = await resolve(request, env, name);
  if (r.res) return r.res;
  const q = (new URL(request.url).searchParams.get("q") ?? "").toLowerCase();
  if (q.length < 2 || q.length > 256) return error(400, "bad_request", "q must be 2 to 256 characters");
  if (!(await env.DB.prepare("SELECT 1 FROM code_search WHERE store = ? AND sha = ? LIMIT 1").bind(r.store, r.sha).first())) await indexCode(env, r.store, r.branch, r.sha);
  // DISTINCT: refs at one sha each keep their own copy of the index.
  const { results } = await env.DB.prepare("SELECT DISTINCT path, content FROM code_search WHERE store = ? AND sha = ? AND content LIKE ? ESCAPE '\\' ORDER BY path")
    .bind(r.store, r.sha, `%${q.replace(/[\\%_]/g, "\\$&")}%`).all();
  const hits = [];
  for (const f of results) {
    f.content.split("\n").forEach((text, i) => {
      if (hits.length < 200 && text.toLowerCase().includes(q)) hits.push({ path: f.path, line: i + 1, text: text.slice(0, 500) });
    });
  }
  return Response.json(hits);
}
