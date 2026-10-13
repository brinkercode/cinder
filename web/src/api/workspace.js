import { changeAct, postJson } from "../client.js";

// DELETE /api/leases/:id (the holding change's id): frees the lease and pauses the agent. Fixture mode sends nothing.
export const releaseLease = (id) => postJson(`/api/leases/${encodeURIComponent(id)}`, undefined, "DELETE");

// POST /api/changes/:id/steer {message}: the agent reads it before its next step.
export const steer = (id, message) => postJson(`/api/changes/${encodeURIComponent(id)}/steer`, { message });

// POST /api/changes/:id/release: the agent drives again and re-requests its lease.
export const giveBack = (id) => changeAct(id, "release");
