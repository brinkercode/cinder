import { CHANGE_PRIORITIES } from "./api/contract.js";
import { error, runnerOf } from "./router.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
const isSymbol = (s) => typeof s === "string" && s.length > 0;

// POST /api/work/edit-check {job, base_sha, writes: [{symbol, kind}], reads: [symbol]} → {diagnostics: [{severity, file,
// symbol, change, intent, suggestion}]}: one agent edit of the claimed job's change, checked against the changes merged
// or verified since base_sha and against the lease map (RepoDO.arbitrate). Every diagnostic is recorded on its change;
// the answer also delivers the ones other changes' edits raised on this change since its last check.
export async function checkEdit(request, env) {
  const { runner_id } = await runnerOf(request, env);
  const b = await request.json().catch(() => null);
  if (!isSymbol(b?.job) || !/^[0-9a-f]{40}$/.test(b.base_sha ?? "") || !Array.isArray(b.writes) || !Array.isArray(b.reads)
    || !b.writes.every((w) => isSymbol(w?.symbol) && ["signature", "body"].includes(w.kind)) || !b.reads.every(isSymbol)) {
    return error(400, "bad_request", "body must be {job, base_sha, writes: [{symbol, kind: signature|body}], reads: [symbol]}");
  }
  const job = await env.DB.prepare("SELECT change_id FROM jobs WHERE id = ? AND runner_id = ? AND status = 'claimed'").bind(b.job, runner_id).first();
  if (!job?.change_id) return error(403, "forbidden", `job ${b.job} is not a change's job leased to this runner`);
  const change = await changeDO(env, job.change_id).get();
  const target = change.target_branch;
  const written = new Set(b.writes.map((w) => w.symbol));
  // Merged since base: merged after the merge that made base_sha (change_merged_shas rows are inserted in merge order).
  // A base cinder didn't merge counts no merged change: a missed one still surfaces at converge.
  const { results: changed } = await env.DB.prepare(
    "SELECT w.change_id, w.symbol, w.kind, c.state FROM change_writes w JOIN changes c ON c.id = w.change_id " +
    "WHERE c.repo_id = ?1 AND c.target_branch = ?2 AND w.change_id <> ?3 AND w.symbol IN (SELECT value FROM json_each(?4)) AND (c.state = 'in_queue' " +
    "OR (c.state = 'merged' AND (SELECT rowid FROM change_merged_shas WHERE change_id = w.change_id) > (SELECT max(m.rowid) FROM change_merged_shas m " +
    "JOIN changes b ON b.id = m.change_id WHERE b.repo_id = ?1 AND m.merged_sha = ?5)))",
  ).bind(change.repo_id, target, change.id, JSON.stringify([...written, ...b.reads]), b.base_sha).all();
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first("name")));
  const leases = await repoDO.leases(target);
  const holders = Object.keys(leases).filter((c) => c !== change.id && leases[c].granted
    && [...written].some((s) => leases[c].symbols.includes(s) || leases[c].symbols.includes(s.split("#")[0])));
  const ids = [...new Set([...holders, ...changed.map((r) => r.change_id)])];
  const others = new Map(await Promise.all(ids.map(async (id) => [id, await changeDO(env, id).get()])));
  const ranks = Object.fromEntries([change, ...others.values()].filter(Boolean).map((c) => [c.id, CHANGE_PRIORITIES.indexOf(c.priority ?? "P2")]));
  const outcomes = await repoDO.arbitrate(target, change.id, [...written], ranks, holders.filter((h) => others.get(h)?.state === "in_queue"));

  const diagnostics = [];
  const told = [];
  const diag = (severity, symbol, other, suggestion) => ({ severity, file: symbol.split("#")[0], symbol, change: other ?? null, intent: others.get(other)?.intent ?? "", suggestion });
  const add = (...args) => {
    const d = diag(...args);
    if (!diagnostics.some((x) => x.symbol === d.symbol && x.change === d.change)) diagnostics.push(d);
  };
  for (const { change_id: other, symbol, kind, state } of changed) {
    const where = state === "merged" ? `rebase onto ${target}` : `stack on ${other}`;
    if (written.has(symbol)) add("error", symbol, other, `${where}: ${other} already changed ${symbol}`);
    else if (kind === "signature") add("error", symbol, other, `${where} and adapt to the new signature of ${symbol}`);
    else add("warning", symbol, other, `${where} to build on the new body of ${symbol}`);
  }
  for (const { symbol, holder, outcome } of outcomes) {
    if (outcome === "own") add("info", symbol, null, `${symbol} is leased to this change; nothing to do`);
    else if (outcome === "held" && others.get(holder)?.state === "in_queue") add("error", symbol, holder, `stack on ${holder}, which is verified and holds ${symbol}`);
    else if (outcome === "held") add("warning", symbol, holder, `stack on ${holder} or propose a seam: it holds ${symbol} with an older grant or higher priority`);
    else {
      add("info", symbol, holder, `${symbol} is leased to this change now; ${holder} was told`);
      const outranked = ranks[change.id] > (ranks[holder] ?? 1);
      told.push({ ...diag(outranked ? "error" : "warning", symbol, change.id, outranked
        ? `rework without ${symbol}: ${change.id} has higher priority and took it`
        : `stack on ${change.id} or propose a seam: its older grant took ${symbol}`), intent: change.intent, for: holder });
    }
  }
  const { results: pending } = await env.DB.prepare("UPDATE edit_diagnostics SET job_id = ?1 WHERE change_id = ?2 AND job_id IS NULL " +
    "RETURNING severity, file, symbol, other AS change, intent, suggestion").bind(b.job, change.id).all();
  const at = new Date().toISOString();
  const insert = "INSERT INTO edit_diagnostics (change_id, job_id, severity, file, symbol, other, intent, suggestion, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
  const rows = [...diagnostics.map((d) => [change.id, b.job, d]), ...told.map((d) => [d.for, null, d])];
  if (rows.length) {
    await env.DB.batch(rows.map(([id, jobId, d]) => env.DB.prepare(insert).bind(id, jobId, d.severity, d.file, d.symbol, d.change, d.intent, d.suggestion, at)));
  }
  return Response.json({ diagnostics: [...pending, ...diagnostics] });
}
