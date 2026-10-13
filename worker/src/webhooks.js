// Outbound webhooks: change, verdict and judgment events go through the cinder-webhooks Queue, one message per
// subscribed hook, and are POSTed signed with X-Cinder-Signature: sha256=<hex HMAC-SHA256 of the body>. Each hook's
// secret lives in the account's Secrets Store; D1 holds only its reference and delivery reads it through its binding.
import { cloudflare } from "./deploy.js";
import { addToStore, binding, denied, rebind, SECRETS_STORE } from "./keystore.js";
import { error, hex } from "./router.js";

const KINDS = ["change", "verdict", "judgment"];
const enc = new TextEncoder();
const badEvents = (events) => !Array.isArray(events) || !events.length || !events.every((e) => KINDS.includes(e));
// The URL's path is redacted, as some receivers take their credential there.
const masked = (url) => `${new URL(url).origin}/…`;
const newSecret = () => hex(crypto.getRandomValues(new Uint8Array(32)));

// POST /api/repos/:name/webhooks {url, events} → {id, url, events, secret}. The secret is returned only here and
// stored only in the Secrets Store.
export async function createWebhook(request, env, { name }) {
  const { url, events } = (await request.json().catch(() => null)) ?? {};
  if (URL.parse(url)?.protocol !== "https:") return error(400, "bad_request", "url must be an https URL");
  if (badEvents(events)) {
    return error(400, "bad_request", `events must be a non-empty list of ${KINDS.join(", ")}`);
  }
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const id = crypto.randomUUID();
  const secret = newSecret();
  const ref = await addToStore(env, id, `webhook ${id}`, secret).catch(denied(SECRETS_STORE));
  if (ref instanceof Response) return ref;
  await env.DB.batch([
    env.DB.prepare("INSERT INTO webhooks (id, repo_id, url, events, store_id, store_secret_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(id, repo.id, url, JSON.stringify(events), ref.store_id, ref.store_secret_name, new Date().toISOString()),
    env.DB.prepare("INSERT INTO webhook_secret_ids (hook_id, store_secret_id) VALUES (?, ?)").bind(id, ref.store_secret_id),
  ]);
  await rebind(env);
  return Response.json({ id, url, events, secret }, { status: 201 });
}

const HOOK = `SELECT w.id, w.url, w.events, w.created_at, w.store_id, s.store_secret_id FROM webhooks w
  LEFT JOIN webhook_secret_ids s ON s.hook_id = w.id WHERE w.repo_id = (SELECT id FROM repos WHERE name = ?1)`;
const hookOf = (env, name, id) => env.DB.prepare(`${HOOK} AND w.id = ?2`).bind(name, id).first();
const secretPath = (env, hook) => `/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores/${hook.store_id}/secrets/${hook.store_secret_id}`;

// GET /api/repos/:name/webhooks → Webhook[] (api/shapes/repo-settings.js), oldest first, each with its latest delivery
// attempt. Never a secret: D1 holds none, and the URL is masked.
export async function listWebhooks(request, env, { name }) {
  const { results } = await env.DB.prepare(`SELECT h.id, h.url, h.events, h.created_at, d.at, d.ok, d.status, d.error FROM (${HOOK}) h
    LEFT JOIN webhook_deliveries d ON d.id = (SELECT MAX(id) FROM webhook_deliveries WHERE hook_id = h.id) ORDER BY h.created_at, h.id`).bind(name).all();
  return Response.json(results.map(({ at, ok, status, error: err, ...h }) => ({ ...h, url: masked(h.url), events: JSON.parse(h.events),
    last_delivery: at ? { at, ok: Boolean(ok), status, error: err } : null })));
}

// PATCH /api/repos/:name/webhooks/:id {events} → {id, url (masked), events}.
export async function patchWebhook(request, env, { name, id }) {
  const { events } = (await request.json().catch(() => null)) ?? {};
  if (badEvents(events)) return error(400, "bad_request", `events must be a non-empty list of ${KINDS.join(", ")}`);
  const hook = await hookOf(env, name, id);
  if (!hook) return error(404, "not_found", `no webhook ${id} on ${name}`);
  await env.DB.prepare("UPDATE webhooks SET events = ? WHERE id = ?").bind(JSON.stringify(events), id).run();
  return Response.json({ id, url: masked(hook.url), events });
}

// Removes a hook's value from the Secrets Store → null, or the error Response. A 404 means it is already gone; a hook
// made before webhook_secret_ids has no id to address.
// lazy: such a hook's value stays in the store until removed in the dashboard; look it up by name if any remain.
export async function dropHookSecret(env, hook) {
  if (!hook.store_secret_id) return null;
  return cloudflare(env, secretPath(env, hook), { method: "DELETE" }).then(() => null, (err) => (err.status === 404 ? null : denied(SECRETS_STORE)(err)));
}

// DELETE /api/repos/:name/webhooks/:id → 204: the hook, its Secrets Store secret and binding, and its delivery rows.
export async function deleteWebhook(request, env, { name, id }) {
  const hook = await hookOf(env, name, id);
  if (!hook) return error(404, "not_found", `no webhook ${id} on ${name}`);
  const failed = await dropHookSecret(env, hook);
  if (failed) return failed;
  await env.DB.batch(["DELETE FROM webhook_deliveries WHERE hook_id = ?", "DELETE FROM webhook_secret_ids WHERE hook_id = ?", "DELETE FROM webhooks WHERE id = ?"]
    .map((q) => env.DB.prepare(q).bind(id)));
  await rebind(env);
  return new Response(null, { status: 204 });
}

// POST /api/repos/:name/webhooks/:id/rotate → {secret}, returned only here: a new value replaces the old in the
// Secrets Store at once and the binding is refreshed. 409 for a hook made before its secret id was kept.
export async function rotateWebhook(request, env, { name, id }) {
  const hook = await hookOf(env, name, id);
  if (!hook) return error(404, "not_found", `no webhook ${id} on ${name}`);
  if (!hook.store_secret_id) return error(409, "conflict", "this webhook predates rotation; delete it and add it again");
  const secret = newSecret();
  const put = await cloudflare(env, secretPath(env, hook), { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: secret }) })
    .catch(denied(SECRETS_STORE));
  if (put instanceof Response) return put;
  await rebind(env);
  return Response.json({ secret });
}

