import { BRANCH_STRATEGIES, validateBranchPolicy } from "./api/contract.js";
import { createArtifacts } from "./artifacts.js";
import { authorOf } from "./commits.js";
import { commit } from "./git/index.js";
import { error } from "./router.js";
import { syncJudges } from "./judgments.js";
import { parseYaml } from "./yaml.js";

const FIELDS = ["integration", "release", "check"];
const OWNED = ["branches", "check"]; // the top-level .cinder.yml keys a policy save writes (and "rules" when it sends rules)
// An integration branch's merge settings when .cinder.yml has no rule for it: merge queue on, one trusted judge,
// auto-merge up to 10% risk, no paths routed to a person.
export const DEFAULT_RULE = { queue: true, judges: 1, risk: 10, route: [] };

// A rule's errors: {branch in integration, queue: boolean, judges: 1-4, risk: 1-50, route: at most 20 path globs}.
function ruleErrors(rule, integration) {
  const p = `rules.${rule?.branch}`;
  return [
    !integration.includes(rule?.branch) && `${p}: branch must be in integration`,
    typeof rule?.queue !== "boolean" && `${p}.queue: expected a boolean`,
    !(Number.isInteger(rule?.judges) && rule.judges >= 1 && rule.judges <= 4) && `${p}.judges: expected an integer from 1 to 4`,
    !(Number.isInteger(rule?.risk) && rule.risk >= 1 && rule.risk <= 50) && `${p}.risk: expected an integer from 1 to 50`,
    !(Array.isArray(rule?.route) && rule.route.length <= 20 && rule.route.every((g) => typeof g === "string" && g)) && `${p}.route: expected at most 20 path globs`,
  ].filter(Boolean);
}

// The rule for branch from .cinder.yml's `rules.<branch>` map, whose scalars parseYaml leaves as strings, over DEFAULT_RULE.
function ruleOf(branch, own) {
  const rule = { branch, ...DEFAULT_RULE };
  for (const k of Object.keys(DEFAULT_RULE)) {
    const v = own?.[k];
    if (v !== undefined) rule[k] = k === "route" ? [].concat(v ?? []) : ({ true: true, false: false })[v] ?? (/^\d+$/.test(v) ? Number(v) : v);
  }
  return rule;
}

// Branch policy per docs/DESIGN.md §3. `text` is .cinder.yml from the default branch, or null when absent. Each of
// FIELDS comes from the file, else the global default (Settings), else the built-in; `sources` says which.
export function parsePolicy(text, defaultBranch, global = {}) {
  let y = {};
  try {
    if (text != null) y = parseYaml(text);
  } catch (e) {
    throw new Error(`.cinder.yml: ${e.message}`, { cause: e }); // the router answers 422 with it
  }
  const asList = (v) => (v == null ? undefined : [].concat(v));
  const own = { integration: asList(y.branches?.integration), release: asList(y.branches?.release), check: y.check ?? undefined };
  const builtIn = { integration: [defaultBranch], release: [], check: "make check" };
  const policy = {
    ...Object.fromEntries(FIELDS.map((k) => [k, own[k] ?? global[k] ?? builtIn[k]])),
    sources: Object.fromEntries(FIELDS.map((k) => [k, own[k] !== undefined ? "repo" : global[k] !== undefined ? "global" : "default"])),
    ...(y.stages && { stages: y.stages }), // per-repo stage → agent@version|channel overrides
    ...(y.overlap && { overlap: y.overlap }), // "wait" or "stack" (default) for a change overlapping a running one
    ...(y.review?.require_resolved === "true" && { review: { require_resolved: true } }), // unresolved threads block merge
    ...(y.wiki?.context === "true" && { wiki: { context: true } }), // develop claims carry the best-matching wiki pages
    ...(y.lease?.idle_minutes && { lease: { idle_minutes: Number(y.lease.idle_minutes) } }), // a parked change's lease expires after this
    ...(y.routes != null && { routes: [].concat(y.routes) }), // [{label, agent|driver|reviewer}]: the first matching label routes a change
    defaulted: text == null,
  };
  // rules: one per integration branch; sources.rules is repo when .cinder.yml has a rules map.
  policy.rules = policy.integration.map((b) => ruleOf(b, y.rules?.[b]));
  policy.sources.rules = y.rules != null ? "repo" : "default";
  const { ok, errors } = validateBranchPolicy(policy);
  if (y.rules != null && (typeof y.rules !== "object" || Array.isArray(y.rules))) errors.push("rules: expected a map of integration branches");
  else {
    for (const [b, r] of Object.entries(y.rules ?? {})) {
      if (!policy.integration.includes(b) || r === null || typeof r !== "object" || Array.isArray(r)) errors.push(`rules.${b}: expected a map for an integration branch`);
    }
  }
  errors.push(...policy.rules.flatMap((r) => ruleErrors(r, policy.integration)));
  (policy.routes ?? []).forEach((r, i) => {
    const targets = ["agent", "driver", "reviewer"].filter((k) => typeof r?.[k] === "string" && r[k]);
    if (typeof r?.label !== "string" || !r.label || targets.length !== 1) errors.push(`routes[${i}]: expected a label and exactly one of agent, driver, reviewer`);
  });
  if (!ok || errors.length) throw new Error(`.cinder.yml: ${errors.join("; ")}`);
  return policy;
}

