import { personOf } from "./access.js";
import { createArtifacts } from "./artifacts.js";
import { parseDeploy, parseJsonc } from "./deploy.js";
import { manifest } from "./environments.js";
import { error } from "./router.js";

// Tags come from the commit API (src/commits.js), a release
// is drafted or published from one tag with notes, and an environment promotes a published release.
// A release is live in each environment whose current deploy (its latest Synced sync) runs the release's sha: the sha it
// was published at (release_shas), a draft's tag sha until then.
const RELEASE = `SELECT r.*, COALESCE(p.sha, t.sha) AS sha, (SELECT json_group_array(DISTINCT s.env) FROM deploy_syncs s WHERE s.repo = r.repo AND s.sha = COALESCE(p.sha, t.sha) AND s.status = 'Synced'
    AND NOT EXISTS (SELECT 1 FROM deploy_syncs n WHERE n.repo = s.repo AND n.env = s.env AND n.status = 'Synced' AND n.started_at > s.started_at)) AS environments
  FROM releases r JOIN tags t ON t.repo = r.repo AND t.name = r.tag LEFT JOIN release_shas p ON p.release_id = r.id`;
// Pins a published release (id) to its tag's current sha, batched with the publish so neither lands alone.
const pin = (env, id) => env.DB.prepare(`INSERT INTO release_shas (release_id, sha) SELECT r.id, t.sha FROM releases r JOIN tags t ON t.repo = r.repo AND t.name = r.tag
  WHERE r.id = ? AND r.state = 'published' ON CONFLICT DO NOTHING`).bind(id);
const out = (r) => ({ ...r, environments: JSON.parse(r.environments) });
const text = (v) => typeof v === "string" && v.trim().length > 0;

// GET /api/repos/:name/tags?limit=n → [Tag], newest first; limit is 1–100, all tags without it.
export async function listTags(request, env, { name }) {
  const raw = new URL(request.url).searchParams.get("limit");
  const limit = raw === null ? -1 : Number(raw);
  if (raw !== null && !(/^\d+$/.test(raw) && limit >= 1 && limit <= 100)) return error(400, "bad_request", "limit must be an integer from 1 to 100");
  const { results } = await env.DB.prepare("SELECT name, sha, message, tagger, created_at FROM tags WHERE repo = ? ORDER BY created_at DESC, name LIMIT ?").bind(name, limit).all();
  return Response.json(results);
}

// GET /api/repos/:name/releases → [Release], newest first, each with the environments it is live in.
export async function listReleases(request, env, { name }) {
  const { results } = await env.DB.prepare(`${RELEASE} WHERE r.repo = ? ORDER BY r.created_at DESC`).bind(name).all();
  return Response.json(results.map(out));
}

// POST /api/repos/:name/releases {tag, title, notes?, draft?} → 201 Release: one release per tag.
export async function createRelease(request, env, { name }) {
  const { tag, title, notes = "", draft = false } = (await request.json().catch(() => null)) ?? {};
  if (!text(tag) || !text(title) || typeof notes !== "string" || typeof draft !== "boolean") {
    return error(400, "bad_request", "body must be {tag, title, notes?, draft?}");
  }
  if (!await env.DB.prepare("SELECT 1 FROM tags WHERE repo = ? AND name = ?").bind(name, tag).first()) return error(404, "not_found", `no tag ${tag} in ${name}`);
  const [at, fresh] = [new Date().toISOString(), crypto.randomUUID()];
  const [{ results: [{ id } = {}] }] = await env.DB.batch([env.DB.prepare(`INSERT INTO releases (id, repo, tag, title, notes, state, author, created_at, published_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING RETURNING id`)
    .bind(fresh, name, tag, title.trim(), notes, draft ? "draft" : "published", personOf(request), at, draft ? null : at), pin(env, fresh)]);
  if (!id) return error(409, "release_exists", `tag ${tag} already has a release`);
  return Response.json(out(await env.DB.prepare(`${RELEASE} WHERE r.id = ?`).bind(id).first()), { status: 201 });
}

