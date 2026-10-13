import { validateDependency } from "./api/contract.js";
import { error } from "./router.js";

const FILTERS = {
  vulnerable: (d) => d.status === "vulnerable",
  outdated: (d, outdated) => outdated,
  direct: (d) => d.direct,
};

// GET /api/repos/:name/dependencies?target=&filter=vulnerable|outdated|direct: the inventory of the target's latest done
// scan (default branch by default). A dep is vulnerable while one of its vulns is an open finding: dismissed ones don't count.
export async function getDependencies(request, env, { name }) {
  const params = new URL(request.url).searchParams;
  const filter = params.get("filter");
  if (filter !== null && !Object.hasOwn(FILTERS, filter)) return error(400, "bad_request", `filter must be one of ${Object.keys(FILTERS).join(", ")}`);
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const target = params.get("target") || repo.default_branch;
  const scan = await env.DB.prepare("SELECT d.deps FROM scans s JOIN scan_deps d ON d.job_id = s.job_id " +
    "WHERE s.repo_id = ? AND s.target = ? AND s.status = 'done' ORDER BY s.finished_at DESC LIMIT 1").bind(repo.id, target).first();
  const { results } = await env.DB.prepare("SELECT fingerprint FROM findings WHERE repo_id = ? AND target = ? AND source = 'dependency' AND state = 'open'")
    .bind(repo.id, target).all();
  const open = new Set(results.map((r) => r.fingerprint));
  const auto = new Set((await env.DB.prepare("SELECT ecosystem || '|' || name AS k FROM dep_auto_fix WHERE repo_id = ?").bind(repo.id).all()).results.map((r) => r.k));
  const deps = [];
  for (const d of JSON.parse(scan?.deps ?? "[]")) {
    const outdated = Boolean(d.latest) && d.latest !== d.version;
    const vulnerable = d.vulns.some((v) => open.has(`${d.ecosystem}|${d.name}|${v.id}`));
    const dep = {
      ecosystem: d.ecosystem, name: d.name, version: d.version, direct: d.direct, license: d.license,
      vulns: d.vulns.map(({ id, severity, fixed_in, also_fixes }) => ({ id, severity, fixed_in, also_fixes })),
      status: vulnerable ? "vulnerable" : outdated ? "outdated" : d.osv === "unchecked" ? "unchecked" : "current",
      auto_fix: auto.has(`${d.ecosystem}|${d.name}`),
    };
    if (!filter || FILTERS[filter](dep, outdated)) deps.push(dep);
  }
  const errors = deps.flatMap((d) => validateDependency(d).errors);
  if (errors.length) return error(500, "contract", errors.join("; "));
  return Response.json(deps);
}

// PATCH /api/repos/:name/dependencies {ecosystem, name, auto_fix}: turns auto-fix on or off for one package. A body, not
// the path, names the package: npm scopes carry a slash.
export async function patchDependency(request, env, { name }) {
  const body = await request.json().catch(() => null);
  const { ecosystem, name: pkg, auto_fix: on } = body ?? {};
  if (![ecosystem, pkg].every((s) => typeof s === "string" && s) || typeof on !== "boolean") {
    return error(400, "bad_request", "expected {ecosystem, name, auto_fix: boolean}");
  }
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  await env.DB.prepare(on ? "INSERT OR IGNORE INTO dep_auto_fix (repo_id, ecosystem, name) VALUES (?, ?, ?)"
    : "DELETE FROM dep_auto_fix WHERE repo_id = ? AND ecosystem = ? AND name = ?").bind(repo.id, ecosystem, pkg).run();
  return new Response(null, { status: 204 });
}
