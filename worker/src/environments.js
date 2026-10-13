import { createArtifacts } from "./artifacts.js";
import { groupsOf, personOf } from "./access.js";
import { deleteResource, parseDeploy, parseJsonc } from "./deploy.js";
import { mayApprove } from "./needs.js";
import { peopleWhere } from "./people.js";
import { promote } from "./releases.js";
import { error } from "./router.js";

// Where a card for an environment outside Cloudflare links (same card, the provider's console).
const CONSOLES = { AWS: "https://console.aws.amazon.com/", "Google Cloud": "https://console.cloud.google.com/", Azure: "https://portal.azure.com/" };
// The console page of the resource an environment's aws, gcp or azure config deploys to, or null without one.
const resourceConsole = ({ aws, gcp, azure }) => {
  const u = encodeURIComponent;
  if (aws) {
    const at = { lambda: `lambda/home?region=${aws.region}#/functions/${u(aws.resource)}`, ecs: `ecs/v2/clusters/${u(aws.resource)}/services?region=${aws.region}`,
      apprunner: `apprunner/home?region=${aws.region}#/services` }[aws.service];
    return `https://${aws.region}.console.aws.amazon.com/${at}`;
  }
  if (gcp) return `https://console.cloud.google.com/${gcp.service === "run" ? "run/detail" : "functions/details"}/${gcp.region}/${u(gcp.name)}`;
  if (azure) {
    const type = azure.service === "functions" ? "Microsoft.Web/sites" : "Microsoft.App/containerApps";
    return `https://portal.azure.com/#@/resource/subscriptions/${u(azure.subscription)}/resourceGroups/${u(azure.resource_group)}/providers/${type}/${u(azure.app)}`;
  }
  return null;
};

// The deploy section of .cinder.yml on the repo's default branch, or null for an unknown repo; no deploy section has no environments.
export async function manifest(env, name) {
  const repo = await env.DB.prepare("SELECT default_branch FROM repos WHERE name = ?").bind(name).first();
  return repo && (parseDeploy(await createArtifacts(env.ARTIFACTS).readFile(name, repo.default_branch, ".cinder.yml")) ?? { environments: [] });
}

// GET /api/repos/:name/branch-deploys → BranchDeploy[]: each environment with a branch, as {branch, environment}.
export async function listBranchDeploys(request, env, { name }) {
  const deploy = await manifest(env, name);
  if (!deploy) return error(404, "not_found", `no repo ${name}`);
  return Response.json(deploy.environments.filter((e) => e.branch).map((e) => ({ branch: e.branch, environment: e.name })));
}

// Everything the manifest declares for environment e, as {type, name} like its deploy_resources rows.
const declared = (deploy, e) => [
  ...(deploy.resources ?? []),
  ...(e.routes ?? []).map((r) => ({ type: "route", name: r.pattern })),
  ...(e.custom_domain ? [{ type: "custom_domain", name: e.custom_domain }] : []),
  ...(e.crons ?? []).map((c) => ({ type: "cron", name: c })),
];

