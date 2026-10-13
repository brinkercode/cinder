import { groupsOf, isOwnerEmail, personOf } from "./access.js";
import { AGENTS_REPO } from "./agents.js";
import { flowFileErrors } from "./api/shapes/flow.js";
import { createArtifacts } from "./artifacts.js";
import { REVERIFY, verifyHead } from "./changes.js";
import { indexCode } from "./code.js";
import { commit, setBranch } from "./git/index.js";
import { can } from "./people.js";
import { onPushes } from "./pushes.js";
import { error, runnerOf } from "./router.js";

const MAX_BYTES = 2 * 1024 * 1024;
const MODES = ["100644", "100755"];
// Ref-safe: no spaces, control characters or "..", so it can't break the pkt-line it is written into.
export const BRANCH = /^[\w-][\w.-]*(\/[\w-][\w.-]*)*$/;
// Empty, ".", ".." or .git segments: absolute paths, escapes and writes into git's own directory.
const badPath = (p) => typeof p !== "string" || p.split("/").some((s) => !s || s === "." || s === ".." || s.toLowerCase() === ".git");

// The commit's author, or null when the caller may not write to name: an owner anywhere, a person with repo.write on it,
// a runner in the fork (a changes.fork) of a change it holds a live job for, as the job's agent version (job: its kind).
// A person needs the capability of pathname (the request's own by default).
export async function authorOf(request, env, name, pathname = new URL(request.url).pathname) {
  const runner = await runnerOf(request, env);
  if (runner) {
    const job = await env.DB.prepare("SELECT coalesce(json_extract(payload, '$.agent'), 'cinder-agent') AS agent, kind FROM jobs " +
      "WHERE change_id = (SELECT change_id FROM change_numbers WHERE fork = ?) AND runner_id = ? AND status = 'claimed' AND lease_expires_at > ?").bind(name, runner.runner_id, new Date().toISOString()).first();
    return job ? { name: job.agent, email: `${runner.runner_id}@runners.cinder`, job: job.kind } : null;
  }
  const person = personOf(request);
  const allowed = person === "owner" || isOwnerEmail(env, person) || await can(env, person, request.method, pathname, null, groupsOf(request));
  return allowed ? { name: person, email: person.includes("@") ? person : `${person}@cinder` } : null;
}

