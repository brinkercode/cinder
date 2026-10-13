// Label routing set in Settings: when a change or intent gets a label, the first rule naming it routes the work.
import { validateLabelRouting } from "./api/contract.js";
import { error } from "./router.js";

const repoIdOf = (env, name) => env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first("id");

// The repo's routes in match order: Settings' rules, then those in .cinder.yml.
export async function routesOf(env, repoId, policyRoutes = []) {
  const rules = await env.DB.prepare("SELECT rules FROM label_routes WHERE repo_id = ?").bind(repoId).first("rules");
  return [...(rules ? JSON.parse(rules) : []), ...policyRoutes];
}

// GET /api/repos/:name/routing → {rules}.
export async function getRouting(request, env, { name }) {
  const id = await repoIdOf(env, name);
  if (!id) return error(404, "not_found", `no repo ${name}`);
  return Response.json({ rules: await routesOf(env, id) });
}

// PUT /api/repos/:name/routing {rules} → {rules}: replaces the repo's rules.
export async function putRouting(request, env, { name }) {
  const id = await repoIdOf(env, name);
  if (!id) return error(404, "not_found", `no repo ${name}`);
  const body = await request.json().catch(() => null);
  const { ok, errors } = validateLabelRouting(body);
  if (!ok) return error(400, "bad_request", errors.join("; "));
  const rules = body.rules.map((r) => Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.trim()])));
  await env.DB.prepare("INSERT INTO label_routes (repo_id, rules) VALUES (?1, ?2) ON CONFLICT (repo_id) DO UPDATE SET rules = ?2")
    .bind(id, JSON.stringify(rules)).run();
  return Response.json({ rules });
}
