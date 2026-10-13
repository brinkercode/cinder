import { postJson } from "../client.js";

// POST /api/changes/:id/threads/:t/<action>: comments {body}, resolve, reopen or apply. Fixture mode posts nothing.
export const threadWrite = (id, thread, action, body = {}) => postJson(`/api/changes/${encodeURIComponent(id)}/threads/${encodeURIComponent(thread)}/${action}`, body);