// POST /api/repos/:name/releases/:id/publish → Release: publishes a draft.
export async function publishRelease(request, env, { name, id }) {
  const [{ results: [done] }] = await env.DB.batch([env.DB.prepare("UPDATE releases SET state = 'published', published_at = ? WHERE id = ? AND repo = ? AND state = 'draft' RETURNING id")
    .bind(new Date().toISOString(), id, name), pin(env, id)]);
  const release = await env.DB.prepare(`${RELEASE} WHERE r.id = ? AND r.repo = ?`).bind(id, name).first();
  if (!release) return error(404, "not_found", `no release ${id} in ${name}`);
  if (!done) return error(409, "already_published", `release ${id} is already published`);
  return Response.json(out(release));
}

// POST /api/repos/:name/environments/:env/promote {release} → 202 {name, id}: syncs the environment to the published
// release's tagged commit, as a manual sync (src/environments.js) whose deploy_syncs id is `id`. An environment without
// auto_sync (a manual gate) deploys nothing yet: it answers 202 {name, need} and raises a Release approval on Needs you,
// whose Approve (needs.js) starts the deploy. Sync now and rollback (environments.js, deploy.js) promote the same way.
export async function promoteRelease(request, env, { name, env: envName }) {
  const { release: id, rollout } = (await request.json().catch(() => null)) ?? {};
  if (!text(id) || ![undefined, "gradual", "all"].includes(rollout)) return error(400, "bad_request", "body must be {release, rollout?: gradual | all}");
  return promote(env, name, envName, id, personOf(request), false, false, rollout === "all");
}

// Approve on a Release approval item (needs.js): deploys the gated promote as the approver.
export const approvePromote = (request, env, n, s) => promote(env, n.repo, s.env, s.release, personOf(request), true, false, s.all === true);

// all skips the environment's gradual steps and deploys at 100%.
export async function promote(env, name, envName, id, actor, approved, override = false, all = false) {
  const release = await env.DB.prepare(`${RELEASE} WHERE r.id = ? AND r.repo = ?`).bind(id, name).first();
  if (!release) return error(404, "not_found", `no release ${id} in ${name}`);
  if (release.state !== "published") return error(409, "draft", `release ${release.tag} is a draft; publish it first`);
  const target = (await manifest(env, name))?.environments.find((e) => e.name === envName);
  if (!target?.branch) return error(404, "not_found", `no branch environment ${envName} in ${name}`);
  // A commit whose Worker entry point is missing is refused before an approval is raised or Cloudflare is called.
  // A build makes main, so only an unbuilt Worker's main is checked.
  if ((target.target ?? "Cloudflare") === "Cloudflare") {
    const read = (path) => createArtifacts(env.ARTIFACTS).readFile(name, release.sha, path);
    const deploy = parseDeploy(await read(".cinder.yml"));
    const config = deploy && !deploy.build ? await read(deploy.worker) : null;
    const main = config != null && parseJsonc(config).main;
    if (main && await read(main) == null) return error(409, "no_entry_point", `release ${release.tag} cannot deploy: ${main} is missing at ${release.sha}`);
  }
  const at = new Date().toISOString();
  if (!target.auto_sync && !approved) {
    const need = crypto.randomUUID();
    await env.DB.batch([
      env.DB.prepare("INSERT INTO needs (id, kind, repo, change_id, text, actions, created_at) VALUES (?, 'Release approval', ?, NULL, ?, ?, ?)")
        .bind(need, name, `Deploy release ${release.tag} to ${envName}, promoted by ${actor} (${need.slice(0, 8)})`, JSON.stringify(["Approve", "Reject"]), at),
      env.DB.prepare("INSERT INTO need_subjects (need_id, subject) VALUES (?, ?)").bind(need, JSON.stringify({ release: id, env: envName, ...(all && { all }), ...(target.approvers && { approvers: target.approvers }) })),
    ]);
    return Response.json({ name: envName, need }, { status: 202 });
  }
  const sync = crypto.randomUUID();
  await env.PIPELINE.create({ id: sync, params: { sync, repo: name, env: envName, branch: target.branch, sha: release.sha, actor, override, all } });
  return Response.json({ name: envName, id: sync }, { status: 202 });
}