// POST /api/repos/:name/commits {branch, base_sha, message, changes: [{path, content | delete, mode?}], tag?}: one commit on
// branch (base_sha null starts a new branch), tagged when tag is set. An agent/<name>/vN tag on the agents repo releases
// that version, its lock the message.
export async function createCommit(request, env, { name }, ctx) {
  // The lookups start together and are awaited in the order they refuse; the catch() marks one an early return leaves unread
  // as handled, and an await still sees its rejection.
  const start = performance.now();
  const ms = {};
  const authorized = authorOf(request, env, name).finally(() => { ms.auth = performance.now() - start; });
  const archived = env.DB.prepare("SELECT 1 FROM repos JOIN repo_meta m ON m.repo_id = repos.id WHERE name = ? AND m.archived_at IS NOT NULL").bind(name).first();
  const found = createArtifacts(env.ARTIFACTS).get(name);
  const policy = env.DB.prepare("SELECT default_branch FROM repos WHERE name = ?").bind(name).first("default_branch")
    .then((b) => b && env.REPO_DO.get(env.REPO_DO.idFromName(name)).policy(name, b)).finally(() => { ms.policy = performance.now() - start; });
  for (const p of [archived, found, policy]) p.catch(() => {});
  const author = await authorized;
  if (!author) return error(403, "forbidden", `you may not commit to ${name}`);
  const id = await env.DB.prepare("SELECT change_id FROM change_numbers WHERE fork = ?").bind(name).first("change_id");
  const change = id && await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get();
  // A person's change takes an agent's commits only when its driver allowed them; a commit job applies the person's own edit.
  if (["develop", "resolve"].includes(author.job) && change?.driver && change.agent_pushes === false) {
    // A commit request carries one commit; the timeline offers the driver Allow agent pushes from this event.
    await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).stageEvent({ kind: "agent_push_refused", agent: author.name, commits: 1,
      actor: { type: "system", id: "cinder" }, action: "change.push", target: id, result: "refused" });
    return error(403, "agent_push_refused", `${change.driver} drives change ${id} and has not let agents push to it`);
  }
  if (await archived) return error(409, "archived", `${name} is archived; unarchive it to push`);
  const raw = await request.arrayBuffer();
  if (raw.byteLength > MAX_BYTES) return error(413, "too_large", "a commit request is at most 2 MiB");
  let body = null;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    // reported as a bad request below
  }
  const { branch, base_sha: base, message, changes, tag } = body ?? {};
  if (typeof branch !== "string" || !BRANCH.test(branch) || branch.includes("..")) return error(400, "bad_request", "branch must be a valid branch name");
  if (base !== null && !/^[0-9a-f]{40}$/.test(base ?? "")) return error(400, "bad_request", "base_sha must be a 40-character commit sha, or null for a new branch");
  if (tag !== undefined && (typeof tag !== "string" || !BRANCH.test(tag) || tag.includes(".."))) return error(400, "bad_request", "tag must be a valid tag name");
  if (typeof message !== "string" || !message.trim()) return error(400, "bad_request", "message is required");
  if (!Array.isArray(changes) || !changes.length) return error(400, "bad_request", "changes must be a non-empty array");
  for (const c of changes) {
    if (badPath(c?.path)) return error(400, "bad_request", `bad path ${JSON.stringify(c?.path)}: relative, no "." or ".." segments, not under .git`);
    if ((c.delete === true) === (typeof c.content === "string")) return error(400, "bad_request", `${c.path}: give content or delete: true`);
    if (c.mode !== undefined && !MODES.includes(c.mode)) return error(400, "bad_request", `${c.path}: mode must be one of ${MODES.join(", ")}`);
    const invalid = c.delete ? [] : flowFileErrors(c.path, c.content);
    if (invalid.length) return error(400, "invalid_flow", invalid.join("; "));
  }
  // .cinder.yml holds the branch policy, so a person needs the policy save's permission to commit it; a runner's commit lands through a change.
  if (!author.job && changes.some((c) => c.path === ".cinder.yml") && !(await authorOf(request, env, name, `/api/repos/${name}/policy`))) {
    return error(403, "forbidden", `changing .cinder.yml in ${name} needs branch.write`);
  }
  const repo = await found;
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  // An integration branch moves only through a change (and its verifier); creating one (base_sha null, an empty repo's first commit) is allowed.
  if (base && (await policy)?.integration.includes(branch)) {
    return Response.json({ error: { code: "integration_branch", message: `${branch} is an integration branch; open a change to land on it`, hint: "open a change" } }, { status: 422 });
  }
  if (tag && await env.DB.prepare("SELECT 1 FROM tags WHERE repo = ? AND name = ?").bind(name, tag).first()) return error(409, "tag_exists", `tag ${tag} exists`);
  try {
    const { timings, ...done } = await commit(repo, { branch, base, changes, message, author, tag, ours: false });
    // Only code search lags: reads after the commit come from Artifacts. Without a ctx (a direct call) it is awaited.
    const indexed = performance.now();
    const index = indexCode(env, name, branch, done.sha);
    if (ctx) ctx.waitUntil(index);
    else await index;
    ms.index = performance.now() - indexed;
    // The binding lists no refs, so the tags list (src/releases.js) reads them from here.
    if (tag) await env.DB.prepare("INSERT INTO tags (repo, name, sha, message, tagger, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(name, tag, done.sha, message, author.name, new Date().toISOString()).run();
    // Recorded now, as the agents bootstrap does, rather than when Artifacts' push event arrives (re-delivery is a no-op).
    // The marker tells onPushes cinder wrote this tag; only an agent.release holder gets here (people.js).
    if (tag && name === AGENTS_REPO) await env.DB.prepare("INSERT OR IGNORE INTO ref_writes (repo, ref, sha) VALUES (?, ?, ?)").bind(name, `refs/tags/${tag}`, done.sha).run();
    if (tag && name === AGENTS_REPO) await onPushes({ messages: [{ body: { type: "cf.artifacts.repo.pushed", source: { repoName: AGENTS_REPO },
      payload: { ref: `refs/tags/${tag}`, after: done.sha, commits: [{ message }] } } }] }, env);
    // The person driving a change committed its files (Code's Open a change, a workspace's submit): it verifies on this commit, no agent develops it.
    if (change?.driver === author.name && REVERIFY.includes(change.state)) await verifyHead(env, change, done.sha, change.state);
    const serverTiming = Object.entries({ auth: ms.auth, policy: ms.policy ?? 0, ...timings, index: ms.index }).map(([k, ms]) => `${k};dur=${ms.toFixed(1)}`).join(", ");
    return Response.json({ branch, ...done }, { status: 201, headers: { "Server-Timing": serverTiming } });
  } catch (e) {
    if (e.code === "conflict") return error(409, "conflict", e.message);
    throw e;
  }
}

