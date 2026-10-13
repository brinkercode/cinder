import { personOf } from "./access.js";
import { judge } from "./judgments.js";
import { publish } from "./live.js";
import { error } from "./router.js";
import { schedule } from "./scheduler.js";
import { SEAM_QUESTIONS, SEAM_THRESHOLD } from "./seam.js";
import { COLLISION_ACTIONS } from "./api/contract.js";

const DAYS = 7;
const EDITING_MS = 10 * 60_000;
const SEVERITY = { signature: "high", body: "low" };
const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
const repoName = (env, id) => env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(id).first("name");
const tell = async (env, id, text) => {
  const stub = changeDO(env, id);
  if (await stub.get()) await stub.addMessage({ text, by: "cinder", at: new Date().toISOString() });
};

// A push that wrote these symbols ([{ symbol, kind }]) makes the change "editing now" on them for EDITING_MS.
// lazy: rows are replaced per (symbol, change) and never pruned; delete the lapsed ones past a few thousand.
export async function recordEditing(env, repoId, changeId, writes) {
  const at = new Date().toISOString();
  await env.DB.batch(writes.map((w) => env.DB.prepare("INSERT OR REPLACE INTO symbol_editing (repo_id, symbol, change_id, kind, at) VALUES (?, ?, ?, ?, ?)")
    .bind(repoId, w.symbol, changeId, w.kind, at)));
  await publish(env, await repoName(env, repoId), "collision.editing", { change: changeId });
}

// The change just entered conflict on a lease collision: one diagnostic row per colliding symbol, sent to the change's
// agent, and a notice to each holder's agent. cinder then settles an agent's change itself: a seam when the seam judge
// trusts the overlap is a shared interface, else stacked behind the holder in lease order, which is also the default
// while the judge isn't trusted. A person's change waits in conflict for its person, since stacking it would hand its
// development to an agent: the seam judge is still asked (and scored by scoreSeam), and its advice is noted per
// collision (advise). Returns the change as it stands after, or null when it had no open collision.
export async function recordCollisions(env, change) {
  const conflict = (await changeDO(env, change.id).conflicts()).findLast((c) => c.status === "open" && c.collisions);
  if (!conflict) return null;
  const holder = conflict.collisions[0].holder;
  const held = await changeDO(env, holder).get();
  const symbols = [...new Set(conflict.collisions.map((c) => c.symbol))];
  const { seam } = await judge(env, change.repo_id, "seam", { intents: [change.intent, held?.intent ?? null], symbols }, SEAM_QUESTIONS, change.id);
  const seamYes = seam.trusted && seam.answer === "yes" && seam.p > SEAM_THRESHOLD;
  const action = change.driver ? null : seamYes ? "seam" : "stack";
  const why = seamYes ? `the seam judge found a shared interface (p ${seam.p.toFixed(2)})`
    : seam.trusted ? "the seam judge found no shared interface" : "the default while the seam judge isn't trusted";
  // [the feed's action, what the change's agent is told, what the holder's is told]
  const [label, ours, theirs] = !action ? ["Stopped; the change moved to conflict", "Stopped until a person resolves the collision.", "It is stopped until a person resolves the collision."]
    : action === "seam" ? [`Seam proposed: ${why}`, "cinder proposed a seam for it.", "cinder proposed a seam for it."]
    : [`Stacked: ${why}`, `cinder stacked your change behind ${holder}.`, "cinder stacked it behind you."];
  const verb = { signature: "changes its signature", body: "edits its body" };
  const rows = conflict.collisions.map((c) => ({ ...c, id: crypto.randomUUID(), message: `${c.holder} leases ${c.symbol} and your change ${verb[c.kind]}. ${ours}` }));
  const lease = change.driver ? (await env.REPO_DO.get(env.REPO_DO.idFromName(await repoName(env, change.repo_id))).leases(change.target_branch))[holder] : null;
  const advice = rows.map((c) => change.driver && advise(seamYes ? why : null, seam.p, held, c, lease)).filter(Boolean);
  await env.DB.batch([...rows.map((c) => env.DB.prepare(
    "INSERT INTO collisions (id, repo_id, conflict_id, ours, theirs, symbol, kind, severity, p, message, action, detected_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)",
  ).bind(c.id, change.repo_id, conflict.id, change.id, c.holder, c.symbol, c.kind, SEVERITY[c.kind], c.message, label, conflict.detected_at)),
  ...advice.map((a) => env.DB.prepare("INSERT INTO collision_notes (collision_id, suggested_action, suggested_why, suggested_p) VALUES (?, ?, ?, ?)")
    .bind(a.id, a.action, a.why, a.p ?? null))]);
  for (const c of rows) {
    await tell(env, change.id, c.message);
    await tell(env, c.holder, `${change.id} ${verb[c.kind]} of ${c.symbol}, which you lease. ${theirs}`);
  }
  await publish(env, await repoName(env, change.repo_id), "collision.opened", { change: change.id });
  if (!action) return change;
  await settle(env, change, action, { type: "system", id: "cinder" }, `${action}: ${why}`);
  return changeDO(env, change.id).get();
}

