import { personOf } from "./access.js";
import { clearNeeds, raiseNeeds } from "./needs.js";
import { reacquireLeases } from "./scheduler.js";
import { error } from "./router.js";
import { openThread } from "./threads.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));

// POST /api/changes/:id/takeover → change: the person drives; the agent's develop job is superseded and none is queued until release.
export async function takeOver(request, env, { id }) {
  return driveAs(env, id, personOf(request));
}

// person drives change id (takeOver, and a granted lease takeover in Needs you). Taking it from another person asks
// that person's lease back in Needs you; any earlier ask on the change is cleared.
export async function driveAs(env, id, person) {
  const previous = (await changeDO(env, id).get())?.driver;
  const change = await changeDO(env, id).setDriver(person);
  if (!change) return error(404, "not_found", `no change ${id}`);
  if (previous !== person) {
    const taken = previous ? [{ kind: "Lease takeover", change: id, text: `${person} took over ${previous}'s lease on change ${id}.`,
      actions: [`Grant to ${previous}`, "Open change"], subject: { person: previous } }] : [];
    await clearNeeds(env.DB, "Lease takeover", change.repo_id, id, taken.map((n) => n.text));
    await raiseNeeds(env.DB, change.repo_id, taken);
  }
  await env.DB.prepare("INSERT OR IGNORE INTO job_cancels (job_id) SELECT id FROM jobs WHERE change_id = ? AND kind = 'develop' AND status IN ('queued', 'claimed')")
    .bind(id).run();
  return Response.json(change);
}

// POST /api/changes/:id/messages {text} → 202: delivered with the agent's next develop job (claimWork). On a person's change
// that agents may not push to, the agent answers in a review thread instead and the timeline records agent_push_refused.
export async function messageAgent(request, env, { id }) {
  const body = await request.json().catch(() => null);
  if (typeof body?.text !== "string" || !body.text.trim()) return error(400, "bad_request", "body must be {text} with non-empty text");
  const stub = changeDO(env, id);
  const change = await stub.get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  if (change.driver && change.agent_pushes === false) {
    const agent = change.agent_version ?? "agent";
    await stub.stageEvent({ kind: "agent_push_refused", agent, actor: { type: "system", id: "cinder" }, action: "change.push", target: id, result: "refused" });
    return openThread(env, change, { body: `${change.driver} has not let agents push to this change, so I answer here instead of committing.\n\n> ${body.text.trim()}` }, agent);
  }
  await stub.addMessage({ text: body.text, by: personOf(request), at: new Date().toISOString() });
  return new Response(null, { status: 202 });
}

// POST /api/changes/:id/release → change: the agent drives again; its superseded develop job is queued afresh.
export async function releaseChange(request, env, { id }) {
  const stub = changeDO(env, id);
  const current = await stub.get();
  if (!current) return error(404, "not_found", `no change ${id}`);
  if (!current.driver) return error(409, "not_driven", `change ${id} is already driven by its agent`);
  const change = await stub.setDriver(null);
  await clearNeeds(env.DB, "Lease takeover", change.repo_id, id);
  // Only a cancelled latest develop job is copied, so a second release queues nothing.
  await env.DB.prepare(`INSERT INTO jobs (id, repo_id, kind, change_id, status, created_at, payload)
    SELECT ?1, repo_id, kind, change_id, 'queued', ?2, json_remove(payload, '$.messages') FROM jobs
    WHERE id = (SELECT id FROM jobs WHERE change_id = ?3 AND kind = 'develop' ORDER BY created_at DESC LIMIT 1) AND id IN (SELECT job_id FROM job_cancels)`)
    .bind(crypto.randomUUID(), new Date().toISOString(), id).run();
  await reacquireLeases(env); // a lease released from Code is re-granted now, not at the agent's next claim
  return Response.json(change);
}