// The branches a branching strategy produces: trunk [default], gitflow [develop, default], release [default] plus
// release/* branches. custom produces nothing, so the policy stays as it is.
export function policyForStrategy(strategy, defaultBranch) {
  if (strategy === "custom") return {};
  return { integration: strategy === "gitflow" ? [...new Set(["develop", defaultBranch])] : [defaultBranch], release: strategy === "release" ? ["release/*"] : [] };
}

export const glob = (pattern) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replaceAll("*", "[^/]*")}$`);

export function isAllowedTarget(policy, branch) {
  return policy.integration.includes(branch) || policy.release.some((p) => glob(p).test(branch));
}

// The policy parsed from .cinder.yml on defaultBranch, also stored as repos.branch_policy, the copy GET /api/repos serves.
// Called whenever the default branch's head may have moved: RepoDO.policy on a new head, pushes and import completion.
export async function refreshPolicy(env, repo, defaultBranch) {
  const global = (await env.DB.prepare("SELECT policy FROM global_policy").first())?.policy ?? "{}";
  const text = await createArtifacts(env.ARTIFACTS).readFile(repo, defaultBranch, ".cinder.yml");
  const policy = parsePolicy(text, defaultBranch, JSON.parse(global));
  const { integration, release, check } = policy;
  await env.DB.prepare("UPDATE repos SET branch_policy = ? WHERE name = ?").bind(JSON.stringify({ integration, release, check }), repo).run();
  await syncJudges(env, repo, text == null ? null : parseYaml(text).judges);
  return policy;
}

const repoOf = (env, name) => env.DB.prepare("SELECT id, name, default_branch, strategy FROM repos WHERE name = ?").bind(name).first();

// GET /api/repos/:name/policy → BranchPolicy plus `defaulted` (true when no .cinder.yml, false when read from it) and
// `base_sha`, the default branch's head it was read at (null when empty), for a save to send back.
export async function getPolicy(request, env, { name }) {
  const repo = await repoOf(env, name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const start = performance.now();
  const policy = await env.REPO_DO.get(env.REPO_DO.idFromName(name)).policy(name, repo.default_branch);
  return Response.json(policy, { headers: { "Server-Timing": `policy;dur=${(performance.now() - start).toFixed(1)}` } });
}

// GET /api/repos/:name/policy/preview?strategy= → {policy, changes: [{key, from, to}]}: the policy a switch to strategy
// would produce and the keys it changes. Reads only.
export async function previewPolicy(request, env, { name }) {
  const strategy = new URL(request.url).searchParams.get("strategy");
  if (!BRANCH_STRATEGIES.includes(strategy)) return error(400, "bad_request", `strategy: expected one of ${BRANCH_STRATEGIES.join(", ")}`);
  const repo = await repoOf(env, name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const current = await env.REPO_DO.get(env.REPO_DO.idFromName(name)).policy(name, repo.default_branch);
  const produced = policyForStrategy(strategy, repo.default_branch);
  const policy = { ...current, ...produced };
  policy.rules = policy.integration.map((b) => current.rules.find((r) => r.branch === b) ?? { branch: b, ...DEFAULT_RULE });
  const changes = Object.keys(produced).filter((k) => JSON.stringify(current[k]) !== JSON.stringify(produced[k])).map((k) => ({ key: k, from: current[k], to: produced[k] }));
  return Response.json({ policy, changes });
}

// The fields of body among keys, with errors for any that aren't valid BranchPolicy values.
function overrides(body, keys) {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return { errors: ["expected a JSON object"] };
  const own = Object.fromEntries(keys.filter((k) => body[k] !== undefined).map((k) => [k, body[k]]));
  const filler = { integration: ["main"], release: [], check: "make check" };
  const { errors } = validateBranchPolicy({ ...filler, ...own });
  return { own, errors };
}

// GET /api/settings/policy → the global default: the policy fields set in Settings ({} when none).
export async function getGlobalPolicy(request, env) {
  return Response.json(JSON.parse((await env.DB.prepare("SELECT policy AS body FROM global_policy").first("body")) ?? "{}"));
}

// PUT /api/settings/policy {integration?, release?, check?}: replaces the global default; every repo inherits
// the fields sent unless its .cinder.yml sets them.
export async function putGlobalPolicy(request, env) {
  const { own, errors } = overrides(await request.json().catch(() => null), FIELDS);
  if (errors.length) return error(422, "invalid_policy", errors.join("; "));
  await env.DB.prepare("INSERT OR REPLACE INTO global_policy (id, policy) VALUES (1, ?)").bind(JSON.stringify(own)).run();
  return Response.json(own);
}

// PUT /api/repos/:name/policy {integration?, release?, check?, rules?, base_sha?} → 201 {sha}: the repo's
// overrides, the fields left out inherit. rules ([{branch, queue, judges, risk, route}], each branch an integration
// branch) replaces the file's rules, left out they stay; integration branches without one get DEFAULT_RULE. Commits them
// into .cinder.yml onto the default branch's head as the caller, keeping its other keys; 409 when that head moved
// meanwhile or is not base_sha (the head the caller loaded); 200 {sha} of the head, without a commit, when the file would not change. RepoDO.policy re-reads the file once the head moves.
export async function putPolicy(request, env, { name }) {
  // The policy route's own path, as putSettings calls this from …/settings.
  const author = await authorOf(request, env, name, `/api/repos/${name}/policy`);
  if (!author) return error(403, "forbidden", `saving the branch policy of ${name} needs branch.write`);
  const body = await request.json().catch(() => null);
  const { own, errors } = overrides(body, FIELDS);
  if (errors.length) return error(422, "invalid_policy", errors.join("; "));
  const repo = await repoOf(env, name);
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const global = JSON.parse((await env.DB.prepare("SELECT policy AS body FROM global_policy").first("body")) ?? "{}");
  const rules = !Array.isArray(body.rules) ? body.rules : body.rules.map((r) => ({ branch: r?.branch, queue: r?.queue, judges: r?.judges, risk: r?.risk, route: r?.route }));
  if (rules !== undefined) {
    const integration = own.integration ?? global.integration ?? [repo.default_branch];
    const ruleErrs = Array.isArray(rules) ? rules.flatMap((r) => ruleErrors(r, integration)) : ["rules: expected an array"];
    if (Array.isArray(rules) && new Set(rules.map((r) => r.branch)).size !== rules.length) ruleErrs.push("rules: one rule per branch");
    if (ruleErrs.length) return error(422, "invalid_policy", ruleErrs.join("; "));
  }
  const q = JSON.stringify;
  const yaml = [
    ...(own.integration || own.release ? ["branches:"] : []),
    ...(own.integration ? [`  integration: ${q(own.integration)}`] : []),
    ...(own.release ? [`  release: ${q(own.release)}`] : []),
    ...(own.check ? [`check: ${q(own.check)}`] : []),
    ...(rules?.length ? ["rules:"] : []),
    ...(rules ?? []).flatMap((r) => [`  ${r.branch}:`, `    queue: ${r.queue}`, `    judges: ${r.judges}`, `    risk: ${r.risk}`,
      r.route.length ? "    route:" : "    route: []", ...r.route.map((g) => `      - ${q(g)}`)]),
    "",
  ].join("\n");
  // parseYaml is a subset (no commas in flow values, no " #"), so refuse what wouldn't read back the same.
  let same = false;
  let back;
  try {
    back = parsePolicy(yaml, repo.default_branch, global);
    same = Object.keys(own).every((k) => q(back[k]) === q(own[k])) && (rules ?? []).every((r) => q(back.rules.find((b) => b.branch === r.branch)) === q(r));
  } catch { /* unreadable: same stays false */ }
  if (!same) return error(422, "invalid_policy", "policy: values must not contain commas, quotes or \" #\"");
  const artifacts = createArtifacts(env.ARTIFACTS);
  const repoCap = await artifacts.get(name);
  if (!repoCap) return error(404, "not_found", `no repo ${name}`);
  const base = (await artifacts.log(name, repo.default_branch))[0]?.sha ?? null;
  if (body.base_sha !== undefined && body.base_sha !== base) return error(409, "conflict", `${repo.default_branch} moved since this page loaded`);
  const current = base && (await artifacts.readFile(name, base, ".cinder.yml"));
  // Replace only the top-level keys the policy owns; any comment lines before the first key and every other key stay byte for byte.
  const chunks = (current ?? "").split(/^(?=[^\s#][^:\n]*:)/m).filter(Boolean);
  const keyOf = (chunk) => chunk.match(/^([^\s#][^:\n]*):/)?.[1];
  const prelude = chunks[0] && !keyOf(chunks[0]) ? chunks.shift().replace(/[^\n]$/, "$&\n") : "";
  const content = prelude + yaml + chunks.filter((c) => !OWNED.includes(keyOf(c)) && !(rules !== undefined && keyOf(c) === "rules")).join("");
  let res = Response.json({ sha: base });
  if (content !== current) {
    try {
      const { sha } = await commit(repoCap, { branch: repo.default_branch, base, changes: [{ path: ".cinder.yml", content }], message: "cinder: update branch policy", author });
      res = Response.json({ sha }, { status: 201 });
    } catch (e) {
      if (e.code === "conflict") return error(409, "conflict", e.message);
      throw e;
    }
  }
  // A saved policy whose branches no longer match what the stored strategy produces is a hand edit: the strategy becomes custom.
  const produced = policyForStrategy(repo.strategy, repo.default_branch);
  if (Object.keys(produced).some((k) => q(back[k]) !== q(produced[k]))) await env.DB.prepare("UPDATE repos SET strategy = 'custom' WHERE id = ?").bind(repo.id).run();
  return res;
}