// GET /api/repos/:name/environments → Environment[] (status, live version, rollout step, drift, history; DESIGN §9).
// Desired state is the head of the environment's branch; a head the latest sync didn't deploy shows OutOfSync.
// pending lists the open Release approvals for the environment, who may approve them and whether the caller may; previous is the release a
// rollback would restore (the latest Synced version other than the one deployed now), or null. secrets counts the
// Keystore secrets scoped to the environment.
export async function listEnvironments(request, env, { name }) {
  const start = performance.now();
  const deploy = await manifest(env, name);
  if (!deploy) return error(404, "not_found", `no repo ${name}`);
  const read = performance.now();
  const artifacts = createArtifacts(env.ARTIFACTS);
  const all = (sql) => env.DB.prepare(sql).bind(name).all().then((r) => r.results);
  // Every read below is independent, so they run at once rather than one after another.
  const [syncs, resources, released, approvals, secrets, heads, script] = await Promise.all([
    // lazy: returns every sync as history; add a per-environment LIMIT when histories grow long.
    all(`SELECT env, sha, version_id, s.status, step, changes, actor, started_at, at, j.id AS run, r.reason
    FROM deploy_syncs s LEFT JOIN deploy_sync_steps p ON p.sync_id = s.id LEFT JOIN jobs j ON j.id = s.id AND j.kind = 'flow'
    LEFT JOIN deploy_sync_reasons r ON r.sync_id = s.id WHERE repo = ? ORDER BY started_at DESC`),
    all("SELECT env, type, name FROM deploy_resources WHERE repo = ?"),
    all("SELECT r.tag, t.sha FROM releases r JOIN tags t ON t.repo = r.repo AND t.name = r.tag WHERE r.repo = ? AND r.state = 'published'"),
    all(`SELECT n.id AS need, r.tag AS release, n.created_at AS at, json_extract(s.subject, '$.env') AS env, s.subject
    FROM needs n JOIN need_subjects s ON s.need_id = n.id JOIN releases r ON r.id = json_extract(s.subject, '$.release')
    WHERE n.repo = ? AND n.kind = 'Release approval' AND n.resolved_at IS NULL ORDER BY n.created_at`),
    all("SELECT environment, count(*) AS n FROM keystore_secrets WHERE repo = ? AND scope = 'environment' GROUP BY environment"),
    // The binding rejects a ref that doesn't exist, so a declared branch nobody pushed reads as no head: that card is
    // branch_missing instead of the whole list failing.
    Promise.all(deploy.environments.map(async (e) => (e.branch ? (await artifacts.log(name, e.branch).catch(() => []))[0]?.sha ?? null : null))),
    // A Cloudflare environment deploys as the Worker script `<wrangler name>-<env>` (secretTarget, the pipeline).
    deploy.worker && env.DB.prepare("SELECT default_branch FROM repos WHERE name = ?").bind(name).first()
      .then(async ({ default_branch: ref }) => { const wrangler = await artifacts.readFile(name, ref, deploy.worker); return wrangler && parseJsonc(wrangler).name; }),
  ]);
  // can_resolve and approvers are the resolve route's check (the gate's approvers role, else who may promote). Access groups
  // come only with a request, so a person who approves through a group mapping is listed when they are the caller.
  const caller = personOf(request);
  await Promise.all(approvals.map(async (a) => {
    const s = JSON.parse(a.subject);
    a.can_resolve = await mayApprove(env, caller, groupsOf(request), { repo: name }, s);
    const names = await peopleWhere(env, (p) => mayApprove(env, p, [], { repo: name }, s));
    a.approvers = a.can_resolve && caller !== "owner" && !names.includes(caller) ? [...names, caller] : names;
  }));
  const done = performance.now();
  const timing = `manifest;dur=${(read - start).toFixed(1)}, state;dur=${(done - read).toFixed(1)}`;
  return Response.json(deploy.environments.map((e, i) => {
    const history = syncs.filter((s) => s.env === e.name).map((s) => ({ ...s, changes: JSON.parse(s.changes) }));
    const live = history.find((s) => s.status === "Synced");
    const mine = new Set(declared(deploy, e).map((r) => `${r.type}:${r.name}`));
    const target = e.target ?? "Cloudflare";
    const gate = [e.auto_sync ? "auto-sync" : "manual", e.health && `health ${e.health}`].filter(Boolean).join(" · ");
    const current = history.find((s) => s.version_id);
    const previous = current && history.find((s) => s.status === "Synced" && s.version_id && s.version_id !== current.version_id);
    return {
      name: e.name,
      branch: e.branch ?? null,
      desired_sha: heads[i],
      branch_missing: Boolean(e.branch) && !heads[i],
      status: heads[i] && heads[i] !== history[0]?.sha ? "OutOfSync" : history[0]?.status ?? null,
      live_version: live?.version_id ? { version_id: live.version_id, sha: live.sha } : null,
      step: history[0]?.step ?? null,
      drift: resources.filter((r) => r.env === e.name && !mine.has(`${r.type}:${r.name}`)).map((r) => ({ type: r.type, name: r.name })),
      history,
      release: (live && released.find((r) => r.sha === live.sha)?.tag) ?? null,
      target,
      console: resourceConsole(e) ?? (target !== "Cloudflare" ? CONSOLES[target] ?? null
        : script ? `https://dash.cloudflare.com/?to=/:account/workers/services/view/${script}-${e.name}/production/deployments` : null),
      host: e.ssh?.host ?? null,
      gate,
      deployed_at: live?.at ?? null,
      pending: approvals.filter((a) => a.env === e.name).map((a) => ({ need: a.need, release: a.release, gate, approvers: a.approvers, at: a.at, can_resolve: a.can_resolve })),
      previous: (previous && released.find((r) => r.sha === previous.sha)?.tag) ?? null,
      secrets: secrets.find((s) => s.environment === e.name)?.n ?? 0,
    };
  }), { headers: { "Server-Timing": timing } });
}

