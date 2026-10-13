import { DENY_WINDOW, validateDeploy } from "./api/contract.js";
import { personOf } from "./access.js";
import { SYSTEM_STEPS, appendLog } from "./flow-logs.js";
import { legacyRun } from "./flows.js";
import { createArtifacts } from "./artifacts.js";
import { recordRiskOutcome } from "./judgments.js";
import { audit, binding, rebind, resolveSecret } from "./keystore.js";
import { promote } from "./releases.js";
import { error } from "./router.js";
import { parseYaml } from "./yaml.js";

// The only caller of the Cloudflare API with CF_DEPLOY_TOKEN (DESIGN §9). The token goes in the Authorization header
// and nowhere else: never logged, never in an error, never sent to runners. Tests pass a fake `fetcher`.
export async function cloudflare(env, path, init = {}, fetcher = fetch) {
  if (!env.CF_DEPLOY_TOKEN) throw new Error("deploy: CF_DEPLOY_TOKEN is not set");
  const res = await fetcher(`https://api.cloudflare.com/client/v4${path}`, {
    ...init,
    headers: { ...init.headers, Authorization: `Bearer ${env.CF_DEPLOY_TOKEN}` },
  });
  if (!res.ok) {
    // Cloudflare's own reason ({errors: [{code, message}]}) rides on the error for route() to show; never the request body.
    const cf = (await res.json().catch(() => null))?.errors?.[0];
    const what = `${init.method ?? "GET"} ${path}`;
    throw Object.assign(new Error(`Cloudflare API ${what} failed with ${res.status}${cf?.message ? `: ${cf.message}` : ""}${cf?.code ? ` (code ${cf.code})` : ""}`),
      { status: res.status, cloudflare: { code: cf?.code ?? null, message: cf?.message ?? null } });
  }
  return res.json();
}

// The `deploy` section of .cinder.yml (docs/DESIGN.md §9), or null when the file or section is absent.
export function parseDeploy(text) {
  const d = text == null ? null : parseYaml(text).deploy;
  if (d == null) return null;
  // parseYaml returns plain scalars as strings; type the ones the manifest declares as boolean or number.
  const bool = (v) => ({ true: true, false: false })[v] ?? v;
  const deploy = {
    ...d,
    worker: d.worker ?? "wrangler.jsonc",
    environments: Array.isArray(d.environments) ? d.environments.map((e) => ({
      ...e,
      ...(e?.auto_sync !== undefined && { auto_sync: bool(e.auto_sync) }),
      ...(e?.self_heal !== undefined && { self_heal: bool(e.self_heal) }),
      ...(Array.isArray(e?.gradual) && { gradual: e.gradual.map((s) => (/^\d+$/.test(s) ? Number(s) : s)) }),
      ...(/^\d+$/.test(e?.bake) && { bake: Number(e.bake) }),
      ...(e?.max_error_rate !== undefined && { max_error_rate: Number(e.max_error_rate) }),
    })) : d.environments,
    ...(d.preview && { preview: { ...d.preview, resources: bool(d.preview.resources) } }),
  };
  const { ok, errors } = validateDeploy(deploy);
  if (!ok) throw new Error(`.cinder.yml: ${errors.join("; ")}`);
  return deploy;
}

// Per type: create path and body, the id in the create result, and the Worker version binding (DESIGN §9).
export const RESOURCE_API = {
  d1: { path: "d1/database", body: (n) => ({ name: n }), id: (r) => r.uuid, binding: (id) => ({ type: "d1", id }) },
  kv: { path: "storage/kv/namespaces", body: (n) => ({ title: n }), id: (r) => r.id, binding: (id) => ({ type: "kv_namespace", namespace_id: id }) },
  queue: { path: "queues", body: (n) => ({ queue_name: n }), id: (r) => r.queue_id, binding: (_, n) => ({ type: "queue", queue_name: n }) },
  r2: { path: "r2/buckets", body: (n) => ({ name: n }), id: (r) => r.name, binding: (_, n) => ({ type: "r2_bucket", bucket_name: n }) },
};

// True when `at` falls inside one of the environment's deny windows, each read in its own time zone.
const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function inDenyWindow(windows, at) {
  return (windows ?? []).some(({ deny, tz }) => {
    const p = Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short", hour: "numeric", minute: "numeric", hourCycle: "h23" })
      .formatToParts(at).map((x) => [x.type, x.value]));
    const minute = (d, h, m) => DAYS.indexOf(d) * 1440 + Number(h) * 60 + Number(m);
    const [, d1, h1, m1, d2, h2, m2] = DENY_WINDOW.exec(deny);
    const now = minute(p.weekday, p.hour, p.minute);
    const start = minute(d1, h1, m1);
    const end = minute(d2, h2, m2);
    // A range whose end comes before its start, like Fri-Mon, wraps through the end of the week.
    return start < end ? now >= start && now < end : now >= start || now < end;
  });
}

