import { personOf } from "./access.js";
import { leaseExpiry } from "./lease-map.js";
import { error } from "./router.js";
import { releaseLease } from "./scheduler.js";

const changeDO = (env, id) => env.CHANGE_DO.get(env.CHANGE_DO.idFromName(id));
const ANSWERS = ["accepted", "declined", "cancelled"];
const view = (r) => ({ ...r, status: r.status === "requested" && r.expires_at <= new Date().toISOString() ? "expired" : r.status });
const tell = async (env, id, r) => {
  const { name } = await env.DB.prepare("SELECT r.name FROM repos r JOIN changes c ON c.repo_id = r.id WHERE c.id = ?").bind(id).first();
  await env.REPO_DO.get(env.REPO_DO.idFromName(name)).broadcast({ kind: "handover", repo: name, at: new Date().toISOString(), id: r.id, holder: id, status: r.status });
};

// POST /api/leases/:id/handover-request {symbol, intent} → Handover (201): asks the change holding lease :id (a lease is
// keyed by its holder) to hand over symbol. The holder's agent reads the ask with its next turn; expires_at is the lease's.
export async function requestHandover(request, env, { id }) {
  const b = await request.json().catch(() => null);
  if (typeof b?.symbol !== "string" || !b.symbol || typeof b.intent !== "string" || !b.intent.trim()) return error(400, "bad_request", "body must be {symbol, intent} with non-empty strings");
  const stub = changeDO(env, id);
  const holder = await stub.get();
  if (!holder) return error(404, "not_found", `no change ${id}`);
  const repo = await env.DB.prepare("SELECT name, default_branch FROM repos WHERE id = ?").bind(holder.repo_id).first();
  const repoDO = env.REPO_DO.get(env.REPO_DO.idFromName(repo.name));
  const lease = (await repoDO.leases(holder.target_branch))[id];
  if (!lease?.granted || !(lease.symbols.includes(b.symbol) || lease.symbols.includes(b.symbol.split("#")[0]))) return error(409, "not_held", `change ${id} holds no lease on ${b.symbol}`);
  const now = new Date().toISOString();
  const row = { id: crypto.randomUUID(), holder: id, requester: personOf(request), symbol: b.symbol, status: "requested", reason: null, expires_at: await leaseExpiry(repoDO, repo.name, repo.default_branch, holder), created_at: now };
  await env.DB.prepare("INSERT INTO handover_requests (id, holder, requester, symbol, status, reason, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
    .bind(...Object.values(row)).run();
  await stub.addMessage({ text: `${row.requester} asks you to hand over ${b.symbol} for: ${b.intent}`, by: row.requester, at: now });
  await tell(env, id, row);
  return Response.json(view(row), { status: 201 });
}

const find = (env, id, rid) => env.DB.prepare("SELECT * FROM handover_requests WHERE id = ? AND holder = ?").bind(rid, id).first();

// GET /api/leases/:id/handover-request/:rid → Handover
export async function getHandover(request, env, { id, rid }) {
  const row = await find(env, id, rid);
  return row ? Response.json(view(row)) : error(404, "not_found", `no handover request ${rid}`);
}

// POST /api/leases/:id/handover-request/:rid/answer {answer: accepted | declined | cancelled, reason?} → Handover: the
// requester cancels; the holder's side accepts or declines. Accepting frees the holder's lease; a decline carries a reason.
// Only a request still open can be answered.
export async function answerHandover(request, env, { id, rid }) {
  const b = await request.json().catch(() => null);
  if (!ANSWERS.includes(b?.answer) || (b.answer === "declined" && !(typeof b.reason === "string" && b.reason.trim()))) {
    return error(400, "bad_request", "body must be {answer: accepted|declined|cancelled}, and a reason when declining");
  }
  const row = await find(env, id, rid);
  if (!row) return error(404, "not_found", `no handover request ${rid}`);
  if (view(row).status !== "requested") return error(409, "closed", `request ${rid} is ${view(row).status}`);
  const next = { ...row, status: b.answer, reason: b.answer === "declined" ? b.reason.trim() : null };
  await env.DB.prepare("UPDATE handover_requests SET status = ?, reason = ? WHERE id = ?").bind(next.status, next.reason, rid).run();
  if (b.answer === "accepted") await releaseLease(env, await changeDO(env, id).get(), true);
  await tell(env, id, next);
  return Response.json(view(next));
}
