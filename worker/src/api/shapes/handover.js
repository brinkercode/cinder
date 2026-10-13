export const HANDOVER_STATUSES = ["requested", "accepted", "declined", "cancelled", "expired"];

const str = (v) => typeof v === "string" && v.length > 0;
const time = (v) => str(v) && !Number.isNaN(Date.parse(v));

// A request to the holder of a lease to hand it over (POST /api/leases/:id/handover-request, then its answer): holder is
// the change holding the lease, requester the person asking. reason is the holder's when it declined, else null. A
// request still "requested" past expires_at (the lease's expiry) reads as "expired".
export function validateHandover(v) {
  const errors = [];
  const check = (ok, path, desc) => { if (!ok) errors.push(`${path}: expected ${desc}`); };
  for (const k of ["id", "holder", "requester", "symbol"]) check(str(v?.[k]), k, "non-empty string");
  check(HANDOVER_STATUSES.includes(v?.status), "status", `one of ${HANDOVER_STATUSES.join(", ")}`);
  check(v?.reason === null || str(v?.reason), "reason", "null or non-empty string");
  check(time(v?.expires_at), "expires_at", "ISO time");
  check(time(v?.created_at), "created_at", "ISO time");
  return { ok: errors.length === 0, errors };
}
