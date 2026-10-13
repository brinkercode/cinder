// Managed worker pools: one Cloudflare Container per worker, running the runner image with that worker's own token.
import { Container } from "@cloudflare/containers";
import { JOB_KINDS } from "./api/contract.js";
import { POOL_SIZES } from "./api/shapes/pool.js";
import { AGENTS_REPO, DEFAULT_EGRESS, GO_MODULE_HOSTS, HOST_PATTERN } from "./agents.js";
import { createArtifacts } from "./artifacts.js";
import { byokAlias, keyUsed, loginFor } from "./model-access.js";
import { budgetUse } from "./overview.js";
import { error, route } from "./router.js";
import { routes } from "./routes.js";
import { BYO_KINDS, OFFLINE_MS, registerRunner } from "./runners.js";
import { AGENT_KINDS, agentLock } from "./work.js";

// A worker serves no requests, so the default idle stop (sleepAfter) would kill it mid-job; a scale-down or stopIfIdle stops it.
// It has no internet of its own: every HTTP and HTTPS request, whatever proxy settings the process uses, goes to the
// outbound handlers below, and anything else (a raw socket) goes nowhere.
class RunnerContainer extends Container {
  enableInternet = false;
  interceptHttps = true;
  async onActivityExpired() {}
}
// Cloudflare sets the instance type per Container class (wrangler.jsonc), so each pool size has its own class and binding.
export class WorkerLite extends RunnerContainer {}
export class WorkerBasic extends RunnerContainer {}
export class WorkerStandard extends RunnerContainer {}
export class WorkerStandard4 extends RunnerContainer {}
export const BINDINGS = { lite: "WORKER_LITE", basic: "WORKER_BASIC", "standard-2": "WORKER_STANDARD", "standard-4": "WORKER_STANDARD4" };
// Lite and basic run the slim image (Node and git); standard-2 and standard-4 run the full one, which bakes Go, Python, Rust, .NET (C#),
// Java/Kotlin, PHP, Ruby and Terraform (HCL). A job that builds or runs the code of a repo whose language the slim image
// can't build matches this (SQL over a jobs row), and only a standard-2 or standard-4 pool claims it: a baked stack, or any other one,
// whose toolchain is set up on the full pool's larger disk. A repo with no language stays on any pool.
// lazy: routes on the repo's one language (repo_meta); read the repo's toolchains if repos mix stacks.
export const NEEDS_FULL_IMAGE = `(kind IN ('develop', 'resolve', 'commit', 'seam', 'split', 'verify', 'flow')
  AND repo_id IN (SELECT repo_id FROM repo_meta WHERE language NOT IN ('JavaScript', 'TypeScript', 'CSS', 'HTML', 'Vue', 'Svelte', 'Shell')))`;
// A job the pool with id `pool` (SQL) may take: its labels cover the job's runs_on (a BYO pool's own labels, else
// pool_settings'; a job without runs_on fits any pool), and a pool with pool_repos rows takes only those repos' jobs.
export const POOL_TAKES = (pool) => `(NOT EXISTS (SELECT 1 FROM json_each(payload, '$.runs_on') WHERE value NOT IN (SELECT value
  FROM json_each(coalesce((SELECT labels FROM byo_pools WHERE id = ${pool}), (SELECT labels FROM pool_settings WHERE pool_id = ${pool}), '[]'))))
  AND (repo_id IN (SELECT repo_id FROM pool_repos WHERE pool_id = ${pool}) OR NOT EXISTS (SELECT 1 FROM pool_repos WHERE pool_id = ${pool})))`;

