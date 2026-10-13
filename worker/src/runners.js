import { personOf } from "./access.js";
import { JOB_KINDS } from "./api/contract.js";
import { error, hex, sha256 } from "./router.js";

// The kinds a bring-your-own worker may take: never merge, release or history, whose jobs get write tokens to target and cinder-agents.
export const BYO_KINDS = JOB_KINDS.filter((k) => !["merge", "release", "history"].includes(k));
// A pool without its own kinds list never takes flow: a flow job reads its environment's secrets (keystore.js readJobSecret).
const poolKinds = (kinds) => (kinds ? JSON.parse(kinds) : BYO_KINDS.filter((k) => k !== "flow"));
const outside = (kinds, pool) => !kinds.every((k) => poolKinds(pool.kinds).includes(k)) && error(403, "kind_not_allowed", `this pool's workers may take: ${poolKinds(pool.kinds).join(", ")}`);

export async function createRunner(request, env) {
  const body = await request.json().catch(() => null);
  const name = body?.name;
  const kinds = body?.kinds;
  if (typeof name !== "string" || !name || !Array.isArray(kinds) || !kinds.length || !kinds.every((k) => JOB_KINDS.includes(k))
    || (body.slots !== undefined && (!Number.isInteger(body.slots) || body.slots < 1 || body.slots > 64))) {
    return error(400, "bad_request", `body must be {name, kinds, pool?, slots? (1-64)} with kinds from: ${JOB_KINDS.join(", ")}`);
  }
  if ((body.pool_token !== undefined || body.pool !== undefined) && !kinds.every((k) => BYO_KINDS.includes(k))) {
    return error(400, "bad_request", `a pool worker's kinds must be from: ${BYO_KINDS.join(", ")}`);
  }
  // pool_token: a minted pool token (mintPoolToken), the only way in without an owner token (router.js); it names the pool.
  if (body.pool_token !== undefined) {
    const row = await poolTokenRow(env, body.pool_token);
    const refused = row && outside(kinds, row);
    if (refused) return refused;
    // One token registers one worker: the conditional update lets only the first of two concurrent callers through.
    const claimed = row && (await env.DB.prepare("UPDATE byo_pool_tokens SET used_at = ? WHERE id = ? AND used_at IS NULL").bind(new Date().toISOString(), row.id).run()).meta.changes;
    if (!claimed) return error(401, "bad_pool_token", "unknown, used or expired pool token");
    const runner = await registerRunner(env, name, kinds);
    await env.DB.batch([env.DB.prepare("INSERT INTO byo_members (runner_id, pool_id) VALUES (?, ?)").bind(runner.id, row.pool_id),
      env.DB.prepare("INSERT INTO byo_member_tokens (runner_id, pool_token_id) VALUES (?, ?)").bind(runner.id, row.id)]);
    return Response.json(runner, { status: 201 });
  }
  // pool: the name of a bring-your-own pool (byo_pools) this runner joins.
  const pool = body.pool === undefined ? null : await env.DB.prepare("SELECT p.id, k.kinds FROM byo_pools p LEFT JOIN byo_pool_kinds k ON k.pool_id = p.id WHERE p.name = ?").bind(String(body.pool)).first();
  if (body.pool !== undefined && !pool) return error(404, "not_found", `no pool named ${body.pool}`);
  const refused = pool && outside(kinds, pool);
  if (refused) return refused;
  const runner = await registerRunner(env, name, kinds);
  if (pool) await env.DB.prepare("INSERT INTO byo_members (runner_id, pool_id) VALUES (?, ?)").bind(runner.id, pool.id).run();
  if (body.slots) await env.DB.prepare("INSERT INTO runner_slots (runner_id, slots) VALUES (?, ?)").bind(runner.id, body.slots).run();
  return Response.json(runner, { status: 201 });
}

// The unused, unexpired byo_pool_tokens row whose hash matches token, compared in constant time, or null.
// lazy: scans every live token of every pool; fine while tokens are minted by hand, index by hash prefix past ~1k live.
async function poolTokenRow(env, token) {
  if (typeof token !== "string") return null;
  const enc = new TextEncoder();
  const hash = enc.encode(hex(await sha256(token)));
  const { results } = await env.DB.prepare("SELECT t.id, t.pool_id, t.token_hash, k.kinds FROM byo_pool_tokens t JOIN byo_pools p ON p.id = t.pool_id LEFT JOIN byo_pool_kinds k ON k.pool_id = p.id WHERE t.used_at IS NULL AND t.expires_at > ?")
    .bind(new Date().toISOString()).all();
  return results.find((r) => crypto.subtle.timingSafeEqual(enc.encode(r.token_hash), hash)) ?? null;
}