// What cinder advises the person on collision c with the holder change (lease: the holder's lease), first match wins:
// seamWhy when the seam judge trusts the overlap is a shared interface, else stack behind a holder that is about to
// merge or is a seam, else handover of a body edit on a shared lease; null rather than a guess. Never acted on.
function advise(seamWhy, p, holder, c, lease) {
  if (seamWhy) return { id: c.id, action: "seam", why: `${seamWhy[0].toUpperCase()}${seamWhy.slice(1)}.`, p };
  if (holder?.kind === "seam" || ["in_queue", "verifying"].includes(holder?.state)) {
    return { id: c.id, action: "stack", why: `${c.holder} is ${holder.kind === "seam" ? "a seam change" : holder.state.replace("_", " ")}; stacking waits the least.` };
  }
  if (c.kind === "body" && lease?.shared?.includes(c.symbol)) return { id: c.id, action: "handover", why: `${c.holder} shares the lease; a body edit moves cleanly.` };
  return null;
}

// Takes change out of conflict with action on its open collisions and schedules it again; the diagnostics record the
// resolution. Returns when it was resolved, or null when nothing was open or the change had left conflict.
//   stack: waits behind the holder (or on its fork, per the repo's overlap policy)   seam: a seam is proposed for the symbols
//   handover: the holder gives the symbols up to this change                         reprioritize: this change goes first in line
// lazy: a change colliding with several holders resolves against the first.
async function settle(env, change, action, actor, reason) {
  const id = change.id;
  const { results: open } = await env.DB.prepare("SELECT symbol, theirs FROM collisions WHERE ours = ? AND resolution IS NULL ORDER BY detected_at").bind(id).all();
  if (!open.length) return null;
  const symbols = [...new Set(open.map((r) => r.symbol))];
  const holder = open[0].theirs;
  const next = await changeDO(env, id).transition("planned", {
    kind: "collision_resolved", actor, action: "change.lease", target: id, result: "ok", reason,
  }, action === "reprioritize" ? { priority: "P1" } : {}, "conflict");
  if (!next) return null;
  const name = await repoName(env, change.repo_id);
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(name));
  if (action === "handover") await repoDO.arbitrate(change.target_branch, id, symbols, { [id]: 2 });
  if (action === "seam") await repoDO.proposeSeam(change.target_branch, { changes: [holder, id], symbols, p: 1 });
  const leased = (await repoDO.leases(change.target_branch))[id]?.symbols ?? [];
  await schedule(env, id, [...new Set([...leased, ...symbols])]);
  const at = new Date().toISOString();
  await env.DB.batch([env.DB.prepare("INSERT INTO collision_notes (collision_id, resolved_by_type, resolved_by_id) SELECT id, ?, ? FROM collisions " +
    "WHERE ours = ? AND resolution IS NULL ON CONFLICT (collision_id) DO UPDATE SET resolved_by_type = excluded.resolved_by_type, resolved_by_id = excluded.resolved_by_id")
    .bind(actor.type, actor.id, id),
  env.DB.prepare("UPDATE collisions SET resolution = ?, resolved_at = ? WHERE ours = ? AND resolution IS NULL").bind(action, at, id)]);
  // cinder's own resolution was already in the diagnostics it sent.
  if (actor.type === "human") {
    await tell(env, id, `A person resolved the collision on ${symbols.join(", ")} with ${action}. Carry on.`);
    await tell(env, holder, `The collision with ${id} on ${symbols.join(", ")} was resolved with ${action}.`);
  }
  await publish(env, name, "collision.resolved", { change: id });
  return at;
}