// Makes the environment's resources match deploy.resources, each named `<name>-<env>`. Returns the bindings for the
// version's config and the drift: cinder-managed resources no longer declared. Drift is deleted only when `prune` is true.
// Trusts deploy_resources for existence; the drift check (drift.js) drops the row of a resource deleted outside cinder.
export async function reconcileResources(env, repo, deploy, envName, { prune = false } = {}, fetcher = fetch) {
  const base = `/accounts/${env.CF_ACCOUNT_ID}`;
  const { results: rows } = await env.DB.prepare("SELECT type, name, cf_id FROM deploy_resources WHERE repo = ? AND env = ? AND type IN ('d1', 'kv', 'queue', 'r2')")
    .bind(repo, envName).all();
  const known = new Map(rows.map((r) => [`${r.type}:${r.name}`, r]));
  const bindings = [];
  for (const { type, name } of deploy.resources ?? []) {
    const api = RESOURCE_API[type];
    const cfName = `${name}-${envName}`;
    let id = known.get(`${type}:${name}`)?.cf_id;
    if (!id) {
      const { result } = await cloudflare(env, `${base}/${api.path}`, {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(api.body(cfName)),
      }, fetcher);
      id = api.id(result);
      await env.DB.prepare("INSERT INTO deploy_resources (repo, env, type, name, cf_id) VALUES (?, ?, ?, ?, ?)")
        .bind(repo, envName, type, name, id).run();
    }
    known.delete(`${type}:${name}`);
    bindings.push({ name: name.toUpperCase().replaceAll("-", "_"), ...api.binding(id, cfName) });
  }
  const drift = [...known.values()];
  if (!prune) return { status: drift.length ? "OutOfSync" : "Synced", bindings, drift };
  for (const r of drift) await deleteResource(env, repo, envName, r, fetcher);
  return { status: "Synced", bindings, drift: [] };
}

const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });

// Makes the environment's Worker triggers match its manifest entry: routes, custom_domain and crons (DESIGN §9).
// Each one set is tagged in deploy_resources; one the manifest drops stays set and shows as drift until it's pruned.
// lazy: keyed by pattern, hostname and expression; a route that only changes zone isn't moved.
export async function reconcileTriggers(env, repo, target, script, fetcher = fetch) {
  const account = `/accounts/${env.CF_ACCOUNT_ID}`;
  const { results: rows } = await env.DB.prepare("SELECT type, name FROM deploy_resources WHERE repo = ? AND env = ? AND type IN ('route', 'custom_domain', 'cron')")
    .bind(repo, target.name).all();
  const tagged = (type, name) => rows.some((r) => r.type === type && r.name === name);
  const tag = (type, name, id) => env.DB.prepare("INSERT OR IGNORE INTO deploy_resources (repo, env, type, name, cf_id) VALUES (?, ?, ?, ?, ?)")
    .bind(repo, target.name, type, name, id).run();
  for (const { pattern, zone } of target.routes ?? []) {
    if (tagged("route", pattern)) continue;
    const { result } = await cloudflare(env, `/zones/${zone}/workers/routes`, json("POST", { pattern, script }), fetcher);
    await tag("route", pattern, `${zone}/${result.id}`);
  }
  const domain = target.custom_domain;
  if (domain && !tagged("custom_domain", domain)) {
    const { result } = await cloudflare(env, `${account}/workers/domains`, json("PUT", { hostname: domain, service: script }), fetcher);
    await tag("custom_domain", domain, result.id);
  }
  // Schedules are replaced as a whole, so the PUT keeps the crons the manifest dropped until they're pruned.
  const crons = [...new Set([...rows.filter((r) => r.type === "cron").map((r) => r.name), ...(target.crons ?? [])])];
  if (!crons.length) return;
  await cloudflare(env, `${account}/workers/scripts/${script}/schedules`, json("PUT", crons.map((cron) => ({ cron }))), fetcher);
  for (const c of target.crons ?? []) await tag("cron", c, script);
}

// Deletes a cinder-managed resource or trigger ({type, name, cf_id} from deploy_resources) in Cloudflare, then its row.
// A route's cf_id is `<zone>/<route id>`; a cron's is its script, whose schedules are put back without it.
export async function deleteResource(env, repo, envName, r, fetcher = fetch) {
  const account = `/accounts/${env.CF_ACCOUNT_ID}`;
  if (r.type === "cron") {
    const { results } = await env.DB.prepare("SELECT name FROM deploy_resources WHERE repo = ? AND env = ? AND type = 'cron' AND name != ?")
      .bind(repo, envName, r.name).all();
    await cloudflare(env, `${account}/workers/scripts/${r.cf_id}/schedules`, json("PUT", results.map((c) => ({ cron: c.name }))), fetcher);
  } else {
    const path = r.type === "route" ? `/zones/${r.cf_id.replace("/", "/workers/routes/")}`
      : r.type === "custom_domain" ? `${account}/workers/domains/${r.cf_id}` : `${account}/${RESOURCE_API[r.type].path}/${r.cf_id}`;
    await cloudflare(env, path, { method: "DELETE" }, fetcher);
  }
  await env.DB.prepare("DELETE FROM deploy_resources WHERE repo = ? AND env = ? AND type = ? AND name = ?")
    .bind(repo, envName, r.type, r.name).run();
}

