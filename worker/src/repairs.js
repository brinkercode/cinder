import { error } from "./router.js";

// GET /api/changes/:id/repairs → [RepairRound], oldest first: one per repair_started event (changes.js #repair). A round
// spans the events up to the next round's start: its develop report, the verifier's verdict and the tokens used in it.
export async function listRepairs(request, env, { id }) {
  const change = await env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id)).get();
  if (!change) return error(404, "not_found", `no change ${id}`);
  const ev = change.events;
  const starts = ev.flatMap((e, i) => (e.kind === "repair_started" ? [i] : []));
  if (!starts.length) return Response.json([]);
  // lazy: tokens are the change's gateway logs between round starts, so a log pulled late lands in the round it was pulled in.
  const { results: usage } = await env.DB.prepare("SELECT at, tokens FROM usage_logs WHERE change_id = ? AND at >= ?").bind(id, ev[starts[0]].at).all();
  return Response.json(starts.map((from, n) => {
    const start = ev[from], end = ev[starts[n + 1]]?.at;
    const span = ev.slice(from + 1, starts[n + 1]);
    const dev = span.find((e) => e.kind === "develop_done" || e.kind === "develop_failed");
    const verdict = span.find((e) => e.kind === "verify_done" || e.kind === "verify_failed");
    return {
      round: start.round, check: start.check,
      did: dev ? dev.reason ?? (dev.kind === "develop_done" ? "pushed a fix" : "develop failed") : null,
      result: verdict ? (verdict.kind === "verify_done" ? "pass" : "fail") : null, reason: verdict?.reason ?? null,
      tokens: usage.filter((u) => u.at >= start.at && (!end || u.at < end)).reduce((s, u) => s + u.tokens, 0), at: start.at,
    };
  }));
}