// GET /api/repos/:name/collisions?target= → Collisions: the diagnostics of the last DAYS days, newest first, and who is
// editing now; ?target= keeps those of changes into that branch.
export async function getCollisions(request, env, { name }) {
  const repo = await env.DB.prepare("SELECT id FROM repos WHERE name = ?").bind(name).first();
  if (!repo) return error(404, "not_found", `no repo ${name}`);
  const target = new URL(request.url).searchParams.get("target");
  const { results } = await env.DB.prepare(
    "SELECT c.id, conflict_id, ours, theirs, symbol, c.kind, severity, p, message, action, detected_at, resolution, resolved_at, " +
    "n.suggested_action, n.suggested_why, n.suggested_p, n.resolved_by_type, n.resolved_by_id FROM collisions c " +
    "LEFT JOIN changes ch ON ch.id = c.ours LEFT JOIN collision_notes n ON n.collision_id = c.id " +
    "WHERE c.repo_id = ?1 AND detected_at >= ?2 AND (?3 IS NULL OR ch.target_branch = ?3) ORDER BY detected_at DESC, c.id",
  ).bind(repo.id, new Date(Date.now() - DAYS * 86_400_000).toISOString(), target).all();
  const feed = results.map(({ suggested_action: action, suggested_why: why, suggested_p: p, resolved_by_type: type, resolved_by_id: id, ...f }) => ({ ...f,
    suggested: action ? { action, why, ...(p !== null && { p }) } : null, resolved_by: type ? { type, id } : null }));
  const { results: editing } = await env.DB.prepare("SELECT symbol, change_id, kind, at FROM symbol_editing e LEFT JOIN changes ch ON ch.id = e.change_id " +
    "WHERE e.repo_id = ?1 AND at >= ?2 AND (?3 IS NULL OR ch.target_branch = ?3) ORDER BY at DESC")
    .bind(repo.id, new Date(Date.now() - EDITING_MS).toISOString(), target).all();
  return Response.json({ feed, editing });
}

// POST /api/changes/:id/collisions/resolve {action} → { resolution, resolved_at }: a person settles a collision that is
// still open (cinder settles new ones itself); both agents are told.
export async function resolveCollision(request, env, { id }) {
  const { action } = (await request.json().catch(() => null)) ?? {};
  if (!COLLISION_ACTIONS.includes(action)) return error(400, "bad_request", `action must be one of ${COLLISION_ACTIONS.join(", ")}`);
  const change = await changeDO(env, id).get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  if (!(await env.DB.prepare("SELECT 1 FROM collisions WHERE ours = ? AND resolution IS NULL").bind(id).first())) {
    return error(409, "no_collision", `change ${id} has no open collision`);
  }
  const at = await settle(env, change, action, { type: "human", id: personOf(request) }, action);
  if (!at) return error(409, "change_moved", `change ${id} is no longer in conflict`);
  return Response.json({ resolution: action, resolved_at: at });
}