// What merging the change would do to each environment (DESIGN §9), or null when it touches no deploy file (.cinder.yml's
// deploy section, the Worker config, migrations). `destructive` says why a person must look: a prune or a new DROP.
// lazy: diffs against the target branch's manifest, not Cloudflare; compare deploy_resources when out-of-band drift matters.
export async function planDeploy(env, repo, change) {
  // A pushed change's head is only in change_heads; the change object carries it once moveHead has run.
  const sha = await env.DB.prepare("SELECT head_sha FROM change_heads WHERE change_id = ?").bind(change.id).first("head_sha") ?? change.head;
  if (!sha) return null;
  const artifacts = createArtifacts(env.ARTIFACTS);
  const read = async (name, ref) => {
    const text = await artifacts.readFile(name, ref, ".cinder.yml");
    const deploy = parseDeploy(text);
    const worker = deploy && await artifacts.readFile(name, ref, deploy.worker);
    const migrations = [];
    for (const r of deploy?.resources ?? []) {
      for (const e of (r.migrations && await artifacts.readTree(name, ref, r.migrations)) ?? []) {
        if (e.type === "blob" && e.name.endsWith(".sql")) migrations.push(`${r.migrations}/${e.name}`);
      }
    }
    const resources = new Set((deploy?.resources ?? []).map((r) => `${r.type} ${r.name}`));
    return { deploy, text, worker, migrations: migrations.sort(), resources, date: worker && JSON.parse(worker).compatibility_date };
  };
  let base, head;
  try {
    [base, head] = await Promise.all([read(repo, change.target_branch), read(change.fork, sha)]);
  } catch (err) {
    // A manifest error names what to fix; a storage error ("Invalid ref: ref required.") means nothing on the change
    // page, so it goes to the log and the review says what happened. Either way a person checks the plan.
    if (err.message.startsWith(".cinder.yml:")) return { destructive: `is invalid: ${err.message}`, environments: [] };
    console.error(`deploy plan ${repo} ${change.id}: ${err.message}`);
    return { destructive: "could not be read: the deploy files at the target branch or the change head are unavailable", environments: [] };
  }
  if (!base.deploy && !head.deploy) return null;
  if (base.text === head.text && base.worker === head.worker && base.migrations.join() === head.migrations.join()) return null;
  const added = head.migrations.filter((m) => !base.migrations.includes(m));
  const drops = [];
  for (const m of added) if (/\bDROP\b/i.test((await artifacts.readFile(change.fork, sha, m)) ?? "")) drops.push(m);
  const binding = (r) => r.split(" ")[1].toUpperCase().replaceAll("-", "_");
  const environments = (head.deploy?.environments ?? []).map((e) => {
    // An environment new in this change starts from nothing.
    const known = base.deploy?.environments.some((b) => b.name === e.name);
    const before = known ? base.resources : new Set();
    const create = [...head.resources].filter((r) => !before.has(r));
    const prune = [...before].filter((r) => !head.resources.has(r));
    return { name: e.name, steps: [
      ...create.map((r) => `create ${r}`), ...prune.map((r) => `prune ${r}`),
      ...(known ? added : head.migrations).map((m) => `apply ${m}`),
      ...create.map((r) => `bind ${binding(r)}`), ...prune.map((r) => `unbind ${binding(r)}`),
      ...(known && base.date !== head.date ? [`compatibility_date ${base.date} -> ${head.date}`] : []),
    ] };
  });
  const pruned = [...base.resources].filter((r) => !head.resources.has(r));
  const destructive = [...pruned.map((r) => `prunes ${r}`), ...drops.map((m) => `${m} drops`)].join("; ") || null;
  return { destructive, environments };
}

// wrangler.jsonc as JSON: drops // and /* */ comments and trailing commas outside strings.
export function parseJsonc(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < text.length && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      out += text.slice(i, j + 1);
      i = j;
    } else if (c === "/" && text[i + 1] === "/") {
      const end = text.indexOf("\n", i);
      i = end < 0 ? text.length : end - 1;
    } else if (c === "/" && text[i + 1] === "*") {
      const end = text.indexOf("*/", i + 2);
      i = end < 0 ? text.length : end + 1;
    } else {
      if (c === "}" || c === "]") out = out.replace(/,\s*$/, "");
      out += c;
    }
  }
  return JSON.parse(out);
}

