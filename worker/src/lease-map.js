import { createArtifacts } from "./artifacts.js";
import { changeKey } from "./changes.js";
import { calibrate, trustOf } from "./calibration.js";
import { collisionQuestion } from "./judgments.js";
import { error } from "./router.js";

const DONE = ["merged", "failed", "closed"];
const DAYS = 7;

// When change's lease lapses: the repo's idle window (.cinder.yml lease.idle_minutes, default 30) after its last event (expireLeases).
export async function leaseExpiry(repoDO, name, branch, change) {
  const minutes = Number((await repoDO.policy(name, branch)).lease?.idle_minutes ?? 30);
  return new Date(Date.parse(change.events.at(-1)?.at ?? change.updated_at) + minutes * 60_000).toISOString();
}

// GET /api/repos/:name/lease-map?target= → LeaseMap for the target branch (default: the repo's default branch): its open changes, the leases they hold
// (with the changes waiting on each symbol), an edge per pair whose leases overlap (RepoDO.collisions) and how many
// of the last DAYS days' merges hit a conflict on the way. Pairs without overlap get an edge from their latest
// collision judgment: p is its P(collision), calibrated that P fitted on its judge's (backend, model) outcomes.
export async function getLeaseMap(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id, default_branch FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const target = new URL(request.url).searchParams.get("target") ?? repo.default_branch;
  // A branch with no commits doesn't exist; the default branch of an empty repo still has its (empty) map.
  if (target !== repo.default_branch && !(await createArtifacts(env.ARTIFACTS).log(name, target)).length) return error(404, "ref_not_found", `unknown ref ${target}`);
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  const { results } = await env.DB.prepare("SELECT c.id, n.number FROM changes c LEFT JOIN change_numbers n ON n.change_id = c.id WHERE c.repo_id = ? AND c.target_branch = ?")
    .bind(repo.id, target).all();
  const keyOf = Object.fromEntries(results.map((r) => [r.id, changeKey(name, r.number)]));
  // lazy: one ChangeDO call per change, like listConflicts; keep counters in D1 past a few hundred changes per target.
  const all = (await Promise.all(results.map(({ id }) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get()))).filter(Boolean);
  const open = all.filter((c) => !DONE.includes(c.state));
  const byId = Object.fromEntries(open.map((c) => [c.id, c]));
  const since = new Date(Date.now() - DAYS * 86_400_000).toISOString();
  const merged = all.filter((c) => c.events.some((e) => e.to_state === "merged" && e.at >= since));
  const leases = await repoDO.leases(target);
  const held = Object.entries(leases).filter(([holder, l]) => l.granted && byId[holder]);
  const expires = Object.fromEntries(await Promise.all(held.map(async ([holder]) => [holder, await leaseExpiry(repoDO, name, target, byId[holder])])));
  const certain = (await repoDO.collisions(target)).filter(([a, b]) => byId[a] && byId[b])
    .map(([a, b]) => ({ a, b, p: 1, judge: { name: "lease", count: 0, trusted: true } }));
  const pair = (a, b) => [a, b].sort().join(" ");
  const linked = new Set(certain.map((e) => pair(e.a, e.b)));
  const { results: rows } = await env.DB.prepare(
    "SELECT j.change_id, j.question, j.answer, j.probability, j.backend, j.model_version, o.correct FROM judgments j " +
    "LEFT JOIN outcomes o ON o.judgment_id = j.id WHERE j.repo_id = ? AND j.kind = 'collision' ORDER BY j.made_at, j.id",
  ).bind(repo.id).all();
  const { min_outcomes } = await trustOf(env.DB, repo.id);
  const series = Map.groupBy(rows.filter((r) => r.correct !== null), (r) => `${r.backend} ${r.model_version}`);
  const fits = new Map([...series].map(([k, v]) => [k, calibrate(v.map((x) => ({ p: x.probability, y: x.correct })), min_outcomes)]));
  const questions = new Map(open.map((c) => [collisionQuestion(c.id), c.id]));
  // lazy: reads every collision judgment of the repo; filter by open change ids past a few thousand judgments.
  const judged = new Map();
  for (const r of rows) {
    const b = questions.get(r.question);
    if (!byId[r.change_id] || !b || linked.has(pair(r.change_id, b))) continue;
    const fit = fits.get(`${r.backend} ${r.model_version}`) ?? calibrate([], min_outcomes);
    const yes = (q) => (r.answer === "yes" ? q : 1 - q);
    judged.set(pair(r.change_id, b), {
      a: r.change_id, b, p: yes(r.probability), calibrated: yes(fit.calibrated(r.probability)),
      judge: { name: r.backend, count: fit.count, trusted: fit.trusted },
    });
  }
  return Response.json({
    conflicts: { merges: merged.length, conflicted: merged.filter((c) => c.events.some((e) => e.to_state === "conflict")).length, days: DAYS },
    changes: open.map((c) => ({ id: c.id, key: keyOf[c.id], state: c.state, intent: c.intent, seam: c.kind === "seam", stacked_on: byId[c.stacked_on] ? c.stacked_on : null })),
    leases: held.flatMap(([holder, l]) => l.symbols.map((symbol) => ({
      symbol, file: symbol.split("#")[0], holder, expires_at: expires[holder], mode: byId[holder].kind === "seam" ? "seam" : l.shared?.includes(symbol) ? "shared" : "exclusive",
      waiting: Object.keys(leases).filter((c) => byId[c] && !leases[c].granted && leases[c].symbols.includes(symbol)),
    }))),
    edges: [...certain, ...judged.values()],
  });
}