// Queues one delivery per hook on repoId subscribed to kind. No hooks, no Queue call.
export async function notify(env, repoId, kind, data) {
  const { results } = await env.DB.prepare("SELECT id FROM webhooks WHERE repo_id = ? AND EXISTS (SELECT 1 FROM json_each(events) WHERE value = ?)")
    .bind(repoId, kind).all();
  if (!results.length) return;
  const at = new Date().toISOString();
  // lazy: sendBatch takes at most 100 messages; chunk if a repo ever has more hooks.
  await env.WEBHOOKS.sendBatch(results.map((h) => ({ body: { hook: h.id, kind, data, at } })));
}

// Consumer for cinder-webhooks. A non-2xx answer or a network error retries the message with backoff, up to
// max_retries in wrangler.jsonc, as does a secret whose binding isn't live yet. A deleted hook drops its messages.
// Every attempt is recorded in webhook_deliveries.
// lazy: keeps every attempt; prune old rows per hook if the table grows large.
export async function deliver(batch, env) {
  const record = (hook, ok, status, err) => env.DB.prepare("INSERT INTO webhook_deliveries (hook_id, at, ok, status, error) VALUES (?, ?, ?, ?, ?)")
    .bind(hook, new Date().toISOString(), ok ? 1 : 0, status, err).run();
  for (const msg of batch.messages) {
    const hook = await env.DB.prepare("SELECT url FROM webhooks WHERE id = ?").bind(msg.body.hook).first();
    if (!hook) {
      msg.ack();
      continue;
    }
    const body = JSON.stringify(msg.body);
    try {
      const secret = await env.SECRETS.read(binding(msg.body.hook));
      if (secret == null) {
        await rebind(env);
        throw new Error("secret binding pending");
      }
      const key = await crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
      const signature = `sha256=${hex(await crypto.subtle.sign("HMAC", key, enc.encode(body)))}`;
      const res = await fetch(hook.url, {
        method: "POST", body, redirect: "manual",
        headers: { "content-type": "application/json", "x-cinder-signature": signature, "x-cinder-delivery": msg.id },
      });
      await record(msg.body.hook, res.ok, res.status, null);
      if (res.ok) {
        msg.ack();
        continue;
      }
      console.warn(`webhook ${msg.body.hook}: HTTP ${res.status}`);
    } catch (err) {
      console.warn(`webhook ${msg.body.hook}: ${err.message}`);
      await record(msg.body.hook, false, null, err.message);
    }
    msg.retry({ delaySeconds: 10 * 2 ** msg.attempts });
  }
}