const MODULE_TYPES = { js: "application/javascript+module", mjs: "application/javascript+module", wasm: "application/wasm" };

// Uploads the repo's Worker (its `main` module) at sha as a version of `<name>-<envName>` with bindings; returns the
// script and version id.
async function uploadVersion(env, repo, sha, deploy, envName, bindings, fetcher) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  const read = async (path) => {
    const text = await artifacts.readFile(repo, sha, path);
    if (text == null) throw new Error(`deploy: ${path} is missing at ${sha}`);
    return text;
  };
  const config = parseJsonc(await read(deploy.worker));
  const script = `${config.name}-${envName}`;
  const main = config.main;
  const files = [[main, await read(main)]];
  const form = (extra) => {
    const f = new FormData();
    f.append("metadata", JSON.stringify({ main_module: main, compatibility_date: config.compatibility_date, bindings, keep_bindings: ["secret_text"], ...extra }));
    for (const [path, body] of files) f.append(path, new File([body], path, { type: MODULE_TYPES[path.split(".").pop()] ?? "application/octet-stream" }));
    return f;
  };
  const url = `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${script}`;
  const upload = () => cloudflare(env, `${url}/versions`, { method: "POST", body: form({ annotations: { "workers/tag": sha } }) }, fetcher);
  const { result } = await upload().catch(async (err) => {
    // An environment's first deploy has no Worker to add a version to: uploading the script creates it, then the version goes up.
    if (err.status !== 404) throw err;
    await cloudflare(env, url, { method: "PUT", body: form() }, fetcher).catch((e) => {
      throw e.status === 403 ? new Error(`deploy: the deploy token cannot create Worker ${script}; it needs Workers Scripts: Edit (${e.message})`) : e;
    });
    return upload();
  });
  // A Worker created through the API has its workers.dev route off, so its health path (probed there) and the environment's
  // URL answer 404. Idempotent, so it also fixes Workers created before; a config with workers_dev: false keeps it off.
  if (config.workers_dev !== false) {
    await cloudflare(env, `${url}/subdomain`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ enabled: true, previews_enabled: false }) }, fetcher);
  }
  return { script, version: result.id };
}

