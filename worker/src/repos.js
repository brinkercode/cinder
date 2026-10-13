import { groupsOf, isOwnerEmail, personOf } from "./access.js";
import { activeAccount } from "./accounts.js";
import { AGENTS_REPO } from "./agents.js";
import { BRANCH_STRATEGIES } from "./api/contract.js";
import { createArtifacts } from "./artifacts.js";
import { commit, mirror, remoteHead } from "./git/index.js";
import { cloudflare } from "./deploy.js";
import { addToStore, binding, rebind } from "./keystore.js";
import { can } from "./people.js";
import { policyForStrategy, refreshPolicy } from "./policy.js";
import { error } from "./router.js";
import { dropHookSecret } from "./webhooks.js";
import { WIKI_REPO } from "./wiki.js";
import { parseYaml } from "./yaml.js";

const REPO_NAME = /^[a-z0-9-]{2,63}$/;
// Clef on Workers AI answers every judge kind by default, pinned so calibration series stay stable.
// Every kind delivery asks (lease.js, queue.js, seam.js, split.js, guard.js, risk.js, flakes.js, mirror.js): the per-push and
// planning questions on clef-flash, the ones that weigh a whole change or failure on clef.
const DEFAULT_JUDGES = [["lease", "clef-flash", "clef-flash@2"], ["collision", "clef-flash", "clef-flash@2"], ["seam", "clef-flash", "clef-flash@2"],
  ["split", "clef-flash", "clef-flash@2"], ["guard", "clef-flash", "clef-flash@2"], ["risk", "clef", "clef@2"], ["flake", "clef", "clef@2"], ["resembles_vuln", "clef", "clef@2"]];
const repoJson = (row) => ({ ...row, branch_policy: JSON.parse(row.branch_policy) });

const optStr = (v) => v === undefined || (typeof v === "string" && v !== "");
// https only: the import token rides in the fetch's Authorization header.
const badSource = (source) => typeof source?.url !== "string" || URL.parse(source.url)?.protocol !== "https:" || !optStr(source.branch) || !optStr(source.token);

const keptImport = (env, name) =>
  env.DB.prepare("SELECT id, store_id, store_secret_id FROM keystore_secrets WHERE kind = 'import_credential' AND scope = 'repo' AND repo = ?").bind(name).first();

// The person's import token, kept in Secrets Store as the repo's import_credential so a re-import without one reuses it.
async function keepImportToken(env, name, token, owner) {
  const old = await keptImport(env, name);
  if (old) {
    await cloudflare(env, `/accounts/${env.CF_ACCOUNT_ID}/secrets_store/stores/${old.store_id}/secrets/${old.store_secret_id}`,
      { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ value: token }) });
    return env.DB.prepare("UPDATE keystore_secrets SET rotated_at = ? WHERE id = ?").bind(new Date().toISOString(), old.id).run();
  }
  const id = crypto.randomUUID();
  const ref = await addToStore(env, id, "IMPORT_TOKEN", token);
  if (ref instanceof Response) throw new Error((await ref.json()).error.message);
  await env.DB.prepare("INSERT INTO keystore_secrets (id, name, kind, scope, repo, owner, store_id, store_secret_id, store_secret_name, created_at) VALUES (?, 'IMPORT_TOKEN', 'import_credential', 'repo', ?, ?, ?, ?, ?, ?)")
    .bind(id, name, owner, ref.store_id, ref.store_secret_id, ref.store_secret_name, new Date().toISOString()).run();
  await rebind(env);
}

