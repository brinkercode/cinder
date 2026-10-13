// The keystore: one place for every key
// and secret, scoped global, repo, environment or flow. Values live in the account's Cloudflare Secrets Store:
// cinder keeps only a reference (store id, secret id and name) and who may use it, never a value or a ciphertext. Each
// secret is a secrets_store_secret binding on the cinder-secrets Worker, read through the SECRETS service binding only for
// a runner holding a job's lease.
import { personOf } from "./access.js";
import { cloudflare } from "./deploy.js";
import { mask } from "./mask.js";
import { isAllowedTarget } from "./policy.js";
import { error, runnerOf } from "./router.js";

const KINDS = ["runner_token", "worker_token", "deploy_token", "import_credential", "flow_secret", "environment_secret", "api_key"];
const SCOPES = ["global", "repo", "environment", "flow"];
const LIMIT = 100; // Secrets Store (beta): secrets per account
const HEADROOM = 5; // near the cap, new secrets are refused
// Never cinder itself: a settings PATCH rolls a new version, and a new cinder version resets every Durable Object and container.
const SCRIPT = "cinder-secrets"; // secrets/wrangler.jsonc
// last_used: the newest runner or deploy read; changed_by: who created or last rotated it.
const META = `id, name, kind, scope, repo, environment, flow, owner, expires_at, created_at, rotated_at,
  (SELECT max(at) FROM keystore_audit a WHERE a.secret_id = keystore_secrets.id AND action = 'read') AS last_used,
  (SELECT actor FROM keystore_audit a WHERE a.secret_id = keystore_secrets.id AND action <> 'read' ORDER BY a.id DESC LIMIT 1) AS changed_by`;
// A job may use a global secret or one of its repo, environment or flow; ?1 repo, ?2 environment, ?3 flow.
const IN_SCOPE = `(scope = 'global' OR (repo = ?1 AND (scope = 'repo' OR (scope = 'environment' AND environment = ?2) OR (scope = 'flow' AND flow = ?3))))`;

const stores = (env) => `/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores`;
const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
export const binding = (id) => `KS_${id.replaceAll("-", "")}`;

export const audit = (env, id, action, actor) =>
  env.DB.prepare("INSERT INTO keystore_audit (secret_id, action, actor, at) VALUES (?, ?, ?, ?)").bind(id, action, actor, new Date().toISOString());

// Values under 8 characters are refused, as runner/internal/mask refuses them: masking one would mangle ordinary output.
const goodValue = (v) => typeof v === "string" && v.length >= 8;
const nonEmpty = (v) => typeof v === "string" && v.length > 0;
const noStore = () => error(503, "no_secrets_store", "the account has no Secrets Store store yet; run make up or the release to create it");
// A Cloudflare 401 or 403 means cinder's API token lacks `permission`: a 503 naming it, never a fallback.
export const denied = (permission) => (err) => {
  if (err.status !== 401 && err.status !== 403) throw err;
  return error(503, "missing_permission", `cinder's Cloudflare API token needs ${permission}`);
};
export const SECRETS_STORE = "Secrets Store: Edit";

// The account's store (release and make up create it) and how many secrets it holds, or null when there is none.
async function storeUsage(env) {
  const { result } = await cloudflare(env, stores(env));
  if (!result?.length) return null;
  const { result: secrets, result_info: info } = await cloudflare(env, `${stores(env)}/${result[0].id}/secrets?per_page=1`);
  return { id: result[0].id, used: info?.total_count ?? secrets.length };
}

// The Secrets Store secrets cinder itself creates: keystore and webhook secrets (addToStore) and people's model keys
// (model-access.js, under the "cinder" gateway). Infrastructure secrets such as cinder_merge_signing_key never match.
export const APP_SECRET = /^cinder_([0-9a-f]{8}(_[0-9a-f]{4}){3}_[0-9a-f]{12}|[a-z-]+_p-[0-9a-f]{16})$/;
const SETTLE = 10 * 60_000; // a save in flight has written its secret but not yet its row