// The pool worker a container runs: its Durable Object id is named by the worker's runner id (scaleTo).
// lazy: hashes every pool member's id per model call; store the container id on pool_members past a few hundred workers.
async function runnerOf(env, containerId) {
  if (!containerId) return null;
  const { results } = await env.DB.prepare("SELECT m.runner_id, coalesce((SELECT size FROM pool_member_sizes WHERE runner_id = m.runner_id), p.size) AS size FROM pool_members m JOIN worker_pools p ON p.id = m.pool_id").all();
  return results.find((r) => env[BINDINGS[r.size]].idFromName(r.runner_id).toString() === containerId)?.runner_id ?? null;
}
// The container's egress (ContainerProxy, exported from index.js). The public origin sits behind Cloudflare Access, which
// turns away a container without service-token headers, so cinder.internal hands its requests straight to the router.
// models.internal forwards through the Worker's AI binding, which reaches the gateway inside the account with no token to
// set; the gateway adds the stored provider key (the person's under cf-aig-byok-alias, else the org's), so no model key
// ever enters the container. cf-aig-metadata goes to the gateway, other cf-aig-* headers are dropped, the rest go to the provider. A call is answered only while the
// container's worker holds a live develop, resolve or review job (never a verify or flow job running repo code), and not
// while the month's budget pauses agent work.
const OUTBOUND = {
  // A worker's write (claim, report, heartbeat) may queue or free a job, so pools scale after it as after any other write
  // (index.js fetch); there is no waitUntil here, so the worker's request waits for it.
  "cinder.internal": async (req, env) => {
    const res = await route(req, env, routes);
    if (req.method !== "GET" && res.ok) await autoscale(env).catch((e) => console.warn(`autoscale: ${e.message}`));
    return res;
  },
  "models.internal": async (req, env, ctx) => {
    if (!env.AI_GATEWAY_ID) return error(503, "gateway_unconfigured", "AI_GATEWAY_ID must be set");
    const runner = await runnerOf(env, ctx.containerId);
    const agent = runner && await env.DB.prepare(`SELECT 1 FROM jobs WHERE runner_id = ? AND status = 'claimed' AND lease_expires_at > ?
      AND kind IN ('develop', 'resolve', 'review')`).bind(runner, new Date().toISOString()).first();
    if (!agent) return error(403, "no_agent_job", "model calls are allowed only while the container runs a develop, resolve or review job");
    if ((await budgetUse(env.DB)).paused) return error(402, "budget_paused", "the month's budget is reached: agent work is paused");
    const url = new URL(req.url);
    const [, provider, ...endpoint] = url.pathname.split("/");
    const query = await req.json().catch(() => null);
    if (!provider || query === null) return error(400, "bad_request", "expected POST /<provider>/<endpoint> with a JSON body");
    const headers = {};
    const gateway = {};
    // Only cf-aig-metadata reaches the gateway: a container-set cf-aig-byok-alias would spend someone else's stored key.
    for (const [k, v] of req.headers) {
      if (k === "cf-aig-metadata") gateway[k] = v;
      else if (!k.startsWith("cf-aig-") && !["x-api-key", "authorization", "host", "content-length"].includes(k)) headers[k] = v;
    }
    // A requester's subscription login rides as the provider's bearer, which the gateway passes through instead of a stored key.
    const login = await loginFor(env, runner, url.pathname);
    if (login && !login.token) return error(503, "binding_pending", "the subscription login is being bound to cinder-secrets; retry in a minute");
    let byok = null;
    if (login) {
      headers.authorization = `Bearer ${login.token}`;
      headers["anthropic-beta"] = headers["anthropic-beta"] ? `${headers["anthropic-beta"]},oauth-2025-04-20` : "oauth-2025-04-20";
    } else {
      byok = await byokAlias(env, runner, url.pathname);
      if (byok) gateway["cf-aig-byok-alias"] = byok.alias;
    }
    const res = await env.AI.gateway(env.AI_GATEWAY_ID).run({ provider, endpoint: endpoint.join("/") + url.search, headers, query }, { extraHeaders: gateway });
    // The answer is the attached credential's status: the login's, the alias's key, or with none (credits, the org key) no person's.
    if (login) await keyUsed(env, login.person, "anthropic", "login", res);
    if (byok) await keyUsed(env, byok.person, byok.provider, "key", res);
    return res;
  },
};
// The toolchain downloads cinder-verify may make on a tool cache miss (runner/cmd/cinder-verify/toolcache.go).
const SETUP_HOSTS = ["nodejs.org", "dl.google.com", "releases.hashicorp.com", "get.helm.sh"];
const matches = (pattern, host) => new RegExp(`^${pattern.replaceAll(".", "\\.").replaceAll("*", ".*").replaceAll("?", ".")}$`).test(host);
const refuse = (host, why) => error(403, "egress_denied", `${host}: ${why}`);
const GO_HOSTS = ["proxy.golang.org", "sum.golang.org", "pkg.go.dev"];
// Every other host: reached only while the container holds a job and the host is on that job's allowlist, which is its
// agent version's egress (an agent job), else its pool's (open allows any host, none no listed host), plus Artifacts and
// the toolchain downloads. A container holding several jobs gets only the hosts every job allows. The default hosts are
// registry and docs reads, so a write to one (a publish) is refused; the Go module services fetch the origin a module
// path names, so a module host must be a public code host or on the allowlist.
// An allowed GET for a container whose every job is an agent on web markdown asks for Markdown; an HTML answer anyway is
// converted with Workers AI before the agent reads it, counted on the job's web usage. Anything else passes through.
// lazy: reads the jobs and their allowlists per request; cache per container if a job's request rate makes D1 the bottleneck.
// Workers clone blobless (runner gitauth) and fetch a file's contents only when a command reads it. Those later fetches
// carry no token: a git read (smart-HTTP upload-pack, never receive-pack) of a repo or change fork one of the container's
// jobs works on gets a 60-second read token here, so no Artifacts token is ever kept in the container.
async function gitRead(req, env, url, jobs) {
  const m = url.pathname.match(/\/([^/]+)\.git\/(info\/refs|git-upload-pack)$/);
  const read = m && (m[2] === "git-upload-pack" ? req.method === "POST" : url.searchParams.get("service") === "git-upload-pack");
  if (!read || req.headers.has("authorization")) return req;
  const changes = JSON.stringify(jobs.map((j) => j.change_id).filter(Boolean));
  const { results } = await env.DB.prepare("SELECT fork FROM change_numbers WHERE change_id IN (SELECT value FROM json_each(?))").bind(changes).all();
  if (![...jobs.map((j) => j.repo), ...results.map((r) => r.fork)].includes(m[1])) return req;
  const headers = new Headers(req.headers);
  headers.set("authorization", `Bearer ${(await createArtifacts(env.ARTIFACTS).createToken(m[1], "read", 60)).token}`);
  return new Request(req, { headers });
}