// Imports source into the Artifacts repo `name`, privately when token is set: {branch} (undefined when the import names
// none), or {res}, the error response. The import form's token is kept for the repo once the import lands.
async function importSource(env, artifacts, name, source, token, owner) {
  try {
    // Artifacts' import is public-only, so a private source is fetched over smart HTTP and pushed with cinder's writer.
    if (token) {
      const created = await artifacts.create(name);
      try {
        // The create token's secret is what precedes "?expires=".
        const head = await mirror(source.url, token, created.remote, created.token.split("?")[0]);
        if (source.token) await keepImportToken(env, name, source.token, owner);
        return { branch: source.branch ?? head };
      } catch (e) {
        // A retry must find no half-written repo under the name.
        await artifacts.delete(name);
        throw e;
      }
    }
    const imported = await artifacts.import(name, { url: source.url, branch: source.branch });
    // The import's defaultBranch can be Artifacts' own (main for a master source), so the source's advertised HEAD wins.
    return { branch: source.branch ?? await remoteHead(source.url).catch(() => undefined) ?? imported.defaultBranch };
  } catch (e) {
    // Artifacts errors may echo the source URL; never let the token out with them.
    const message = token ? String(e.message).replaceAll(token, "***") : e.message;
    const reason = `import of ${source.url} failed: ${message}`;
    return { res: error(502, "import_failed", reason), reason };
  }
}

export async function createRepo(request, env) {
  const body = await request.json().catch(() => null);
  const name = body?.name;
  const source = body?.import;
  if (typeof name !== "string" || !REPO_NAME.test(name)) {
    return error(400, "bad_request", "name must be 2-63 chars of [a-z0-9-]");
  }
  // a name with --c could still be read as a legacy change fork; cinder's own repos are never user-created.
  if (name.includes("--c") || name === AGENTS_REPO || name === WIKI_REPO) {
    return error(400, "bad_request", "name must not contain --c or be a reserved name");
  }
  if (!optStr(body.default_branch) || (body.strategy !== undefined && !BRANCH_STRATEGIES.includes(body.strategy))) {
    return error(400, "bad_request", `default_branch must be a non-empty string and strategy one of ${BRANCH_STRATEGIES.join(", ")}`);
  }
  if (source !== undefined && badSource(source)) return error(400, "bad_request", "import must be {url, branch?, token?}");
  if (body.description !== undefined && !DESCRIPTION(body.description)) return error(400, "bad_request", "description must be at most 280 chars on one line");
  if (await env.DB.prepare("SELECT 1 FROM repos WHERE name = ?").bind(name).first()) {
    return error(409, "conflict", `repo ${name} exists`);
  }
  const account = activeAccount(request);
  if (!(await env.DB.prepare("SELECT 1 FROM accounts WHERE id = ?").bind(account).first())) return error(400, "bad_request", `no account ${account}`);
  const artifacts = createArtifacts(env.ARTIFACTS);
  let branch = source?.branch ?? body.default_branch ?? "main";
  // An Artifacts repo left by an earlier install (no row here) refuses the name: say so instead of failing the request.
  const taken = (e) => (/already exists/i.test(e?.message ?? "") ? error(409, "artifacts_repo_exists",
    `an Artifacts repo named ${name} already exists with no cinder repo for it: delete it in Artifacts, or pick another name`) : Promise.reject(e));
  if (source) {
    const imported = await importSource(env, artifacts, name, source, source.token, personOf(request)).catch(taken);
    if (imported instanceof Response) return imported;
    if (imported.res) return imported.res;
    branch = imported.branch ?? branch;
  }
  let created = null;
  if (!source) {
    created = await artifacts.create(name).catch(taken);
    if (created instanceof Response) return created;
  }
  // trunk's branches are what a repo without .cinder.yml gets, so a trunk repo stays empty for its first push.
  const produced = created && body.strategy !== "trunk" ? policyForStrategy(body.strategy ?? "custom", branch) : {};
  const policy = { integration: [branch], release: [], check: "make check", ...produced };
  const row = { id: crypto.randomUUID(), name, default_branch: branch, strategy: body.strategy ?? "trunk", branch_policy: JSON.stringify(policy), created_at: new Date().toISOString(),
    description: body.description?.trim() ?? "", language: null };
  await env.DB.batch([
    env.DB.prepare("INSERT INTO repos (id, name, default_branch, strategy, branch_policy, created_at) VALUES (?, ?, ?, ?, ?, ?)")
      .bind(row.id, row.name, row.default_branch, row.strategy, row.branch_policy, row.created_at),
    env.DB.prepare("INSERT INTO repo_meta (repo_id, description) VALUES (?, ?)").bind(row.id, row.description),
    env.DB.prepare("INSERT INTO repo_accounts (repo_id, account_id) VALUES (?, ?)").bind(row.id, account),
    ...DEFAULT_JUDGES.map(([kind, backend, model]) =>
      env.DB.prepare("INSERT INTO judge_config (repo_id, kind, backend, model_version) VALUES (?, ?, ?, ?)").bind(row.id, kind, backend, model)),
    ...(created ? [env.DB.prepare("INSERT INTO repo_empty (repo_id) VALUES (?)").bind(row.id)] : []),
    ...(source ? [env.DB.prepare("INSERT INTO repo_imports (repo_id, state) VALUES (?, 'importing')").bind(row.id)] : []),
  ]);
  if (Object.keys(produced).length) {
    // The new repo may still be "being created" for get(), so push with the remote and token create returned.
    const repo = { info: async () => ({ name, remote: created.remote }), createToken: async () => ({ plaintext: created.token }) };
    const q = JSON.stringify;
    const content = `branches:\n  integration: ${q(produced.integration)}\n  release: ${q(produced.release)}\n`;
    try {
      await commit(repo, { branch, base: null, changes: [{ path: ".cinder.yml", content }], message: "cinder: branch policy", author: { name: "cinder", email: "cinder@cinder.invalid" } });
    } catch (e) {
      return error(502, "policy_failed", `${name} was created, but committing its .cinder.yml failed: ${e.message}`);
    }
  }
  return Response.json(repoJson(row), { status: 201 });
}

