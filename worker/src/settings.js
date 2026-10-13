import { asCaller, groupsOf, isOwnerEmail, personOf } from "./access.js";
import { BRANCH_STRATEGIES } from "./api/contract.js";
import { trustErrors } from "./api/shapes/judges.js";
import { createArtifacts } from "./artifacts.js";
import { commit } from "./git/index.js";
import { can } from "./people.js";
import { policyForStrategy, putPolicy } from "./policy.js";
import { branchWithFiles, DESCRIPTION } from "./repos.js";
import { error } from "./router.js";

// GET /api/repos/:name/settings → RepoSettings (api/shapes/repo-settings.js). can_reimport uses re-import's own check.
export async function getSettings(request, env, { name }) {
  const row = await env.DB.prepare(`SELECT r.id, r.default_branch, r.strategy, r.created_at, COALESCE(m.description, '') AS description, m.language,
    COALESCE(s.flake_quarantine, 0.2) AS flake_quarantine, mi.mirror_url,
    EXISTS (SELECT 1 FROM scan_pauses WHERE repo_id = r.id) AS scans_paused, NOT EXISTS (SELECT 1 FROM quarantine_off WHERE repo = r.id) AS auto_quarantine
    FROM repos r LEFT JOIN repo_meta m ON m.repo_id = r.id
    LEFT JOIN repo_settings s ON s.repo = r.id LEFT JOIN repo_mirrors mi ON mi.repo_id = r.id WHERE r.name = ?`).bind(name).first();
  if (!row) return error(404, "not_found", `no repo ${name}`);
  const { id, scans_paused: paused, auto_quarantine: auto, ...settings } = row;
  return Response.json({ ...settings, scans_paused: Boolean(paused), auto_quarantine: Boolean(auto), can_reimport: !(await branchWithFiles(env, { id, default_branch: row.default_branch }, name)) });
}