async function egress(req, env, ctx) {
  const url = new URL(req.url);
  const host = url.hostname.toLowerCase();
  if (DEFAULT_EGRESS.includes(host) && !["GET", "HEAD"].includes(req.method)) return refuse(host, "default hosts are read only");
  let module = null;
  if (GO_HOSTS.includes(host)) {
    // The module path's first element, past a sumdb proxy prefix and a lookup/mod/badge route; "!x" escapes an uppercase letter.
    const first = url.pathname.match(/^\/(?:sumdb\/[^/]+\/)?(?:lookup\/|mod\/|badge\/)?([^/@]*)/)[1];
    try {
      module = decodeURIComponent(first).replaceAll("!", "").toLowerCase();
    } catch {
      return refuse(host, "malformed module path");
    }
    // Without a dot it is the standard library or a service route, never a fetched origin.
    if (!module.includes(".") || GO_MODULE_HOSTS.includes(module)) module = null;
  }
  const runner = await runnerOf(env, ctx.containerId);
  const jobs = runner ? (await env.DB.prepare(`SELECT j.id, j.kind, j.change_id, j.payload, r.name AS repo, s.egress AS mode, s.egress_allow FROM jobs j
    LEFT JOIN repos r ON r.id = j.repo_id LEFT JOIN pool_members m ON m.runner_id = j.runner_id LEFT JOIN pool_settings s ON s.pool_id = m.pool_id
    WHERE j.runner_id = ? AND j.status = 'claimed'`).bind(runner).all()).results : [];
  if (!jobs.length) return refuse(host, "the container holds no job");
  const locks = [];
  for (const job of jobs) {
    const lock = job.change_id && AGENT_KINDS.includes(job.kind) ? await agentLock(env, job.change_id, job.kind, JSON.parse(job.payload)) : null;
    locks.push(lock);
    if (job.mode === "open") continue;
    const pool = JSON.parse(job.egress_allow ?? "[]");
    const list = lock?.egress ?? (job.mode === "none" ? [] : pool.length ? pool : DEFAULT_EGRESS);
    if (module && !list.some((p) => matches(p, module))) return refuse(host, `module host ${module} is not on the job's egress allowlist`);
    if ([...SETUP_HOSTS, ...list].some((p) => matches(p, host))) continue;
    const store = await createArtifacts(env.ARTIFACTS).get(job.repo ?? AGENTS_REPO);
    if (store && new URL((await store.info()).remote).hostname === host) continue;
    return refuse(host, "not on the job's egress allowlist");
  }
  req = await gitRead(req, env, url, jobs);
  if (req.method !== "GET" || !locks.every((l) => l?.web === "markdown")) return fetch(req);
  const headers = new Headers(req.headers);
  headers.set("accept", "text/markdown, text/html;q=0.9, */*;q=0.8");
  const res = await fetch(new Request(req, { headers }));
  if (!/^text\/html\b/i.test(res.headers.get("content-type") ?? "")) return res;
  const html = await res.blob();
  const [out] = await env.AI.toMarkdown([{ name: "page.html", blob: new Blob([html], { type: "text/html" }) }]);
  // A page the conversion can't read (too large, malformed) still reaches the agent, as served.
  if (out?.format !== "markdown") return new Response(html, res);
  const body = new TextEncoder().encode(out.data);
  await env.DB.prepare("INSERT INTO job_web_usage (job_id, agent_version, converted, saved_bytes) VALUES (?, ?, 1, ?) " +
    "ON CONFLICT (job_id) DO UPDATE SET converted = converted + 1, saved_bytes = saved_bytes + excluded.saved_bytes")
    .bind(jobs[0].id, `${locks[0].name}@v${locks[0].version}`, html.size - body.length).run();
  const sent = new Headers(res.headers);
  sent.set("content-type", "text/markdown; charset=utf-8");
  for (const h of ["content-length", "content-encoding", "etag"]) sent.delete(h);
  return new Response(body, { status: res.status, statusText: res.statusText, headers: sent });
}
// The registry is keyed by class name, so each class sets it (a static field would shadow the setter).
for (const c of [WorkerLite, WorkerBasic, WorkerStandard, WorkerStandard4]) {
  c.outboundByHost = OUTBOUND;
  c.outbound = egress;
}

const validKinds = (kinds) => Array.isArray(kinds) && kinds.length > 0 && kinds.every((k) => JOB_KINDS.includes(k));
const poolOf = (env, id) => env.DB.prepare("SELECT * FROM worker_pools WHERE id = ?").bind(id).first();
export const forget = (env, id) => env.DB.batch(["pool_members", "pool_member_sizes", "byo_members", "byo_member_tokens", "runner_heartbeats", "runner_tokens"].map((t) => env.DB.prepare(`DELETE FROM ${t} WHERE runner_id = ?`).bind(id)));
// size is the member's own: after a resize, a member still busy on the old size is stopped through that binding.
const poolOfMember = (env, runnerId) => env.DB.prepare("SELECT p.id, p.name, p.min_count, p.kinds, coalesce((SELECT size FROM pool_member_sizes WHERE runner_id = m.runner_id), p.size) AS size FROM worker_pools p JOIN pool_members m ON m.pool_id = p.id WHERE m.runner_id = ?").bind(runnerId).first();
async function halt(env, pool, id) {
  await forget(env, id);
  const ns = env[BINDINGS[pool.size]];
  await ns.get(ns.idFromName(id)).stop();
}

// {repo} → [repo_id, null] (null repo = any repo), or [null, Response] when the repo is unknown.
async function repoId(env, repo) {
  if (repo === null || repo === undefined || repo === "") return [null, null];
  const row = typeof repo === "string" && (await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(repo).first());
  return row ? [row.id, null] : [null, error(404, "not_found", `no repo named ${repo}`)];
}

