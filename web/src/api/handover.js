import { validateHandover } from "../../../worker/src/api/shapes.js";
import { fetchJson, fixtures, postJson } from "../client.js";

const at = (holder, rid = "") => `/api/leases/${encodeURIComponent(holder)}/handover-request${rid && `/${encodeURIComponent(rid)}`}`;
const valid = (path, body) => {
  const { ok, errors } = validateHandover(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
};

// POST /api/leases/:holder/handover-request {symbol, intent} → Handover: asks the holder of a lease to hand over symbol.
// Fixture mode has no holder to answer; the request waits until expires_at.
export async function requestHandover(holder, body, expires_at) {
  if (fixtures()) return { id: "local", holder, requester: "you", symbol: body.symbol, status: "requested", reason: null, expires_at, created_at: new Date().toISOString() };
  return valid(at(holder), await postJson(at(holder), body));
}

// GET /api/leases/:holder/handover-request/:id → Handover: requested, accepted, declined (with the holder's reason), cancelled or expired.
export async function getHandover(holder, id) {
  if (fixtures()) return { status: "requested" };
  return valid(at(holder, id), await fetchJson(at(holder, id)));
}

// Withdraws the request.
export async function cancelHandover(holder, id) {
  if (!fixtures()) await postJson(`${at(holder, id)}/answer`, { answer: "cancelled" });
}
