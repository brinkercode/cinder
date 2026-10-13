import { personOf } from "./access.js";
import { createArtifacts } from "./artifacts.js";
import { logEntry } from "./code.js";
import { BRANCH } from "./commits.js";
import { listRefs, setTag } from "./git/index.js";
import { error } from "./router.js";

// POST /api/repos/:name/tags {tag, sha?, ref?, message?} → 201 Tag: tags an existing commit, sha or the head of branch ref
// (the router requires repo.write), and records it for the tags list. No commit or branch is created.
export async function createTag(request, env, { name }) {
  const { tag, sha, ref, message } = (await request.json().catch(() => null)) ?? {};
  // BRANCH plus git's check-ref-format rules it lets through: no component ending in ".lock", no trailing ".".
  if (typeof tag !== "string" || !BRANCH.test(tag) || tag.includes("..") || /\.lock(\/|$)|\.$/.test(tag)) return error(400, "bad_request", "tag must be a valid tag name");
  if ((sha === undefined) === (ref === undefined)) return error(400, "bad_request", "give one of sha or ref");
  if (sha !== undefined && !/^[0-9a-f]{40}$/.test(sha)) return error(400, "bad_request", "sha must be a 40-character commit sha");
  if (ref !== undefined && (typeof ref !== "string" || !BRANCH.test(ref) || ref.includes(".."))) return error(400, "bad_request", "ref must be a valid branch name");
  if (message !== undefined && typeof message !== "string") return error(400, "bad_request", "message must be a string");
  if (await env.DB.prepare("SELECT 1 FROM tags WHERE repo = ? AND name = ?").bind(name, tag).first()) return error(409, "tag_exists", `tag ${tag} exists`);
  const artifacts = createArtifacts(env.ARTIFACTS);
  const repo = await artifacts.get(name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const head = (await artifacts.log(name, sha ?? ref))[0]?.sha;
  if (!head || (sha && head !== sha)) return error(404, "not_found", `no commit ${sha ?? `at ${ref}`} in ${name}`);
  try {
    await setTag(repo, tag, head);
  } catch (e) {
    if (e.code === "conflict") return error(409, "tag_exists", e.message);
    throw e;
  }
  const row = { name: tag, sha: head, message: message?.trim() || tag, tagger: personOf(request), created_at: new Date().toISOString() };
  await env.DB.prepare("INSERT INTO tags (repo, name, sha, message, tagger, created_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(name, row.name, row.sha, row.message, row.tagger, row.created_at).run();
  return Response.json(row, { status: 201 });
}

// GET /api/repos/:name/resolve?sha=<7–40 hex> → LogCommit (api/shapes/code-log.js): the one commit on any branch whose
// sha starts with it. 404 when none does, 400 when it is not hex or names more than one commit.
// lazy: reads each branch's log as the binding returns it; index commits by sha once histories outgrow that.
export async function resolveCommit(request, env, { name }) {
  const prefix = new URL(request.url).searchParams.get("sha") ?? "";
  if (!/^[0-9a-f]{7,40}$/.test(prefix)) return error(400, "bad_request", "sha must be 7 to 40 hex characters");
  const artifacts = createArtifacts(env.ARTIFACTS);
  const repo = await artifacts.get(name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const branches = (await listRefs(repo)).filter((r) => r.kind === "branch");
  const found = new Map();
  for (const log of await Promise.all(branches.map((b) => artifacts.log(name, b.sha)))) {
    for (const c of log) if (c.sha.startsWith(prefix)) found.set(c.sha, c);
  }
  if (found.size > 1) return error(400, "ambiguous", `${prefix} matches ${found.size} commits; give more of the sha`);
  if (!found.size) return error(404, "not_found", `no commit ${prefix} in ${name}`);
  const [commit] = [...found.values()].map(logEntry);
  return Response.json(commit);
}