// Starts or stops containers until the pool runs `count` workers. A stopped worker's token is deleted with it; a job it
// held returns to the queue when its lease expires.
async function scaleTo(env, pool, count) {
  const { results } = await env.DB.prepare("SELECT runner_id, coalesce((SELECT size FROM pool_member_sizes WHERE runner_id = m.runner_id), ?2) AS size FROM pool_members m WHERE pool_id = ?1 ORDER BY rowid").bind(pool.id, pool.size).all();
  const ns = env[BINDINGS[pool.size]];
  for (let i = results.length; i < count; i++) {
    // One batch: a cut-off invocation never leaves a token without its pool membership.
    const { id, token } = await registerRunner(env, `${pool.name}-${crypto.randomUUID().slice(0, 8)}`, JSON.parse(pool.kinds), (id) => [
      env.DB.prepare("INSERT INTO pool_members (runner_id, pool_id) VALUES (?, ?)").bind(id, pool.id),
      env.DB.prepare("INSERT OR REPLACE INTO pool_member_sizes (runner_id, size) VALUES (?, ?)").bind(id, pool.size)]);
    // A container that never started must not leave a live token behind.
    // ANTHROPIC_API_KEY is a placeholder claude needs to start; models.internal drops it and the gateway adds the real key.
    // Intercepted HTTPS is signed by the Containers CA, which Go, OpenSSL, git and Node are pointed at.
    const ca = "/etc/cloudflare/certs/cloudflare-containers-ca.crt";
    await ns.get(ns.idFromName(id)).start({ envVars: { CINDER_URL: "http://cinder.internal", CINDER_RUNNER_TOKEN: token, CINDER_AI_GATEWAY: "http://models.internal",
      ANTHROPIC_API_KEY: "via-gateway", SSL_CERT_FILE: ca, GIT_SSL_CAINFO: ca, NODE_EXTRA_CA_CERTS: ca } }).catch(async (e) => { await forget(env, id); throw e; });
  }
  for (const { runner_id: id, size } of results.slice(count)) await halt(env, { size }, id);
}

// A pool worker whose claim found nothing stops, unless that would take its pool below `min`, it still holds a job, or
// less than its pool's keep_warm_s has passed since its last job (or its start, before any).
// One statement decides, so two idle workers polling at once never both leave.
export async function stopIfIdle(env, runnerId) {
  const pool = await poolOfMember(env, runnerId);
  if (!pool) return;
  const { meta } = await env.DB.prepare(`DELETE FROM pool_members WHERE runner_id = ?1 AND (SELECT count(*) FROM pool_members WHERE pool_id = ?2) > ?3
    AND NOT EXISTS (SELECT 1 FROM jobs WHERE runner_id = ?1 AND status = 'claimed')
    AND ?4 >= coalesce((SELECT max(unixepoch(r.started_at)) FROM pool_runs r JOIN jobs j ON j.id = r.job_id WHERE j.runner_id = ?1),
      (SELECT unixepoch(created_at) FROM runner_tokens WHERE runner_id = ?1), 0) + coalesce((SELECT keep_warm_s FROM pool_settings WHERE pool_id = ?2), ${DEFAULTS.keep_warm_s})`)
    .bind(runnerId, pool.id, pool.min_count, Math.floor(Date.now() / 1000)).run();
  if (meta.changes) await halt(env, pool, runnerId);
}

// A pool worker runs one job: once it has reported, it stops and its token goes, so no state reaches a next job.
export async function retire(env, runnerId) {
  const pool = await poolOfMember(env, runnerId);
  if (pool) await halt(env, pool, runnerId);
}

// Starts a worker for each queued job a pool's idle workers can't take, up to max, and refills the pool to min. A claimed
// job whose lease expired (its worker stopped mid-job, as a deploy's rollout does) counts as queued: it is claimable again.
// Called after any request or batch that may have queued a job. lazy: two concurrent calls (or two pools with the same
// kinds) can each start one for the same job; the spare stops on its first empty claim (stopIfIdle).
// Also prunes pool_runs older than a day; pools() reads only the last hour.
export async function autoscale(env) {
  await env.DB.prepare("DELETE FROM pool_runs WHERE started_at < ?").bind(new Date(Date.now() - 86400 * 1000).toISOString()).run();
  const { results } = await env.DB.prepare(`SELECT p.*, (SELECT count(*) FROM pool_members m WHERE m.pool_id = p.id) AS members,
    (SELECT count(*) FROM pool_members m WHERE m.pool_id = p.id AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.runner_id = m.runner_id AND j.status = 'claimed')) AS idle,
    (SELECT count(*) FROM jobs j WHERE (j.status = 'queued' OR (j.status = 'claimed' AND j.lease_expires_at <= ?1))
      AND j.kind IN (SELECT value FROM json_each(p.kinds)) AND (p.repo_id IS NULL OR j.repo_id = p.repo_id)
      AND (p.size LIKE 'standard-%' OR NOT ${NEEDS_FULL_IMAGE}) AND (p.size <> 'lite' OR j.kind NOT IN ('develop', 'resolve', 'review')) AND ${POOL_TAKES("p.id")} AND j.id NOT IN (SELECT job_id FROM job_cancels)) AS queued
    FROM worker_pools p WHERE p.draining = 0`).bind(new Date().toISOString()).all();
  for (const p of results) {
    const want = Math.min(p.max_count, Math.max(p.min_count, p.members - p.idle + p.queued));
    // A start Cloudflare refuses ("no container instance … try again later") leaves the pool short until the next call
    // (any request, the 10-minute cron): it never stops the other pools from scaling.
    if (want > p.members) await scaleTo(env, p, want).catch((e) => console.warn(`autoscale ${p.name}: ${e.message}`));
  }
}

