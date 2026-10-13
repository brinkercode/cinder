import { error } from "./router.js";

// People sign in with Cloudflare Access: the edge adds a signed Cf-Access-Jwt-Assertion to every browser request.
const people = new WeakMap();
// The request's Access groups {idp, names} (the JWT's idp and groups claims), per request only: a group change applies
// from the next request. idp is the identity provider's id (Cloudflare's {id, type}) or name, "" when the JWT has none.
const groups = new WeakMap();
// Isolate-wide cache, "<team domain> <kid>" → CryptoKey.
const keys = new Map();
// Isolate-wide, team domain → the last certs fetch {at: ms, done}: forged kids cost at most one fetch a minute, and
// requests arriving while it runs wait for it instead of failing (a page's parallel first requests).
const fetches = new Map();

const b64url = (s) => Uint8Array.from(atob(s.replaceAll("-", "+").replaceAll("_", "/")), (c) => c.charCodeAt(0));
const json = (s) => JSON.parse(new TextDecoder().decode(b64url(s)));

// Requests whose valid Access JWT has no email and no allowlisted service token (router.js answers access_no_email).
const noEmail = new WeakSet();
export const accessNoEmail = (request) => noEmail.has(request);

export const accessOn = (env) => Boolean(env.ACCESS_TEAM_DOMAIN && env.ACCESS_AUD);

// OWNER_TOKEN requests → the owner they act as: the first of OWNERS, "owner" while OWNERS is empty.
const owners = new WeakMap();
export const ownerTokenIn = (request, env) => owners.set(request, (env.OWNERS ?? "").split(",")[0].trim().toLowerCase() || "owner");
export const byOwnerToken = (request) => owners.has(request);

// The request's signed-in person: an Access email or the OWNER_TOKEN's owner; null for anyone else (fails closed).
export const personOf = (request) => people.get(request) ?? owners.get(request) ?? null;
export const groupsOf = (request) => groups.get(request) ?? { idp: "", names: [] };

// A new Request(url, init) that acts as `from`'s caller, for a handler that calls another handler.
export function asCaller(from, url, init) {
  const request = new Request(url, init);
  for (const map of [people, groups, owners]) if (map.has(from)) map.set(request, map.get(from));
  return request;
}

export const isOwnerEmail = (env, email) => (env.OWNERS ?? "").split(",").some((o) => o.trim().toLowerCase() === email);

// An unknown kid refetches the certs at most once per 60s; inside that window it waits on that fetch, then fails fast.
async function accessKey(env, kid) {
  const domain = env.ACCESS_TEAM_DOMAIN;
  if (!keys.has(`${domain} ${kid}`) && !(Date.now() - fetches.get(domain)?.at < 60_000)) {
    const done = (async () => {
      const res = await fetch(`https://${domain}/cdn-cgi/access/certs`);
      if (!res.ok) throw new Error(`access certs: HTTP ${res.status}`);
      for (const jwk of (await res.json()).keys) {
        keys.set(`${domain} ${jwk.kid}`, await crypto.subtle.importKey("jwk", jwk, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]));
      }
    })();
    // Only the request that fetched sees a failure; the ones waiting on it fall through to the missing key.
    fetches.set(domain, { at: Date.now(), done: done.catch(() => {}) });
    await done;
  }
  await fetches.get(domain)?.done;
  return keys.get(`${domain} ${kid}`);
}

const denied = (reason) => {
  console.warn(`access: ${reason}`);
  return null;
};

