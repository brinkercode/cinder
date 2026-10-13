// Review threads anchored to a line of a change's diff. A head move re-maps each new-side anchor through the line diff of
// its file; a thread whose anchored line changed or vanished is marked outdated and stays at its last head_sha.
import { personOf } from "./access.js";
import { lineDiff } from "./agents.js";
import { createArtifacts } from "./artifacts.js";
import { error } from "./router.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
const now = () => new Date().toISOString();

export async function threadsOf(env, changeId, threadId = null) {
  const { results } = await env.DB.prepare("SELECT id, path, side, line, head_sha, original_lines, outdated, resolved, state_by, state_at, (SELECT applied_sha FROM review_thread_applied a WHERE a.thread_id = review_threads.id) AS applied_sha FROM review_threads WHERE change_id = ?1 AND (?2 IS NULL OR id = ?2) ORDER BY created_at, id")
    .bind(changeId, threadId).all();
  const { results: comments } = await env.DB.prepare(
    "SELECT thread_id, actor, body, at FROM review_comments WHERE thread_id IN (SELECT id FROM review_threads WHERE change_id = ?) ORDER BY at, rowid",
  ).bind(changeId).all();
  return results.map(({ original_lines, outdated, resolved, ...t }) => {
    const thread = comments.filter((c) => c.thread_id === t.id).map(({ actor, body, at }) => ({ actor, body, at }));
    const fence = fenceOf(thread);
    return { ...t, original_lines: JSON.parse(original_lines), outdated: outdated === 1, resolved: resolved === 1, comments: thread,
      // Only a new-side line has text to replace: from is that line, to the latest suggestion's lines.
      suggestion: t.side === "new" && fence !== undefined ? { from: JSON.parse(original_lines)[0], to: fence.replace(/\n$/, "") } : null };
  });
}

// The latest ```suggestion fence's content (every line newline-terminated; "" deletes the line), or undefined.
const fenceOf = (comments) => comments.map((c) => /^```suggestion[^\n]*\n([\s\S]*?)^```/m.exec(c.body)).filter(Boolean).at(-1)?.[1];

// GET /api/changes/:id/threads
export async function listThreads(request, env, { id }) {
  if (!(await changeDO(env, id).get())) return error(404, "not_found", `no change ${id}`);
  return Response.json(await threadsOf(env, id));
}

// POST /api/changes/:id/threads {body, path?, side?, line?}: a new-side anchor is pinned to the change's current head.
export async function createThread(request, env, { id }) {
  const change = await changeDO(env, id).get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const body = await request.json().catch(() => null);
  if (typeof body?.body !== "string" || !body.body.trim()) return error(400, "bad_request", "body must be a non-empty string");
  const { path = null, side = null, line = null } = body;
  const anchored = path !== null;
  if (anchored && (typeof path !== "string" || !path || !["old", "new"].includes(side) || !Number.isInteger(line) || line < 1)) {
    return error(400, "bad_request", "an anchored thread needs path, side (old or new) and line >= 1");
  }
  if (!anchored && (side !== null || line !== null)) return error(400, "bad_request", "side and line need a path");
  return openThread(env, change, { path, side, line, body: body.body }, personOf(request));
}

// Opens a thread with its first comment by actor; a new-side anchor is pinned to the change's current head.
export async function openThread(env, change, { path = null, side = null, line = null, body }, actor) {
  const id = change.id;
  let head = null, original = null;
  // Old-side anchors sit on the target's code, which a head move does not change, so only new-side text is kept to re-map.
  if (side === "new") {
    head = await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(id).first("head_sha");
    if (!head) return error(409, "no_head", `change ${id} has no head yet`);
    const text = await createArtifacts(env.ARTIFACTS).readFile(change.fork, head, path);
    const lines = text?.split("\n");
    if (!lines || line > lines.length) return error(422, "no_line", `${path} has no line ${line} at ${head}`);
    original = [lines[line - 1]];
  }
  const thread = crypto.randomUUID(), at = now();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO review_threads (id, change_id, path, side, line, head_sha, original_lines, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(thread, id, path, side, line, head, JSON.stringify(original), at),
    env.DB.prepare("INSERT INTO review_comments (id, thread_id, actor, body, at) VALUES (?, ?, ?, ?, ?)")
      .bind(crypto.randomUUID(), thread, actor, body, at),
  ]);
  return Response.json((await threadsOf(env, id, thread))[0], { status: 201 });
}

const threadOf = (env, id, t) => env.DB.prepare("SELECT id FROM review_threads WHERE id = ? AND change_id = ?").bind(t, id).first();