// POST /api/repos/:name/environments/:environment/sync → 202 {name, id}: starts a cinder-pipeline Workflow instance that
// syncs the environment, as the caller (the sync's actor). `id` is the sync's deploy_syncs id and the instance id.
// An environment running a published release re-deploys that release, gated like promote (releases.js): a manual gate
// answers 202 {name, need}. Without a live release it syncs to its branch head, auto_sync or not.
// Body {override: true} syncs inside a deny window; an empty body is a plain sync.
export async function syncEnvironmentNow(request, env, { name, environment }) {
  const target = (await manifest(env, name))?.environments.find((e) => e.name === environment);
  if (!target?.branch) return error(404, "not_found", `no branch environment ${environment} in ${name}`);
  const override = (await request.json().catch(() => null))?.override === true;
  const release = await env.DB.prepare(`SELECT r.id FROM deploy_syncs s JOIN tags t ON t.repo = s.repo AND t.sha = s.sha
    JOIN releases r ON r.repo = t.repo AND r.tag = t.name AND r.state = 'published'
    WHERE s.id = (SELECT id FROM deploy_syncs WHERE repo = ? AND env = ? AND status = 'Synced' ORDER BY started_at DESC LIMIT 1) ORDER BY r.created_at DESC LIMIT 1`)
    .bind(name, environment).first("id");
  if (release) return promote(env, name, environment, release, personOf(request), false, override);
  const sha = (await createArtifacts(env.ARTIFACTS).log(name, target.branch))[0]?.sha;
  if (!sha) return error(409, "empty_branch", `branch ${target.branch} has no commits`);
  const id = crypto.randomUUID();
  await env.PIPELINE.create({ id, params: { sync: id, repo: name, branch: target.branch, sha, actor: personOf(request), override } });
  return Response.json({ name: environment, id }, { status: 202 });
}