// Verifies the request's Access JWT (header, else the CF_Authorization cookie) and records its person (created in D1
// on first sign-in). The email, or null when the JWT is missing or invalid; a present but invalid JWT logs why.
export async function accessPerson(request, env) {
  const token = request.headers.get("Cf-Access-Jwt-Assertion") ?? /(?:^|;\s*)CF_Authorization=([^;]+)/.exec(request.headers.get("Cookie") ?? "")?.[1] ?? "";
  if (!token) return null;
  const [head, body, sig] = token.split(".");
  let header, claims, signature;
  try {
    [header, claims, signature] = [json(head), json(body), b64url(sig)];
  } catch {
    return denied("malformed JWT");
  }
  if (header?.alg !== "RS256" || !claims) return denied("bad alg or no claims");
  if (claims.iss !== `https://${env.ACCESS_TEAM_DOMAIN}`) return denied(`wrong issuer ${claims.iss}`);
  if (![claims.aud].flat().includes(env.ACCESS_AUD)) return denied("wrong aud");
  // 60s leeway for clock skew between the edge that signed and this isolate.
  if (!((claims.exp + 60) * 1000 > Date.now())) return denied("expired");
  let key;
  try {
    key = await accessKey(env, header.kid);
  } catch (err) {
    return denied(err.message);
  }
  if (!key) return denied(`unknown kid ${header.kid}`);
  if (!(await crypto.subtle.verify("RSASSA-PKCS1-v1_5", key, signature, new TextEncoder().encode(`${head}.${body}`)))) return denied("bad signature");
  // Only a verified JWT reaches the allowlist: a service token (no email) allowlisted in D1 as client id → name is <name>@service-token.
  const name = typeof claims.email !== "string" && typeof claims.common_name === "string" &&
    (await env.DB.prepare("SELECT name FROM service_tokens WHERE client_id = ?").bind(claims.common_name).first("name"));
  const email = ((typeof claims.email === "string" && claims.email) || (name && `${name}@service-token`))?.toLowerCase();
  if (!email) {
    noEmail.add(request);
    return denied(`no email, service token ${claims.common_name} not allowlisted`);
  }
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO people (email, created_at) VALUES (?, ?) ON CONFLICT DO NOTHING").bind(email, now),
    env.DB.prepare("INSERT INTO people_seen VALUES (?, ?) ON CONFLICT (email) DO UPDATE SET at = excluded.at").bind(email, now),
  ]);
  people.set(request, email);
  // IdPs send group names as strings; Access identities as {id, name}.
  // The id, not the type: two IdPs of one type (two SAML orgs) must not share group names.
  const idp = typeof claims.idp === "string" ? claims.idp : claims.idp?.id;
  groups.set(request, {
    idp: typeof idp === "string" ? idp : "",
    names: [claims.groups ?? []].flat().map((g) => (typeof g === "string" ? g : g?.name)).filter((g) => typeof g === "string"),
  });
  return email;
}

// GET /api/me. email is null for the OWNER_TOKEN, the only bearer token that reaches this route. nonprod: the admin
// seed routes are open (CINDER_ENV=nonprod).
export function getMe(request, env) {
  const email = people.get(request) ?? null;
  return Response.json({ email, owner: email === null || isOwnerEmail(env, email), nonprod: env.CINDER_ENV === "nonprod" });
}

// GET /api/service-tokens → [{client_id, name}]: the service tokens allowed to act as <name>@service-token.
export async function listServiceTokens(request, env) {
  return Response.json((await env.DB.prepare("SELECT client_id, name FROM service_tokens ORDER BY name").all()).results);
}

// PUT /api/service-tokens/:client_id {name}: allows the token; a person-safe name, since it becomes <name>@service-token.
export async function putServiceToken(request, env, { client_id }) {
  const { name } = (await request.json().catch(() => null)) ?? {};
  if (typeof name !== "string" || !/^[\w.-]{1,64}$/.test(name)) return error(400, "bad_request", "body must be {name: letters, digits, . _ -}");
  const id = decodeURIComponent(client_id);
  await env.DB.prepare("INSERT INTO service_tokens VALUES (?, ?) ON CONFLICT (client_id) DO UPDATE SET name = excluded.name").bind(id, name).run();
  return Response.json({ client_id: id, name });
}

// DELETE /api/service-tokens/:client_id: the token is refused from its next request.
export async function deleteServiceToken(request, env, { client_id }) {
  await env.DB.prepare("DELETE FROM service_tokens WHERE client_id = ?").bind(decodeURIComponent(client_id)).run();
  return new Response(null, { status: 204 });
}