// Applies the migrations directory's .sql files not yet in the database's d1_migrations table (wrangler's own ledger).
async function applyMigrations(env, repo, sha, dir, dbId, fetcher) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  const query = (sql, params = []) => cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/d1/database/${dbId}/query`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ sql, params }),
  }, fetcher);
  await query("CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)");
  const { result } = await query("SELECT name FROM d1_migrations");
  const done = new Set(result[0].results.map((r) => r.name));
  const files = ((await artifacts.readTree(repo, sha, dir)) ?? []).filter((e) => e.type === "blob" && e.name.endsWith(".sql"))
    .map((e) => e.name).sort();
  for (const name of files.filter((n) => !done.has(n))) {
    await query(await artifacts.readFile(repo, sha, `${dir}/${name}`));
    await query("INSERT INTO d1_migrations (name) VALUES (?)", [name]);
  }
}

// The ids of the changes whose head or merged commit is one of the commits in shas (a JSON array).
async function changeIds(env, shas) {
  const { results } = await env.DB.prepare("SELECT change_id FROM change_heads WHERE head_sha IN (SELECT value FROM json_each(?1)) " +
    "UNION SELECT change_id FROM change_merged_shas WHERE merged_sha IN (SELECT value FROM json_each(?1))")
    .bind(shas).all();
  return results.map((r) => r.change_id);
}

// A rollback or failed sync is a "reverted: yes" outcome for every open risk judgment on the deploy's changes (DESIGN §9).
async function scoreRisky(env, shas) {
  const at = new Date().toISOString();
  for (const id of await changeIds(env, shas)) await recordRiskOutcome(env.DB, id, "yes", at);
}

// On a move of an environment's branch: reconciles resources, applies D1 migrations, uploads a version and deploys it in
// the environment's gradual steps, each gated on its health path and followed by a `bake` wait. Runs as cinder-pipeline
// Workflow steps (`step`). Without auto_sync the environment is only marked OutOfSync, unless the owner asked for the sync
// (`manual`; `id` is the sync id the request returned). Returns the final status, or null when no environment follows the
// branch. Status and history: deploy_syncs; each status change also goes to the repo live stream.
// Risk (the review routeChange stores on each change in the deploy): high risk adds a 1% canary step; high risk, an
// untrusted judge or no review holds production OutOfSync until a person syncs it (`manual`). Commits without a change aren't judged.
// Inside a deny window (`windows`) every sync, a self-heal or a manual one included, is held OutOfSync unless the manual
// sync passed `override`, which is recorded as the sync's reason. `all` (a rollback, or a promote all at once) skips the gradual steps.
// `name` picks the environment (a promote); without it the first environment on the branch syncs.
export async function syncEnvironment(env, repo, branch, sha, step, { manual = false, id = null, actor = "owner", override = false, all = false, name = null } = {}, fetcher = fetch) {
  const plan = await step.do("plan sync", async () => {
    const artifacts = createArtifacts(env.ARTIFACTS);
    const deploy = parseDeploy(await artifacts.readFile(repo, sha, ".cinder.yml"));
    const target = deploy?.environments.find((e) => e.branch === branch && (!name || e.name === name));
    if (!target) return null;
    const last = await env.DB.prepare("SELECT sha, version_id FROM deploy_syncs WHERE repo = ? AND env = ? AND status = 'Synced' ORDER BY started_at DESC LIMIT 1")
      .bind(repo, target.name).first();
    const log = await artifacts.log(repo, sha);
    const end = log.findIndex((c) => c.sha === last?.sha);
    // lazy: a first sync lists at most the last 100 commits; page the log if history views need more.
    const changes = (end < 0 ? log.slice(0, 100) : log.slice(0, end)).map((c) => c.sha);
    const reviews = await Promise.all((await changeIds(env, JSON.stringify(changes)))
      .map(async (c) => (await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(c)).get())?.review));
    const high = reviews.some((r) => r?.route === "human");
    const hold = target.name === "production" && !manual && (high || reviews.some((r) => !r?.trusted));
    const syncId = id ?? crypto.randomUUID();
    const now = new Date().toISOString();
    const denied = inDenyWindow(target.windows, new Date(now));
    // Outside Cloudflare there is no Worker to upload: the sync is recorded and the deploy is left to a flow step.
    const external = (target.target ?? "Cloudflare") !== "Cloudflare";
    const status = !external && (target.auto_sync || manual) && !hold && !(denied && !override) ? "Progressing" : "OutOfSync";
    await env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, status, changes, actor, started_at, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(syncId, repo, target.name, sha, status, JSON.stringify(changes), manual ? actor : "cinder-pipeline", now, now).run();
    const reason = external ? `${target.target} deploys run as a flow step, not a Worker upload` : denied ? (override ? `sync window overridden by ${actor}` : "sync window")
      : hold ? `awaiting a person's approval: ${high ? "high risk" : "risk not judged by a trusted judge"}` : null;
    if (reason) await env.DB.prepare("INSERT INTO deploy_sync_reasons (sync_id, reason) VALUES (?, ?)").bind(syncId, reason).run();
    // A first deploy has no version to split traffic with, so it goes straight to 100%.
    const steps = last && !all ? target.gradual ?? [100] : [100];
    const rollout = high && last && !all ? [1, ...steps.filter((p) => p > 1)] : steps;
    if (status === "Progressing") {
      await env.DB.batch(deployRun(env, repo, syncId, target.name, sha, rollout, "claimed", now));
      await sysStep(env, syncId, rollout[0], "Set up job", "running");
      await logLine(env, repo, syncId, rollout[0], `sync ${sha.slice(0, 7)} to ${target.name}: ${changes.length} new commit(s), rollout ${rollout.join("% → ")}%${reason ? `; ${reason}` : ""}`, sysIdx("Set up job"));
    }
    await announce(env, repo, target.name, status);
    return { id: syncId, deploy, target, last, changes: JSON.stringify(changes), rollout, status };
  });
  if (!plan || plan.status === "OutOfSync") return plan?.status ?? null;
  const { deploy, target, last, changes, rollout } = plan;
  // Each step's outcome is a line in the rollout job's log, the way a runner logs a flow step.
  let at = rollout[0];
  const log = (text) => logLine(env, repo, plan.id, at, text);
  // Secrets, resources, migrations and the upload are the sync's Set up job; triggers and the outcome its Complete job.
  const setup = (text) => logLine(env, repo, plan.id, rollout[0], text, sysIdx("Set up job"));
  const complete = async (text, status = "passed") => {
    await sysStep(env, plan.id, at, "Complete job", "running");
    await logLine(env, repo, plan.id, at, text, sysIdx("Complete job"));
    await sysStep(env, plan.id, at, "Complete job", status);
  };
  // One reason row per sync; a later reason is appended.
  const note = (reason) => env.DB.prepare("INSERT INTO deploy_sync_reasons (sync_id, reason) VALUES (?, ?) ON CONFLICT DO UPDATE SET reason = reason || '; ' || excluded.reason")
    .bind(plan.id, reason).run();
  const set = async (s, version = null) => {
    await env.DB.prepare("UPDATE deploy_syncs SET status = ?, version_id = COALESCE(?, version_id), at = ? WHERE id = ?")
      .bind(s, version, new Date().toISOString(), plan.id).run();
    if (s !== "Progressing") await env.DB.batch([env.DB.prepare("UPDATE jobs SET status = ? WHERE id = ? AND kind = 'flow'").bind(s === "Synced" ? "done" : "failed", plan.id),
      env.DB.prepare("UPDATE flow_runs SET status = ?, finished_at = ? WHERE id = ?").bind(s === "Synced" ? "passed" : "failed", new Date().toISOString(), plan.id)]);
    await announce(env, repo, target.name, s);
  };
  try {
    if (deploy.build) throw new Error("deploy.build isn't run: commit the built Worker and point main at it");
    // Each declared secret is the Keystore entry in scope for this environment; only ids cross the step, never values.
    const secrets = await step.do("check secrets", async () => {
      const found = await Promise.all((target.secrets ?? []).map(async (name) => ({ name, id: await resolveSecret(env, repo, target.name, null, name) })));
      const missing = found.filter((s) => !s.id).map((s) => s.name);
      if (missing.length) throw new Error(`deploy: unset secrets ${missing.join(", ")} in ${target.name}`);
      await setup(found.length ? `secrets resolved: ${found.map((f) => f.name).join(", ")}` : "no secrets declared");
      return found;
    });
    const { bindings } = await step.do("reconcile resources", async () => {
      const r = await reconcileResources(env, repo, deploy, target.name, {}, fetcher);
      await setup(`resources reconciled: ${r.bindings.length} binding(s)`);
      return r;
    });
    await step.do("apply migrations", async () => {
      for (const [i, r] of (deploy.resources ?? []).entries()) {
        if (r.migrations) {
          await applyMigrations(env, repo, sha, r.migrations, bindings[i].id, fetcher);
          await setup(`migrations applied from ${r.migrations}`);
        }
      }
    });
    const { script, version, subdomain } = await step.do("upload version", async () => {
      const values = await Promise.all(secrets.map(async ({ name, id }) => ({ type: "secret_text", name, text: await env.SECRETS.read(binding(id)) })));
      if (values.some((v) => v.text == null)) {
        await rebind(env);
        throw new Error("deploy: a Keystore secret is being bound to cinder-secrets; retrying");
      }
      if (secrets.length) await env.DB.batch(secrets.map(({ id }) => audit(env, id, "read", `sync:${plan.id}`)));
      const up = await uploadVersion(env, repo, sha, deploy, target.name, [...bindings, ...values], fetcher);
      await set("Progressing", up.version);
      await setup(`uploaded version ${up.version} of ${up.script}`);
      await sysStep(env, plan.id, rollout[0], "Set up job", "passed");
      const sub = target.health ? (await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/workers/subdomain`, {}, fetcher)).result.subdomain : null;
      return { ...up, subdomain: sub };
    });
    for (const [i, pct] of rollout.entries()) {
      at = pct;
      if (i) await step.sleep(`bake before ${pct}%`, (target.bake ?? 60) * 1000);
      try {
        if (i && target.max_error_rate !== undefined) {
          const { requests, errors } = await step.do(`error rate before ${pct}%`, () => versionErrors(env, script, version,
            new Date(Date.now() - (target.bake ?? 60) * 1000).toISOString(), fetcher));
          const rate = requests ? errors / requests : 0;
          if (!requests) await step.do(`no traffic before ${pct}%`, () => note(`no traffic in the bake before ${pct}%; error rate gate passed`));
          if (rate > target.max_error_rate) throw new Error(`error rate ${rate} over ${target.max_error_rate} before ${pct}%`);
        }
        // Retries redeploy the same split, which is idempotent, and give the probe a backoff.
        await step.do(`deploy ${pct}%`, { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" } }, async () => {
          const versions = [{ version_id: version, percentage: pct }];
          if (pct < 100) versions.push({ version_id: last.version_id, percentage: 100 - pct });
          await env.DB.prepare("INSERT INTO deploy_sync_steps (sync_id, step) VALUES (?1, ?2) ON CONFLICT DO UPDATE SET step = ?2").bind(plan.id, pct).run();
          await deployVersions(env, script, versions, fetcher);
          await log(`deployed: ${versions.map((v) => `${v.version_id} at ${v.percentage}%`).join(", ")}`);
          if (!target.health) return;
          // The override pins the request to the new version whatever the split.
          const res = await fetcher(`https://${script}.${subdomain}.workers.dev${target.health}`, {
            headers: { "Cloudflare-Workers-Version-Overrides": `${script}="${version}"` },
          }).catch(() => null);
          if (!res?.ok) throw new Error(`health check ${target.health} failed at ${pct}%: ${res?.status ?? "no response"}`);
          await log(`health check ${target.health} answered ${res.status}`);
        });
        await step.do(`passed ${pct}%`, () => env.DB.batch(runStep(env, plan.id, pct, "passed")));
      } catch (err) {
        // Workflows carry only the message across a step, so the prefix tells a failed probe from a failed deploy.
        const gated = String(err?.message).startsWith("error rate ");
        if (!gated && !String(err?.message).startsWith(`health check ${target.health} failed`)) throw err;
        await step.do("roll back", async () => {
          // A gate failure fires before this step deploys, so the new version still holds the previous step's share.
          if (pct < 100 || gated) await deployVersions(env, script, [{ version_id: last.version_id, percentage: 100 }], fetcher);
          await env.DB.batch(runStep(env, plan.id, pct, "failed"));
          await set("Degraded");
          await scoreRisky(env, changes);
          // An override reason recorded at plan time is kept ahead of the rollback's.
          await note(`${err.message}; rolled back to ${last?.version_id ?? "nothing"}`);
          await log(`##[error]${err.message}`);
          await complete(`rolled back to ${last?.version_id ?? "nothing"}; ${target.name} is Degraded`);
        });
        return "Degraded";
      }
    }
    await step.do("reconcile triggers", () => reconcileTriggers(env, repo, target, script, fetcher));
    await step.do("mark synced", async () => {
      await complete(`triggers reconciled; ${target.name} synced to ${sha.slice(0, 7)}`);
      await set("Synced");
    });
    return "Synced";
  } catch (err) {
    await step.do("mark failed", async () => {
      await log(`##[error]${err?.message ?? err}`);
      // A failure before the upload ends inside Set up job.
      await env.DB.prepare("UPDATE flow_step_runs SET status = 'failed', finished_at = ? WHERE run_id = ? AND name = 'Set up job' AND status = 'running'")
        .bind(new Date().toISOString(), plan.id).run();
      await complete(`${target.name} sync failed`);
      await env.DB.batch(runStep(env, plan.id, at, "failed"));
      await set("Failed");
      await env.DB.prepare("INSERT OR IGNORE INTO deploy_sync_reasons (sync_id, reason) VALUES (?, ?)").bind(plan.id, String(err?.message ?? err)).run();
      await scoreRisky(env, changes);
    });
    throw err;
  }
}