// POST /api/repos/:name/import {url, branch?, token?} → the repo, importing: replaces an existing repo that has no files
// but .cinder.yml (one an older seed created empty, then committed a policy to, say) with an import of url, keeping that
// policy. Owner only and audited; 409 when any branch holds any other file.
export async function reimportRepo(request, env, { name }) {
  const actor = personOf(request);
  if (actor !== "owner" && !isOwnerEmail(env, actor)) return error(403, "forbidden", "only an owner may re-import a repo");
  const source = await request.json().catch(() => null);
  if (badSource(source)) return error(400, "bad_request", "body must be {url, branch?, token?}");
  const repo = await env.DB.prepare("SELECT * FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const artifacts = createArtifacts(env.ARTIFACTS);
  const ref = await branchWithFiles(env, repo, name, source.branch);
  if (ref) return error(409, "conflict", `${name} has files on ${ref}; only a repo holding at most .cinder.yml is re-imported`);
  const stored = !source.token && await keptImport(env, name);
  const token = source.token ?? (stored ? await env.SECRETS.read(binding(stored.id)) : undefined);
  if (stored && !token) {
    await rebind(env);
    return error(503, "binding_pending", `${name}'s import token is being bound to cinder-secrets; retry in a minute`);
  }
  // A retry after a failed import finds no Artifacts repo, so its policy comes from the attempt that stored it.
  const kept = (await artifacts.readFile(name, repo.default_branch, ".cinder.yml"))
    ?? await env.DB.prepare("SELECT yaml FROM repo_import_policies WHERE repo_id = ?").bind(repo.id).first("yaml");
  // Stored before the delete, so a failed import loses no policy.
  if (kept) await env.DB.prepare("INSERT OR REPLACE INTO repo_import_policies (repo_id, yaml) VALUES (?, ?)").bind(repo.id, kept).run();
  if (await artifacts.get(name)) await artifacts.delete(name);
  // Delete completes asynchronously, and import answers "already exists" even after get stops finding the repo.
  // lazy: retries for up to ~10s in the request; a slower delete fails the import and the owner retries.
  let imported = await importSource(env, artifacts, name, source, token, actor);
  for (let i = 0; i < 20 && /already exists/i.test(imported.reason); i++) {
    await new Promise((r) => setTimeout(r, 500));
    imported = await importSource(env, artifacts, name, source, token, actor);
  }
  if (imported.res) {
    // The old repo is gone, so the repo lists as failed with the reason until a re-import lands.
    await env.DB.prepare("INSERT OR REPLACE INTO repo_imports (repo_id, state, reason) VALUES (?, 'failed', ?)").bind(repo.id, imported.reason).run();
    return imported.res;
  }
  // The new repo's heads are not the deleted one's (code.js resolve).
  await env.REPO_DO.get(env.REPO_DO.idFromName(name)).dropHeads();
  const branch = imported.branch ?? repo.default_branch;
  await env.DB.batch([
    env.DB.prepare("UPDATE repos SET default_branch = ? WHERE id = ?").bind(branch, repo.id),
    env.DB.prepare("INSERT OR REPLACE INTO repo_imports (repo_id, state) VALUES (?, 'importing')").bind(repo.id),
    env.DB.prepare("INSERT INTO repo_audit (repo_id, action, actor, detail, at) VALUES (?, 'reimport', ?, ?, ?)")
      .bind(repo.id, actor, JSON.stringify({ url: source.url, branch }), new Date().toISOString()),
  ]);
  return Response.json(repoJson({ ...repo, default_branch: branch }));
}

// The first branch holding anything but .cinder.yml, or null. Checks the default branch, `also`, and every branch a
// refs job has seen too: a re-import's delete must never take commits with it.
export async function branchWithFiles(env, repo, name, also = repo.default_branch) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  const { results: refs } = await env.DB.prepare("SELECT name FROM repo_refs WHERE repo_id = ?").bind(repo.id).all();
  for (const ref of new Set([repo.default_branch, also, ...refs.map((r) => r.name)])) {
    if ((await artifacts.readTree(name, ref, ""))?.some((e) => e.path !== ".cinder.yml" || e.type !== "blob")) return ref;
  }
  return null;
}

