// GET /api/agents/:name/versions/:version returns this: the version's lock (an AgentVersion with its egress and web setting)
// and its prompt, read from its release tag.
// contract.js re-exports this file, so its bindings are only read inside the function (import cycle).
import { validateAgentVersion } from "../contract.js";

export function validateAgentVersionDetail(v) {
  const { errors } = validateAgentVersion(v);
  if (typeof v?.prompt !== "string") errors.push("prompt: expected string");
  if (!Array.isArray(v?.egress)) errors.push("egress: expected array");
  if (v?.web === undefined) errors.push("web: required");
  return { ok: errors.length === 0, errors };
}
