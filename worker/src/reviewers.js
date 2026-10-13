import { groupsOf, isOwnerEmail, personOf } from "./access.js";
import { autoQueue } from "./changes.js";
import { can } from "./people.js";
import { error } from "./router.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));

// POST /api/changes/:id/reviewers {person} | {agent_version}, by an owner, the change's author or driver, or anyone with
// repo.write on its repo.
export async function requestReviewer(request, env, { id }) {
  const current = await changeDO(env, id).get();
  if (!current) return error(404, "not_found", `no change ${id}`);
  const caller = personOf(request);
  const author = current.events.find((e) => e.kind === "created")?.actor.id;
  if (caller !== "owner" && !isOwnerEmail(env, caller) && caller !== author && caller !== current.driver &&
    !(await can(env, caller, request.method, new URL(request.url).pathname, null, groupsOf(request)))) return error(403, "forbidden", "only the author, the driver or repo.write may request reviewers");
  const body = await request.json().catch(() => null);
  const { person, agent_version } = body ?? {};
  const ok = (v) => typeof v === "string" && v.trim() !== "";
  if (ok(person) === ok(agent_version)) {
    return error(400, "bad_request", "send exactly one of person or agent_version, a non-empty string");
  }
  const change = await changeDO(env, id).requestReviewer(ok(person) ? { person: person.trim().toLowerCase() } : { agent_version: agent_version.trim() });
  return change ? Response.json(change) : error(404, "not_found", `no change ${id}`);
}

// DELETE /api/changes/:id/reviewers/:who → 204, for the change's author, its driver or a person with repo.write on it
// (router.js lets any signed-in person reach this). Dropping the last pending person queues a verified change.
export async function removeReviewer(request, env, { id, who }) {
  const stub = changeDO(env, id);
  const change = await stub.get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const caller = personOf(request);
  const author = change.events.find((e) => e.kind === "created")?.actor.id;
  if (caller !== "owner" && !isOwnerEmail(env, caller) && caller !== author && caller !== change.driver &&
    !(await can(env, caller, "DELETE", new URL(request.url).pathname, null, groupsOf(request)))) return error(403, "forbidden", "only the author, the driver or repo.write may remove a reviewer");
  await stub.removeReviewer(decodeURIComponent(who), { type: "human", id: caller });
  await autoQueue(env, id, { kind: "queued", actor: { type: "human", id: caller }, action: "stage.decide", target: id, result: "ok" });
  return new Response(null, { status: 204 });
}

// GET /api/changes/:id/reviewers/suggested → [{ owner, weight, owns, touched }]: learned owners (people and agent versions) of the
// symbols the change leases and their paths, by summed weight; owns of touched counts the paths behind the weight. The author, person or agent version, is never suggested.
export async function suggestReviewers(request, env, { id }) {
  const stub = changeDO(env, id);
  const change = await stub.get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const name = await env.DB.prepare("SELECT name FROM repos WHERE id = ?").bind(change.repo_id).first("name");
  const symbols = (await env.REPO_DO.get(env.REPO_DO.idFromName(name)).leases(change.target_branch))[id]?.symbols ?? [];
  const touched = [...new Set([...symbols, ...symbols.map((s) => s.split("#")[0])])];
  const authors = [change.events[0]?.actor?.id, (await stub.stages()).findLast((s) => s.stage === "develop")?.agent_version].filter(Boolean);
  const { results } = await env.DB.prepare(
    "SELECT owner, SUM(weight) AS weight, COUNT(*) AS owns, json_array_length(?2) AS touched FROM owners WHERE repo = ?1 AND path IN (SELECT value FROM json_each(?2)) " +
    "AND owner NOT IN (SELECT value FROM json_each(?3)) GROUP BY owner ORDER BY weight DESC, owner",
  ).bind(change.repo_id, JSON.stringify(touched), JSON.stringify(authors)).all();
  return Response.json(results);
}