// Pool workers not heard from in GONE_MS that hold no live lease are gone (crashed, or evicted by Cloudflare): their
// containers are stopped and their tokens pruned. A job outlasts its claim's heartbeat, so a held lease keeps a worker.
const GONE_MS = 15 * 60 * 1000;
export async function pruneGone(env) {
  const now = Date.now();
  const { results } = await env.DB.prepare(`SELECT m.runner_id, coalesce((SELECT size FROM pool_member_sizes WHERE runner_id = m.runner_id), p.size) AS size FROM pool_members m JOIN worker_pools p ON p.id = m.pool_id
    JOIN runner_tokens t ON t.runner_id = m.runner_id LEFT JOIN runner_heartbeats h ON h.runner_id = m.runner_id
    WHERE coalesce(h.last_heartbeat_at, t.created_at) < ?1 AND NOT EXISTS (SELECT 1 FROM jobs j WHERE j.runner_id = m.runner_id AND j.status = 'claimed' AND j.lease_expires_at > ?2)`)
    .bind(new Date(now - GONE_MS).toISOString(), new Date(now).toISOString()).all();
  for (const { runner_id: id, size } of results) await halt(env, { size }, id);
  // Tokens a cut-off scaleTo left before it wrote token and membership in one batch: named after a pool, in none, never heard from.
  const { results: orphans } = await env.DB.prepare(`SELECT t.runner_id FROM runner_tokens t JOIN worker_pools p ON t.name LIKE p.name || '-%'
    WHERE t.created_at < ?1 AND NOT EXISTS (SELECT 1 FROM pool_members m WHERE m.runner_id = t.runner_id)
    AND NOT EXISTS (SELECT 1 FROM byo_members b WHERE b.runner_id = t.runner_id) AND NOT EXISTS (SELECT 1 FROM runner_heartbeats h WHERE h.runner_id = t.runner_id)`)
    .bind(new Date(now - GONE_MS).toISOString()).all();
  for (const { runner_id: id } of orphans) await forget(env, id);
}

// POST /api/workers/pools {name, size, min?, max, kinds?, repo?} → 201 Pool, with `min` workers started. min defaults to 0:
// queued jobs start workers (autoscale), so a warm floor only buys a faster accept. kinds defaults to every job kind.
export async function createPool(request, env) {
  const b = await request.json().catch(() => null);
  const min = b?.min ?? 0;
  const kinds = b?.kinds ?? JOB_KINDS;
  if (typeof b?.name !== "string" || !b.name || !POOL_SIZES.includes(b.size) || !Number.isInteger(min) || !Number.isInteger(b.max)
    || min < 0 || b.max < min || b.max > 20 || !validKinds(kinds)) {
    return error(400, "bad_request", `body must be {name, size, min?, max, kinds?, repo?} with size from: ${POOL_SIZES.join(", ")}, 0 <= min <= max <= 20, kinds from: ${JOB_KINDS.join(", ")}`);
  }
  const [repo, missing] = await repoId(env, b.repo);
  if (missing) return missing;
  const id = crypto.randomUUID();
  if (await nameTaken(env, b.name, id)) return error(409, "name_taken", `a pool named ${b.name} already exists`);
  const inserted = await env.DB.prepare(`INSERT INTO worker_pools (id, name, size, min_count, max_count, repo_id, kinds, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING`).bind(id, b.name, b.size, min, b.max, repo, JSON.stringify(kinds), new Date().toISOString()).run();
  if (!inserted.meta.changes) return error(409, "name_taken", `a pool named ${b.name} already exists`);
  await scaleTo(env, await poolOf(env, id), min);
  return Response.json(await pools(env, id), { status: 201 });
}

// All pools, or the one with `id`.
async function pools(env, id) {
  const { results } = await env.DB.prepare(`SELECT p.*, r.name AS repo, (SELECT count(*) FROM pool_members m WHERE m.pool_id = p.id) AS workers,
    (SELECT count(*) FROM pool_members m JOIN runner_heartbeats h ON h.runner_id = m.runner_id WHERE m.pool_id = p.id AND h.last_heartbeat_at > ?) AS online,
    p.id = (SELECT id FROM worker_pools ORDER BY created_at, id LIMIT 1) AS is_default
    FROM worker_pools p LEFT JOIN repos r ON r.id = p.repo_id ORDER BY p.name`).bind(new Date(Date.now() - OFFLINE_MS).toISOString()).all();
  // lazy: reads every start of the last hour and takes medians here; move to SQL past ~10k runs an hour.
  const { results: runs } = await env.DB.prepare("SELECT pool_id, start_s FROM pool_runs WHERE started_at > ? ORDER BY start_s")
    .bind(new Date(Date.now() - 3600 * 1000).toISOString()).all();
  const starts = (pool) => runs.filter((r) => r.pool_id === pool).map((r) => r.start_s);
  const median = (s) => (s.length ? Math.round((s[(s.length - 1) >> 1] + s[s.length >> 1]) / 2) : null);
  const list = results.map((p) => ({ id: p.id, name: p.name, size: p.size, min: p.min_count, max: p.max_count, repo: p.repo, kinds: JSON.parse(p.kinds),
    draining: p.draining === 1, workers: p.workers, online: p.online, created_at: p.created_at, default: p.is_default === 1,
    runs_per_hour: starts(p.id).length, median_start_s: median(starts(p.id)) })).filter((p) => !id || p.id === id);
  return id ? (await withSettings(env, list))[0] : withSettings(env, list);
}