// POST /api/changes/:id/threads/:t/comments {body}
export async function addComment(request, env, { id, t }) {
  if (!(await threadOf(env, id, t))) return error(404, "not_found", `no thread ${t} on change ${id}`);
  const body = await request.json().catch(() => null);
  if (typeof body?.body !== "string" || !body.body.trim()) return error(400, "bad_request", "body must be a non-empty string");
  await env.DB.prepare("INSERT INTO review_comments (id, thread_id, actor, body, at) VALUES (?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), t, personOf(request), body.body, now()).run();
  return Response.json((await threadsOf(env, id, t))[0], { status: 201 });
}

// POST /api/changes/:id/threads/:t/resolve and …/reopen
export async function resolveThread(request, env, params) {
  return setResolved(request, env, params, 1);
}

export async function reopenThread(request, env, params) {
  return setResolved(request, env, params, 0);
}

async function setResolved(request, env, { id, t }, resolved) {
  if (!(await threadOf(env, id, t))) return error(404, "not_found", `no thread ${t} on change ${id}`);
  await env.DB.prepare("UPDATE review_threads SET resolved = ?, state_by = ?, state_at = ? WHERE id = ?").bind(resolved, personOf(request), now(), t).run();
  return Response.json((await threadsOf(env, id, t))[0]);
}

// POST /api/changes/:id/threads/:t/apply: splices the thread's latest ```suggestion fence over its anchored line at the
// change's head and queues a commit job on the fork whose commit names the thread; the thread is resolved.
export async function applySuggestion(request, env, { id, t }) {
  const change = await changeDO(env, id).get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const [thread] = await threadsOf(env, id, t);
  if (!thread) return error(404, "not_found", `no thread ${t} on change ${id}`);
  if (change.driver !== personOf(request)) return error(409, "not_driving", `take over ${id} before applying a suggestion`);
  const fence = fenceOf(thread.comments);
  if (thread.side !== "new" || fence === undefined) return error(422, "no_suggestion", `thread ${t} has no suggestion on a new-side line`);
  const head = await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(id).first("head_sha");
  // A head the thread was not re-mapped to yet is as unsafe as an outdated anchor: the line may have moved.
  if (thread.outdated || thread.head_sha !== head) return error(409, "outdated", `thread ${t} is outdated`);
  const lines = (await createArtifacts(env.ARTIFACTS).readFile(change.fork, head, thread.path))?.split("\n");
  if (lines?.[thread.line - 1] !== thread.original_lines[0]) return error(409, "outdated", `thread ${t} is outdated`);
  // An empty fence deletes the line; otherwise the fence's lines replace it (the newline before the closing fence is not content).
  lines.splice(thread.line - 1, 1, ...(fence === "" ? [] : fence.slice(0, -1).split("\n")));
  const payload = { lease: [], path: thread.path, content: lines.join("\n"), base_sha: head, thread: t };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload) VALUES (?, ?, 'commit', ?, 'queued', ?, ?)")
      .bind(crypto.randomUUID(), change.repo_id, id, now(), JSON.stringify(payload)),
    env.DB.prepare("UPDATE review_threads SET resolved = 1, state_by = ?, state_at = ? WHERE id = ?").bind(personOf(request), now(), t),
  ]);
  return Response.json((await threadsOf(env, id, t))[0], { status: 202 });
}

// Re-maps every live new-side anchor of the change from its own head_sha to `after`, read from the change's fork.
// lazy: reads each file twice per thread; group by (path, head_sha) past a few dozen threads per change.
export async function remapThreads(env, changeId, fork, after) {
  const { results } = await env.DB.prepare("SELECT id, path, line, head_sha, original_lines FROM review_threads WHERE change_id = ? AND side = 'new' AND outdated = 0 AND head_sha != ?")
    .bind(changeId, after).all();
  if (!results.length) return;
  const artifacts = createArtifacts(env.ARTIFACTS);
  for (const t of results) {
    const [before, next] = await Promise.all([artifacts.readFile(fork, t.head_sha, t.path), artifacts.readFile(fork, after, t.path)]);
    let line = null;
    if (before !== null && next !== null) {
      let i = 0, j = 0;
      for (const d of lineDiff(before, next)) {
        if (d[0] === " " && i === t.line - 1) line = j + 1;
        if (d[0] !== "+") i++;
        if (d[0] !== "-") j++;
      }
    }
    // A kept line is unchanged text, so a moved anchor still matches original_lines; anything else changed it.
    const stmt = line === null
      ? env.DB.prepare("UPDATE review_threads SET outdated = 1 WHERE id = ?").bind(t.id)
      : env.DB.prepare("UPDATE review_threads SET line = ?, head_sha = ? WHERE id = ?").bind(line, after, t.id);
    await stmt.run();
  }
}
