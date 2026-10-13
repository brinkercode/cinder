import { error } from "./router.js";

// POST /api/changes/:id/quarantine {action: release|discard}: a person settles a quarantined push. release says the guard
// was wrong: a "no" outcome on its open judgments and the guard clears. discard says it was right: a "yes" outcome, and
// the push stays out of verify and merge until a new push is guarded.
export async function settleQuarantine(request, env, { id }) {
  const { action } = (await request.json().catch(() => null)) ?? {};
  if (action !== "release" && action !== "discard") return error(400, "bad_request", "action must be release or discard");
  const stub = env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
  const change = await stub.get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  if (change.guard?.status !== "quarantined") return error(409, "not_quarantined", `change ${id} is not quarantined`);
  const guard = { ...change.guard, status: action === "release" ? "clear" : "discarded" };
  await stub.setGuard(guard);
  await env.DB.prepare(
    "INSERT INTO outcomes (judgment_id, actual, correct, observed_at) SELECT id, ?2, answer = ?2, ?3 FROM judgments " +
    "WHERE change_id = ?1 AND kind = 'guard' AND id NOT IN (SELECT judgment_id FROM outcomes)",
  ).bind(id, action === "release" ? "no" : "yes", new Date().toISOString()).run();
  return Response.json({ ...change, guard });
}