// POST /api/repos/:name/seed {branch?, commits: [{author, message, files: {path: content}}]} (owner only) → 201 {shas}: the
// seed's history, one commit per entry on branch (the default branch when unset) over whatever it holds, each by its own
// author. A row whose Artifacts repo is gone (a re-import that failed after deleting it) gets a new, empty one.
// A new branch starts at from's head; a commit may be dated at (ISO), tagged tag, and merge a branch (its head the second parent).
// Only a nonprod deployment (CINDER_ENV=nonprod) has the route; elsewhere it answers 404.
export async function seedCommits(request, env, { name }) {
  if (env.CINDER_ENV !== "nonprod") return error(404, "not_found", "no such route");
  const person = personOf(request);
  if (person !== "owner" && !isOwnerEmail(env, person)) return error(403, "forbidden", "only the owner may seed a repo");
  const { branch: ref, from, commits } = (await request.json().catch(() => null)) ?? {};
  const badRef = (r) => r !== undefined && (typeof r !== "string" || !BRANCH.test(r) || r.includes(".."));
  if (badRef(ref) || badRef(from)) return error(400, "bad_request", "branch and from must be valid branch names");
  if (!Array.isArray(commits) || !commits.length) return error(400, "bad_request", "commits must be a non-empty array");
  for (const c of commits) {
    // The author is written into the commit header, so it is a plain name or email: no spaces, angle brackets or newlines.
    if (!/^[\w.-]+(@[\w.-]+)?$/.test(c?.author ?? "")) return error(400, "bad_request", "author must be a plain name or an email");
    if (typeof c.message !== "string" || !c.message.trim()) return error(400, "bad_request", "message is required");
    const files = Object.entries(c.files ?? {});
    if (!files.length || files.some(([path, text]) => badPath(path) || typeof text !== "string")) return error(400, "bad_request", "files must map relative paths to text");
    if (c.at !== undefined && Number.isNaN(Date.parse(c.at))) return error(400, "bad_request", "at must be an ISO date");
    if (badRef(c.tag)) return error(400, "bad_request", "tag must be a valid tag name");
    if (badRef(c.merge)) return error(400, "bad_request", "merge must be a valid branch name");
  }
  const fallback = await env.DB.prepare("SELECT default_branch FROM repos WHERE name = ?").bind(name).first("default_branch");
  if (!fallback) return error(404, "not_found", `no repo ${name}`);
  const branch = ref ?? fallback;
  const artifacts = createArtifacts(env.ARTIFACTS);
  let repo;
  try {
    repo = await artifacts.get(name);
    if (!repo) {
      await artifacts.create(name);
      repo = await artifacts.get(name);
    }
  } catch (e) {
    // Artifacts creates repos asynchronously; the seed's client backs off and retries repo_importing.
    if (/being created/.test(e?.message)) return error(409, "repo_importing", `${name} is being created; retry shortly`);
    throw e;
  }
  const shas = [];
  try {
    // Resolved before the first write, so a missing branch leaves the repo as it was.
    const merges = [];
    for (const { merge } of commits) {
      merges.push(merge && (await artifacts.log(name, merge))[0]?.sha);
      if (merge && !merges.at(-1)) return error(400, "bad_request", `no branch ${merge} to merge`);
    }
    let head = (await artifacts.log(name, branch))[0]?.sha ?? null;
    if (!head && from) {
      await setBranch(repo, branch, from);
      head = (await artifacts.log(name, from))[0]?.sha;
    }
    for (const [i, { author, message, files, at, tag }] of commits.entries()) {
      const changes = Object.entries(files).map(([path, content]) => ({ path, content }));
      const [user, domain = "cinder.invalid"] = author.split("@");
      const who = { name: user, email: `${user}@${domain}`, time: at && Math.floor(Date.parse(at) / 1000) };
      shas.push((await commit(repo, { branch, base: shas.at(-1) ?? head, changes, message, author: who, tag, merge: merges[i] })).sha);
      // The binding lists no refs, so the tags list (src/releases.js) reads them from here, as createCommit records them.
      if (tag) await env.DB.prepare("INSERT OR IGNORE INTO tags (repo, name, sha, message, tagger, created_at) VALUES (?, ?, ?, ?, ?, ?)")
        .bind(name, tag, shas.at(-1), message, author, at ?? new Date().toISOString()).run();
    }
    await indexCode(env, name, branch, shas.at(-1));
  } catch (e) {
    if (e.code === "conflict") return error(409, "conflict", e.message);
    throw e;
  }
  return Response.json({ shas }, { status: 201 });
}
