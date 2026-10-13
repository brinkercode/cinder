// GET /api/agents returns a list of these; GET /api/agents/:name returns one.
// contract.js re-exports this file, so its bindings are only read inside the function (import cycle).
import { validateAgentVersion } from "../contract.js";

export const AGENT_CHANNELS = ["stable", "canary"];

export function validateAgent(v) {
  const errors = [];
  if (typeof v?.name !== "string" || !v.name) errors.push("name: expected non-empty string");
  if (!Array.isArray(v?.versions) || !v.versions.length) errors.push("versions: expected array with at least 1 item(s)");
  else v.versions.forEach((x, i) => errors.push(...validateAgentVersion(x).errors.map((e) => `versions[${i}].${e}`)));
  if (!Array.isArray(v?.channels)) errors.push("channels: expected array");
  else v.channels.forEach((c, i) => {
    if (!AGENT_CHANNELS.includes(c?.channel)) errors.push(`channels[${i}].channel: expected one of ${AGENT_CHANNELS.join(", ")}`);
    if (!Number.isInteger(c?.version) || c.version < 1) errors.push(`channels[${i}].version: expected integer >= 1`);
  });
  return { ok: errors.length === 0, errors };
}