// null once the repo's import has finished (its default branch has commits), else the error response for the caller.
// lazy: polls the log once per caller request, so the caller's retries are the backoff; poll from a DO alarm if callers stop retrying.
export async function importBlocked(env, repo, name) {
  const row = await env.DB.prepare("SELECT state, reason FROM repo_imports WHERE repo_id = ?").bind(repo.id).first();
  if (!row) return null;
  if (row.state === "failed") return error(502, "import_failed", row.reason);
  let commits;
  try {
    commits = await createArtifacts(env.ARTIFACTS).log(name, repo.default_branch);
  } catch (e) {
    // Only a public import is still running here: a private one landed before the repo was recorded.
    const reason = `import of ${name} failed: ${e.message}`;
    await env.DB.prepare("UPDATE repo_imports SET state = 'failed', reason = ? WHERE repo_id = ?").bind(reason, repo.id).run();
    return error(502, "import_failed", reason);
  }
  if (!commits.length) return error(409, "repo_importing", `${name} is still importing; retry shortly`);
  const kept = await env.DB.prepare("SELECT yaml FROM repo_import_policies WHERE repo_id = ?").bind(repo.id).first("yaml");
  if (kept) await reapplyPolicy(env, name, repo.default_branch, commits[0].sha, kept);
  const language = await detectLanguage(env, name, repo.default_branch);
  await env.DB.batch([
    // A language set in settings while the import ran wins.
    env.DB.prepare("INSERT INTO repo_meta (repo_id, language) VALUES (?1, ?2) ON CONFLICT (repo_id) DO UPDATE SET language = COALESCE(language, ?2)").bind(repo.id, language),
    env.DB.prepare("DELETE FROM repo_imports WHERE repo_id = ?").bind(repo.id),
    env.DB.prepare("DELETE FROM repo_import_policies WHERE repo_id = ?").bind(repo.id),
  ]);
  // The import landed its own .cinder.yml; a bad one leaves the stored policy as it was rather than failing every list.
  await refreshPolicy(env, name, repo.default_branch).catch((e) => console.error(`import: refreshing ${name} policy failed: ${e.message}`));
  return null;
}

