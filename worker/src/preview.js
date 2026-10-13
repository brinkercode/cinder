import { personOf } from "./access.js";
import { createArtifacts } from "./artifacts.js";
import { predictSymbols } from "./lease.js";
import { isAllowedTarget } from "./policy.js";
import { judgeRisk } from "./risk.js";
import { error } from "./router.js";
import { resolveAgent } from "./agents.js";

// POST /api/repos/:name/changes/preview {intent, target, request_id}: a dry run of planning for the live intent box.
// Creates no change, fork, lease or job; the judgments it asks for are recorded like every System 1 call.
// request_id is echoed (or minted) so a debounced client can drop stale responses.
export async function previewChange(request, env, { name }) {
  // Per person, not per repo: every preview runs the risk judge, and one person must not spend another's allowance.
  if (!(await env.PREVIEW_LIMIT.limit({ key: personOf(request) })).success) return error(429, "rate_limited", "too many previews; retry in a minute");
  const body = await request.json().catch(() => null);
  const { intent, target } = body ?? {};
  const request_id = typeof body?.request_id === "string" && body.request_id ? body.request_id : crypto.randomUUID();
  if (typeof intent !== "string" || !intent.trim()) return error(400, "bad_request", "intent must be a non-empty string");
  if (target !== undefined && (typeof target !== "string" || !target)) return error(400, "bad_request", "target must be a non-empty string");
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  const policy = await repoDO.policy(name, repo.default_branch);
  const branch = target ?? policy.integration[0];
  if (!isAllowedTarget(policy, branch)) return error(422, "target_not_allowed", `branch policy does not allow target ${branch}`);

  const sha = (await createArtifacts(env.ARTIFACTS).log(name, branch))[0]?.sha ?? null;
  const symbols = await predictSymbols(env, repo.id, sha, intent);
  const predicted = symbols.map((s) => s.symbol);
  // Same overlap rule as RepoDO.grant, against every change holding or waiting on a lease.
  const collisions = Object.entries(await repoDO.leases(branch))
    .map(([change, lease]) => ({ change, symbols: lease.symbols.filter((s) => predicted.includes(s)) }))
    .filter((c) => c.symbols.length);
  const { risk } = await judgeRisk(env, repo.id, {
    files: [...new Set(predicted.map((s) => s.split("#")[0]))].map((path) => ({ path, added: 0, removed: 0 })),
    intent, test_delta: 0, lease_overlaps: collisions.length,
  });
  // @dev@v2, @dev@canary, or @dev (its stable channel); an unknown agent resolves to null.
  const agents = await Promise.all([...intent.matchAll(/(?<![\w@])@([a-z0-9-]+(?:@[a-z0-9]+)?)/g)].map(async ([, ref]) => ({
    ref, agent_version: await resolveAgent(env, ref.includes("@") ? ref : `${ref}@stable`).catch(() => null),
  })));
  const changes = [...intent.matchAll(/(?<![\w#])#([\w-]+)/g)].map(([, id]) => id);
  return Response.json({ request_id, target: branch, symbols, collisions, risk, agents, changes });
}
