import { accessNoEmail, accessOn, accessPerson, byOwnerToken, groupsOf, isOwnerEmail, ownerTokenIn, personOf } from "./access.js";
import { activeAccount } from "./accounts.js";
import { hex, sha256 } from "./hex.js";
import { can } from "./people.js";

export { hex, sha256 };

export function error(status, code, message) {
  return Response.json({ error: { code, message } }, { status });
}

// Hashing both sides first gives equal lengths, which timingSafeEqual requires.
async function isOwner(token, ownerToken) {
  if (!ownerToken) return false;
  return crypto.subtle.timingSafeEqual(await sha256(token), await sha256(ownerToken));
}

const bearer = (request) => /^Bearer (\S+)$/.exec(request.headers.get("Authorization") ?? "")?.[1];

// The runner_tokens row ({runner_id, name, kinds}) for the request's bearer token, or null.
export async function runnerOf(request, env) {
  const token = bearer(request);
  if (!token) return null;
  return env.DB.prepare("SELECT runner_id, name, kinds FROM runner_tokens WHERE token_hash = ?").bind(hex(await sha256(token))).first();
}

// A runner route writes a repo's results only while the runner holds a live `kind` job (any kind when null) of that repo.
export async function holdsJob(request, env, repoId, kind = null) {
  const runner = await runnerOf(request, env);
  return Boolean(runner && await env.DB.prepare("SELECT 1 FROM jobs WHERE runner_id = ?1 AND repo_id = ?2 AND (?3 IS NULL OR kind = ?3) AND status = 'claimed' AND lease_expires_at > ?4")
    .bind(runner.runner_id, repoId, kind, new Date().toISOString()).first());
}

// Bearer tokens (runners, CLI, OWNER_TOKEN) first and unchanged; without a known one, Access (when on) identifies a
// person, so a stale owner token left in a browser doesn't hide its valid Access JWT.
async function principal(request, env) {
  const token = bearer(request);
  if (token && (await isOwner(token, env.OWNER_TOKEN))) {
    ownerTokenIn(request, env);
    return "owner";
  }
  if (await runnerOf(request, env)) return "runner";
  const email = accessOn(env) && (await accessPerson(request, env));
  if (!email) return null;
  return isOwnerEmail(env, email) ? "owner" : "person";
}

// routes: { "METHOD /path/:param": handler(request, env, params) }. /api/health is public, /api/work/* is for runners,
// /api/repos/:name/live checks its own ticket (live.js); every other /api/* route is for the owner.
export async function route(request, env, routes, ctx) {
  const { pathname } = new URL(request.url);
  // A BYO worker registers with {pool_token} in the body and no other credential; createRunner checks the token (runners.js).
  // The body is read before auth, so it is size-checked before it is parsed.
  const register = request.method === "POST" && pathname === "/api/runners";
  const body = register ? await request.clone().arrayBuffer() : null;
  if (body?.byteLength > 4096) return error(413, "too_large", "a runner registration body is at most 4 KiB");
  const poolToken = register && typeof (await new Response(body).json().catch(() => null))?.pool_token === "string";
  if (pathname.startsWith("/api/") && pathname !== "/api/health" && !/^\/api\/repos\/[^/]+\/live$/.test(pathname) && !poolToken) {
    const who = await principal(request, env);
    if (!who && accessOn(env) && !bearer(request)) {
      if (accessNoEmail(request)) return error(401, "access_no_email", "this Access identity has no email and its service token is not allowlisted");
      return error(401, "access_denied", "missing or invalid Cloudflare Access JWT");
    }
    if (!who) return error(401, "unauthorized", "missing or unknown bearer token");
    // The browser sends the Access cookie on another site's requests too, so a state change signed in by Access must come
    // from this deployment's own pages; runner and OWNER_TOKEN requests are bearer tokens, not Access.
    const origin = request.headers.get("Origin");
    if (request.method !== "GET" && who !== "runner" && !byOwnerToken(request) && origin && origin !== new URL(request.url).origin) {
      return error(403, "cross_origin", "a signed-in change must come from this deployment's own pages");
    }
    const needed = pathname.startsWith("/api/work/") ? "runner" : "owner";
    // Any signed-in person may ask who they are, for git credentials (pushes.js checks write access) or mark a draft ready
    // (readyChange checks authorship), review a change (reviewChange checks the verdict's capability) or request reviewers (requestReviewer checks author, driver or repo.write), manages their own model access (model-access.js) or lists and switches their own accounts (accounts.js). A runner uploads SARIF for a repo it holds a live job of (sarif.js).
    const sarif = who === "runner" && request.method === "POST" && /^\/api\/repos\/[^/]+\/sarif$/.test(pathname);
    const self = who === "person" && (/^\/api\/me(\/models(\/[^/]+)?|\/accounts(\/[^/]+\/switch)?)?$/.test(pathname) || (request.method === "POST" && /^\/api\/(repos\/[^/]+\/git-credentials|changes\/[^/]+\/(ready|reviewers|review))$/.test(pathname)));
    // A commit checks its own caller (commits.js): owners anywhere, repo.write on the repo, a runner in its change's fork.
    const commits = request.method === "POST" && /^\/api\/repos\/[^/]+\/commits$/.test(pathname);
    // Removing a requested reviewer checks its own caller (reviewers.js): the author, the driver or repo.write.
    const reviewer = who === "person" && request.method === "DELETE" && /^\/api\/changes\/[^/]+\/reviewers\/[^/]+$/.test(pathname);
    // Editing a change's priority or labels checks its own caller (changes.js): the author, the driver or repo.write.
    const edit = who === "person" && request.method === "PATCH" && /^\/api\/changes\/[^/]+$/.test(pathname);
    // Resolving a need checks its own caller (needs.js): an approval item's approvers, org.manage for any other.
    const need = who === "person" && request.method === "POST" && /^\/api\/needs\/[^/]+\/resolve$/.test(pathname);
    // A policy save checks its own caller (putPolicy), so a refusal names the permission it needs.
    const policy = who === "person" && request.method === "PUT" && /^\/api\/repos\/[^/]+\/policy$/.test(pathname);
    // Any other person route needs a capability from the person's roles (people.js).
    const granted = who === "person" && needed === "owner" && !self && !commits && (await can(env, personOf(request), request.method, pathname, activeAccount(request), groupsOf(request)));
    if (who !== needed && !self && !sarif && !commits && !reviewer && !edit && !need && !policy && !granted) return error(403, "forbidden", `this route needs the ${needed} token`);
  }
  for (const [key, handler] of Object.entries(routes)) {
    const [method, path] = key.split(" ");
    const match = method === request.method && new URLPattern({ pathname: path }).exec({ pathname });
    if (!match) continue;
    try {
      return await handler(request, env, match.pathname.groups, ctx);
    } catch (err) {
      // A Cloudflare API refusal (deploy.js cloudflare()) answers 502 with what failed and Cloudflare's reason.
      if (err.cloudflare) return error(502, "cloudflare_error", err.message);
      // A refusal of the repo's .cinder.yml (parsePolicy, parseDeploy or parseYaml), by message because it crosses RepoDO's RPC boundary.
      if (/^(\.cinder\.yml|yaml): /.test(err.message)) return error(422, "invalid_policy", err.message);
      // A runner gets the JSON error shape for any failure, never the platform's exception page.
      if (!pathname.startsWith("/api/work/")) throw err;
      console.error(`${request.method} ${pathname}: ${err.stack ?? err}`);
      return error(500, "internal", "the request failed inside cinder; see the Worker logs");
    }
  }
  return error(404, "not_found", "no such route");
}