// GET /api/workers/pools → Pool[] (api/shapes/pool.js).
export const listPools = async (request, env) => Response.json(await pools(env));

// POST /api/workers/pools/:id/scale {count}, min <= count <= max.
export async function scalePool(request, env, { id }) {
  const pool = await poolOf(env, id);
  if (!pool) return error(404, "not_found", "no such pool");
  const count = (await request.json().catch(() => null))?.count;
  if (!Number.isInteger(count) || count < pool.min_count || count > pool.max_count) {
    return error(400, "bad_request", `body must be {count} with ${pool.min_count} <= count <= ${pool.max_count}`);
  }
  await scaleTo(env, pool, count);
  return Response.json(await pools(env, id));
}

// PUT /api/workers/pools/:id/assign {repo, kinds}: the pool's workers claim only these flows, from this repo (null = any).
export async function assignPool(request, env, { id }) {
  const pool = await poolOf(env, id);
  if (!pool) return error(404, "not_found", "no such pool");
  const b = await request.json().catch(() => null);
  if (!validKinds(b?.kinds)) return error(400, "bad_request", `body must be {repo, kinds} with kinds from: ${JOB_KINDS.join(", ")}`);
  const [repo, missing] = await repoId(env, b.repo);
  if (missing) return missing;
  const kinds = JSON.stringify(b.kinds);
  await env.DB.batch([env.DB.prepare("UPDATE worker_pools SET repo_id = ?, kinds = ? WHERE id = ?").bind(repo, kinds, id), tokenKinds(env, id, kinds)]);
  return Response.json(await pools(env, id));
}

// POST /api/workers/pools/:id/drain: its workers finish what they hold and claim nothing new (work.js).
export async function drainPool(request, env, { id }) {
  const { meta } = await env.DB.prepare("UPDATE worker_pools SET draining = 1 WHERE id = ?").bind(id).run();
  if (!meta.changes) return error(404, "not_found", "no such pool");
  return Response.json(await pools(env, id));
}

// POST /api/workers/pools/:id/undrain: its workers claim again, and autoscale (after the request) starts workers for its queue.
export async function undrainPool(request, env, { id }) {
  const { meta } = await env.DB.prepare("UPDATE worker_pools SET draining = 0 WHERE id = ?").bind(id).run();
  if (!meta.changes) return error(404, "not_found", "no such pool");
  return Response.json(await pools(env, id));
}

// PUT /api/workers/pools/:id/size {size}: a managed pool is resized, never deleted. Each size is its own Container binding:
// idle members on the old size stop now, busy ones finish their job (a pool worker retires after one) and autoscale starts
// the new size's members after the request.
export async function resizePool(request, env, { id }) {
  const size = (await request.json().catch(() => null))?.size;
  if (!POOL_SIZES.includes(size)) return error(400, "bad_request", `body must be {size} with size from: ${POOL_SIZES.join(", ")}`);
  return updatePool(env, id, { size });
}

// PUT /api/workers/pools/:id {name?, size?, max?, kinds?, max_concurrent?, keep_warm_s?, placement?, labels?, egress?,
// egress_allow?, repos?} → Pool. Every field is checked before anything is written.
export const putPool = async (request, env, { id }) => updatePool(env, id, await request.json().catch(() => null));

async function updatePool(env, id, b) {
  const pool = await pools(env, id);
  if (!pool) return error(404, "not_found", "no such pool");
  if (!b || typeof b !== "object" || (b.name !== undefined && !label(b.name)) || (b.size !== undefined && !POOL_SIZES.includes(b.size))
    || (b.max !== undefined && !(Number.isInteger(b.max) && b.max >= pool.min && b.max <= 20)) || (b.kinds !== undefined && !validKinds(b.kinds))) {
    return error(400, "bad_request", `body must be {name?, size?, max?, kinds?, ...settings, repos?} with size from: ${POOL_SIZES.join(", ")}, ${pool.min} <= max <= 20, kinds from: ${JOB_KINDS.join(", ")}`);
  }
  const [writes, wrong] = await settingsWrites(env, id, b, Object.keys(SETTINGS));
  if (wrong) return wrong;
  if (b.name !== undefined && (await nameTaken(env, b.name, id))) return error(409, "name_taken", `a pool named ${b.name} already exists`);
  const kinds = b.kinds && JSON.stringify(b.kinds);
  await env.DB.batch([
    env.DB.prepare("UPDATE worker_pools SET name = coalesce(?, name), size = coalesce(?, size), max_count = coalesce(?, max_count), kinds = coalesce(?, kinds) WHERE id = ?")
      .bind(b.name ?? null, b.size ?? null, b.max ?? null, kinds ?? null, id),
    ...(kinds ? [tokenKinds(env, id, kinds)] : []), ...writes,
  ]);
  if (b.size !== undefined && b.size !== pool.size) {
    const { results } = await env.DB.prepare(`SELECT runner_id, coalesce((SELECT size FROM pool_member_sizes WHERE runner_id = m.runner_id), ?2) AS size FROM pool_members m WHERE pool_id = ?1 AND coalesce((SELECT size FROM pool_member_sizes WHERE runner_id = m.runner_id), ?2) <> ?3
      AND NOT EXISTS (SELECT 1 FROM jobs WHERE runner_id = m.runner_id AND status = 'claimed')`).bind(id, pool.size, b.size).all();
    for (const { runner_id: r, size } of results) await halt(env, { size }, r);
  }
  return Response.json(await pools(env, id));
}