// POST /api/repos/:name/environments/:env/prune {resources: [{type, name}], confirm: "<env>"} → 204: deletes drifted
// cinder-managed resources (DESIGN §9). The prune is recorded first as a history row repeating the latest sync, with
// the actor and the resource list as its reason, so a deletion that fails halfway is still on record.
export async function pruneEnvironment(request, env, { name, env: envName }) {
  const body = await request.json().catch(() => null);
  const resources = body?.resources;
  if (!Array.isArray(resources) || !resources.length || !resources.every((r) => typeof r?.type === "string" && typeof r?.name === "string")) {
    return error(400, "bad_request", "body must be {resources: [{type, name}], confirm}");
  }
  if (body.confirm !== envName) return error(400, "bad_confirm", `confirm must be the environment name ${envName}`);
  const deploy = await manifest(env, name);
  const target = deploy?.environments.find((e) => e.name === envName);
  if (!target) return error(404, "not_found", `no environment ${envName} in ${name}`);
  const same = (a) => (b) => a.type === b.type && a.name === b.name;
  const kept = resources.find((r) => declared(deploy, target).some(same(r)));
  if (kept) return error(409, "still_declared", `${kept.type} ${kept.name} is still declared in .cinder.yml`);
  const { results: rows } = await env.DB.prepare("SELECT type, name, cf_id FROM deploy_resources WHERE repo = ? AND env = ?").bind(name, envName).all();
  const untagged = resources.find((r) => !rows.some(same(r)));
  if (untagged) return error(404, "not_found", `${untagged.type} ${untagged.name} is not a cinder resource of ${envName}`);
  const last = await env.DB.prepare("SELECT sha, version_id, status, changes, step FROM deploy_syncs LEFT JOIN deploy_sync_steps ON sync_id = id WHERE repo = ? AND env = ? ORDER BY started_at DESC LIMIT 1")
    .bind(name, envName).first();
  // A Progressing sync updates its own row, so a later prune row would hide its outcome.
  if (!last || last.status === "Progressing") return error(409, "not_settled", `${envName} has no settled sync to record the prune on`);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  const pruned = rows.filter((t) => resources.some(same(t)));
  await env.DB.batch([
    env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, name, envName, last.sha, last.version_id, last.status, last.changes, personOf(request), now, now),
    ...(last.step == null ? [] : [env.DB.prepare("INSERT INTO deploy_sync_steps (sync_id, step) VALUES (?, ?)").bind(id, last.step)]),
    env.DB.prepare("INSERT INTO deploy_sync_reasons (sync_id, reason) VALUES (?, ?)")
      .bind(id, `pruned ${pruned.map((r) => `${r.type}:${r.name}`).join(", ")}`),
  ]);
  for (const r of pruned) await deleteResource(env, name, envName, r);
  return new Response(null, { status: 204 });
}

// GET /api/repos/:name/environments/:env/tree → {script, live_version, bindings}: Argo's app tree for one environment.
// Each declared resource binds as NAME (reconcileResources) to `<name>-<env>`; drift marks a declared resource cinder hasn't
// provisioned yet, or a cinder-tagged one the manifest no longer declares (bound to nothing).
export async function environmentTree(request, env, { name, env: envName }) {
  const deploy = await manifest(env, name);
  if (!deploy?.environments.some((e) => e.name === envName)) return error(404, "not_found", `no environment ${envName} in ${name}`);
  const { default_branch: ref } = await env.DB.prepare("SELECT default_branch FROM repos WHERE name = ?").bind(name).first();
  const wrangler = deploy.worker ? await createArtifacts(env.ARTIFACTS).readFile(name, ref, deploy.worker) : null;
  const worker = wrangler && parseJsonc(wrangler).name;
  const live = await env.DB.prepare("SELECT version_id, sha FROM deploy_syncs WHERE repo = ? AND env = ? AND status = 'Synced' ORDER BY started_at DESC LIMIT 1")
    .bind(name, envName).first();
  const { results: rows } = await env.DB.prepare("SELECT type, name FROM deploy_resources WHERE repo = ? AND env = ? AND type IN ('d1', 'kv', 'queue', 'r2')")
    .bind(name, envName).all();
  const want = deploy.resources ?? [];
  const has = (list, r) => list.some((x) => x.type === r.type && x.name === r.name);
  return Response.json({
    script: worker ? `${worker}-${envName}` : null,
    live_version: live?.version_id ? live : null,
    bindings: [...want, ...rows.filter((r) => !has(want, r))].map((r) => ({
      binding: has(want, r) ? r.name.toUpperCase().replaceAll("-", "_") : null,
      type: r.type,
      resource: `${r.name}-${envName}`,
      drift: !has(want, r) || !has(rows, r),
    })),
  });
}