// PUT /api/repos/:name/settings {trust?: {min_outcomes, min_races}, flake_quarantine?, auto_quarantine?, mirror_url?, description?,
// language?: string or null, scans_paused?, default_branch?, strategy?, apply?}: sets the keys sent, leaves the rest. With
// apply: true the branches the strategy produces are first committed to .cinder.yml through putPolicy. The router
// lets repo.write through; default_branch, strategy and apply need branch.write. A new default_branch must exist; the change is audited, and when that branch has
// no .cinder.yml the old default's is committed onto it first, so the policy carries over (409 if the branch moved).
export async function putSettings(request, env, { name }) {
  const body = await request.json().catch(() => null);
  if (body === null || typeof body !== "object") return error(400, "bad_request", "expected a JSON object");
  const { trust, flake_quarantine: flake, mirror_url: mirror, description, language, scans_paused: paused, default_branch: branch, strategy, apply, auto_quarantine: auto } = body;
  const errors = trust === undefined ? [] : trustErrors(trust);
  if (flake !== undefined && !(typeof flake === "number" && flake >= 0 && flake <= 1)) errors.push("flake_quarantine: expected a number from 0 to 1");
  if (mirror !== undefined && URL.parse(mirror)?.protocol !== "https:") errors.push("mirror_url: expected an https URL");
  if (description !== undefined && !DESCRIPTION(description)) errors.push("description: expected at most 280 chars on one line");
  if (language !== undefined && !(language === null || (typeof language === "string" && /^[^\r\n]{1,40}$/.test(language.trim())))) errors.push("language: expected null or 1-40 chars");
  if (paused !== undefined && typeof paused !== "boolean") errors.push("scans_paused: expected a boolean");
  if (auto !== undefined && typeof auto !== "boolean") errors.push("auto_quarantine: expected a boolean");
  if (branch !== undefined && !(typeof branch === "string" && branch)) errors.push("default_branch: expected a branch name");
  if (strategy !== undefined && !BRANCH_STRATEGIES.includes(strategy)) errors.push(`strategy: expected one of ${BRANCH_STRATEGIES.join(", ")}`);
  if (apply !== undefined && (typeof apply !== "boolean" || (apply && (strategy === undefined || branch !== undefined)))) errors.push("apply: expected a boolean, true only with a strategy and no default_branch");
  if (errors.length) return error(400, "bad_request", errors.join("; "));
  // The default branch is where .cinder.yml (protection, judges) is read from, so moving it needs what a policy save needs.
  const person = personOf(request);
  if ((branch !== undefined || strategy !== undefined || apply !== undefined) && person !== "owner" && !isOwnerEmail(env, person) &&
    !(await can(env, person, "PUT", `/api/repos/${name}/policy`, null, groupsOf(request)))) return error(403, "forbidden", "default_branch, strategy and apply need branch.write");
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const produced = apply ? policyForStrategy(strategy, repo.default_branch) : {};
  if (Object.keys(produced).length) {
    const current = await env.REPO_DO.get(env.REPO_DO.idFromName(name)).policy(name, repo.default_branch);
    // putPolicy rewrites every key it owns, so the repo's own check and rules go along; rules for branches the
    // strategy drops don't, as .cinder.yml may only hold rules for integration branches.
    const keep = { ...(current.sources.check === "repo" && { check: current.check }),
      ...(current.sources.rules === "repo" && { rules: current.rules.filter((r) => produced.integration.includes(r.branch)) }) };
    const res = await putPolicy(asCaller(request, request.url, { method: "PUT", headers: request.headers, body: JSON.stringify({ ...keep, ...produced, base_sha: current.base_sha }) }), env, { name });
    if (!res.ok) return res;
  }
  const writes = [];
  if (branch !== undefined && branch !== repo.default_branch) {
    const artifacts = createArtifacts(env.ARTIFACTS);
    const head = (await artifacts.log(name, branch))[0]?.sha;
    if (!head) return error(400, "bad_request", `default_branch: no branch ${branch}`);
    const policy = await artifacts.readFile(name, repo.default_branch, ".cinder.yml");
    if (policy !== null && (await artifacts.readFile(name, branch, ".cinder.yml")) === null) {
      try {
        await commit(await artifacts.get(name), { branch, base: head, changes: [{ path: ".cinder.yml", content: policy }],
          message: "cinder: carry branch policy to the new default branch", author: { name: "cinder", email: "cinder@cinder.invalid" } });
      } catch (e) {
        if (e.code === "conflict") return error(409, "conflict", `${branch} moved; retry`);
        throw e;
      }
    }
    writes.push(env.DB.prepare("UPDATE repos SET default_branch = ? WHERE id = ?").bind(branch, repo.id),
      env.DB.prepare("INSERT INTO repo_audit (repo_id, action, actor, detail, at) VALUES (?, 'default_branch', ?, ?, ?)")
        .bind(repo.id, personOf(request), JSON.stringify({ from: repo.default_branch, to: branch }), new Date().toISOString()));
  }
  if (strategy !== undefined) writes.push(env.DB.prepare("UPDATE repos SET strategy = ? WHERE id = ?").bind(strategy, repo.id));
  if (trust !== undefined) writes.push(env.DB.prepare("INSERT OR REPLACE INTO repo_trust (repo, min_outcomes, min_races) VALUES (?, ?, ?)").bind(repo.id, trust.min_outcomes, trust.min_races));
  if (flake !== undefined) writes.push(env.DB.prepare("INSERT OR REPLACE INTO repo_settings (repo, flake_quarantine) VALUES (?, ?)").bind(repo.id, flake));
  if (mirror !== undefined) writes.push(env.DB.prepare("INSERT OR REPLACE INTO repo_mirrors (repo_id, mirror_url) VALUES (?, ?)").bind(repo.id, mirror));
  if (description !== undefined) writes.push(env.DB.prepare("INSERT INTO repo_meta (repo_id, description) VALUES (?1, ?2) ON CONFLICT (repo_id) DO UPDATE SET description = ?2").bind(repo.id, description.trim()));
  if (language !== undefined) writes.push(env.DB.prepare("INSERT INTO repo_meta (repo_id, language) VALUES (?1, ?2) ON CONFLICT (repo_id) DO UPDATE SET language = ?2").bind(repo.id, language?.trim() ?? null));
  if (paused !== undefined) writes.push(env.DB.prepare(paused ? "INSERT OR IGNORE INTO scan_pauses (repo_id) VALUES (?)" : "DELETE FROM scan_pauses WHERE repo_id = ?").bind(repo.id));
  if (auto !== undefined) writes.push(env.DB.prepare(auto ? "DELETE FROM quarantine_off WHERE repo = ?" : "INSERT OR IGNORE INTO quarantine_off (repo) VALUES (?)").bind(repo.id));
  if (writes.length) await env.DB.batch(writes);
  return new Response(null, { status: 204 });
}