const tokenKinds = (env, id, kinds) => env.DB.prepare("UPDATE runner_tokens SET kinds = ? WHERE runner_id IN (SELECT runner_id FROM pool_members WHERE pool_id = ?)").bind(kinds, id);
// lazy: two concurrent writes of one name to the two tables can both pass; a shared names table would close that.
const nameTaken = async (env, name, id) => Boolean(await env.DB.prepare("SELECT 1 FROM worker_pools WHERE name = ?1 AND id <> ?2 UNION ALL SELECT 1 FROM byo_pools WHERE name = ?1 AND id <> ?2")
  .bind(name, id).first());

// The pool_settings columns a PUT or POST may set, and the migration's defaults for a pool without a row.
const SETTINGS = {
  labels: (v) => Array.isArray(v) && v.every(label),
  max_concurrent: (v) => Number.isInteger(v) && v >= 1,
  keep_warm_s: (v) => Number.isInteger(v) && v >= 0,
  placement: (v) => label(v),
  egress: (v) => ["allowlist", "none", "open"].includes(v),
  egress_allow: (v) => Array.isArray(v) && v.every((h) => typeof h === "string" && HOST_PATTERN.test(h)),
};
const DEFAULTS = { labels: "[]", max_concurrent: 8, keep_warm_s: 60, placement: "nearest", egress: "allowlist", egress_allow: "[]" };
const BYO_SETTINGS = Object.keys(SETTINGS).filter((k) => k !== "labels");

// The statements that write body b's settings (`keys`) and repos ("*" = every repo) for pool `id`, or [null, error].
async function settingsWrites(env, id, b, keys) {
  const bad = keys.find((k) => b[k] !== undefined && !SETTINGS[k](b[k]));
  if (bad) return [null, error(400, "bad_request", `${bad}: invalid value; egress is allowlist, none or open, egress_allow holds host patterns of [a-z0-9.-] with * or ?`)];
  const set = keys.filter((k) => b[k] !== undefined);
  const writes = set.length ? [env.DB.prepare(`INSERT INTO pool_settings (pool_id, ${set.join(", ")}) VALUES (?${", ?".repeat(set.length)})
    ON CONFLICT (pool_id) DO UPDATE SET ${set.map((k) => `${k} = excluded.${k}`).join(", ")}`).bind(id, ...set.map((k) => (Array.isArray(b[k]) ? JSON.stringify(b[k]) : b[k])))] : [];
  if (b.repos === undefined) return [writes, null];
  if (b.repos !== "*" && !(Array.isArray(b.repos) && b.repos.length && b.repos.every(label))) return [null, error(400, "bad_request", "repos: expected \"*\" or a non-empty list of repo names")];
  writes.push(env.DB.prepare("DELETE FROM pool_repos WHERE pool_id = ?").bind(id));
  for (const name of b.repos === "*" ? [] : new Set(b.repos)) {
    const [repo, missing] = await repoId(env, name);
    if (missing) return [null, missing];
    writes.push(env.DB.prepare("INSERT INTO pool_repos (pool_id, repo_id) VALUES (?, ?)").bind(id, repo));
  }
  return [writes, null];
}

// Pools with their settings; a BYO pool's own labels win over pool_settings'. lazy: reads every settings row, fine for tens of pools.
async function withSettings(env, list) {
  const [{ results: rows }, { results: repos }] = await env.DB.batch([env.DB.prepare("SELECT * FROM pool_settings"),
    env.DB.prepare("SELECT pr.pool_id, r.name FROM pool_repos pr JOIN repos r ON r.id = pr.repo_id ORDER BY r.name")]);
  return list.map((p) => {
    const s = rows.find((r) => r.pool_id === p.id) ?? DEFAULTS;
    const names = repos.filter((r) => r.pool_id === p.id).map((r) => r.name);
    return { labels: JSON.parse(s.labels), max_concurrent: s.max_concurrent, keep_warm_s: s.keep_warm_s, placement: s.placement, egress: s.egress,
      egress_allow: JSON.parse(s.egress_allow), ...p, repos: names.length ? names : "*" };
  });
}

const label = (v) => typeof v === "string" && v.length > 0;
const place = (v) => v === undefined || v === null || label(v);
const kindsWrite = (env, id, kinds) => env.DB.prepare("INSERT INTO byo_pool_kinds (pool_id, kinds) VALUES (?, ?) ON CONFLICT (pool_id) DO UPDATE SET kinds = excluded.kinds")
  .bind(id, JSON.stringify(kinds));
const byoKinds = (v) => v === undefined || (Array.isArray(v) && v.length > 0 && v.every((k) => BYO_KINDS.includes(k)));