// Deletes store `storeId`'s cinder-created secrets that no keystore, webhook or model-access row references (a save
// aborted between the store write and the D1 write leaves one) → how many went. One younger than SETTLE, or with no
// created time, is left to the save that may still be writing its row.
async function sweepOrphans(env, storeId) {
  const { results } = await env.DB.prepare(`SELECT store_secret_name AS ref FROM keystore_secrets UNION SELECT store_secret_name FROM webhooks
    UNION SELECT substr(secret_id, instr(secret_id, '/') + 1) FROM model_providers WHERE secret_id IS NOT NULL`).all();
  const kept = new Set(results.map((r) => r.ref));
  // lazy: one page of 100, the account's cap (LIMIT); page through if the cap rises.
  const { result } = await cloudflare(env, `${stores(env)}/${storeId}/secrets?per_page=100`);
  const orphans = result.filter((s) => APP_SECRET.test(s.name) && !kept.has(s.name) && !kept.has(s.id) && Date.parse(s.created) < Date.now() - SETTLE);
  for (const s of orphans) {
    await cloudflare(env, `${stores(env)}/${storeId}/secrets/${s.id}`, { method: "DELETE" }).catch((err) => { if (err.status !== 404) throw err; });
  }
  return orphans.length;
}

// Puts `value` in the store as entry `id`'s secret → its reference, or an error Response when there's no store or
// the store is near its cap. No fallback: without the store there is nowhere a value may go. Orphans go first.
export async function addToStore(env, id, name, value) {
  const store = await storeUsage(env);
  if (!store) return noStore();
  store.used -= await sweepOrphans(env, store.id);
  if (store.used >= LIMIT - HEADROOM) {
    return error(409, "keystore_full", `the Secrets Store holds ${store.used} of its ${LIMIT} secrets (beta limit per account); remove a secret before adding another`);
  }
  const secretName = `cinder_${id.replaceAll("-", "_")}`;
  const { result: [made] } = await cloudflare(env, `${stores(env)}/${store.id}/secrets`, json("POST", [{ name: secretName, value, scopes: ["workers"], comment: `cinder keystore ${name}` }]));
  return { store_id: store.id, store_secret_id: made.id, store_secret_name: secretName };
}

// Gives cinder-secrets one secrets_store_secret binding per referenced secret and inherits every other binding: a
// settings PATCH, so Cloudflare rolls a new version of it. Webhook signing secrets get one too. A deploy or a racing
// change can drop a binding; readJobSecret and webhook delivery re-run this.
export async function rebind(env) {
  const path = `/accounts/${env.CF_ACCOUNT_ID}/workers/scripts/${SCRIPT}/settings`;
  const { result } = await cloudflare(env, path);
  // A model login's store and secret name follow from its secret_id ("<store>/<secret>") and addToStore's naming.
  const { results } = await env.DB.prepare(`SELECT id, store_id, store_secret_name FROM keystore_secrets UNION ALL SELECT id, store_id, store_secret_name FROM webhooks
    UNION ALL SELECT login_id, substr(secret_id, 1, instr(secret_id, '/') - 1), 'cinder_' || replace(login_id, '-', '_') FROM model_providers WHERE login_id IS NOT NULL`).all();
  const bindings = [...result.bindings.filter((b) => !b.name.startsWith("KS_")).map(({ name }) => ({ type: "inherit", name })),
    ...results.map((r) => ({ type: "secrets_store_secret", name: binding(r.id), store_id: r.store_id, secret_name: r.store_secret_name }))];
  const form = new FormData();
  form.set("settings", new Blob([JSON.stringify({ bindings })], { type: "application/json" }));
  await cloudflare(env, path, { method: "PATCH", body: form });
}

