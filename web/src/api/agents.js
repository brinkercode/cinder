import { validateAgentHistory, validateAgentVersionDetail, validateAgentVersions, validateTokenLimits } from "../../../worker/src/api/contract.js";
import history from "../../../worker/src/api/fixtures/agent-history.json";
import versions from "../../../worker/src/api/fixtures/agent-version-list.json";
import { checked, fetchJson, fixtures, postJson } from "../client.js";

const path = (name, rest) => `/api/agents/${encodeURIComponent(name)}${rest}`;

// GET /api/agents/:name/versions → AgentVersions, oldest first.
export async function agentVersions(name) {
  const body = fixtures() ? versions : await fetchJson(path(name, "/versions"));
  const { ok, errors } = validateAgentVersions(body);
  if (!ok) throw new Error(`${path(name, "/versions")}: ${errors.join("; ")}`);
  return body;
}

// GET /api/agents/:name/versions/:version → AgentVersionDetail: that version's lock and prompt at its release tag.
export async function agentVersion(name, version) {
  const body = await fetchJson(path(name, `/versions/${version}`));
  const { ok, errors } = validateAgentVersionDetail(body);
  if (!ok) throw new Error(`${path(name, `/versions/${version}`)}: ${errors.join("; ")}`);
  return body;
}

// GET /api/agents/:name/history → [AgentHistory], newest first.
export const agentHistory = async (name) => checked(path(name, "/history"), fixtures() ? history : await fetchJson(path(name, "/history")), validateAgentHistory);

// PUT /api/agents/:name/channels/:channel {version, share?}: promote, roll back or set the canary's share of new runs.
export const moveChannel = (name, channel, body) => postJson(path(name, `/channels/${channel}`), body, "PUT");

// PUT /api/agents/:name/versions/:version/limits {max_tokens, max_tokens_month}; null clears a limit. Fixture mode saves nothing.
export async function setTokenLimits(name, version, body) {
  if (fixtures()) return body;
  const saved = await postJson(path(name, `/versions/${version}/limits`), body, "PUT");
  const { ok, errors } = validateTokenLimits(saved);
  if (!ok) throw new Error(`${path(name, `/versions/${version}/limits`)}: ${errors.join("; ")}`);
  return saved;
}