// A sync or rollback is a flow run of its rollout (flows.js runOf), one step per traffic percentage; its job id is the
// deploy_syncs id. Held 'claimed' with no lease, so no worker claims it. A repo without a repos row gets no run.
const deployRun = (env, repo, id, envName, sha, rollout, status, now) => [env.DB.prepare(
  "INSERT INTO jobs (id, repo_id, kind, status, created_at, payload) SELECT ?, id, 'flow', ?, ?, ? FROM repos WHERE name = ?")
  .bind(id, status, now, JSON.stringify({ flow: `deploy-${envName}`, sha, trigger: "sync", steps: rollout.map((p) => ({ name: `deploy ${p}%`, stage: "rollout" })) }), repo),
...legacyRun(env, id, "cinder-pipeline")];
const runStep = (env, id, pct, status) => [env.DB.prepare(
  "INSERT INTO flow_steps (job_id, name, status) SELECT id, ?2, ?3 FROM jobs WHERE id = ?1 ON CONFLICT DO UPDATE SET status = ?3").bind(id, `deploy ${pct}%`, status),
env.DB.prepare("UPDATE flow_jobs SET status = ? WHERE run_id = ? AND key = ?").bind(status, id, `rollout/deploy ${pct}%`),
env.DB.prepare(`INSERT INTO flow_step_runs (run_id, job_key, idx, name, status, finished_at) VALUES (?1, ?2, 0, ?3, ?4, ?5)
  ON CONFLICT DO UPDATE SET status = ?4, finished_at = ?5`).bind(id, `rollout/deploy ${pct}%`, `deploy ${pct}%`, status, new Date().toISOString())];
