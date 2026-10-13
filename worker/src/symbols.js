import { scheduleIndexed } from "./changes.js";
import { error, holdsJob } from "./router.js";

// Owner route: symbols at the head of ?target. 200 when that head is indexed, 202 once its index job is queued.
export async function getSymbols(request, env, { name }) {
  const target = new URL(request.url).searchParams.get("target");
  if (!target) return error(400, "bad_request", "target query parameter is required");
  const repo = await env.DB.prepare("SELECT id, name FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const start = performance.now();
  const index = await env.REPO_DO.get(env.REPO_DO.idFromName(name)).symbols(repo, target);
  const headers = { "Server-Timing": `symbols;dur=${(performance.now() - start).toFixed(1)}` };
  // A branch with no commits (yet: an import may still land) has no index: not a 404 the browser logs as a failure.
  if (!index) return Response.json({ sha: null, symbols: null }, { headers });
  return Response.json(index, { status: index.symbols ? 200 : 202, headers });
}

// Runner route: the index job's result, `cinder-verify symbols` output collected into a list. Changes waiting for
// this index are then leased from it.
export async function putSymbols(request, env, { name, sha }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  if (!(await holdsJob(request, env, repo.id, "index"))) return error(403, "forbidden", `this runner holds no index job of ${name}`);
  const rows = await request.json().catch(() => null);
  if (!Array.isArray(rows)) return error(400, "bad_request", "body: expected a list of symbols");
  const stmts = [];
  for (const [i, s] of rows.entries()) {
    const file = s?.kind === "file";
    const ok = ["path", "kind"].every((k) => typeof s?.[k] === "string" && s[k]) && typeof s.name === "string" && (file || s.name)
      && Number.isInteger(s.line) && s.line >= 1 && Number.isInteger(s.end) && s.end >= s.line
      && ["scope", "sig", "body"].every((k) => s[k] === undefined || typeof s[k] === "string")
      && (s.reads === undefined || (Array.isArray(s.reads) && s.reads.every((r) => typeof r === "string" && r)));
    if (!ok || (s.exported !== undefined && typeof s.exported !== "boolean")) {
      return error(400, "bad_request", `[${i}]: expected {path, name, kind, line, end, scope?, exported?, sig?, body?, reads?} with 1 <= line <= end`);
    }
    stmts.push(env.DB.prepare("INSERT OR REPLACE INTO symbol_hashes VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .bind(repo.id, sha, s.path, s.scope ? `${s.scope}.${s.name}` : s.name, s.kind, s.sig ?? "", s.body ?? "", JSON.stringify(s.reads ?? [])));
    if (file) continue;
    stmts.push(env.DB.prepare("INSERT OR IGNORE INTO symbols VALUES (?, ?, ?, ?, ?, ?, ?)")
      .bind(repo.id, sha, s.path, s.name, s.kind, s.line, s.end));
    // Re-indexing a sha updates export status.
    stmts.push(env.DB.prepare(s.exported
      ? "INSERT OR IGNORE INTO symbol_exports VALUES (?, ?, ?, ?, ?)"
      : "DELETE FROM symbol_exports WHERE repo_id = ? AND sha = ? AND path = ? AND name = ? AND kind = ?",
    ).bind(repo.id, sha, s.path, s.name, s.kind));
  }
  stmts.push(env.DB.prepare("INSERT OR IGNORE INTO symbol_indexes VALUES (?, ?)").bind(repo.id, sha));
  // lazy: one D1 batch per request; chunk here if a repo's symbols outgrow a batch.
  await env.DB.batch(stmts);
  await scheduleIndexed(env, name, sha);
  return new Response(null, { status: 204 });
}
