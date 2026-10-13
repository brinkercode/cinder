import { postJson } from "../client.js";

// PATCH /api/changes/:id {agent_pushes}: whether agents may commit to a change a person drives.
export const setAgentPushes = (id, on) => postJson(`/api/changes/${encodeURIComponent(id)}`, { agent_pushes: on }, "PATCH");