// A line in a sync's log, stored like a runner's step log (flow-logs.js appendLog): its rollout job's one step (idx 0), or
// the runner-style Set up job / Complete job around it (sysIdx), which flows.js getRun shows before and after it.
const sysIdx = (name) => 1 + SYSTEM_STEPS.indexOf(name);
const logLine = (env, repo, id, pct, text, idx = 0) => appendLog(env, {
  repo, name: idx ? SYSTEM_STEPS[idx - 1] : `deploy ${pct}%`, run: id, key: `rollout/deploy ${pct}%`, idx, job: id,
  ensure: env.DB.prepare("INSERT OR IGNORE INTO flow_step_logs (run_id, job_key, idx, job_id) VALUES (?, ?, ?, ?)").bind(id, `rollout/deploy ${pct}%`, idx, id),
}, null, [{ at: new Date().toISOString(), text }]);
const sysStep = (env, id, pct, name, status) => env.DB.prepare(`INSERT INTO flow_step_runs (run_id, job_key, idx, name, status, started_at, finished_at)
  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7) ON CONFLICT DO UPDATE SET status = ?5, finished_at = ?7`)
  .bind(id, `rollout/deploy ${pct}%`, sysIdx(name), name, status, new Date().toISOString(), status === "running" ? null : new Date().toISOString()).run();