const LANGUAGES = {
  js: "JavaScript", jsx: "JavaScript", mjs: "JavaScript", cjs: "JavaScript", ts: "TypeScript", tsx: "TypeScript", go: "Go", py: "Python", rs: "Rust",
  rb: "Ruby", java: "Java", kt: "Kotlin", swift: "Swift", c: "C", h: "C", cc: "C++", cpp: "C++", hpp: "C++", cs: "C#", php: "PHP", sh: "Shell",
  css: "CSS", scss: "CSS", html: "HTML", vue: "Vue", svelte: "Svelte", ex: "Elixir", exs: "Elixir", scala: "Scala", zig: "Zig", lua: "Lua", tf: "HCL",
};

// The language with the most files on ref by extension, or null when no file has a known one.
// lazy: walks at most 200 directories, one readTree each; sample the tree if imports of bigger repos slow down.
async function detectLanguage(env, name, ref) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  const counts = {}, dirs = [""];
  for (let i = 0; i < dirs.length && i < 200; i++) {
    for (const e of (await artifacts.readTree(name, ref, dirs[i])) ?? []) {
      if (e.type === "tree") dirs.push(e.path);
      const language = e.type === "blob" && LANGUAGES[/\.([^.]+)$/.exec(e.name)?.[1].toLowerCase()];
      if (language) counts[language] = (counts[language] ?? 0) + 1;
    }
  }
  return Object.entries(counts).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