// POST /api/workers/byo-pools/:id/tokens → 201 {token, expires_at}. The token is shown once and good for 24 h; only its hash is kept.
export async function mintPoolToken(request, env, { id }) {
  if (!(await env.DB.prepare("SELECT 1 FROM byo_pools WHERE id = ?").bind(id).first())) return error(404, "not_found", `no pool ${id}`);
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  const now = new Date();
  const expires_at = new Date(now.getTime() + 24 * 60 * 60 * 1000).toISOString();
  await env.DB.prepare("INSERT INTO byo_pool_tokens (id, pool_id, token_hash, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)")
    .bind(crypto.randomUUID(), id, hex(await sha256(token)), personOf(request), now.toISOString(), expires_at).run();
  return Response.json({ token, expires_at }, { status: 201 });
}

// A token's prefix is the first 8 characters of its stored hash: it names the token for revoking without revealing it.
// GET /api/workers/byo-pools/:id/tokens → PoolToken[] (api/shapes/pool-token.js), unrevoked tokens, newest first.
export async function listPoolTokens(request, env, { id }) {
  const { results } = await env.DB.prepare("SELECT substr(token_hash, 1, 8) AS prefix, created_by, created_at, used_at, expires_at FROM byo_pool_tokens WHERE pool_id = ? ORDER BY created_at DESC").bind(id).all();
  return Response.json(results);
}

// DELETE /api/workers/byo-pools/:id/tokens/:prefix → 204. The token is deleted, so it answers 401 bad_pool_token from then on,
// and the workers it registered are refused at their next claim once their running jobs finish (work.js claimWork).
export async function revokePoolToken(request, env, { id, prefix }) {
  const { meta } = await env.DB.prepare("DELETE FROM byo_pool_tokens WHERE pool_id = ? AND substr(token_hash, 1, 8) = ?").bind(id, prefix).run();
  return meta.changes ? new Response(null, { status: 204 }) : error(404, "not_found", `no token ${prefix} in pool ${id}`);
}

// A worker's id and its token; only the token's hash is stored. also(id) gives statements written in the same batch.
export async function registerRunner(env, name, kinds, also = () => []) {
  const id = crypto.randomUUID();
  const token = hex(crypto.getRandomValues(new Uint8Array(32)));
  await env.DB.batch([env.DB.prepare("INSERT INTO runner_tokens (runner_id, name, kinds, token_hash, created_at) VALUES (?, ?, ?, ?, ?)")
    .bind(id, name, JSON.stringify(kinds), hex(await sha256(token)), new Date().toISOString()), ...also(id)]);
  return { id, token };
}

export const OFFLINE_MS = 2 * 60 * 1000;

// GET /api/workers → Runner[] (contract.js). Never selects token_hash.
export async function listRunners(request, env) {
  const { results: runners } = await env.DB.prepare(`SELECT t.runner_id, name, kinds, slots, last_heartbeat_at, created_at, pool_id
    FROM runner_tokens t LEFT JOIN runner_heartbeats h ON h.runner_id = t.runner_id LEFT JOIN pool_members m ON m.runner_id = t.runner_id ORDER BY name`).all();
  const { results: jobs } = await env.DB.prepare("SELECT id, kind, change_id, lease_expires_at, runner_id FROM jobs WHERE status = 'claimed'").all();
  const now = Date.now();
  // Stored rows can hold kinds since retired from the contract ("policy"); a worker left with none can claim nothing.
  const known = (k) => JOB_KINDS.includes(k);
  return Response.json(runners.map((r) => ({
    id: r.runner_id, name: r.name, kinds: JSON.parse(r.kinds).filter(known), slots: r.slots, last_heartbeat_at: r.last_heartbeat_at,
    online: r.last_heartbeat_at !== null && now - Date.parse(r.last_heartbeat_at) < OFFLINE_MS, created_at: r.created_at, pool: r.pool_id,
    claims: jobs.filter((j) => j.runner_id === r.runner_id && known(j.kind)).map((j) => ({ job: j.id, kind: j.kind, change_id: j.change_id, lease_expires_at: j.lease_expires_at })),
  })).filter((r) => r.kinds.length));
}
