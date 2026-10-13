import { accessOn, accessPerson, groupsOf, isOwnerEmail } from "./access.js";
import { can } from "./people.js";
import { error, hex } from "./router.js";

const TTL_MS = 60_000;

// Stateless ticket "<expiry ms>.<hmac>", keyed by LIVE_TICKET_KEY (a Secrets Store binding used for nothing else): only
// an owner can mint one, and it lapses in 60 s. null when the binding is missing: then the ticket route answers 204,
// which the client reads as "live updates off" (a 5xx would log a console error on every repo page).
async function key(env) {
  if (!env.LIVE_TICKET_KEY) return null;
  return crypto.subtle.importKey("raw", new TextEncoder().encode(await env.LIVE_TICKET_KEY.get()), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

// The ticket is bound to the repo named in the body {repo}, so it opens no other repo's socket. It signs the name as it
// appears in the socket's path (encoded), which openLive compares without decoding.
export async function createLiveTicket(request, env) {
  const k = await key(env);
  if (!k) return new Response(null, { status: 204 });
  const repo = (await request.json().catch(() => null))?.repo;
  if (typeof repo !== "string" || !repo) return error(400, "bad_request", "repo is required");
  const exp = String(Date.now() + TTL_MS);
  const sig = hex(new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(`${exp}.${encodeURIComponent(repo)}`))));
  return Response.json({ ticket: `${exp}.${sig}`, expires_at: new Date(Number(exp)).toISOString() });
}

async function validTicket(env, ticket, repo) {
  const match = /^(\d+)\.([0-9a-f]{64})$/.exec(ticket ?? "");
  if (!match || Number(match[1]) <= Date.now()) return false;
  const k = await key(env);
  if (!k) return false;
  const sig = new Uint8Array(match[2].match(/../g).map((b) => parseInt(b, 16)));
  return crypto.subtle.verify("HMAC", k, sig, new TextEncoder().encode(`${match[1]}.${repo}`));
}

// A signed-in owner, or a person whose roles may read this repo (people.js), as the router decides for GET routes.
async function accessAllowed(request, env) {
  const email = accessOn(env) && (await accessPerson(request, env));
  if (!email) return false;
  return isOwnerEmail(env, email) || can(env, email, "GET", new URL(request.url).pathname, null, groupsOf(request));
}

// Browsers can't set headers on a WebSocket, so this route skips the router's check (router.js). The browser sends its
// Access cookie with the upgrade; without Access, a ticket for this repo authorises it. Browsers always send Origin on
// an upgrade, so one that isn't ours (or none) is another site riding the cookie and is refused.
export async function openLive(request, env, { name }) {
  if (request.headers.get("Upgrade") !== "websocket") return error(426, "upgrade_required", "expected a websocket upgrade");
  const url = new URL(request.url);
  if (request.headers.get("Origin") !== url.origin) return error(403, "forbidden", "websocket upgrade from another origin");
  const ok = (await accessAllowed(request, env)) || (await validTicket(env, url.searchParams.get("ticket"), name));
  if (!ok) return error(401, "unauthorized", "missing, bad or expired ticket or Access JWT");
  return env.REPO_DO.get(env.REPO_DO.idFromName(name)).fetch(request);
}

// Sends {kind, repo, at, ...data} to every socket open on the repo. kind is "<area>.<verb>", e.g. "pool.scaled".
export function publish(env, repo, kind, data) {
  if (!/^[a-z]+\.[a-z]+$/.test(kind)) throw new Error(`live kind must be <area>.<verb>, got ${JSON.stringify(kind)}`);
  return env.REPO_DO.get(env.REPO_DO.idFromName(repo)).broadcast({ kind, repo, at: new Date().toISOString(), ...data });
}