// .cinder.yml text by top-level section; a comment or blank line rides with the section above it.
function sections(text) {
  const out = new Map();
  let key = "";
  for (const line of text.split("\n")) {
    if (/^[^\s#-]/.test(line)) key = line.split(":")[0];
    out.set(key, [...(out.get(key) ?? []), line]);
  }
  return out;
}

// Commits the kept policy's sections over the imported .cinder.yml's onto branch at head, unless they already agree.
async function reapplyPolicy(env, name, branch, head, kept) {
  const artifacts = createArtifacts(env.ARTIFACTS);
  const imported = await artifacts.readFile(name, branch, ".cinder.yml");
  const merged = `${[...new Map([...sections(imported ?? ""), ...sections(kept)]).values()].flat().join("\n").trimEnd()}\n`;
  if (imported !== null && JSON.stringify(parseYaml(merged)) === JSON.stringify(parseYaml(imported))) return;
  try {
    await commit(await artifacts.get(name), { branch, base: head, changes: [{ path: ".cinder.yml", content: merged }],
      message: "cinder: re-apply branch policy", author: { name: "cinder", email: "cinder@cinder.invalid" } });
  } catch (e) {
    // A concurrent caller applied it first: the head moved.
    if (e.code !== "conflict") throw e;
  }
}

const EMPTY = "EXISTS (SELECT 1 FROM repo_empty WHERE repo_id = repos.id) AS empty";

// The first commit to land clears the flag, whether it came from a push or cinder's own writer.
// lazy: logs every still-empty repo on each read; keep a last-checked time if many repos sit empty.
async function stillEmpty(env, row) {
  if (!row.empty) return false;
  try {
    if (!(await createArtifacts(env.ARTIFACTS).log(row.name, row.default_branch)).length) return true;
  } catch {
    // The binding may reject a log of a branch with no commit yet: the repo stays empty.
    return true;
  }
  await env.DB.prepare("DELETE FROM repo_empty WHERE repo_id = ?").bind(row.id).run();
  return false;
}

// Each repo carries status importing, failed or ready. Archived repos are left out.
// lazy: polls the log of every still-importing repo on each list; move to a DO alarm if many imports run at once.
// With a cinder_account cookie (POST /api/me/accounts/:id/switch), only that account's repos are listed.
// A signed-in person who isn't an owner sees only the repos they can read (repo.read, people.js).
// lazy: one role query per repo; filter in the list query past a few hundred repos.
export async function listRepos(request, env) {
  const account = /(?:^|;\s*)cinder_account=/.test(request.headers.get("Cookie") ?? "") ? activeAccount(request) : null;
  const person = personOf(request);
  const { results: all } = await env.DB.prepare(
    "SELECT *, (SELECT 1 FROM repo_imports WHERE repo_id = repos.id) AS pending, " +
    "COALESCE((SELECT description FROM repo_meta WHERE repo_id = repos.id), '') AS description, (SELECT language FROM repo_meta WHERE repo_id = repos.id) AS language, " +
    EMPTY + " FROM repos WHERE NOT EXISTS (SELECT 1 FROM repo_meta m WHERE m.repo_id = repos.id AND m.archived_at IS NOT NULL) " +
    "AND (?1 IS NULL OR EXISTS (SELECT 1 FROM repo_accounts WHERE repo_id = repos.id AND account_id = ?1)) ORDER BY name",
  ).bind(account).all();
  const owner = person === "owner" || isOwnerEmail(env, person);
  const readable = owner || await Promise.all(all.map((r) => can(env, person, "GET", `/api/repos/${encodeURIComponent(r.name)}`, null, groupsOf(request))));
  const results = owner ? all : all.filter((r, i) => readable[i]);
  return Response.json(await Promise.all(results.map(async ({ pending, ...row }) => {
    const blocked = pending && await importBlocked(env, row, row.name);
    // An import that just finished refreshed the stored policy after the select above.
    if (pending && !blocked) row.branch_policy = await env.DB.prepare("SELECT branch_policy FROM repos WHERE id = ?").bind(row.id).first("branch_policy");
    return { ...repoJson(row), empty: await stillEmpty(env, row), status: !blocked ? "ready" : blocked.status === 409 ? "importing" : "failed" };
  })));
}

export const DESCRIPTION = (v) => typeof v === "string" && /^[^\r\n]{0,280}$/.test(v.trim());

// POST /api/repos/:name/archive → 204: the repo leaves GET /api/repos and refuses pushes; DELETE restores it. Owners and
// maintainers (repo.archive, people.js); each change of state is audited, a repeat is a no-op.
export async function archiveRepo(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id, (SELECT archived_at FROM repo_meta WHERE repo_id = repos.id) AS archived_at FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const archive = request.method === "POST";
  if (Boolean(repo.archived_at) === archive) return new Response(null, { status: 204 });
  const at = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare("INSERT INTO repo_meta (repo_id, archived_at) VALUES (?1, ?2) ON CONFLICT (repo_id) DO UPDATE SET archived_at = ?2").bind(repo.id, archive ? at : null),
    env.DB.prepare("INSERT INTO repo_archive_audit (repo_id, action, actor, at) VALUES (?, ?, ?, ?)").bind(repo.id, archive ? "archive" : "unarchive", personOf(request), at),
  ]);
  return new Response(null, { status: 204 });
}

