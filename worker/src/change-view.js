// Change detail's writes beyond review, threads and takeover: auto-queue and Add to merge queue.
import { personOf } from "./access.js";
import { autoQueue, queueBlocker } from "./changes.js";
import { enqueue, queueMergeJob } from "./queue.js";
import { error } from "./router.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
const missing = (id) => error(404, "not_found", `no change ${id}`);

// PATCH /api/changes/:id/auto_queue {auto_queue} → 204. Off, a person's approval leaves the change for POST /queue; on, a
// verified change nothing holds queues at once.
export async function setAutoQueue(request, env, { id }) {
  const on = (await request.json().catch(() => null))?.auto_queue;
  if (typeof on !== "boolean") return error(400, "bad_request", "body must be {auto_queue: boolean}");
  if (!(await changeDO(env, id).get())) return missing(id);
  await env.DB.prepare("INSERT INTO change_views (change_id, auto_queue) VALUES (?1, ?2) ON CONFLICT (change_id) DO UPDATE SET auto_queue = ?2")
    .bind(id, Number(on)).run();
  if (on) await autoQueue(env, id, { kind: "queued", actor: { type: "human", id: personOf(request) }, action: "stage.decide", target: id, result: "ok" });
  return new Response(null, { status: 204 });
}

// POST /api/changes/:id/queue → change: a person adds a verified, approved change to its target's merge queue. There is
// no merge route for people: the verifier's merge job takes the change from the queue.
// approve (Judges disagree ▸ Merge, needs.js) records the person's approval of the head in the same write, so a refused
// queue leaves no approval.
export async function queueChange(request, env, { id }, approve = false) {
  const stub = changeDO(env, id);
  const stored = await stub.get();
  if (!stored) return missing(id);
  const actor = { type: "human", id: personOf(request) };
  const patch = approve ? { approvals: [...(stored.approvals ?? []).filter((a) => a.actor.id !== actor.id), { actor, head_sha: stored.head ?? null, at: new Date().toISOString() }] } : {};
  const change = { ...stored, ...patch };
  const blocker = await queueBlocker(env, change);
  const queued = !blocker && await stub.transition("in_queue", {
    kind: "queued", actor, action: "stage.decide", target: id, result: "ok",
  }, patch, "verifying");
  if (!queued) return error(409, "not_ready", `change ${id} can't queue: ${blocker ?? "its state changed"}`);
  await enqueue(env, queued);
  await queueMergeJob(env, queued.repo_id, queued.target_branch);
  return Response.json(queued);
}
