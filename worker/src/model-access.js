// My model access: each person's model credentials, bound to their sign-in
// identity. A key is a Secrets Store secret that an AI Gateway provider config names under the person's alias:
// cinder sends it to Cloudflare once and never reads or holds it. Runners report each agent run's provider check and
// usage, which is where status, last used and the month's usage come from.
import { personOf } from "./access.js";
import { activeAccount } from "./accounts.js";
import { cloudflare } from "./deploy.js";
import { addToStore, binding, denied, rebind } from "./keystore.js";
import { error, hex, runnerOf, sha256 } from "./router.js";

const PROVIDERS = [["cf", "Cloudflare credits"], ["anthropic", "Anthropic"], ["openai", "OpenAI"], ["google", "Google"], ["xai", "xAI"]];
const SOURCES = ["credits", "org", "mine"];
const known = (id) => PROVIDERS.some(([p]) => p === id);
// The gateway's provider slug, which is also the first segment of a model call's path through it.
const SLUGS = { anthropic: "anthropic", openai: "openai", google: "google-ai-studio", xai: "grok" };
const configs = (env) => `/accounts/${env.CF_ACCOUNT_ID}/ai-gateway/gateways/${env.AI_GATEWAY_ID}/provider_configs`;
const stores = (env) => `/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores`;
const json = (method, body) => ({ method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
// A 401 or 403 names the permission the failing call needed.
const deniedFor = (err) => denied(err.message.includes("/secrets_store/") ? "Secrets Store: Edit" : "AI Gateway: Edit")(err);
const gone = (err) => { if (err.status !== 404) throw err; }; // already deleted in the dashboard

// Deletes a saved key's provider config, then its secret (secret_id is "<store>/<secret>").
export async function removeKey(env, { config_id, secret_id }) {
  if (config_id) await cloudflare(env, `${configs(env)}/${config_id}`, { method: "DELETE" }).catch(gone);
  if (secret_id) await cloudflare(env, `${stores(env)}/${secret_id.replace("/", "/secrets/")}`, { method: "DELETE" }).catch(gone);
}

// The gateway sees a new secret a moment after the store accepts it, so a config POST can answer 7001 "Secret ... was
// not found" at first: retried 6 times over ~7.5 s. Any other error, or the last 7001, goes to the caller.
// A save aborted after its config was created leaves that config (7001 "... already exists"): it names the same secret,
// whose value this save just replaced, so it is reused.
async function createConfig(env, body) {
  for (let i = 1; ; i++) {
    try {
      return await cloudflare(env, configs(env), json("POST", body));
    } catch (err) {
      if (err.cloudflare?.code === 7001 && /already exists/.test(err.cloudflare.message)) {
        const { result } = await cloudflare(env, `${configs(env)}?per_page=50`);
        const left = result.find((c) => c.alias === body.alias && c.provider_slug === body.provider_slug);
        if (left) return { result: { id: left.id } };
      }
      if (i === 6 || err.cloudflare?.code !== 7001 || !/Secret .* was not found/.test(err.cloudflare.message)) throw err;
      await new Promise((resolve) => setTimeout(resolve, i * 500));
    }
  }
}

// One alias per person: a hash, so two emails never fold into one alias.
async function aliasOf(person) {
  return `p-${hex((await sha256(person)).slice(0, 8))}`;
}

// The one person who requested the live job runner runnerId holds. Null with no live job, or jobs for two people: the call
// can't be tied to one person. Never read from the call, which the runner controls.
async function requesterOf(env, runnerId) {
  if (!runnerId) return null;
  const { results } = await env.DB.prepare(`SELECT DISTINCT r.person FROM jobs j JOIN job_requesters r ON r.job_id = j.id
    WHERE j.runner_id = ? AND j.status = 'claimed' AND j.lease_expires_at > ?`).bind(runnerId, new Date().toISOString()).all();
  return results.length === 1 ? results[0].person : null;
}

// The cf-aig-byok-alias for a model call from runner runnerId: set when the requester of the job it holds picked their own
// keys and saved one for the provider in its path, as {person, provider, alias}. Otherwise none, and the gateway uses the
// org's default stored key.
export async function byokAlias(env, runnerId, pathname) {
  const provider = Object.keys(SLUGS).find((p) => SLUGS[p] === pathname.split("/")[1]);
  if (!runnerId || !provider) return null;
  const person = await requesterOf(env, runnerId);
  if (!person) return null;
  const mine = await env.DB.prepare(`SELECT 1 FROM model_providers p JOIN model_sources s ON s.person = p.person AND s.source = 'mine'
    WHERE p.person = ? AND p.provider = ? AND p.config_id IS NOT NULL`).bind(person, provider).first();
  return mine ? { person, provider, alias: await aliasOf(person) } : null;
}

// A Claude Code subscription login (`claude setup-token`) is an OAuth token Anthropic accepts only as a bearer with the
// oauth beta, never in x-api-key where a gateway provider key goes. So models.internal sends it itself, and only on a
// claimed job its owner requested, with source mine; never on system-created or others' work.
// → {person, token} (token null while its binding is pending), or null.
export async function loginFor(env, runnerId, pathname) {
  if (pathname.split("/")[1] !== "anthropic") return null;
  const person = await requesterOf(env, runnerId);
  if (!person) return null;
  const id = await env.DB.prepare(`SELECT p.login_id FROM model_providers p JOIN model_sources s ON s.person = p.person AND s.source = 'mine'
    WHERE p.person = ? AND p.provider = 'anthropic' AND p.login_id IS NOT NULL`).bind(person).first("login_id");
  if (!id) return null;
  const token = await env.SECRETS.read(binding(id));
  if (token == null) await rebind(env);
  return { person, token };
}

// A person's key or login status comes from its real use: the gateway's answer to a call made with it (401/403 refused,
// 402 out of credits). Other errors leave it as it was.
export async function keyUsed(env, person, provider, method, res) {
  if (!res.ok && ![401, 402, 403].includes(res.status)) return;
  const name = PROVIDERS.find(([p]) => p === provider)[1];
  await env.DB.prepare("UPDATE model_providers SET status = ?, reason = ?, last_used_at = ? WHERE person = ? AND provider = ? AND source = 'mine'")
    .bind(res.ok ? "connected" : "failing", res.ok ? null : `${name} refused the ${method} (HTTP ${res.status})`, new Date().toISOString(), person, provider).run();
}

// The providers with an org key: gateway provider configs not under a person's alias. Only slugs are read, never a key.
// null when the gateway can't be read (no token or permission), so the page says so instead of claiming none.
async function orgKeys(env) {
  const slugs = new Set();
  try {
    for (let page = 1, pages = 1; page <= pages; page++) {
      const { result, result_info } = await cloudflare(env, `${configs(env)}?per_page=50&page=${page}`);
      for (const c of result) if (!/^p-[0-9a-f]{16}$/.test(c.alias ?? "")) slugs.add(c.provider_slug);
      pages = result_info?.total_pages ?? 1;
    }
  } catch {
    return null;
  }
  return Object.keys(SLUGS).filter((p) => slugs.has(SLUGS[p]));
}

// GET /api/me/models → ModelAccess (api/shapes/model-access.js). Cloudflare credits need no key, so they are always there.
export async function getModelAccess(request, env) {
  const me = personOf(request);
  const [[pick, rows, usage, account], org_keys] = await Promise.all([env.DB.batch([
    env.DB.prepare("SELECT source FROM model_sources WHERE person = ?").bind(me),
    env.DB.prepare("SELECT provider, source, method, status, reason, last_used_at FROM model_providers WHERE person = ?").bind(me),
    env.DB.prepare("SELECT tokens, cost_usd, runs FROM model_usage WHERE person = ? AND month = ?").bind(me, new Date().toISOString().slice(0, 7)),
    env.DB.prepare("SELECT name FROM accounts WHERE id = ?").bind(activeAccount(request)),
  ]), orgKeys(env)]);
  const by = new Map(rows.results.map((r) => [r.provider, r]));
  return Response.json({
    source: pick.results[0]?.source ?? "credits",
    providers: PROVIDERS.map(([id, name]) => {
      const r = by.get(id);
      return { id, name, source: r?.source ?? (id === "cf" ? "credits" : null), method: r?.method ?? null,
        status: r?.status ?? (id === "cf" ? "connected" : "missing"), reason: r?.reason ?? null, last_used_at: r?.last_used_at ?? null };
    }),
    usage: usage.results[0] ?? { tokens: 0, cost_usd: 0, runs: 0 },
    account: account.results[0]?.name ?? null,
    org_keys,
  });
}

// PUT /api/me/models {source} → 204: the credential source the person picked.
export async function putModelSource(request, env) {
  const source = (await request.json().catch(() => null))?.source;
  if (!SOURCES.includes(source)) return error(400, "bad_request", `body must be {source} with source from ${SOURCES.join(", ")}`);
  await env.DB.prepare("INSERT INTO model_sources VALUES (?, ?) ON CONFLICT (person) DO UPDATE SET source = excluded.source").bind(personOf(request), source).run();
  return new Response(null, { status: 204 });
}

// PUT /api/me/models/:provider {method, value} → 204: saves (or replaces) the person's own key or login token.
export async function putModelKey(request, env, { provider }) {
  const b = await request.json().catch(() => null);
  if (!known(provider) || provider === "cf") return error(404, "not_found", `no provider ${provider} takes a key`);
  if (!["key", "login"].includes(b?.method) || typeof b?.value !== "string" || !b.value) return error(400, "bad_request", "body must be {method: key|login, value}");
  if (b.method === "login" && provider !== "anthropic") return error(400, "bad_request", "a subscription login is taken only for anthropic (Claude Code)");
  if (!env.AI_GATEWAY_ID) return error(503, "gateway_unconfigured", "AI_GATEWAY_ID must be set");
  const me = personOf(request);
  const old = await env.DB.prepare("SELECT config_id, secret_id, login_id FROM model_providers WHERE person = ? AND provider = ?").bind(me, provider).first();
  // The new key is stored before the old one is removed, so a failed replace leaves the old key working.
  const saved = await (async () => {
    if (b.method === "login") {
      const id = crypto.randomUUID();
      const ref = await addToStore(env, id, `model login ${provider}`, b.value);
      return ref instanceof Response ? ref : { config_id: null, secret_id: `${ref.store_id}/${ref.store_secret_id}`, login_id: id };
    }
    const { result: [store] } = await cloudflare(env, stores(env));
    if (!store) return error(503, "no_secrets_store", "the account has no Secrets Store store yet; run make up or the release to create it");
    // The gateway finds a provider config's key by this name, so the secret must exist first (else code 7001).
    const alias = await aliasOf(me);
    const name = `${env.AI_GATEWAY_ID}_${SLUGS[provider]}_${alias}`;
    // A save aborted before its row was written leaves this person's secret behind: its value is replaced, not re-created.
    // lazy: one page of 100, the account's cap (keystore.js LIMIT); page through if the cap rises.
    let secret = (await cloudflare(env, `${stores(env)}/${store.id}/secrets?per_page=100`)).result.find((s) => s.name === name);
    const existed = Boolean(secret);
    if (secret) await cloudflare(env, `${stores(env)}/${store.id}/secrets/${secret.id}`, json("PATCH", { value: b.value }));
    else [secret] = (await cloudflare(env, `${stores(env)}/${store.id}/secrets`, json("POST",
      [{ name, value: b.value, scopes: ["ai_gateway"], comment: `cinder model key ${provider} ${alias}` }]))).result;
    const secretId = `${store.id}/${secret.id}`;
    const config = await createConfig(env, { alias, provider_slug: SLUGS[provider], default_config: false })
      // An existing secret may be the old key's: it stays.
      .catch(async (err) => { if (!existed) await removeKey(env, { secret_id: secretId }); throw err; });
    return { config_id: config.result.id, secret_id: secretId, login_id: null };
  })().catch(deniedFor);
  if (saved instanceof Response) return saved;
  // Saving a key picks the person's own keys, or agents they start would never use it.
  await env.DB.batch([env.DB.prepare(`INSERT INTO model_providers (person, provider, source, method, config_id, secret_id, login_id, status) VALUES (?, ?, 'mine', ?, ?, ?, ?, 'unchecked')
    ON CONFLICT (person, provider) DO UPDATE SET source = 'mine', method = excluded.method, config_id = excluded.config_id, secret_id = excluded.secret_id,
      login_id = excluded.login_id, status = 'unchecked', reason = NULL`)
    .bind(me, provider, b.method, saved.config_id, saved.secret_id, saved.login_id),
  env.DB.prepare("INSERT INTO model_sources VALUES (?, 'mine') ON CONFLICT (person) DO UPDATE SET source = 'mine'").bind(me)]);
  // A replaced key under the same alias keeps its secret and config; only what the new key doesn't reuse goes.
  if (old) await removeKey(env, { config_id: old.config_id !== saved.config_id && old.config_id, secret_id: old.secret_id !== saved.secret_id && old.secret_id });
  if (saved.login_id || old?.login_id) await rebind(env);
  return new Response(null, { status: 204 });
}

// DELETE /api/me/models/:provider → 204: removes the person's own key; the provider shows missing again.
export async function deleteModelKey(request, env, { provider }) {
  const row = await env.DB.prepare("SELECT config_id, secret_id, login_id FROM model_providers WHERE person = ? AND provider = ? AND source = 'mine'").bind(personOf(request), provider).first();
  const removed = row && await removeKey(env, row).catch(deniedFor);
  if (removed instanceof Response) return removed;
  await env.DB.prepare("DELETE FROM model_providers WHERE person = ? AND provider = ? AND source = 'mine'").bind(personOf(request), provider).run();
  if (row?.login_id) await rebind(env);
  return new Response(null, { status: 204 });
}

// POST /api/work/model-usage {job?, provider, source, tokens, cost_usd, error?} → 204: one agent run's usage, a failed
// run's with its error and maybe no tokens. It never sets a provider's status: the runner can't tell which key the gateway
// used, so status comes from models.internal (keyUsed), and a provider without a stored key keeps no row.
export async function reportModelUsage(request, env) {
  const b = await request.json().catch(() => null);
  const count = (n) => Number.isFinite(n) && n >= 0;
  if (!known(b?.provider) || !SOURCES.includes(b.source) || !Number.isInteger(b.tokens) || !count(b.tokens) || !count(b.cost_usd) ||
    (b.job != null && typeof b.job !== "string") || (b.error != null && typeof b.error !== "string")) {
    return error(400, "bad_request", "body must be {job?, provider, source, tokens, cost_usd, error?}");
  }
  // The person is the requester of the job this runner holds, never one the runner names; without one it stays the runner's.
  const { runner_id } = await runnerOf(request, env);
  const person = (b.job && await env.DB.prepare("SELECT r.person FROM jobs j JOIN job_requesters r ON r.job_id = j.id WHERE j.id = ? AND j.runner_id = ?")
    .bind(b.job, runner_id).first("person")) || `runner:${runner_id}`;
  if (b.source === "mine" && !(await env.DB.prepare("SELECT 1 FROM model_providers WHERE person = ? AND provider = ? AND source = 'mine'").bind(person, b.provider).first())) {
    return error(409, "no_key", `${person} has no key for ${b.provider}`);
  }
  await env.DB.prepare(`INSERT INTO model_usage VALUES (?, ?, ?, ?, 1)
    ON CONFLICT (person, month) DO UPDATE SET tokens = tokens + excluded.tokens, cost_usd = cost_usd + excluded.cost_usd, runs = runs + 1`)
    .bind(person, new Date().toISOString().slice(0, 7), b.tokens, b.cost_usd).run();
  return new Response(null, { status: 204 });
}
