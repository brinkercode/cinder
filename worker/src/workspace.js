import { asCaller, personOf } from "./access.js";
import { releaseLease } from "./scheduler.js";
import { driveAs, messageAgent } from "./takeover.js";
import { error } from "./router.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));

// DELETE /api/leases/:id (the id is the holding change's) → change: frees the lease at once and pauses the agent
// (the person drives, as in a takeover). Refused with 409 while a commit job of the change is running.
export async function releaseWorkspaceLease(request, env, { id }) {
  const change = await changeDO(env, id).get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const busy = await env.DB.prepare("SELECT 1 FROM jobs WHERE change_id = ? AND kind = 'commit' AND status = 'claimed' AND id NOT IN (SELECT job_id FROM job_cancels)").bind(id).first();
  if (busy) return error(409, "mid_commit", `${id} is mid-commit; try again when it lands`);
  const driven = await driveAs(env, id, personOf(request));
  await releaseLease(env, change, true);
  return driven;
}

// POST /api/changes/:id/steer {message} → 202: the agent reads it with its next develop job.
export const steerAgent = async (request, env, params) => {
  const body = await request.json().catch(() => null);
  return messageAgent(asCaller(request, request.url, { method: "POST", body: JSON.stringify({ text: body?.message }) }), env, params);
};