// Statements deleting every D1 row keyed to the repo (?1 its id, ?2 its name), dependants first. The roots are the
// rows of tables with a repo_id or repo column (repo holds the id in some tables, the name in others) and those of the
// repo's changes and jobs; each root's dependants are found through the schema's foreign keys, so a new table needs no
// edit here. Keystore secrets' Secrets Store values are removed by deleteRepo before these run.
async function repoRows(env) {
  const [{ results: cols }, { results: fks }] = await env.DB.batch([
    env.DB.prepare(`SELECT m.name AS tbl, c.name AS col FROM sqlite_master m, pragma_table_info(m.name) c WHERE m.type = 'table'
      AND m.name != 'repos' AND substr(m.name, 1, 7) != 'sqlite_' AND substr(m.name, 1, 4) != '_cf_' AND c.name IN ('repo_id', 'repo', 'change_id', 'job_id')`),
    env.DB.prepare(`SELECT m.name AS child, f.id, f."from" AS col, f."table" AS parent, f."to" AS pcol FROM sqlite_master m, pragma_foreign_key_list(m.name) f
      WHERE m.type = 'table' AND substr(m.name, 1, 7) != 'sqlite_' AND substr(m.name, 1, 4) != '_cf_' ORDER BY f.seq`),
  ]);
  const keys = new Map();
  for (const f of fks) {
    const key = `${f.child} ${f.id}`;
    keys.set(key, { ...f, cols: [...(keys.get(key)?.cols ?? []), f.col], pcols: [...(keys.get(key)?.pcols ?? []), f.pcol] });
  }
  const sql = new Set();
  const drop = (table, where) => {
    // A self-reference (a wiki page's parent) goes with the one statement that deletes its table's rows.
    for (const fk of keys.values()) {
      if (fk.parent === table && fk.child !== table) drop(fk.child, `(${fk.cols.join(", ")}) IN (SELECT ${fk.pcols.join(", ")} FROM ${table} WHERE ${where})`);
    }
    sql.add(`DELETE FROM ${table} WHERE ${where}`);
  };
  const owned = { change_id: "change_id IN (SELECT id FROM changes WHERE repo_id = ?1)", job_id: "job_id IN (SELECT id FROM jobs WHERE repo_id = ?1)" };
  for (const c of cols) if (owned[c.col]) drop(c.tbl, owned[c.col]);
  for (const c of cols) if (!owned[c.col]) drop(c.tbl, c.col === "repo" ? "repo IN (?1, ?2)" : "repo_id = ?1");
  drop("repos", "id = ?1");
  return [...sql];
}

// DELETE /api/repos/:name {confirm} → 204: owners only, archived or not; confirm must equal the name. Removes the
// webhooks' and the repo's Keystore secrets' Secrets Store values, the Artifacts repo, then in one batch every D1 row
// keyed to the repo, and records the deletion in repo_deletions, which outlives it. A retry after a failure part-way finds less to delete.
export async function deleteRepo(request, env, { name }) {
  const actor = personOf(request);
  if (actor !== "owner" && !isOwnerEmail(env, actor)) return error(403, "forbidden", "only an owner may delete a repo");
  if ((await request.json().catch(() => null))?.confirm !== name) return error(400, "bad_request", "confirm must equal the repo name");
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const { results: hooks } = await env.DB.prepare("SELECT w.id, w.store_id, s.store_secret_id FROM webhooks w LEFT JOIN webhook_secret_ids s ON s.hook_id = w.id WHERE w.repo_id = ?")
    .bind(repo.id).all();
  const { results: secrets } = await env.DB.prepare("SELECT store_id, store_secret_id FROM keystore_secrets WHERE repo = ?").bind(name).all();
  for (const hook of [...hooks, ...secrets]) {
    const failed = await dropHookSecret(env, hook);
    if (failed) return failed;
  }
  const artifacts = createArtifacts(env.ARTIFACTS);
  if (await artifacts.get(name)) await artifacts.delete(name);
  // A repo made again under this name must not see this one's heads (code.js resolve).
  await env.REPO_DO.get(env.REPO_DO.idFromName(name)).dropHeads();
  await env.DB.batch([...(await repoRows(env)).map((q) => env.DB.prepare(q).bind(...(q.includes("?2") ? [repo.id, name] : [repo.id]))),
    env.DB.prepare("INSERT INTO repo_deletions (name, actor, at) VALUES (?, ?, ?)").bind(name, actor, new Date().toISOString())]);
  if (hooks.length || secrets.length) await rebind(env);
  return new Response(null, { status: 204 });
}

export async function getRepo(request, env, { name }) {
  const row = await env.DB.prepare(`SELECT *, ${EMPTY} FROM repos WHERE name = ?`).bind(name).first();
  return row ? Response.json({ ...repoJson(row), empty: await stillEmpty(env, row) }) : error(404, "not_found", `no repo ${name}`);
}
