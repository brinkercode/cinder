import { validateAgentVersions } from "../../../worker/src/api/contract.js";
import versions from "../../../worker/src/api/fixtures/agent-version-list.json";
import { fetchJson, fixtures, postJson } from "../client.js";

// GET /api/agents/:name/versions → each version with the channel pointing at it and the canary's share.
export async function agentVersions(name) {
  const path = `/api/agents/${encodeURIComponent(name)}/versions`;
  const body = fixtures() ? versions : await fetchJson(path);
  const { ok, errors } = validateAgentVersions(body);
  if (!ok) throw new Error(`${path}: ${errors.join("; ")}`);
  return body;
}

// POST /api/agents/:name/egress {host, verdict, channel}: releases a new version, never edits a released one. Fixture mode sends nothing.
export const releaseEgress = (name, body) => postJson(`/api/agents/${encodeURIComponent(name)}/egress`, body);