// POST /api/keystore/rebind → 204: re-binds every KS_* secret on cinder-secrets; the release calls it after a deploy drops them.
export async function rebindSecrets(request, env) {
  const failed = await rebind(env).catch(denied("Workers Scripts: Edit"));
  return failed ?? new Response(null, { status: 204 });
}

// POST /api/keystore {name, kind, scope, repo?, environment?, flow?, owner?, expires_at?, forks?, value} → 201 KeystoreSecret.
// owner defaults to the signed-in person; forks: true lets a global or repo secret reach untrusted runs too.
export async function createSecret(request, env) {
  const b = await request.json().catch(() => null);
  const { name, kind, scope, value } = b ?? {};
  const owner = b?.owner ?? personOf(request);
  const repo = scope === "global" ? null : b?.repo;
  const environment = scope === "environment" ? b?.environment : null;
  const flow = scope === "flow" ? b?.flow : null;
  const expires = b?.expires_at ?? null;
  const forks = b?.forks ?? false;
  if (!nonEmpty(name) || !KINDS.includes(kind) || !SCOPES.includes(scope) || !nonEmpty(owner) || !goodValue(value) ||
    (scope !== "global" && !nonEmpty(repo)) || (scope === "environment" && !nonEmpty(environment)) || (scope === "flow" && !nonEmpty(flow)) ||
    (expires !== null && Number.isNaN(Date.parse(expires))) || typeof forks !== "boolean") {
    return error(400, "bad_request", `body must be {name, kind, scope, owner, value (8+ characters), expires_at?, forks? (boolean)} with kind from ${KINDS.join(", ")}, scope from ${SCOPES.join(", ")}, and repo/environment/flow as the scope needs`);
  }
  if (repo && !(await env.DB.prepare("SELECT 1 FROM repos WHERE name = ?").bind(repo).first())) return error(404, "not_found", `no repo ${repo}`);
  // lazy: check then insert, so two concurrent adds of one name can both pass; add a unique index if that shows up.
  if (await env.DB.prepare("SELECT 1 FROM keystore_secrets WHERE name = ? AND scope = ? AND repo IS ? AND environment IS ? AND flow IS ?").bind(name, scope, repo, environment, flow).first()) {
    return error(409, "conflict", `${name} already exists in this scope; replace it from its row or pick another name`);
  }
  const id = crypto.randomUUID();
  const ref = await addToStore(env, id, name, value).catch(denied(SECRETS_STORE));
  if (ref instanceof Response) return ref;
  const now = new Date().toISOString();
  const [, , { results: [row] }] = await env.DB.batch([
    env.DB.prepare("INSERT INTO keystore_secrets (id, name, kind, scope, repo, environment, flow, owner, expires_at, store_id, store_secret_id, store_secret_name, created_at, forks) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(id, name, kind, scope, repo, environment, flow, owner, expires, ref.store_id, ref.store_secret_id, ref.store_secret_name, now, forks ? 1 : 0),
    audit(env, id, "create", personOf(request)),
    env.DB.prepare(`SELECT ${META} FROM keystore_secrets WHERE id = ?`).bind(id),
  ]);
  await rebind(env);
  return Response.json(row, { status: 201 });
}

// GET /api/keystore → {secrets: KeystoreSecret[], wanted}: metadata only. wanted: each secret a step whose latest report
// failed named missing, unless a global or same-repo secret of that name is saved since; one row per repo, flow and step,
// from its newest run.
export async function listKeystore(request, env) {
  const [{ results: secrets }, { results: wanted }] = await env.DB.batch([
    env.DB.prepare(`SELECT ${META} FROM keystore_secrets ORDER BY name, id`),
    env.DB.prepare(`SELECT s.value AS name, r.name AS repo, json_extract(j.payload, '$.flow') AS flow, f.name AS step,
        coalesce(json_extract(j.payload, '$.run_id'), j.id) AS run_id, max(j.created_at) AS at
      FROM flow_steps f JOIN flow_step_missing_secrets m ON m.job_id = f.job_id AND m.name = f.name JOIN jobs j ON j.id = f.job_id
        JOIN repos r ON r.id = j.repo_id, json_each(m.secrets) s
      WHERE f.status = 'failed' AND NOT EXISTS (SELECT 1 FROM keystore_secrets k WHERE k.name = s.value AND (k.scope = 'global' OR k.repo = r.name))
      GROUP BY s.value, r.name, json_extract(j.payload, '$.flow'), f.name ORDER BY s.value, r.name`),
  ]);
  for (const w of wanted) delete w.at; // max(at) only makes SQLite take the newest run's columns
  return Response.json({ secrets, wanted });
}

// GET /api/keystore/usage → {used, limit}: the account's Secrets Store secrets against its beta cap, from one quota
// request (the cap is per account, so no store lookup first). Server-Timing: that request's time.
export async function getKeystoreUsage(request, env) {
  const start = Date.now();
  const quota = await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/secrets_store/quota`).catch(denied(SECRETS_STORE));
  if (quota instanceof Response) return quota;
  return Response.json({ used: quota.result.secrets.usage, limit: LIMIT }, { headers: { "Server-Timing": `secrets-store;dur=${Date.now() - start}` } });
}

// POST /api/keystore/:id/rotate {value} → 200 KeystoreSecret: replaces the value in the store and records the rotation.
export async function rotateSecret(request, env, { id }) {
  const b = await request.json().catch(() => null);
  if (!goodValue(b?.value)) return error(400, "bad_request", "body must be {value} with 8+ characters");
  const row = await env.DB.prepare("SELECT store_id, store_secret_id FROM keystore_secrets WHERE id = ?").bind(id).first();
  if (!row) return error(404, "not_found", `no secret ${id}`);
  const put = await cloudflare(env, `${stores(env)}/${row.store_id}/secrets/${row.store_secret_id}`, json("PATCH", { value: b.value })).catch(denied(SECRETS_STORE));
  if (put instanceof Response) return put;
  const [, , { results: [updated] }] = await env.DB.batch([
    env.DB.prepare("UPDATE keystore_secrets SET rotated_at = ? WHERE id = ?").bind(new Date().toISOString(), id),
    audit(env, id, "rotate", personOf(request)),
    env.DB.prepare(`SELECT ${META} FROM keystore_secrets WHERE id = ?`).bind(id),
  ]);
  return Response.json(updated);
}

// DELETE /api/keystore/:id → 204: removes the value from the store, then the reference and its binding.
export async function removeSecret(request, env, { id }) {
  const row = await env.DB.prepare("SELECT store_id, store_secret_id FROM keystore_secrets WHERE id = ?").bind(id).first();
  if (!row) return error(404, "not_found", `no secret ${id}`);
  const gone = await cloudflare(env, `${stores(env)}/${row.store_id}/secrets/${row.store_secret_id}`, { method: "DELETE" })
    .catch((err) => (err.status === 404 ? null : denied(SECRETS_STORE)(err))); // a 404: already gone from the store
  if (gone instanceof Response) return gone;
  await env.DB.batch([env.DB.prepare("DELETE FROM keystore_secrets WHERE id = ?").bind(id), audit(env, id, "remove", personOf(request))]);
  await rebind(env);
  return new Response(null, { status: 204 });
}

// GET /api/keystore/:id/audit → [{action, actor, at}], oldest first.
export async function getKeystoreAudit(request, env, { id }) {
  const { results } = await env.DB.prepare("SELECT action, actor, at FROM keystore_audit WHERE secret_id = ? ORDER BY id").bind(id).all();
  return Response.json(results);
}

// The id of the most specific unexpired secret `name` in scope for repo, environment and flow, or null. An untrusted
// caller gets only secrets marked forks.
export async function resolveSecret(env, repo, environment, flow, name, trusted = true) {
  return env.DB.prepare(`SELECT id FROM keystore_secrets WHERE ${IN_SCOPE} AND name = ?4 AND (expires_at IS NULL OR expires_at > ?5) AND (?6 = 1 OR forks = 1)
    ORDER BY CASE scope WHEN 'flow' THEN 0 WHEN 'environment' THEN 1 WHEN 'repo' THEN 2 ELSE 3 END LIMIT 1`)
    .bind(repo, environment, flow, name, new Date().toISOString(), trusted ? 1 : 0).first("id");
}

// The id of secret name for a flow job (its repo, branch_policy and payload), or null. Environment and
// flow secrets go only to protected code: push and cron run the default branch head, a manual run its ref, which must be
// an integration or release branch. A change's fork, or a run with no trigger, gets neither, and a global or repo secret
// only when it is marked forks; a withheld secret 404s as a missing one does.
function resolveFor(env, job, name) {
  const payload = JSON.parse(job.payload);
  const trusted = payload.fork == null && (["push", "cron"].includes(payload.trigger)
    || (payload.trigger === "manual" && isAllowedTarget(JSON.parse(job.branch_policy), payload.ref)));
  return resolveSecret(env, job.repo, trusted ? payload.environment ?? null : null, trusted ? payload.flow ?? null : null, name, trusted);
}

// The names among names that flow job jobId would not resolve, in order: what its runner reports missing.
export async function unresolved(env, jobId, names) {
  const job = await env.DB.prepare("SELECT r.name AS repo, r.branch_policy, j.payload FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE j.id = ?").bind(jobId).first();
  const ids = await Promise.all(names.map((n) => resolveFor(env, job, n)));
  return names.filter((_, i) => !ids[i]);
}

// GET /api/work/jobs/:job/secrets/:secret → {value} for the runner holding a flow job's lease, read through the secret's
// binding. Agent sandboxes never get a value: any other job kind is refused at every scope. Resolves within the job's repo (and its payload's environment and flow) or global; the most specific
// unexpired match wins. A secret of another repo is a 404, never a 403, so its existence
// doesn't leak.
export async function readJobSecret(request, env, { job: jobId, secret: name }) {
  const runner = await runnerOf(request, env);
  const job = await env.DB.prepare("SELECT r.name AS repo, r.branch_policy, j.payload FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE j.id = ? AND j.kind = 'flow' AND j.runner_id = ? AND j.status = 'claimed' AND j.lease_expires_at > ?")
    .bind(jobId, runner.runner_id, new Date().toISOString()).first();
  if (!job) return error(403, "forbidden", `job ${jobId} is not a flow job leased to this runner`);
  const id = await resolveFor(env, job, name);
  if (!id) return error(404, "not_found", `no secret ${name} for this job`);
  const value = await env.SECRETS.read(binding(id));
  if (value == null) {
    await rebind(env);
    return error(503, "binding_pending", `secret ${name} is being bound to cinder-secrets; retry in a minute`);
  }
  await audit(env, id, "read", `runner:${runner.runner_id}`).run();
  return Response.json({ value });
}

// A job's report body, parsed after every value bound for the job and every token-shaped string is masked; null when it isn't JSON.
// lazy: reads each in-scope binding per report; cache per job if a repo holds more than a few dozen secrets.
export async function maskedJson(request, env, jobId) {
  const text = await request.text();
  const job = await env.DB.prepare("SELECT r.name AS repo, j.payload FROM jobs j JOIN repos r ON r.id = j.repo_id WHERE j.id = ?").bind(jobId).first();
  const payload = JSON.parse(job?.payload ?? "{}");
  const { results } = job ? await env.DB.prepare(`SELECT id FROM keystore_secrets WHERE ${IN_SCOPE}`).bind(job.repo, payload.environment ?? null, payload.flow ?? null).all() : { results: [] };
  const values = (await Promise.all(results.map((r) => env.SECRETS.read(binding(r.id))))).filter(Boolean);
  try {
    return JSON.parse(mask(text, values));
  } catch {
    return null;
  }
}