export const announce = (env, repo, envName, status) => env.REPO_DO.get(env.REPO_DO.idFromName(repo)).broadcast({ kind: "environment", env: envName, status });

// The version's requests and errors (invocations that failed) since `since`, from the Workers analytics GraphQL API.
async function versionErrors(env, script, version, since, fetcher) {
  const query = `query($account: string!, $script: string!, $version: string!, $since: Time!) { viewer { accounts(filter: {accountTag: $account}) {
    workersInvocationsAdaptive(limit: 1, filter: {scriptName: $script, scriptVersion: $version, datetime_geq: $since}) { sum { requests errors } } } } }`;
  const res = await cloudflare(env, "/graphql", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables: { account: env.CF_ACCOUNT_ID, script, version, since } }),
  }, fetcher);
  if (res.errors?.length) throw new Error(`deploy: analytics query failed: ${res.errors.map((e) => e.message).join("; ")}`);
  // No rows means no requests in the window.
  return res.data.viewer.accounts[0]?.workersInvocationsAdaptive[0]?.sum ?? { requests: 0, errors: 0 };
}

function deployVersions(env, script, versions, fetcher) {
  return cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${script}/deployments`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ strategy: "percentage", versions }),
  }, fetcher);
}

// POST /api/repos/:name/environments/:env/rollback {reason} → 202 {name, id}: redeploys the latest Synced version other
// than the one deployed now, marks the rolled-back row Degraded and records who and why as a new Synced row `id`.
// Like promote, an environment without auto_sync whose earlier version is a published release answers 202 {name, need}
// instead: a Release approval whose Approve deploys that release.
export async function rollbackEnvironment(request, env, { name, env: envName }) {
  const body = await request.json().catch(() => null);
  if (typeof body?.reason !== "string" || !body.reason.trim()) return error(400, "bad_request", "body must be {reason} with non-empty reason");
  const current = await env.DB.prepare("SELECT id, version_id, changes FROM deploy_syncs WHERE repo = ? AND env = ? AND version_id IS NOT NULL ORDER BY started_at DESC LIMIT 1")
    .bind(name, envName).first();
  const good = current && await env.DB.prepare("SELECT sha, version_id FROM deploy_syncs WHERE repo = ? AND env = ? AND status = 'Synced' AND version_id != ? ORDER BY started_at DESC LIMIT 1")
    .bind(name, envName, current.version_id).first();
  if (!good) return error(409, "no_healthy_version", `${name} ${envName} has no earlier healthy version to roll back to`);
  const artifacts = createArtifacts(env.ARTIFACTS);
  const deploy = parseDeploy(await artifacts.readFile(name, good.sha, ".cinder.yml"));
  const release = !deploy.environments.find((e) => e.name === envName)?.auto_sync && await env.DB.prepare(
    "SELECT r.id FROM releases r JOIN tags t ON t.repo = r.repo AND t.name = r.tag WHERE r.repo = ? AND t.sha = ? AND r.state = 'published' ORDER BY r.created_at DESC LIMIT 1")
    .bind(name, good.sha).first("id");
  if (release) return promote(env, name, envName, release, personOf(request), false, false, true);
  const script = `${parseJsonc(await artifacts.readFile(name, good.sha, deploy.worker)).name}-${envName}`;
  await deployVersions(env, script, [{ version_id: good.version_id, percentage: 100 }]);
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("UPDATE deploy_syncs SET status = 'Degraded', at = ? WHERE id = ?").bind(now, current.id),
    // An automatic rollback's health reason on the current row is kept.
    env.DB.prepare("INSERT OR IGNORE INTO deploy_sync_reasons (sync_id, reason) VALUES (?, ?)").bind(current.id, body.reason),
    env.DB.prepare("INSERT INTO deploy_syncs (id, repo, env, sha, version_id, status, changes, actor, started_at, at) VALUES (?, ?, ?, ?, ?, 'Synced', '[]', ?, ?, ?)")
      .bind(id, name, envName, good.sha, good.version_id, personOf(request), now, now),
    env.DB.prepare("INSERT INTO deploy_sync_steps (sync_id, step) VALUES (?, 100)").bind(id),
    env.DB.prepare("INSERT INTO deploy_sync_reasons (sync_id, reason) VALUES (?, ?)").bind(id, body.reason),
    ...deployRun(env, name, id, envName, good.sha, [100], "done", now),
    ...runStep(env, id, 100, "passed"),
  ]);
  await logLine(env, name, id, 100, `rolled ${envName} back to ${good.sha.slice(0, 7)} (version ${good.version_id}) by ${personOf(request)}: ${body.reason}`);
  await scoreRisky(env, current.changes);
  await announce(env, name, envName, "Synced");
  return Response.json({ name: envName, id }, { status: 202 });
}