// POST /api/workers/byo-pools {name, labels, cloud?, region?, kinds?, ...settings, repos?} → 201 ByoPool. Runners join with POST /api/workers {pool: name}.
// kinds: the job kinds its workers may register for (runners.js); without it, every BYO kind except flow.
export async function createByoPool(request, env) {
  const b = await request.json().catch(() => null);
  if (!label(b?.name) || !SETTINGS.labels(b.labels) || !place(b.cloud) || !place(b.region) || !byoKinds(b.kinds)) {
    return error(400, "bad_request", `body must be {name, labels, cloud?, region?, kinds?, ...settings, repos?} with non-empty strings and kinds from: ${BYO_KINDS.join(", ")}`);
  }
  const id = crypto.randomUUID();
  const [writes, wrong] = await settingsWrites(env, id, b, BYO_SETTINGS);
  if (wrong) return wrong;
  if (b.kinds) writes.push(kindsWrite(env, id, b.kinds));
  if (await nameTaken(env, b.name, id)) return error(409, "name_taken", `a pool named ${b.name} already exists`);
  const inserted = await env.DB.prepare("INSERT INTO byo_pools (id, name, labels, cloud, region, created_at) VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (name) DO NOTHING")
    .bind(id, b.name, JSON.stringify(b.labels), b.cloud ?? null, b.region ?? null, new Date().toISOString()).run();
  if (!inserted.meta.changes) return error(409, "name_taken", `a pool named ${b.name} already exists`);
  if (writes.length) await env.DB.batch(writes);
  return Response.json((await byoPools(env)).find((p) => p.id === id), { status: 201 });
}

// PUT /api/workers/byo-pools/:id {name?, labels?, cloud?, region?, kinds?, ...settings, repos?} → ByoPool; null clears cloud or region.
// kinds applies to workers registering from then on.
export async function putByoPool(request, env, { id }) {
  const b = await request.json().catch(() => null);
  if (!b || typeof b !== "object" || (b.name !== undefined && !label(b.name)) || (b.labels !== undefined && !SETTINGS.labels(b.labels)) || !place(b.cloud) || !place(b.region) || !byoKinds(b.kinds)) {
    return error(400, "bad_request", `body must be {name?, labels?, cloud?, region?, kinds?, ...settings, repos?} with non-empty strings and kinds from: ${BYO_KINDS.join(", ")}`);
  }
  const pool = await env.DB.prepare("SELECT * FROM byo_pools WHERE id = ?").bind(id).first();
  if (!pool) return error(404, "not_found", `no pool ${id}`);
  const [writes, wrong] = await settingsWrites(env, id, b, BYO_SETTINGS);
  if (wrong) return wrong;
  if (b.kinds) writes.push(kindsWrite(env, id, b.kinds));
  if (b.name !== undefined && (await nameTaken(env, b.name, id))) return error(409, "name_taken", `a pool named ${b.name} already exists`);
  const keep = (k) => (b[k] === undefined ? pool[k] : b[k]);
  await env.DB.batch([env.DB.prepare("UPDATE byo_pools SET name = ?, labels = ?, cloud = ?, region = ? WHERE id = ?")
    .bind(keep("name"), b.labels ? JSON.stringify(b.labels) : pool.labels, keep("cloud"), keep("region"), id), ...writes]);
  return Response.json((await byoPools(env)).find((p) => p.id === id));
}

async function byoPools(env) {
  const { results } = await env.DB.prepare(`SELECT p.*, count(m.runner_id) AS members, coalesce(sum(h.last_heartbeat_at > ?), 0) AS online,
    max(h.last_heartbeat_at) AS last_heartbeat_at FROM byo_pools p LEFT JOIN byo_members m ON m.pool_id = p.id
    LEFT JOIN runner_heartbeats h ON h.runner_id = m.runner_id GROUP BY p.id ORDER BY p.name`).bind(new Date(Date.now() - OFFLINE_MS).toISOString()).all();
  const list = results.map((p) => ({ id: p.id, name: p.name, labels: JSON.parse(p.labels), cloud: p.cloud, region: p.region, members: p.members,
    online: p.online, last_heartbeat_at: p.last_heartbeat_at, created_at: p.created_at }));
  return withSettings(env, list);
}

// GET /api/workers/byo-pools → ByoPool[] (api/shapes/byo-pool.js).
export const listByoPools = async (request, env) => Response.json(await byoPools(env));

// DELETE /api/workers/byo-pools/:id → 204. Its runners keep their tokens and leave the pool.
export async function deleteByoPool(request, env, { id }) {
  const [, { meta }] = await env.DB.batch([env.DB.prepare("DELETE FROM byo_members WHERE pool_id = ?").bind(id), env.DB.prepare("DELETE FROM byo_pools WHERE id = ?").bind(id),
    env.DB.prepare("DELETE FROM pool_settings WHERE pool_id = ?").bind(id), env.DB.prepare("DELETE FROM pool_repos WHERE pool_id = ?").bind(id),
    env.DB.prepare("DELETE FROM byo_pool_kinds WHERE pool_id = ?").bind(id)]);
  if (!meta.changes) return error(404, "not_found", `no pool ${id}`);
  return new Response(null, { status: 204 });
}

// DELETE /api/workers/:id → 204. The token goes first, so the runner can't claim again before its claimed jobs are queued again.
export async function revokeRunner(request, env, { id }) {
  if (!(await env.DB.prepare("SELECT 1 FROM runner_tokens WHERE runner_id = ?").bind(id).first())) return error(404, "not_found", `no runner ${id}`);
  const pool = await poolOfMember(env, id);
  await (pool ? halt(env, pool, id) : forget(env, id));
  await env.DB.prepare("UPDATE jobs SET status = 'queued', runner_id = NULL, lease_expires_at = NULL WHERE runner_id = ? AND status = 'claimed'").bind(id).run();
  return new Response(null, { status: 204 });
}
